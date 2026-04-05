// Ported from OpenClaw src/agents/failover-error.ts + pi-embedded-helpers/errors.ts + failover-matches.ts
// Consolidated into a single module. All classification logic, patterns, and constants are identical.

export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";

export type FailoverSignal = {
  status?: number;
  code?: string;
  message?: string;
};

export type FailoverClassification =
  | { kind: "reason"; reason: FailoverReason }
  | { kind: "context_overflow" };

// --- FailoverError class (from failover-error.ts) ---

const ABORT_TIMEOUT_RE = /request was aborted|request aborted/i;

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      status?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.status = params.status;
    this.code = params.code;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

export function resolveFailoverStatus(reason: FailoverReason): number | undefined {
  switch (reason) {
    case "billing": return 402;
    case "rate_limit": return 429;
    case "overloaded": return 503;
    case "auth": return 401;
    case "auth_permanent": return 403;
    case "timeout": return 408;
    case "format": return 400;
    case "model_not_found": return 404;
    case "session_expired": return 410;
    default: return undefined;
  }
}

// --- Error patterns (from failover-matches.ts) ---

type ErrorPattern = string | RegExp;

const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    "model_cooldown",
    "exceeded your current quota",
    "resource has been exhausted",
    "quota exceeded",
    "resource_exhausted",
    "usage limit",
    /\btpm\b/i,
    "tokens per minute",
    "tokens per day",
  ] as ErrorPattern[],
  overloaded: [
    /overloaded_error|"type"\s*:\s*"overloaded_error"/i,
    "overloaded",
    /service[_ ]unavailable.*(?:overload|capacity|high[_ ]demand)|(?:overload|capacity|high[_ ]demand).*service[_ ]unavailable/i,
    "high demand",
  ] as ErrorPattern[],
  serverError: [
    "an error occurred while processing",
    "internal server error",
    "internal_error",
    "server_error",
    "service temporarily unavailable",
    "service_unavailable",
    "bad gateway",
    "gateway timeout",
    "upstream error",
    "upstream connect error",
    "connection reset",
  ] as ErrorPattern[],
  timeout: [
    "timeout",
    "timed out",
    "service unavailable",
    "deadline exceeded",
    "context deadline exceeded",
    "connection error",
    "network error",
    "network request failed",
    "fetch failed",
    "socket hang up",
    /\beconn(?:refused|reset|aborted)\b/i,
    /\benetunreach\b/i,
    /\behostunreach\b/i,
    /\behostdown\b/i,
    /\benetreset\b/i,
    /\betimedout\b/i,
    /\besockettimedout\b/i,
    /\bepipe\b/i,
    /\benotfound\b/i,
    /\beai_again\b/i,
    /without sending (?:any )?chunks?/i,
    /\bstop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
    /\breason:\s*(?:abort|error|malformed_response|network_error)\b/i,
    /\bunhandled stop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
  ] as ErrorPattern[],
  billing: [
    /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment/i,
    "payment required",
    "insufficient credits",
    /insufficient[_ ]quota/i,
    "credit balance",
    "plans & billing",
    "insufficient balance",
    "insufficient usd or diem balance",
    /requires?\s+more\s+credits/i,
  ] as ErrorPattern[],
  authPermanent: [
    /api[_ ]?key[_ ]?(?:revoked|invalid|deactivated|deleted)/i,
    "invalid_api_key",
    "key has been disabled",
    "key has been revoked",
    "account has been deactivated",
    /could not (?:authenticate|validate).*(?:api[_ ]?key|credentials)/i,
    "permission_error",
    "not allowed for this organization",
  ] as ErrorPattern[],
  auth: [
    /invalid[_ ]?api[_ ]?key/,
    "incorrect api key",
    "invalid token",
    "authentication",
    "re-authenticate",
    "oauth token refresh failed",
    "unauthorized",
    "forbidden",
    "access denied",
    "insufficient permissions",
    "insufficient permission",
    /missing scopes?:/i,
    "expired",
    "token has expired",
    /\b401\b/,
    /\b403\b/,
    "no credentials found",
    "no api key found",
    /\bfailed to (?:extract|parse|validate|decode)\b.*\btoken\b/,
  ] as ErrorPattern[],
  format: [
    "string should match pattern",
    "tool_use.id",
    "tool_use_id",
    "messages.1.content.1.tool_use.id",
    "invalid request format",
    /tool call id was.*must be/i,
  ] as ErrorPattern[],
  modelNotFound: [
    "model_not_found",
    "model not found",
    "the model does not exist",
    /model.*does not exist/i,
    /model.*not available/i,
    "no such model",
  ] as ErrorPattern[],
} as const;

