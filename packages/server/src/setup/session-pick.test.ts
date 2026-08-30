import { describe, expect, it } from 'vitest';
import { pickSession, type CandidateSession } from './session-pick.js';

const S = (
  sessionId: string,
  url: string,
  extra: Partial<CandidateSession> = {},
): CandidateSession => ({
  sessionId,
  url,
  ...extra,
});

describe('choosing the session to drive', () => {
  it('has nothing to pick when the daemon holds nothing', () => {
    expect(pickSession([], 'http://localhost:5173')).toBeNull();
  });

  // The false green this guard exists for: another tab being alive says nothing about THIS app.
  it("never picks somebody else's tab", () => {
    expect(pickSession([S('other', 'http://localhost:9999/')], 'http://localhost:5173')).toBeNull();
  });

  it('matches despite a trailing slash on either side', () => {
    expect(
      pickSession([S('a', 'http://localhost:5173/x')], 'http://localhost:5173/')?.sessionId,
    ).toBe('a');
  });

  // The other false green: driving a tab from a dev server that died yesterday.
  it('prefers a session that is new since this run opened one', () => {
    const picked = pickSession(
      [S('old', 'http://localhost:5173/'), S('new', 'http://localhost:5173/')],
      'http://localhost:5173',
      new Set(['old']),
    );
    expect(picked?.sessionId).toBe('new');
  });

  it('prefers a visible tab over a hidden one, among equals', () => {
    const picked = pickSession(
      [
        S('hidden', 'http://localhost:5173/', { hidden: true }),
        S('shown', 'http://localhost:5173/'),
      ],
      'http://localhost:5173',
    );
    expect(picked?.sessionId).toBe('shown');
  });

  it('counts a throttled tab as not live', () => {
    const picked = pickSession(
      [
        S('throttled', 'http://localhost:5173/', { throttled: true }),
        S('shown', 'http://localhost:5173/'),
      ],
      'http://localhost:5173',
    );
    expect(picked?.sessionId).toBe('shown');
  });

  // Freshness outranks visibility: a new hidden tab is still THIS run's, while an old visible one is
  // a leftover that would be driven and reported on as though it were ours.
  it('takes a fresh hidden tab over an old visible one', () => {
    const picked = pickSession(
      [S('old', 'http://localhost:5173/'), S('new', 'http://localhost:5173/', { hidden: true })],
      'http://localhost:5173',
      new Set(['old']),
    );
    expect(picked?.sessionId).toBe('new');
  });

  it('falls back to the least stale when nothing else separates them', () => {
    const picked = pickSession(
      [
        S('stale', 'http://localhost:5173/', { hidden: true, lastSeenMs: 90_000 }),
        S('recent', 'http://localhost:5173/', { hidden: true, lastSeenMs: 200 }),
      ],
      'http://localhost:5173',
    );
    expect(picked?.sessionId).toBe('recent');
  });
});
