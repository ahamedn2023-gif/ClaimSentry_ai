// The claim triage agent.
//
// Stage 1  deterministic checks   - cheap, explainable, always run
// Stage 2  document examination   - multimodal model per document, if a key is set
// Stage 3  claim synthesis        - risk score, band, recommendation, routing
//
// Set GEMINI_API_KEY to enable stage 2/3. Set GEMINI_ENDPOINT to send the same
// requests through a gateway or a test double.
//
// Routing is decided by the deterministic rule engine in `routeClaim`; the model
// can only *argue* for a different department, and every rule that fires is
// recorded on the claim so a human can audit why it landed on their desk.

import { clamp, daysBetween, toCents } from './util.js';
import { CLAIM_TYPES } from './store.js';

/** Default ClaimSentry document examiner. */
export const DEFAULT_MODEL = 'CLAIMSENTRY_AGENT-20.26 Running';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Base endpoint for the model. Override with GEMINI_ENDPOINT to route through a
 * gateway or a mock during testing; the request shape is unchanged.
 */
const endpointFor = (env) => (env.GEMINI_ENDPOINT || GEMINI_ENDPOINT).replace(/\/+$/, '');

const SEVERITY_WEIGHT = { critical: 40, high: 24, medium: 12, low: 5, info: 0 };
export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
export const RISK_BANDS = ['low', 'medium', 'high', 'critical'];

export const riskBandFor = (score) => {
  if (score === null || score === undefined) return null;
  if (score < 25) return 'low';
  if (score < 50) return 'medium';
  if (score < 75) return 'high';
  return 'critical';
};

const signal = (code, severity, description, evidence = null) => ({
  code,
  severity,
  description,
  evidence,
  source: 'rule',
});

/* ------------------------------------------------- stage 1: deterministic */

export function preflightSignals(claim, { documents, duplicateHits }) {
  const signals = [];
  const today = new Date().toISOString().slice(0, 10);
  const amount = claim.amountCents ?? 0;

  if (documents.length === 0) {
    signals.push(
      signal('NO_DOCUMENTS', 'high', 'No supporting documents were attached to this claim.', null),
    );
  }

  for (const hit of duplicateHits) {
    signals.push(
      signal(
        'DUPLICATE_DOCUMENT',
        'critical',
        `Document "${hit.filename}" is byte-identical to one already submitted on claim ${hit.claimId}.`,
        { previousClaimId: hit.claimId, sha256: hit.sha256 },
      ),
    );
  }

  if (claim.incidentDate) {
    if (claim.incidentDate > today) {
      signals.push(
        signal('FUTURE_INCIDENT_DATE', 'critical', `Incident date ${claim.incidentDate} is in the future.`, claim.incidentDate),
      );
    } else {
      const lag = -daysBetween(claim.incidentDate, today);
      if (lag > 180) {
        signals.push(
          signal('LATE_REPORTING', 'medium', `Claim was reported ${lag} days after the incident.`, `${lag} days`),
        );
      } else if (lag > 60) {
        signals.push(
          signal('DELAYED_REPORTING', 'low', `Claim was reported ${lag} days after the incident.`, `${lag} days`),
        );
      }
    }
  } else {
    signals.push(signal('MISSING_INCIDENT_DATE', 'low', 'No incident date was supplied.', null));
  }

  if (amount >= 100000_00) {
    signals.push(signal('VERY_HIGH_VALUE', 'high', `Claimed amount is $${(amount / 100).toLocaleString()}.`, null));
  } else if (amount >= 25000_00) {
    signals.push(signal('HIGH_VALUE', 'medium', `Claimed amount is $${(amount / 100).toLocaleString()}.`, null));
  }

  if (amount >= 5000_00 && amount % 100000 === 0) {
    signals.push(signal('ROUND_AMOUNT', 'low', 'Claimed amount is an exact round figure.', null));
  }

  if (!claim.claimantEmail) {
    signals.push(signal('NO_CONTACT_EMAIL', 'info', 'No e-mail address was supplied for the claimant.', null));
  }

  return signals;
}

export const severityWeight = (severity) => SEVERITY_WEIGHT[severity] ?? 0;

/** Deterministic risk floor: the sum of the fired rule weights. */
export const ruleRiskScore = (signals) =>
  clamp(signals.reduce((sum, s) => sum + severityWeight(s.severity), 0), 0, 100);

