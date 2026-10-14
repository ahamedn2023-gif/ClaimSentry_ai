# ClaimSentry

An AI-assisted insurance claims triage web application. A claimant files a claim and uploads
their paperwork; an agent examines each document for signs of alteration, scores the risk, and
routes the file to the head of the department that should own it. **The agent never approves or
rejects anything** — the department head reviews the evidence and makes the decision of record.

```
claimant ──▶ intake + SHA-256 fingerprint + R2 storage
                 │
                 ▼
            agent  stage 1  deterministic rule engine  (always runs)
                   stage 2  multimodal document examiner  (per document)
                   stage 3  risk + recommendation synthesis
                 │
                 ▼
            routing rule engine ──▶ Auto │ Health │ Property │ Life │ Travel │ SIU
                 │
                 ▼
            department head (signed in) ──▶ approve │ reject │ request info │ escalate
                 └── every step written to an append-only audit trail
```

## Stack

| Piece | Used for |
| --- | --- |
| Cloudflare Worker (`worker.js`) | routing, API, agent pipeline |
| Static assets (`public/`) | claimant form and department console, no build step |
| D1 (`env.DB`) | claims, documents, analyses, decisions, audit log, reviewers, password hashes and sessions |
| R2 (`env.FILES`) | the uploaded documents themselves |
| Native auth (`lib/password-auth.js`) | PBKDF2-SHA-256 password hashing, opaque server-side sessions, HttpOnly cookies |
| Gemini `generateContent` | the document examiner (`GEMINI_API_KEY`) |

## The agent

**Stage 1 — deterministic rules.** Always runs, never costs anything, and every result is citable.
Duplicate submissions (byte-identical files already filed on another claim), future incident dates,
reporting lag, exact round amounts, high values, missing documents, absent contact details.

**Stage 2 — the document examiner.** Each file is sent to a multimodal model with the claim's declared
data and a forensic-examiner prompt, and returns a schema-constrained JSON assessment: document type,
legibility, extracted fields, an authenticity score, tamper signals with the concrete observation as
evidence, positive signals, consistency notes. It looks for altered regions, inconsistent fonts,
cloned text blocks, pasted stamps, totals that do not sum, dates outside the policy window,
recompression artifacts, template leftovers, and contradictions with the claim.

**Cross-document consistency.** After per-file examination, the rule engine compares extracted policy numbers and insured/patient names across the claim bundle, and flags repeated issuer/reference numbers and relevant timeline conflicts. Findings cite the filenames and observed values so reviewers can verify the mismatch. These checks are triage signals: documents can legitimately differ, so they are not proof of fraud.

**Stage 3 — synthesis.** The model weighs the whole file and returns a risk score, band, a
recommendation, a suspected-fraud flag, key concerns, questions for the claimant and a short summary.

### Two floors that the model cannot cross

A model that returns an over-confident "looks fine" cannot clear a file the rules have flagged:

- **Risk floor** — the stored risk score is the average of the rule score and the model score, so a
  model score of 18 against a rule score of 100 still lands at 59.
- **Recommendation floor** — a claim that tripped a *critical* rule is never merely "approve". The
  final recommendation is the more severe of the model's answer and the rule floor.

Both are covered by tests in `test/agent.test.mjs`.

### Routing

`routeClaim` decides the department, not the model. The claimant's line of business is the default;
the Special Investigations Unit takes over when a document was already filed on another claim, when
the incident date is in the future, when the agent flags suspected fabrication, or when a critical
rule fired. The model may argue for a different desk, and when it wins the routing reason records
that it overrode the default. Every rule that fired is stored on the claim and shown to the reviewer.

## Human decision

