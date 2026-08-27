/**
 * Telling the human that the agent went somewhere they cannot see.
 *
 * A lease is a separate pooled context, and it is the highest-value path in the product for
 * autonomous work. It also has one failure mode that is entirely about people: the HUD lives in the
 * human's OWN tab, so while an agent drives a lease that tab shows nothing at all. An idle agent and
 * a busy one are then indistinguishable from the only seat a human occupies.
 *
 * That is not hypothetical. An agent followed the daemon's own throttle recommendation into a lease,
 * drove fifteen calls, and the developer watching an empty HUD asked why nothing was running. The
 * product was working perfectly and looked broken, which is the worst combination available.
 *
 * The fix rides on machinery that already exists — `pushNarration` posts `ReticleCommand.NARRATE`
 * and every SDK in the field already renders it — so nothing here moves the wire contract. It is a
 * message to tabs that are ALREADY connected, not a new capability.
 */

/** The minimum a session has to expose to be a candidate watcher. Structural, so tests need no SDK. */
export interface WatcherCandidate {
  id: string;
  projectId: string | undefined;
}

/**
 * Shown on a watching human's HUD when an agent takes a lease.
 *
 * States the fact and its consequence, because the fact alone ("agent leased a context") does not
 * tell somebody why their screen is still. The consequence is the whole reason to say anything.
 */
export const AGENT_DRIVING_ELSEWHERE =
  'An agent is driving a separate leased context — its actions will not appear in this tab.';

/** Shown when the lease is released, so a HUD that went quiet is explained in both directions. */
export const AGENT_DRIVING_HERE_AGAIN =
  'The agent released its separate context — this tab is live again.';

/**
 * Which connected sessions belong to a human who should be told.
 *
 * Two exclusions, both deliberate:
 *
 * - Leased sessions. They ARE the agent's context; narrating "an agent is driving elsewhere" into
 *   the tab doing the driving is noise, and with several leases open they would talk about each
 *   other. Membership comes from the pool rather than an id prefix, because a naming convention is
 *   not a fact and `pool.leasedSessionIds()` is.
 *
 * - Other projects. One daemon serves many, and somebody watching app A does not need to hear about
 *   a lease taken against app B. A session that declares no project is NOT excluded: an older SDK
 *   sends no projectId, and silently dropping those would reintroduce the dark HUD for exactly the
 *   people least likely to work out why.
 *
 * Pure: no IO, no clock, no session objects. The caller does the posting.
 */
export function watchersToNotify(
  sessions: readonly WatcherCandidate[],
  leasedSessionIds: readonly string[],
  projectId: string | undefined,
): string[] {
  const leased = new Set(leasedSessionIds);
  return sessions
    .filter((session) => !leased.has(session.id))
    .filter(
      (session) =>
        projectId === undefined ||
        session.projectId === undefined ||
        session.projectId === projectId,
    )
    .map((session) => session.id);
}
