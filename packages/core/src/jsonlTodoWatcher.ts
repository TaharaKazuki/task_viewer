import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { extractLatestTodoWrite, todoWriteSignature } from './jsonlTodoExtractor.js';
import type { TodoFileEvent } from './watcher.js';

export type JsonlTodoWatcherOptions = {
  dir?: string;
  // Debounce window for change events. JSONL files often receive multiple
  // appends per assistant turn; collapse them into one extract pass.
  debounceMs?: number;
};

export type JsonlTodoWatcher = {
  events: AsyncIterable<TodoFileEvent>;
  stop: () => Promise<void>;
};

const DEFAULT_DIR = path.join(homedir(), '.claude', 'projects');
const DEFAULT_DEBOUNCE_MS = 200;

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

type FileState = {
  lastOffset: number;
  // Bytes after the last complete newline; carried into the next read so
  // we never feed a half-line to JSON.parse.
  partialLine: string;
  // Most recently emitted TodoWrite signature, keyed by agentId. A repeat
  // payload (no real change) is suppressed.
  latestSigs: Map<string, string>;
};

async function readRange(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return '';
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function syntheticTodoPath(sessionId: string, agentId: string): string {
  // Same shape as the real ~/.claude/todos/ filenames so todoWatcher and
  // jsonlTodoWatcher events coalesce by path in the server's StateStore.
  return path.join(homedir(), '.claude', 'todos', `${sessionId}-agent-${agentId}.json`);
}

export function watchJsonlTodos(opts: JsonlTodoWatcherOptions = {}): JsonlTodoWatcher {
  const dir = opts.dir ?? DEFAULT_DIR;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let stopped = false;
  let closed = false;

  const buffer: TodoFileEvent[] = [];
  const pendingResolves: Array<(r: IteratorResult<TodoFileEvent>) => void> = [];

  const push = (ev: TodoFileEvent): void => {
    if (stopped) return;
    const next = pendingResolves.shift();
    if (next) {
      next({ value: ev, done: false });
      return;
    }
    buffer.push(ev);
  };

  const endIterator = (): void => {
    while (pendingResolves.length > 0) {
      const r = pendingResolves.shift();
      if (r) r({ value: undefined as never, done: true });
    }
  };

  const fileStates = new Map<string, FileState>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-file mutex: serialize processFile invocations for the same path so
  // concurrent calls cannot interleave their stat / read / lastOffset writes
  // and lose progress. A second call while one is in flight queues; only one
  // queued retry is needed since it'll observe whatever the first call wrote.
  const inFlight = new Map<string, Promise<void>>();
  const pendingRetry = new Set<string>();

  const processFile = async (filePath: string): Promise<void> => {
    if (stopped) return;
    let st: { size: number; mtimeMs: number };
    try {
      st = await stat(filePath);
    } catch {
      // File may have been deleted between event and stat; ignore.
      return;
    }
    let state = fileStates.get(filePath);
    if (!state) {
      state = { lastOffset: 0, partialLine: '', latestSigs: new Map() };
      fileStates.set(filePath, state);
    }
    // Truncation / rotation guard: file shrank below where we left off.
    if (st.size < state.lastOffset) {
      state.lastOffset = 0;
      state.partialLine = '';
      // Don't clear latestSigs; if the rewritten content matches the prior
      // signature we still suppress redundant re-emit.
    }
    const length = st.size - state.lastOffset;
    if (length <= 0) return;
    let chunk: string;
    try {
      chunk = await readRange(filePath, state.lastOffset, length);
    } catch (e) {
      push({ kind: 'error', path: filePath, reason: 'io', error: toError(e) });
      return;
    }
    state.lastOffset = st.size;
    const combined = state.partialLine + chunk;
    const newlineIdx = combined.lastIndexOf('\n');
    const completeChunk = newlineIdx >= 0 ? combined.slice(0, newlineIdx) : '';
    state.partialLine = newlineIdx >= 0 ? combined.slice(newlineIdx + 1) : combined;
    if (!completeChunk) return;
    const extracted = extractLatestTodoWrite(completeChunk);
    if (!extracted) return;
    const sig = todoWriteSignature(extracted);
    if (state.latestSigs.get(extracted.agentId) === sig) {
      return;
    }
    state.latestSigs.set(extracted.agentId, sig);
    push({
      kind: 'upsert',
      meta: {
        sessionId: extracted.sessionId,
        agentId: extracted.agentId,
        isSubagent: extracted.sessionId !== extracted.agentId,
      },
      path: syntheticTodoPath(extracted.sessionId, extracted.agentId),
      items: extracted.items,
      mtimeMs: st.mtimeMs,
    });
  };

  const runProcessFile = (filePath: string): void => {
    // Serialize per file. If a run is already in flight, mark a pending
    // retry; when it finishes, run once more so we observe any growth that
    // happened during the in-flight read.
    if (inFlight.has(filePath)) {
      pendingRetry.add(filePath);
      return;
    }
    const p = (async () => {
      try {
        await processFile(filePath);
      } finally {
        inFlight.delete(filePath);
        if (pendingRetry.delete(filePath) && !stopped) runProcessFile(filePath);
      }
    })();
    inFlight.set(filePath, p);
  };

  // Throttle (NOT debounce). Under sustained appends, debounce-and-reset
  // never fires because each new event resets the timer before it elapses.
  // Throttle: leading-edge fire, then ignore further events until cooldown
  // ends; if events landed during cooldown, fire one trailing run.
  const lastRun = new Map<string, number>();
  const trailingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (filePath: string, immediate: boolean): void => {
    if (immediate) {
      lastRun.set(filePath, Date.now());
      runProcessFile(filePath);
      return;
    }
    const now = Date.now();
    const last = lastRun.get(filePath) ?? 0;
    const elapsed = now - last;
    if (elapsed >= debounceMs) {
      lastRun.set(filePath, now);
      runProcessFile(filePath);
      return;
    }
    // Inside cooldown — schedule one trailing run; subsequent events while
    // the trailing timer is pending coalesce into the same run.
    if (trailingTimers.has(filePath)) return;
    trailingTimers.set(
      filePath,
      setTimeout(() => {
        trailingTimers.delete(filePath);
        lastRun.set(filePath, Date.now());
        if (!stopped) runProcessFile(filePath);
      }, debounceMs - elapsed),
    );
  };

  const shouldConsider = (p: string): boolean => {
    if (!p.endsWith('.jsonl')) return false;
    // Reject the watch root itself; only accept files inside a subdirectory.
    const parent = path.dirname(p);
    return parent !== dir;
  };

  // macOS FSEvents drops 'change' events under sustained append bursts (Claude
  // Code's JSONL writes are exactly that). Use polling to reliably notice
  // every size delta. The cost is roughly stat(file) per polling interval
  // per file; with ~14 JSONLs in ~/.claude/projects and a 250ms tick that's
  // negligible.
  const fsWatcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: false,
    usePolling: true,
    interval: 250,
    binaryInterval: 1000,
  });

  // 'add' for pre-existing files reads the whole file once (immediate = no
  // debounce). New 'change' bursts during a session use the debounce.
  fsWatcher.on('add', (p) => {
    if (!shouldConsider(p)) return;
    schedule(p, true);
  });
  fsWatcher.on('change', (p) => {
    if (!shouldConsider(p)) return;
    schedule(p, false);
  });
  fsWatcher.on('error', (e) => {
    push({ kind: 'error', path: dir, reason: 'io', error: toError(e) });
  });

  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopped = true;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    for (const t of trailingTimers.values()) clearTimeout(t);
    trailingTimers.clear();
    try {
      await fsWatcher.close();
    } catch {
      // we're tearing down regardless
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
          await teardown();
          return { value: undefined as never, done: true };
        },
      };
    },
  };

  return { events, stop: teardown };
}
