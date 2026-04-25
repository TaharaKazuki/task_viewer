import type { TodoFileEvent, TodoFileMeta, TodoItem } from '@task-viewer/core';
import type { SessionInfo } from './sessionIndex.js';

export const UNKNOWN_PROJECT = '(Unknown)';

export type UpsertEnriched = {
  kind: 'upsert';
  meta: TodoFileMeta;
  path: string;
  items: TodoItem[];
  mtimeMs: number;
  cwd: string | null;
  gitBranch: string | null;
  project: string;
};

// Server-side enriched event union. Upsert carries session metadata
// resolved via SessionIndex. Other event kinds pass through unchanged.
export type EnrichedTodoFileEvent =
  | { kind: 'ready' }
  | UpsertEnriched
  | Extract<TodoFileEvent, { kind: 'remove' }>
  | Extract<TodoFileEvent, { kind: 'error' }>;

export function enrich(ev: TodoFileEvent, info: SessionInfo | null): EnrichedTodoFileEvent {
  if (ev.kind !== 'upsert') return ev;
  return {
    kind: 'upsert',
    meta: ev.meta,
    path: ev.path,
    // Copy-on-write: break the alias back to core's parsed array so any
    // later mutation of the stored snapshot (unlikely but possible in
    // future refactors) does not bleed into other consumers holding the
    // original event reference.
    items: [...ev.items],
    mtimeMs: ev.mtimeMs,
    cwd: info?.cwd ?? null,
    gitBranch: info?.gitBranch ?? null,
    project: info?.project ?? UNKNOWN_PROJECT,
  };
}
