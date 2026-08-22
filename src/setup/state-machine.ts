import type { SetupStatus } from "./types.js";

const transitions: Readonly<Record<SetupStatus, readonly SetupStatus[]>> = {
  IDLE: ["PREFLIGHT"],
  PREFLIGHT: ["PLANNED", "NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION"],
  PLANNED: ["WAITING_FOR_CONFIRMATION", "NEEDS_RECONCILIATION"],
  WAITING_FOR_CONFIRMATION: ["APPLYING", "NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION"],
  APPLYING: ["VERIFYING", "NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION"],
  VERIFYING: ["COMPLETE", "NEEDS_CREDENTIAL_REENTRY", "NEEDS_RECONCILIATION"],
  COMPLETE: ["ROLLING_BACK", "NEEDS_CREDENTIAL_REENTRY"],
  NEEDS_CREDENTIAL_REENTRY: ["PREFLIGHT", "WAITING_FOR_CONFIRMATION", "NEEDS_RECONCILIATION", "ROLLING_BACK", "COMPLETE"],
  NEEDS_RECONCILIATION: ["VERIFYING", "ROLLING_BACK", "NEEDS_CREDENTIAL_REENTRY", "COMPLETE"],
  ROLLING_BACK: ["ROLLED_BACK", "ROLLBACK_PARTIAL", "NEEDS_CREDENTIAL_REENTRY"],
  ROLLED_BACK: [],
  ROLLBACK_PARTIAL: ["ROLLING_BACK", "NEEDS_CREDENTIAL_REENTRY"],
};

export function canTransition(from: SetupStatus, to: SetupStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: SetupStatus, to: SetupStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid setup state transition: ${from} -> ${to}`);
  }
}

export function isMutatingStatus(status: SetupStatus): status is "APPLYING" | "ROLLING_BACK" {
  return status === "APPLYING" || status === "ROLLING_BACK";
}
