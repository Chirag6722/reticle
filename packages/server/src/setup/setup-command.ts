/**
 * The wire: everything init established, plus the world, plus the phases.
 *
 * Kept apart from cli.ts so the assembly is readable in one place and so `handleInit` stays the
 * three lines it was. The only decision here is which effects to hand over; the sequencing lives in
 * run-setup.ts and the pieces it calls.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openInBrowser } from '../cli/cli-launch.js';
import { chooseDriver, DRIVERS, shouldEscalate } from './drive-plan.js';
import { driveWith } from './drive-agent.js';
import {
  binaryExists,
  flowsSaved,
  listSessions,
  OwnedDevServer,
  probePage,
} from './node-effects.js';
import {
  runSetupPhases,
  type SetupEffects,
  type SetupInput,
  type SetupOutcome,
} from './run-setup.js';

/** The capabilities file init scaffolds, in the order a project is likely to have it. */
const CAPABILITY_FILES = ['reticle-dev.tsx', 'reticle-dev.ts', 'reticle-dev.jsx', 'reticle-dev.js'];

export interface SetupCommandInput extends SetupInput {
  /** Where setup was invoked, which is not the app directory in a monorepo. */
  readonly invokedAt: string;
  readonly bridgePort: number;
  readonly env: Readonly<Record<string, string>>;
  readonly flow?: string | undefined;
  readonly driveBudgetUsd: number;
  readonly driveModel?: string | undefined;
  readonly escalateWeakFlow: boolean;
}

export interface SetupCommandResult extends SetupOutcome {
  /** Set when a weak flow was re-recorded with the stronger model. */
  readonly escalated?: { readonly from: string; readonly to: string } | undefined;
  readonly driveTurns?: number | undefined;
  readonly driveCostUsd?: number | undefined;
}

/**
 * Run the phases against the real world.
 *
 * The dev server is stopped on every ending except success, where it is handed to the user: an
 * instrumented app they can watch is the deliverable, and killing it would leave them with config
 * files and a dead tab.
 */
export async function runSetupCommand(
  input: SetupCommandInput,
  print: (line: string) => void,
): Promise<SetupCommandResult> {
  const server = new OwnedDevServer();
  // Both roots, because in a monorepo `.reticle/` sits at the app root rather than where setup ran.
  const flowRoots = [input.invokedAt, input.appDir];
  let lastDrive: ReturnType<typeof driveWith> | undefined;
  let escalated: { from: string; to: string } | undefined;

  const effects: SetupEffects = {
    startDevServer: (command, cwd) => {
      print(`starting: ${command}`);
      server.start(command, cwd, input.env);
      return Promise.resolve();
    },
    devServerOutput: () => server.output(),
    devServerExited: () => server.exited(),
    devServerQuietForMs: () => server.quietForMs(),
    observedPorts: () => server.listeningPorts(),
    probePage,
    openBrowser: async (url) => {
      const failure = await openInBrowser(url);
      if (null !== failure) {
        print(
          `could not open a browser (${failure}). On a machine with none — CI, a container, an SSH ` +
            'session — take a tab Reticle owns instead: reticle_run({ tool: "reticle_lease", args: ' +
            `{ action: "acquire", url: "${url}" } }).`,
        );
      }
    },
    listSessions: () => listSessions(input.bridgePort),
    drive: (url, session) => {
      const driver = chooseDriver(DRIVERS, (bin) => ({
        present: binaryExists(bin),
        // Present is not enough: a CLI that does not run produces an empty session that looks
        // exactly like success.
        runs: binaryExists(bin),
      }));
      if (null === driver) return Promise.resolve(null);
      // Only when the SESSION says they were never finished. init fills this file for a
      // conventional app — it detects a state library and the testids — so opening it otherwise
      // spends a turn on work already done, and grants write access nobody needed.
      const capabilitiesFile =
        false === session.hasCapabilities
          ? CAPABILITY_FILES.map((f) => join(input.appDir, 'src', f)).find((p) => existsSync(p))
          : undefined;
      print('');
      print(
        `  ▸ WATCH ${url} NOW — the HUD is on, and you are about to see Reticle drive your app.`,
      );
      print('');
      const request = {
        url,
        sessionId: session.sessionId,
        tabThrottled: false,
        budgetUsd: input.driveBudgetUsd,
        ...(undefined === input.flow ? {} : { flow: input.flow }),
        ...(undefined === input.driveModel ? {} : { model: input.driveModel }),
        ...(undefined === capabilitiesFile ? {} : { unfinishedCapabilitiesFile: capabilitiesFile }),
      };
      lastDrive = driveWith(driver, request, input.appDir);

      // A weak flow only ACTS, so it passes when the feature is broken — and setup replays saved
      // flows, which turns one weak recording into a permanent green. Re-record it rather than
      // hand the trade to the user.
      if (
        shouldEscalate({
          escalationEnabled: input.escalateWeakFlow,
          fasterModel: input.driveModel,
          flowSaved: flowsSaved(flowRoots),
          ...(undefined === lastDrive.grade ? { grade: undefined } : { grade: lastDrive.grade }),
        })
      ) {
        print(
          `the saved flow graded \`${lastDrive.grade ?? 'unknown'}\` — re-recording with the default model`,
        );
        const stronger = driveWith(driver, { ...request, model: undefined }, input.appDir);
        escalated = { from: lastDrive.grade ?? 'unknown', to: stronger.grade ?? 'unknown' };
        if (undefined !== stronger.grade) lastDrive = stronger;
      }
      if (undefined !== lastDrive.incomplete) {
        print(`the drive did not finish, and ${lastDrive.incomplete}`);
      }
      return Promise.resolve('' === lastDrive.text ? null : lastDrive.text);
    },
    flowsSaved: () => flowsSaved(flowRoots),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    note: print,
  };

  try {
    const outcome = await runSetupPhases(input, effects);
    // The app stays up only when there is something worth watching.
    if (outcome.ok) server.handOver();
    return {
      ...outcome,
      ...(undefined === escalated ? {} : { escalated }),
      ...(undefined === lastDrive?.turns ? {} : { driveTurns: lastDrive.turns }),
      ...(undefined === lastDrive?.costUsd ? {} : { driveCostUsd: lastDrive.costUsd }),
    };
  } finally {
    server.stop();
  }
}
