// D1 schema. Created idempotently from server-side code so a freshly
// provisioned database becomes usable without an out-of-band SQL step.

export const DDL = [
  `CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    tracking_secret TEXT NOT NULL,
    claimant_name TEXT NOT NULL,
    claimant_email TEXT,
    claimant_sub TEXT,
    policy_number TEXT NOT NULL,
    claim_type TEXT NOT NULL,
    incident_date TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    description TEXT,
    status TEXT NOT NULL,
    department TEXT,
    routing_reason TEXT,
    risk_score INTEGER,
    risk_band TEXT,
    rule_risk_score INTEGER,
    rule_signals TEXT,
    ai_rationale TEXT,
    authenticity_score INTEGER,
    recommendation TEXT,
    suspected_fraud INTEGER NOT NULL DEFAULT 0,
    analysis_mode TEXT,
    questions TEXT,
    case_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_claims_department ON claims (department, status)`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    doc_type TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_claim ON documents (claim_id)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents (sha256)`,
  `CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    model TEXT,
    mode TEXT NOT NULL,
    doc_type TEXT,
    legibility TEXT,
    extracted TEXT,
    authenticity_score INTEGER,
    tamper_signals TEXT,
    positive_signals TEXT,
    consistency_notes TEXT,
    summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_analyses_claim ON analyses (claim_id)`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    reviewer_sub TEXT NOT NULL,
    reviewer_name TEXT,
    reviewer_email TEXT,
    department TEXT NOT NULL,
    action TEXT NOT NULL,
    amount_approved_cents INTEGER,
    notes TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_claim ON decisions (claim_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_label TEXT,
    event TEXT NOT NULL,
    detail TEXT,
    public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_claim ON audit_log (claim_id, id)`,
  `CREATE TABLE IF NOT EXISTS auth_users (email TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions (expires_at)`,
  `ALTER TABLE claims ADD COLUMN ai_consent INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE claims ADD COLUMN ai_consent_at TEXT`,
  `CREATE TABLE IF NOT EXISTS reviewers (
    sub TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    picture TEXT,
    department TEXT,
    role TEXT NOT NULL DEFAULT 'head',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
];

let ready = null;

/** Runs once per isolate; subsequent calls reuse the resolved promise. */
export function ensureSchema(db) {
  ready ??= (async () => {
    for (const sql of DDL) {
      try { await db.prepare(sql).run(); } catch (err) {
        // The two additive claim columns already exist on databases migrated previously.
        if (!/^ALTER TABLE claims ADD COLUMN ai_consent(_at)? /.test(sql) || !/duplicate column name/i.test(String(err?.message || err))) throw err;
      }
    }
    return true;
  })().catch((err) => {
    ready = null; // allow a retry on the next request
    throw err;
  });
  return ready;
}
