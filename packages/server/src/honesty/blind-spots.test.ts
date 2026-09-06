import { describe, expect, it } from 'vitest';
import { AppRuntime, EventType, type ReticleEvent } from '@reticlehq/core';
import {
  BlindSpotKind,
  absenceBlindSpotNote,
  buildCoverageStatement,
  blindSpotsFromEvents,
  spotsForRuntime,
} from './blind-spots.js';

function ev(type: EventType, data: Record<string, unknown>, t = 1): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

describe('buildCoverageStatement', () => {
  it('reports full coverage when nothing went unobserved', () => {
    expect(buildCoverageStatement([])).toEqual({ coverage: 'full', spots: [] });
    expect(
      buildCoverageStatement([{ kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 0 }]).coverage,
    ).toBe('full');
  });

  it('names an un-instrumented Electron renderer, so an empty network view cannot read as clean', () => {
    const statement = buildCoverageStatement([{ kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 }]);
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toContain('@reticlehq/electron/preload');
  });

  it('degrades an unknown kind to its name instead of throwing on the verdict path', () => {
    // An SDK newer than the daemon can report a kind this LABEL table has never heard of. Indexing
    // it and calling the result threw a TypeError, which turned "there is something I could not
    // see" into a crashed assert — strictly worse than either the caveat or the silence.
    const statement = buildCoverageStatement([
      { kind: 'a-kind-from-the-future' as BlindSpotKind, count: 3 },
    ]);
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toContain('a-kind-from-the-future');
  });

  it('reports partial coverage with a legible note listing what was unobserved', () => {
    const statement = buildCoverageStatement([
      { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 },
      { kind: BlindSpotKind.CLOSED_SHADOW_ROOT, count: 1 },
    ]);
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toBe(
      'partial — 2 cross-origin frames unobserved, 1 closed shadow root unobserved',
    );
  });

  /**
   * A Vite + React tab at localhost:5173 was reported as an Electron renderer with unobserved
   * ipcRenderer.invoke coverage, while reticle_sessions correctly showed a web session. The
   * desktop kinds live in the same vocabulary as "no store registered", so presence of the
   * kind is not evidence the page is a desktop app — the session already reports the runtime.
   */
  it('drops Electron IPC rows on a web session, even when that kind is in the spots', () => {
    const spots = [
      { kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 },
      { kind: BlindSpotKind.UNWATCHED_STATE, count: 1 },
    ];
    const statement = buildCoverageStatement(spotsForRuntime(spots, AppRuntime.WEB));
    expect(statement.note).toContain('no subscribable store');
    expect(statement.note).not.toContain('Electron');
    expect(statement.note).not.toContain('ipcRenderer');
  });

  it('drops a one-way IPC send row on Tauri — that kind is Electron preload, not invoke', () => {
    const statement = buildCoverageStatement(
      spotsForRuntime([{ kind: BlindSpotKind.VERDICTLESS_SEND, count: 1 }], AppRuntime.TAURI),
    );
    expect(statement.coverage).toBe('full');
  });

  it('keeps the missing-preload warning on an actual Electron renderer', () => {
    const statement = buildCoverageStatement(
      spotsForRuntime([{ kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 }], AppRuntime.ELECTRON),
    );
    expect(statement.coverage).toBe('partial');
    expect(statement.note).toContain('@reticlehq/electron/preload');
  });

  it('keeps desktop rows when the runtime is unknown, so an older SDK still warns', () => {
    const statement = buildCoverageStatement(
      spotsForRuntime([{ kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 }], undefined),
    );
    expect(statement.note).toContain('Electron');
  });

  it('drops zero-count spots from the note', () => {
    const statement = buildCoverageStatement([
      { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 0 },
      { kind: BlindSpotKind.VIRTUALIZED_UNMOUNTED, count: 5 },
    ]);
    expect(statement.spots).toHaveLength(1);
    expect(statement.note).toContain('5 virtualized unmounted rows');
  });
});

describe('blindSpotsFromEvents', () => {
  it('reduces BLIND_SPOT events to one spot per kind, latest count winning', () => {
    const spots = blindSpotsFromEvents([
      ev(EventType.BLIND_SPOT, { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 1 }),
      ev(EventType.DOM_ADDED, {}),
      ev(EventType.BLIND_SPOT, { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 }), // later wins
    ]);
    expect(spots).toEqual([{ kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 }]);
  });

  it('is empty when the window has no BLIND_SPOT events (→ full coverage)', () => {
    const spots = blindSpotsFromEvents([ev(EventType.NET_REQUEST, {})]);
    expect(spots).toEqual([]);
    expect(buildCoverageStatement(spots).coverage).toBe('full');
  });
});

