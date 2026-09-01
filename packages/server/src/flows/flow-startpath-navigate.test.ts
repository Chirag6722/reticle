/**
 * Replay's half of the FlowFile contract: `startPath` says replay navigates there before step 1.
 * These pin the navigate-then-replay behaviour — that replay dispatches the navigation itself,
 * continues on the session the SDK reconnects as, and degrades to the wrong-page hint (never a
 * hang, never someone else's tab) when arrival cannot be confirmed.
 */

import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  RETICLE_URL_PARAM,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { arriveAtStartPath } from './flow-replay-run.js';
import type { SessionManager } from '../session/session-manager.js';
import type { Session } from '../session/session.js';

const flow = (startPath?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'sign-in',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'submit' } }],
  ...(startPath === undefined ? {} : { startPath }),
});

interface NavCall {
  name: string;
  args: Record<string, unknown>;
}

/** A connected tab that accepts (or refuses) a NAVIGATE and records what it was sent. */
function tab(
  url: string | undefined,
  options: { accepted?: boolean } = {},
): {
  calls: NavCall[];
  session: {
    id: string;
    url?: string;
    eventsSince: () => never[];
    command: (name: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  };
} {
  const calls: NavCall[] = [];
  return {
    calls,
    session: {
      id: 'old',
      ...(url === undefined ? {} : { url }),
      eventsSince: () => [],
      command: (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        return Promise.resolve({
          kind: 'command_result',
          id: 'n',
          ok: true,
          result: { ok: options.accepted ?? true },
        } as CommandResult);
      },
    },
  };
}

/**
 * A manager whose `resolve('old')` answers from a script, one entry per look — mirroring the
 * tombstone rebind: first the still-registered old tab, later the successor on the new page.
 */
function manager(resolutionsOverTime: (Partial<Session> | undefined)[]): SessionManager {
  let look = 0;
  return {
    resolve: () => {
      const found = resolutionsOverTime[Math.min(look, resolutionsOverTime.length - 1)];
      look++;
      if (found === undefined) throw new Error('no connected session');
      return found as Session;
    },
  } as unknown as SessionManager;
}

/** A clock that advances only when slept on — deterministic and instant, as navigate-arrival's. */
function instantClock(step: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

const successor = (url: string): Partial<Session> => ({ id: 'fresh', url, eventsSince: () => [] });

describe('arriveAtStartPath — replay navigates to the flow start page before step 1', () => {
  it('dispatches the navigation and returns the session the SDK reconnects as', async () => {
    const { calls, session } = tab('http://localhost:3000/reset-password');
    const fresh = successor('http://localhost:3000/login');
    const sessions = manager([session, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
    expect(calls).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/login' } },
    ]);
  });

  it('does nothing when the tab already sits on the start page', async () => {
    const { calls, session } = tab('http://localhost:3000/login');
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('does nothing for a flow with no startPath (back-compat)', async () => {
    const { calls, session } = tab('http://localhost:3000/anywhere');
    const arrived = await arriveAtStartPath(manager([]), session, flow());
    expect(arrived).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('never navigates blind: an unobservable current route stays put', async () => {
    const { calls, session } = tab(undefined);
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('falls back (undefined) when the browser refuses the navigation', async () => {
    const { calls, session } = tab('http://localhost:3000/reset-password', { accepted: false });
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('gives up after the window rather than hanging when the SDK never reconnects', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    // resolve keeps answering the old tab, still on the old page — arrival never happens.
    const sessions = manager([session]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      500,
      instantClock(100),
    );
    expect(arrived).toBeUndefined();
  });

  it('keeps waiting through the teardown gap where the old id resolves to nothing yet', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    const fresh = successor('http://localhost:3000/login');
    const sessions = manager([session, undefined, undefined, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
  });

  it('carries a leased tab’s identity params so the navigation cannot strand the lease', async () => {
    const leased = `http://localhost:3000/?${RETICLE_URL_PARAM.SESSION}=lease-1`;
    const { calls, session } = tab(leased);
    const fresh = successor(`http://localhost:3000/checkout?${RETICLE_URL_PARAM.SESSION}=lease-1`);
    const sessions = manager([session, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/checkout'),
      5_000,
      instantClock(100),
    );
    expect(arrived).toBe(fresh);
    const sent = String(calls[0]?.args['url']);
    expect(sent).toContain('/checkout');
    expect(sent).toContain(`${RETICLE_URL_PARAM.SESSION}=lease-1`);
  });
});
