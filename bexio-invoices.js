// Bexio invoice adapter.
//
// Fetches all invoices (v2.0 API, kb_invoice), normalizes to the domain shape
// (see types.js::BexioInvoice), and filters to the statuses the forecast cares
// about.
//
// Amounts: we expose BOTH gross (`total_chf`, the original invoice total) and
// outstanding (`outstanding_chf` / legacy `amount_chf`, what's still owed).
// Conflating them was causing paid invoices to surface as "CHF 0" and Claude
// couldn't answer "what has been invoiced" for completed work.
//   - `total_chf` ← Bexio's `total` (gross incl. VAT)
//   - `outstanding_chf` ← `total_remaining_payments` (after payments/credits)
//   - `amount_chf` is kept = outstanding_chf for forecast.js backwards-compat
//
// Customer identity: `title` is the invoice title line (e.g. "Hands on RAG Kurs
// vom 25. März 2026") — useful metadata but NOT the customer. The actual
// customer comes from joining `contact_id` against the contact directory
// (bexio-contacts.js). Never conflate the two — Claude will hallucinate a
// customer-name match against invoice titles and confidently give the wrong
// answer (e.g. mapping contact:93 to SV Group because it saw "Schweizer…"
// in another invoice's title).
//
// Currency: most invoices are CHF (currency_id=1). Non-CHF are converted via
// the hardcoded FX table below. Replace with live feed if a majority of your
// revenue ever flips to EUR/USD.
//
// Status mapping (kb_item_status_id → domain): Bexio uses integer IDs that are
// partially tenant-defined. The observed set in this tenant:
//     7  draft
//     8  open (issued, awaiting payment)
//     9  paid
//    10  partially paid                       → 'open' (still outstanding)
//    15  cancelled
//    19  settled by credit voucher            → 'paid'
//    21  overdue (when Bexio sets it itself)  → 'overdue'
// Unknown IDs fall back to 'open' with a warning, so the forecast never
// silently drops an invoice because of a status ID we haven't seen. We also
// upgrade 'open' → 'overdue' ourselves based on due_date, as a safety net.
//
// Fail-closed contract: any error → { ok: false, reason, fallback: [] }.

import { bxGet, bxList } from './bexio-http.js';
import { fetchContactMap } from './bexio-contacts.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'sources/bexio-invoices' });

const STATUS_MAP = {
  7: 'draft',
  8: 'open',
  9: 'paid',
  10: 'open',        // partially paid — still has outstanding amount
  15: 'cancelled',
  16: 'cancelled',
  19: 'paid',        // settled via credit voucher
  21: 'overdue',
};

// Bexio web UI base. Same for every tenant — they don't per-subdomain. The
// tenant is identified by the session cookie, not the URL. The invoice detail
// page URL is deterministic: /kb_invoice/show/id/{internal_id}. Override via
// env only if Bexio ever rolls out a new routing scheme.
const BEXIO_WEB_BASE = process.env.BEXIO_WEB_BASE || 'https://office.bexio.com';
function invoiceWebUrl(id) {
  return `${BEXIO_WEB_BASE}/index.php/kb_invoice/show/id/${encodeURIComponent(id)}`;
}

function mapStatus(id) {
  if (STATUS_MAP[id]) return STATUS_MAP[id];
  log.warn('unknown kb_item_status_id — defaulting to open', { id });
  return 'open';
}

// 1 unit of X in CHF. Hardcoded fallback — replace with live feed if ever material.
const FX_FALLBACK = { CHF: 1, EUR: 0.95, USD: 0.88, GBP: 1.12 };
const CURRENCY_BY_ID = { 1: 'CHF', 2: 'EUR', 3: 'USD' };

function toChf(amount, currencyId) {
  const code = CURRENCY_BY_ID[currencyId] || 'CHF';
  const rate = FX_FALLBACK[code];
  if (rate == null) return amount; // unknown → pass through (1:1)
  return amount * rate;
}

/**
 * Normalize a raw Bexio invoice into the snapshot shape.
 *
 * Fields produced:
 *   id              stable Bexio ID as string
 *   document_nr     human-readable "RE-00495" — what the user sees in Bexio UI
 *   title           invoice title line (NOT the customer)
 *   customer_name   actual customer from contact join; "contact:ID" fallback
 *   customer_id     raw contact_id (number) for cross-reference
 *   total_chf       gross total (Bexio `total`), FX-converted
 *   outstanding_chf what's still owed after payments/credits
 *   amount_chf      = outstanding_chf (kept for forecast.js backwards-compat)
 *   status          see STATUS_MAP
 *   issued_date / due_date / paid_date
 *   bexio_url       direct link to the invoice detail page in Bexio web UI
 */
