// Three independent model requests plus time to validate and commit the result.
export const REASONING_CALL_TIMEOUT_MS = 180_000;
export const REASONING_MAX_ATTEMPTS = 3;
export const REASONING_ACTIVITY_TIMEOUT_MS = 600_000;
export const REASONING_SCHEDULE_TIMEOUT_MS = 2_100_000;

export function decisionByteLimit(config: {
  maxOutputTokens: number;
  maxContextBytes: number;
}) {
  // JSON-encoded payloads need room for UTF-8 and escaping. Keep an absolute
  // ceiling, while respecting a workflow's smaller context allowance.
  return Math.min(
    config.maxContextBytes,
    64_000,
    Math.max(16_000, config.maxOutputTokens * 8),
  );
}
