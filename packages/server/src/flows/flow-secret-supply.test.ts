import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  asRef,
  type CommandResult,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { asRecord, asString } from '../tools/tools-helpers.js';
import { REDACTED_FILL } from './flows.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { replayActionArgs } from './replay.js';

/**
 * Supplying at replay the secret that was redacted at save.
 *
 * Redacting the password out of a git-checked flow is only half a fix. The other half is that
 * sign-in still has to REPLAY — a flow that drifts at step two forever because its own credential
 * was removed is a flow nobody keeps, and a team that cannot replay sign-in cannot replay anything
 * behind it.
 *
 * So the value comes from the environment at replay time: the one place a secret can live that is
 * neither the repository nor our database.
 */

const KEY = 'RETICLE_SECRET_AUTH_PASSWORD';
const ROLE_KEY = 'RETICLE_SECRET_PASSWORD';

afterEach(() => {
  delete process.env[KEY];
  delete process.env[ROLE_KEY];
  delete process.env['RETICLE_SECRET_API_KEY'];
});

describe('a redacted fill at replay time', () => {
  it('is filled from the environment variable named after its field', () => {
    process.env[KEY] = 'the-real-password';
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'auth-password');
    expect(args['value']).toBe('the-real-password');
  });

  /**
   * Left as the placeholder rather than blanked. The replay then fails at the login form with the
   * placeholder visible on screen, which names its own fix — an empty field fails identically and
   * tells the reader nothing.
   */
  it('stays the placeholder when nothing supplies it', () => {
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'auth-password');
    expect(args['value']).toBe(REDACTED_FILL);
  });

  /** An ordinary recorded value is never touched, whatever the environment holds. */
  it('leaves a non-redacted value exactly as recorded', () => {
    process.env[KEY] = 'the-real-password';
    const args = replayActionArgs({ value: 'checkout total' }, false, 'auth-password');
    expect(args['value']).toBe('checkout total');
  });

  /** Field names become env keys predictably, or nobody can guess what to set. */
  it('maps a dashed field name onto a SCREAMING_SNAKE variable', () => {
    process.env['RETICLE_SECRET_API_KEY'] = 'rk_live_x';
    const args = replayActionArgs({ value: REDACTED_FILL }, false, 'api-key');
    expect(args['value']).toBe('rk_live_x');
  });
});

/**
 * Substitution used to fire on the testid runner only. A role-anchored fill, and every sub-step
 * of an act_sequence, called `replayActionArgs` without the field name, so a login recorded against
 * role+name typed the literal placeholder and the app answered 401.
 */
class CapturingSession implements FlowReplaySession {
  readonly fills: unknown[] = [];

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (ReticleCommand.QUERY === name) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements: [
            {
              ref: asRef('e1'),
              role: asString(args['value']) ?? 'textbox',
              name: asString(args['name']) ?? 'Password',
              states: [],
              visible: true,
            },
          ],
        },
      });
    }
    if (ReticleCommand.ACT === name) {
      this.fills.push(asRecord(args['args'])['value']);
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
    }
    if (ReticleCommand.ACT_SEQUENCE === name) {
      const steps = Array.isArray(args['steps']) ? args['steps'] : [];
      for (const step of steps) {
        this.fills.push(asRecord(asRecord(step)['args'])['value']);
      }
      return Promise.resolve({ kind: 'command_result', id: 's', ok: true, result: {} });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(): never[] {
    return [];
  }

  onEvent(): () => void {
    return () => undefined;
  }

  elapsed(): number {
    return 0;
  }
}

function wait(): Promise<{ pass: boolean }> {
  return Promise.resolve({ pass: true });
}

function file(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'sign-in', createdAt: 0, steps };
}

describe('every replay path supplies a redacted fill from the environment', () => {
  it('a role-anchored fill is substituted, not typed as the placeholder', async () => {
    process.env[ROLE_KEY] = 'the-real-password';
    const session = new CapturingSession();
    await replayFlow(
      session,
      file([
        {
          tool: ReticleTool.ACT,
          anchor: { kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' },
          action: ActionType.FILL,
          args: { value: REDACTED_FILL },
        },
      ]),
      wait,
      60,
    );
    expect(session.fills).toEqual(['the-real-password']);
  });

  it('a testid-anchored fill still substitutes (the path that already worked)', async () => {
    process.env[KEY] = 'the-real-password';
    const session = new CapturingSession();
    await replayFlow(
      session,
      file([
        {
          tool: ReticleTool.ACT,
          anchor: { kind: AnchorKind.TESTID, value: 'auth-password' },
          action: ActionType.FILL,
          args: { value: REDACTED_FILL },
        },
      ]),
      wait,
      60,
    );
    expect(session.fills).toEqual(['the-real-password']);
  });

  it('each act_sequence sub-step is substituted from its own anchor', async () => {
    process.env[ROLE_KEY] = 'the-real-password';
    process.env[KEY] = 'the-real-password';
    const session = new CapturingSession();
    await replayFlow(
      session,
      file([
        {
          tool: ReticleTool.ACT_SEQUENCE,
          anchor: { kind: AnchorKind.ROLE, role: 'form', name: 'login' },
          steps: [
            {
              tool: ReticleTool.ACT,
              anchor: { kind: AnchorKind.ROLE, role: 'textbox', name: 'Password' },
              action: ActionType.FILL,
              args: { value: REDACTED_FILL },
            },
            {
              tool: ReticleTool.ACT,
              anchor: { kind: AnchorKind.TESTID, value: 'auth-password' },
              action: ActionType.FILL,
              args: { value: REDACTED_FILL },
            },
          ],
        },
      ]),
      wait,
      60,
    );
    expect(session.fills).toEqual(['the-real-password', 'the-real-password']);
  });
});
