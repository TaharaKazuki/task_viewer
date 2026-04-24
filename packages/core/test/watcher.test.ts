import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TodoFileEvent, type TodoWatcher, watchTodos } from '../src/index.js';

const UUID_A = '01205cda-ff84-4259-9f77-8e898c0cf748';
const UUID_B = 'ddb95474-a044-4449-a973-221d19610629';
const fname = (sid: string, aid: string) => `${sid}-agent-${aid}.json`;

async function collect(watcher: TodoWatcher, n: number): Promise<TodoFileEvent[]> {
  const out: TodoFileEvent[] = [];
  const iter = watcher.events[Symbol.asyncIterator]();
  while (out.length < n) {
    const result = await iter.next();
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

async function collectWithinMs(watcher: TodoWatcher, ms: number): Promise<TodoFileEvent[]> {
  const out: TodoFileEvent[] = [];
  const iter = watcher.events[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = new Promise<IteratorResult<TodoFileEvent>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined as never }), remaining),
    );
    const result = await Promise.race([iter.next(), timeout]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

describe('watchTodos', () => {
  let dir: string;
  let watcher: TodoWatcher | null = null;

  beforeEach(() => {
    // realpathSync: macOS /tmp is a symlink to /private/tmp; chokidar
    // sometimes realpath-expands its paths, which breaks naive comparisons
    // of ev.path against dir. Normalize up front.
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tv-watcher-')));
  });

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits ready for an empty directory', async () => {
    watcher = watchTodos({ dir, debounceMs: 10 });
    const events = await collect(watcher, 1);
    expect(events).toEqual([{ kind: 'ready' }]);
  });

  it('emits upsert for a pre-existing file before ready', async () => {
    const file = path.join(dir, fname(UUID_A, UUID_A));
    writeFileSync(file, JSON.stringify([{ id: '1', content: 'x', status: 'pending' }]));
    watcher = watchTodos({ dir, debounceMs: 10 });
    const events = await collect(watcher, 2);
    expect(events[0]).toMatchObject({
      kind: 'upsert',
      meta: { sessionId: UUID_A, agentId: UUID_A, isSubagent: false },
    });
    expect(events[1]).toEqual({ kind: 'ready' });
    if (events[0]?.kind === 'upsert') {
      expect(events[0].items).toHaveLength(1);
      expect(events[0].items[0]?.status).toBe('pending');
      expect(events[0].mtimeMs).toBeTypeOf('number');
    }
  });

  it('detects a subagent file by the sessionId !== agentId filename', async () => {
    writeFileSync(
      path.join(dir, fname(UUID_A, UUID_B)),
      JSON.stringify([{ id: '1', content: 'sub', status: 'in_progress' }]),
    );
    watcher = watchTodos({ dir, debounceMs: 10 });
    const events = await collect(watcher, 2);
    expect(events[0]).toMatchObject({ kind: 'upsert', meta: { isSubagent: true } });
  });

  it('emits upsert when a file is added after ready', async () => {
    watcher = watchTodos({ dir, debounceMs: 20 });
    await collect(watcher, 1);
    writeFileSync(
      path.join(dir, fname(UUID_A, UUID_A)),
      JSON.stringify([{ id: '1', content: 'new', status: 'pending' }]),
    );
    const [ev] = await collect(watcher, 1);
    expect(ev).toMatchObject({ kind: 'upsert' });
  });

  it('emits upsert on change', async () => {
    const file = path.join(dir, fname(UUID_A, UUID_A));
    writeFileSync(file, '[]');
    watcher = watchTodos({ dir, debounceMs: 20 });
    await collect(watcher, 2);
    writeFileSync(file, JSON.stringify([{ id: '1', content: 'y', status: 'completed' }]));
    const [ev] = await collect(watcher, 1);
    expect(ev?.kind).toBe('upsert');
    if (ev?.kind === 'upsert') expect(ev.items[0]?.content).toBe('y');
  });

  it('emits remove on unlink', async () => {
    const file = path.join(dir, fname(UUID_A, UUID_A));
    writeFileSync(file, '[]');
    watcher = watchTodos({ dir, debounceMs: 10 });
    await collect(watcher, 2);
    unlinkSync(file);
    const [ev] = await collect(watcher, 1);
    expect(ev).toMatchObject({ kind: 'remove', meta: { sessionId: UUID_A } });
  });

  it('emits error with reason=json on malformed JSON', async () => {
    writeFileSync(path.join(dir, fname(UUID_A, UUID_A)), '[{"id":');
    watcher = watchTodos({ dir, debounceMs: 10 });
    const events = await collect(watcher, 2);
    const err = events.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ kind: 'error', reason: 'json' });
  });

  it('ignores filenames that do not match the UUID-agent-UUID.json pattern', async () => {
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'not-a-real-name.json'), '[]');
    watcher = watchTodos({ dir, debounceMs: 10 });
    const events = await collectWithinMs(watcher, 200);
    expect(events).toEqual([{ kind: 'ready' }]);
  });

  it('debounces rapid writes into a single upsert with the latest content', async () => {
    watcher = watchTodos({ dir, debounceMs: 80 });
    await collect(watcher, 1);
    const file = path.join(dir, fname(UUID_A, UUID_A));
    writeFileSync(file, '[]');
    writeFileSync(file, JSON.stringify([{ id: '1', content: 'mid', status: 'pending' }]));
    writeFileSync(file, JSON.stringify([{ id: '1', content: 'final', status: 'completed' }]));
    const events = await collectWithinMs(watcher, 400);
    const upserts = events.filter((e) => e.kind === 'upsert');
    expect(upserts).toHaveLength(1);
    if (upserts[0]?.kind === 'upsert') {
      expect(upserts[0].items[0]?.content).toBe('final');
    }
  });

  it('stops emitting after stop() and returns done on the iterator', async () => {
    watcher = watchTodos({ dir, debounceMs: 10 });
    await collect(watcher, 1);
    const iter = watcher.events[Symbol.asyncIterator]();
    await watcher.stop();
    writeFileSync(path.join(dir, fname(UUID_A, UUID_A)), '[]');
    const result = await iter.next();
    expect(result.done).toBe(true);
    watcher = null;
  });

  it('stop() is idempotent on repeated calls', async () => {
    watcher = watchTodos({ dir, debounceMs: 10 });
    await collect(watcher, 1);
    await watcher.stop();
    // Second call must not throw or hang.
    await watcher.stop();
    watcher = null;
  });

  it('tears down the watcher when for-await-of breaks (iterator.return())', async () => {
    watcher = watchTodos({ dir, debounceMs: 10 });
    let sawReady = false;
    for await (const ev of watcher.events) {
      if (ev.kind === 'ready') {
        sawReady = true;
        break;
      }
    }
    expect(sawReady).toBe(true);
    // After the break, stop() should be fast (already-closed path) and
    // a subsequent write should not produce any late event.
    const t0 = Date.now();
    await watcher.stop();
    expect(Date.now() - t0).toBeLessThan(200);
    const iter = watcher.events[Symbol.asyncIterator]();
    writeFileSync(path.join(dir, fname(UUID_A, UUID_A)), '[]');
    const result = await iter.next();
    expect(result.done).toBe(true);
    watcher = null;
  });

  it('survives interleaved next() calls (FIFO resolver queue)', async () => {
    watcher = watchTodos({ dir, debounceMs: 10 });
    const iter = watcher.events[Symbol.asyncIterator]();
    // Fire three next() calls before any event arrives. Each one parks a
    // resolver; a single-slot implementation would overwrite and strand
    // earlier ones. All three must resolve as events arrive.
    const p1 = iter.next();
    const p2 = iter.next();
    const p3 = iter.next();
    // Produce 3 events: `ready` + 2 post-ready upserts.
    writeFileSync(path.join(dir, fname(UUID_A, UUID_A)), '[]');
    writeFileSync(path.join(dir, fname(UUID_A, UUID_B)), '[]');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);
    expect(r3.done).toBe(false);
    const kinds = [r1.value.kind, r2.value.kind, r3.value.kind].sort();
    expect(kinds).toEqual(['ready', 'upsert', 'upsert']);
  });
});
