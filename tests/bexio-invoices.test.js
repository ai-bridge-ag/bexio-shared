import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../bexio-invoices.js';

// Real-world fixtures from 2026-07-07: status 19 ("settled via credit
// voucher") hides both genuine settlements and STORNOS. The voucher total is
// the discriminator.

test('fully credited invoice is cancelled with zero earned revenue (SNB RE-00490)', () => {
  const inv = normalize({
    id: 1, document_nr: 'RE-00490', kb_item_status_id: 19,
    total: 5945.5, total_net: 5500, total_remaining_payments: 0,
    total_credit_vouchers: 5945.5, currency_id: 1,
  }, new Map());
  assert.equal(inv.status, 'cancelled');
  assert.equal(inv.earned_net_chf, 0);
  assert.equal(inv.credited_chf, 5945.5);
  assert.equal(inv.net_chf, 5500); // face value preserved for reference
});

test('partially credited invoice keeps status but exposes reduced earned net (RE-00060 shape)', () => {
  const inv = normalize({
    id: 2, document_nr: 'RE-00060', kb_item_status_id: 9,
    total: 3600, total_net: 3333, total_remaining_payments: 0,
    total_credit_vouchers: 900, currency_id: 1,
  }, new Map());
  assert.equal(inv.status, 'paid');
  assert.equal(inv.credited_chf, 900);
  assert.equal(Math.round(inv.earned_net_chf * 100) / 100, 2499.75); // 3333 × (1 − 900/3600)
});

test('uncredited paid invoice: earned equals net, nothing changes', () => {
  const inv = normalize({
    id: 3, document_nr: 'RE-00491', kb_item_status_id: 9,
    total: 11937, total_net: 11042.55, total_remaining_payments: 0,
    total_credit_vouchers: 0, currency_id: 1,
  }, new Map());
  assert.equal(inv.status, 'paid');
  assert.equal(inv.earned_net_chf, 11042.55);
  assert.equal(inv.credited_chf, 0);
});

test('rounding epsilon: credited within 1 rappen of total still counts as full storno', () => {
  const inv = normalize({
    id: 4, kb_item_status_id: 19, total: 100, total_net: 92.5,
    total_remaining_payments: 0, total_credit_vouchers: 99.995, currency_id: 1,
  }, new Map());
  assert.equal(inv.status, 'cancelled');
});
