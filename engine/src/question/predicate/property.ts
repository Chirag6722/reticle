import { z } from 'zod';

/**
 * Assert a PROPERTY of an observed value rather than its exact bytes.
 *
 * Every predicate this engine had compared for equality, and equality cannot express the one thing
 * a generative feature needs: an app whose output IS a model's output is different on every run and
 * correct on every one of them. `equals: "Paris is the capital of France"` fails the next run for
 * the right answer. "a non-empty string matching /Paris/" holds for every right answer and fails
 * for an empty one, a stack trace, or a spinner that never resolved.
 *
 * DETERMINISM is the discipline, and it is not negotiable. Every property here is decided by this
 * function alone — no model, no network, no clock. "Ask a model whether the output looks right" is
 * the obvious next idea and it is the one that must not be built: it makes the verdict
 * unfalsifiable, which is precisely what `no-fault` exists to name instead of paper over.
 *
 * A failing check always says why. An assertion that reports only `false` sends the reader back for
 * another call to find out what it saw, and that round trip is most of what a verdict costs.
 */

export type PropertyAssertion =
  /** Produced something at all — the honest floor for any generated output. */
  | { readonly property: 'nonEmpty' }
  /** A classification landed inside the allowed set. Exact membership, no coercion. */
  | { readonly property: 'oneOf'; readonly values: readonly unknown[] }
  /** A number near enough to an expected one — inclusive on the bound. */
  | { readonly property: 'withinTolerance'; readonly of: number; readonly tolerance: number }
  /** The shape of the output, as a regular expression over its string form. */
  | { readonly property: 'matchesPattern'; readonly pattern: string }
  /** The right KIND of thing: `array` and `object` are distinguished, which `typeof` cannot do. */
  | {
      readonly property: 'type';
      readonly is: 'string' | 'number' | 'boolean' | 'array' | 'object';
    };

export interface PropertyResult {
  readonly ok: boolean;
  /** Why, in the words a reader needs — always present, on pass and on fail. */
  readonly because: string;
}

/**
 * A short, readable rendering of any observed value.
 *
 * Never `String(value)` on an unknown: an object stringifies to `[object Object]`, which tells the
 * reader nothing and looks like a real reading. A value JSON cannot encode (a cycle, a BigInt, a
 * function) is named by its TYPE instead, because "cyclic object" is a fact and "[object Object]"
 * is noise wearing the shape of one.
 */
const show = (value: unknown): string => {
  if (undefined === value) return 'undefined';
  if (null === value) return 'null';
  if ('string' === typeof value) return JSON.stringify(value).slice(0, 80);
  if ('number' === typeof value || 'boolean' === typeof value || 'bigint' === typeof value) {
    return String(value);
  }
  try {
    const encoded = JSON.stringify(value);
    return undefined === encoded ? `<${typeof value}>` : encoded.slice(0, 80);
  } catch {
    return Array.isArray(value) ? '<cyclic array>' : '<cyclic object>';
  }
};

function isNonEmpty(value: unknown): boolean {
  if (null === value || undefined === value) return false;
  if ('string' === typeof value) return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if ('object' === typeof value) return Object.keys(value).length > 0;
  // A number or boolean is a value that exists; 0 and false are not "empty".
  return true;
}

function typeOf(value: unknown): string {
  if (null === value) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function satisfiesProperty(value: unknown, assertion: PropertyAssertion): PropertyResult {
  switch (assertion.property) {
    case 'nonEmpty': {
      const ok = isNonEmpty(value);
      return {
        ok,
        because: ok
          ? `produced ${typeOf(value)} ${show(value)}`
          : `expected something, got ${show(value)} — an empty result is the failure mode a generated feature actually has`,
      };
    }
    case 'oneOf': {
      const ok = assertion.values.some((v) => Object.is(v, value));
      return {
        ok,
        because: ok
          ? `${show(value)} is in the allowed set`
          : `${show(value)} is not one of ${show(assertion.values)}`,
      };
    }
    case 'withinTolerance': {
      if ('number' !== typeof value || !Number.isFinite(value)) {
        return {
          ok: false,
          because: `expected a finite number within ${String(assertion.tolerance)} of ${String(assertion.of)}, got ${typeOf(value)} ${show(value)} — not coerced, because "100" and 100 are different answers`,
        };
      }
      const delta = Math.abs(value - assertion.of);
      const ok = delta <= assertion.tolerance;
      return {
        ok,
        because: `${String(value)} is ${String(delta)} from ${String(assertion.of)} (tolerance ${String(assertion.tolerance)})`,
      };
    }
    case 'matchesPattern': {
      let re: RegExp;
      try {
        re = new RegExp(assertion.pattern);
      } catch {
        // Never report a broken check as a real negative: that is the false-green shape in miniature.
        return {
          ok: false,
          because: `"${assertion.pattern}" is not a valid regular expression, so nothing was tested — fix the pattern; this is not a result about the app`,
        };
      }
      const text = 'string' === typeof value ? value : show(value);
      const ok = re.test(text);
      return {
        ok,
        because: ok
          ? `${show(text)} matches /${assertion.pattern}/`
          : `${show(text)} does not match /${assertion.pattern}/`,
      };
    }
    case 'type': {
      const actual = typeOf(value);
      const ok = actual === assertion.is;
      return {
        ok,
        because: ok ? `is ${actual}` : `expected ${assertion.is}, got ${actual} ${show(value)}`,
      };
    }
  }
}

/**
 * The wire shape of a property assertion.
 *
 * Lives here beside the evaluator on purpose: a schema in one file and the switch that consumes it
 * in another is how a new property comes to parse and then silently never match.
 */
export const propertyAssertionSchema = z.discriminatedUnion('property', [
  z.object({ property: z.literal('nonEmpty') }).strict(),
  z.object({ property: z.literal('oneOf'), values: z.array(z.unknown()).min(1) }).strict(),
  z
    .object({
      property: z.literal('withinTolerance'),
      of: z.number().finite(),
      tolerance: z.number().finite().nonnegative(),
    })
    .strict(),
  z.object({ property: z.literal('matchesPattern'), pattern: z.string().min(1) }).strict(),
  z
    .object({
      property: z.literal('type'),
      is: z.enum(['string', 'number', 'boolean', 'array', 'object']),
    })
    .strict(),
]);
