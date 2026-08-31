/**
 * The project-aware SDK remedy for version skew (#618).
 *
 * `sdkFix` in version-skew.ts is the no-project fallback: it names `@reticlehq/browser` and npm,
 * because those answers are never actively wrong. This module is what that fallback's comment used
 * to point at as if it existed — when a project directory IS in hand, name the packages actually
 * in package.json and the manager the lockfile implies.
 *
 * Detectors are reused, not copied: `reticleDepsOf` is what `reticle update` already reads,
 * `detect` / `detectPackageManager` / `installCommand` are what `init` already uses, and
 * `frameworkPackages` is the per-framework list whose own comment says installing the React kit
 * into a Vue codebase is the single thing most likely to make someone abandon the setup.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  detect,
  detectPackageManager,
  Framework,
  installCommand,
  PackageManager,
  UiLibrary,
  type DetectInput,
} from '../init/detect.js';
import { frameworkPackages } from '../init/plan.js';
import { reticleDepsOf } from '../update/sdk-sync.js';

/** What a project contributes to the remedy, when we were able to read one. */
export interface SdkFixContext {
  /** `@reticlehq/*` packages declared in package.json. Empty / omitted means none yet. */
  packages?: readonly string[];
  packageManager: PackageManager;
  framework?: Framework;
  uiLibrary?: UiLibrary;
}

/** Same package `frameworkPackages` picks for Nuxt — never the React kit. */
const FRAMEWORK_NEUTRAL_SDK = '@reticlehq/browser';
const PACKAGE_JSON = 'package.json';
const NODE_MODULES = 'node_modules';
const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'] as const;
const NODE_MODULES_MARKERS = ['.modules.yaml', '.yarn-state.yml', '.package-lock.json'] as const;

function packagesFor(ctx: Partial<SdkFixContext> | undefined): readonly string[] {
  if (ctx?.packages !== undefined && 0 !== ctx.packages.length) return ctx.packages;
  if (ctx === undefined) return [FRAMEWORK_NEUTRAL_SDK];
  if (
    ctx.framework === undefined ||
    (ctx.framework === Framework.HTML &&
      (ctx.uiLibrary === undefined || ctx.uiLibrary === UiLibrary.UNKNOWN))
  ) {
    return [FRAMEWORK_NEUTRAL_SDK];
  }
  return frameworkPackages(ctx.framework, ctx.uiLibrary ?? UiLibrary.UNKNOWN);
}

function restartClause(): string {
  return (
    'or run `reticle update`, then restart their dev server so the page reloads with it. The ' +
    'restart is not optional: a bundler keeps serving the pre-bundled copy it already has, so an ' +
    'upgrade can look applied — matching versions in `npm ls` — while the page runs the old module.'
  );
}

/**
 * The one sentence telling the human how to bring the page's SDK in line with this daemon.
 *
 * No context → the framework-neutral sensor and npm, never the React kit. Packages from
 * package.json win when present. When the project has none of ours yet, `frameworkPackages`
 * supplies the same list `init` would install, so a Nuxt app is never told to add `@reticlehq/react`.
 */
export function resolveSdkFix(daemonVersion: string, ctx?: Partial<SdkFixContext>): string {
  const pm = ctx?.packageManager ?? PackageManager.NPM;
  const pinned = packagesFor(ctx).map((name) => `${name}@${daemonVersion}`);
  return `Tell the human to install the matching SDK (\`${installCommand(pm, pinned)}\`) ${restartClause()}`;
}

/**
 * Read the context `resolveSdkFix` needs off a parsed manifest and the lockfiles/markers present.
 *
 * Undefined when there is no manifest to interpret — the caller then uses the no-project fallback.
 * Pure: no filesystem.
 */
export function sdkFixContextOf(
  pkgJson: unknown,
  lockfiles: ReadonlySet<string>,
  configFiles: ReadonlySet<string> = new Set(),
  nodeModulesMarkers: ReadonlySet<string> = new Set(),
): SdkFixContext | undefined {
  if ('object' !== typeof pkgJson || null === pkgJson) return undefined;
  const pkg = pkgJson as DetectInput['pkg'];
  const detection = detect({
    pkg,
    configFiles,
    lockfiles,
    nodeModulesMarkers,
  });
  return {
    packages: reticleDepsOf(pkgJson),
    packageManager: detectPackageManager(lockfiles, nodeModulesMarkers),
    framework: detection.framework,
    uiLibrary: detection.uiLibrary,
  };
}

/** Reads a file, or undefined if it is not there / not readable. */
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function present(
  directory: string,
  names: readonly string[],
  read: (path: string) => string | undefined,
  extra = '',
): Set<string> {
  const found = new Set<string>();
  for (const name of names) {
    if (read(join(directory, extra, name)) !== undefined) found.add(name);
  }
  return found;
}

/**
 * The remedy for the project in `directory`, or the no-project fallback when it cannot be read.
 *
 * `read` is injected so the decision is testable without a filesystem; the daemon uses the default.
 */
export function sdkFixForDirectory(
  daemonVersion: string,
  directory: string,
  read: (path: string) => string | undefined = readTextFile,
): string {
  const ctx = sdkFixContextOf(
    parseJson(read(join(directory, PACKAGE_JSON))),
    present(directory, LOCKFILE_NAMES, read),
    new Set(),
    present(directory, NODE_MODULES_MARKERS, read, NODE_MODULES),
  );
  return resolveSdkFix(daemonVersion, ctx);
}
