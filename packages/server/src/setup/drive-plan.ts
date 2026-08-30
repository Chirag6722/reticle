/**
 * Who drives the app, and whether what they left behind is worth keeping.
 *
 * The drive is the only part of setup that needs a model, and the only part that can succeed
 * expensively and leave something worthless. Both of those are decisions, so both live here where
 * they can be tested without spending anything.
 */

/** An agent CLI that can be asked to drive, in preference order. */
export interface DriverSpec {
  readonly id: string;
  readonly bin: string;
  /** How its prompt is delivered. Gemini takes it as a flag value; the rest read stdin. */
  readonly promptVia: 'stdin' | 'arg';
}

/**
 * Preference order. Restricting this to one CLI meant a Cursor or Codex user got a connected app
 * and no verdict at all: the whole point of the install, withheld over which tool they happen to
 * use.
 */
export const DRIVERS: readonly DriverSpec[] = [
  { id: 'claude', bin: 'claude', promptVia: 'stdin' },
  { id: 'opencode', bin: 'opencode', promptVia: 'stdin' },
  { id: 'cursor-agent', bin: 'cursor-agent', promptVia: 'stdin' },
  { id: 'gemini', bin: 'gemini', promptVia: 'arg' },
];

/**
 * The first driver that is present AND runs.
 *
 * The second half is the one that has bitten: a CLI can be on PATH and broken — a half-installed
 * codex whose vendor binary is missing exits non-zero on every invocation — and driving with one of
 * those produces an empty session that looks exactly like success.
 */
export function chooseDriver(
  drivers: readonly DriverSpec[],
  probe: (bin: string) => { readonly present: boolean; readonly runs: boolean },
): DriverSpec | null {
  for (const d of drivers) {
    const { present, runs } = probe(d.bin);
    if (present && runs) return d;
  }
  return null;
}

/** The grade `reticle_flow_save` reported, read out of the drive's own prose. */
export function readAssertionsGrade(text: string | undefined): string | undefined {
  const source = text ?? '';
  return (
    /assertions?\.?grade\W+`?([a-z-]+)/i.exec(source)?.[1] ??
    /grade\W+`?([a-z-]+)/i.exec(source)?.[1]
  );
}

/** The only grade that makes a saved flow worth replaying. */
export const ASSERTED = 'asserted';

export interface EscalationInput {
  readonly escalationEnabled: boolean;
  /** Set only when a faster model was chosen, since escalation means retrying without it. */
  readonly fasterModel: string | undefined;
  readonly flowSaved: boolean;
  readonly grade: string | undefined;
}

/**
 * Whether to re-record with the stronger model.
 *
 * Measured: a faster model reaches the same `verified: "yes"` about three times quicker and leaves
 * an `assertion-free` or `presence-only` flow in three runs out of four. Such a flow only ACTS, so
 * it passes even when the feature is broken — and setup replays saved flows on every later run,
 * which turns one weak recording into a permanent green. Presenting that as a trade for the user to
 * choose is worse than spending a second drive on it.
 */
export function shouldEscalate(input: EscalationInput): boolean {
  if (!input.escalationEnabled) return false;
  if (undefined === input.fasterModel) return false;
  if (!input.flowSaved) return false;
  if (undefined === input.grade) return false;
  return ASSERTED !== input.grade;
}