export const RECOMMENDATIONS = ['approve', 'request_info', 'investigate', 'reject'];
const RECOMMENDATION_RANK = { approve: 0, request_info: 1, investigate: 2, reject: 3 };

/**
 * The rules set a minimum recommendation. A claim that tripped a critical rule
 * is never merely "approve"; it needs investigation or at least more evidence.
 */
export function ruleRecommendationFloor(ruleSignals, ruleScore) {
  if (ruleSignals.some((s) => s.severity === 'critical')) return 'investigate';
  if (ruleScore >= 40) return 'request_info';
  return 'approve';
}

/**
 * Combine the model's recommendation with the rule floor. The model may raise
 * severity but never lower it - same principle as the risk score.
 */
export function applyRecommendationFloor(modelRecommendation, floor) {
  const model = RECOMMENDATION_RANK[modelRecommendation] ?? 0;
  const minimum = RECOMMENDATION_RANK[floor] ?? 0;
  return model >= minimum ? modelRecommendation : floor;
}

/* ---------------------------------- stage 2: per-document model analysis */

const DOC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    document_type: {
      type: 'STRING',
      enum: ['invoice', 'receipt', 'medical_report', 'prescription', 'police_report', 'repair_estimate', 'policy_document', 'identity_document', 'photograph', 'discharge_summary', 'other', 'unreadable'],
    },
    legibility: { type: 'STRING', enum: ['clear', 'partial', 'unreadable'] },
    issuer: { type: 'STRING', nullable: true },
    document_number: { type: 'STRING', nullable: true },
    document_date: { type: 'STRING', nullable: true },
    document_amount: { type: 'NUMBER', nullable: true },
    patient_or_insured_name: { type: 'STRING', nullable: true },
    policy_number_on_document: { type: 'STRING', nullable: true },
    service_description: { type: 'STRING', nullable: true },
    authenticity_score: { type: 'INTEGER' },
    tamper_signals: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: { type: 'STRING' },
          severity: { type: 'STRING', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          description: { type: 'STRING' },
          evidence: { type: 'STRING', nullable: true },
        },
        required: ['code', 'severity', 'description'],
      },
    },
    positive_signals: { type: 'ARRAY', items: { type: 'STRING' } },
    consistency_notes: { type: 'STRING', nullable: true },
    summary: { type: 'STRING' },
  },
  required: ['document_type', 'legibility', 'authenticity_score', 'tamper_signals', 'positive_signals', 'summary'],
};

const DOC_SYSTEM = `You are a forensic document examiner working for an insurance claims department.
You are given one supporting document from a claim and the claim's declared data.
Assess the document as evidence. Report what you actually observe; never invent details you cannot see.

Look specifically for:
- digitally altered or erased regions, inconsistent fonts, misaligned baselines, mismatched font weights
- cloned or repeated blocks of text, copy-pasted punctuation, uneven letter spacing
- numbers that do not sum (line items vs total), totals in words vs digits, GST/tax arithmetic errors
- inconsistent dates (service before policy start, dates after the incident, out-of-order sequence)
- stamps/signatures that are pasted, cropped, mirrored, or duplicated inside the document
- screenshots of screenshots, heavy recompression, elliptical/circular artifacts from JPEG re-saving
- template evidence: untrimmed placeholders, watermark-of-watermark, mismatched letterhead and footer
- content that contradicts the declared claim (wrong patient/insured, wrong policy number, wrong currency, wrong service)
- for photographs: whether the damage is visible, whether the scene matches the described incident, whether metadata-like overlays were edited

authenticity_score: 0-100 where 100 means "no indicators of alteration found"; 50 means inconclusive/incomplete;
below 30 means strong indicators of fabrication. Base it only on observable evidence, and be careful not to
treat poor scan quality alone as evidence of fraud.
Every tamper signal must cite the concrete observation in "evidence".`;

