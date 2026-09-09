#!/usr/bin/env node
// Re-derive every row in the third-party false-green corpus (#130 item 3, ground-truth half).
//
// A row claims something falsifiable: at `brokenRef` the upstream oracle FAILS, at `fixedRef` it
// PASSES, and the failures are the specific assertions named in the row. This runs that claim.
//
// Why it has to be re-runnable rather than measured once and written down: this repo has been
// burned by exactly that. The published benchmark figures were recorded on one date, 615 commits
// touched the harness and the fixture app, and when they were finally re-derived the detection
// numbers had moved and the per-bug output figure had INVERTED. A benchmark nobody re-derives is a
// claim, not a measurement.
//
// The rows here are pinned to immutable upstream refs, so unlike that case they cannot drift on
// their own — but the recipe around them can: a package manager changes, a lockfile resolves
// differently, a transitive dep breaks an old checkout. This tells you that happened, instead of
// letting a row quietly stop meaning what it says.
//
// Usage:
//   node bench/false-green-corpus/verify-rows.mjs [--row <id>] [--work <dir>]
//
// Network and disk heavy by nature: it clones and installs somebody else's project. Not part of any
// gate that runs per-commit; this is a release-time check, or one you run when adding a row.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(join(HERE, 'rows.json'), 'utf8'));

const args = process.argv.slice(2);
const only = args.includes('--row') ? args[args.indexOf('--row') + 1] : undefined;
const work = args.includes('--work')
  ? args[args.indexOf('--work') + 1]
  : join(tmpdir(), 'reticle-false-green-corpus');

const run = (cmd, cwd, allowFailure = false) => {
  try {
    return {
      ok: true,
      out: execFileSync('bash', ['-lc', cmd], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, out: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` };
  }
};

/** Count the assertions the oracle reported as failing, from a vitest-style summary line. */
function failureCount(output) {
  const m = /Tests\s+(\d+)\s+failed/.exec(output);
  return m === null ? 0 : Number(m[1]);
}

mkdirSync(work, { recursive: true });
let bad = 0;

for (const row of CORPUS.rows) {
  if (only !== undefined && row.id !== only) continue;
  console.log(`\n=== ${row.id} — ${row.subject}`);
  const dir = join(work, row.id);
  if (!existsSync(dir)) {
    console.log(`   cloning ${row.upstream}`);
    run(`git clone --filter=blob:none ${row.upstream} ${JSON.stringify(dir)}`, work);
  }

  // FIXED first: if the oracle cannot pass here, the recipe is broken and the broken-ref result
  // below would be meaningless — a red that proves nothing about the defect.
  run(`git checkout -q ${row.fixedRef} && git checkout -q ${row.fixedRef} -- .`, dir);
  run(row.oracle.install, dir);
  const pkg = join(dir, row.oracle.package);
  const fixed = run(row.oracle.command, pkg, true);
  if (!fixed.ok) {
    console.log(`   ❌ oracle FAILED at fixedRef — the recipe is broken, not the app`);
    bad += 1;
    continue;
  }
  console.log('   ✅ fixedRef: oracle passes');

  // The oracle is the fix's test applied to the BROKEN source: their assertion about their bug.
  run(`git checkout -q ${row.brokenRef} -- ${row.oracle.brokenSource.join(' ')}`, dir);
  const broken = run(row.oracle.command, pkg, true);
  const failures = failureCount(broken.out);
  const expected = row.verified.failing.length;
  if (broken.ok) {
    console.log('   ❌ brokenRef: oracle PASSED — this row no longer demonstrates a defect');
    bad += 1;
  } else if (failures !== expected) {
    // A coarse oracle going red for any reason would make every row look like a catch, so the
    // COUNT is asserted, not merely the redness.
    console.log(`   ❌ brokenRef: ${String(failures)} failed, row claims ${String(expected)}`);
    bad += 1;
  } else {
    console.log(`   ✅ brokenRef: exactly ${String(expected)} failed, as recorded`);
  }
}

console.log(bad === 0 ? '\n✅ every row re-derived' : `\n❌ ${String(bad)} row(s) no longer hold`);
process.exit(bad === 0 ? 0 : 1);
