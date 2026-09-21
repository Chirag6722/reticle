#!/usr/bin/env node
/**
 * Rebase a pull request written against the old `packages/*` layout onto the current tree.
 *
 * The v3 restructure moved every package directory and deleted `packages/`, which put 40 of 55 open
 * pull requests into conflict against a path that no longer exists (#979). Git knows where every
 * file went — `git diff -M` pairs each old path with its new one — so recovering a branch is a
 * lookup against THAT, per pull request, from the base the branch actually forked from: rewrite the
 * paths in each commit's patch headers, replay onto `main`, force-push the contributor's branch.
 *
 * It rewrites PATCH HEADERS ONLY — never a `+`/`-` content line. A relative import or a workspace
 * path inside a file is a source change that belongs to whoever reviews the PR; rewriting it here
 * would silently edit a contributor's code under their name.
 *
 * Dry run by default. `--apply` force-pushes, and is the only destructive mode. `--self-test` proves
 * the rewrite on a synthetic patch and on the two incident files below, and touches no branch.
 *
 * Incidents:
 *   - the v3 restructure (5d475e05) stranded 40 open PRs the day it shipped; none had been rebased
 *     four days later, and the contributors had no way to know why their branch went red.
 *   - the first version of this script mapped package ROOTS with a twelve-entry table
 *     (`packages/server/` → `server/`), but the move was two levels deep: `server/src/session/`
 *     became `server/src/portal/session/`, `server/src/events/` was split across three directories
 *     in the new `engine` package, and so on. Measured against git's own rename detection, 1078 of
 *     1402 renamed source files landed on a path that did not exist, and `git am` counted every
 *     one as "a real conflict with work landed since" (#1033). The table is gone; git is asked.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The patch lines that carry a path. Anything else is content and is left exactly as the author
 * wrote it — the distinction is the whole safety property of this script.
 */
const PATH_LINE =
  /^(diff --git |--- |\+\+\+ |rename from |rename to |copy from |copy to |Binary files )/;

const DEV_NULL = '/dev/null';

const git = (args, opts = {}) =>
  // `?? ''`: a command whose stdout is not piped returns null, and `.trim()` on that used to throw
  // from inside the `am --abort` recovery path, replacing every real conflict message with a
  // TypeError. An error handler that cannot report is worse than no error handler.
  (
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ??
    ''
  ).trim();

/** Best-effort cleanup: a failure here must never replace the failure we are reporting. */
const gitQuietly = (args, opts = {}) => {
  try {
    execFileSync('git', args, { stdio: 'ignore', ...opts });
  } catch {
    /* the caller is already on an error path */
  }
};

/**
 * Where every renamed file went between `base` and `origin/main`, as git sees it.
 *
 * No pathspec, on purpose: a pathspec limits the diff to paths that exist on ONE side, which stops
 * git pairing an old path with its new one, and the rename comes back as a delete plus an add.
 * Similarity is left at git's default; the lineage file in #1033 paired at 97%, and a branch that
 * edited a file heavily enough to drop below the default has a real conflict to report anyway.
 */
export function renamedFiles(base, cwd) {
  const out = git(['diff', '-M', '--diff-filter=R', '--name-status', base, 'origin/main'], { cwd });
  const files = new Map();
  for (const line of out.split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status !== undefined && status.startsWith('R') && from !== undefined && to !== undefined) {
      files.set(from, to);
    }
  }
  return files;
}

/**
 * The directory moves the file renames imply, for the one case a file-level map cannot answer: a
 * file the pull request ADDS under an old directory. It has no rename row of its own, so it follows
 * the directory it was written into.
 *
 * A directory that was SPLIT — `server/src/events/` went to three places — maps to the destination
 * that took most of its files, and the caller is told how many paths were placed that way, because
 * a guess that is not announced is the failure this script exists to end.
 */
export function movedDirectories(files) {
  const tally = new Map();
  for (const [from, to] of files) {
    const oldDir = dirname(from);
    const newDir = dirname(to);
    if (oldDir === newDir) continue;
    const dests = tally.get(oldDir) ?? new Map();
    dests.set(newDir, (dests.get(newDir) ?? 0) + 1);
    tally.set(oldDir, dests);
  }
  const dirs = new Map();
  for (const [oldDir, dests] of tally) {
    const ranked = [...dests.entries()].sort((a, b) => b[1] - a[1]);
    const [best] = ranked;
    if (best === undefined) continue;
    dirs.set(oldDir, { to: best[0], split: ranked.length > 1 });
  }
  return dirs;
}

