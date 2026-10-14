import assert from 'node:assert/strict';
import test from 'node:test';

import { agreesWithAgent, validateDecision } from '../lib/decisions.js';

test('rejects an unknown action', () => {
  assert.match(validateDecision({ action: 'pay' }).error, /must be one of/);
});

test('requires a written justification to reject or escalate', () => {
  assert.match(validateDecision({ action: 'reject', notes: 'no' }).error, /justification/);
  assert.match(validateDecision({ action: 'escalate', notes: '  short  ' }).error, /justification/);
  assert.equal(validateDecision({ action: 'reject', notes: 'Invoice arithmetic does not reconcile.' }).error, undefined);
});

test('does not require a justification to request information', () => {
  assert.equal(validateDecision({ action: 'request_info' }).error, undefined);
});

test('an approval must carry a positive amount', () => {
  assert.match(validateDecision({ action: 'approve', claimedCents: 100000 }).error, /amount to approve/);
  assert.match(validateDecision({ action: 'approve', amountApprovedCents: 0, claimedCents: 100000 }).error, /amount to approve/);
});

test('an approval cannot exceed twice the claim', () => {
  assert.match(
    validateDecision({ action: 'approve', amountApprovedCents: 200001, claimedCents: 100000 }).error,
    /twice the claimed amount/,
  );
  assert.equal(validateDecision({ action: 'approve', amountApprovedCents: 200000, claimedCents: 100000 }).amountApprovedCents, 200000);
});

test('non-approval actions never record a payout', () => {
  assert.equal(validateDecision({ action: 'request_info', amountApprovedCents: 5000 }).amountApprovedCents, null);
  assert.equal(validateDecision({ action: 'reject', notes: 'Duplicate of claim CLM-1.', amountApprovedCents: 5000 }).amountApprovedCents, null);
});

test('agreesWithAgent maps the agent vocabulary onto the human actions', () => {
  assert.equal(agreesWithAgent('escalate', 'investigate'), true);
  assert.equal(agreesWithAgent('approve', 'investigate'), false);
  assert.equal(agreesWithAgent('request_info', 'request_info'), true);
  assert.equal(agreesWithAgent('approve', null), null);
});