function matchesErrorPatterns(raw: string, patterns: readonly ErrorPattern[]): boolean {
  if (!raw) return false;
  const value = raw.toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern),
  );
}

export function isRateLimitErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}

export function isTimeoutErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}

export function isOverloadedErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
}

export function isBillingErrorMessage(raw: string): boolean {
  if (!raw) return false;
  const value = raw.toLowerCase();
  if (value.length > 5000) {
    return /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b/i.test(value);
  }
  if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) return true;
  if (!/\b(?:402|billing|credit|payment|quota|balance)\b/i.test(raw)) return false;
  return (
    value.includes("upgrade") ||
    value.includes("credits") ||
    value.includes("payment") ||
    value.includes("plan")
  );
}

export function isAuthPermanentErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.authPermanent);
}

export function isAuthErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.auth);
}

function isServerErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.serverError);
}

const TRANSIENT_HTTP_ERROR_CODES = new Set([499, 500, 502, 503, 504, 521, 522, 523, 524, 529]);

export function isTransientHttpError(raw: string): boolean {
  const match = raw.match(/\b(\d{3})\b/);
  if (!match) return false;
  const code = Number(match[1]);
  return TRANSIENT_HTTP_ERROR_CODES.has(code) && !isRateLimitErrorMessage(raw);
}

export function isModelNotFoundErrorMessage(raw: string): boolean {
  return matchesErrorPatterns(raw, ERROR_PATTERNS.modelNotFound);
}

function hasRateLimitTpmHint(raw: string): boolean {
  const lower = raw.toLowerCase();
  return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}

function isReasoningConstraintErrorMessage(raw: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("reasoning is mandatory") ||
    lower.includes("reasoning is required") ||
    lower.includes("requires reasoning") ||
    (lower.includes("reasoning") && lower.includes("cannot be disabled"))
  );
}

// --- Image error detection (from errors.ts) ---

const IMAGE_DIMENSION_ERROR_RE =
  /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;

export function isImageDimensionErrorMessage(raw: string): boolean {
  if (!raw) return false;
  return raw.toLowerCase().includes("image dimensions exceed max allowed size");
}

const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;

export function isImageSizeError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return lower.includes("image exceeds") && lower.includes("mb");
}

// --- Session expired detection (from errors.ts) ---

export function isCliSessionExpiredErrorMessage(raw: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("session not found") ||
    lower.includes("session does not exist") ||
    lower.includes("session expired") ||
    lower.includes("session invalid") ||
    lower.includes("conversation not found") ||
    lower.includes("conversation does not exist") ||
    lower.includes("conversation expired") ||
    lower.includes("conversation invalid") ||
    lower.includes("no such session") ||
    lower.includes("invalid session") ||
    lower.includes("session id not found") ||
    lower.includes("conversation id not found")
  );
}

// --- Periodic usage limit (from failover-matches.ts) ---

const PERIODIC_USAGE_LIMIT_RE =
  /\b(?:daily|weekly|monthly)(?:\/(?:daily|weekly|monthly))* (?:usage )?limit(?:s)?(?: (?:exhausted|reached|exceeded))?\b/i;

export function isPeriodicUsageLimitErrorMessage(raw: string): boolean {
  return PERIODIC_USAGE_LIMIT_RE.test(raw);
}

// --- Provider-specific patterns (from provider-error-patterns.ts) ---

const PROVIDER_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /ValidationException.*(?:input is too long|max input token|input token.*exceed)/i,
  /ValidationException.*(?:exceeds? the (?:maximum|max) (?:number of )?(?:input )?tokens)/i,
  /ModelStreamErrorException.*(?:Input is too long|too many input tokens)/i,
  /content_filter.*(?:prompt|input).*(?:too long|exceed)/i,
  /\bollama\b.*(?:context length|too many tokens|context window)/i,
  /\btruncating input\b.*\btoo long\b/i,
  /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i,
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i,
  /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i,
  /INVALID_ARGUMENT.*(?:exceeds? the (?:maximum|max)|input.*too (?:long|large))/i,
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

