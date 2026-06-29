'use strict';

/** Minimal fetch surface we depend on, so a stub can be injected in tests. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<FetchResponse>;

/** Configuration for an EightSleepClient. */
export interface EightSleepConfig {
  email: string;
  password: string;
  /** Optional override for the baked-in public OAuth client id. */
  clientId?: string;
  /** Optional override for the baked-in public OAuth client secret. */
  clientSecret?: string;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchFn;
  /** Injectable clock in ms (defaults to Date.now). */
  now?: () => number;
  /** Injectable sleep (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional logger. */
  log?: (...args: unknown[]) => void;
}

/** A cached OAuth access token plus the resolved primary user id. */
export interface Token {
  accessToken: string;
  /** Epoch milliseconds at which the token should be considered expired. */
  expiresAt: number;
  userId: string;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

/** A single bed side belonging to a device. */
export interface BedSideRef {
  deviceId: string;
  userId: string;
  side: 'left' | 'right' | 'solo';
}

/** A [timestamp, value] sample as returned in trend timeseries arrays. */
export type TimeseriesSample = [string, number];

export interface TrendTimeseries {
  heartRate?: TimeseriesSample[];
  tempRoomC?: TimeseriesSample[];
  tempBedC?: TimeseriesSample[];
  hrv?: TimeseriesSample[];
  respiratoryRate?: TimeseriesSample[];
}

export interface TrendSession {
  timeseries?: TrendTimeseries;
  stages?: Array<{ stage?: string }>;
}

export interface TrendDay {
  day?: string;
  score?: number;
  sleepDuration?: number;
  presenceStart?: string;
  presenceEnd?: string;
  processing?: boolean;
  sleepQualityScore?: {
    total?: number;
    heartRate?: {
      current?: number;
      average?: number;
      inclusive7DayAverage?: number;
    };
    hrv?: {
      current?: number;
      average?: number;
      inclusive7DayAverage?: number;
    };
    respiratoryRate?: {
      current?: number;
      average?: number;
      inclusive7DayAverage?: number;
    };
  };
  sleepRoutineScore?: { total?: number };
  sessions?: TrendSession[];
}

/** Normalised per-side biometric + sleep metrics derived from trend data. */
export interface SideMetrics {
  bedPresence: boolean | null;
  presenceReason: string;
  heartRateSampleAgeMinutes: number | null;
  heartRateSampleAt: string | null;
  heartRate: number | null;
  restingHeartRate: number | null;
  restingHeartRateWeekly: number | null;
  hrv: number | null;
  hrvWeekly: number | null;
  breathRate: number | null;
  breathRateWeekly: number | null;
  roomTemp: number | null;
  bedTemp: number | null;
  sleepStage: string | null;
  sleepFitnessScore: number | null;
  sleepQualityScore: number | null;
  sleepRoutineScore: number | null;
  timeSleptSeconds: number | null;
}

export interface SideMetricsOptions {
  tz: string;
  from: string;
  to: string;
  stateType?: string;
}

export interface WeeklyAverages {
  days: number;
  fitness: number | null;
  quality: number | null;
  routine: number | null;
  hours: number | null;
  restingHeartRate: number | null;
  hrv: number | null;
  breathRate: number | null;
}

/** A single alarm as returned by the v2 alarms endpoint. */
export interface EightSleepAlarm {
  id: string;
  enabled?: boolean;
  time?: string;
  nextTimestamp?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  snoozing?: boolean;
}

/** Options for creating a one-off alarm. */
export interface OneOffAlarmOptions {
  time: string;
  enabled?: boolean;
  vibrationEnabled?: boolean;
  vibrationPowerLevel?: number;
  vibrationPattern?: string;
  thermalEnabled?: boolean;
  thermalLevel?: number;
}

/** Raw per-side base data as returned by the base endpoint. */
export interface BaseSideData {
  leg?: { currentAngle?: number };
  torso?: { currentAngle?: number };
  inSnoreMitigation?: boolean;
  preset?: { name?: string };
}

/** Normalised adjustable-base state for a side. */
export interface BaseSummary {
  legAngle: number;
  torsoAngle: number;
  snoreMitigation: boolean;
  preset: string | null;
}
