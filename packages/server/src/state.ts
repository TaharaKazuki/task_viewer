import type { TodoFileMeta, TodoItem } from '@task-viewer/core';
import type { EnrichedTodoFileEvent, TodoSource } from './enrich.js';

export type UpsertSnapshot = {
  meta: TodoFileMeta;
  path: string;
  items: readonly TodoItem[];
  mtimeMs: number;
  cwd: string | null;
  gitBranch: string | null;
  project: string;
  source: TodoSource;
};

export class StateStore {
  private readonly map = new Map<string, UpsertSnapshot>();
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
        source: ev.source,
      });
      return;
    }
    if (ev.kind === 'remove') {
      const previous = this.map.get(ev.path);
      if (previous) this.unindex(previous.meta.sessionId, ev.path);
      this.map.delete(ev.path);
      return;
    }
  }

  snapshot(): readonly UpsertSnapshot[] {
    return Array.from(this.map.values());
  }

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
