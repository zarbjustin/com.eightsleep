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