export async function analyzeDocument(env, { claim, bytes, contentType, filename }) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!env.GEMINI_API_KEY) return heuristicAnalysis(filename, 'AI analysis unavailable: no GEMINI_API_KEY is configured on this deployment.');

  if (!isInlinable(contentType)) {
    return heuristicAnalysis(filename, `AI analysis skipped: ${contentType || 'unknown'} cannot be sent to a multimodal model.`);
  }

  const context = `Claim data declared by the claimant:
- claim type: ${claim.claimType}
- policy number: ${claim.policyNumber}
- incident date: ${claim.incidentDate || 'not supplied'}
- claimed amount: ${claim.currency} ${(claim.amountCents / 100).toFixed(2)}
- claimant statement: ${claim.description || 'not supplied'}

Document filename: ${filename}
Content type: ${contentType}

Examine this document and return your findings.`;

  try {
    const result = await callGemini(env, {
      model,
      systemInstruction: DOC_SYSTEM,
      parts: [
        { text: context },
        { inlineData: { mimeType: contentType, data: bytes } },
      ],
      schema: DOC_SCHEMA,
    });

    return normalizeDocAnalysis(result, model, 'ai');
  } catch (err) {
    return {
      ...heuristicAnalysis(filename, `AI analysis failed: ${String(err.message || err).slice(0, 300)}`),
      mode: 'error',
    };
  }
}

function isInlinable(contentType) {
  if (!contentType) return false;
  return (
    contentType.startsWith('image/') ||
    contentType === 'application/pdf' ||
    contentType === 'audio/mpeg' ||
    contentType === 'text/plain'
  );
}

function normalizeDocAnalysis(raw, model, mode) {
  const signals = Array.isArray(raw.tamper_signals)
    ? raw.tamper_signals
        .filter((s) => s && s.description)
        .map((s) => ({
          code: String(s.code || 'MODEL_SIGNAL').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48),
          severity: SEVERITY_ORDER.includes(s.severity) ? s.severity : 'medium',
          description: String(s.description).slice(0, 500),
          evidence: s.evidence ? String(s.evidence).slice(0, 500) : null,
          source: 'model',
        }))
    : [];

  return {
    mode,
    model,
    docType: raw.document_type || 'other',
    legibility: raw.legibility || null,
    extracted: {
      issuer: raw.issuer ?? null,
      documentNumber: raw.document_number ?? null,
      documentDate: raw.document_date ?? null,
      documentAmount: raw.document_amount ?? null,
      patientOrInsuredName: raw.patient_or_insured_name ?? null,
      policyNumberOnDocument: raw.policy_number_on_document ?? null,
      serviceDescription: raw.service_description ?? null,
    },
    authenticityScore: Number.isFinite(raw.authenticity_score) ? clamp(Math.round(raw.authenticity_score), 0, 100) : null,
    tamperSignals: signals,
    positiveSignals: Array.isArray(raw.positive_signals) ? raw.positive_signals.map((s) => String(s).slice(0, 300)) : [],
    consistencyNotes: raw.consistency_notes ?? null,
    summary: raw.summary ?? null,
    error: null,
  };
}

function heuristicAnalysis(filename, reason) {
  return {
    mode: 'heuristic',
    model: null,
    docType: null,
    legibility: null,
    extracted: {},
    authenticityScore: null,
    tamperSignals: [],
    positiveSignals: [],
    consistencyNotes: null,
    summary: `"${filename}" was stored and fingerprinted, but was not examined by the model. ${reason}`,
    error: reason,
  };
}

