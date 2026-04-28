// Shared Bexio OAuth helper.
// Exchanges the long-lived refresh token for a short-lived access token (~1h),
// caches it in memory until near-expiry, and exposes a single `getAccessToken()`
// that adapters call on every request.
//
// Env:
//   BEXIO_CLIENT_ID
//   BEXIO_CLIENT_SECRET
//   BEXIO_REFRESH_TOKEN
//
// Not thread-safe across processes (fine for a single Railway instance).
// Within one process: dedupes concurrent refreshes via an in-flight promise.

import { logger } from './logger.js';

const log = logger.child({ mod: 'sources/bexio-auth' });

const TOKEN_URL = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token';
const EARLY_REFRESH_MS = 60 * 1000; // refresh 1 min before expiry

let cached = null;        // { access_token, expires_at_ms }
let inFlight = null;      // Promise<cached> while a refresh is running

async function refreshNow() {
  const clientId = process.env.BEXIO_CLIENT_ID;
  const clientSecret = process.env.BEXIO_CLIENT_SECRET;
  const refreshToken = process.env.BEXIO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('bexio-auth: BEXIO_CLIENT_ID, BEXIO_CLIENT_SECRET, BEXIO_REFRESH_TOKEN all required');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`bexio-auth: token refresh ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (!json.access_token || !json.expires_in) {
    throw new Error(`bexio-auth: unexpected token response: ${JSON.stringify(json).slice(0, 300)}`);
  }

  cached = {
    access_token: json.access_token,
    expires_at_ms: Date.now() + Number(json.expires_in) * 1000,
  };
  log.info('access token refreshed', { expires_in_s: Number(json.expires_in) });
  return cached;
}

/**
 * Get a valid access token. Refreshes if expired or near expiry. Deduplicates
 * concurrent callers so only one refresh fires at a time.
 * @returns {Promise<string>}
 */
export async function getAccessToken() {
  if (cached && cached.expires_at_ms > Date.now() + EARLY_REFRESH_MS) {
    return cached.access_token;
  }
  if (inFlight) {
    const c = await inFlight;
    return c.access_token;
  }
  inFlight = refreshNow().finally(() => { inFlight = null; });
  const c = await inFlight;
  return c.access_token;
}

/** Drop cached token — force a refresh on next call. Used after a 401. */
export function invalidate() {
  cached = null;
}