The department head can approve (with a payout amount), reject, request more information, or escalate
to investigations. Rejections and escalations require a written justification of at least ten
characters. An approval cannot exceed twice the claimed amount. A claim that already has a final
decision returns `409`. Each decision records whether the reviewer agreed with or overrode the agent,
so override rates can be reviewed later.

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/claims` | anyone | File a claim (multipart, up to 6 documents / 8 MB each / 16 MB total) |
| `GET` | `/api/claims/track?reference=&secret=` | claimant | Status look-up; needs the tracking code issued at submission |
| `GET` | `/api/departments` | anyone | Department and claim-type catalogue |
| `GET` | `/api/health` | anyone | Service status and whether the document examiner is configured |
| `GET` | `/api/reviewer/session` | anyone | Current identity and reviewer record |
| `POST` | `/api/auth/register` | anyone | Create a pending reviewer account |
| `POST` | `/api/auth/login` | anyone | Start a secure server-side session |
| `POST` | `/api/auth/logout` | signed in | Revoke the current session |
| `POST` | `/api/reviewer/onboard` | administrator | Assign the administrator's own department |
| `POST` | `/api/reviewer/assign` | administrator | Assign a registered reviewer to a department
| `GET` | `/api/reviewer/queue` | reviewer | Claims routed to your department |
| `GET` | `/api/reviewer/roster` | reviewer | Who heads which department |
| `GET` | `/api/claims/:id` | owning reviewer | Full case file: claim, documents, analyses, decisions, audit trail |
| `GET` | `/api/documents/:id/file` | owning reviewer | Stream the stored document from R2 |
| `POST` | `/api/claims/:id/reanalyze` | owning reviewer | Re-run the document examiner on the stored files |
| `POST` | `/api/claims/:id/decision` | owning reviewer | The final decision |

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_ORIGIN` | yes | Canonical origin. Used for session, CSRF and callback checks. Never derived from the request. |
| `GEMINI_API_KEY` | no | **Secret.** Without it the agent runs rules-only; everything else still works. |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.5-flash-lite`. |
| `GEMINI_ENDPOINT` | no | Override the model base URL to route through a gateway or a test double. |
| `ADMIN_EMAILS` | yes for admin workflows | Comma-separated email addresses allowed to assign departments and access cross-department queues. Set this before creating the first admin account. |

Set the model key as a platform secret. Never commit it, never paste it into chat, and keep it out of
`public/`.

> **Data protection:** most LLM providers, including Google's free tier, may use submitted content to
> improve their products. Real claim documents contain medical and financial data. Use a paid tier with
> a data-processing agreement before sending anything real through the examiner.

## Local development

```sh
npm install                 # Wrangler only; no external auth provider
npm test                    # rule engine, routing floors, decision validation
npm run dev                 # wrangler dev on :8787 with local D1 + R2
```

The D1 schema is created/migrated from `lib/schema.js` on the first API request, including auth tables and AI-consent columns, so a fresh database needs no out-of-band SQL step. Local state lives in `.wrangler/` and is disposable.

`npm run build` produces a bundled Worker in `dist/` (`wrangler deploy --dry-run --outdir dist`) for
platforms that take prebuilt output; `deploy.manifest.json` is the manifest used for that.

To exercise the document examiner without a live key, point `GEMINI_ENDPOINT` at a test double that
speaks the `generateContent` response shape and set any value for `GEMINI_API_KEY`.

## Deploying

```sh
npm run build               # → dist/index.js
npx wrangler deploy         # or deploy dist/index.js through the Sites manifest
```

Set `APP_ORIGIN` to the exact deployed HTTPS origin and `ADMIN_EMAILS` to the administrator email(s). Deploy once before adding secrets, then set `GEMINI_API_KEY`. Gemini is only used for a claim when the claimant explicitly consents; otherwise the agent remains rules-only.

## First administrator setup

1. Set `ADMIN_EMAILS` to the exact email address that will administer the deployment.
2. Deploy, then register an account with that email at `/reviewer.html` and sign in.
3. The administrator can assign their own department in the console. Other reviewers register normally but stay pending until an administrator uses the **Assign a reviewer** panel in the console.

The app does not yet implement email verification, password reset, or login rate limiting. Treat this as a safer project/demo baseline, not production-ready identity infrastructure. Do not use real insurance or medical records until a security review and operational controls are in place.

## Security model

- Every reviewer endpoint resolves a server-side session from an HttpOnly cookie and scopes data to the authenticated email and assigned department. Hiding UI is never the control.
- Passwords are salted and hashed with PBKDF2-SHA-256 (310,000 iterations); raw passwords are never stored. Session tokens are random, only their SHA-256 hashes are stored in D1, and cookies are HttpOnly/SameSite=Strict. Use HTTPS in production.
- New accounts remain pending. Only emails in `ADMIN_EMAILS` can assign departments; ordinary registration never grants claim access. Set a long unique password and configure `ADMIN_EMAILS` before creating the admin account.
- AI consent is explicit and unchecked by default. Without consent, the server removes `GEMINI_API_KEY` from the agent context so neither uploaded bytes nor claim text are sent to Gemini; rules-only processing still runs. Consent and its timestamp are stored in D1 and audit-logged.
- A reviewer cannot read, download or decide a claim belonging to another department — that is a `403`,
  not a redacted page. `ADMIN_EMAILS` is the only exception.
- State-changing requests (`onboard`, `reanalyze`, `decision`) pass `isSameOriginRequest`.
- Claim tracking needs both the reference and a random tracking code issued once at submission.
- Documents stream from R2 only to the owning department, with `Cache-Control: private, no-store`.
- Sessions, tokens and the model key never reach the browser, `localStorage` or the audit trail.

### Before handling real claims

1. Configure `ADMIN_EMAILS` and deploy over HTTPS. Add rate limiting, email verification, password reset and account recovery before production use.
2. Rotate `GEMINI_API_KEY` into a paid tier with a data-processing agreement; consent does not override provider retention terms.
3. Add rate limiting on `POST /api/claims`, and a retention policy for R2 objects and D1 rows.
4. Capture the model's `gemini-3.5-flash-lite` version rather than the floating alias, so a stored
   assessment can be reproduced.
5. Treat a duplicate-document hit as a strong signal, not proof: shared boilerplate invoices exist.

## Demo data

`scripts/seed-demo.mjs [origin]` files a handful of claims so the queues are not empty. It generates
unique document bytes on every run (a re-run is never mistaken for a duplicate submission) and prints
the reference, department, risk band and agent recommendation for each. Requires no credentials —
claim intake is public by design.

The preview database currently holds the claims created while this was being built, including repeated
seeding runs. Two consequences worth knowing:

- Duplicate detection is working as designed, so most of the repeated files ended up in the Special
  Investigations Unit queue. That queue looks busy; the Auto, Health, Property and Travel queues each
  hold their own examples.
- Two of the earliest rows store a recommendation of `approve` alongside a critical fraud flag. They
  were written before the recommendation floor existed. Press **Re-run the document examiner** on those
  two claims and the stored assessment is refreshed.

Claim rows cannot be deleted through the API by design. There is no anonymous delete endpoint, and
remote D1 has no ad-hoc SQL access from this workspace, so a clean database means publishing
**production**, which has its own empty D1.

## Known limitations

- Rules-only mode (no `GEMINI_API_KEY`, or no claimant consent) does not inspect document contents, so it cannot produce AI authenticity findings or extracted-field cross-document comparisons. It still runs metadata/hash and claim-level deterministic checks.
- Authenticity scores are model judgements, not forensic proof. They are evidence for a human, which is
  the whole design.
- Model responses are validated and normalised, but a provider outage degrades to rules-only rather
  than failing the submission.
