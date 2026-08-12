import { ReticleTool } from './tool-names.js';
import type { ToolDef } from './tools.js';

/**
 * There is ONE tool surface. This is not a menu.
 *
 * The advertised tool DEFINITIONS are re-sent to the model on every turn, so the surface is a
 * per-turn cost that compounds across a loop, and fewer tools also makes the model wander less.
 * What ships is the verify loop (navigate→look→act→observe→assert, with direct network + console +
 * state) advertised directly, plus two meta-tools — `reticle_tools` to discover and `reticle_run` to
 * invoke — that keep every other tool exactly one call away. Nothing is unreachable; the cold tail
 * just is not re-sent every turn.
 *
 * Five profiles were tried. Four are gone, each for a measured reason rather than a taste:
 *
 * `core` was BYTE-IDENTICAL to the default — 16 tools, 18,183 bytes, the same list. One behaviour
 * behind two names is how "I set it and nothing changed" becomes a support question with no answer.
 *
 * `standard` advertised 17 more tools directly for ~3,500 extra tokens EVERY TURN, buying only the
 * removal of an occasional `reticle_run` hop. Nothing about that was characterisable as a use case.
 *
 * `dynamic` advertised the 2 meta-tools and nothing else. Not one harness, app or bench ever
 * selected it, and this repo's own measurement (bench/agent-loop-and-replay.md) says a pure
 * on-demand surface does NOT hold accuracy with a generic model: "it needs the hot-set schemas.
 * On-demand is for the cold tail, not the hot path." An option that is unused and measured-worse is
 * a trap, not a choice — it looks like a 4,000-token saving and costs correctness.
 *
 * ALL is what remains, and it is deliberately NOT a profile: it is a verification switch. It is the
 * only mode that advertises `outputSchema`, which is what makes the MCP layer validate tool OUTPUT —
 * the check that caught `reticle_verify_change` returning a payload its own schema rejected. It
 * cannot be folded into the default: measured, carrying output schemas on the 16-tool surface costs
 * 18,183 -> 41,117 bytes, 2.26x, +5,733 tokens per turn. And it cannot simply be deleted without
 * losing that defect class. So it stays, named for what it is, and no user is asked to pick it.
 *
 * Sizes are NOT restated here — not as a current figure, not as a historical one. Four generations
 * of this comment got them wrong. They live in surface-sizes.test.ts, which reads them off the real
 * surface. (The numbers above are the two measurements that JUSTIFY a decision, which is a different
 * job from documenting the current size; both were taken with a fresh daemon per reading.)
 */
export const TOOL_SURFACE = {
  /** What every user gets: the verify loop, plus the 2 meta-tools that reach everything else. */
  DEFAULT: 'default',
  /** Every tool advertised directly, WITH output schemas. A verification switch — see above. */
  ALL: 'all',
} as const;
export type ToolSurface = (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE];

/**
 * The switch that turns on the full, output-schema-carrying surface. A boolean, not a menu.
 *
 * Named for what it does rather than which "profile" it selects, because the previous name invited
 * users to shop among alternatives that did not meaningfully differ.
 */
export const ADVERTISE_ALL_ENV = 'RETICLE_ADVERTISE_ALL_TOOLS';

/**
 * The retired setting, still read so nobody's shell profile breaks.
 *
 * Every value it ever accepted resolves to something sensible: `full` to the ALL surface, everything
 * else to the default. Silently honouring them would repeat the original sin, so `describeToolSurface`
 * says the setting retired and what was used instead.
 */
export const TOOL_PROFILE_ENV = 'RETICLE_TOOL_PROFILE';
const RETIRED_PROFILE_VALUES: Readonly<Record<string, ToolSurface>> = {
  full: TOOL_SURFACE.ALL,
  hybrid: TOOL_SURFACE.DEFAULT,
  core: TOOL_SURFACE.DEFAULT,
  standard: TOOL_SURFACE.DEFAULT,
  dynamic: TOOL_SURFACE.DEFAULT,
};

