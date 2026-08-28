/**
 * Where an intent files itself, and why it is inferred rather than asked for.
 *
 * The real corpus this was built against: 141 intents in one 109KB object, of which FOUR carried a
 * surface. So the common case is an intent whose only structural evidence is the predicate it is
 * bound to, and a scheme that needs a caller-supplied category would put 137 of them in one pile.
 */
import { describe, expect, it } from 'vitest';
import { slugifySubject, subjectFor, UNSORTED_SUBJECT } from './intent-subject.js';

describe('the subject ladder', () => {
  it('takes an explicit subject over everything else', () => {
    expect(subjectFor({ subject: 'Checkout', surface: { flow: 'sign-in' } })).toBe('checkout');
  });

  it('prefers the flow, because a flow IS a feature', () => {
    expect(subjectFor({ surface: { flow: 'triage-queue', route: '/settings' } })).toBe(
      'triage-queue',
    );
  });

  it('falls back to the route, which is how the product is navigated and discussed', () => {
    expect(subjectFor({ surface: { route: '/issues?status=open' } })).toBe('issues');
  });

  it('reads the API path out of a binding when the UI says nothing', () => {
    // The common case in the real corpus: no surface at all, but a predicate naming an endpoint.
    expect(
      subjectFor({ binding: { kind: 'net', urlContains: '/v1/auth/signin', status: 200 } }),
    ).toBe('auth');
  });

  it('walks a nested predicate tree to find one', () => {
    expect(
      subjectFor({
        binding: {
          kind: 'allOf',
          predicates: [
            { kind: 'element', testid: 'x' },
            { kind: 'route', pathname: '/billing' },
          ],
        },
      }),
    ).toBe('billing');
  });

  it('never mistakes a version prefix or an id for a name', () => {
    expect(subjectFor({ binding: { kind: 'net', urlContains: '/v1/orders/42' } })).toBe('orders');
  });

  it('files the genuinely unplaceable somewhere visible, not somewhere plausible', () => {
    // Deliberately NOT inferred from prose: clustering sentences is how "sign-in works" ends up
    // under settings with nobody able to say why.
    expect(subjectFor({})).toBe(UNSORTED_SUBJECT);
    expect(subjectFor({ binding: { kind: 'element', testid: 'submit' } })).toBe(UNSORTED_SUBJECT);
  });

  it('always returns something — a store that can refuse a record loses records', () => {
    for (const e of [{}, { subject: '' }, { subject: '///' }, { surface: {} }]) {
      expect(subjectFor(e).length).toBeGreaterThan(0);
    }
  });
});

describe('the slug is a filename somebody reads in a listing', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifySubject('Sign In Flow')).toBe('sign-in-flow');
  });

  it('caps length without leaving a trailing hyphen', () => {
    const s = slugifySubject(`${'a'.repeat(38)} tail`);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
});
