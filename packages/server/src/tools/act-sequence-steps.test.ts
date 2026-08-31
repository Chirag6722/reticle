/**
 * A sequence that cannot act must say so, not report success.
 *
 * `steps` is a bare array of objects. A step with neither `ref` nor `target` used to dispatch as
 * `ref: ''` and fail with a stale-ref diagnosis. `target` is accepted — it is the same locator
 * `reticle_act` takes — and a step that names neither is still refused before the first dispatch,
 * so a typo in step three cannot leave one and two applied.
 */
import { describe, expect, it } from 'vitest';
import { assertSequenceSteps } from './act-preflight.js';
import { describeStepResult } from './act-sequence-retry.js';

describe('refusing a sequence that cannot act', () => {
  it('accepts a step written with `target` instead of `ref`', () => {
    expect(() =>
      assertSequenceSteps([{ target: { testid: 'auth-email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('accepts a mixed sequence of refs and targets', () => {
    expect(() =>
      assertSequenceSteps([
        { target: { label: 'Email' }, action: 'fill' },
        { ref: 'e2', action: 'fill' },
        { target: { testid: 'submit' }, action: 'click' },
      ]),
    ).not.toThrow();
  });

  it('names WHICH step is wrong', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill' },
        { ref: 'e2', action: 'fill' },
        { action: 'click' },
      ]),
    ).toThrow(/step 2/);
  });

  it('refuses the WHOLE sequence, so a bad step three cannot leave one and two applied', () => {
    // Checked before the first dispatch. Half a journey is worse than none: the page has moved and
    // nothing says how far.
    expect(() => assertSequenceSteps([{ ref: 'e1', action: 'fill' }, { action: 'click' }])).toThrow(
      /Nothing was acted on/,
    );
  });

  it('refuses an empty step list rather than reporting a successful no-op', () => {
    expect(() => assertSequenceSteps([])).toThrow(/no steps/);
  });

  it('refuses a step with an empty ref and no target', () => {
    expect(() => assertSequenceSteps([{ ref: '', action: 'click' }])).toThrow(
      /no `ref` or `target`/,
    );
  });

  it('accepts an empty ref when a target is present', () => {
    // resolveActTarget treats an empty ref as missing and falls through to target.
    expect(() =>
      assertSequenceSteps([{ ref: '', target: { label: 'Email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('refuses junk in the steps array', () => {
    for (const junk of [null, 'a step', 42, []]) {
      expect(() => assertSequenceSteps([junk]), JSON.stringify(junk)).toThrow();
    }
  });

  it('accepts a well-formed sequence', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e2', action: 'click' },
      ]),
    ).not.toThrow();
  });
});

describe('what a step reports', () => {
  it('falls back to the step’s own ref and action when the act did not echo them', () => {
    const out = describeStepResult({ ref: 'e1', action: 'fill' }, {});
    expect(out['ref']).toBe('e1');
    expect(out['action']).toBe('fill');
  });

  it('prefers what the act actually reported', () => {
    const out = describeStepResult({ ref: 'e1', action: 'fill' }, { ref: 'e9', action: 'type' });
    expect(out['ref']).toBe('e9');
    expect(out['action']).toBe('type');
  });

  it('omits fields the act did not produce, rather than filling a row with nulls', () => {
    // A row of nulls reads as "we looked and found nothing" instead of "there was nothing to look for".
    const out = describeStepResult({ ref: 'e1', action: 'click' }, {});
    expect('testid' in out).toBe(false);
    expect('warning' in out).toBe(false);
  });

  it('carries the identifying fields when they are there', () => {
    const out = describeStepResult(
      { ref: 'e1', action: 'click' },
      { testid: 'submit', role: 'button', name: 'Sign In', source: 'src/x.tsx:1' },
    );
    expect(out['testid']).toBe('submit');
    expect(out['name']).toBe('Sign In');
  });
});
