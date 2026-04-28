# bexio-shared

Read-only Bexio adapter shared by AI Bridge agents (`cashflow-agent`, `sales-pipeline-agent`, ...).

## Why this exists

Two agents need to read from Bexio: cashflow-agent (forecasting) and sales-pipeline-agent (invoice status sync). Without a shared package, each agent had its own copy of `bexio-http.js`, `bexio-auth.js`, etc. — easy to drift.

This package centralizes the OAuth handling, paginated HTTP wrapper, contact map, and invoice fetcher. It's installed via git URL in each agent's `package.json`:

```json
{
  "dependencies": {
    "bexio-shared": "git+https://github.com/ai-bridge-ag/bexio-shared.git#main"
  }
}
```

Bump the SHA / tag to upgrade.

## READ-ONLY by design

**This package never exports a write function.** No `bxPost`, no `bxPatch`, no `bxDelete`. Bexio is the financial system of record — corrupting an invoice via a bot would be hard to recover from.

If you ever need a write (e.g. mark a Bexio invoice as cancelled when the parent deal is dropped):

1. Open a SEPARATE PR adding a NAMED, SCOPED function (e.g. `markInvoiceAsCancelledInBexio(invoiceId)`).
2. Get explicit security review on it.
3. Never add a generic `bxPost`/`bxPatch` — those are too easy to misuse later.

In addition, consumers MUST configure their Bexio OAuth app with **read-only scopes** (`kb_invoice_show`, `kb_invoice_show_all`, `contact_show`). Even if this package ever ships a buggy write call by accident, Bexio rejects it at the auth gate. Belt-and-suspenders.

## Required env vars

```
BEXIO_CLIENT_ID
BEXIO_CLIENT_SECRET
BEXIO_REFRESH_TOKEN
```

Optional:
```
BEXIO_WEB_BASE  # default https://office.bexio.com
```

Each consuming agent MUST have its own Bexio OAuth integration (separate refresh tokens). Sharing one refresh token across agents causes auth races (the token rotates on use, one consumer can invalidate the other).

## Usage

```js
import { fetchInvoices, fetchContactMap, setLogger } from 'bexio-shared';
import { logger as appLogger } from './logger.js';

// Optional: pipe bexio-shared logs into the host app's logger.
setLogger(appLogger);

const invoices = await fetchInvoices();
// → [{ id, status, total_chf, outstanding_chf, customer, bexio_url, ... }]
```

See `index.js` for the full export surface.

## Status mapping (kb_item_status_id → domain)

```
 7  draft
 8  open (issued, awaiting payment)
 9  paid
10  partially paid              → 'open'
15  cancelled
16  cancelled
19  settled by credit voucher   → 'paid'
21  overdue                     → 'overdue'
```

Unknown ids fall back to `'open'` with a warning. The `'open'` status is also upgraded to `'overdue'` based on `due_date < today` as a safety net.