// The set an agent needs to verify a change end-to-end. Tool DEFINITIONS are re-sent every turn, so
// this set is a per-turn cost, and every name in it has to earn its place.
//
// MEASURED per-turn `tools/list` cost, off the real wire (spawn `mcp`, read tools/list, measure the
// serialized result), with a FRESH DAEMON per reading — the setting is read by the daemon at startup,
// so a loop that reuses one daemon measures the first surface every time and looks like proof that
// the setting does nothing. That happened while taking this very reading.
//
//   default    18,183 B  ~4,546 tok/turn    16 tools
//   all       127,903 B ~31,976 tok/turn    48 tools
//
// Treat these as the SHAPE of the gap and re-measure before quoting one; counts are asserted in
// surface-sizes.test.ts, never from this comment.
//
// Where the cost sits on the default surface: inputSchema is 76% of the payload (parameter
// descriptions are half of that), tool descriptions are 12%, outputSchema ~0 because it is dropped.
// So the next real saving is in parameter prose, not in dropping more tools.
//
// There is a floor, though: an 8-tool cut (dropping act/navigate/wait_for/sessions) was MEASURED to
// regress real-agent accuracy 5/5 -> 3/5, because the model loses scaffolding and wanders on harder
// flows. Direct network/console stay (far more discoverable than observe-with-filters -> fewer turns,
// better verdicts).
//
// Evidence status: the 5/5 figure came from a single gpt-4o run and is STALE as a justification.
// Current-model evidence is indirect but real — the cost-delta run (bench/fix-loop/COST-DELTA.md)
// drove this surface on a current model and fixed 4/4 cells with ~25% FEWER tool calls than the
// baseline. A formal A/B against a leaner surface on a current model is still UNRUN.
// See bench/agent-loop-and-replay.md.
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReticleTool.SESSIONS,
  ReticleTool.NAVIGATE,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  // ACT_SEQUENCE is here because its absence was measurably CAUSING the biggest loop in the data.
  //
  // In the field `reticle_act` is called overwhelmingly more often than `reticle_act_sequence`, and
  // `act` leads the repeat table by a wide margin — inside those sessions the repeated calls are
  // clicks and fills, a login form driven one round trip at a time, which is exactly the antipattern
  // SKILL.md warns about and exactly what this tool exists to collapse.
  //
  // The repeats are NOT retries: looping sessions have a LOWER error rate than non-looping ones. The
  // calls succeed and get repeated, because the batching tool was reachable only through
  // `reticle_run` — so an agent had to already know it existed to use it, and essentially nobody
  // did. A tool an agent must already know about is a tool that never gets called; the same argument
  // that put INSPECT and FEEDBACK here.
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  ReticleTool.STATE,
  // INSPECT is what turns a finding into an EDIT: it maps a DOM node to `src/App.tsx:104`. Finding a
  // bug is half the job; knowing which file to open is the half that makes the agent useful, and it
  // is the one capability here with no substitute in any other verification tool. It sat in
  // `standard`, so under the default profile an agent had to already know it existed and reach it
  // through reticle_run — which, observed over a drive of the whole surface, means it never gets called.
  // The measured floor that justifies a lean core was about CUTTING to 8 (accuracy 5/5 → 3/5), not
  // about holding at 12; one tool of schema tax to close the find→fix loop is the right trade.
  ReticleTool.INSPECT,
  // FEEDBACK is in every profile for the same reason INSPECT is: a tool an agent has to already know
  // about, and reach through reticle_run, is a tool that never gets called. That is fatal here in a way
  // it is not elsewhere — an unadvertised feedback channel collects nothing, which is indistinguishable
  // from not having built one. It is also the cheapest tool on the surface to carry (three params) and
  // the only one whose whole purpose is telling us which of the other fifteen are failing.
  ReticleTool.FEEDBACK,
  // SESSION is here because the product ORDERS the agent to call it. The session lease block is
  // spliced onto the first result of every session ("call reticle_session {action:'yield'}"), and
  // the pause hint is spliced onto every refusal while a human has the session paused, where
  // {action:"resume"} is the only exit. Both were naming a tool the default surface did not
  // advertise: an agent that obeyed got `unknown tool`, and an agent that did not left the panel
  // reading "live" after it had stopped driving — which is the state the whole handback protocol
  // exists to prevent.
  //
  // Measured cost: ~1.3 KB of prose (455 B description + ~780 B of parameter descriptions) on a
  // surface whose prose is ~23.7 KB, so roughly +5%, a few hundred tokens a turn. The alternative —
  // deleting the instruction from the lease and the pause hint — deletes the handback protocol,
  // because there is nowhere else those two calls are ever named.
  ReticleTool.SESSION,
]);

