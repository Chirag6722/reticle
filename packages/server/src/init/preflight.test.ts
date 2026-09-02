import { describe, expect, it } from 'vitest';
import { preflightRefusal, type PreflightIo } from './preflight.js';

/**
 * Two conditions that make every later phase fail, checked before anything is written.
 *
 * Both were in setup/reticle.mjs and neither survived the port into `init`. Without them the
 * failures arrive far from their cause: EACCES as a stack trace at phase four, and `spawn pnpm
 * ENOENT` surfacing inside "the dev server exited" — which sends the reader into their own dev
 * script hunting a bug that is not there.
 */
const io = (over: Partial<PreflightIo> = {}): PreflightIo => ({
  cwd: () => '/app',
  canWrite: () => true,
  exists: () => false,
  probe: () => true,
  ...over,
});

describe('preflight refuses what cannot possibly work', () => {
  it('passes a writable project with the tools it names', () => {
    expect(preflightRefusal(io())).toBeUndefined();
  });

  it('names an unwritable checkout, and what setup needs to write', () => {
    const refusal = preflightRefusal(io({ canWrite: () => false }));
    expect(refusal).toContain('not writable');
    expect(refusal).toContain('/app');
  });

  // The lockfile says which package manager the PROJECT uses. It says nothing about whether the
  // machine has it, and a pnpm-lock.yaml on an npm-only box is an ordinary Monday.
  it('names a package manager the lockfile requires and the machine lacks', () => {
    const refusal = preflightRefusal(
      io({
        exists: (p) => 'pnpm-lock.yaml' === p,
        probe: (cmd) => 'pnpm' !== cmd,
      }),
    );
    expect(refusal).toContain('pnpm is not installed');
  });

  it('says nothing when the lockfile names one the machine has', () => {
    expect(preflightRefusal(io({ exists: (p) => 'pnpm-lock.yaml' === p }))).toBeUndefined();
  });

  it('recognises yarn and bun lockfiles too', () => {
    for (const [lock, pm] of [
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
    ] as const) {
      const refusal = preflightRefusal(
        io({ exists: (p) => lock === p, probe: (cmd) => pm !== cmd }),
      );
      expect(refusal).toContain(`${pm} is not installed`);
    }
  });

  // npm ships with node. Refusing for its absence would refuse on a machine that is fine.
  it('does not check for npm, which comes with node', () => {
    expect(preflightRefusal(io({ probe: () => false }))).toBeUndefined();
  });

  // Writability first: on a read-only checkout nothing else matters, and running a subprocess to
  // find that out is slower and noisier than one access check.
  it('reports unwritable before anything else', () => {
    const refusal = preflightRefusal(
      io({ canWrite: () => false, exists: (p) => 'pnpm-lock.yaml' === p, probe: () => false }),
    );
    expect(refusal).toContain('not writable');
  });

  // The recovery has to name a flag init actually has: it takes --url, never --dev-cmd.
  it('points at a flag that exists', () => {
    const refusal = preflightRefusal(
      io({ exists: (p) => 'pnpm-lock.yaml' === p, probe: (cmd) => 'pnpm' !== cmd }),
    );
    expect(refusal).toContain('--url');
    expect(refusal).not.toContain('--dev-cmd');
  });
});
