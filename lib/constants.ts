'use strict';

/**
 * Endpoints and constants for Eight Sleep's (unofficial) cloud API.
 *
 * Eight Sleep does not publish a public API. The base URLs, OAuth grant shape
 * and public mobile OAuth client values below are used by existing open-source
 * integrations, but remain unofficial and may stop working if Eight Sleep
 * changes its cloud service. They are NOT user secrets; user credentials are
 * supplied at pairing time and are never stored in source.
 */

export const AUTH_URL = 'https://auth-api.8slp.net/v1/tokens';
export const CLIENT_API_URL = 'https://client-api.8slp.net/v1';
export const APP_API_URL = 'https://app-api.8slp.net/';

// Public OAuth client extracted from the official Android app. Used as the
// default when the user does not supply their own client_id / client_secret.
export const KNOWN_CLIENT_ID = '0894c7f33bb94800a03f1f4df13a4f38';
export const KNOWN_CLIENT_SECRET = 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76';

// Refresh the access token this many seconds before it actually expires.
export const TOKEN_TIME_BUFFER_SECONDS = 120;

// Network timeout for a single request, in milliseconds.
export const DEFAULT_TIMEOUT_MS = 30_000;

// 429 backoff: base delay doubles each attempt, capped, for this many retries.
export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

// Minimum gap between outgoing requests to be a good API citizen.
export const MIN_REQUEST_GAP_MS = 250;

export const AUTH_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'user-agent': 'okhttp/4.9.3',
  'accept-encoding': 'gzip',
  accept: 'application/json',
};

export const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  connection: 'keep-alive',
  'user-agent': 'okhttp/4.9.3',
  'accept-encoding': 'gzip',
  accept: 'application/json',
};
