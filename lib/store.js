// All D1 access lives here so the route handlers stay readable.

import { nowIso, parseJson, fromCents, truthy } from './util.js';

export const DEPARTMENTS = {
  auto: { code: 'auto', name: 'Auto Claims', head: 'Head of Auto Claims' },
  health: { code: 'health', name: 'Health Claims', head: 'Head of Health Claims' },
  property: { code: 'property', name: 'Property Claims', head: 'Head of Property Claims' },
  life: { code: 'life', name: 'Life & Disability Claims', head: 'Head of Life Claims' },
  travel: { code: 'travel', name: 'Travel Claims', head: 'Head of Travel Claims' },
  siu: { code: 'siu', name: 'Special Investigations Unit', head: 'SIU Lead' },
};

export const CLAIM_TYPES = ['auto', 'health', 'property', 'life', 'travel'];

export const departmentName = (code) => DEPARTMENTS[code]?.name ?? code ?? 'Unrouted';

export const adminSubs = (env) => String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const selfEnrollAllowed = () => false;

/* ------------------------------------------------------------------ audit */

export async function audit(db, { claimId, actorType, actorId = null, actorLabel = null, event, detail = {}, isPublic = false }) {
  await db
    .prepare(
      `INSERT INTO audit_log (claim_id, actor_type, actor_id, actor_label, event, detail, public, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      claimId,
      actorType,
      actorId,
      actorLabel,
      event,
      JSON.stringify(detail),
      isPublic ? 1 : 0,
      nowIso(),
    )
    .run();
}

export async function timeline(db, claimId, { publicOnly = false } = {}) {
  const rows = await db
    .prepare(
      `SELECT id, actor_type, actor_label, event, detail, public, created_at
       FROM audit_log WHERE claim_id = ? ${publicOnly ? 'AND public = 1' : ''} ORDER BY id ASC`,
    )
    .bind(claimId)
    .all();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    actorType: row.actor_type,
    actorLabel: row.actor_label,
    event: row.event,
    detail: parseJson(row.detail, {}),
    isPublic: row.public === 1,
    createdAt: row.created_at,
  }));
}

/* -------------------------------------------------------------- reviewers */

export async function getReviewer(db, sub) {
  const row = await db.prepare('SELECT * FROM reviewers WHERE sub = ?').bind(sub).first();
  return row ? mapReviewer(row) : null;
}

/** Records the signed-in identity and refreshes the "last seen" stamp. */
export async function touchReviewer(db, user) {
  const existing = await getReviewer(db, user.sub);
  const stamp = nowIso();
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO reviewers (sub, name, email, picture, department, role, status, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, NULL, 'head', 'pending', ?, ?)`,
      )
      .bind(user.sub, user.name ?? null, user.email ?? null, user.picture ?? null, stamp, stamp)
      .run();
    return getReviewer(db, user.sub);
  }
  await db
    .prepare(
      `UPDATE reviewers SET name = ?, email = ?, picture = ?, last_seen_at = ? WHERE sub = ?`,
    )
    .bind(
      user.name ?? existing.name,
      user.email ?? existing.email,
      user.picture ?? existing.picture,
      stamp,
      user.sub,
    )
    .run();
  return getReviewer(db, user.sub);
}

