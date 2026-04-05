// Ported verbatim from OpenClaw src/agents/failover-policy.ts

import type { FailoverReason } from "./failover-error.js";

export function shouldAllowCooldownProbeForReason(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "billing" ||
    reason === "unknown"
  );
}

export function shouldUseTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return reason === "rate_limit" || reason === "overloaded" || reason === "unknown";
}

export function shouldPreserveTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "model_not_found" ||
    reason === "format" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired"
  );
}
