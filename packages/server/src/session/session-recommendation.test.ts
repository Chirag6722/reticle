import { describe, expect, it } from 'vitest';
import {
  HIDDEN_TAB_RECOMMENDATION,
  THROTTLED_TAB_RECOMMENDATION,
  UNSCRIPTABLE_TAB_RECOMMENDATION,
} from '@reticlehq/core';
import { buildSessionRecommendation } from './session-recommendation.js';

describe('buildSessionRecommendation', () => {
  it('recommends reticle drive when hidden and throttled', () => {
    // Hidden outranks throttled: a background tab is the stronger fact, and the one whose failure
    // mode (events landing on a page that never advances) is worth warning about.
    const rec = buildSessionRecommendation({ hidden: true, throttled: true, focused: false });
    expect(rec).toBe(HIDDEN_TAB_RECOMMENDATION);
    expect(rec).toContain('reticle drive');
  });

  it('names the in-protocol escape hatch before the CLI one (#521)', () => {
    // An MCP-only agent has no shell: `reticle drive` is a sentence for the human, while
    // `reticle_run { tool: "reticle_lease" }` is the route the agent itself can take. The agent's
    // option leads; the CLI follows as the human's equivalent.
    const rec = UNSCRIPTABLE_TAB_RECOMMENDATION;
    expect(rec).toContain('reticle_run { tool: "reticle_lease"');
    expect(rec.indexOf('reticle_run')).toBeLessThan(rec.indexOf('reticle drive'));
  });

  it('tells a VISIBLE throttled tab it is still driveable, instead of sending the agent away', () => {
    // The defect this split exists for. A visible throttled tab took a sign-in and two clean
    // net-grade verdicts with no retries, while the old shared message had already recommended a
    // lease the watching human could not see.
    const rec = buildSessionRecommendation({ hidden: false, throttled: true, focused: true });
    expect(rec).toBe(THROTTLED_TAB_RECOMMENDATION);
    expect(rec).toContain('still driveable');
    // It names the precise instrument for what throttling actually degrades — timing — rather than
    // offering a different browser as the answer to a slow one.
    expect(rec).toContain('refuseWhenThrottled');
    // And a lease is the fallback for a drive that FAILS, not the opening move.
    expect(rec).toContain('only if a drive here actually fails');
  });

  it('says what a lease costs, on every recommendation that offers one', () => {
    // An agent cannot weigh a tradeoff it is not told about. Recommending a lease without saying
    // the human sees nothing is what produced fifteen invisible tool calls and "why is nothing
    // running?" from someone watching an empty HUD.
    for (const rec of [HIDDEN_TAB_RECOMMENDATION, THROTTLED_TAB_RECOMMENDATION]) {
      expect(rec).toContain('SEPARATE context');
      expect(rec).toContain('sees nothing');
    }
  });

  it('keeps the deprecated name pointing at the hidden-tab wording', () => {
    // The single message was correct for a hidden tab and wrong for a visible one, so that is the
    // meaning an older pinned consumer should keep.
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toBe(HIDDEN_TAB_RECOMMENDATION);
  });

  it('recommends when hidden regardless of throttled flag', () => {
    expect(buildSessionRecommendation({ hidden: true, throttled: false, focused: false })).toBe(
      HIDDEN_TAB_RECOMMENDATION,
    );
  });

  it('returns undefined for a healthy focused tab', () => {
    expect(
      buildSessionRecommendation({ hidden: false, throttled: false, focused: true }),
    ).toBeUndefined();
  });

  it('does not recommend for a merely-unfocused but live tab', () => {
    expect(
      buildSessionRecommendation({ hidden: false, throttled: false, focused: false }),
    ).toBeUndefined();
  });

  it('the recommendation is the named UNSCRIPTABLE_TAB_RECOMMENDATION constant', () => {
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('reticle_run { tool: "reticle_lease"');
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('reticle drive');
    // Case-insensitive: the invariant is that refocusing is OFFERED, not where the sentence
    // boundary happens to fall.
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toMatch(/refocus/i);
  });
});
