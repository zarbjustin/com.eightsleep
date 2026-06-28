'use strict';

import {
  API_HEADERS,
  APP_API_URL,
  AUTH_HEADERS,
  AUTH_URL,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CLIENT_API_URL,
  DEFAULT_TIMEOUT_MS,
  KNOWN_CLIENT_ID,
  KNOWN_CLIENT_SECRET,
  MAX_RETRIES,
  MIN_REQUEST_GAP_MS,
  TOKEN_TIME_BUFFER_SECONDS,
} from './constants';
import { RateLimiter } from './RateLimiter';
import type {
  BaseSideData, BaseSummary, BedSideRef, EightSleepAlarm, EightSleepConfig, FetchFn, FetchResponse, HttpMethod, OneOffAlarmOptions, SideMetrics, Token, TrendDay, TrendSession,
} from './types';

/** Error thrown for any non-recoverable API failure. */
export class EightSleepError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EightSleepError';
    this.status = status;
  }
}

const noop = (): void => undefined;

/** Last numeric value of a [timestamp, value] timeseries, or null. */
function lastSample(arr?: Array<[string, number]>): number | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const v = arr[arr.length - 1]?.[1];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Epoch ms of the last sample's timestamp, or null. */
function lastSampleTime(arr?: Array<[string, number]>): number | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const t = Date.parse(arr[arr.length - 1]?.[0]);
  return Number.isFinite(t) ? t : null;
}

/**
 * How recent a live heart-rate sample must be to imply the bed is occupied.
 * The Pod streams heart rate roughly every minute while someone is on the bed,
 * so this is the primary real-time presence signal. Once samples stop arriving
 * (the sleeper left), presence drops after this window elapses.
 */
const PRESENCE_HR_FALLBACK_MS = 15 * 60 * 1000;

/**
 * Determine whether someone is currently in bed.
 *
 * A recent live heart-rate sample is the PRIMARY, real-time signal: the Pod
 * streams heart rate roughly every minute while anyone is on the bed (even lying
 * awake), so a fresh sample is the most reliable "is someone in bed right now"
 * indicator. This mirrors Eight Sleep's own clients (e.g. pyEight), which derive
 * bed presence purely from recent heart-rate recency.
 *
 * The processed presenceStart/presenceEnd markers lag the live data and can mark
 * a session "ended" while the sleeper is still in bed, so they are only used as a
 * fallback when there is no recent heart-rate sample. When both markers are
 * present the most recent one wins: a presenceStart newer than (or equal to)
 * presenceEnd means the sleeper got back into bed after an earlier exit.
 *
 * Returns false (not null) when there is no evidence of presence so the
 * "bed empty" trigger can fire.
 */
function computePresence(day: TrendDay, ts: { heartRate?: Array<[string, number]> }, now: number): boolean {
  const hrTime = lastSampleTime(ts.heartRate);
  if (hrTime !== null && now - hrTime <= PRESENCE_HR_FALLBACK_MS) return true;

  const start = day.presenceStart ? Date.parse(day.presenceStart) : NaN;
  const end = day.presenceEnd ? Date.parse(day.presenceEnd) : NaN;
  const hasStart = Number.isFinite(start);
  const hasEnd = Number.isFinite(end);

  if (hasStart && hasEnd) return start >= end;
  if (hasEnd) return false;
  if (hasStart) return true;
  return false;
}

/**
 * Pick the most recent trend day that actually carries data. The trends query
 * spans yesterday→tomorrow, and the API can return empty placeholder days for
 * parts of the range (e.g. a not-yet-started "tomorrow"). Selecting the last
 * raw element would then read an empty day and wrongly report the bed as empty
 * while the sleeper's real data sits in the previous day record.
 */