export function matchesProviderContextOverflow(errorMessage: string): boolean {
  return PROVIDER_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

type ProviderErrorPattern = { test: RegExp; reason: FailoverReason };

const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[] = [
  { test: /ThrottlingException|Too many concurrent requests/i, reason: "rate_limit" },
  { test: /ModelNotReadyException/i, reason: "overloaded" },
  { test: /model(?:_is)?_deactivated|model has been deactivated/i, reason: "model_not_found" },
  { test: /\bconcurrency limit\b.*\breached\b/i, reason: "rate_limit" },
  { test: /\bworkers?_ai\b.*\b(?:rate|limit|quota)\b/i, reason: "rate_limit" },
];

export function classifyProviderSpecificError(errorMessage: string): FailoverReason | null {
  for (const pattern of PROVIDER_SPECIFIC_PATTERNS) {
    if (pattern.test.test(errorMessage)) return pattern.reason;
  }
  return null;
}

// --- JSON API internal server error (from errors.ts) ---

const API_ERROR_TRANSIENT_SIGNALS_RE =
  /internal server error|overload|temporarily unavailable|service unavailable|unknown error|server error|bad gateway|gateway timeout|upstream error|backend error|try again later|temporarily.+unable|unexpected error/i;

function isJsonApiInternalServerError(raw: string): boolean {
  if (!raw) return false;
  const value = raw.toLowerCase();
  if (!value.includes('"type":"api_error"')) return false;
  if (isBillingErrorMessage(raw) || isAuthErrorMessage(raw) || isAuthPermanentErrorMessage(raw)) return false;
  return API_ERROR_TRANSIENT_SIGNALS_RE.test(raw);
}

// --- Full 402 classification (from errors.ts) ---

type PaymentRequiredFailoverReason = "billing" | "rate_limit";

const BILLING_402_HINTS = [
  "insufficient credits", "insufficient quota", "credit balance", "insufficient balance",
  "plans & billing", "add more credits", "top up",
] as const;
const BILLING_402_PLAN_HINTS = [
  "upgrade your plan", "upgrade plan", "current plan", "subscription",
] as const;
const PERIODIC_402_HINTS = ["daily", "weekly", "monthly"] as const;
const RETRYABLE_402_RETRY_HINTS = ["try again", "retry", "temporary", "cooldown"] as const;
const RETRYABLE_402_LIMIT_HINTS = ["usage limit", "rate limit", "organization usage"] as const;
const RETRYABLE_402_SCOPED_HINTS = ["organization", "workspace"] as const;
const RETRYABLE_402_SCOPED_RESULT_HINTS = [
  "billing period", "exceeded", "reached", "exhausted",
] as const;

const RAW_402_MARKER_RE =
  /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment required\b|^\s*402\s+.*used up your points\b/i;
const LEADING_402_WRAPPER_RE =
  /^(?:error[:\s-]+)?(?:(?:http\s*)?402(?:\s+payment required)?|payment required)(?:[:\s-]+|$)/i;

function includesAnyHint(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function hasExplicit402BillingSignal(text: string): boolean {
  return (
    includesAnyHint(text, BILLING_402_HINTS) ||
    (includesAnyHint(text, BILLING_402_PLAN_HINTS) && text.includes("limit")) ||
    text.includes("billing hard limit") ||
    text.includes("hard limit reached") ||
    (text.includes("maximum allowed") && text.includes("limit"))
  );
}

function hasQuotaRefreshWindowSignal(text: string): boolean {
  return (
    text.includes("subscription quota limit") &&
    (text.includes("automatic quota refresh") || text.includes("rolling time window"))
  );
}

function hasRetryable402TransientSignal(text: string): boolean {
  const hasPeriodicHint = includesAnyHint(text, PERIODIC_402_HINTS);
  const hasSpendLimit = text.includes("spend limit") || text.includes("spending limit");
  const hasScopedHint = includesAnyHint(text, RETRYABLE_402_SCOPED_HINTS);
  return (
    (includesAnyHint(text, RETRYABLE_402_RETRY_HINTS) &&
      includesAnyHint(text, RETRYABLE_402_LIMIT_HINTS)) ||
    (hasPeriodicHint && (text.includes("usage limit") || hasSpendLimit)) ||
    (hasPeriodicHint && text.includes("limit") && text.includes("reset")) ||
    (hasScopedHint &&
      text.includes("limit") &&
      (hasSpendLimit || includesAnyHint(text, RETRYABLE_402_SCOPED_RESULT_HINTS)))
  );
}

function normalize402Message(raw: string): string {
  return raw.trim().toLowerCase().replace(LEADING_402_WRAPPER_RE, "").trim();
}

// --- Context overflow detection (from errors.ts) ---

const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE =
  /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;
const RATE_LIMIT_HINT_RE =
  /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i;

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();

  if (hasRateLimitTpmHint(errorMessage)) return false;
  if (isReasoningConstraintErrorMessage(errorMessage)) return false;

  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");
  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("prompt too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow:") ||
    lower.includes("exceed context limit") ||
    lower.includes("exceeds the model's maximum context") ||
    (lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("input length") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("413") && lower.includes("too large")) ||
    lower.includes("context_window_exceeded") ||
    errorMessage.includes("上下文过长") ||
    errorMessage.includes("上下文超出") ||
    errorMessage.includes("上下文长度超") ||
    errorMessage.includes("超出最大上下文") ||
    errorMessage.includes("请压缩上下文") ||
    matchesProviderContextOverflow(errorMessage)
  );
}

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  if (hasRateLimitTpmHint(errorMessage)) return false;
  if (isReasoningConstraintErrorMessage(errorMessage)) return false;
  if (isBillingErrorMessage(errorMessage)) return false;
  if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) return false;
  if (isRateLimitErrorMessage(errorMessage)) return false;
  if (isContextOverflowError(errorMessage)) return true;
  if (RATE_LIMIT_HINT_RE.test(errorMessage)) return false;
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}

