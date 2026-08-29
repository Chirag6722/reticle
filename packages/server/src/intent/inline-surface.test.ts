import { describe, expect, it } from 'vitest';
import { surfaceForInlineIntent } from './inline-intent.js';

/**
 * Where an inline intent was captured, so the store can file it.
 *
 * Measured on a real corpus: 167 of 173 things a project knew landed in `unsorted`, because
 * `act_and_wait({ intent })` declared a statement and nothing else. The subject ladder had no flow,
 * no route and no explicit subject to work from, so every record fell to the bucket of last resort
 * — and a coverage map that is one pile with six labels tells a manager the team knows nothing,
 * when the truth is that it knows a great deal and none of it is filed.
 *
 * The route is the fix because it is ALWAYS available: an agent is always somewhere. The flow name
 * is better when there is one, and the ladder in `intent-subject.ts` already prefers it.
 */

describe('the surface an inline intent is captured on', () => {
  it('takes the pathname from the session URL', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/issues', undefined)).toEqual({
      route: '/issues',
    });
  });

  /** Query and hash are per-visit, not per-subject: `/issues?category=severe` is still `/issues`. */
  it('drops the query and hash, which are not what a record is about', () => {
    expect(
      surfaceForInlineIntent('http://localhost:4320/issues?category=severe#top', undefined),
    ).toEqual({ route: '/issues' });
  });

  /** A flow is a feature, so it beats a route — the same order the subject ladder already uses. */
  it('carries the flow name when one is running, alongside the route', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/checkout', 'checkout-pay')).toEqual({
      route: '/checkout',
      flow: 'checkout-pay',
    });
  });

  /**
   * Undefined, not an empty object. A surface that says nothing is worse than no surface: it looks
   * like the capture recorded a location and found none, rather than never having had one.
   */
  it('is undefined when there is nothing to record', () => {
    expect(surfaceForInlineIntent(undefined, undefined)).toBeUndefined();
    expect(surfaceForInlineIntent('not a url', undefined)).toBeUndefined();
  });

  /** A bare origin has no path worth filing under; `/` would file everything under one bucket. */
  it('is undefined for a bare origin', () => {
    expect(surfaceForInlineIntent('http://localhost:4320/', undefined)).toBeUndefined();
  });
});
