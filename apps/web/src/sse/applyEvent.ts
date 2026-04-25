import {
  type TodoSource,
  UNKNOWN_PROJECT,
  type UpsertSnapshot,
  type WireEvent,
} from '../types/wire.js';

export type TodoFiles = Record<string, UpsertSnapshot>;

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export type StoreState = {
  files: TodoFiles;
  connection: ConnectionState;
  errorMessage: string | null;
  ready: boolean;
};

export const INITIAL_STATE: StoreState = {
  files: {},
  connection: 'connecting',
  errorMessage: null,
  ready: false,
};

function markOpen(connection: ConnectionState): ConnectionState {
  return connection === 'closed' ? connection : 'open';
}

// Defensive defaults for snapshots that pre-date ADR-0004/0005 enrichment.
function fillEnrichment<T extends Partial<UpsertSnapshot>>(
  f: T,
): T & Pick<UpsertSnapshot, 'cwd' | 'gitBranch' | 'project' | 'source'> {
  return {
    ...f,
    cwd: f.cwd ?? null,
    gitBranch: f.gitBranch ?? null,
    project: f.project ?? UNKNOWN_PROJECT,
    source: (f.source as TodoSource | undefined) ?? 'todos',
  };
}

export function applyEvent(prev: StoreState, ev: WireEvent): StoreState {
  switch (ev.kind) {
    case 'snapshot': {
      const files: TodoFiles = {};
      for (const f of ev.files) files[f.path] = fillEnrichment(f) as UpsertSnapshot;
      return {
        ...prev,
        files,
        connection: markOpen(prev.connection),
        errorMessage: null,
        ready: false,
      };
    }
    case 'upsert': {
      const existing = prev.files[ev.path];
      if (
        existing &&
        existing.mtimeMs === ev.mtimeMs &&
        existing.cwd === ev.cwd &&
        existing.gitBranch === ev.gitBranch &&
        existing.project === ev.project &&
        existing.source === ev.source
      ) {
        return prev;
      }
      return {
        ...prev,
        files: {
          ...prev.files,
          [ev.path]: {
            meta: ev.meta,
            path: ev.path,
            items: ev.items,
            mtimeMs: ev.mtimeMs,
            cwd: ev.cwd,
            gitBranch: ev.gitBranch,
            project: ev.project,
            source: ev.source,
          },
        },
        connection: markOpen(prev.connection),
      };
    }
    case 'remove': {
      if (!(ev.path in prev.files)) return prev;
      const nextFiles = { ...prev.files };
      delete nextFiles[ev.path];
      return { ...prev, files: nextFiles, connection: markOpen(prev.connection) };
    }
    case 'error':
      return {
        ...prev,
        errorMessage: `${ev.reason}: ${ev.message}`,
        connection: markOpen(prev.connection),
      };
    case 'ready':
      return { ...prev, ready: true, connection: markOpen(prev.connection) };
  }
}
