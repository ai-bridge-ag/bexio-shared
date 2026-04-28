// Authenticated HTTP client for Bexio. Handles:
//   - Bearer access_token injection from sources/bexio-auth.js
//   - One-shot retry on 401 (invalidates cache, refreshes, retries)
//   - JSON parsing
//   - Transparent pagination via offset/limit (for the list endpoints that support it)

import { getAccessToken, invalidate } from './bexio-auth.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'sources/bexio-http' });
const BASE = 'https://api.bexio.com';

async function doFetch(path, opts = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      accept: 'application/json',
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
      authorization: `Bearer ${token}`,
    },
  });
  return res;
}

/**
 * GET a Bexio JSON endpoint. Retries once on 401 after forcing a token refresh.
 * Returns parsed JSON on 2xx, throws with body preview otherwise.
 */
export async function bxGet(path, { query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  let res = await doFetch(path + qs);
  if (res.status === 401) {
    log.warn('401 from bexio; refreshing token once', { path });
    invalidate();
    res = await doFetch(path + qs);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`bexio GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Paginate through a list endpoint using offset/limit. Stops when a page returns
 * fewer rows than the page size or when safetyCap is hit.
 */
export async function bxList(path, { query = {}, pageSize = 500, safetyCap = 5000 } = {}) {
  const all = [];
  let offset = 0;
  while (all.length < safetyCap) {
    const page = await bxGet(path, { query: { ...query, limit: pageSize, offset } });
    if (!Array.isArray(page)) {
      // Some endpoints wrap results in an object — caller must use bxGet instead.
      throw new Error(`bexio list ${path}: expected array, got ${typeof page}`);
    }
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
