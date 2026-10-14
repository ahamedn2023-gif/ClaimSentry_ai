// The department head console: sign in, claim a department, work the queue,
// read the agent's evidence, and issue the final decision.

import { api } from './api.js';
import { $, ago, badge, bytes, clear, el, money, notice, riskVariant, spinner, when } from './dom.js';

const main = $('#main');
const userChip = $('#user-chip');

const state = { session: null, view: 'open', queue: [], selected: null, detail: null, departments: [] };

const ACTION_LABEL = {
  approve: 'Approve',
  reject: 'Reject',
  request_info: 'Request more information',
  escalate: 'Escalate to investigations',
};

const label = (value) =>
  String(value ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const render = (nodes) => clear(main).append(...[].concat(nodes).filter(Boolean));

function showChip() {
  const reviewer = state.session?.reviewer;
  const user = state.session?.user;
  clear(userChip);
  if (!user) return;
  if (user.picture) userChip.append(el('img', { src: user.picture, alt: '' }));
  userChip.append(el('span', { text: reviewer?.name || user.name || user.email || 'Signed in' }));
  userChip.append(
    el('button', { class: 'ghost small', text: 'Sign out', onclick: async () => { await api.post('/api/auth/logout', {}); location.reload(); } }),
  );
}

/* ------------------------------------------------------------------- gates */

function renderSignIn() {
  const email = el('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com' });
  const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'At least 12 characters' });
  const name = el('input', { type: 'text', autocomplete: 'name', placeholder: 'Full name' });
  const message = el('div', { id: 'auth-message' });
  const register = el('button', { class: 'ghost', text: 'Create account instead', onclick: () => {
    name.closest('.field')?.classList.remove('hidden');
    password.autocomplete = 'new-password';
    register.classList.add('hidden');
    create.classList.remove('hidden');
    message.textContent = 'New accounts remain pending until an administrator assigns a department.';
  }});
  const create = el('button', { class: 'primary hidden', text: 'Create account', onclick: async () => {
    message.textContent = '';
    try {
      await api.post('/api/auth/register', { name: name.value, email: email.value, password: password.value });
      message.replaceChildren(notice('Account created. Sign in; an administrator must assign your department.', 'ok'));
      name.closest('.field')?.classList.add('hidden'); create.classList.add('hidden'); register.classList.remove('hidden');
      password.autocomplete = 'current-password';
    } catch (err) { message.replaceChildren(notice(err.message, 'error')); }
  }});
  const signIn = el('button', { class: 'primary', text: 'Sign in', onclick: async () => {
    message.textContent = '';
    try { await api.post('/api/auth/login', { email: email.value, password: password.value }); await start(); }
    catch (err) { message.replaceChildren(notice(err.message, 'error')); }
  }});
  render([
    el('h1', { text: 'Department console' }),
    el('p', { class: 'lede', text: 'Sign in to review claims routed to your department. Claim access is checked on the server for every request.' }),
    el('div', { class: 'card' }, [
      el('p', { class: 'small muted', text: 'Accounts use native email/password authentication. Use a unique password; registration does not grant access to claim files.' }),
      el('div', { class: 'field hidden' }, [el('label', { text: 'Full name' }), name]),
      el('div', { class: 'field' }, [el('label', { text: 'Email' }), email]),
      el('div', { class: 'field' }, [el('label', { text: 'Password' }), password]),
      message,
      el('div', { class: 'btn row' }, [signIn, register, create]),
    ]),
  ]);
}

