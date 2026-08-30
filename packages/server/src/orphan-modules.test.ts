import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A module that nothing imports must be DECLARED unwired, not discovered by an auditor.
 *
 * Four modules sat in the tree with doc comments written in the present tense — describing behaviour
 * the product does not have. The worst claimed "the server snapshots registered store paths + storage
 * keys BEFORE dispatching an action and again after", which nothing does; anyone reading the source to
 * evaluate the product would conclude that fallback exists. Dead code is cheap; dead code that asserts
 * it is alive is a lie told to the next reader.
 *
 * This test does not ban orphans — some are staged work with real tests, and deleting them would throw
 * away sound code. It bans UNDECLARED orphans: to add one you must name it here, which is exactly the
 * moment to ask whether it should be wired or removed.
 */

const SRC = join(__dirname);

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {
  'setup/run-setup.ts':
    'The half of setup that happens after the files are written: get the app running, prove a ' +
    'session connected, drive one flow to a verdict. Lands ahead of the CLI wiring. Every effect is ' +
    'injected, so the five phases and each way they fail are tested without booting a dev server or ' +
    'a browser.',
  'setup/setup-options.ts':
    'The contract between the agent and the script, landing ahead of its caller. Everything setup ' +
    'does is deterministic except the few things that need a repository and a request read and ' +
    'understood — which flow proves what the user cares about, which app in a monorepo, what env ' +
    'the app needs to get past its own front door. Those arrive as arguments rather than as steps ' +
    'somebody walks through: the agent decides, the script executes.',
  'setup/drive-plan.ts':
    'Who drives the app and whether the flow they saved is worth keeping, landing ahead of its ' +
    'caller. Both are decisions that can be tested without spending anything, which matters because ' +
    'the drive is the only part of setup that can succeed expensively and leave something worthless.',
  'setup/listeners.ts':
    'Port discovery for the setup orchestrator, landing ahead of the code that calls it. Pure ' +
    'parsing of lsof/netstat/wmic, split out so the Windows rows are testable from any machine — ' +
    'they returned nothing there until this existed, which made a dev server that prints no ' +
    'parseable URL undiscoverable on the majority platform.',
  'setup/agent-configs.ts':
    'The registry of coding agents init does not itself reach, landing ahead of its caller. Pure ' +
    'planning over an injected filesystem, which is how the per-platform paths are checked without ' +
    'those platforms.',
  'dev/stale-issue-guard.ts':
    'decision logic for scripts/check-stale-issues.mjs, which runs in CI and imports it from dist. ' +
    'A repo-hygiene guard has no caller inside the product by definition; the unit tests are here ' +
    'so the rule is testable without a network or a repo.',
  'project/memory-fs.ts':
    'test-only in-memory FileSystemPort. Extracted after a third spec hand-rolled its own copy; ' +
    'imported by specs, which this scan deliberately does not count as production importers.',
  'capsule/minimize.ts':
    'Pure prefix-trim for bug capsules, unit-tested. Ready to wire into capsule save; not yet called.',
  'flows/flow-report.ts':
    'Mermaid confidence report. No caller can produce it today — needs a CLI or tool surface first.',
  'phenomena/phenomena.ts':
    'Phenomenon classification over journal actions. Staged for the deviation reporter; not yet called.',
  'temp-dir.ts':
    'Test-only teardown helper: removing a temp directory tolerantly of Windows’ delayed handle ' +
    'release. Production code never deletes a temp tree, so a production importer would be the ' +
    'surprise here — it is imported by ~30 test files and belongs to src only because that is where ' +
    'the tsconfig can see it.',
  'ee/audit-log.ts':
    'Enterprise audit hook, a self-admitted pass-through stub. Nothing calls it; the license gate that ' +
    'would is real, but this consumer is not implemented.',
};

/** Source files, excluding tests, type-only barrels and the entry points everything hangs off. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test-harness.ts')) continue;
    // `relative()` returns the PLATFORM separator, so every comparison below is against a POSIX
    // literal that never matches on Windows: the scan then reports every file as a violation, or
    // passes by matching nothing. Same fixture bug as four other packages on this branch.
    acc.push(relative(SRC, full).split(sep).join('/'));
  }
  return acc;
}

/** Entry points and barrels are imported by consumers outside src, so "no importer here" is expected. */
const ENTRY_POINTS = new Set(['index.ts', 'cli.ts', 'mcp.ts', 'daemon.ts']);

describe('no undeclared orphan modules', () => {
  const files = sourceFiles(SRC);
  const corpus = files.map((f) => ({ path: f, text: readFileSync(join(SRC, f), 'utf8') }));

  it('every module without a production importer is declared, with a reason', () => {
    const orphans: string[] = [];
    for (const file of files) {
      if (ENTRY_POINTS.has(file)) continue;
      const base = file.replace(/\.ts$/, '');
      const specifier = `${base.split('/').pop() ?? base}.js`;
      const imported = corpus.some(
        (c) => c.path !== file && !c.path.endsWith('.test.ts') && c.text.includes(specifier),
      );
      if (!imported && DECLARED_UNWIRED[file] === undefined) orphans.push(file);
    }
    expect(orphans).toEqual([]);
  });

  it('every declared entry is still an orphan — a wired one must be removed from the list', () => {
    const stale: string[] = [];
    for (const declared of Object.keys(DECLARED_UNWIRED)) {
      const specifier = `${declared.replace(/\.ts$/, '').split('/').pop() ?? ''}.js`;
      const imported = corpus.some(
        (c) => c.path !== declared && !c.path.endsWith('.test.ts') && c.text.includes(specifier),
      );
      if (imported) stale.push(declared);
    }
    expect(stale).toEqual([]);
  });
});
