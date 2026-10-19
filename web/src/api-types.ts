import type { Case } from "../../src/domain";

export interface Health {
  paypalBaseUrl: string;
  simulator: boolean;
  aiConfigured: boolean;
  testDouble?: boolean;
  aiProvider?: string;
  aiModel?: string;
}

export interface AuditEntry {
  at: string;
  kind: string;
  detail: unknown;
}

export interface CaseDetail {
  case: Case;
  audit: AuditEntry[];
}

export type SandboxOutcome = "BUYER_FAVOR" | "SELLER_FAVOR";

export interface SandboxResult {
  simulated_resolution: true;
  case: Case;
}

export interface Backend {
  health(): Promise<Health>;
  cases(): Promise<Case[]>;
  caseDetail(id: string): Promise<CaseDetail>;
  reassess(id: string): Promise<Case>;
  approve(id: string, approvedBy: string, recommendationRevision: string): Promise<Case>;
  execute(id: string): Promise<Case>;
  requireEvidence(id: string): Promise<SandboxResult>;
  adjudicate(id: string, outcome: SandboxOutcome): Promise<SandboxResult>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
