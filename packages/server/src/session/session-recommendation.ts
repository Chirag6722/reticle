import { HIDDEN_TAB_RECOMMENDATION, THROTTLED_TAB_RECOMMENDATION } from '@reticlehq/core';

/**
 * The session flags the recommendation is derived from. All already exist on every
 * Session (fed by PAGE_HEALTH events) — no new browser API is needed.
 */
export interface RecommendationInputs {
  hidden: boolean;
  throttled: boolean;
  focused: boolean;
}

/**
 * A human-readable hint when a tab is hidden or throttled. Returns undefined for a healthy tab so
 * the field stays ABSENT (not empty). A merely-unfocused but live tab is still scriptable, so blur
 * alone does not trigger it. Pure.
 *
 * HIDDEN and THROTTLED get DIFFERENT answers, which is the fix. They used to share one message that
 * said "may be un-focusable; acquire a guaranteed scriptable context" — correct for a background
 * tab, and actively harmful for a visible one. A visible throttled tab is driveable; measured in the
 * field, one took a sign-in and two clean net-grade verdicts with no retries, while that message had
 * already sent the agent into a lease the watching human could not see. One flag, advice that cost
 * the product's main trust surface, and nothing bought.
 *
 * Hidden outranks throttled when both are set: a background tab is the stronger fact, and its
 * failure mode (events landing on a page that never advances) is the one worth warning about.
 */
export function buildSessionRecommendation(inputs: RecommendationInputs): string | undefined {
  if (inputs.hidden) return HIDDEN_TAB_RECOMMENDATION;
  if (inputs.throttled) return THROTTLED_TAB_RECOMMENDATION;
  return undefined;
}
