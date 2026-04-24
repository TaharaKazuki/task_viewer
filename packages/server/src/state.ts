import type { TodoFileEvent, TodoFileMeta, TodoItem } from '@task-viewer/core';

export type UpsertSnapshot = {
  meta: TodoFileMeta;
  path: string;
  // readonly: mutations on the snapshot returned by StateStore.snapshot()
  // must not corrupt store state.
  items: readonly TodoItem[];
  mtimeMs: number;
};

export class StateStore {
  private readonly map = new Map<string, UpsertSnapshot>();

  apply(ev: TodoFileEvent): void {
    if (ev.kind === 'upsert') {
      this.map.set(ev.path, {
        meta: ev.meta,
        path: ev.path,
        items: ev.items,
        mtimeMs: ev.mtimeMs,
      });
      return;
    }
    if (ev.kind === 'remove') {
      this.map.delete(ev.path);
      return;
    }
    // ready / error: notifications, not state transitions
  }

  snapshot(): readonly UpsertSnapshot[] {
    return Array.from(this.map.values());
  }

  size(): number {
    return this.map.size;
  }
}
