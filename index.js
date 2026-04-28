// Re-export the read-only Bexio adapter surface.
//
// READ-ONLY by design. To add a write function, open a SEPARATE PR adding
// a NAMED, SCOPED function (e.g. markInvoiceAsCancelledInBexio) with an
// explicit security review. Never export a generic bxPost / bxPatch /
// bxDelete from this package — corrupting Bexio data is exactly what
// the read-only-by-default boundary prevents.
//
// In addition, consumers SHOULD configure their Bexio OAuth app with
// read-only scopes (kb_invoice_show, kb_invoice_show_all, contact_show)
// so even if this package ever ships a buggy write call, Bexio rejects
// it at the auth gate.

export { getAccessToken, invalidate } from './bexio-auth.js';
export { bxGet, bxList } from './bexio-http.js';
export { fetchContactMap, _resetContactCache } from './bexio-contacts.js';
export { fetchInvoices, fetchInvoicePdf } from './bexio-invoices.js';
export { logger, setLogger } from './logger.js';
