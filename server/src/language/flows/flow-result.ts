import { FlowErrorCode } from '@reticlehq/core';
import { isValidFlowName } from '@/memory/project/dir/reticle-dir.js';

/** Discriminated result so callers never branch on free strings. */
export type FlowResult<T> =
  { ok: true; value: T } | { ok: false; code: FlowErrorCode; detail?: string };

/**
 * A project id that is safe to put in a path, or nothing.
 *
 * An unsafe or absent value collapses to `undefined` — the flat, global store — so a malformed id
 * can never escape `.reticle/flows/`. The store defends the disk boundary itself rather than
 * trusting whatever arrived in a session's HELLO.
 */
export const safeProjectId = (projectId?: string): string | undefined =>
  projectId !== undefined && isValidFlowName(projectId) ? projectId : undefined;