// --- HTTP status extraction (from assistant-error-format.ts) ---

const HTTP_STATUS_DELIMITER_RE = /(?:\s*:\s*|\s+)/;
const HTTP_STATUS_CODE_PREFIX_RE = new RegExp(
  `^(?:http\\s*)?(\\d{3})(?:${HTTP_STATUS_DELIMITER_RE.source}([\\s\\S]+))?$`,
  "i",
);

function extractLeadingHttpStatus(raw: string): { code: number; rest: string } | null {
  const match = raw.match(HTTP_STATUS_CODE_PREFIX_RE);
  if (!match) return null;
  const code = Number(match[1]);
  if (!Number.isFinite(code)) return null;
  return { code, rest: (match[2] ?? "").trim() };
}

// --- Error code classification ---

const TIMEOUT_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENETUNREACH",
  "EHOSTUNREACH", "EHOSTDOWN", "ENETRESET", "ETIMEDOUT",
  "ESOCKETTIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function classifyFailoverReasonFromCode(raw: string | undefined): FailoverReason | null {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) return null;
  switch (normalized) {
    case "RESOURCE_EXHAUSTED":
    case "RATE_LIMIT":
    case "RATE_LIMITED":
    case "RATE_LIMIT_EXCEEDED":
    case "TOO_MANY_REQUESTS":
    case "THROTTLED":
    case "THROTTLING":
    case "THROTTLINGEXCEPTION":
    case "THROTTLING_EXCEPTION":
      return "rate_limit";
    case "OVERLOADED":
    case "OVERLOADED_ERROR":
      return "overloaded";
    default:
      return TIMEOUT_ERROR_CODES.has(normalized) ? "timeout" : null;
  }
}

// --- Message classification ---

function toReasonClassification(reason: FailoverReason): FailoverClassification {
  return { kind: "reason", reason };
}

function failoverReasonFromClassification(c: FailoverClassification | null): FailoverReason | null {
  return c?.kind === "reason" ? c.reason : null;
}

function classify402Message(message: string): PaymentRequiredFailoverReason {
  const normalized = normalize402Message(message);
  if (!normalized) return "billing";
  if (hasQuotaRefreshWindowSignal(normalized)) return "rate_limit";
  if (hasExplicit402BillingSignal(normalized)) return "billing";
  if (isRateLimitErrorMessage(normalized)) return "rate_limit";
  if (hasRetryable402TransientSignal(normalized)) return "rate_limit";
  return "billing";
}

