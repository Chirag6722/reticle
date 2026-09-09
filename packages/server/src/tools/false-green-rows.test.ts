/**
 * A row in the third-party false-green corpus is only a row once it has been MEASURED.
 *
 * The corpus exists because our own fixtures are too easy: they contain the defects we chose, shaped
 * by the same understanding that built the detectors. A row fixes that by taking its ground truth
 * from somebody else's history — an upstream commit that fixed a bug and shipped the regression test
 * for it — so the bug is real, it shipped, and a maintainer fixed it.
 *
 * That only holds if the pair was actually run. A candidate that LOOKS like a fix-with-test but whose
 * test does not fail at the parent is not ground truth, and putting one in would make the scorecard
 * read stronger than it is — the exact failure the corpus exists to prevent, committed into the
 * instrument that is supposed to detect it.
 *
 * So: every row carries its measurement, and every ref is immutable. A branch name here would let
 * upstream move a row under the measurement without anyone noticing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROWS = join(import.meta.dirname, '../../../../bench/false-green-corpus/rows.json');
const corpus = JSON.parse(readFileSync(ROWS, 'utf8')) as {
  rows: {
    id: string;
    fixedRef: string;
    brokenRef: string;
    oracle?: { kind?: string; command?: string };
    verified?: { fixedRef?: string; brokenRef?: string; failing?: string[] };
    whyItIsAFalseGreen?: string;
  }[];
};

/** A commit sha, not a branch: `main` can move, a sha cannot. */
const IMMUTABLE_REF = /^[0-9a-f]{7,40}(~\d+)?$/;

describe('the third-party false-green corpus', () => {
  it('has rows at all — a guard over an empty corpus proves nothing', () => {
    expect(corpus.rows.length).toBeGreaterThan(0);
  });

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s pins immutable refs, so upstream cannot move it under the measurement',
    (_id, row) => {
      expect(row.fixedRef).toMatch(IMMUTABLE_REF);
      expect(row.brokenRef).toMatch(IMMUTABLE_REF);
      expect(row.brokenRef, 'broken and fixed must differ, or the row measures nothing').not.toBe(
        row.fixedRef,
      );
    },
  );

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s carries the measurement that makes it a row rather than a candidate',
    (_id, row) => {
      expect(
        row.verified,
        'a candidate becomes a row only after the oracle is run at BOTH refs. Without that, this ' +
          "is somebody's guess about a commit, and a guess in a false-green corpus makes the " +
          'scorecard read stronger than it is.',
      ).toBeDefined();
      expect(row.verified?.brokenRef, 'the broken ref must record a FAILURE').toMatch(/fail/i);
      expect(row.verified?.fixedRef, 'the fixed ref must record a PASS').toMatch(/pass/i);
      expect(
        (row.verified?.failing ?? []).length,
        'name WHICH assertions failed: "the suite went red" does not show the oracle is specific ' +
          'to this defect rather than to a broken build',
      ).toBeGreaterThan(0);
    },
  );

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s says why the defect is a FALSE GREEN and not merely a bug',
    (_id, row) => {
      expect(
        (row.whyItIsAFalseGreen ?? '').length,
        'the corpus measures false greens: broken but LOOKS fine. A defect that announces itself ' +
          'belongs in a different benchmark.',
      ).toBeGreaterThan(40);
    },
  );
});

/**
 * A row must be able to prove it is driving the RIGHT application.
 *
 * The corpus measures whether Reticle catches a defect. That means nothing unless the app under the
 * cursor is the one the defect lives in, and an app can render, connect and return a green verdict
 * while being something else entirely.
 *
 * Measured on the first row: nuclear's `main.tsx` branches on `window.__TAURI_INTERNALS__`. Under
 * Tauri it loads the PLAYER, where this row's defect lives; in a plain browser it loads a REMOTE
 * CONTROL app. A bare `vite` therefore renders 1867 characters of "Connecting to Nuclear..." and
 * `reticle_assert` returns `verified: "yes"` for text on it. That verdict is real, and it is about
 * the wrong application. Scoring against it would have produced a false green inside the instrument
 * built to measure false greens.
 *
 * So every row names something that identifies its app, and says plainly whether it can be driven at
 * all. `drivableInBrowser: false` is a fine answer — it routes the row to the desktop path instead
 * of silently scoring it in the wrong place.
 */
describe('a row can prove it is driving the right application', () => {
  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s names an identifying marker for its app',
    (_id, row) => {
      const marker = (row as { boot?: { identifies?: { textContains?: string } } }).boot?.identifies
        ?.textContains;
      expect(
        (marker ?? '').length,
        'without a marker, a row can be scored against a different app that happens to render — ' +
          'which is a false green inside the false-green corpus',
      ).toBeGreaterThan(0);
    },
  );

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s states whether it is drivable in a browser at all',
    (_id, row) => {
      const drivable = (row as { boot?: { drivableInBrowser?: boolean } }).boot?.drivableInBrowser;
      expect(
        typeof drivable,
        'UNSTATED is the dangerous value: it reads as "probably fine" and is how a row gets scored ' +
          'in the wrong runtime. `false` is a perfectly good answer.',
      ).toBe('boolean');
    },
  );
});