describe('absenceBlindSpotNote reads both spellings of an absence claim', () => {
  const shadow = [{ kind: BlindSpotKind.CLOSED_SHADOW_ROOT, count: 2 }];

  it('fires on a `not`-wrapped element, the other spelling of `absent: true`', () => {
    // The defect: `not` and `absent: true` are the same claim, and only one of them carried the
    // caveat. `restsOnCompleteWindow` already treats `not` as an absence claim, so the two honesty
    // checks sitting beside each other disagreed about the same predicate — and the one that stayed
    // quiet was the one guarding the DOM the walk could not enter.
    const note = absenceBlindSpotNote(
      { kind: 'not', predicate: { kind: 'element', query: {} } },
      shadow,
    );
    expect(note).toContain('cannot prove absence');
    expect(note).toContain('2 closed shadow roots');
  });

  it('says the same thing for both spellings, so neither reads as the weaker claim', () => {
    const wrapped = absenceBlindSpotNote(
      { kind: 'not', predicate: { kind: 'element', query: {} } },
      shadow,
    );
    const flagged = absenceBlindSpotNote({ kind: 'element', absent: true, query: {} }, shadow);
    expect(wrapped).toBe(flagged);
  });

  it('stays silent on a double negative — `not` over `absent` is a PRESENCE claim', () => {
    // Polarity, not spelling, decides this. `not(absent)` asserts the element IS there, and a
    // positive assertion that passed found its evidence; an unobservable region cannot unmake it.
    expect(
      absenceBlindSpotNote(
        { kind: 'not', predicate: { kind: 'element', absent: true, query: {} } },
        shadow,
      ),
    ).toBeUndefined();
  });

  it('reads `query.scope` off the negated predicate, where the caller wrote it', () => {
    // The scope lives on the INNER predicate; a wrapper-only read would find nothing and drop the
    // cross-origin branch on exactly the predicates that name a frame.
    const spots = [{ kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 1 }];
    expect(
      absenceBlindSpotNote(
        { kind: 'not', predicate: { kind: 'element', query: { scope: '#checkout-frame' } } },
        spots,
      ),
    ).toContain('1 cross-origin frame');
    // Unscoped, the frame is not the region being asserted about, and the note must not fire —
    // the same rule the `absent: true` path already applies.
    expect(
      absenceBlindSpotNote({ kind: 'not', predicate: { kind: 'element', query: {} } }, spots),
    ).toBeUndefined();
  });

  it('leaves a plain presence assertion alone', () => {
    expect(absenceBlindSpotNote({ kind: 'element', query: {} }, shadow)).toBeUndefined();
  });

  it('stays out of `not` over a non-element kind, which asserts nothing about the DOM', () => {
    // A network or console claim is not answered by the DOM walk, so the DOM coverage note would be
    // a caveat about the wrong channel.
    expect(
      absenceBlindSpotNote({ kind: 'not', predicate: { kind: 'net' } }, shadow),
    ).toBeUndefined();
  });

  it('unwraps one level only, which is where the claim stops being an absence claim anyway', () => {
    // `not(not(element))` is a double negative — a PRESENCE claim — so silence is the correct
    // answer here, not a limitation being tolerated. Deeper nesting than this is not a shape a
    // caller writes, and guessing how deep to recurse is not a call this fix makes.
    expect(
      absenceBlindSpotNote(
        { kind: 'not', predicate: { kind: 'not', predicate: { kind: 'element', query: {} } } },
        shadow,
      ),
    ).toBeUndefined();
  });

  it('is silent when the page has no blind spots at all, on either spelling', () => {
    expect(
      absenceBlindSpotNote({ kind: 'not', predicate: { kind: 'element', query: {} } }, []),
    ).toBeUndefined();
    expect(
      absenceBlindSpotNote({ kind: 'not', predicate: { kind: 'element', query: {} } }, [
        { kind: BlindSpotKind.CLOSED_SHADOW_ROOT, count: 0 },
      ]),
    ).toBeUndefined();
  });
});
