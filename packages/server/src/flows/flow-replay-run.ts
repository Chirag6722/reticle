import {
  EventType,
  FLOW_SIGNAL_TIMEOUT_MS,
  FlowErrorCode,
  RecordedFlowSchema,
  ReplayStatus,
  ReticleCommand,
  RunKind,
  RunStatus,
  type CommandResult,
  type FlowFile,
  type FlowReplayResult,
  type FlowStepResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { asRecord, asString } from '../tools/tools-helpers.js';
import type { ArrivalClock } from '../tools/navigate-arrival.js';
import { carryReticleIdentity } from '../tools/lease-tools.js';
import type { SessionManager } from '../session/session-manager.js';
import type { Session } from '../session/session.js';
import { replayFlow } from './flow-replay.js';
import { assertSuccess, dynamicTestids, successLabel, SUCCESS_STEP_TOOL } from './flow-success.js';
import { buildDecision, unverifiableReason } from './decision.js';
import { classifyFlowAssertions } from './flow-classify.js';
import { dischargeFlowIntent, flowIntentStatement, flowReplayVerdictId } from './flow-intent.js';
import { IntentStore } from '../intent/intent-store.js';
import { sessionRoot } from '../project/session-root.js';
import { waitForPredicate } from '../events/predicate.js';
import { computeSegments } from '../journal/rollups.js';
import { AssertionTiersStore } from './assertion-tiers-store.js';
import { toFlowSources } from './flow-sources.js';
import { reportAndAccumulate } from '../journal/deviation-service.js';
import { EnvelopeStore } from '../journal/envelope-store.js';
import type { DeviationReport } from '../journal/deviation-report.js';
import { homedir } from 'node:os';
import { cloudFetch, syncRunRecordToCloud, SyncOutcome } from '../cloud/cloud-sync.js';
import { resolveProjectCloud } from '../cloud/cloud-config.js';
import { log } from '../log.js';
import type { ToolDeps } from '../tools/tools.js';

export function latestRecordedFlow(
  events: ReticleEvent[],
): { name: string; flow: import('@reticlehq/core').FlowFile } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== EventType.FLOW_RECORDED) continue;
    const parsed = RecordedFlowSchema.safeParse(event.data);
    if (parsed.success) return { name: parsed.data.name, flow: parsed.data.flow };
  }
  return undefined;
}

/** Map a structured FlowErrorCode to a legible one-line message for the agent. */
export function flowErrorMessage(code: FlowErrorCode): string {
  switch (code) {
    case FlowErrorCode.INVALID_NAME:
      return 'invalid flow name — use a single safe segment (letters/digits/-/_), no path separators';
    case FlowErrorCode.NOT_FOUND:
      return 'no such flow on disk — run reticle_flow{action:"list"} to see saved flows';
    case FlowErrorCode.PARSE_FAILED:
      return 'flow file is malformed — fix or regenerate it with reticle_flow_save';
    case FlowErrorCode.NO_RECORDING:
      return 'no compiled recording by that name — record one (reticle_record{action:"start"|"stop"}) first';
  }
}

/** Map the wire ReplayStatus onto the persisted RunStatus (ok→pass). */
function replayToRunStatus(status: ReplayStatus): RunStatus {
  switch (status) {
    case ReplayStatus.OK:
      return RunStatus.PASS;
    case ReplayStatus.DRIFT:
      return RunStatus.DRIFT;
    case ReplayStatus.ERROR:
      return RunStatus.ERROR;
  }
}

/**
 * Append a flow-replay outcome to .reticle/project.json (never throws into replay) and, when logged in,
 * best-effort mirror it to Reticle Cloud so the team's server-side regression history stays current. The
 * cloud push is fire-and-forget: not logged in → skipped, a network failure is logged and swallowed.
 */
async function recordReplayRun(
  deps: ToolDeps,
  name: string,
  status: ReplayStatus,
  driftSteps: number,
  durationMs: number,
  projectId: string | undefined,
): Promise<void> {
  const runStatus = replayToRunStatus(status);
  await deps.project.recordRun({
    kind: RunKind.FLOW_REPLAY,
    name,
    status: runStatus,
    evidence: { driftSteps },
    durationMs,
  });
  // Per-project cloud: push memory outcomes only when cloud is attached AND memory sync is enabled.
  const cloud = await resolveProjectCloud(deps.fs, deps.reticleRoot, homedir(), process.env);
  if (null === cloud.config || !cloud.policy.memory) return; // not attached / memory disabled → local only
  const result = await syncRunRecordToCloud(
    { kind: RunKind.FLOW_REPLAY, name, status: runStatus, at: deps.now(), durationMs },
    projectId,
    cloud.config,
    cloudFetch,
  );
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-run-record-sync-failed', { flow: name, status: result.status, error: result.error });
  }
}

