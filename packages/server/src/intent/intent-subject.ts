/**
 * What an intent is ABOUT — the key the store shards on, and the thing that makes it retrievable.
 *
 * `.reticle/intent.json` reached 141 entries and 109KB as one object. That is not expensive to
 * parse; it is expensive to READ, which is the operation that matters here. An agent that wants the
 * two rules about checkout has to pull 139 irrelevant ones through its context to find them, and an
 * agent that wants to change one has to rewrite the whole file.
 *
 * Sharding by subject fixes both, but only if the subject is DERIVABLE. A store that requires every
 * caller to invent a category is one where everything lands in whatever the first caller typed. So
 * the subject is inferred from evidence the intent already carries, in falling order of reliability:
 *
 *   1. an explicit subject, when the caller knows one
 *   2. the flow it belongs to — the strongest signal, because a flow IS a feature
 *   3. the route it touches, which is how the product is navigated and therefore how it is discussed
 *   4. the API path its binding asserts on, which names the domain even when the UI does not
 *   5. failing all of that, a single shared bucket — visibly unsorted rather than silently misfiled
 *
 * Nothing here guesses from prose. A statement is a sentence written for a human, and clustering
 * sentences is exactly the kind of plausible-looking inference that puts "sign-in works" under
 * `settings` and leaves nobody able to explain why.
 */

/** Where an intent goes when nothing about it says where it belongs. Deliberately obvious. */
export const UNSORTED_SUBJECT = 'unsorted';

/** The longest a subject may be. It is a filename, and it is read in a directory listing. */
const MAX_SUBJECT = 40;

/** Shape enough of an intent to derive a subject, without importing the whole record. */
export interface SubjectEvidence {
  subject?: string | undefined;
  surface?: { route?: string | undefined; flow?: string | undefined } | undefined;
  binding?: unknown;
}

/** A filesystem- and URL-safe slug. Same rules as a project id, for the same reasons. */
export const slugifySubject = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SUBJECT)
    .replace(/-+$/g, '');
  return 0 === slug.length ? UNSORTED_SUBJECT : slug;
};

/** The first path segment of a route or URL — `/issues?x=1` and `/v1/issues` both give `issues`. */
const firstSegment = (path: string): string | undefined => {
  const clean = path.split(/[?#]/)[0] ?? '';
  for (const part of clean.split('/')) {
    // Skip empties, the API version prefix, and anything that is plainly an id rather than a name.
    if ('' === part || /^v\d+$/i.test(part) || /^\d+$/.test(part)) continue;
    /*
     * A QUERY FRAGMENT is not a path segment.
     *
     * A `net` predicate's `urlContains` is frequently a filter rather than a URL —
     * `category=vulnerability%2Csevere`, `projectId=storefront` — and with no `?` to split on, the
     * whole thing survived as a "path" and was slugified into a subject. Measured on a real corpus:
     * six of thirty-four subjects were query values, one record each, and together they made the
     * coverage map read as a product with two dozen tiny unrelated areas.
     *
     * Skipped rather than aborting the walk, so a binding that asserts a filter AND a route still
     * finds the route.
     */
    if (part.includes('=') || part.includes('&')) continue;
    return part;
  }
  return undefined;
};

/** Walk a binding predicate tree for the first route or URL it mentions. */
const fromBinding = (binding: unknown): string | undefined => {
  if (typeof binding !== 'object' || null === binding) return undefined;
  const node = binding as Record<string, unknown>;
  const direct = node['pathname'] ?? node['urlContains'] ?? node['path'];
  if ('string' === typeof direct) {
    const seg = firstSegment(direct);
    if (seg !== undefined) return seg;
  }
  const nested = node['predicates'] ?? node['of'];
  if (Array.isArray(nested)) {
    for (const child of nested) {
      const found = fromBinding(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/**
 * The subject for one intent, by the ladder above.
 *
 * Total: it always returns something, because a store that can refuse to place a record is a store
 * that loses records.
 */
export const subjectFor = (evidence: SubjectEvidence): string => {
  const explicit = evidence.subject;
  if ('string' === typeof explicit && explicit.trim() !== '') return slugifySubject(explicit);

  const flow = evidence.surface?.flow;
  if ('string' === typeof flow && flow.trim() !== '') return slugifySubject(flow);

  const route = evidence.surface?.route;
  if ('string' === typeof route) {
    const seg = firstSegment(route);
    if (seg !== undefined) return slugifySubject(seg);
  }

  const bound = fromBinding(evidence.binding);
  if (bound !== undefined) return slugifySubject(bound);

  return UNSORTED_SUBJECT;
};