function renderOnboard() {
  if (!state.session?.isAdmin) {
    return render([el('h1', { text: 'Account pending approval' }), el('p', { class: 'lede', text: 'Your account is signed in, but it has no active department assignment. Ask the deployment administrator to assign your registered email to a department.' })]);
  }
  const select = el('select', {}, (state.departments || []).map((d) => el('option', { value: d.code, text: `${d.name} — ${d.head}` })));
  select.value = 'health';

  render([
    el('h1', { text: 'Which department do you head?' }),
    el('p', { class: 'lede', text: 'Your queue is scoped to the department you choose. Sign in with a different account and pick a different department to see that the queues stay separate.' }),
    el('div', { class: 'notice warn', text: 'Only an administrator whose email is listed in ADMIN_EMAILS may assign a department. Other accounts stay pending until approved.' }),
    el('div', { class: 'card' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Department' }), select]),
      el('div', { id: 'onboard-error' }),
      el('button', {
        class: 'primary',
        text: 'Start working this queue',
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            await api.post('/api/reviewer/onboard', { department: select.value });
            await loadSession();
            await showConsole();
          } catch (err) {
            $('#onboard-error').replaceChildren(notice(err.message, 'error'));
            event.target.disabled = false;
          }
        },
      }),
    ]),
  ]);
}

/* ----------------------------------------------------------------- console */

async function showConsole() {
  render([spinner('Loading your queue…')]);
  try {
    const query = state.view === 'decided' ? '?status=decided' : '';
    const data = await api.get(`/api/reviewer/queue${query}`);
    state.queue = data.claims || [];
    state.openStats = data;
    renderConsole();
  } catch (err) {
    if (err.body?.code === 'ONBOARDING_REQUIRED') return renderOnboard();
    render([notice(err.message, 'error')]);
  }
}

