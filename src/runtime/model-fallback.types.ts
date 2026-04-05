// Ported verbatim from OpenClaw src/agents/model-fallback.types.ts

import type { FailoverReason } from "./failover-error.js";

export type ModelCandidate = {
  provider: string;
  model: string;
};

export type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};