function mapReviewer(row) {
  return {
    sub: row.sub,
    name: row.name,
    email: row.email,
    picture: row.picture,
    department: row.department,
    departmentName: row.department ? departmentName(row.department) : null,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function listReviewers(db) {
  const rows = await db
    .prepare('SELECT * FROM reviewers ORDER BY created_at ASC LIMIT 100')
    .all();
  return (rows.results ?? []).map(mapReviewer);
}

/* ----------------------------------------------------------------- claims */

export function mapClaim(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const claim = {
    id: row.id,
    reference: row.reference,
    claimantName: row.claimant_name,
    claimantEmail: row.claimant_email,
    policyNumber: row.policy_number,
    claimType: row.claim_type,
    incidentDate: row.incident_date,
    amount: fromCents(row.amount_cents),
    amountCents: row.amount_cents,
    currency: row.currency,
    description: row.description,
    status: row.status,
    department: row.department,
    departmentName: row.department ? departmentName(row.department) : null,
    routingReason: row.routing_reason,
    riskScore: row.risk_score,
    riskBand: row.risk_band,
    ruleRiskScore: row.rule_risk_score,
    ruleSignals: parseJson(row.rule_signals, []),
    aiRationale: row.ai_rationale,
    authenticityScore: row.authenticity_score,
    recommendation: row.recommendation,
    suspectedFraud: row.suspected_fraud === 1,
    analysisMode: row.analysis_mode,
    questions: parseJson(row.questions, []),
    caseSummary: row.case_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    aiConsent: row.ai_consent === 1,
    aiConsentAt: row.ai_consent_at || null,
  };
  if (includeSecret) claim.trackingSecret = row.tracking_secret;
  return claim;
}

export const getClaimById = async (db, id) =>
  mapClaim(await db.prepare('SELECT * FROM claims WHERE id = ?').bind(id).first());

export const getClaimByReference = async (db, reference) =>
  mapClaim(await db.prepare('SELECT * FROM claims WHERE reference = ?').bind(reference).first());

export async function listClaimQueue(db, { department, statuses }) {
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT * FROM claims WHERE department = ? AND status IN (${placeholders})
       ORDER BY risk_score DESC, created_at ASC LIMIT 200`,
    )
    .bind(department, ...statuses)
    .all();
  return (rows.results ?? []).map((row) => mapClaim(row));
}

export async function listAllClaims(db, { statuses }) {
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT * FROM claims WHERE status IN (${placeholders})
       ORDER BY risk_score DESC, created_at ASC LIMIT 200`,
    )
    .bind(...statuses)
    .all();
  return (rows.results ?? []).map((row) => mapClaim(row));
}

export async function listDocuments(db, claimId) {
  const rows = await db
    .prepare('SELECT * FROM documents WHERE claim_id = ? ORDER BY created_at ASC')
    .bind(claimId)
    .all();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    claimId: row.claim_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    docType: row.doc_type,
    createdAt: row.created_at,
    fileUrl: `/api/documents/${row.id}/file`,
  }));
}

export async function listAnalyses(db, claimId) {
  const rows = await db
    .prepare('SELECT * FROM analyses WHERE claim_id = ? ORDER BY created_at ASC')
    .bind(claimId)
    .all();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    documentId: row.document_id,
    model: row.model,
    mode: row.mode,
    docType: row.doc_type,
    legibility: row.legibility,
    extracted: parseJson(row.extracted, {}),
    authenticityScore: row.authenticity_score,
    tamperSignals: parseJson(row.tamper_signals, []),
    positiveSignals: parseJson(row.positive_signals, []),
    consistencyNotes: row.consistency_notes,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export async function listDecisions(db, claimId) {
  const rows = await db
    .prepare('SELECT * FROM decisions WHERE claim_id = ? ORDER BY created_at ASC')
    .bind(claimId)
    .all();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    claimId: row.claim_id,
    reviewerSub: row.reviewer_sub,
    reviewerName: row.reviewer_name,
    reviewerEmail: row.reviewer_email,
    department: row.department,
    departmentName: departmentName(row.department),
    action: row.action,
    amountApproved: fromCents(row.amount_approved_cents),
    notes: row.notes,
    createdAt: row.created_at,
  }));
}

/** Cross-claim duplicate detection on the stored document hash. */
export async function findDocumentByHash(db, sha256, excludeClaimId) {
  return db
    .prepare('SELECT id, claim_id, filename, created_at FROM documents WHERE sha256 = ? AND claim_id != ? LIMIT 1')
    .bind(sha256, excludeClaimId)
    .first();
}

export async function departmentStats(db) {
  const rows = await db
    .prepare(
      `SELECT department, status, COUNT(*) AS count, AVG(risk_score) AS avg_risk
       FROM claims GROUP BY department, status`,
    )
    .all();
  const byDepartment = {};
  for (const row of rows.results ?? []) {
    const key = row.department ?? 'unrouted';
    byDepartment[key] ??= { department: key, departmentName: departmentName(row.department), total: 0, byStatus: {} };
    byDepartment[key].total += row.count;
    byDepartment[key].byStatus[row.status] = row.count;
  }
  return Object.values(byDepartment);
}
