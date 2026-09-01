import { describe, expect, it } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { BUFFER_EVICTION_WARNING, SessionState, Verified, VerifiedReason } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * The worst answer a verification layer can give is a confident green that rests on evidence it no
 * longer has. `reticle_assert { kind:'console', absent:true }` concludes "no errors" from the ring
 * buffer — which evicts on an age and size cap — so on a flow longer than the buffer's window, an
 * error logged early is gone by the time the assertion runs, and the verdict is `pass:true`.
 *
 * reticle_console has always disclosed this for the same window. The verdict path, which is the one
 * an agent actually gates on, did not. These tests pin the disclosure onto the verdict.
 *
 * The block stays OMITTED when nothing was dropped: silence has to keep meaning "the buffer was
 * intact", or it becomes noise on every healthy call and gets ignored.
 */
function depsWithBuffer(dropped: number, lastActSource?: string, lost = false): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    recordAction: () => 'a1',
    lastAct: ((): LastAct => {
      const a = new LastAct();
      a.markSource(lastActSource);
      return a;
    })(),
    bufferHealth: () => ({ total: 12, dropped }),
    lostSince: () => lost,
    blindSpots: () => ({}),
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    elapsed: () => 1000,
    throttled: () => false,
    health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

const absentConsole = {
  predicate: { kind: 'console', level: 'error', absent: true },
  timeout_ms: 0,
};

describe('a verdict reached over an evicted buffer says so', () => {
  it('reticle_assert discloses eviction on a PASSING absence assertion', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(7), absentConsole)) as {
      pass: boolean;
      buffer?: { dropped: number; note: string };
    };
    expect(result.pass).toBe(true);
    expect(result.buffer?.dropped).toBe(7);
    expect(result.buffer?.note).toBe(BUFFER_EVICTION_WARNING);
  });

  it('stays silent when the buffer is intact — silence must keep meaning trustworthy', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(0), absentConsole)) as {
      pass: boolean;
      buffer?: unknown;
    };
    expect(result.pass).toBe(true);
    expect(result.buffer).toBeUndefined();
  });

  it('declares buffer in its output schema, or a strict client never sees it', () => {
    for (const name of [ReticleTool.ASSERT, ReticleTool.WAIT_FOR]) {
      expect(Object.keys(tool(name).outputSchema ?? {})).toContain('buffer');
    }
  });
});

/**
 * A failure with no ELEMENT still has a place to send the agent.
 *
 * "the signal never fired", "the request was never made", "the store did not change" have no DOM node
 * to map to a component — so the file:line work that covers element failures leaves exactly the
 * failures that most need explaining with no destination. But the handler that should have fired the
 * signal lives with the control that was clicked, and the act path already captures that control's
 * source. Carrying it onto the verdict turns "nothing happened" into "nothing happened, and the code
 * that should have made it happen is here".
 *
 * Only on RED, and only when an act actually preceded the assertion.
 */
describe('a non-element failure still names a file', () => {
  const missingSignal = {
    predicate: { kind: 'signal', name: 'compose:generated' },
    timeout_ms: 0,
  };

  it("attaches the last acted control's source to a failing signal assertion", async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, 'src/views/Compose.tsx:60'),
      missingSignal,
    )) as { pass: boolean; source?: string };
    expect(result.pass).toBe(false);
    expect(result.source).toBe('src/views/Compose.tsx:60');
  });

  it('does not attach it to a PASSING assertion', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, 'src/views/Compose.tsx:60'),
      { predicate: { kind: 'console', level: 'error', absent: true }, timeout_ms: 0 },
    )) as { pass: boolean; source?: string };
    expect(result.pass).toBe(true);
    expect(result.source).toBeUndefined();
  });

  it('says nothing when no act preceded the assertion', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(depsWithBuffer(0), missingSignal)) as {
      pass: boolean;
      source?: string;
    };
    expect(result.pass).toBe(false);
    expect(result.source).toBeUndefined();
  });
});

/**
 * The `buffer` block above discloses the RAW drop counter, and ring-buffer.ts says in as many words
 * that the counter cannot answer "was the capture clean": it moves for the age eviction that runs on
 * every push and for the churn floor that is sacrificed on purpose. `lostSince` is the honest input —
 * did this buffer evict SCARCE evidence belonging to the window opened at `since`.
 *
 * act_and_wait passes it as `truncated`, and `decideVerified` turns a dirty capture into UNKNOWN /
 * unclean_capture, because the evidence is ABSENT rather than negative. reticle_assert never consulted
 * it, on the reasoning that it "observes an already-open window" — but eviction happens on push,
 * regardless of who opened the window, and assert reads the same buffer over an arbitrary `since`.
 *
 * So the same loss in the same window returned `unknown` through one half of the verdict surface and
 * `yes` through the other — and assert is the half agents call most. An absence assertion is where it
 * bites hardest: the evicted error is exactly the evidence that would have made it fail.
 */
describe('assert does not grade a window the buffer lost evidence from', () => {
  it('refuses a green when scarce evidence from this window was evicted', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, true),
      absentConsole,
    )) as { verified?: string; verifiedReason?: string };
    expect(result.verified).toBe(Verified.UNKNOWN);
    expect(result.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('still grades normally when the window is intact', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(0, undefined, false),
      absentConsole,
    )) as { verified?: string; verifiedReason?: string };
    expect(result.verified).not.toBe(Verified.UNKNOWN);
  });

  // The counter moving is NOT loss from this window — that conflation is what made unclean_capture
  // the dominant cause of unknown in the field once already.
  it('a moving drop counter alone does not impeach the verdict', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithBuffer(7, undefined, false),
      absentConsole,
    )) as { verified?: string };
    expect(result.verified).not.toBe(Verified.UNKNOWN);
  });
});