function normalize(inv, contactMap) {
  const total = Number(inv.total ?? 0);
  const remaining = Number(inv.total_remaining_payments ?? 0);
  // NET amount excl. VAT — Bexio's own `total_net` (the sum of net positions).
  // Use this field directly, never total/1.081: VAT rates vary and some
  // invoices are exempt, in which case total_net == total. Falls back to gross
  // if the field is missing.
  const totalNet = Number(inv.total_net ?? total);
  const status = mapStatus(inv.kb_item_status_id);
  const total_chf = toChf(total, inv.currency_id);
  const outstanding_chf = toChf(remaining, inv.currency_id);
  const net_chf = toChf(totalNet, inv.currency_id);
  // Net portion of what's still owed, using THIS invoice's own net/gross ratio
  // (actual Bexio figures, no assumed VAT rate). For an unpaid invoice
  // remaining == total, so this equals net_chf.
  const outstanding_net_chf = total > 0 ? toChf(remaining * (totalNet / total), inv.currency_id) : outstanding_chf;
  const customer_name = inv.contact_id
    ? (contactMap?.get(inv.contact_id) || `contact:${inv.contact_id}`)
    : '(no contact)';
  return {
    id: String(inv.id),
    document_nr: inv.document_nr || null,
    title: inv.title || null,
    customer_name,
    customer_id: inv.contact_id || null,
    total_chf,
    net_chf,             // gross excl. VAT (Bexio total_net)
    outstanding_chf,
    outstanding_net_chf, // net portion still owed
    amount_chf: outstanding_chf, // forecast.js backwards-compat
    status,
    issued_date: inv.is_valid_from || null,
    due_date: inv.is_valid_to || null,
    paid_date: status === 'paid' ? (inv.updated_at || null) : undefined,
    // Direct link to the invoice in the Bexio web UI. The agent always cites
    // invoices with a clickable link so the user can open the source in one
    // click rather than searching by RE-number.
    bexio_url: invoiceWebUrl(inv.id),
  };
}

/** If Bexio hasn't flipped to overdue yet, do it ourselves based on due_date. */
function computeOverdue(inv, now = new Date()) {
  if (inv.status !== 'open') return inv;
  if (!inv.due_date) return inv;
  const due = new Date(inv.due_date);
  if (Number.isNaN(due.getTime())) return inv;
  if (due.getTime() < now.getTime()) return { ...inv, status: 'overdue' };
  return inv;
}

export async function fetchInvoices() {
  try {
    const t0 = Date.now();
    // Fetch invoices + contact directory in parallel. A partial failure on
    // contacts degrades to "contact:ID" placeholders — we'd rather ship the
    // invoice list than block the whole snapshot on a names lookup.
    const [raw, contactMap] = await Promise.all([
      bxList('/2.0/kb_invoice', { pageSize: 500, safetyCap: 10000 }),
      fetchContactMap(),
    ]);
    const normalized = raw
      .map((inv) => normalize(inv, contactMap))
      .map((i) => computeOverdue(i));
    log.info('bexio invoices fetched', {
      ms: Date.now() - t0,
      count: normalized.length,
      contacts_resolved: normalized.filter((i) => !i.customer_name.startsWith('contact:')).length,
      by_status: countBy(normalized, (i) => i.status),
      outstanding_chf: normalized
        .filter((i) => ['open', 'overdue', 'draft'].includes(i.status))
        .reduce((s, i) => s + i.outstanding_chf, 0),
    });
    return { ok: true, data: normalized };
  } catch (err) {
    log.error('bexio invoices failed', { err: err.message });
    return { ok: false, reason: `bexio-invoices: ${err.message}`, fallback: [] };
  }
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Fetch a single invoice's PDF from Bexio. Returns { name, mime, size, buffer }
 * with the decoded binary. Throws on any error — callers should catch and
 * report per-invoice failures.
 *
 * Bexio endpoint: GET /2.0/kb_invoice/{id}/pdf
 *   → { name: "re-00495.pdf", mime: "application/pdf", size: <int>, content: <base64> }
 * Requires the `kb_invoice_show` scope (already present in our refresh token).
 */
export async function fetchInvoicePdf(invoiceId) {
  const id = String(invoiceId);
  const res = await bxGet(`/2.0/kb_invoice/${encodeURIComponent(id)}/pdf`);
  if (!res || typeof res.content !== 'string' || !res.content.length) {
    throw new Error(`bexio PDF response for invoice ${id} missing content`);
  }
  const buffer = Buffer.from(res.content, 'base64');
  if (buffer.length < 4 || buffer.slice(0, 4).toString() !== '%PDF') {
    throw new Error(`bexio PDF response for invoice ${id} is not a valid PDF (first bytes: ${buffer.slice(0, 4).toString('hex')})`);
  }
  return {
    name: res.name || `invoice-${id}.pdf`,
    mime: res.mime || 'application/pdf',
    size: buffer.length,
    buffer,
  };
}