/** Is the truthy form of a boolean env var set? `1`, `true`, `yes` — anything else is off. */
function envFlagOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return '1' === value || 'true' === value || 'yes' === value || 'on' === value;
}

/**
 * Which surface is live.
 *
 * `explicit` is the programmatic override (tests, `advertisedTools` callers). Otherwise the ALL
 * switch decides, and the retired setting is honoured last so an old shell profile still works.
 */
export function resolveToolSurface(explicit?: string): ToolSurface {
  if (explicit === TOOL_SURFACE.ALL) return TOOL_SURFACE.ALL;
  if (explicit === TOOL_SURFACE.DEFAULT) return TOOL_SURFACE.DEFAULT;
  const retiredExplicit = explicit === undefined ? undefined : RETIRED_PROFILE_VALUES[explicit];
  if (retiredExplicit !== undefined) return retiredExplicit;
  if (envFlagOn(process.env[ADVERTISE_ALL_ENV])) return TOOL_SURFACE.ALL;
  const retiredEnv = RETIRED_PROFILE_VALUES[process.env[TOOL_PROFILE_ENV] ?? ''];
  return retiredEnv ?? TOOL_SURFACE.DEFAULT;
}

/** The live surface plus what chose it — see describeToolSurface. */
export interface ToolSurfaceOrigin {
  active: ToolSurface;
  source: string;
}

/**
 * Which surface is live, and what chose it.
 *
 * These settings are read by the DAEMON at startup, never by the client, so exporting one in an
 * agent's environment while a daemon is already running changes nothing at all — which is exactly
 * the observation that produced a "standard and full advertise the same tools" report. Documenting
 * that was not enough; the setting failing to take has to be VISIBLE, so this rides along in the
 * reticle_tools catalog.
 */
export function describeToolSurface(active: ToolSurface, requested?: string): ToolSurfaceOrigin {
  const retired = requested ?? process.env[TOOL_PROFILE_ENV];
  if (retired !== undefined && retired in RETIRED_PROFILE_VALUES) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV}=${retired} is RETIRED — there is one tool surface now; using '${active}' (set ${ADVERTISE_ALL_ENV}=1 for the full, schema-carrying surface)`,
    };
  }
  if (retired !== undefined && 0 < retired.length) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV} is RETIRED and '${retired}' was never one of its values; using '${active}'`,
    };
  }
  const flag = process.env[ADVERTISE_ALL_ENV];
  if (envFlagOn(flag)) {
    return { active, source: `${ADVERTISE_ALL_ENV} set in the DAEMON's environment at startup` };
  }
  // "unset" and "set to 0" are different facts, and only one of them means "you did not ask for it".
  // Reporting the second as the first is how somebody spends an afternoon on a switch that IS being
  // read and is simply off.
  return flag === undefined || 0 === flag.length
    ? {
        active,
        source: `the one tool surface (${ADVERTISE_ALL_ENV} unset when the daemon started)`,
      }
    : { active, source: `the one tool surface (${ADVERTISE_ALL_ENV}='${flag}' is off)` };
}

export function filterTools(tools: ToolDef[], surface: ToolSurface): ToolDef[] {
  // CORE_TOOL_NAMES is what it always really was: the set advertised directly. It was never the
  // interesting thing about the `core` PROFILE, whose only distinction was a second name for this.
  if (surface === TOOL_SURFACE.DEFAULT) return tools.filter((t) => CORE_TOOL_NAMES.has(t.name));
  return tools;
}