/**
 * One path, mapped. An exact rename wins; otherwise the nearest moved ancestor directory carries the
 * file with it; otherwise the path is left alone. Reports whether a split directory decided it.
 */
export function remapPath(path, files, dirs) {
  const exact = files.get(path);
  if (exact !== undefined) return { path: exact, guessed: false };
  let dir = dirname(path);
  while ('.' !== dir && '' !== dir && '/' !== dir) {
    const moved = dirs.get(dir);
    if (moved !== undefined) {
      return { path: `${moved.to}/${path.slice(dir.length + 1)}`, guessed: moved.split };
    }
    dir = dirname(dir);
  }
  return { path, guessed: false };
}

/** Rewrite the paths in one patch HEADER line. Content lines never reach this. */
export function remapHeader(line, mapPath) {
  const sub = (p) => (p === DEV_NULL ? p : mapPath(p));
  const diffGit = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (diffGit !== null) return `diff --git a/${sub(diffGit[1])} b/${sub(diffGit[2])}`;
  const marker = /^(---|\+\+\+) (a\/|b\/)?(.+)$/.exec(line);
  if (marker !== null) {
    const [, sign, side, p] = marker;
    return p === DEV_NULL ? line : `${sign} ${side ?? ''}${sub(p)}`;
  }
  const renameCopy = /^(rename|copy) (from|to) (.+)$/.exec(line);
  if (renameCopy !== null) return `${renameCopy[1]} ${renameCopy[2]} ${sub(renameCopy[3])}`;
  const binary = /^Binary files a\/(.+) and b\/(.+) differ$/.exec(line);
  if (binary !== null) return `Binary files a/${sub(binary[1])} and b/${sub(binary[2])} differ`;
  return line;
}

/**
 * Rewrite every moved path in one patch file's headers. Returns how many header lines changed and
 * how many of those were placed by a split directory.
 */
export function remapPatch(file, files, dirs) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = 0;
  let guessed = 0;
  const out = lines.map((line) => {
    if (!PATH_LINE.test(line)) return line;
    const next = remapHeader(line, (p) => {
      const r = remapPath(p, files, dirs);
      if (r.guessed) guessed += 1;
      return r.path;
    });
    if (next !== line) changed += 1;
    return next;
  });
  if (changed > 0) writeFileSync(file, out.join('\n'));
  return { changed, guessed };
}

/**
 * The files `git am` stopped on, read while the failed patch is still applied. `--diff-filter=U`
 * is the unmerged set; a patch that failed to apply at all (no base blob, a path that does not
 * exist) leaves nothing unmerged, and then the caller falls back to git's own message.
 */
function conflictedFiles(worktree) {
  try {
    const out = git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree });
    return out.length > 0 ? out.split('\n') : [];
  } catch {
    return [];
  }
}

function rescue(pr, { apply, worktree }) {
  const head = JSON.parse(
    execFileSync(
      'gh',
      ['pr', 'view', String(pr), '--json', 'headRefName,headRepositoryOwner,maintainerCanModify'],
      { encoding: 'utf8' },
    ),
  );
  const { headRefName: ref, maintainerCanModify: mayPush } = head;
  const owner = head.headRepositoryOwner.login;
  const remote = `https://github.com/${owner}/reticle.git`;

  git(['fetch', '--quiet', remote, `${ref}:refs/remap/${pr}`], { cwd: worktree });
  const base = git(['merge-base', 'origin/main', `refs/remap/${pr}`], { cwd: worktree });

  // Asked from THIS branch's base, not a fixed commit: two stranded branches can fork from different
  // points on the old main, and a file renamed after the earlier fork is a rename for one and not
  // for the other.
  const files = renamedFiles(base, worktree);
  const dirs = movedDirectories(files);

  const patches = mkdtempSync(join(tmpdir(), `remap-${pr}-`));
  git(['format-patch', '--quiet', '-o', patches, `${base}..refs/remap/${pr}`], { cwd: worktree });
  const patchFiles = readdirSync(patches)
    .sort()
    .map((f) => join(patches, f));
  if (0 === patchFiles.length) return { pr, status: 'nothing-to-replay' };

  let remapped = 0;
  let guessed = 0;
  for (const f of patchFiles) {
    const r = remapPatch(f, files, dirs);
    remapped += r.changed;
    guessed += r.guessed;
  }

  git(['checkout', '--quiet', '-B', `remap/${pr}`, 'origin/main'], { cwd: worktree });
  try {
    git(['am', '--3way', '--quiet', ...patchFiles], { cwd: worktree });
  } catch (err) {
    // With the paths right, a conflict here IS a real conflict with work landed since. Those need
    // a human — and the human is told WHICH files, because "Failed to merge in the changes" cannot
    // distinguish a changelog clash (five of the six remaining, see #1007) from anything else.
    const conflicted = conflictedFiles(worktree);
    gitQuietly(['am', '--abort'], { cwd: worktree });
    return {
      pr,
      owner,
      ref,
      status: 'needs-human',
      commits: patchFiles.length,
      remapped,
      guessed,
      detail:
        conflicted.length > 0
          ? `conflict in ${conflicted.join(', ')}`
          : String(err.stderr ?? err.message).slice(0, 200),
    };
  }

  const done = { pr, owner, ref, commits: patchFiles.length, remapped, guessed };
  if (!apply) return { ...done, status: 'clean' };
  if (!mayPush) return { ...done, status: 'no-push-permission' };
  git(['push', '--force-with-lease', remote, `remap/${pr}:${ref}`], { cwd: worktree });
  return { ...done, status: 'pushed' };
}

