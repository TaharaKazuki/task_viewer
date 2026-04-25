import type { TodoFileMeta, TodoItem } from '@task-viewer/core';
import type { EnrichedTodoFileEvent } from './enrich.js';

export type UpsertSnapshot = {
  meta: TodoFileMeta;
  path: string;
  // readonly: mutations on the snapshot returned by StateStore.snapshot()
  // must not corrupt store state.
  items: readonly TodoItem[];
  mtimeMs: number;
  cwd: string | null;
  gitBranch: string | null;
  project: string;
};

export class StateStore {
  private readonly map = new Map<string, UpsertSnapshot>();
  // Inverted index: sessionId → set of paths. Built so the session pump can
  // find affected files in O(k) instead of scanning the full state every
  // discovered event (pre-fix complexity: O(files × discovered-events)).
  private readonly pathsBySessionId = new Map<string, Set<string>>();

  apply(ev: EnrichedTodoFileEvent): void {
    if (ev.kind === 'upsert') {
      const previous = this.map.get(ev.path);
      if (previous && previous.meta.sessionId !== ev.meta.sessionId) {
        this.unindex(previous.meta.sessionId, ev.path);
      }
      this.index(ev.meta.sessionId, ev.path);
      this.map.set(ev.path, {
        meta: ev.meta,
        path: ev.path,
        items: ev.items,
        mtimeMs: ev.mtimeMs,
        cwd: ev.cwd,
        gitBranch: ev.gitBranch,
        project: ev.project,
      });
      return;
    }
    if (ev.kind === 'remove') {
      const previous = this.map.get(ev.path);
      if (previous) this.unindex(previous.meta.sessionId, ev.path);
      this.map.delete(ev.path);
      return;
    }
    // ready / error: notifications, not state transitions
  }

  snapshot(): readonly UpsertSnapshot[] {
    return Array.from(this.map.values());
  }

  // O(k) lookup: return all UpsertSnapshots associated with a sessionId.
  // Used by the session pump to re-emit enrichment when a session's JSONL is
  // discovered after its todo was already registered.
  pathsForSession(sessionId: string): UpsertSnapshot[] {
    const paths = this.pathsBySessionId.get(sessionId);
    if (!paths) return [];
    const out: UpsertSnapshot[] = [];
    for (const p of paths) {
      const snap = this.map.get(p);
      if (snap) out.push(snap);
    }
    return out;
  }

  size(): number {
    return this.map.size;
  }

  private index(sessionId: string, p: string): void {
    let set = this.pathsBySessionId.get(sessionId);
    if (!set) {
      set = new Set();
      this.pathsBySessionId.set(sessionId, set);
    }
    set.add(p);
  }

  private unindex(sessionId: string, p: string): void {
    const set = this.pathsBySessionId.get(sessionId);
    if (!set) return;
    set.delete(p);
    if (set.size === 0) this.pathsBySessionId.delete(sessionId);
  }
}
