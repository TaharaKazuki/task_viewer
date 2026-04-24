import type { UpsertSnapshot, WireEvent } from '../types/wire.js';

export type TodoFiles = Record<string, UpsertSnapshot>;

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export type StoreState = {
  files: TodoFiles;
  connection: ConnectionState;
  errorMessage: string | null;
  // True once the server has sent its 'ready' signal since the last snapshot.
  ready: boolean;
};

export const INITIAL_STATE: StoreState = {
  files: {},
  connection: 'connecting',
  errorMessage: null,
  ready: false,
};

// Any incoming data event implies the connection is open, regardless of
// whether the browser has fired its 'open' event yet (Firefox has been
// observed to deliver buffered messages before 'open' resolves).
function markOpen(connection: ConnectionState): ConnectionState {
  return connection === 'closed' ? connection : 'open';
}

export function applyEvent(prev: StoreState, ev: WireEvent): StoreState {
  switch (ev.kind) {
    case 'snapshot': {
      const files: TodoFiles = {};
      for (const f of ev.files) files[f.path] = f;
      // Snapshot is the authoritative "fresh start" signal — also after
      // auto-reconnect — so we clear transient diagnostics here.
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
      if (existing && existing.mtimeMs === ev.mtimeMs) {
        // Same revision; short-circuit to avoid re-rendering subscribers on
        // duplicate-delivery (which is expected per ADR-0002 subscribe-first).
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