/** Cross-checks model findings against the data the claimant declared. */
export function crossCheckSignals(claim, documents, analyses) {
  const signals = [];

  for (const analysis of analyses) {
    const doc = documents.find((d) => d.id === analysis.documentId);
    const label = doc?.filename ?? 'document';

    if (analysis.legibility === 'unreadable') {
      signals.push(signal('UNREADABLE_DOCUMENT', 'high', `"${label}" could not be read, so it cannot support the claim.`, label));
    } else if (analysis.legibility === 'partial') {
      signals.push(signal('PARTIAL_DOCUMENT', 'low', `"${label}" is only partially legible.`, label));
    }

    const declaredPolicy = String(claim.policyNumber || '').replace(/\s+/g, '').toUpperCase();
    const docPolicy = String(analysis.extracted?.policyNumberOnDocument || '').replace(/\s+/g, '').toUpperCase();
    if (docPolicy && declaredPolicy && docPolicy !== declaredPolicy) {
      signals.push(
        signal('POLICY_MISMATCH', 'high', `"${label}" shows policy number ${docPolicy} but the claim declares ${declaredPolicy}.`, label),
      );
    }

    const docDate = analysis.extracted?.documentDate;
    if (docDate && claim.incidentDate && /^\d{4}-\d{2}-\d{2}$/.test(docDate)) {
      const gap = daysBetween(docDate, claim.incidentDate);
      if (gap < -30) {
        signals.push(
          signal('DOCUMENT_PREDATES_INCIDENT', 'medium', `"${label}" is dated ${docDate}, more than 30 days before the reported incident date.`, label),
        );
      }
    }

    for (const s of analysis.tamperSignals ?? []) {
      signals.push({
        ...s,
        description: `"${label}": ${s.description}`,
        documentId: analysis.documentId,
        source: 'model',
      });
    }
  }

  // Declared amount vs the sum of the documents that carry an amount.
  const docAmounts = analyses
    .map((a) => toCents(a.extracted?.documentAmount))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (docAmounts.length > 0 && claim.amountCents > 0) {
    const sum = docAmounts.reduce((a, b) => a + b, 0);
    const drift = Math.abs(sum - claim.amountCents) / claim.amountCents;
    if (drift > 0.2) {
      signals.push(
        signal(
          'AMOUNT_MISMATCH',
          'medium',
          `Documents total ${(sum / 100).toFixed(2)} but the claim asks for ${(claim.amountCents / 100).toFixed(2)} (${Math.round(drift * 100)}% difference).`,
          { documentTotal: sum / 100, claimed: claim.amountCents / 100 },
        ),
      );
    }
  }

  return signals;
}

/** Compare extracted fields across all documents in one claim. These are
 * review signals, not proof of fraud: different document types legitimately
 * have different issuers, dates, and reference numbers. */
export function crossDocumentSignals(documents, analyses) {
  const signals = [];
  const pairs = [];
  for (const analysis of analyses) {
    const doc = documents.find((item) => item.id === analysis.documentId);
    if (doc) pairs.push({ doc, analysis, fields: analysis.extracted || {} });
  }
  const norm = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const compare = (field, code, severity, label) => {
    const values = pairs.map(({ doc, fields }) => ({ doc, value: fields[field] }))
      .filter(({ value }) => value !== null && value !== undefined && String(value).trim() !== '')
      .map(({ doc, value }) => ({ filename: doc.filename, value: String(value).trim(), normalized: norm(value) }))
      .filter((item) => item.normalized);
    if (new Set(values.map((item) => item.normalized)).size > 1) {
      signals.push(signal(code, severity,
        `Supporting documents disagree on ${label}: ${values.map((item) => `${item.filename} says "${item.value}"`).join('; ')}. Check whether the difference is expected for these document types.`,
        values.map(({ filename, value }) => ({ filename, value }))));
    }
  };

  // Policy number and insured name should usually agree across supporting records.
  compare('policyNumberOnDocument', 'CROSS_DOC_POLICY_CONFLICT', 'high', 'policy number');
  compare('patientOrInsuredName', 'CROSS_DOC_INSURED_NAME_CONFLICT', 'medium', 'insured/patient name');

  // Compare document dates only where they parse as ISO dates. A date spread is
  // normal across invoices/receipts, so only flag dates after the incident below.
  const dated = pairs.map(({ doc, fields }) => ({ filename: doc.filename, date: fields.documentDate }))
    .filter((item) => typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
  if (dated.length > 1) {
    const incidentDate = pairs[0]?.analysis?.claimIncidentDate;
    if (incidentDate) {
      const after = dated.filter((item) => item.date > incidentDate);
      if (after.length) signals.push(signal('CROSS_DOC_DATE_AFTER_INCIDENT', 'low',
        `Some documents are dated after the reported incident (${incidentDate}): ${after.map((item) => `${item.filename} (${item.date})`).join(', ')}. This may be legitimate; verify the service timeline.`, after));
    }
  }

  // Repeated document numbers across different files can indicate duplicate
  // evidence, but common placeholder numbers are ignored.
  const numberGroups = new Map();
  for (const { doc, fields } of pairs) {
    const number = norm(fields.documentNumber);
    if (!number || ['NA', 'NONE', 'UNKNOWN', '123456', '000000'].includes(number)) continue;
    const key = `${norm(fields.issuer)}:${number}`;
    const list = numberGroups.get(key) || [];
    list.push({ filename: doc.filename, number: fields.documentNumber, issuer: fields.issuer || null });
    numberGroups.set(key, list);
  }
  for (const group of numberGroups.values()) {
    if (group.length > 1) signals.push(signal('CROSS_DOC_REPEATED_REFERENCE', 'medium',
      `The same issuer/reference number appears in multiple uploaded documents: ${group.map((item) => `${item.filename} (${item.number})`).join(', ')}. Confirm these are not duplicate or reused records.`, group));
  }
  return signals;
}

/* ------------------------------------------ stage 3: claim-level synthesis */

const CLAIM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    risk_score: { type: 'INTEGER' },
    risk_band: { type: 'STRING', enum: ['low', 'medium', 'high', 'critical'] },
    recommendation: { type: 'STRING', enum: RECOMMENDATIONS },
    suspected_fraud: { type: 'BOOLEAN' },
    routing_department: { type: 'STRING', enum: [...CLAIM_TYPES, 'siu'] },
    routing_rationale: { type: 'STRING' },
    key_concerns: { type: 'ARRAY', items: { type: 'STRING' } },
    questions_for_claimant: { type: 'ARRAY', items: { type: 'STRING' } },
    case_summary: { type: 'STRING' },
  },
  required: ['risk_score', 'risk_band', 'recommendation', 'suspected_fraud', 'routing_department', 'routing_rationale', 'key_concerns', 'questions_for_claimant', 'case_summary'],
};