/**
 * The negative control, run before trusting a dry run: a synthetic map and a synthetic patch, so
 * the rewrite is checked on every header shape and on the one line it must never touch — and then
 * the real map from the last 2.x main, on the two files #1033 was filed about.
 */
function selfTest() {
  const failures = [];
  const check = (name, got, want) => {
    if (got !== want) failures.push(`${name}\n    got:  ${got}\n    want: ${want}`);
  };

  const files = new Map([
    [
      'packages/server/src/session/no-session-watch.ts',
      'server/src/portal/session/no-session-watch.ts',
    ],
    ['packages/server/src/session/session.ts', 'server/src/portal/session/session.ts'],
    ['packages/server/src/events/a.ts', 'engine/src/question/a.ts'],
    ['packages/server/src/events/b.ts', 'engine/src/question/b.ts'],
    ['packages/server/src/events/c.ts', 'engine/src/disagreement/c.ts'],
    ['packages/server/package.json', 'server/package.json'],
  ]);
  const dirs = movedDirectories(files);
  const map = (p) => remapPath(p, files, dirs);

  // The incident: a file under a re-homed directory lands where git says, not one level up.
  check(
    'exact rename',
    map('packages/server/src/session/no-session-watch.ts').path,
    'server/src/portal/session/no-session-watch.ts',
  );
  // A file the PR ADDS under a moved directory follows the directory.
  check(
    'added file follows its directory',
    map('packages/server/src/session/route-status-probe.ts').path,
    'server/src/portal/session/route-status-probe.ts',
  );
  // …including into a subdirectory the PR itself creates.
  check(
    'added file in a new subdirectory',
    map('packages/server/src/session/dev-server/probe.ts').path,
    'server/src/portal/session/dev-server/probe.ts',
  );
  // A split directory places by majority and says so.
  const split = map('packages/server/src/events/new.ts');
  check('split directory: majority destination', split.path, 'engine/src/question/new.ts');
  check('split directory: reported as a guess', String(split.guessed), 'true');
  check(
    'unsplit directory: not a guess',
    String(map('packages/server/src/session/x.ts').guessed),
    'false',
  );
  // A path nothing moved is left alone.
  check('untouched path', map('apps/bench-app/src/App.tsx').path, 'apps/bench-app/src/App.tsx');

  // Every header shape, and the two lines that must not change.
  const h = (line) => remapHeader(line, (p) => map(p).path);
  check(
    'diff --git',
    h(
      'diff --git a/packages/server/src/session/session.ts b/packages/server/src/session/session.ts',
    ),
    'diff --git a/server/src/portal/session/session.ts b/server/src/portal/session/session.ts',
  );
  check(
    '--- a/',
    h('--- a/packages/server/src/session/session.ts'),
    '--- a/server/src/portal/session/session.ts',
  );
  check(
    '+++ b/',
    h('+++ b/packages/server/src/session/session.ts'),
    '+++ b/server/src/portal/session/session.ts',
  );
  check('--- /dev/null stays', h('--- /dev/null'), '--- /dev/null');
  check(
    'rename to',
    h('rename to packages/server/src/session/session.ts'),
    'rename to server/src/portal/session/session.ts',
  );
  check(
    'Binary files',
    h('Binary files a/packages/server/package.json and b/packages/server/package.json differ'),
    'Binary files a/server/package.json and b/server/package.json differ',
  );
  // The safety property: a CONTENT line that happens to contain an old path is never a header.
  const content = "+import { x } from '../../packages/server/src/session/session.js';";
  check('content line is not a header', String(PATH_LINE.test(content)), 'false');

  // The real map, from the last 2.x main, on the files the incident was filed about.
  const LAST_V2_MAIN = '3a7785dd';
  let real;
  try {
    real = renamedFiles(LAST_V2_MAIN, process.cwd());
  } catch (err) {
    failures.push(
      `could not read renames from ${LAST_V2_MAIN}: ${String(err.message).slice(0, 120)}`,
    );
  }
  if (real !== undefined) {
    const realDirs = movedDirectories(real);
    check(
      '#1033 incident: session file',
      remapPath('packages/server/src/session/no-session-watch.ts', real, realDirs).path,
      'server/src/portal/session/no-session-watch.ts',
    );
    check(
      '#1033 incident: lineage file',
      remapPath('packages/server/src/events/lineage.ts', real, realDirs).path,
      'engine/src/question/lineage.ts',
    );
    check(
      '#1033 incident: the old table would have said server/src/events/lineage.ts',
      String(
        'server/src/events/lineage.ts' ===
          remapPath('packages/server/src/events/lineage.ts', real, realDirs).path,
      ),
      'false',
    );
  }

  if (failures.length > 0) {
    process.stderr.write(
      `self-test FAILED — ${String(failures.length)} check(s):\n  ${failures.join('\n  ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('remap self-test passed (16 checks, incident files included)\n');
}

// Runs as a CLI only when invoked directly; imported, it only exports the functions above. The
// pattern core/scripts/gen-source-constants.mjs uses, and the reason the self-test can be driven
// from another script without triggering a remap.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
const args = process.argv.slice(2);
if (!invokedDirectly) {
  /* imported for its exports */
} else if (args.includes('--self-test')) {
  selfTest();
} else {
  const apply = args.includes('--apply');
  const prs = args.filter((a) => /^\d+$/.test(a)).map(Number);
  if (0 === prs.length) {
    process.stderr.write(
      'usage: node scripts/remap-stranded-prs.mjs [--apply] <pr> [pr...]\n       node scripts/remap-stranded-prs.mjs --self-test\n',
    );
    process.exit(1);
  }

  const worktree = mkdtempSync(join(tmpdir(), 'remap-wt-'));
  git(['worktree', 'add', '--quiet', '--detach', worktree, 'origin/main']);
  const results = [];
  try {
    for (const pr of prs) {
      try {
        results.push(rescue(pr, { apply, worktree }));
      } catch (err) {
        results.push({
          pr,
          status: 'error',
          detail: String(err.stderr ?? err.message).slice(0, 200),
        });
      }
    }
  } finally {
    // Leave the repository as it was found. The first version did not: a dry run over the whole
    // stranded list left forty `remap/<pr>` branches and forty `refs/remap/<pr>` behind in the
    // caller's .git, which is forty-one pieces of clutter from a command whose whole promise is that
    // it changes nothing. A rerun rebuilds any of it in seconds, so keeping it buys nothing and costs
    // the next person a `git branch` they have to reason about.
    git(['worktree', 'remove', '--force', worktree]);
    for (const pr of prs) {
      gitQuietly(['branch', '-D', `remap/${pr}`]);
      gitQuietly(['update-ref', '-d', `refs/remap/${pr}`]);
    }
  }

  for (const r of results) {
    const guess = r.guessed !== undefined && r.guessed > 0 ? `\tguessed=${String(r.guessed)}` : '';
    process.stdout.write(
      `#${String(r.pr)}\t${r.status}\tcommits=${String(r.commits ?? 0)}\tpaths=${String(r.remapped ?? 0)}${guess}\t${r.detail ?? ''}\n`,
    );
  }
  const bad = results.filter((r) => 'clean' !== r.status && 'pushed' !== r.status).length;
  process.stdout.write(
    `\n${String(results.length - bad)}/${String(results.length)} recoverable${apply ? ' (pushed)' : ' (dry run)'}\n`,
  );
  process.exitCode = 0;
}