function pickActiveDay(days: TrendDay[]): TrendDay | undefined {
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const d = days[i];
    const hasData = !!d.presenceStart
      || !!d.presenceEnd
      || d.processing === true
      || (Array.isArray(d.sessions) && d.sessions.length > 0);
    if (hasData) return d;
  }
  return days.length ? days[days.length - 1] : undefined;
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
      global.setTimeout(r, ms);
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
    const res = await this.limiter.run(() => this.timedFetch(AUTH_URL, {
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
      throw new EightSleepError(
        res.status === 401 || res.status === 400
          ? 'Eight Sleep login failed — check your email and password.'
          : `Eight Sleep authentication failed (HTTP ${res.status}).`,
        res.status,
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
    const res = await this.limiter.run(() => this.timedFetch(`${CLIENT_API_URL}/users/me`, {
      method: 'get',
      headers: { ...API_HEADERS, authorization: `Bearer ${accessToken}` },
    }));
    if (!res.ok) {
      throw new EightSleepError(`Failed to load Eight Sleep profile (HTTP ${res.status}).`, res.status);
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
    const res = await this.limiter.run(() => this.timedFetch(url, {
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
      throw new EightSleepError(`Eight Sleep API error (HTTP ${res.status}) during ${method.toUpperCase()} request.`, res.status);
    }

    return (await this.safeJson(res)) as T;
  }

  private async safeJson(res: FetchResponse): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /** Perform a fetch that rejects if it does not settle within the timeout. */
  private timedFetch(url: string, init?: Parameters<FetchFn>[1]): Promise<FetchResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = global.setTimeout(() => reject(new EightSleepError('Eight Sleep request timed out.')), DEFAULT_TIMEOUT_MS);
    });
    return Promise.race([this.fetchImpl(url, init), timeout]).finally(() => {
      if (timer) global.clearTimeout(timer);
    }) as Promise<FetchResponse>;
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

    const perDevice = await Promise.all(deviceIds.map(async (deviceId): Promise<BedSideRef[]> => {
      const device = await this.getDevice(deviceId);
      const left = device.result?.leftUserId;
      const right = device.result?.rightUserId;
      if (left && right && left !== right) {
        return [
          { deviceId, userId: left, side: 'left' },
          { deviceId, userId: right, side: 'right' },
        ];
      }
      const solo = left || right;
      return solo ? [{ deviceId, userId: solo, side: 'solo' }] : [];
    }));

    return perDevice.flat();
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
    const day = pickActiveDay(days);
    if (!day) return emptyMetrics();

    const sessions = Array.isArray(day.sessions) ? day.sessions : [];
    const session = sessions.length ? sessions[sessions.length - 1] : undefined;
    const ts = session?.timeseries ?? {};
    const now = this.now();

    const heartRate = lastSample(ts.heartRate);

    // While Eight Sleep is still processing the night, scores can be partial or
    // zero — withhold them (return null) rather than logging garbage.
    const processing = day.processing === true;
    const score = (value: unknown): number | null => (processing ? null : numOrNull(value));

    return {
      bedPresence: computePresence(day, ts, now),
      heartRate,
      hrv: numOrNull(day.sleepQualityScore?.hrv?.current),
      breathRate: numOrNull(day.sleepQualityScore?.respiratoryRate?.current),
      roomTemp: lastSample(ts.tempRoomC),
      bedTemp: lastSample(ts.tempBedC),
      sleepStage: latestStage(session),
      sleepFitnessScore: score(day.score),
      sleepQualityScore: score(day.sleepQualityScore?.total),
      sleepRoutineScore: score(day.sleepRoutineScore?.total),
      timeSleptSeconds: numOrNull(day.sleepDuration),
    };
  }

  /** Return all alarms configured for a user. */
  async getAlarms(userId: string): Promise<EightSleepAlarm[]> {
    const data = await this.apiRequest<{ alarms?: EightSleepAlarm[] }>(
      'get',
      `${APP_API_URL}v2/users/${userId}/alarms`,
    );
    return Array.isArray(data?.alarms) ? data.alarms : [];
  }

  /**
   * Return the chronologically soonest enabled alarm that has not yet finished
   * ringing, or null when none is scheduled.
   */
  async getNextAlarm(userId: string): Promise<EightSleepAlarm | null> {
    const alarms = await this.getAlarms(userId);
    const now = Date.now();
    let soonest: EightSleepAlarm | null = null;
    let soonestTime = Infinity;

    for (const alarm of alarms) {
      if (alarm.enabled === false) continue;
      const next = alarm.nextTimestamp ? Date.parse(alarm.nextTimestamp) : NaN;
      if (!Number.isFinite(next)) continue;
      const end = alarm.endTimestamp ? Date.parse(alarm.endTimestamp) : next;
      if (Number.isFinite(end) && end < now) continue;
      if (next < soonestTime) {
        soonestTime = next;
        soonest = alarm;
      }
    }

    return soonest;
  }

  /** Snooze a ringing alarm for a number of minutes. */
  async snoozeAlarm(userId: string, alarmId: string, minutes: number): Promise<void> {
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/alarms/${alarmId}/snooze`, {
      snoozeMinutes: Math.max(1, Math.round(minutes)),
      ignoreDeviceErrors: false,
    });
  }

  /** Dismiss (stop) an alarm. */
  async dismissAlarm(userId: string, alarmId: string): Promise<void> {
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/alarms/${alarmId}/dismiss`, {
      ignoreDeviceErrors: false,
    });
  }

  /** Create a one-off alarm for a side. */
  async setOneOffAlarm(userId: string, opts: OneOffAlarmOptions): Promise<void> {
    await this.apiRequest('post', `${APP_API_URL}v1/users/${userId}/alarms`, {
      time: opts.time,
      enabled: opts.enabled ?? true,
      vibration: {
        enabled: opts.vibrationEnabled ?? true,
        powerLevel: opts.vibrationPowerLevel ?? 50,
        pattern: opts.vibrationPattern ?? 'RISE',
      },
      thermal: {
        enabled: opts.thermalEnabled ?? true,
        level: opts.thermalLevel ?? 0,
      },
    });
  }

  /** Start or end away mode for a side. */
  async setAwayMode(userId: string, action: 'start' | 'end'): Promise<void> {
    // Backdate by 24h so the API applies the change immediately.
    const when = `${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 23)}Z`;
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/away-mode`, {
      awayPeriod: { [action]: when },
    });
  }

  /** Trigger a re-prime of the Pod. */
  async primePod(deviceId: string, userId: string): Promise<void> {
    await this.apiRequest('post', `${APP_API_URL}v1/devices/${deviceId}/priming/tasks`, {
      notifications: { users: [userId], meta: 'rePriming' },
    });
  }

  /** Set which physical side a user occupies ('solo' | 'left' | 'right'). */
  async setBedSide(userId: string, deviceId: string, side: 'solo' | 'left' | 'right'): Promise<void> {
    await this.apiRequest('put', `${CLIENT_API_URL}/users/${userId}/current-device`, {
      id: deviceId,
      side,
    });
  }

  /** Read bed-level maintenance status (water + priming). */
  async getDeviceStatus(deviceId: string): Promise<{
    hasWater: boolean | null;
    isPriming: boolean | null;
    needsPriming: boolean | null;
    awayUserIds: string[];
  }> {
    const data = await this.apiRequest<{
      result?: {
        hasWater?: boolean;
        priming?: boolean;
        needsPriming?: boolean;
        awaySides?: Record<string, string>;
      };
    }>('get', `${CLIENT_API_URL}/devices/${deviceId}`);
    const r = data?.result ?? {};
    return {
      hasWater: typeof r.hasWater === 'boolean' ? r.hasWater : null,
      isPriming: typeof r.priming === 'boolean' ? r.priming : null,
      needsPriming: typeof r.needsPriming === 'boolean' ? r.needsPriming : null,
      awayUserIds: r.awaySides ? Object.values(r.awaySides) : [],
    };
  }

  /**
   * Return the adjustable-base state for a side, or null when no base is
   * paired (the endpoint errors or returns no per-side data).
   */
  async getBase(userId: string, side: 'left' | 'right' | 'solo'): Promise<BaseSummary | null> {
    let data: Record<string, BaseSideData> | undefined;
    try {
      data = await this.apiRequest<Record<string, BaseSideData>>('get', `${APP_API_URL}v1/users/${userId}/base`);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    const key = side === 'right' ? 'right' : 'left';
    const s = data[key] ?? data.left ?? data.right;
    if (!s || typeof s !== 'object') return null;
    return {
      legAngle: Number(s.leg?.currentAngle ?? 0),
      torsoAngle: Number(s.torso?.currentAngle ?? 0),
      snoreMitigation: s.inSnoreMitigation === true,
      preset: s.preset?.name ?? null,
    };
  }

  /** Set the adjustable base leg + torso angles. */
  async setBaseAngle(userId: string, deviceId: string, legAngle: number, torsoAngle: number): Promise<void> {
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/base/angle?ignoreDeviceErrors=false`, {
      deviceId,
      deviceOnline: true,
      legAngle: Math.round(legAngle),
      torsoAngle: Math.round(torsoAngle),
    });
  }

  /** Apply a named base preset (sleep / relaxing / reading / flat). */
  async setBasePreset(userId: string, deviceId: string, preset: string): Promise<void> {
    await this.apiRequest('put', `${APP_API_URL}v1/users/${userId}/base/angle?ignoreDeviceErrors=false`, {
      deviceId,
      deviceOnline: true,
      preset,
    });
  }

  /** Average sleep scores over the returned trend window (ignoring still-processing days). */
  async getWeeklyAverages(userId: string, opts: { tz: string; from: string; to: string }): Promise<{
    fitness: number | null; quality: number | null; routine: number | null; hours: number | null; days: number;
  }> {
    const days = (await this.getTrends(userId, opts)).filter((d) => d.processing !== true);
    const nums = (sel: (d: TrendDay) => unknown): number[] => days
      .map(sel)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    const avg = (vals: number[]): number | null => (vals.length
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null);
    const hours = nums((d) => d.sleepDuration).map((s) => s / 3600);
    return {
      fitness: avg(nums((d) => d.score)),
      quality: avg(nums((d) => d.sleepQualityScore?.total)),
      routine: avg(nums((d) => d.sleepRoutineScore?.total)),
      hours: avg(hours),
      days: days.length,
    };
  }

}

/** Factory mirroring the createClient pattern used across the app. */
export function createClient(config: EightSleepConfig): EightSleepClient {
  return new EightSleepClient(config);
}
