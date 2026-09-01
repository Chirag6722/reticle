import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { startPathMismatchHint } from './flow-replay-run.js';

const flow = (startPath?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'pay' } }],
  ...(startPath === undefined ? {} : { startPath }),
});

const onRoute = (pathname: string): { eventsSince(c: number): ReticleEvent[] } => ({
  eventsSince: () => [{ t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname } }],
});

const noRoute = (): { eventsSince(c: number): ReticleEvent[] } => ({ eventsSince: () => [] });

describe('startPathMismatchHint — wrong-page drift becomes an actionable next move', () => {
  it('names the navigate target when the tab is on a different route', () => {
    const hint = startPathMismatchHint(flow('/cart'), onRoute('/home'));
    expect(hint).toContain('/cart');
    expect(hint).toContain('reticle_navigate');
  });

  it('is silent when the tab is already on the start page', () => {
    expect(startPathMismatchHint(flow('/cart'), onRoute('/cart'))).toBeUndefined();
  });

  it('is silent when the flow has no startPath (back-compat)', () => {
    expect(startPathMismatchHint(flow(), onRoute('/home'))).toBeUndefined();
  });

  it('never false-alarms when the current route is unobservable', () => {
    expect(startPathMismatchHint(flow('/cart'), noRoute())).toBeUndefined();
  });

  it('falls back to the session URL when no route event was observed (hard-loaded tab)', () => {
    const session = { url: 'http://localhost:3000/reset-password', eventsSince: () => [] };
    const hint = startPathMismatchHint(flow('/login'), session);
    expect(hint).toContain('/login');
    expect(hint).toContain('/reset-password');
  });

  it('is silent when the session URL already sits on the start page', () => {
    const session = { url: 'http://localhost:3000/login?next=%2F', eventsSince: () => [] };
    expect(startPathMismatchHint(flow('/login'), session)).toBeUndefined();
  });

  it('treats a trailing slash as the same page, not as elsewhere', () => {
    const session = { url: 'http://localhost:3000/login/', eventsSince: () => [] };
    expect(startPathMismatchHint(flow('/login'), session)).toBeUndefined();
  });
});
