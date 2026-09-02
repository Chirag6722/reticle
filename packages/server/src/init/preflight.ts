/**
 * The two conditions that make every later phase fail, checked before anything is written.
 *
 * Both lived in setup/reticle.mjs and neither survived the port into `init`. What they buy is the
 * distance between a failure and its cause: without them, an unwritable checkout arrives as EACCES
 * in a stack trace at phase four, and a missing package manager arrives as `spawn pnpm ENOENT`
 * inside "the dev server exited" — which sends the reader into their own dev script hunting a bug
 * that is not there.
 */

/** The parts of the environment preflight reads, so the rules are testable without a filesystem. */
export interface PreflightIo {
  /** Absolute path of the directory init is running in. */
  cwd(): string;
  /** Can this process write into the project root. */
  canWrite(): boolean;
  /** Is this basename present in the project root. */
  exists(name: string): boolean;
  /** Runs a command quietly for a yes/no check; true on exit code 0. */
  probe(command: string, args: readonly string[]): boolean;
}

/**
 * The package manager a lockfile commits the project to, and never `npm`.
 *
 * npm ships with node, so refusing for its absence would refuse on a machine that is fine — and the
 * absence of any lockfile means nothing has been committed to.
 */
const LOCKFILES = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
] as const;

/** The refusal to print, or undefined when this machine can run the install. */
export function preflightRefusal(io: PreflightIo): string | undefined {
  // First: on a read-only checkout nothing else matters, and one access check is cheaper and
  // quieter than spawning a subprocess to discover the same thing.
  if (!io.canWrite()) {
    return (
      `${io.cwd()} is not writable, and init has to write into it (.reticle.json, the build config, ` +
      'a capabilities file). Fix the permissions, or run init from a checkout you own.'
    );
  }
  for (const { file, pm } of LOCKFILES) {
    // The lockfile says what the PROJECT uses. It says nothing about what the machine has, and a
    // pnpm-lock.yaml on an npm-only box is an ordinary Monday.
    if (io.exists(file) && !io.probe(pm, ['--version'])) {
      return (
        `this project uses ${pm} (its lockfile says so) and ${pm} is not installed on this machine. ` +
        `Install it (npm i -g ${pm}, or corepack enable), or pass --url with the address the app ` +
        'already serves.'
      );
    }
  }
  return undefined;
}
