import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { extractSessionMeta } from './jsonl.js';

export type SessionMetaEvent =
  | { kind: 'ready' }
  | {
      kind: 'discovered';
      sessionId: string;
      cwd: string;
      gitBranch: string | null;
      path: string;
    }
  | { kind: 'error'; path: string; error: Error };

export type SessionWatcherOptions = {
  dir?: string;
  // Bytes to read from the head of each JSONL file. 64 KiB is more than
  // enough to reach the first sessionId+cwd line; full JSONL can be multi-MB.
  headBytes?: number;
};

export type SessionWatcher = {
  events: AsyncIterable<SessionMetaEvent>;
  stop: () => Promise<void>;
};

const DEFAULT_DIR = path.join(homedir(), '.claude', 'projects');
const DEFAULT_HEAD_BYTES = 64 * 1024;

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

async function readHead(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export function watchSessionMeta(opts: SessionWatcherOptions = {}): SessionWatcher {
  const dir = opts.dir ?? DEFAULT_DIR;
  const headBytes = opts.headBytes ?? DEFAULT_HEAD_BYTES;

  let stopped = false;
  let closed = false;
  let chokidarReady = false;
  let pendingInitialReads = 0;

  const buffer: SessionMetaEvent[] = [];
  const pendingResolves: Array<(r: IteratorResult<SessionMetaEvent>) => void> = [];

  const push = (ev: SessionMetaEvent): void => {
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

  const maybeEmitReady = (): void => {
    if (chokidarReady && pendingInitialReads === 0 && !stopped) {
      push({ kind: 'ready' });
    }
  };

  const readAndEmit = async (filePath: string): Promise<void> => {
    try {
      const chunk = await readHead(filePath, headBytes);
      if (stopped) return;
      const meta = extractSessionMeta(chunk);
      if (meta) {
        push({ kind: 'discovered', ...meta, path: filePath });
      }
      // If meta is null the file is new but has no useful header yet — stay
      // quiet. Session will be picked up on a later 'add' or via the todo
      // path's fallback enrichment.
    } catch (e) {
      push({ kind: 'error', path: filePath, error: toError(e) });
    }
  };

  const shouldConsider = (filePath: string): boolean => {
    if (!filePath.endsWith('.jsonl')) return false;
    // Ignore the root directory itself; only accept files inside a
    // project subdirectory (conventional layout).
    const parent = path.dirname(filePath);
    if (parent === dir) return false;
    // Reject subagent jsonls. They live at
    //   {projectDir}/{parentSessionId}/subagents/agent-{aid}.jsonl
    // and contain `sessionId: parent` with the SUBAGENT's transient cwd
    // (which often differs because subagents run via Bash with `cd`).
    // Letting them feed SessionIndex would clobber the parent session's
    // project label with whatever directory the subagent happened to be
    // in. jsonlTodoWatcher handles subagent jsonls separately for
    // TodoWrite extraction.
    if (filePath.includes(`${path.sep}subagents${path.sep}`)) return false;
    return true;
  };

  const processInitialAdd = (filePath: string): void => {
    pendingInitialReads++;
    void readAndEmit(filePath).finally(() => {
      pendingInitialReads--;
      maybeEmitReady();
    });
  };

  const fsWatcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: false,
  });

  fsWatcher.on('add', (p) => {
    if (!shouldConsider(p)) return;
    if (chokidarReady) {
      void readAndEmit(p);
    } else {
      processInitialAdd(p);
    }
  });

  // change events are intentionally not handled: session metadata is
  // effectively immutable after the first line, and Phase 3 token-usage
  // tracking will handle incremental reads separately.

  fsWatcher.on('ready', () => {
    chokidarReady = true;
    maybeEmitReady();
  });

  fsWatcher.on('error', (e) => {
    push({ kind: 'error', path: dir, error: toError(e) });
  });

  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopped = true;
    try {
      await fsWatcher.close();
    } catch {
      // swallow: we're tearing down regardless
    }
    endIterator();
  };

  const events: AsyncIterable<SessionMetaEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<SessionMetaEvent> {
      return {
        next(): Promise<IteratorResult<SessionMetaEvent>> {
          const queued = buffer.shift();
          if (queued !== undefined) {
            return Promise.resolve({ value: queued, done: false });
          }
          if (stopped) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise<IteratorResult<SessionMetaEvent>>((resolve) => {
            pendingResolves.push(resolve);
          });
        },
        async return(): Promise<IteratorResult<SessionMetaEvent>> {
          await teardown();
          return { value: undefined as never, done: true };
        },
      };
    },
  };

  return { events, stop: teardown };
}
