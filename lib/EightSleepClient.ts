'use strict';

import {
  API_HEADERS,
  APP_API_URL,
  AUTH_HEADERS,
  AUTH_URL,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CLIENT_API_URL,
  KNOWN_CLIENT_ID,
  KNOWN_CLIENT_SECRET,
  MAX_RETRIES,
  MIN_REQUEST_GAP_MS,
  TOKEN_TIME_BUFFER_SECONDS,
} from './constants';
import { RateLimiter } from './RateLimiter';
import type {
  BedSideRef, EightSleepConfig, FetchFn, FetchResponse, HttpMethod, SideMetrics, Token, TrendDay, TrendSession,
} from './types';

/** Error thrown for any non-recoverable API failure. */
export class EightSleepError extends Error {
  readonly status?: number;

  readonly body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'EightSleepError';
    this.status = status;
    this.body = body;
  }
}

const noop = (): void => undefined;

/** Last numeric value of a [timestamp, value] timeseries, or null. */
function lastSample(arr?: Array<[string, number]>): number | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const v = arr[arr.length - 1]?.[1];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Coerce an API value to a finite number, treating null/"None" as null. */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === 'None') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pick the most relevant sleep stage from a session's stages list. */
function latestStage(session?: TrendSession): string | null {
  const stages = session?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return null;
  return stages[stages.length - 1]?.stage ?? null;
}

function emptyMetrics(): SideMetrics {
  return {
    bedPresence: null,
    heartRate: null,
    hrv: null,
    breathRate: null,
    roomTemp: null,
    bedTemp: null,
    sleepStage: null,
    sleepFitnessScore: null,
    sleepQualityScore: null,
    sleepRoutineScore: null,
    timeSleptSeconds: null,
  };
}

function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Talks to Eight Sleep's unofficial cloud API. Handles OAuth password-grant
 * authentication, transparent token refresh, 401 re-authentication and 429
 * exponential backoff. All requests are serialised through a RateLimiter.
 */
export class EightSleepClient {
  private readonly email: string;

  private readonly password: string;

  private readonly clientId: string;

  private readonly clientSecret: string;

  private readonly fetchImpl: FetchFn;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly log: (...args: unknown[]) => void;

  private readonly limiter: RateLimiter;

  private token: Token | null = null;

  /** Prevents concurrent authentication storms. */
  private authInFlight: Promise<Token> | null = null;