const CLAIM_SYSTEM = `You are the triage agent for an insurance claims department. You never decide a claim -
a human department head makes the final decision. Your job is to assess risk and route the file.

Given the claim, the fingerprint and model analysis of every attached document, and the rule signals already
fired, produce an overall assessment:
- risk_score 0-100 (0 = routine, 100 = almost certainly fraudulent)
- risk_band consistent with the score (<25 low, <50 medium, <75 high, else critical)
- recommendation: approve (pay as claimed), request_info (need missing evidence), investigate (SIU), reject
- suspected_fraud: true only when there is concrete evidence, not merely a weak or badly scanned document
- routing_department: who should own the decision. Default to the claim's own line of business; choose "siu"
  when there are strong fraud indicators, materially altered documents, duplicate submissions, or a
  very high value file with unexplained inconsistencies
- key_concerns: short bullet points for the department head
- questions_for_claimant: what the claimant should be asked to supply or explain
- case_summary: 2-4 sentences a busy department head can read in ten seconds

Be calibrated and specific. Absence of evidence is not evidence of fraud: poor image quality, a partially
visible document, or an unusual but plausible amount should not by themselves push a file into SIU.
Write plainly, in the language of the claim.`;

export async function synthesizeClaim(env, { claim, documents, analyses, ruleSignals }) {
  const fallback = () => ({
    riskScore: null,
    riskBand: null,
    recommendation: null,
    suspectedFraud: false,
    aiDepartment: null,
    aiRationale: null,
    keyConcerns: [],
    questions: [],
    caseSummary: null,
    mode: 'heuristic',
    model: null,
  });

  if (!env.GEMINI_API_KEY) {
    const heuristic = heuristicSummary(ruleSignals);
    return { ...fallback(), ...heuristic };
  }

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const payload = {
    claim: {
      reference: claim.id,
      type: claim.claimType,
      policyNumber: claim.policyNumber,
      incidentDate: claim.incidentDate,
      claimedAmount: `${claim.currency} ${(claim.amountCents / 100).toFixed(2)}`,
      statement: claim.description || null,
    },
    documents: documents.map((doc) => {
      const analysis = analyses.find((a) => a.documentId === doc.id);
      return {
        filename: doc.filename,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        alreadySeenOnAnotherClaim: doc.duplicateOfClaimId ?? null,
        modelAnalysis: analysis
          ? {
              mode: analysis.mode,
              documentType: analysis.docType,
              legibility: analysis.legibility,
              authenticityScore: analysis.authenticityScore,
              extracted: analysis.extracted,
              tamperSignals: analysis.tamperSignals,
              positiveSignals: analysis.positiveSignals,
              consistencyNotes: analysis.consistencyNotes,
              summary: analysis.summary,
            }
          : null,
      };
    }),
    ruleSignals: ruleSignals.map((s) => ({ code: s.code, severity: s.severity, description: s.description })),
  };

  try {
    const result = await callGemini(env, {
      model,
      systemInstruction: CLAIM_SYSTEM,
      parts: [{ text: `Claim file:\n${JSON.stringify(payload, null, 2)}` }],
      schema: CLAIM_SCHEMA,
    });

    const riskScore = Number.isFinite(result.risk_score) ? clamp(Math.round(result.risk_score), 0, 100) : null;
    return {
      riskScore,
      riskBand: RISK_BANDS.includes(result.risk_band) ? result.risk_band : riskBandFor(riskScore),
      recommendation: result.recommendation ?? null,
      suspectedFraud: result.suspected_fraud === true,
      aiDepartment: CLAIM_TYPES.includes(result.routing_department) || result.routing_department === 'siu' ? result.routing_department : null,
      aiRationale: result.routing_rationale ?? null,
      keyConcerns: (result.key_concerns ?? []).map((s) => String(s)).slice(0, 12),
      questions: (result.questions_for_claimant ?? []).map((s) => String(s)).slice(0, 12),
      caseSummary: result.case_summary ?? null,
      mode: 'ai',
      model,
    };
  } catch (err) {
    const heuristic = heuristicSummary(ruleSignals);
    return {
      ...fallback(),
      ...heuristic,
      mode: 'error',
      error: String(err.message || err).slice(0, 300),
    };
  }
}