function renderConsole() {
  const reviewer = state.session.reviewer;
  const stats = state.openStats?.stats || [];
  const mine = stats.find((s) => s.department === reviewer.department);

  render([
    el('div', { class: 'pillrow', style: { marginTop: '20px', justifyContent: 'space-between' } }, [
      el('div', {}, [
        el('div', { class: 'eyebrow', text: 'Department console' }),
        el('h1', { style: { margin: '4px 0 0' }, text: reviewer.departmentName }),
        el('div', { class: 'small muted', text: `Signed in as ${reviewer.name || reviewer.email || reviewer.sub}${state.session.isAdmin ? ' · cross-department admin' : ''}` }),
      ]),
      el('div', { class: 'pillrow' }, [
        badge(`${state.queue.filter((c) => c.status !== 'decided').length} in queue`),
        badge(`${mine?.byStatus?.decided ?? 0} decided by this desk`, 'neutral'),
      ]),
    ]),

    el('div', { class: 'tabs' }, [
      tabButton('open', 'Open queue'),
      tabButton('decided', 'Decided'),
    ]),

    el('div', { class: 'split' }, [
      el('div', { class: 'card queue' }, [
        el('h2', { text: state.view === 'decided' ? 'Decided claims' : 'Waiting on a decision' }),
        state.queue.length === 0
          ? el('p', { class: 'small muted', text: state.view === 'decided' ? 'Nothing has been decided yet.' : 'Your queue is clear.' })
          : el('table', {}, [
              el('thead', {}, [el('tr', {}, ['Reference', 'Claimant', 'Amount', 'Risk'].map((h) => el('th', { text: h })))]),
              el('tbody', {}, state.queue.map(queueRow)),
            ]),
      ]),
      el('div', { id: 'detail' }, [
        el('div', { class: 'card' }, [
          el('p', { class: 'small muted', text: 'Select a claim from the queue to review the agent’s evidence and make the decision.' }),
        ]),
      ]),
    ]),

    state.session.isAdmin ? renderAdminAssign() : null,
    el('div', { class: 'card' }, [
      el('h2', { text: 'Queue across the company' }),
      el('table', {}, [
        el('thead', {}, [el('tr', {}, ['Department', 'Open', 'Decided'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, stats.map((row) =>
          el('tr', {}, [
            el('td', { text: row.departmentName }),
            el('td', { text: String((row.byStatus['in_review'] ?? 0) + (row.byStatus.routed ?? 0)) }),
            el('td', { text: String(row.byStatus.decided ?? 0) }),
          ]),
        )),
      ]),
      el('p', { class: 'small muted', style: { marginBottom: '0' }, text: 'Counts only. Claim contents are never visible outside the owning department.' }),
    ]),
  ]);

  if (state.selected) openClaim(state.selected);
}

function renderAdminAssign() {
  const email = el('input', { type: 'email', placeholder: 'reviewer@example.com', autocomplete: 'off' });
  const department = el('select', {}, [
    ['auto', 'Auto Claims'], ['health', 'Health Claims'], ['property', 'Property Claims'],
    ['life', 'Life & Disability Claims'], ['travel', 'Travel Claims'], ['siu', 'Special Investigations Unit'],
  ].map(([value, text]) => el('option', { value, text })));
  const result = el('div', { class: 'small muted' });
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Administrator: assign a reviewer' }),
    el('p', { class: 'small muted', text: 'The reviewer must register first. Assignment grants access only to the selected department.' }),
    el('div', { class: 'grid two' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Registered reviewer email' }), email]),
      el('div', { class: 'field' }, [el('label', { text: 'Department' }), department]),
    ]),
    el('div', { class: 'btn row' }, [el('button', { class: 'primary', text: 'Assign department', onclick: async (event) => {
      event.target.disabled = true; result.textContent = '';
      try { await api.post('/api/reviewer/assign', { email: email.value, department: department.value }); result.replaceChildren(notice('Reviewer assigned.', 'ok')); }
      catch (err) { result.replaceChildren(notice(err.message, 'error')); }
      finally { event.target.disabled = false; }
    }})]), result,
  ]);
}

const tabButton = (view, text) =>
  el('button', {
    class: state.view === view ? 'active' : '',
    text,
    onclick: () => { state.view = view; state.selected = null; showConsole(); },
  });

function queueRow(claim) {
  const row = el('tr', { class: `clickable ${state.selected === claim.id ? 'selected' : ''}` }, [
    el('td', {}, [
      el('div', { class: 'mono', text: claim.reference }),
      el('div', { class: 'small muted', text: `${label(claim.claimType)} · ${ago(claim.createdAt)}` }),
    ]),
    el('td', {}, [
      el('div', { text: claim.claimantName }),
      el('div', { class: 'small muted', text: claim.policyNumber }),
    ]),
    el('td', { class: 'nowrap', text: money(claim.amount, claim.currency) }),
    el('td', {}, [
      badge(claim.riskBand || 'unscored', riskVariant(claim.riskBand)),
      claim.suspectedFraud ? el('div', { style: { marginTop: '4px' } }, [badge('fraud flag', 'critical')]) : null,
    ]),
  ]);
  row.addEventListener('click', () => openClaim(claim.id));
  return row;
}

/* -------------------------------------------------------------- claim view */

async function openClaim(id) {
  state.selected = id;
  const panel = $('#detail');
  if (!panel) return;
  panel.replaceChildren(spinner('Loading the case file…'));
  try {
    const scroll = !state.detail || state.detail.claim.id !== id;
    state.detail = await api.get(`/api/claims/${encodeURIComponent(id)}`);
    renderDetail();
    if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    panel.replaceChildren(el('div', { class: 'card' }, [notice(err.message, 'error')]));
  }
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const severityBadge = (severity) =>
  badge(severity, ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'neutral');

function renderDetail() {
  const { claim, documents, analyses, decisions, timeline } = state.detail;
  const panel = $('#detail');
  const signals = [...(claim.ruleSignals || [])].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));

  panel.replaceChildren(
    el('div', { class: 'card' }, [
      el('div', { class: 'pillrow', style: { justifyContent: 'space-between' } }, [
        el('div', {}, [
          el('div', { class: 'mono', text: claim.reference }),
          el('h2', { style: { margin: '4px 0 0' }, text: `${claim.claimantName} · ${label(claim.claimType)}` }),
        ]),
        el('div', { class: 'pillrow' }, [
          badge(label(claim.status), claim.status === 'decided' ? 'ok' : 'neutral'),
          claim.riskBand ? badge(`risk ${claim.riskBand}`, riskVariant(claim.riskBand)) : null,
        ]),
      ]),

      el('div', { class: 'grid three', style: { marginTop: '16px' } }, [
        statCard('Claimed', money(claim.amount, claim.currency)),
        statCard('Agent risk score', claim.riskScore === null ? '—' : `${claim.riskScore} / 100`, `rule floor ${claim.ruleRiskScore ?? '—'}`),
        statCard('Authenticity', claim.authenticityScore === null ? '—' : `${claim.authenticityScore} / 100`, 'weakest document'),
      ]),

      el('dl', { class: 'kv', style: { marginTop: '16px' } }, [
        el('dt', { text: 'Policy' }), el('dd', { class: 'mono', text: claim.policyNumber }),
        el('dt', { text: 'Incident date' }), el('dd', { text: claim.incidentDate || 'not supplied' }),
        el('dt', { text: 'Submitted' }), el('dd', { text: `${when(claim.createdAt)} (${ago(claim.createdAt)})` }),
        el('dt', { text: 'Claimant e-mail' }), el('dd', { text: claim.claimantEmail || 'not supplied' }),
        el('dt', { text: 'Analysis' }), el('dd', { text: claim.analysisMode === 'ai' ? 'multimodal model + rule engine' : `${label(claim.analysisMode || 'rules only')} (no model configured)` }),
      ]),

      claim.description ? el('p', { class: 'small', style: { marginTop: '14px' }, text: `“${claim.description}”` }) : null,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Agent assessment' }),
      el('p', { class: 'small', style: { marginTop: 0 }, text: claim.caseSummary || 'The agent did not produce a narrative summary for this claim.' }),
      el('div', { class: 'pillrow', style: { margin: '10px 0' } }, [
        badge(`Recommends: ${label(claim.recommendation) || '—'}`, claim.recommendation === 'approve' ? 'ok' : claim.recommendation === 'reject' ? 'bad' : 'medium'),
        claim.suspectedFraud ? badge('suspected fabrication', 'critical') : badge('no fabrication flag', 'neutral'),
      ]),
      el('h3', { text: 'Why it was routed here' }),
      el('p', { class: 'small', style: { marginTop: 0 }, text: claim.routingReason || '—' }),
      claim.aiRationale ? el('p', { class: 'small muted', text: `Model rationale: ${claim.aiRationale}` }) : null,
      claim.questions?.length
        ? el('div', {}, [
            el('h3', { text: 'Open questions for the claimant' }),
            el('ul', { class: 'small muted' }, claim.questions.map((q) => el('li', { text: q }))),
          ])
        : null,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: `Signals (${signals.length})` }),
      signals.length === 0
        ? el('p', { class: 'small muted', text: 'No rule or model signal fired on this claim.' })
        : el('div', {}, signals.map((s) =>
            el('div', { class: 'signal' }, [
              el('div', { class: 'sev' }, [severityBadge(s.severity)]),
              el('div', { class: 'body' }, [
                el('div', { class: 'desc', text: s.description }),
                el('div', { class: 'meta', text: [s.code, s.source === 'model' ? 'model examiner' : 'rule engine', s.evidence].filter(Boolean).join(' · ') }),
              ]),
            ]),
          )),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: `Documents (${documents.length})` }),
      ...documents.map((doc) => documentCard(doc, analyses.filter((a) => a.documentId === doc.id).slice(-1)[0])),
      el('div', { class: 'btn row', style: { marginTop: '12px' } }, [
        el('button', {
          class: 'btn',
          text: 'Re-run the document examiner',
          onclick: async (event) => {
            event.target.disabled = true;
            event.target.textContent = 'Re-running…';
            try {
              await api.post(`/api/claims/${encodeURIComponent(claim.id)}/reanalyze`, {});
              await openClaim(claim.id);
            } catch (err) {
              event.target.disabled = false;
              event.target.textContent = 'Re-run the document examiner';
              alert(err.message);
            }
          },
        }),
      ]),
    ]),

    decisions.length ? decisionCard(decisions) : decisionForm(claim),
    auditCard(timeline),
  );
}

