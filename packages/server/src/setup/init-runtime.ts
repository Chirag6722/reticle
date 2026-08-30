/**
 * What `init` does after the files are written, and how it decides whether to.
 *
 * Lives here rather than in cli.ts because it is a cohesive unit with its own reasons, and because
 * cli.ts is a dispatcher: a command that grew a second half should not make the file that routes
 * every command harder to read.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import type { InitResult } from '../init/run.js';
import { confirmInstall, nodeConfirmDeps } from '../init/confirm.js';
import { writeLicenseKey } from './license-key.js';
import { runSetupCommand } from './setup-command.js';
import { collectEnv, DEFAULT_DRIVE_BUDGET_USD, DEFAULT_PHASE_TIMEOUT_MS } from './setup-options.js';

/** How often the runtime phases look again: fast enough not to be the wait, slow enough to be free. */
const POLL_MS = 250;

/** Just enough of the parsed command to decide and run. */
export interface InitRuntimeArgs {
  readonly port: number | undefined;
  readonly dryRun: boolean;
  readonly filesOnly?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly drive?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly agents?: boolean | undefined;
  readonly flow?: string | undefined;
  readonly env?: string[] | undefined;
  readonly url?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly driveModel?: string | undefined;
  readonly licenseKey?: string | undefined;
}

export interface RuntimePrintIo {
  readonly print: (line: string) => void;
}

const licenseIo = {
  exists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string => readFileSync(path, 'utf8'),
  writeFile: (path: string, contents: string): void => writeFileSync(path, contents),
};

/**
 * Carry on from a finished `init`, or stop where it used to.
 *
 * `--files-only` is what init did before it learned to boot the app, and a dry run is a preview:
 * both keep the old ending. Everyone else gets the rest, because writing files was never the same
 * thing as an install working.
 */
export function continueAfterInit(
  parsed: InitRuntimeArgs,
  result: InitResult,
  io: RuntimePrintIo,
  cwd: string,
): Promise<void> {
  const port = parsed.port ?? RETICLE_DEFAULT_PORT;

  // Before anything else: the key belongs in .env whichever way this run ends, and the CLI folds a
  // project-local .env into the environment on every invocation.
  if (undefined !== parsed.licenseKey) {
    const written = writeLicenseKey(cwd, parsed.licenseKey, licenseIo);
    io.print(written.message);
  }

  if (true === parsed.filesOnly || parsed.dryRun) {
    return confirmInstall(result, io, nodeConfirmDeps(port)).then(() => {
      if (!result.ok) process.exit(1);
    });
  }

  const context = result.context;
  if (!result.ok || context === undefined) {
    // Nothing was established, so there is nothing to run against. init has already said why.
    process.exit(1);
  }

  return runSetupCommand(
    {
      appDir: context.appDir,
      invokedAt: cwd,
      bridgePort: port,
      env: collectEnv(parsed.env ?? []),
      openBrowser: false !== parsed.open,
      drive: false !== parsed.drive,
      registerAgents: false !== parsed.agents,
      escalateWeakFlow: true,
      driveBudgetUsd: DEFAULT_DRIVE_BUDGET_USD,
      phaseTimeoutMs:
        undefined === parsed.timeoutSeconds
          ? DEFAULT_PHASE_TIMEOUT_MS
          : parsed.timeoutSeconds * 1000,
      pollMs: POLL_MS,
      ...(undefined === context.devCommand ? {} : { devCommand: context.devCommand }),
      ...(undefined === parsed.flow ? {} : { flow: parsed.flow }),
      ...(undefined === parsed.url ? {} : { suppliedUrl: parsed.url }),
      ...(undefined === parsed.driveModel ? {} : { driveModel: parsed.driveModel }),
    },
    (line) => io.print(line),
  ).then((outcome) => {
    // One object, so an agent reads a result instead of interpreting a report.
    if (true === parsed.json) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      if (!outcome.ok) process.exit(1);
      return;
    }
    io.print('');
    // The drive's own account, whether it ended well or not. Discarding it left a run that reached
    // the drive, produced something, and told the reader nothing about what it found.
    if (undefined !== outcome.verdict && '' !== outcome.verdict) {
      io.print(outcome.verdict);
      io.print('');
    }
    if (outcome.ok) {
      io.print(
        `✓ setup complete — ${outcome.url ?? 'the app'} is instrumented and a flow was driven.`,
      );
      // A passing flow shows the mechanism working. What the run SAW is the part nobody can get for
      // themselves, and it deserves a line of its own rather than a paragraph that gets skimmed.
      io.print(
        '  Read the FINDINGS above before moving on: a flow can pass with a failed request or a ' +
          'console error behind it, and that is the app, not the check.',
      );
      return;
    }
    // A run that produced no verdict did not succeed, and the exit code is the one place a caller
    // reads that without parsing anything.
    io.print('⚠ setup did not finish. To carry on from here:');
    for (const [i, step] of outcome.fallback.entries()) io.print(`   ${i + 1}. ${step}`);
    process.exit(1);
  });
}
