// Validation for the human final decision. Kept pure so the rules that guard a
// payout can be tested without a signed-in session.

export const DECISION_ACTIONS = ['approve', 'reject', 'request_info', 'escalate'];

/** Actions that materially affect the claimant and therefore need a written reason. */
export const NEEDS_JUSTIFICATION = ['reject', 'escalate'];

export function validateDecision({ action, notes = '', amountApprovedCents = null, claimedCents = 0 }) {
  if (!DECISION_ACTIONS.includes(action)) {
    return { error: `action must be one of: ${DECISION_ACTIONS.join(', ')}` };
  }

  if (NEEDS_JUSTIFICATION.includes(action) && String(notes).trim().length < 10) {
    return { error: 'A written justification is required to reject or escalate a claim.' };
  }

  if (action !== 'approve') return { amountApprovedCents: null };

  if (amountApprovedCents === null || !Number.isFinite(amountApprovedCents) || amountApprovedCents <= 0) {
    return { error: 'Enter the amount to approve' };
  }
  if (claimedCents > 0 && amountApprovedCents > claimedCents * 2) {
    return { error: 'The approved amount cannot exceed twice the claimed amount' };
  }
  return { amountApprovedCents };
}

/**
 * Whether the department head went along with the agent. Recorded on every
 * decision so override rates can be reviewed later.
 */
export function agreesWithAgent(action, recommendation) {
  if (!recommendation) return null;
  const equivalent = { approve: 'approve', reject: 'reject', investigate: 'escalate', request_info: 'request_info' };
  return equivalent[recommendation] === action;
}