function classifyFailoverReasonFrom402Text(raw: string): PaymentRequiredFailoverReason | null {
  if (!RAW_402_MARKER_RE.test(raw)) return null;
  return classify402Message(raw);
}

function classifyFailoverClassificationFromMessage(raw: string): FailoverClassification | null {
  if (isImageDimensionErrorMessage(raw)) return null;
  if (isImageSizeError(raw)) return null;
  if (isCliSessionExpiredErrorMessage(raw)) return toReasonClassification("session_expired");
  if (isModelNotFoundErrorMessage(raw)) return toReasonClassification("model_not_found");
  if (isContextOverflowError(raw)) return { kind: "context_overflow" };
  const reasonFrom402Text = classifyFailoverReasonFrom402Text(raw);
  if (reasonFrom402Text) return toReasonClassification(reasonFrom402Text);
  if (isPeriodicUsageLimitErrorMessage(raw)) {
    return toReasonClassification(isBillingErrorMessage(raw) ? "billing" : "rate_limit");
  }
  if (isRateLimitErrorMessage(raw)) return toReasonClassification("rate_limit");
  if (isOverloadedErrorMessage(raw)) return toReasonClassification("overloaded");
  if (isTransientHttpError(raw)) {
    const status = extractLeadingHttpStatus(raw.trim());
    if (status?.code === 529) return toReasonClassification("overloaded");
    return toReasonClassification("timeout");
  }
  if (isBillingErrorMessage(raw)) return toReasonClassification("billing");
  if (isAuthPermanentErrorMessage(raw)) return toReasonClassification("auth_permanent");
  if (isAuthErrorMessage(raw)) return toReasonClassification("auth");
  if (isServerErrorMessage(raw)) return toReasonClassification("timeout");
  if (isJsonApiInternalServerError(raw)) return toReasonClassification("timeout");
  if (isTimeoutErrorMessage(raw)) return toReasonClassification("timeout");
  const providerSpecific = classifyProviderSpecificError(raw);
  if (providerSpecific) return toReasonClassification(providerSpecific);
  return null;
}

function classifyFailoverClassificationFromHttpStatus(
  status: number | undefined,
  message: string | undefined,
  messageClassification: FailoverClassification | null,
): FailoverClassification | null {
  const messageReason = failoverReasonFromClassification(messageClassification);
  if (typeof status !== "number" || !Number.isFinite(status)) return null;

  if (status === 402) return toReasonClassification(message ? classify402Message(message) : "billing");
  if (status === 429) return toReasonClassification("rate_limit");
  if (status === 401 || status === 403) {
    if (message && isAuthPermanentErrorMessage(message)) return toReasonClassification("auth_permanent");
    return toReasonClassification("auth");
  }
  if (status === 408) return toReasonClassification("timeout");
  if (status === 410) {
    if (messageReason === "session_expired" || messageReason === "billing" || messageReason === "auth_permanent" || messageReason === "auth") {
      return messageClassification;
    }
    return toReasonClassification("timeout");
  }
  if (status === 503) {
    if (messageReason === "overloaded") return messageClassification;
    return toReasonClassification("timeout");
  }
  if (status === 499) {
    if (messageReason === "overloaded") return messageClassification;
    return toReasonClassification("timeout");
  }
  if (status === 500 || status === 502 || status === 504) return toReasonClassification("timeout");
  if (status === 529) return toReasonClassification("overloaded");
  if (status === 400 || status === 422) {
    if (messageClassification) return messageClassification;
    return toReasonClassification("format");
  }
  return null;
}

export function classifyFailoverSignal(signal: FailoverSignal): FailoverClassification | null {
  const inferredStatus =
    typeof signal.status === "number" && Number.isFinite(signal.status)
      ? signal.status
      : extractLeadingHttpStatus(signal.message?.trim() ?? "")?.code;
  const messageClassification = signal.message
    ? classifyFailoverClassificationFromMessage(signal.message)
    : null;
  const statusClassification = classifyFailoverClassificationFromHttpStatus(
    inferredStatus,
    signal.message,
    messageClassification,
  );
  if (statusClassification) return statusClassification;
  const codeReason = classifyFailoverReasonFromCode(signal.code);
  if (codeReason) return toReasonClassification(codeReason);
  return messageClassification;
}

