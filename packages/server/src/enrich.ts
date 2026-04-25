import type { TodoFileEvent, TodoFileMeta, TodoItem } from '@task-viewer/core';
import type { SessionInfo } from './sessionIndex.js';

export const UNKNOWN_PROJECT = '(Unknown)';

// Identifies which underlying watcher produced the event so the UI can
// render a small badge on each card. ADR-0005.
export type TodoSource = 'todos' | 'jsonl';

export type UpsertEnriched = {
  kind: 'upsert';
  meta: TodoFileMeta;
  path: string;
  items: TodoItem[];
  mtimeMs: number;
  cwd: string | null;
  gitBranch: string | null;
  project: string;
  source: TodoSource;
};

export type EnrichedTodoFileEvent =
  | { kind: 'ready' }
  | UpsertEnriched
  | Extract<TodoFileEvent, { kind: 'remove' }>
  | Extract<TodoFileEvent, { kind: 'error' }>;

export function enrich(
  ev: TodoFileEvent,
  info: SessionInfo | null,
  source: TodoSource,
): EnrichedTodoFileEvent {
  if (ev.kind !== 'upsert') return ev;
  return {
    kind: 'upsert',
    meta: ev.meta,
    path: ev.path,
    // Copy-on-write: break the alias back to core's parsed array.
    items: [...ev.items],
    mtimeMs: ev.mtimeMs,
    cwd: info?.cwd ?? null,
    gitBranch: info?.gitBranch ?? null,
    project: info?.project ?? UNKNOWN_PROJECT,
    source,
  };
}