const statCard = (label, value, sub) =>
  el('div', { class: 'stat' }, [
    el('span', { class: 'l', text: label }),
    el('span', { class: 'n', text: value }),
    sub ? el('span', { class: 'small muted', text: sub }) : null,
  ]);

function documentCard(doc, analysis) {
  const isImage = String(doc.contentType || '').startsWith('image/');
  const score = analysis?.authenticityScore;
  return el('div', { style: { marginBottom: '18px' } }, [
    el('div', { class: 'doc-row' }, [
      el('div', { style: { flex: '1', minWidth: '0' } }, [
        el('div', { text: doc.filename }),
        el('div', { class: 'small muted', text: `${doc.docType ? label(doc.docType) + ' · ' : ''}${bytes(doc.sizeBytes)} · submitted ${when(doc.createdAt)}` }),
        el('div', { class: 'mono small muted', text: `sha256 ${String(doc.sha256 || '').slice(0, 16)}…` }),
      ]),
      score === null || score === undefined
        ? null
        : el('div', {}, [badge(`authenticity ${score}`, score < 40 ? 'critical' : score < 70 ? 'medium' : 'ok')]),
      el('a', { class: 'btn small', href: doc.fileUrl, target: '_blank', rel: 'noopener', text: 'Open' }),
    ]),
    isImage
      ? el('div', { class: 'doc-preview', style: { marginTop: '8px' } }, [
          el('img', { src: doc.fileUrl, alt: doc.filename, loading: 'lazy' }),
        ])
      : null,
    analysis
      ? el('div', { class: 'small', style: { marginTop: '8px' } }, [
          el('div', { class: 'muted', text: `Examiner: ${analysis.mode}${analysis.model ? ` (${analysis.model})` : ''}${analysis.legibility ? ` · legibility: ${analysis.legibility}` : ''}` }),
          analysis.summary ? el('div', { style: { marginTop: '4px' }, text: analysis.summary }) : null,
          analysis.consistencyNotes ? el('div', { class: 'muted', style: { marginTop: '4px' }, text: analysis.consistencyNotes }) : null,
          analysis.positiveSignals?.length
            ? el('ul', { class: 'muted', style: { margin: '6px 0 0 18px' } }, analysis.positiveSignals.map((s) => el('li', { text: s })))
            : null,
          analysis.error ? el('div', { class: 'muted', style: { marginTop: '4px' }, text: analysis.error }) : null,
        ])
      : null,
  ]);
}

