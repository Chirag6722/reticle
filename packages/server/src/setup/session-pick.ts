/**
 * Which connected session to drive, out of everything the daemon is holding.
 *
 * This is a false-green guard, which is why it is its own module. Two ways to get it wrong, and
 * both report a successful install for an app that was never verified:
 *
 * - Match "any session" and you pass on somebody else's tab. A daemon usually holds several, and
 *   one of them being alive says nothing about whether THIS app connected.
 * - Match "the first session on this url" and you drive whichever the daemon listed first, usually
 *   the oldest: a tab whose dev server died yesterday. The HUD then plays to a window nobody is
 *   watching, and the verdict describes a page the user cannot see.
 */

/** The fields of a daemon session this decision actually reads. */
export interface CandidateSession {
  readonly sessionId: string;
  readonly url?: string;
  readonly hidden?: boolean;
  readonly throttled?: boolean;
  readonly lastSeenMs?: number;
  /** False when the capabilities file init scaffolded was never completed. */
  readonly hasCapabilities?: boolean;
}

/** Sorts a hidden tab after a visible one; among equals, the least stale first. */
const isLive = (s: CandidateSession): boolean => true !== s.hidden && true !== s.throttled;
const staleness = (s: CandidateSession): number => s.lastSeenMs ?? Number.POSITIVE_INFINITY;

/**
 * The session to drive, or null when nothing on this url qualifies.
 *
 * Preference order, strongest evidence first:
 *   1. NEW since we opened the tab — definitely this run's, definitely alive
 *   2. visible and not throttled  — the tab a human is actually looking at
 *   3. least stale               — the best of a bad set
 *
 * `before` is the set of session ids that already existed when this run started; anything outside
 * it belongs to us.
 */
export function pickSession(
  sessions: readonly CandidateSession[],
  url: string,
  before: ReadonlySet<string> = new Set(),
): CandidateSession | null {
  const wanted = String(url).replace(/\/$/, '');
  const onUrl = sessions.filter((s) => (s?.url ?? '').startsWith(wanted));
  if (0 === onUrl.length) return null;
  const fresh = onUrl.filter((s) => !before.has(s.sessionId));
  const pool = 0 < fresh.length ? fresh : onUrl;
  return pool.find(isLive) ?? [...pool].sort((a, b) => staleness(a) - staleness(b))[0] ?? null;
}
