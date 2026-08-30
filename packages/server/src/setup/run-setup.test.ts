import { describe, expect, it } from 'vitest';
import { runSetupPhases, SetupPhase, type SetupEffects, type SetupInput } from './run-setup.js';
import { AppShape } from './desktop-shape.js';
import type { CandidateSession } from './session-pick.js';
import type { PageProbe } from './page-probe.js';

const INPUT: SetupInput = {
  appDir: '/app',
  devCommand: 'npm run dev',
  openBrowser: true,
  drive: true,
  shape: AppShape.WEB,
  phaseTimeoutMs: 1_000,
  pollMs: 1,
};

/** A world that behaves, with each part overridable to make exactly one thing go wrong. */
function world(
  over: Partial<SetupEffects> = {},
  opts: { url?: string } = {},
): SetupEffects & { opened: string[]; driven: number } {
  let clock = 0;
  const opened: string[] = [];
  const state = { driven: 0 };
  const url = opts.url ?? 'http://localhost:5173';
  const base: SetupEffects = {
    startDevServer: () => Promise.resolve(),
    devServerOutput: () => `  Local: ${url}`,
    devServerExited: () => false,
    devServerQuietForMs: () => 0,
    observedPorts: () => [],
    probePage: (): Promise<PageProbe> => Promise.resolve({ served: true, sdkInPage: true }),
    openBrowser: (u: string) => {
      opened.push(u);
      return Promise.resolve();
    },
    listSessions: (): Promise<CandidateSession[]> => Promise.resolve([{ sessionId: 'new', url }]),
    drive: () => {
      state.driven += 1;
      return Promise.resolve('Flow: checkout. verified: yes. assertions.grade: asserted');
    },
    flowsSaved: () => true,
    now: () => (clock += 10),
    sleep: () => Promise.resolve(),
    note: () => undefined,
    ...over,
  };
  return Object.assign(base, {
    opened,
    get driven() {
      return state.driven;
    },
  });
}

describe('the whole sequence, when everything works', () => {
  it('ends with a verdict and a saved flow', async () => {
    const r = await runSetupPhases(INPUT, world());
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.DONE);
    expect(r.flowSaved).toBe(true);
    expect(r.verdict).toContain('asserted');
    expect(r.fallback).toEqual([]);
  });

  it('opens the url the dev server announced, never one it composed', async () => {
    const fx = world({ devServerOutput: () => '  ➜  Local: http://127.0.0.1:4321/' });
    const r = await runSetupPhases(INPUT, fx);
    expect(fx.opened).toEqual(['http://127.0.0.1:4321']);
    expect(r.url).toBe('http://127.0.0.1:4321');
  });

  it('starts nothing when the caller says the app is already served', async () => {
    let started = false;
    const fx = world({
      startDevServer: () => {
        started = true;
        return Promise.resolve();
      },
    });
    await runSetupPhases({ ...INPUT, suppliedUrl: 'http://localhost:3000' }, fx);
    expect(started).toBe(false);
  });
});

describe('when it cannot continue, it says what is left', () => {
  // Writing files is not an install, so none of these may report ok.
  it('stops rather than inventing a dev command', async () => {
    const r = await runSetupPhases({ ...INPUT, devCommand: undefined }, world());
    expect(r.ok).toBe(false);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.fallback.join(' ')).toContain('dev script');
  });

  it('reports a dev server that exited without serving', async () => {
    const fx = world({
      devServerExited: () => true,
      probePage: () => Promise.resolve({ served: false, sdkInPage: false }),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.DEV_SERVER);
    expect(r.notes.join(' ')).toContain('exited');
  });

  // astro dev forks the real server and returns. serving outranks the launcher having exited.
  it('carries on when the launcher exited but the port answers', async () => {
    const fx = world({ devServerExited: () => true });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(true);
  });

  it('explains what the page looked like when nothing connected', async () => {
    const fx = world({
      listSessions: () => Promise.resolve([]),
      probePage: () => Promise.resolve({ served: true, sdkInPage: false }),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
    expect(r.notes.join(' ')).toContain('before the build config was edited');
    expect(r.fallback.join(' ')).toContain('reticle_sessions');
  });

  // The false green this guards: another tab on the same daemon is not this install.
  it("never accepts somebody else's session", async () => {
    const fx = world({
      listSessions: () => Promise.resolve([{ sessionId: 'other', url: 'http://localhost:9999/' }]),
    });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(false);
    expect(r.sessionId).toBeUndefined();
  });

  it('does not report success when the drive saved nothing', async () => {
    const fx = world({ flowsSaved: () => false });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.ok).toBe(false);
    expect(r.reachedPhase).toBe(SetupPhase.DRIVE);
    expect(r.fallback.join(' ')).toContain('asserted');
  });

  it('says plainly when no agent could drive', async () => {
    const fx = world({ drive: () => Promise.resolve(null), flowsSaved: () => false });
    const r = await runSetupPhases(INPUT, fx);
    expect(r.notes.join(' ')).toContain('nothing was proved');
  });
});

describe('a desktop app', () => {
  // The harmful one: the app's own window is the client, so a browser tab would be a SECOND session
  // that is not the app — the stale-tab false green, arranged deliberately.
  it('never opens a browser, even with openBrowser on', async () => {
    const fx = world();
    await runSetupPhases({ ...INPUT, shape: AppShape.TAURI, openBrowser: true }, fx);
    expect(fx.opened).toEqual([]);
  });

  // Tauri serves its webview from tauri://localhost. Nothing outside can fetch it, so waiting for an
  // HTTP response would fail an app that is running perfectly.
  it('does not require the url to answer before looking for a session', async () => {
    const fx = world({ probePage: () => Promise.resolve({ served: false, sdkInPage: false }) });
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.TAURI }, fx);
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.DONE);
  });

  it('says why there is no browser and why the wait is long', async () => {
    const fx = world();
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.ELECTRON }, fx);
    expect(r.notes.join(' ')).toContain('own window is the client');
  });

  // There is no page to describe when nothing outside the app can fetch it, so the advice has to be
  // desktop-shaped rather than "restart your dev server".
  it('gives desktop advice when nothing connects, not page advice', async () => {
    const fx = world({ listSessions: () => Promise.resolve([]) });
    const r = await runSetupPhases({ ...INPUT, shape: AppShape.TAURI, phaseTimeoutMs: 1 }, fx);
    expect(r.notes.join(' ')).toContain('preload');
    expect(r.notes.join(' ')).not.toContain('build config was edited');
  });
});

describe('opting out', () => {
  it('--no-drive stops at a connected session and calls that success', async () => {
    const fx = world();
    const r = await runSetupPhases({ ...INPUT, drive: false }, fx);
    expect(r.ok).toBe(true);
    expect(r.reachedPhase).toBe(SetupPhase.CONNECT);
    expect(fx.driven).toBe(0);
  });

  it('--no-open still requires something to connect', async () => {
    const fx = world({ listSessions: () => Promise.resolve([]) });
    const r = await runSetupPhases({ ...INPUT, openBrowser: false }, fx);
    expect(fx.opened).toEqual([]);
    expect(r.ok).toBe(false);
  });
});
