import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRecommendationFloor,
  crossDocumentSignals,
  preflightSignals,
  riskBandFor,
  routeClaim,
  ruleRecommendationFloor,
  ruleRiskScore,
} from '../lib/agent.js';

const claim = (over = {}) => ({
  id: 'CLM-TEST',
  claimType: 'auto',
  policyNumber: 'POL-1',
  incidentDate: '2026-09-01',
  amountCents: 20000_50, // deliberately not a round figure
  currency: 'USD',
  description: 'Rear end collision',
  claimantEmail: 'a@b.c',
  ...over,
});

const today = new Date().toISOString().slice(0, 10);

test('risk bands sit on the documented thresholds', () => {
  assert.equal(riskBandFor(0), 'low');
  assert.equal(riskBandFor(24), 'low');
  assert.equal(riskBandFor(25), 'medium');
  assert.equal(riskBandFor(49), 'medium');
  assert.equal(riskBandFor(50), 'high');
  assert.equal(riskBandFor(74), 'high');
  assert.equal(riskBandFor(75), 'critical');
  assert.equal(riskBandFor(100), 'critical');
});

test('a clean claim produces no rule signals and the lowest risk', () => {
  const signals = preflightSignals(claim(), { documents: [{ id: 'd1' }], duplicateHits: [] });
  assert.deepEqual(signals, []);
  assert.equal(ruleRiskScore(signals), 0);
});

test('a future incident date is critical', () => {
  const signals = preflightSignals(claim({ incidentDate: '2099-01-01' }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  assert.equal(signals.find((s) => s.code === 'FUTURE_INCIDENT_DATE').severity, 'critical');
});

test('reporting delay escalates from low to medium', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const slow = preflightSignals(claim({ incidentDate: daysAgo(90) }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  const verySlow = preflightSignals(claim({ incidentDate: daysAgo(200) }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  assert.equal(slow.find((s) => s.code === 'DELAYED_REPORTING').severity, 'low');
  assert.equal(verySlow.find((s) => s.code === 'LATE_REPORTING').severity, 'medium');
});

test('a claim with no documents is flagged', () => {
  const signals = preflightSignals(claim(), { documents: [], duplicateHits: [] });
  assert.equal(signals.find((s) => s.code === 'NO_DOCUMENTS').severity, 'high');
});

test('routing sends a duplicate submission straight to investigations', () => {
  const signals = preflightSignals(claim(), {
    documents: [{ id: 'd1' }],
    duplicateHits: [{ claimId: 'CLM-OTHER', filename: 'x.pdf', sha256: 'ab' }],
  });
  const routing = routeClaim({ claim: claim(), ruleSignals: signals, synthesis: { riskBand: 'low' } });
  assert.equal(routing.department, 'siu');
  assert.match(routing.reason, /another claim/);
});

test('a routine claim stays with its own line of business', () => {
  const routing = routeClaim({
    claim: claim({ claimType: 'health' }),
    ruleSignals: [],
    synthesis: { riskBand: 'low', aiDepartment: 'health' },
  });
  assert.equal(routing.department, 'health');
  assert.equal(routing.overridden, false);
});

test('the agent may route sideways, and the reason records the override', () => {
  const routing = routeClaim({
    claim: claim({ claimType: 'health' }),
    ruleSignals: [],
    synthesis: { riskBand: 'medium', aiDepartment: 'travel', aiRationale: 'Overseas treatment.' },
  });
  assert.equal(routing.department, 'travel');
  assert.equal(routing.overridden, true);
  assert.match(routing.reason, /Overseas treatment/);
});

test('a model that downplays a critical rule cannot avoid investigations', () => {
  const signals = preflightSignals(claim({ incidentDate: '2099-01-01' }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  const routing = routeClaim({
    claim: claim(),
    ruleSignals: signals,
    synthesis: { riskBand: 'low', aiDepartment: 'auto', suspectedFraud: false },
  });
  assert.equal(routing.department, 'siu');
  assert.equal(routing.overridden, true);
  assert.ok(ruleRiskScore(signals) >= 40);
});

test('an incident date before today is not treated as a future date', () => {
  const signals = preflightSignals(claim({ incidentDate: today }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  assert.equal(signals.find((s) => s.code === 'FUTURE_INCIDENT_DATE'), undefined);
});

test('a critical rule signal forces at least an investigation', () => {
  const signals = preflightSignals(claim({ incidentDate: '2099-01-01' }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  assert.equal(ruleRecommendationFloor(signals, ruleRiskScore(signals)), 'investigate');
});

test('a high but non-critical rule score asks for evidence rather than clearing the claim', () => {
  const signals = [{ code: 'X', severity: 'high', description: 'x' }]; // 24 -> below the escalation mark
  assert.equal(ruleRecommendationFloor(signals, 24), 'approve');
  assert.equal(ruleRecommendationFloor(signals, 40), 'request_info');
});

test('the model may escalate but never clear past the floor', () => {
  assert.equal(applyRecommendationFloor('approve', 'investigate'), 'investigate');
  assert.equal(applyRecommendationFloor(null, 'request_info'), 'request_info');
  assert.equal(applyRecommendationFloor('investigate', 'approve'), 'investigate');
  assert.equal(applyRecommendationFloor('reject', 'investigate'), 'reject');
  assert.equal(applyRecommendationFloor('request_info', 'approve'), 'request_info');
});

test('rules-only mode agrees with the floor it publishes', () => {
  const signals = preflightSignals(claim({ incidentDate: '2099-01-01' }), { documents: [{ id: 'd1' }], duplicateHits: [] });
  const score = ruleRiskScore(signals);
  assert.equal(ruleRecommendationFloor(signals, score), 'investigate');
});


test('cross-document comparison flags conflicting policy numbers', () => {
  const docs = [{ id: 'd1', filename: 'policy.pdf' }, { id: 'd2', filename: 'invoice.pdf' }];
  const analyses = [
    { documentId: 'd1', extracted: { policyNumberOnDocument: 'POL-100' } },
    { documentId: 'd2', extracted: { policyNumberOnDocument: 'POL-200' } },
  ];
  const signals = crossDocumentSignals(docs, analyses);
  assert.equal(signals.find((s) => s.code === 'CROSS_DOC_POLICY_CONFLICT')?.severity, 'high');
});

test('cross-document comparison ignores missing fields and accepts matching insured names', () => {
  const docs = [{ id: 'd1', filename: 'a.pdf' }, { id: 'd2', filename: 'b.pdf' }];
  const analyses = [
    { documentId: 'd1', extracted: { patientOrInsuredName: 'A. Example', policyNumberOnDocument: 'POL-1' } },
    { documentId: 'd2', extracted: { patientOrInsuredName: 'A. Example', policyNumberOnDocument: null } },
  ];
  assert.deepEqual(crossDocumentSignals(docs, analyses), []);
});
