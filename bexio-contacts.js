// Bexio contact adapter. Only purpose: resolve contact_id → display name
// so invoice rows carry the real customer ("SV (Schweiz) AG") instead of
// an opaque "contact:271" that Claude tries to guess at.
//
// Bexio models a company as a contact with name_1 (company name). Private
// people use name_1 = last name, name_2 = first name. We build a readable
// label from whichever fields are present.
//
// We cache the full contact map in-process for 1 hour. Contacts change
// rarely and re-fetching on every snapshot refresh would triple the Bexio
// round-trips per Slack turn.

import { bxList } from './bexio-http.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'sources/bexio-contacts' });

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = null; // { map: Map<id, name>, at: number }

/** Build a display name from a raw contact row. */
function displayName(c) {
  const a = (c.name_1 || '').trim();
  const b = (c.name_2 || '').trim();
  if (a && b) return `${a} — ${b}`; // e.g. "SV (Schweiz) AG — Training & Development"
  return a || b || `contact:${c.id}`;
}

/**
 * Return a Map<contact_id (number), display_name>.
 * On failure we return an empty Map so invoice normalization can fall back
 * to the contact:ID placeholder — an empty map is degraded but not broken.
 */
export async function fetchContactMap() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }
  try {
    const t0 = Date.now();
    const rows = await bxList('/2.0/contact', { pageSize: 500, safetyCap: 50000 });
    const map = new Map();
    for (const c of rows) {
      map.set(c.id, displayName(c));
    }
    cache = { map, at: now };
    log.info('bexio contacts fetched', { ms: Date.now() - t0, count: map.size });
    return map;
  } catch (err) {
    log.warn('bexio contacts fetch failed — invoices will show contact:ID only', { err: err.message });
    return new Map();
  }
}

/** Test hook: wipe the cache. Not called from normal flow. */
export function _resetContactCache() {
  cache = null;
}
