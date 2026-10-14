// ClaimSentry - claims intake, automated document authenticity review, and
// routing to the human department head who makes the final decision.
//
// The agent never decides a claim. It produces evidence and a recommendation,
// picks the department that should own the file, and hands it to a person.

import { getPasswordUser, loginPasswordUser, logoutPasswordUser, registerPasswordUser } from './lib/password-auth.js';

import {
  DEFAULT_MODEL,
  analyzeDocument,
  applyRecommendationFloor,
  ruleRecommendationFloor,
  crossCheckSignals,
  crossDocumentSignals,
  preflightSignals,
  riskBandFor,
  routeClaim,
  ruleRiskScore,
  synthesizeClaim,
} from './lib/agent.js';
import { agreesWithAgent, validateDecision } from './lib/decisions.js';
import { ensureSchema } from './lib/schema.js';
import {
  CLAIM_TYPES,
  DEPARTMENTS,
  adminSubs,
  audit,
  departmentName,
  departmentStats,
  findDocumentByHash,
  getClaimById,
  getReviewer,
  listAllClaims,
  listAnalyses,
  listClaimQueue,
  listDecisions,
  listDocuments,
  listReviewers,
  selfEnrollAllowed,
  timeline,
  touchReviewer,
} from './lib/store.js';
import {
  clamp,
  clean,
  claimId as newClaimId,
  errorJson,
  fromCents,
  isIsoDate,
  json,
  nowIso,
  privateJson,
  readJson,
  sha256Hex,
  toBase64,
  toCents,
  trackingSecret,
  uuid,
} from './lib/util.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 6;
const MAX_AMOUNT_CENTS = 1_000_000_00;
const OPEN_STATUSES = ['routed', 'in_review'];

/* --------------------------------------------------------------- plumbing */

function isSameOriginRequest(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(env.APP_ORIGIN).origin; } catch { return false; }
}

const ROUTES = [];
const route = (method, pattern, handler) => ROUTES.push({ method, pattern, handler });

