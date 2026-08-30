import { describe, expect, it } from 'vitest';
import {
  ASSERTED,
  chooseDriver,
  DRIVERS,
  readAssertionsGrade,
  shouldEscalate,
} from './drive-plan.js';

describe('choosing who drives', () => {
  const all =
    (bins: string[], broken: string[] = []) =>
    (bin: string) => ({
      present: bins.includes(bin),
      runs: bins.includes(bin) && !broken.includes(bin),
    });

  it('prefers the first available driver', () => {
    expect(chooseDriver(DRIVERS, all(['claude', 'gemini']))?.id).toBe('claude');
  });

  // A CLI on PATH that does not run produces an empty session which looks exactly like success.
  it('skips a driver that is installed but does not run', () => {
    expect(chooseDriver(DRIVERS, all(['claude', 'gemini'], ['claude']))?.id).toBe('gemini');
  });

  it('has no driver when none is usable', () => {
    expect(chooseDriver(DRIVERS, all(['claude'], ['claude']))).toBeNull();
  });

  it('covers more than one vendor, so the verdict is not withheld over tool choice', () => {
    expect(new Set(DRIVERS.map((d) => d.id)).size).toBeGreaterThan(1);
  });
});

describe('reading the grade out of the drive report', () => {
  it('finds it in the form the drive usually writes', () => {
    expect(readAssertionsGrade('**assertions.grade:** `asserted` (1 consequence step)')).toBe(
      'asserted',
    );
  });

  it('finds a weak grade just as reliably', () => {
    expect(readAssertionsGrade('Flow saved. assertions.grade: presence-only')).toBe(
      'presence-only',
    );
  });

  it('reports nothing when the drive never said', () => {
    expect(readAssertionsGrade('I could not reach the page at all.')).toBeUndefined();
    expect(readAssertionsGrade(undefined)).toBeUndefined();
  });
});

describe('when to re-record instead of accepting the flow', () => {
  const base = {
    escalationEnabled: true,
    fasterModel: 'sonnet',
    flowSaved: true,
    grade: 'presence-only',
  };

  it('re-records a weak flow', () => {
    expect(shouldEscalate(base)).toBe(true);
    expect(shouldEscalate({ ...base, grade: 'assertion-free' })).toBe(true);
  });

  it('leaves an already-asserted flow alone', () => {
    expect(shouldEscalate({ ...base, grade: ASSERTED })).toBe(false);
  });

  // Escalation means retrying WITHOUT the faster model. With no faster model in play there is
  // nothing stronger to retry with, so it would just repeat the same run at the same cost.
  it('does not escalate when no faster model was used', () => {
    expect(shouldEscalate({ ...base, fasterModel: undefined })).toBe(false);
  });

  it('does not escalate when there is no flow to improve', () => {
    expect(shouldEscalate({ ...base, flowSaved: false })).toBe(false);
  });

  it('does not escalate on a grade it could not read, which would be guessing', () => {
    expect(shouldEscalate({ ...base, grade: undefined })).toBe(false);
  });

  it('respects the opt-out', () => {
    expect(shouldEscalate({ ...base, escalationEnabled: false })).toBe(false);
  });
});
