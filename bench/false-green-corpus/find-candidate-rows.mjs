#!/usr/bin/env node
// Find candidate rows for the third-party false-green corpus (#130 item 1).
//
// A row needs a defect whose ground truth is SOMEBODY ELSE'S, so the corpus does not encode our
// opinion about what a bug looks like. The strongest available form, and the one #130 item 2 names,
// is the upstream test that failed: a commit that fixes a bug AND ships the regression test for it.
// That test passes at the fix and fails at its parent, which makes the pair
// (parent = broken, commit = fixed) a triple a stranger can audit.
//
// WHAT THIS DOES NOT DO, stated because the difference matters: it finds CANDIDATES. It does not
// prove the test fails at the parent. Only running the suite at both refs proves that, and a
// candidate that turns out not to fail is not a row. Treating this output as verified is exactly the
// mistake that would put an unverified row into a false-green measurement, which is worse than
// having no row at all.
//
// Usage:
//   node bench/false-green-corpus/find-candidate-rows.mjs <path-to-clone> [--limit N]
//
// A blobless clone is enough and is much faster:
//   git clone --filter=blob:none --no-checkout <upstream> /tmp/app
//
// Why a script rather than a note: item 1 was blocked on "which apps", and the honest answer turned
// out to depend on which apps HAVE auditable defects. That is a question about their history, not a
// matter of preference, and it is answerable mechanically in about a minute per repo.

import { execFileSync } from 'node:child_process';

const [dir, ...rest] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: find-candidate-rows.mjs <path-to-clone> [--limit N]');
  process.exit(2);
}
const limitFlag = rest.indexOf('--limit');
const LIMIT = limitFlag === -1 ? 600 : Number(rest[limitFlag + 1] ?? 600);

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
const SOURCE_FILE = /\.[jt]sx?$/;
/** A subject line that claims to repair something. Deliberately loose; the pair is the real filter. */
const REPAIRS = /\b(fix|fixes|fixed|bug|regression|broken)\b/i;

const log = execFileSync('git', ['log', `-${String(LIMIT)}`, '--format=%H%x09%s', '--name-only'], {
  cwd: dir,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

/** Commits as {sha, subject, files}. `git log --name-only` separates entries by a blank line. */
function* commits(text) {
  let current;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const header = /^([0-9a-f]{40})\t(.*)$/.exec(line);
    if (header !== null) {
      if (current !== undefined) yield current;
      current = { sha: header[1], subject: header[2], files: [] };
    } else if (line.trim().length > 0 && current !== undefined) {
      current.files.push(line.trim());
    }
  }
  if (current !== undefined) yield current;
}

const rows = [];
for (const commit of commits(log)) {
  if (!REPAIRS.test(commit.subject)) continue;
  const tests = commit.files.filter((f) => TEST_FILE.test(f));
  const sources = commit.files.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f));
  // Both, or it is not the shape: a fix with no test has no oracle, and a test with no source
  // change is somebody tidying their suite.
  if (tests.length === 0 || sources.length === 0) continue;
  rows.push({ fixedRef: commit.sha, subject: commit.subject, tests, sources });
}

if (rows.length === 0) {
  console.log(`no candidate rows in the last ${String(LIMIT)} commits of ${dir}.`);
  console.log(
    'That is a finding, not a failure: an app whose fixes ship no tests cannot supply an',
  );
  console.log(
    'auditable oracle, and belongs in the install-complexity corpus rather than this one.',
  );
  process.exit(0);
}

console.log(`${String(rows.length)} CANDIDATE rows in ${dir} (unverified — see the header):\n`);
for (const row of rows.slice(0, 25)) {
  console.log(`  ${row.fixedRef.slice(0, 9)}  ${row.subject.slice(0, 72)}`);
  // `~1` is load-bearing: truncating it yields a ref that resolves to the FIXED commit, which would
  // silently make the pair identical and the row meaningless.
  console.log(`      broken: ${row.fixedRef.slice(0, 9)}~1  oracle: ${row.tests[0]}`);
  console.log(`      source: ${row.sources[0]}`);
}
console.log('\nNext, per candidate, and this is the part that makes it a ROW rather than a guess:');
console.log('  1. check out brokenRef, install, run the oracle test  -> it must FAIL');
console.log('  2. check out fixedRef,  install, run the oracle test  -> it must PASS');
console.log('  3. only then is the pair ground truth Reticle can be graded against.');
