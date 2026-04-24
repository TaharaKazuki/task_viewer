import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { parseTodoFilename, safeParseTodoContent } from './todo.js';
import type { ParseReason, TodoFileMeta, TodoItem } from './todo.js';

export type TodoFileEvent =
  | { kind: 'ready' }
  | {
      kind: 'upsert';
      meta: TodoFileMeta;
      path: string;
      items: TodoItem[];
      mtimeMs: number;
    }
  | { kind: 'remove'; meta: TodoFileMeta; path: string }
  | { kind: 'error'; path: string; reason: ParseReason | 'io'; error: Error };

export type TodoWatcherOptions = {
  dir?: string;
  debounceMs?: number;
};

// Single-consumer iterator. Calling `for await` from multiple loops against the
// same watcher shares one underlying queue, so events are drained by whichever
// consumer calls `.next()` first — no fan-out. Use one watcher per consumer.
export type TodoWatcher = {
  events: AsyncIterable<TodoFileEvent>;
  stop: () => Promise<void>;
};

const DEFAULT_DIR = path.join(homedir(), '.claude', 'todos');
const DEFAULT_DEBOUNCE_MS = 50;

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export function watchTodos(opts: TodoWatcherOptions = {}): TodoWatcher {
  const dir = opts.dir ?? DEFAULT_DIR;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let stopped = false;
  let closed = false;
  let chokidarReady = false;
  let pendingInitialReads = 0;

  const buffer: TodoFileEvent[] = [];
  // FIFO queue of waiting `.next()` resolvers. Multiple awaits (including
  // Promise.race-with-timeout patterns) otherwise overwrite a single slot
  // and strand earlier promises.
  const pendingResolves: Array<(r: IteratorResult<TodoFileEvent>) => void> = [];

  const push = (ev: TodoFileEvent): void => {
    if (stopped) return;
    const next = pendingResolves.shift();
    if (next) {
      next({ value: ev, done: false });
      return;
    }
    // Buffer is unbounded; the server/SSE layer is responsible for backpressure
    // (coalescing upserts by path, applying a max size). See learnings.
    buffer.push(ev);
  };

  const endIterator = (): void => {
    while (pendingResolves.length > 0) {
      const r = pendingResolves.shift();
      if (r) r({ value: undefined as never, done: true });
    }
  };

  const maybeEmitReady = (): void => {
    if (chokidarReady && pendingInitialReads === 0 && !stopped) {
      push({ kind: 'ready' });
    }
  };

  const readAndEmit = async (filePath: string, meta: TodoFileMeta): Promise<void> => {
    try {
      // Non-atomic read+stat — mtime may reflect a later write than `raw`.
      // Acceptable for Phase 1; dedup layer in Phase 2 keys on content hash.
      const [raw, st] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
      if (stopped) return;
      const result = safeParseTodoContent(raw);
      if (result.ok) {
        push({
          kind: 'upsert',
          meta,
          path: filePath,
          items: result.items,
          mtimeMs: st.mtimeMs,
        });
      } else {
        push({ kind: 'error', path: filePath, reason: result.reason, error: result.error });
      }
    } catch (e) {
      push({ kind: 'error', path: filePath, reason: 'io', error: toError(e) });
    }
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const scheduleDebounced = (filePath: string, meta: TodoFileMeta): void => {
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);
    timers.set(
      filePath,
      setTimeout(() => {
        timers.delete(filePath);
        if (!stopped) void readAndEmit(filePath, meta);
      }, debounceMs),
    );
  };

  const processInitialAdd = (filePath: string, meta: TodoFileMeta): void => {
    pendingInitialReads++;
    void readAndEmit(filePath, meta).finally(() => {
      pendingInitialReads--;
      maybeEmitReady();
    });
  };

  const fsWatcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: false,
  });

  fsWatcher.on('add', (p) => {
    const meta = parseTodoFilename(path.basename(p));
    if (!meta) return;
    if (chokidarReady) {
      scheduleDebounced(p, meta);
    } else {
      processInitialAdd(p, meta);
    }
  });

  fsWatcher.on('change', (p) => {
    const meta = parseTodoFilename(path.basename(p));
    if (!meta) return;
    scheduleDebounced(p, meta);
  });

  fsWatcher.on('unlink', (p) => {
    const meta = parseTodoFilename(path.basename(p));
    if (!meta) return;
    push({ kind: 'remove', meta, path: p });
  });

  fsWatcher.on('ready', () => {
    chokidarReady = true;
    maybeEmitReady();
  });

  fsWatcher.on('error', (e) => {
    push({ kind: 'error', path: dir, reason: 'io', error: toError(e) });
  });

  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopped = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    try {
      await fsWatcher.close();
    } catch {
      // swallow: we're tearing down regardless
    }
    endIterator();
  };

  const events: AsyncIterable<TodoFileEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<TodoFileEvent> {
      return {
        next(): Promise<IteratorResult<TodoFileEvent>> {
          const queued = buffer.shift();
          if (queued !== undefined) {
            return Promise.resolve({ value: queued, done: false });
          }
          if (stopped) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise<IteratorResult<TodoFileEvent>>((resolve) => {
            pendingResolves.push(resolve);
          });
        },
        async return(): Promise<IteratorResult<TodoFileEvent>> {
          // for-await-of's break / return path. MUST free external resources
          // (chokidar FDs, timers) — otherwise a consumer that breaks out of
          // the loop silently leaks the watcher.
          await teardown();
          return { value: undefined as never, done: true };
        },
      };
    },
  };

  return {
    events,
    stop: teardown,
  };
}
