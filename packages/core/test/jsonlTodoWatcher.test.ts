import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type JsonlTodoWatcher, watchJsonlTodos } from '../src/jsonlTodoWatcher.js';
import type { TodoFileEvent } from '../src/watcher.js';

type Status = 'pending' | 'in_progress' | 'completed';

const todoLine = (
  sessionId: string,
  agentId: string,
  todos: { id: string; content: string; status: Status }[],
) =>
  JSON.stringify({
    parentUuid: 'p',
    sessionId,
    agentId,
    type: 'assistant',
    timestamp: '2026-04-25T00:00:00Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu',
          name: 'TodoWrite',
          input: { todos },
        },
      ],
    },
  });

const userLine = (sessionId: string) =>
  JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'hi' } });

async function collect(
  watcher: JsonlTodoWatcher,
  n: number,
  timeoutMs = 4000,
): Promise<TodoFileEvent[]> {
  const out: TodoFileEvent[] = [];
  const iter = watcher.events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (out.length < n) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return out;
    const timeoutP = new Promise<IteratorResult<TodoFileEvent>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined as never }), remaining),
    );
    const result = await Promise.race([iter.next(), timeoutP]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

async function collectWithinMs(watcher: JsonlTodoWatcher, ms: number): Promise<TodoFileEvent[]> {
  const out: TodoFileEvent[] = [];
  const iter = watcher.events[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeoutP = new Promise<IteratorResult<TodoFileEvent>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined as never }), remaining),
    );
    const result = await Promise.race([iter.next(), timeoutP]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

describe('watchJsonlTodos', () => {
  let dir: string;
  let watcher: JsonlTodoWatcher | null = null;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tv-jsonltw-')));
  });

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits an upsert for an existing JSONL with a TodoWrite', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid-1.jsonl'),
      `${userLine('sid-1')}\n${todoLine('sid-1', 'sid-1', [
        { id: '1', content: 'hello', status: 'in_progress' },
      ])}\n`,
    );
    watcher = watchJsonlTodos({ dir, debounceMs: 30 });
    const [ev] = await collect(watcher, 1);
    expect(ev?.kind).toBe('upsert');
    if (ev?.kind === 'upsert') {
      expect(ev.meta.sessionId).toBe('sid-1');
      expect(ev.meta.agentId).toBe('sid-1');
      expect(ev.meta.isSubagent).toBe(false);
      expect(ev.items[0]?.content).toBe('hello');
      expect(ev.path).toMatch(/\/sid-1-agent-sid-1\.json$/);
    }
  });

  it('emits an upsert with isSubagent=true for subagent JSONLs', async () => {
    const subDir = path.join(dir, '-Users-x-app', 'parent-sid', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      path.join(subDir, 'agent-aaa.jsonl'),
      `${todoLine('parent-sid', 'aaa', [{ id: '1', content: 'sub work', status: 'pending' }])}\n`,
    );
    watcher = watchJsonlTodos({ dir, debounceMs: 30 });
    const [ev] = await collect(watcher, 1);
    if (ev?.kind === 'upsert') {
      expect(ev.meta.sessionId).toBe('parent-sid');
      expect(ev.meta.agentId).toBe('aaa');
      expect(ev.meta.isSubagent).toBe(true);
    }
  });

  it('does not emit when a JSONL contains no TodoWrite', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid-1.jsonl'),
      `${userLine('sid-1')}\n${userLine('sid-1')}\n`,
    );
    watcher = watchJsonlTodos({ dir, debounceMs: 30 });
    const events = await collectWithinMs(watcher, 300);
    expect(events).toEqual([]);
  });

  it('emits a new upsert when the JSONL is appended with a different TodoWrite', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    const file = path.join(projectDir, 'sid-1.jsonl');
    writeFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'first', status: 'pending' }])}\n`,
    );
    watcher = watchJsonlTodos({ dir, debounceMs: 60 });
    const first = await collect(watcher, 1);
    expect((first[0] as { kind: string }).kind).toBe('upsert');

    appendFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'second', status: 'in_progress' }])}\n`,
    );
    const second = await collect(watcher, 1);
    if (second[0]?.kind === 'upsert') {
      expect(second[0].items[0]?.content).toBe('second');
    }
  });

  it('does NOT re-emit if the appended TodoWrite has an identical signature', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    const file = path.join(projectDir, 'sid-1.jsonl');
    const sameLine = todoLine('sid-1', 'sid-1', [{ id: '1', content: 'x', status: 'pending' }]);
    writeFileSync(file, `${sameLine}\n`);
    watcher = watchJsonlTodos({ dir, debounceMs: 60 });
    await collect(watcher, 1); // first emit
    appendFileSync(file, `${sameLine}\n`);
    const events = await collectWithinMs(watcher, 300);
    expect(events).toEqual([]);
  });

  it('debounces a burst of appends into a single upsert', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    const file = path.join(projectDir, 'sid-1.jsonl');
    writeFileSync(file, '');
    watcher = watchJsonlTodos({ dir, debounceMs: 120 });

    appendFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'a', status: 'pending' }])}\n`,
    );
    appendFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'b', status: 'pending' }])}\n`,
    );
    appendFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'c', status: 'completed' }])}\n`,
    );

    const events = await collectWithinMs(watcher, 500);
    const upserts = events.filter((e) => e.kind === 'upsert');
    expect(upserts).toHaveLength(1);
    if (upserts[0]?.kind === 'upsert') {
      expect(upserts[0].items[0]?.content).toBe('c');
    }
  });

  it('handles a partial line at the end of a chunk (carries over)', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    const file = path.join(projectDir, 'sid-1.jsonl');
    const line = todoLine('sid-1', 'sid-1', [
      { id: '1', content: 'partial-test', status: 'pending' },
    ]);
    // Write only the first half (no terminating newline). No emit yet.
    const half = line.slice(0, line.length - 5);
    writeFileSync(file, half);
    watcher = watchJsonlTodos({ dir, debounceMs: 60 });
    const noneYet = await collectWithinMs(watcher, 250);
    expect(noneYet.filter((e) => e.kind === 'upsert')).toEqual([]);
    // Now finish the line and append the newline.
    appendFileSync(file, `${line.slice(line.length - 5)}\n`);
    const got = await collect(watcher, 1);
    if (got[0]?.kind === 'upsert') {
      expect(got[0].items[0]?.content).toBe('partial-test');
    }
  });

  it('rescans from the start when the file is truncated', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    const file = path.join(projectDir, 'sid-1.jsonl');
    writeFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'before', status: 'pending' }])}\n`,
    );
    watcher = watchJsonlTodos({ dir, debounceMs: 60 });
    await collect(watcher, 1);
    truncateSync(file, 0);
    writeFileSync(
      file,
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'after', status: 'completed' }])}\n`,
    );
    const events = await collect(watcher, 1);
    if (events[0]?.kind === 'upsert') {
      expect(events[0].items[0]?.content).toBe('after');
    }
  });

  it('ignores non-.jsonl files and JSONL files at the watch root', async () => {
    writeFileSync(path.join(dir, 'stray.jsonl'), `${todoLine('s', 's', [])}\n`);
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    writeFileSync(path.join(projectDir, 'notes.txt'), 'hello');
    watcher = watchJsonlTodos({ dir, debounceMs: 30 });
    const events = await collectWithinMs(watcher, 250);
    expect(events).toEqual([]);
  });

  it('stop() ends the iterator and prevents late emits', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid-1.jsonl'),
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'x', status: 'pending' }])}\n`,
    );
    watcher = watchJsonlTodos({ dir, debounceMs: 30 });
    await collect(watcher, 1);
    const iter = watcher.events[Symbol.asyncIterator]();
    await watcher.stop();
    // Late append must not produce a new event.
    appendFileSync(
      path.join(projectDir, 'sid-1.jsonl'),
      `${todoLine('sid-1', 'sid-1', [{ id: '1', content: 'y', status: 'completed' }])}\n`,
    );
    const result = await iter.next();
    expect(result.done).toBe(true);
    watcher = null;
  });
});
