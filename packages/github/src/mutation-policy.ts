export interface MutationPolicy {
  writesEnabled: boolean;
  dryRun: boolean;
}

export interface MutationResult<T> {
  executed: boolean;
  wouldExecute: boolean;
  action: string;
  result?: T;
  reason?: string;
}

export interface MutationAuditEntry {
  action: string;
  timestamp: string;
  reason: string;
  wouldExecute: boolean;
}

export const WRITE_GATE_REASON = "GOVERNED_WRITES_ENABLED=false";

export class WriteGateBlockedError extends Error {
  readonly action: string;
  readonly reason: string;

  constructor(action: string, reason: string = WRITE_GATE_REASON) {
    super(`Write gate blocked: ${action} (${reason})`);
    this.name = "WriteGateBlockedError";
    this.action = action;
    this.reason = reason;
  }
}