function decisionCard(decisions) {
  const latest = decisions[decisions.length - 1];
  const verdict = latest.action === 'approve' ? 'ok' : latest.action === 'reject' ? 'bad' : 'medium';
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Final decision' }),
    el('div', { class: 'pillrow' }, [badge(label(latest.action), verdict), badge(latest.departmentName || '')]),
    el('dl', { class: 'kv', style: { marginTop: '12px' } }, [
      el('dt', { text: 'Decided by' }), el('dd', { text: latest.reviewerName || latest.reviewerEmail || latest.reviewerSub }),
      el('dt', { text: 'When' }), el('dd', { text: `${when(latest.createdAt)} (${ago(latest.createdAt)})` }),
      latest.amountApproved ? el('dt', { text: 'Amount approved' }) : null,
      latest.amountApproved ? el('dd', { text: money(latest.amountApproved) }) : null,
      el('dt', { text: 'Notes' }), el('dd', { text: latest.notes || '—' }),
    ]),
  ]);
}

const DEFAULT_ACTION = { approve: 'approve', reject: 'reject', investigate: 'escalate', request_info: 'request_info' };

function decisionForm(claim) {
  const action = el('select', {}, Object.entries(ACTION_LABEL).map(([value, text]) => el('option', { value, text })));
  action.value = DEFAULT_ACTION[claim.recommendation] || 'approve';

  const amount = el('input', { type: 'text', value: claim.amount, inputmode: 'decimal' });
  const notes = el('textarea', { placeholder: 'Record your reasoning. Required for a rejection or an escalation.' });
  const errorBox = el('div');

  const amountField = el('div', { class: 'field' }, [
    el('label', { text: 'Amount to approve (USD)' }),
    amount,
    el('div', { class: 'hint', text: 'Only used when you approve.' }),
  ]);
  const syncAmount = () => amountField.classList.toggle('hidden', action.value !== 'approve');
  action.addEventListener('change', syncAmount);
  syncAmount();

  const submit = el('button', {
    class: 'primary',
    text: 'Record final decision',
    onclick: async (event) => {
      const button = event.target;
      button.disabled = true;
      button.textContent = 'Recording…';
      clear(errorBox);
      try {
        const escalated = action.value === 'escalate';
        await api.post(`/api/claims/${encodeURIComponent(claim.id)}/decision`, {
          action: action.value,
          amountApproved: action.value === 'approve' ? amount.value : undefined,
          notes: notes.value,
        });
        state.view = escalated ? 'open' : 'decided';
        state.selected = claim.id;
        await showConsole();
      } catch (err) {
        errorBox.replaceChildren(notice(err.message, 'error'));
        button.disabled = false;
        button.textContent = 'Record final decision';
      }
    },
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: 'Your decision' }),
    el('p', { class: 'small muted', style: { marginTop: 0 }, text: 'This is the decision of record. The agent has no authority to approve or reject a claim.' }),
    el('div', { class: 'grid two' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Action' }), action]),
      amountField,
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Notes' }), notes]),
    errorBox,
    submit,
  ]);
}