// --- Nested error traversal (from failover-error.ts) ---

function readErrorName(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function findErrorProperty<T>(
  err: unknown,
  reader: (candidate: unknown) => T | undefined,
  seen: Set<object> = new Set(),
): T | undefined {
  const direct = reader(err);
  if (direct !== undefined) return direct;
  if (!err || typeof err !== "object") return undefined;
  if (seen.has(err)) return undefined;
  seen.add(err);
  const candidate = err as { error?: unknown; cause?: unknown };
  return (
    findErrorProperty(candidate.error, reader, seen) ??
    findErrorProperty(candidate.cause, reader, seen)
  );
}

function readDirectStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number") return candidate;
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
  return undefined;
}

function getStatusCode(err: unknown): number | undefined {
  return findErrorProperty(err, readDirectStatusCode);
}

function readDirectErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const directCode = (err as { code?: unknown }).code;
  if (typeof directCode === "string") {
    const trimmed = directCode.trim();
    return trimmed || undefined;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "string" || /^\d+$/.test(status)) return undefined;
  const trimmed = status.trim();
  return trimmed || undefined;
}

function getErrorCode(err: unknown): string | undefined {
  return findErrorProperty(err, readDirectErrorCode);
}

function readDirectErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message || undefined;
  if (typeof err === "string") return err || undefined;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  if (typeof err === "symbol") return err.description ?? undefined;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message || undefined;
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  return findErrorProperty(err, readDirectErrorMessage) ?? "";
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== "object" || !("cause" in err)) return undefined;
  return (err as { cause?: unknown }).cause;
}

function hasTimeoutHint(err: unknown): boolean {
  if (!err) return false;
  if (readErrorName(err) === "TimeoutError") return true;
  const message = getErrorMessage(err);
  return Boolean(message && isTimeoutErrorMessage(message));
}

export function isTimeoutError(err: unknown): boolean {
  if (hasTimeoutHint(err)) return true;
  if (!err || typeof err !== "object") return false;
  if (readErrorName(err) !== "AbortError") return false;
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) return true;
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  const reason = "reason" in err ? (err as { reason?: unknown }).reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}

// --- Public resolution API ---

function resolveFailoverClassificationFromError(err: unknown): FailoverClassification | null {
  if (isFailoverError(err)) return { kind: "reason", reason: err.reason };

  const classification = classifyFailoverSignal(normalizeErrorSignal(err));
  if (!classification || classification.kind === "context_overflow") {
    const cause = getErrorCause(err);
    if (cause && cause !== err) {
      const causeClassification = resolveFailoverClassificationFromError(cause);
      if (causeClassification) return causeClassification;
    }
  }
  if (classification) return classification;
  if (isTimeoutError(err)) return { kind: "reason", reason: "timeout" };
  return null;
}

function normalizeErrorSignal(err: unknown): FailoverSignal {
  return {
    status: getStatusCode(err),
    code: getErrorCode(err),
    message: getErrorMessage(err) || undefined,
  };
}

export function resolveFailoverReasonFromError(err: unknown): FailoverReason | null {
  const c = resolveFailoverClassificationFromError(err);
  return c?.kind === "reason" ? c.reason : null;
}

export function describeFailoverError(err: unknown): {
  message: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
} {
  if (isFailoverError(err)) {
    return { message: err.message, reason: err.reason, status: err.status, code: err.code };
  }
  const signal = normalizeErrorSignal(err);
  const message = signal.message ?? String(err);
  return {
    message,
    reason: resolveFailoverReasonFromError(err) ?? undefined,
    status: signal.status,
    code: signal.code,
  };
}

export function coerceToFailoverError(
  err: unknown,
  context?: { provider?: string; model?: string; profileId?: string },
): FailoverError | null {
  if (isFailoverError(err)) return err;
  const reason = resolveFailoverReasonFromError(err);
  if (!reason) return null;

  const signal = normalizeErrorSignal(err);
  const message = signal.message ?? String(err);
  const status = signal.status ?? resolveFailoverStatus(reason);
  const code = signal.code;

  return new FailoverError(message, {
    reason,
    provider: context?.provider,
    model: context?.model,
    profileId: context?.profileId,
    status,
    code,
    cause: err instanceof Error ? err : undefined,
  });
}