  constructor(config: EightSleepConfig) {
    this.email = config.email;
    this.password = config.password;
    this.clientId = config.clientId || KNOWN_CLIENT_ID;
    this.clientSecret = config.clientSecret || KNOWN_CLIENT_SECRET;
    this.fetchImpl = config.fetchImpl ?? ((url, init) => (fetch as unknown as FetchFn)(url, init));
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => {
      setTimeout(r, ms);
    }));
    this.log = config.log ?? noop;
    this.limiter = new RateLimiter(MIN_REQUEST_GAP_MS, this.now, this.sleep);
  }

  /** The resolved primary user id, once authenticated. */
  get userId(): string | null {
    return this.token?.userId ?? null;
  }

  private isTokenValid(): boolean {
    if (!this.token) return false;
    return this.now() < this.token.expiresAt - TOKEN_TIME_BUFFER_SECONDS * 1000;
  }

  /** Force a fresh login. Useful to validate credentials during pairing. */
  async authenticate(): Promise<Token> {
    this.token = null;
    return this.ensureToken();
  }

  private async ensureToken(): Promise<Token> {
    if (this.isTokenValid()) return this.token as Token;
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.login().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async login(): Promise<Token> {
    const res = await this.limiter.run(() => this.fetchImpl(AUTH_URL, {
      method: 'post',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'password',
        username: this.email,
        password: this.password,
      }),
    }));

    if (!res.ok) {
      const body = await this.safeText(res);
      throw new EightSleepError(
        res.status === 401 || res.status === 400
          ? 'Eight Sleep login failed — check your email and password.'
          : `Eight Sleep authentication failed (HTTP ${res.status}).`,
        res.status,
        body,
      );
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new EightSleepError('Eight Sleep auth response did not contain an access token.');
    }

    const expiresAt = this.now() + (Number(data.expires_in ?? 3600) * 1000);
    // Authenticate, then resolve the primary user id via /users/me.
    const userId = await this.resolveUserId(data.access_token);
    this.token = { accessToken: data.access_token, expiresAt, userId };
    this.log('Eight Sleep authenticated; userId resolved');
    return this.token;
  }

  private async resolveUserId(accessToken: string): Promise<string> {
    const res = await this.limiter.run(() => this.fetchImpl(`${CLIENT_API_URL}/users/me`, {
      method: 'get',
      headers: { ...API_HEADERS, authorization: `Bearer ${accessToken}` },
    }));
    if (!res.ok) {
      const body = await this.safeText(res);
      throw new EightSleepError(`Failed to load Eight Sleep profile (HTTP ${res.status}).`, res.status, body);
    }
    const data = (await res.json()) as { user?: { userId?: string; currentDevice?: { id?: string } } };
    const userId = data.user?.userId;
    if (!userId) throw new EightSleepError('Eight Sleep profile did not contain a user id.');
    return userId;
  }

  /**
   * Perform an authenticated API request against a fully-qualified URL.
   * Handles a single 401 re-auth and 429 backoff with exponential delay.
   */
  async apiRequest<T = unknown>(method: HttpMethod, url: string, body?: unknown): Promise<T> {
    await this.ensureToken();
    return this.requestWithRetry<T>(method, url, body, 0, false);
  }

  private async requestWithRetry<T>(
    method: HttpMethod,
    url: string,
    body: unknown,
    attempt: number,
    didReauth: boolean,
  ): Promise<T> {
    const token = this.token as Token;
    const res = await this.limiter.run(() => this.fetchImpl(url, {
      method,
      headers: { ...API_HEADERS, authorization: `Bearer ${token.accessToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

    if (res.status === 401 && !didReauth) {
      this.log('Eight Sleep request got 401 — re-authenticating');
      this.token = null;
      await this.ensureToken();
      return this.requestWithRetry<T>(method, url, body, attempt, true);
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      this.log(`Eight Sleep rate limited (429) — backing off ${delay}ms`);
      await this.sleep(delay);
      return this.requestWithRetry<T>(method, url, body, attempt + 1, didReauth);
    }

    if (!res.ok) {
      const text = await this.safeText(res);
      throw new EightSleepError(`Eight Sleep API error (HTTP ${res.status}) for ${method.toUpperCase()} ${url}.`, res.status, text);
    }

    return (await res.json()) as T;
  }

  /** Return the raw /users/me payload. */
  async getMe(): Promise<{ user?: { userId?: string; devices?: string[]; currentDevice?: { id?: string; side?: string } } }> {
    return this.apiRequest('get', `${CLIENT_API_URL}/users/me`);
  }

  /** Return a single device's metadata (occupants per side). */
  async getDevice(deviceId: string): Promise<{
    result?: { leftUserId?: string; rightUserId?: string; awaySides?: Record<string, string> };
  }> {
    const filter = 'leftUserId,rightUserId,awaySides';
    return this.apiRequest('get', `${CLIENT_API_URL}/devices/${deviceId}?filter=${filter}`);
  }

  /**
   * Discover all bed sides reachable by the signed-in account: every occupied
   * side of every device the user belongs to. Used during pairing to create
   * one Homey device per side.
   */
  async discoverBedSides(): Promise<BedSideRef[]> {
    const me = await this.getMe();
    const deviceIds = me.user?.devices ?? [];
    const sides: BedSideRef[] = [];

    for (const deviceId of deviceIds) {
      // eslint-disable-next-line no-await-in-loop
      const device = await this.getDevice(deviceId);
      const left = device.result?.leftUserId;
      const right = device.result?.rightUserId;
      if (left && right && left !== right) {
        sides.push({ deviceId, userId: left, side: 'left' });
        sides.push({ deviceId, userId: right, side: 'right' });
      } else {
        const solo = left || right;
        if (solo) sides.push({ deviceId, userId: solo, side: 'solo' });
      }
    }

    return sides;
  }

  /**
   * Read a side's current temperature state: the raw heating level and whether
   * the side is actively running (any state other than "off").
   */
  async getSideState(userId: string): Promise<{ currentLevel: number; isOn: boolean; stateType: string }> {
    const data = await this.apiRequest<{ currentLevel?: number; currentState?: { type?: string } }>(
      'get',
      `${APP_API_URL}v1/users/${userId}/temperature`,
    );
    const stateType = data?.currentState?.type ?? 'off';
    return {
      currentLevel: Number(data?.currentLevel ?? 0),
      isOn: stateType !== 'off',
      stateType,
    };
  }

  /** Turn a side on (smart mode) or off. */
  async setSidePower(userId: string, on: boolean): Promise<void> {
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/temperature`, {
      currentState: { type: on ? 'smart' : 'off' },
    });
  }

  /** Set a side's raw heating level (-100..100). */
  async setSideLevel(userId: string, level: number): Promise<void> {
    const clamped = Math.max(-100, Math.min(100, Math.round(level)));
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/temperature`, {
      currentLevel: clamped,
    });
  }

  /**
   * Fetch the user's sleep "trends" (V2 API) for a date range. Each entry is a
   * day with sleep scores plus per-session timeseries (heart rate, temps, etc.).
   */
  async getTrends(userId: string, opts: { tz: string; from: string; to: string }): Promise<TrendDay[]> {
    const query = buildQuery({
      tz: opts.tz,
      from: opts.from,
      to: opts.to,
      'include-main': 'false',
      'include-all-sessions': 'true',
      'model-version': 'v2',
    });
    const data = await this.apiRequest<{ days?: TrendDay[] }>(
      'get',
      `${CLIENT_API_URL}/users/${userId}/trends?${query}`,
    );
    return Array.isArray(data.days) ? data.days : [];
  }

  /**
   * Derive normalised biometric + sleep metrics for a side from the latest
   * trend day. Field paths mirror the Eight Sleep V2 trends payload. Values are
   * null when no current/active session data is available.
   */
  async getSideMetrics(userId: string, opts: { tz: string; from: string; to: string }): Promise<SideMetrics> {
    const days = await this.getTrends(userId, opts);
    const day = days.length ? days[days.length - 1] : undefined;
    if (!day) return emptyMetrics();

    const sessions = Array.isArray(day.sessions) ? day.sessions : [];
    const session = sessions.length ? sessions[sessions.length - 1] : undefined;
    const ts = session?.timeseries ?? {};

    const heartRate = lastSample(ts.heartRate);

    return {
      // Presence is inferred from a live heart-rate signal (the cloud API has
      // no reliable explicit presence flag). Refined in a later sprint.
      bedPresence: heartRate !== null ? true : null,
      heartRate,
      hrv: numOrNull(day.sleepQualityScore?.hrv?.current),
      breathRate: numOrNull(day.sleepQualityScore?.respiratoryRate?.current),
      roomTemp: lastSample(ts.tempRoomC),
      bedTemp: lastSample(ts.tempBedC),
      sleepStage: latestStage(session),
      sleepFitnessScore: numOrNull(day.score),
      sleepQualityScore: numOrNull(day.sleepQualityScore?.total),
      sleepRoutineScore: numOrNull(day.sleepRoutineScore?.total),
      timeSleptSeconds: numOrNull(day.sleepDuration),
    };
  }

  private async safeText(res: FetchResponse): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }
}

/** Factory mirroring the createClient pattern used across the app. */
export function createClient(config: EightSleepConfig): EightSleepClient {
  return new EightSleepClient(config);
}