/** The slice of a session the start-path logic reads: the live URL plus the event buffer. */
interface StartPathSession {
  url?: string;
  eventsSince(cursor: number): ReticleEvent[];
}

/**
 * The route the tab is on now: the last observed route.change, falling back to the pathname of the
 * session's own URL. The fallback matters — a tab that hard-loaded its page emits no route event
 * (the route observer only sees pushState/replaceState/popstate), but the HELLO url still names
 * where it sits, and without it a wrong-page replay reported plain drift with no hint at all.
 */
function currentPathOf(session: StartPathSession): string | undefined {
  const routes = session.eventsSince(0).filter((e) => e.type === EventType.ROUTE_CHANGE);
  const data = routes.at(-1)?.data ?? {};
  const observed = asString(data['pathname']) ?? asString(data['to']);
  if (observed !== undefined) return observed;
  if (session.url === undefined) return undefined;
  try {
    return new URL(session.url).pathname;
  } catch {
    return undefined;
  }
}

/** Pathname equality up to a trailing slash — a router normalising one must not read as "elsewhere". */
function samePath(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

/**
 * When a flow records the page its journey started on (`startPath`) and the tab is currently on a
 * different route, step 1 drifts for a reason that has nothing to do with the app regressing — the
 * anchor simply isn't on this page yet. Detect that so the decision says "navigate there first"
 * instead of a mystifying "a step no longer matches". Returns undefined when the routes agree or the
 * current route is unobservable — never a false alarm. Replay normally never gets here on a
 * wrong page (arriveAtStartPath navigates before step 1); this is the fallback for when that
 * navigation was refused or the SDK never reconnected in the window.
 */
export function startPathMismatchHint(
  flow: FlowFile,
  session: StartPathSession,
): string | undefined {
  const startPath = flow.startPath;
  if (startPath === undefined || 0 === startPath.length) return undefined;
  const current = currentPathOf(session);
  if (current === undefined || samePath(current, startPath)) return undefined;
  return `this flow's journey starts on ${startPath} but the tab is on ${current} — navigate there (reticle_navigate { url: "${startPath}" }), then replay`;
}

/** How long replay waits for the SDK to reconnect on the start page before falling back to the hint. */
const START_PATH_ARRIVAL_TIMEOUT_MS = 5_000;
const START_PATH_POLL_MS = 100;

const REAL_ARRIVAL_CLOCK: ArrivalClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The session `oldId` denotes right now — itself, or the tombstone successor `resolve` rebinds to
 * after a full-document navigation — but only once it actually sits on `target`. Undefined while
 * the tab is still travelling (or in the gap between teardown and the successor's HELLO, when
 * `resolve` throws). Keyed to the navigated tab's own identity on purpose: matching "any session at
 * the target page" would happily hand replay an unrelated tab that was already sitting there.
 */
function arrivedSuccessor(
  sessions: SessionManager,
  oldId: string,
  target: string,
): Session | undefined {
  try {
    const candidate = sessions.resolve(oldId);
    const path = currentPathOf(candidate);
    return path !== undefined && samePath(path, target) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replay's half of the FlowFile contract: navigate to the flow's `startPath` before step 1.
 *
 * A full-page load tears down the session socket, so the navigation must happen here — before any
 * step runs — and the replay continues on the session the SDK reconnects as (found via the same
 * tombstone rebind that lets `resolve(oldId)` answer after any navigation). Best-effort by design:
 * when the flow carries no startPath, the tab is already there, the current route is unobservable,
 * the navigation is refused, or the SDK never reconnects in the window, it returns undefined and
 * replay proceeds on the connected session as before — with startPathMismatchHint turning any
 * resulting drift into an actionable next move rather than a mystifying one.
 */
export async function arriveAtStartPath(
  sessions: SessionManager,
  session: StartPathSession & {
    id: string;
    command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  },
  flow: FlowFile,
  timeoutMs: number = START_PATH_ARRIVAL_TIMEOUT_MS,
  clock: ArrivalClock = REAL_ARRIVAL_CLOCK,
): Promise<Session | undefined> {
  const target = flow.startPath;
  if (target === undefined || 0 === target.length) return undefined;
  const current = currentPathOf(session);
  if (current === undefined || samePath(current, target)) return undefined;
  let destination: string;
  try {
    // startPath is a pathname (a host belongs to the machine, not the journey) — resolve it
    // against the tab's own URL to get something the browser can be sent to.
    destination = new URL(target, session.url).toString();
  } catch {
    return undefined; // no usable base URL — nowhere to navigate from
  }
  // A leased tab is addressed by URL params, so navigating without them would strand the lease.
  const url = carryReticleIdentity(session.url, destination);
  try {
    const outcome = await session.command(ReticleCommand.NAVIGATE, { url });
    if (!outcome.ok || true !== asRecord(outcome.result)['ok']) return undefined;
  } catch {
    return undefined;
  }
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const arrived = arrivedSuccessor(sessions, session.id, target);
    if (arrived !== undefined) return arrived;
    if (clock.now() >= deadline) return undefined;
    await clock.sleep(START_PATH_POLL_MS);
  }
}

/**
 * Replay one named flow end to end: load → re-resolve+run each step → assert the success oracle →
 * status + decision. Shared by reticle_flow_replay (single flow) and reticle_flow_verify (whole suite) so
 * both produce identical FlowReplayResults. Every exit path records a run to project.json.
 */
export async function replayNamedFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<FlowReplayResult> {
  const startedAt = deps.now();
  const name = asString(args['flowName']) ?? '';
  // Resolve within the connecting app's scope so a shared daemon replays THIS project's flow, not a
  // same-named flow from another app. Safe-resolve: a missing session degrades to the global store,
  // and the load-then-session order (unchanged) still surfaces a not-found before a no-session error.
  let projectId: string | undefined;
  try {
    projectId = deps.sessions.resolve(asString(args['sessionId'])).projectId;
  } catch {
    projectId = undefined;
  }
  const loaded = await deps.flows.load(name, projectId);
  if (!loaded.ok) {
    await recordReplayRun(deps, name, ReplayStatus.ERROR, 0, deps.now() - startedAt, projectId);
    return {
      name,
      status: ReplayStatus.ERROR,
      steps: [],
      error: { code: loaded.code, message: flowErrorMessage(loaded.code) },
    };
  }
  // What this flow is FOR, from the shared ledger — so a failure can report the business outcome
  // that stopped being true before the step that stopped being green. Undefined when nothing
  // declared one, which the decision then says plainly rather than inventing a goal from step names.
  const intents = new IntentStore(deps.fs, sessionRoot(deps, asString(args['sessionId'])), {
    now: deps.now,
  });
  const intentSaid = await flowIntentStatement(intents, loaded.value);
  const connected = deps.sessions.resolve(asString(args['sessionId']));
  // The FlowFile contract: replay navigates to the flow's startPath before step 1, and the steps run
  // on the session the SDK reconnects as. When arrival can't be confirmed, replay proceeds on the
  // connected session — and the hint below turns the wrong-page drift into an actionable next move.
  const session = (await arriveAtStartPath(deps.sessions, connected, loaded.value)) ?? connected;
  const startPathHint = startPathMismatchHint(loaded.value, session);
  // Floor the success oracle at the start of THIS replay so a stale signal from a prior run
  // in the same session can't fake a pass.
  const replayFloor = session.elapsed();
  const steps = await replayFlow(
    session,
    loaded.value,
    waitForPredicate,
    FLOW_SIGNAL_TIMEOUT_MS,
    true === args['confirmDangerous'],
  );
  // "green means intent satisfied": when every step ran clean, assert the flow's success
  // end-condition as a real consequence. A signal/net success that never fires FAILS the replay
  // even though all locators resolved — the regression a healed-but-wrong locator ships green.
  const stepsClean = steps.length > 0 && steps.every((s) => s.ok && s.drift === undefined);
  if (stepsClean && loaded.value.success !== undefined) {
    const verdict = await assertSuccess(
      session,
      loaded.value.success,
      dynamicTestids(loaded.value),
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      replayFloor,
    );
    const row: FlowStepResult = {
      step: steps.length,
      tool: SUCCESS_STEP_TOOL,
      anchor: successLabel(loaded.value.success),
      ok: verdict.pass,
      ...(verdict.pass ? {} : { error: verdict.failureReason ?? 'flow.success not satisfied' }),
    };
    steps.push(row);
  }
  const driftSteps = steps.filter((s) => s.drift !== undefined).length;
  const allOk = steps.every((s) => s.ok);
  const status = driftSteps > 0 ? ReplayStatus.DRIFT : allOk ? ReplayStatus.OK : ReplayStatus.ERROR;
  await recordReplayRun(deps, name, status, driftSteps, deps.now() - startedAt, projectId);
  // Anti-reward-hacking baseline: record what this flow asserted ONLY when it passed clean. A
  // failing run must never become the baseline a later weakening is measured against.
  if (status === ReplayStatus.OK) {
    await new AssertionTiersStore(deps.fs, deps.reticleRoot).recordPassing(
      name,
      loaded.value.steps.map((s, i) => ({
        step: i,
        ...(s.expect === undefined ? {} : { expect: s.expect }),
      })),
      // Record what this flow COVERS so a later deletion can be scoped to the files that changed.
      toFlowSources([{ name, steps: loaded.value.steps }])[0]?.sources ?? [],
    );
    // The ledger learns what this run proved. Only a flow that COULD have gone red discharges: an
    // assertion-free flow is never bound, and `dischargeIntent` refuses an unbound intent, so the
    // guard here is the cheap half of a rule the ledger already enforces. `grade` is what makes a
    // later weakening visible — an intent re-proved by a weaker flow says so in the git diff.
    if (unverifiableReason(loaded.value) === undefined) {
      const provedAt = deps.now();
      await dischargeFlowIntent(intents, loaded.value, {
        verdictId: flowReplayVerdictId(name, provedAt),
        grade: classifyFlowAssertions(loaded.value).grade,
        at: provedAt,
      });
    }
  }
  // Push-default: the deviation report over this drive's segments, learned across runs. Best-effort.
  const deviation = await computeReplayDeviation(deps, session, replayFloor);
  const failed = steps.find((step) => !step.ok && step.drift === undefined);
  if (failed !== undefined) {
    const errored: FlowReplayResult = {
      name,
      status,
      steps,
      error: { code: ReplayStatus.ERROR, message: failed.error ?? 'flow action failed' },
    };
    errored.decision = buildDecision(errored, loaded.value, intentSaid);
    applyStartPathHint(errored, startPathHint);
    if (deviation !== undefined) errored.deviation = deviation;
    return errored;
  }
  const result: FlowReplayResult = { name, status, steps };
  // A green that cannot go red is not a pass. `reticle_flow_verify` already refuses to count these,
  // via this same function -- a single-flow caller saw a bare `ok` and had no way to learn the flow
  // asserts nothing. Derived from the same helper on purpose: two copies of this judgement would
  // drift, and the sibling tools would then disagree about the same flow.
  const cannotFail = status === ReplayStatus.OK ? unverifiableReason(loaded.value) : undefined;
  if (cannotFail !== undefined) result.unverifiable = { reason: cannotFail };
  if (status !== ReplayStatus.OK) result.decision = buildDecision(result, loaded.value, intentSaid);
  applyStartPathHint(result, startPathHint);
  if (deviation !== undefined) result.deviation = deviation;
  return result;
}

/**
 * The deviation report over a replay's route segments — compared against the learned envelope, which is
 * then updated. Best-effort: any failure (disk, empty window) yields undefined, never breaking the replay.
 */
async function computeReplayDeviation(
  deps: ToolDeps,
  session: { eventsSince(cursor: number): ReticleEvent[] },
  floor: number,
): Promise<DeviationReport | undefined> {
  try {
    const segments = computeSegments(session.eventsSince(floor));
    if (0 === segments.length) return undefined;
    return await reportAndAccumulate(new EnvelopeStore(deps.fs, deps.reticleRoot), segments);
  } catch {
    return undefined;
  }
}

/** Fold a start-page-mismatch hint onto a non-passing replay's decision (the actionable next move). */
function applyStartPathHint(result: FlowReplayResult, hint: string | undefined): void {
  if (hint === undefined || result.decision === undefined) return;
  result.decision.suggestedFix = hint;
  result.decision.nextAction = hint;
}

/**
 * The connecting session's project, or undefined when no browser is attached. Flow tools use it to
 * scope storage to the current app on a shared daemon; resolving must NOT throw here (list/load are
 * documented to work headless), so a missing/unknown session degrades to the global/legacy store.
 */
export function sessionProjectId(
  deps: ToolDeps,
  sessionId: string | undefined,
): string | undefined {
  try {
    return deps.sessions.resolve(sessionId).projectId;
  } catch {
    return undefined;
  }
}