function match(pathname, method) {
  for (const entry of ROUTES) {
    if (entry.method !== method) continue;
    const names = [];
    const regex = new RegExp(
      '^' +
        entry.pattern
          .split('/')
          .map((segment) => {
            if (segment.startsWith(':')) {
              names.push(segment.slice(1));
              return '([^/]+)';
            }
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$',
    );
    const found = regex.exec(pathname);
    if (found) {
      const params = {};
      names.forEach((name, i) => (params[name] = decodeURIComponent(found[i + 1])));
      return { handler: entry.handler, params };
    }
  }
  return null;
}

/** State-changing requests must come from our own origin. */
function requireSameOrigin(request, env) {
  if (!isSameOriginRequest(request, env)) {
    return errorJson('Cross-origin request rejected', 403);
  }
  return null;
}

/** Signed-in reviewer with an active department assignment, or a Response. */
async function requireReviewer(env, request) {
  const user = await getPasswordUser(env.DB, request);
  if (!user) return { response: privateJson({ error: 'Sign in required' }, { status: 401 }) };

  const reviewer = await touchReviewer(env.DB, user);
  if (!reviewer.department || reviewer.status !== 'active') {
    return {
      response: privateJson(
        { error: 'No active department assignment', code: 'ONBOARDING_REQUIRED', reviewer },
        { status: 403 },
      ),
    };
  }
  return { user, reviewer };
}

const canAccessClaim = (env, reviewer, claim) =>
  adminSubs(env).includes(reviewer.sub) || reviewer.department === claim.department;

const adminEmails = (env) => String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = (env, sub) => adminEmails(env).includes(String(sub || '').toLowerCase());

/* ------------------------------------------------------- native auth routes */
route('POST', '/api/auth/register', async (request, env) => {
  const crossOrigin = requireSameOrigin(request, env); if (crossOrigin) return crossOrigin;
  const body = await readJson(request);
  const email = clean(body.email, 254).toLowerCase();
  const name = clean(body.name, 120);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errorJson('Enter a valid email address.', 422);
  if (!name) return errorJson('Name is required.', 422);
  if (password.length < 12 || password.length > 256) return errorJson('Use a password between 12 and 256 characters.', 422);
  const result = await registerPasswordUser(env.DB, email, password, name);
  if (result.error) return errorJson(result.error, 409);
  await audit(env.DB, { claimId: null, actorType: 'system', actorId: email, actorLabel: email, event: 'reviewer.account_registered', detail: { email } });
  return privateJson({ created: true, message: 'Account created. Sign in; an administrator must assign your department before you can view claims.' }, { status: 201 });
});

route('POST', '/api/auth/login', async (request, env) => {
  const crossOrigin = requireSameOrigin(request, env); if (crossOrigin) return crossOrigin;
  const body = await readJson(request);
  const email = clean(body.email, 254).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return errorJson('Email and password are required.', 422);
  const result = await loginPasswordUser(env.DB, request, email, password);
  if (!result) return errorJson('Invalid email or password.', 401);
  return privateJson({ signedIn: true, user: { email: result.email, name: result.name } }, { headers: { 'set-cookie': result.setCookie } });
});

route('POST', '/api/auth/logout', async (request, env) => {
  const crossOrigin = requireSameOrigin(request, env); if (crossOrigin) return crossOrigin;
  return privateJson({ signedIn: false }, { headers: { 'set-cookie': await logoutPasswordUser(env.DB, request) } });
});

/* ------------------------------------------ POST /api/claims   (claimant) */

route('POST', '/api/claims', async (request, env) => {
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorJson('Expected a multipart form submission');
  }

  const claimantName = clean(form.get('claimantName'), 120);
  const claimantEmail = clean(form.get('claimantEmail'), 160).toLowerCase();
  const policyNumber = clean(form.get('policyNumber'), 60).toUpperCase();
  const claimType = clean(form.get('claimType'), 20).toLowerCase();
  const incidentDate = clean(form.get('incidentDate'), 10);
  const description = clean(form.get('description'), 2000);
  const aiConsent = form.get('aiConsent') === 'on' || form.get('aiConsent') === 'true';
  const amountCents = toCents(form.get('amount'));

  const problems = {};
  if (!claimantName) problems.claimantName = 'Required';
  if (!policyNumber) problems.policyNumber = 'Required';
  if (!CLAIM_TYPES.includes(claimType)) problems.claimType = `Must be one of: ${CLAIM_TYPES.join(', ')}`;
  if (incidentDate && !isIsoDate(incidentDate)) problems.incidentDate = 'Use YYYY-MM-DD';
  if (amountCents === null || amountCents <= 0) problems.amount = 'Enter the amount claimed';
  else if (amountCents > MAX_AMOUNT_CENTS) problems.amount = 'Above the online claim limit - contact your broker';
  if (Object.keys(problems).length > 0) {
    return errorJson('Please correct the highlighted fields', 422, { fields: problems });
  }

  const files = form
    .getAll('documents')
    .filter((f) => f && typeof f === 'object' && 'size' in f && f.size > 0);
  if (files.length > MAX_FILES) return errorJson(`At most ${MAX_FILES} documents per claim`, 422);

  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) return errorJson(`"${file.name}" is larger than 8 MB`, 422);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) return errorJson('Total upload size is limited to 16 MB per claim', 422);

  const id = newClaimId();
  const secret = trackingSecret();
  const stamp = nowIso();

  await env.DB.prepare(
    `INSERT INTO claims (id, reference, tracking_secret, claimant_name, claimant_email, policy_number, claim_type,
       incident_date, amount_cents, currency, description, status, ai_consent, ai_consent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'analyzing', ?, ?, ?, ?)`,
  )
    .bind(id, id, secret, claimantName, claimantEmail || null, policyNumber, claimType, incidentDate || null, amountCents, description || null, aiConsent ? 1 : 0, aiConsent ? stamp : null, stamp, stamp)
    .run();

  await audit(env.DB, {
    claimId: id,
    actorType: 'claimant',
    actorLabel: claimantName,
    event: 'claim.submitted',
    detail: { claimType, policyNumber, amount: amountCents / 100, documentCount: files.length },
    isPublic: true,
  });

  const claim = { id, reference: id, claimType, policyNumber, incidentDate: incidentDate || null, amountCents, currency: 'USD', description, aiConsent };

  // --- store and fingerprint every document, then check for re-submissions
  const documents = [];
  for (const file of files) {
    const docId = uuid();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);
    const contentType = file.type || 'application/octet-stream';
    const safeName = (file.name || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const r2Key = `${id}/${docId}-${safeName}`;

    await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType } });
    await env.DB.prepare(
      `INSERT INTO documents (id, claim_id, filename, content_type, size_bytes, r2_key, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(docId, id, safeName, contentType, bytes.byteLength, r2Key, hash, nowIso())
      .run();

    const previous = await findDocumentByHash(env.DB, hash, id);
    documents.push({
      id: docId,
      filename: safeName,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256: hash,
      r2Key,
      bytes,
      duplicateOfClaimId: previous?.claim_id ?? null,
    });

    await audit(env.DB, {
      claimId: id,
      actorType: 'system',
      event: 'document.stored',
      detail: { filename: safeName, sizeBytes: bytes.byteLength, sha256: hash, duplicateOfClaimId: previous?.claim_id ?? null },
    });
    if (previous) {
      await audit(env.DB, {
        claimId: id,
        actorType: 'agent',
        event: 'document.duplicate_detected',
        detail: { filename: safeName, previousClaimId: previous.claim_id, submittedAt: previous.created_at },
      });
    }
  }

  await audit(env.DB, { claimId: id, actorType: 'claimant', actorLabel: claimantName, event: aiConsent ? 'claim.ai_consent_granted' : 'claim.ai_consent_declined', detail: { consent: aiConsent, model: env.GEMINI_MODEL || DEFAULT_MODEL }, isPublic: false });
  const result = await runAgent(env, { claim: { ...claim, aiConsent }, documents });
  // The tracking code is handed back exactly once, to the claimant who filed it.
  return json({ ...publicSubmission(result), trackingSecret: secret }, { status: 201 });
});

/* ------------------------------------------------ the agent run pipeline */

/**
 * Examine every document, then score and route the claim.
 * `mode` is 'initial' (bytes already in memory) or 'reanalyze' (read from R2).
 */
async function runAgent(env, { claim, documents = [], mode = 'initial' }) {
  // No model call receives document bytes or claim text unless the claimant opted in.
  const analysisEnv = claim.aiConsent ? env : { ...env, GEMINI_API_KEY: undefined };
  const duplicateHits = documents
    .filter((d) => d.duplicateOfClaimId)
    .map((d) => ({ claimId: d.duplicateOfClaimId, filename: d.filename, sha256: d.sha256 }));

  const ruleSignals = preflightSignals(claim, { documents, duplicateHits });

  const analyses = [];
  for (const doc of documents) {
    const base64 =
      mode === 'initial' && doc.bytes ? toBase64(doc.bytes) : await readDocumentBase64(env, doc);

    const analysis = await analyzeDocument(analysisEnv, {
      claim,
      bytes: base64,
      contentType: doc.contentType,
      filename: doc.filename,
    });

    const analysisId = uuid();
    await env.DB.prepare(
      `INSERT INTO analyses (id, document_id, claim_id, model, mode, doc_type, legibility, extracted,
         authenticity_score, tamper_signals, positive_signals, consistency_notes, summary, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        analysisId,
        doc.id,
        claim.id,
        analysis.model,
        analysis.mode,
        analysis.docType,
        analysis.legibility,
        JSON.stringify(analysis.extracted ?? {}),
        analysis.authenticityScore,
        JSON.stringify(analysis.tamperSignals ?? []),
        JSON.stringify(analysis.positiveSignals ?? []),
        analysis.consistencyNotes,
        analysis.summary,
        analysis.error,
        nowIso(),
      )
      .run();

    if (analysis.docType) {
      await env.DB.prepare('UPDATE documents SET doc_type = ? WHERE id = ?').bind(analysis.docType, doc.id).run();
    }
    analyses.push({ ...analysis, documentId: doc.id, id: analysisId });
  }

  const allSignals = dedupeSignals([...ruleSignals, ...crossCheckSignals(claim, documents, analyses), ...crossDocumentSignals(documents, analyses)]);

  const synthesis = await synthesizeClaim(analysisEnv, { claim, documents, analyses, ruleSignals: allSignals });

  // Deterministic floor: a confident model cannot lower risk below what the rules found.
  const ruleScore = ruleRiskScore(allSignals);
  const riskScore =
    synthesis.riskScore === null ? ruleScore : clamp(Math.round((ruleScore + synthesis.riskScore) / 2), 0, 100);
  const riskBand = riskBandFor(riskScore);
  const authenticityScore = analyses.length
    ? Math.min(...analyses.map((a) => a.authenticityScore ?? 50))
    : null;

  const suspectedFraud = synthesis.suspectedFraud || allSignals.some((s) => s.severity === 'critical');
  // The model may make a claim look worse than the rules but never better.
  const recommendation = applyRecommendationFloor(
    synthesis.recommendation,
    ruleRecommendationFloor(allSignals, ruleScore),
  );

  const decided = { ...synthesis, riskScore, riskBand, suspectedFraud, recommendation };

  const routing = routeClaim({ claim, ruleSignals: allSignals, synthesis: decided });

  // Re-running the examiner refreshes the assessment; it never reopens a claim
  // that already has a final decision.
  const nextStatus = claim.status === 'decided' ? 'decided' : 'in_review';

  await env.DB.prepare(
    `UPDATE claims SET status = ?, department = ?, routing_reason = ?, risk_score = ?, risk_band = ?,
       rule_risk_score = ?, rule_signals = ?, ai_rationale = ?, authenticity_score = ?, recommendation = ?,
       suspected_fraud = ?, analysis_mode = ?, questions = ?, case_summary = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      nextStatus,
      routing.department,
      routing.reason,
      riskScore,
      riskBand,
      ruleScore,
      JSON.stringify(allSignals),
      synthesis.aiRationale,
      authenticityScore,
      recommendation,
      decided.suspectedFraud ? 1 : 0,
      synthesis.mode,
      JSON.stringify(decided.questions ?? []),
      decided.caseSummary,
      nowIso(),
      claim.id,
    )
    .run();

  await audit(env.DB, {
    claimId: claim.id,
    actorType: 'agent',
    actorLabel: synthesis.model ? `triage-agent (${synthesis.model})` : 'triage-agent (rules only)',
    event: 'agent.analysis_completed',
    detail: {
      mode: synthesis.mode,
      riskScore,
      ruleRiskScore: ruleScore,
      riskBand,
      authenticityScore,
      recommendation,
      suspectedFraud,
      signals: allSignals.map((s) => ({ code: s.code, severity: s.severity, source: s.source, description: s.description })),
    },
  });

  await audit(env.DB, {
    claimId: claim.id,
    actorType: 'agent',
    event: 'agent.routed',
    detail: {
      department: routing.department,
      departmentName: departmentName(routing.department),
      reason: routing.reason,
      overriddenByAgent: routing.overridden,
    },
    isPublic: true,
  });

  return {
    id: claim.id,
    reference: claim.reference,
    status: 'in_review',
    department: routing.department,
    departmentName: departmentName(routing.department),
    riskScore,
    riskBand,
    authenticityScore,
    recommendation,
    suspectedFraud: decided.suspectedFraud,
    analysisMode: synthesis.mode,
    routingReason: routing.reason,
    caseSummary: decided.caseSummary,
    keyConcerns: decided.keyConcerns ?? [],
    questions: decided.questions ?? [],
    signals: allSignals,
    documentCount: documents.length,
  };
}

const publicSubmission = (r) => ({
  id: r.id,
  reference: r.reference,
  status: r.status,
  department: r.department,
  departmentName: r.departmentName,
  riskBand: r.riskBand,
  recommendation: r.recommendation,
  analysisMode: r.analysisMode,
  documentCount: r.documentCount,
  caseSummary: r.caseSummary,
});

async function readDocumentBase64(env, doc) {
  const object = await env.FILES.get(doc.r2Key);
  if (!object) throw new Error(`Stored document ${doc.filename} is missing from storage`);
  return toBase64(new Uint8Array(await object.arrayBuffer()));
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals.filter((s) => {
    const key = `${s.code}|${s.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------ public look-up routes  */

route('GET', '/api/departments', async () =>
  json({
    departments: Object.values(DEPARTMENTS).map((d) => ({ ...d })),
    claimTypes: CLAIM_TYPES,
  }),
);

route('GET', '/api/health', async (_request, env) => {
  await ensureSchema(env.DB);
  return json({
    ok: true,
    aiConfigured: Boolean(env.GEMINI_API_KEY),
    model: env.GEMINI_MODEL || DEFAULT_MODEL,
    selfEnroll: selfEnrollAllowed(env),
    time: nowIso(),
  });
});

/** Claimant status look-up: needs both the reference and the tracking code. */
route('GET', '/api/claims/track', async (request, env) => {
  const url = new URL(request.url);
  const reference = clean(url.searchParams.get('reference'), 40).toUpperCase();
  const secret = clean(url.searchParams.get('secret'), 80);
  if (!reference || !secret) return errorJson('Both the reference and the tracking code are required', 422);

  const claim = await getClaimById(env.DB, reference);
  if (!claim) return errorJson('No claim found for that reference', 404);

  const stored = await env.DB.prepare('SELECT tracking_secret FROM claims WHERE id = ?').bind(claim.id).first();
  if (!stored || stored.tracking_secret !== secret) return errorJson('Invalid tracking code', 403);

  const documents = await listDocuments(env.DB, claim.id);
  return privateJson({
    claim: {
      reference: claim.id,
      status: claim.status,
      claimType: claim.claimType,
      amount: claim.amount,
      currency: claim.currency,
      department: claim.department,
      departmentName: claim.departmentName,
      riskBand: claim.riskBand,
      recommendation: claim.recommendation,
      analysisMode: claim.analysisMode,
      caseSummary: claim.caseSummary,
      questions: claim.questions,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
    },
    documents: documents.map(({ id, filename, docType, sizeBytes, createdAt }) => ({ id, filename, docType, sizeBytes, createdAt })),
    decisions: await listDecisions(env.DB, claim.id),
    timeline: await timeline(env.DB, claim.id, { publicOnly: true }),
  });
});

/* ----------------------------------------------------- reviewer endpoints */

route('GET', '/api/reviewer/session', async (request, env) => {
  const user = await getPasswordUser(env.DB, request);
  if (!user) return privateJson({ signedIn: false, user: null, reviewer: null });

  let reviewer = await getReviewer(env.DB, user.sub);
  if (!reviewer) {
    await touchReviewer(env.DB, { sub: user.sub, name: user.name, email: user.email, picture: user.picture });
    reviewer = await getReviewer(env.DB, user.sub);
  } else {
    await touchReviewer(env.DB, { sub: user.sub, name: user.name, email: user.email, picture: user.picture });
    reviewer = await getReviewer(env.DB, user.sub);
  }

  return privateJson({
    signedIn: true,
    user: { sub: user.sub, name: user.name ?? null, email: user.email ?? null, picture: user.picture ?? null },
    reviewer,
    isAdmin: isAdmin(env, user.sub),
    allowSelfEnroll: selfEnrollAllowed(env),
  });
});

route('POST', '/api/reviewer/onboard', async (request, env) => {
  const crossOrigin = requireSameOrigin(request, env);
  if (crossOrigin) return crossOrigin;

  const user = await getPasswordUser(env.DB, request);
  if (!user) return privateJson({ error: 'Sign in required' }, { status: 401 });

  const reviewer = await touchReviewer(env.DB, { sub: user.sub, name: user.name, email: user.email, picture: user.picture });
  const body = await readJson(request);
  const department = clean(body.department, 20).toLowerCase();

  if (!DEPARTMENTS[department]) return errorJson('Unknown department', 422);
  if (!isAdmin(env, user.email)) {
    return errorJson('Department assignment is restricted to administrators. Ask an administrator to assign your department.', 403);
  }

  await env.DB.prepare('UPDATE reviewers SET department = ?, role = ?, status = ?, last_seen_at = ? WHERE sub = ?')
    .bind(department, clean(body.role, 20) || 'head', 'active', nowIso(), user.sub)
    .run();

  await audit(env.DB, {
    claimId: null,
    actorType: 'human',
    actorId: user.sub,
    actorLabel: user.name || user.email || user.sub,
    event: 'reviewer.assigned',
    detail: { department, departmentName: departmentName(department) },
  });

  return privateJson({ reviewer: await getReviewer(env.DB, reviewer.sub) });
});

route('POST', '/api/reviewer/assign', async (request, env) => {
  const crossOrigin = requireSameOrigin(request, env); if (crossOrigin) return crossOrigin;
  const user = await getPasswordUser(env.DB, request);
  if (!user || !isAdmin(env, user.email)) return privateJson({ error: 'Administrator sign-in required' }, { status: 403 });
  const body = await readJson(request);
  const email = clean(body.email, 254).toLowerCase();
  const department = clean(body.department, 20).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !DEPARTMENTS[department]) return errorJson('Valid reviewer email and department are required.', 422);
  const target = await getReviewer(env.DB, email);
  if (!target) return errorJson('Reviewer account not found. Ask them to register first.', 404);
  await env.DB.prepare("UPDATE reviewers SET department = ?, status = 'active', last_seen_at = ? WHERE sub = ?").bind(department, nowIso(), email).run();
  await audit(env.DB, { claimId: null, actorType: 'human', actorId: user.sub, actorLabel: user.email, event: 'reviewer.assigned', detail: { email, department } });
  return privateJson({ reviewer: await getReviewer(env.DB, email) });
});

route('GET', '/api/reviewer/queue', async (request, env) => {
  const guard = await requireReviewer(env, request);
  if (guard.response) return guard.response;

  const url = new URL(request.url);
  const wantAll = url.searchParams.get('scope') === 'all' && isAdmin(env, guard.reviewer.sub);
  const statuses = url.searchParams.get('status') === 'decided' ? ['decided'] : OPEN_STATUSES;

  const claims = wantAll
    ? await listAllClaims(env.DB, { statuses })
    : await listClaimQueue(env.DB, { department: guard.reviewer.department, statuses });

  return privateJson({
    department: guard.reviewer.department,
    departmentName: guard.reviewer.departmentName,
    scope: wantAll ? 'all' : 'department',
    claims,
    stats: await departmentStats(env.DB),
  });
});

route('GET', '/api/reviewer/roster', async (request, env) => {
  const guard = await requireReviewer(env, request);
  if (guard.response) return guard.response;
  const reviewers = await listReviewers(env.DB);
  return privateJson({
    departments: Object.values(DEPARTMENTS),
    reviewers: reviewers.map((r) => ({
      sub: r.sub,
      name: r.name,
      email: r.email,
      department: r.department,
      departmentName: r.departmentName,
      status: r.status,
      isYou: r.sub === guard.reviewer.sub,
    })),
  });
});

/* ----------------------------------------------------------- claim detail */

route('GET', '/api/claims/:id', async (request, env, { params }) => {
  const guard = await requireReviewer(env, request);
  if (guard.response) return guard.response;

  const claim = await getClaimById(env.DB, params.id.toUpperCase());
  if (!claim) return errorJson('Claim not found', 404);
  if (!canAccessClaim(env, guard.reviewer, claim)) {
    return privateJson({ error: `This claim sits with ${claim.departmentName}, not your department.` }, { status: 403 });
  }

  return privateJson({
    claim,
    documents: await listDocuments(env.DB, claim.id),
    analyses: await listAnalyses(env.DB, claim.id),
    decisions: await listDecisions(env.DB, claim.id),
    timeline: await timeline(env.DB, claim.id),
  });
});

route('GET', '/api/documents/:id/file', async (request, env, { params }) => {
  const guard = await requireReviewer(env, request);
  if (guard.response) return guard.response;

  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(params.id).first();
  if (!doc) return errorJson('Document not found', 404);

  const claim = await getClaimById(env.DB, doc.claim_id);
  if (!claim || !canAccessClaim(env, guard.reviewer, claim)) {
    return privateJson({ error: 'Not your department' }, { status: 403 });
  }

  const object = await env.FILES.get(doc.r2_key);
  if (!object) return errorJson('Stored file is missing', 410);

  return new Response(object.body, {
    headers: {
      'content-type': doc.content_type || 'application/octet-stream',
      'content-disposition': `inline; filename="${String(doc.filename).replace(/"/g, '')}"`,
      'cache-control': 'private, no-store',
    },
  });
});

route('POST', '/api/claims/:id/reanalyze', async (request, env, { params }) => {
  const crossOrigin = requireSameOrigin(request, env);
  if (crossOrigin) return crossOrigin;

  const guard = await requireReviewer(env, request);
  if (guard.response) return guard.response;

  const claim = await getClaimById(env.DB, params.id.toUpperCase());
  if (!claim) return errorJson('Claim not found', 404);
  if (!canAccessClaim(env, guard.reviewer, claim)) return privateJson({ error: 'Not your department' }, { status: 403 });

  const rows = await env.DB.prepare('SELECT * FROM documents WHERE claim_id = ?').bind(claim.id).all();
  const documents = (rows.results ?? []).map((row) => ({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    r2Key: row.r2_key,
    sha256: row.sha256,
    duplicateOfClaimId: null,
    bytes: null,
  }));

  await audit(env.DB, {
    claimId: claim.id,
    actorType: 'human',
    actorId: guard.reviewer.sub,
    actorLabel: guard.reviewer.name || guard.reviewer.email || guard.reviewer.sub,
    event: 'human.requested_reanalysis',
    detail: { documents: documents.length },
  });

  const result = await runAgent(env, { claim, documents, mode: 'reanalyze' });
  return privateJson({ result: publicSubmission(result) });
});

/* ----------------------------------------------- the human final decision */

route('POST', '/api/claims/:id/decision', async (request, env, { params }) => {
  const crossOrigin = requireSameOrigin(request, env);
  if (crossOrigin) return crossOrigin;

  const guard = await requireReviewer(env, request);
  if (guard.response) return guard.response;

  const claim = await getClaimById(env.DB, params.id.toUpperCase());
  if (!claim) return errorJson('Claim not found', 404);
  if (!canAccessClaim(env, guard.reviewer, claim)) {
    return privateJson({ error: `Only ${claim.departmentName} can decide this claim.` }, { status: 403 });
  }
  if (claim.status === 'decided') return errorJson('This claim already has a final decision', 409);

  const body = await readJson(request);
  const action = clean(body.action, 20).toLowerCase();
  const notes = clean(body.notes, 4000);
  const amountApprovedCents =
    body.amountApproved === undefined || body.amountApproved === '' ? null : toCents(body.amountApproved);

  const checked = validateDecision({
    action,
    notes,
    amountApprovedCents,
    claimedCents: claim.amountCents,
  });
  if (checked.error) return errorJson(checked.error, 422);
  const approvedCents = checked.amountApprovedCents;

  const decisionId = uuid();
  const stamp = nowIso();
  const reviewerLabel = guard.reviewer.name || guard.reviewer.email || guard.reviewer.sub;

  await env.DB.prepare(
    `INSERT INTO decisions (id, claim_id, reviewer_sub, reviewer_name, reviewer_email, department, action,
       amount_approved_cents, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      decisionId,
      claim.id,
      guard.reviewer.sub,
      guard.reviewer.name,
      guard.reviewer.email,
      guard.reviewer.department,
      action,
      checked.amountApprovedCents,
      notes || null,
      stamp,
    )
    .run();

  const nextStatus = action === 'escalate' ? 'in_review' : 'decided';
  const nextDepartment = action === 'escalate' ? 'siu' : claim.department;

  await env.DB.prepare('UPDATE claims SET status = ?, department = ?, routing_reason = ?, updated_at = ? WHERE id = ?')
    .bind(
      nextStatus,
      nextDepartment,
      action === 'escalate'
        ? `${reviewerLabel} escalated this file from ${departmentName(guard.reviewer.department)} to the Special Investigations Unit.`
        : claim.routingReason,
      stamp,
      claim.id,
    )
    .run();

  await audit(env.DB, {
    claimId: claim.id,
    actorType: 'human',
    actorId: guard.reviewer.sub,
    actorLabel: reviewerLabel,
    event: `human.${action}`,
    detail: {
      department: guard.reviewer.department,
      departmentName: guard.reviewer.departmentName,
      amountApproved: approvedCents === null ? null : approvedCents / 100,
      notes: notes || null,
      agentRecommendation: claim.recommendation,
      agentRiskBand: claim.riskBand,
      agreedWithAgent: agreesWithAgent(action, claim.recommendation),
      escalatedTo: action === 'escalate' ? 'siu' : null,
    },
    isPublic: true,
  });

  return privateJson({
    decision: {
      id: decisionId,
      action,
      reviewerName: guard.reviewer.name,
      department: guard.reviewer.department,
      departmentName: guard.reviewer.departmentName,
      amountApproved: approvedCents === null ? null : fromCents(approvedCents),
      notes: notes || null,
      createdAt: stamp,
    },
    claim: await getClaimById(env.DB, claim.id),
  });
});


/* ------------------------------------------------------------- dispatcher */

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    try {
      await ensureSchema(env.DB);
      const found = match(pathname, request.method);
      if (!found) return errorJson(`No API route for ${request.method} ${pathname}`, 404);
      return await found.handler(request, env, { params: found.params, url });
    } catch (err) {
      console.error('api_error', pathname, err?.stack || String(err));
      return errorJson('Something went wrong handling this request.', 500, {
        detail: String(err?.message || err).slice(0, 300),
      });
    }
  }

  return env.ASSETS.fetch(request);
}

export default { fetch: handle };
