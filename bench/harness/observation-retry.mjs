/**
 * Whether a failed observation cell is rig noise worth one retry.
 *
 * Playwright MCP initialize and browser_click time out under CI load. The cell is then recorded
 * NOT MEASURED, which leaves the catch-rate denominator and trips the coverage floor while every
 * rate stays 1.0. Replay-detect already retries a flaky baseline for the same reason; this is that
 * rule for Layer A. A missing tool or a thrown injector is still a real miss.
 *
 * The backend's failure does NOT always name a timeout. The same hung `browser_click` arrives as
 * `TimeoutError: browserBackend.callTool:` on one run and as a bare `Error: browserBackend.callTool:
 * Error:` on the next, and only the first was ever retried — so `network-timeout/playwright` was
 * lost twice running while `broken-form-validation/playwright`, the same rig noise with the luckier
 * wording, was retried. Match the FAILING CALL, not the adjective in front of it.
 */
export function isObservationRetryable(error) {
  const msg = String(error);
  return (
    /timeout after \d+ms on /i.test(msg) ||
    /TimeoutError/i.test(msg) ||
    /cell exceeded \d+ms/i.test(msg) ||
    /browserBackend\.callTool/i.test(msg)
  );
}
