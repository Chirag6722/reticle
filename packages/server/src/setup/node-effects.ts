/**
 * The real world, bound to the injected shape `runSetupPhases` expects.
 *
 * Everything here is a thin binding to something that already exists — `openInBrowser`,
 * `fetchStatus`, the driver table — with one exception: the dev server. Nothing else in the package
 * owns a spawned process, and owning one properly is most of this file.
 *
 * The promise this makes about that process: setup leaves it running on success, because an
 * instrumented app the user can watch IS the deliverable, and stops it on every other ending. A
 * server nobody started, holding a port nobody can account for, surviving the terminal that spawned
 * it, is the failure this file exists to avoid — measured, an interrupted run used to leave one
 * listening indefinitely.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchStatus } from '../cli/cli-launch.js';
import {
  descendants,
  parseLsofPorts,
  parseNetstatListeners,
  parseWmicProcesses,
} from './listeners.js';
import type { CandidateSession } from './session-pick.js';
import type { PageProbe } from './page-probe.js';

const WINDOWS = 'win32' === process.platform;
/** A page fetch that is slow is a page fetch that failed, for our purposes. */
const PROBE_TIMEOUT_MS = 5_000;

/** The dev server this process started, and the only one it will ever stop. */
export class OwnedDevServer {
  private child: ChildProcess | undefined;
  private buffer = '';
  private lastOutputAt = Date.now();
  private handedOver = false;

  start(command: string, cwd: string, env: Readonly<Record<string, string>>): void {
    const child = spawn(command, {
      cwd,
      shell: true,
      // Its own process group, so stopping it stops what it started rather than only the wrapper.
      detached: !WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const collect = (chunk: Buffer | string): void => {
      this.buffer += String(chunk);
      this.lastOutputAt = Date.now();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    this.child = child;
  }

  output(): string {
    return this.buffer;
  }

  exited(): boolean {
    return undefined !== this.child && null !== this.child.exitCode;
  }

  quietForMs(): number {
    return Date.now() - this.lastOutputAt;
  }

  /** Ports anything in this server's process tree is listening on. */
  listeningPorts(): number[] {
    const pid = this.child?.pid;
    if (undefined === pid) return [];
    if (WINDOWS) {
      const tree = new Set(
        descendants(
          parseWmicProcesses(run('wmic', ['process', 'get', 'ParentProcessId,ProcessId'])),
          pid,
        ),
      );
      return [
        ...new Set(
          parseNetstatListeners(run('netstat', ['-ano']))
            .filter((r) => tree.has(r.pid))
            .map((r) => r.port),
        ),
      ];
    }
    const pids = run('sh', ['-c', `ps -o pid= -g ${pid} 2>/dev/null | tr -d ' '`])
      .split('\n')
      .filter(Boolean);
    if (0 === pids.length) return [];
    return parseLsofPorts(
      run('sh', [
        '-c',
        `lsof -a -p ${pids.join(',')} -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1{print $9}'`,
      ]),
    );
  }

  /** Hand the running server to the user. After this, `stop()` does nothing. */
  handOver(): void {
    this.handedOver = true;
    this.child?.unref();
  }

  stop(): void {
    const child = this.child;
    if (this.handedOver || undefined === child?.pid) return;
    if (WINDOWS) run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }
    this.child = undefined;
  }
}

function run(file: string, args: string[]): string {
  const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return r.stdout ?? '';
}

/**
 * Fetch the page and say what came back.
 *
 * A refused certificate is reported separately because the server ANSWERED: a self-signed dev cert
 * is an ordinary local setup, and calling it "nothing is listening" sends somebody to start a
 * server that is already running.
 */
export async function probePage(url: string): Promise<PageProbe> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.text();
    return { served: true, sdkInPage: /@reticlehq|@reticle-connect|reticle-dev/.test(body) };
  } catch (err) {
    const message = String(
      (err as { cause?: { message?: string }; message?: string })?.cause?.message ??
        (err as Error)?.message ??
        '',
    );
    const tlsRefused = /certificate|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|unable to verify/i.test(message);
    return { served: false, sdkInPage: false, tlsRefused };
  }
}

/** Sessions the daemon is holding, in the shape the picker reads. */
export async function listSessions(port: number): Promise<CandidateSession[]> {
  try {
    const payload = await fetchStatus(port);
    const sessions = (payload as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) ? (sessions as CandidateSession[]) : [];
  } catch {
    return [];
  }
}

/** Whether this project has a saved flow, wherever the project keeps one. */
export function flowsSaved(roots: readonly string[]): boolean {
  for (const root of roots) {
    try {
      if (0 < readdirSync(join(root, '.reticle', 'flows')).length) return true;
    } catch {
      /* no flows kept there */
    }
  }
  return false;
}

/** On PATH at all. The separate question of whether it RUNS is asked by chooseDriver. */
export function binaryExists(bin: string): boolean {
  return 0 === spawnSync(WINDOWS ? 'where' : 'which', [bin], { stdio: 'ignore' }).status;
}

/** Whether a directory looks like a project setup has already wired. */
export function alreadyWired(dir: string): boolean {
  return existsSync(join(dir, '.reticle.json'));
}