function auditCard(timeline) {
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Audit trail' }),
    el('ul', { class: 'timeline' }, timeline.map((event) => {
      const d = event.detail || {};
      return el('li', { class: event.actorType }, [
        el('div', {}, [
          el('strong', { text: label(event.event.replace(/\./g, ' ')) }),
          event.actorLabel ? el('span', { class: 'small muted', text: ` — ${event.actorLabel}` }) : null,
        ]),
        d.reason ? el('div', { class: 'small muted', text: d.reason }) : null,
        d.notes ? el('div', { class: 'small', text: d.notes }) : null,
        d.policyNumber ? el('div', { class: 'small muted', text: `policy ${d.policyNumber} · ${money(d.amount)}` }) : null,
        d.filename ? el('div', { class: 'small muted', text: `${d.filename}${d.duplicateOfClaimId ? ` · duplicate of ${d.duplicateOfClaimId}` : ''}` }) : null,
        Array.isArray(d.signals) ? el('div', { class: 'small muted', text: `${d.signals.length} signal(s) · agent mode: ${d.mode} · risk ${d.riskScore}` }) : null,
        d.amountApproved !== undefined && d.amountApproved !== null ? el('div', { class: 'small', text: `Approved ${money(d.amountApproved)}` }) : null,
        typeof d.agreedWithAgent === 'boolean'
          ? el('div', { class: 'small muted', text: d.agreedWithAgent ? 'Agreed with the agent recommendation' : 'Overrode the agent recommendation' })
          : null,
        el('div', { class: 'small muted', text: when(event.createdAt) }),
      ]);
    })),
  ]);
}

/* ---------------------------------------------------------------- start-up */

async function loadSession() {
  state.session = await api.get('/api/reviewer/session');
  showChip();
  return state.session;
}

async function start() {
  try {
    const session = await loadSession();
    const reviewer = session.reviewer;

    if (!session.signedIn) return renderSignIn();
    if (!reviewer?.department || reviewer.status !== 'active') {
      const { departments } = await api.get('/api/departments');
      state.departments = departments;
      return renderOnboard();
    }
    await showConsole();
  } catch (err) {
    render([notice(`Could not load the console: ${err.message}`, 'error')]);
  }
}

start();
