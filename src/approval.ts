import { createHash } from 'node:crypto';
import type { ApprovalSnapshot, Case, DecisionFacts } from './domain.js';
import type { Dispute } from './paypal/schemas.js';
import { minorUnits } from './money.js';
import { providerContextHash } from './response-policy.js';

export class ApprovalStale extends Error {
  constructor() { super('Approved facts are missing or changed. Reassess and review a new recommendation before approving again.'); }
}

function deadline(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ApprovalStale();
  return parsed;
}

export function decisionFacts(dispute: Dispute): DecisionFacts {
  const amount = minorUnits(dispute.dispute_amount);
  const captureId = dispute.disputed_transactions?.[0]?.seller_transaction_id;
  if (amount === undefined || !dispute.dispute_id || !dispute.reason || !dispute.dispute_life_cycle_stage ||
      dispute.disputed_transactions?.length !== 1 || !captureId) throw new ApprovalStale();
  return {
    disputeId: dispute.dispute_id, captureId, currency: dispute.dispute_amount.currency_code,
    amountMinor: amount.toString(), reason: dispute.reason, stage: dispute.dispute_life_cycle_stage,
    deadline: deadline(dispute.seller_response_due_date),
    providerContextHash: providerContextHash(dispute),
  };
}

export function snapshotForCase(c: Case): ApprovalSnapshot {
  const facts = c.decisionFacts;
  const recommendation = c.assessment?.kind === "actionable" ? c.assessment.recommendation : undefined;
  if (!c.recommendationRevision || !recommendation || !facts || c.disputeId !== facts.disputeId ||
      c.reason !== facts.reason || c.amount?.currency_code !== facts.currency ||
      minorUnits(c.amount)?.toString() !== facts.amountMinor || deadline(c.sellerResponseDueDate) !== facts.deadline) throw new ApprovalStale();
  return {
    revision: c.recommendationRevision,
    facts: structuredClone(facts),
    contentHash: createHash('sha256').update(JSON.stringify({ recommendation, evidence: c.evidence, facts })).digest('hex'),
  };
}

export function assertApprovalCurrent(c: Case, fresh: Dispute, now: Date): void {
  if (!c.approvedSnapshot || JSON.stringify(c.approvedSnapshot) !== JSON.stringify(snapshotForCase(c))) throw new ApprovalStale();
  const current = decisionFacts(fresh);
  if (JSON.stringify(current) !== JSON.stringify(c.approvedSnapshot.facts) ||
      (current.deadline !== null && current.deadline <= now.getTime())) throw new ApprovalStale();
}
