import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

/**
 * Two axes the contradiction hunter never had, and every rule needed both.
 *
 * ORIGIN. A verdict is about the app under test. An analytics beacon, an ad-blocked SDK bootstrap
 * and a vendor CDN ping are all somebody else's code failing in somebody else's domain, and none of
 * them says anything about whether the caller's action worked. Reported independently from several
 * apps: with any analytics package installed, a correct drive came back `contradicted`, and on one
 * app EVERY assertion did — it fires a branding call on page load. A verdict field that answers
 * "no" to everything is not a verdict field.
 *
 * ATTRIBUTION. A rule that says "the UI moved forward while a request failed" is a claim about
 * CAUSATION, and causation needs a cause. Over a window nothing attributed to an action, the two
 * halves merely co-occurred — a poll and a re-render that have nothing to do with each other, or
 * with the caller.
 *
 * The negative controls matter more than the positives here: the cheap way to silence a false
 * positive is to break the true one, and the true one is the product.
 */

const APP = 'http://localhost:3000/dashboard';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}, t?: number): ReticleEvent {
  seq += 1;
  return { t: t ?? seq, seq, type, sessionId: 's', data };
}

const domChanged = (t?: number): ReticleEvent => ev(EventType.DOM_REMOVED, { path: 'li' }, t);
const failedCall = (url: string, t?: number): ReticleEvent =>
  ev(
    EventType.NET_REQUEST,
    { id: `n${String(seq)}`, method: 'POST', url, status: 500, ok: false },
    t,
  );

const kinds = (events: ReticleEvent[], options = {}): string[] =>
  findContradictions(events, { actionSince: 0, appOrigin: APP, ...options }).map((c) => c.kind);

describe('contradictions — the first-party/third-party axis', () => {
  it('does not let a failed analytics beacon contradict an assertion the caller proved', () => {
    const beacon = failedCall('https://www.google-analytics.com/g/collect?v=2');
    expect(kinds([domChanged(), beacon])).toEqual([]);
  });

  it('does not let an ad-blocked third-party bootstrap contradict it either', () => {
    // What an extension-blocked request looks like on the wire: no response at all.
    const blocked = ev(EventType.NET_REQUEST, {
      id: 'n-blocked',
      method: 'GET',
      url: 'https://cdn.segment.com/analytics.js/v1/abc/analytics.min.js',
      status: 0,
      ok: false,
      error: 'Failed to fetch',
    });
    expect(kinds([domChanged(), blocked])).toEqual([]);
  });

  it('STILL fires on the app’s own failed request — the true positive, stated three ways', () => {
    // Relative: the overwhelmingly common shape, and first-party by construction.
    expect(kinds([domChanged(), failedCall('/api/todos')])).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
    // Absolute, same host, DIFFERENT PORT: a dev app on :3000 talking to its API on :8787 is the
    // ordinary local setup, and grading that as somebody else's traffic would silence the detector
    // on the bench app itself.
    expect(kinds([domChanged(), failedCall('http://localhost:8787/api/todos')])).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
    // A sibling subdomain: `api.example.com` called from `app.example.com` is the app's own backend.
    expect(
      kinds([domChanged(), failedCall('https://api.example.com/todos')], {
        appOrigin: 'https://app.example.com/dashboard',
      }),
    ).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  it('judges nothing by origin when nobody could say what the app’s origin is', () => {
    // Same absence rule the document scoping follows: an unknown origin disables the axis rather
    // than guessing, so an older SDK behaves exactly as it did before this existed.
    expect(
      kinds([domChanged(), failedCall('https://www.google-analytics.com/g/collect')], {
        appOrigin: undefined,
      }),
    ).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });
});

describe('contradictions — the attribution floor', () => {
  it('does not contradict a PASSIVE assertion with ambient first-party traffic', () => {
    // No action opened this window, so nothing in it is anybody's consequence: the app polled, the
    // poll failed, and a re-render landed. Neither half caused the other and the caller caused
    // neither.
    expect(kinds([domChanged(), failedCall('/api/branding')], { actionSince: undefined })).toEqual(
      [],
    );
  });

  it('ignores traffic that predates the action', () => {
    const before = [domChanged(30), failedCall('/api/branding', 10)];
    expect(kinds(before, { actionSince: 20 })).toEqual([]);
  });

  it('STILL fires on traffic the action itself caused', () => {
    const after = [domChanged(30), failedCall('/api/todos', 25)];
    expect(kinds(after, { actionSince: 20 })).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
  });

  it('leaves the app’s OWN claims judged with or without an action', () => {
    // The flagship false green, and the reason the floor is not a blanket "no action, no findings":
    // the app explicitly asserted success while its own request failed. That is a claim the app
    // made, not a consequence anybody inferred, so it stands on a passive assert too.
    const claimed = [
      ev(EventType.SIGNAL, { name: 'compose:generated' }),
      failedCall('/api/generate-script'),
    ];
    expect(kinds(claimed, { actionSince: undefined })).toEqual([
      ContradictionKind.SIGNAL_CONTRADICTED,
    ]);
  });
});