function heuristicSummary(ruleSignals) {
  const score = ruleRiskScore(ruleSignals);
  return {
    riskScore: score,
    riskBand: riskBandFor(score),
    recommendation: ruleRecommendationFloor(ruleSignals, score),
    suspectedFraud: ruleSignals.some((s) => s.severity === 'critical'),
    keyConcerns: ruleSignals.filter((s) => s.severity !== 'info').map((s) => s.description).slice(0, 12),
    questions: [],
    caseSummary: null,
  };
}

/* ------------------------------------------------ the routing rule engine */

/**
 * The model may recommend a department; the rule engine decides.
 * Returns { department, reason, overridden }.
 */
export function routeClaim({ claim, ruleSignals, synthesis }) {
  const requested = synthesis?.aiDepartment ?? null;
  const band = synthesis?.riskBand ?? null;
  const critical = ruleSignals.filter((s) => s.severity === 'critical');
  const fraud = synthesis?.suspectedFraud === true;

  const siuReasons = [];
  if (ruleSignals.some((s) => s.code === 'DUPLICATE_DOCUMENT')) siuReasons.push('a document was submitted previously on another claim');
  if (ruleSignals.some((s) => s.code === 'FUTURE_INCIDENT_DATE')) siuReasons.push('the incident date is in the future');
  if (fraud) siuReasons.push('the triage agent flagged suspected fabrication');
  if (critical.length > 0 && siuReasons.length === 0) siuReasons.push(`${critical.length} critical rule signal(s)`);

  const base = CLAIM_TYPES.includes(claim.claimType) ? claim.claimType : 'siu';

  if (siuReasons.length > 0) {
    return {
      department: 'siu',
      reason: `Routed to the Special Investigations Unit: ${siuReasons.join('; ')}.`,
      overridden: requested !== null && requested !== 'siu',
    };
  }

  if (requested && requested !== base) {
    return {
      department: requested,
      reason: `The triage agent routed this to ${requested} rather than the claimant's line of business. ${synthesis.aiRationale ?? ''}`.trim(),
      overridden: true,
    };
  }

  return {
    department: base,
    reason:
      synthesis?.aiRationale ||
      `Routed to the claimant's line of business (${base}). Risk band: ${band ?? 'not assessed'}.`,
    overridden: false,
  };
}

/* ------------------------------------------------------- model transport  */

async function callGemini(env, { model, systemInstruction, parts, schema, temperature = 0 }) {
  const url = `${endpointFor(env)}/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    let message = detail.slice(0, 400);
    try {
      message = JSON.parse(detail)?.error?.message ?? message;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Gemini ${response.status}: ${message}`);
  }

  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text)
    .filter(Boolean)
    .join('');

  if (!text) {
    const finish = data?.candidates?.[0]?.finishReason ?? 'unknown';
    throw new Error(`Gemini returned no content (finishReason: ${finish})`);
  }

  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Gemini returned malformed JSON');
  }
}
