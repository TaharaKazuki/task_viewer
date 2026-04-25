import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type SessionMetaEvent,
  type SessionWatcher,
  watchSessionMeta,
} from '../src/sessionWatcher.js';

const jsonl = (lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n');

async function collect(watcher: SessionWatcher, n: number): Promise<SessionMetaEvent[]> {
  const out: SessionMetaEvent[] = [];
  const iter = watcher.events[Symbol.asyncIterator]();
  while (out.length < n) {
    const r = await iter.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

async function collectWithinMs(watcher: SessionWatcher, ms: number): Promise<SessionMetaEvent[]> {
  const out: SessionMetaEvent[] = [];
  const iter = watcher.events[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeoutP = new Promise<IteratorResult<SessionMetaEvent>>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined as never }), remaining),
    );
    const result = await Promise.race([iter.next(), timeoutP]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

describe('watchSessionMeta', () => {
  let dir: string;
  let watcher: SessionWatcher | null = null;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tv-sessions-')));
  });

  afterEach(async () => {
    if (watcher) await watcher.stop();
    watcher = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits ready for an empty projects directory', async () => {
    watcher = watchSessionMeta({ dir });
    const events = await collect(watcher, 1);
    expect(events).toEqual([{ kind: 'ready' }]);
  });

  it('emits discovered for a pre-existing JSONL before ready', async () => {
    const projectDir = path.join(dir, '-Users-x-my-app');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid-1.jsonl'),
      jsonl([
        { type: 'file-history-snapshot', messageId: 'a' },
        { sessionId: 'sid-1', cwd: '/Users/x/my-app', gitBranch: 'main', type: 'user' },
      ]),
    );
    watcher = watchSessionMeta({ dir });
    const events = await collect(watcher, 2);
    expect(events[0]).toMatchObject({
      kind: 'discovered',
      sessionId: 'sid-1',
      cwd: '/Users/x/my-app',
      gitBranch: 'main',
    });
    expect(events[1]).toEqual({ kind: 'ready' });
  });

  it('emits discovered when a new JSONL appears after ready', async () => {
    watcher = watchSessionMeta({ dir });
    await collect(watcher, 1); // ready

    const projectDir = path.join(dir, '-Users-x-other');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid-2.jsonl'),
      jsonl([{ sessionId: 'sid-2', cwd: '/Users/x/other', type: 'user' }]),
    );

    const [ev] = await collect(watcher, 1);
    expect(ev).toMatchObject({ kind: 'discovered', sessionId: 'sid-2', cwd: '/Users/x/other' });
  });

  it('ignores non-.jsonl files', async () => {
    const projectDir = path.join(dir, '-Users-x-my-app');
    mkdirSync(projectDir);
    writeFileSync(path.join(projectDir, 'notes.txt'), 'hello');
    writeFileSync(path.join(projectDir, 'random.json'), '{}');
    watcher = watchSessionMeta({ dir });
    const events = await collectWithinMs(watcher, 300);
    expect(events).toEqual([{ kind: 'ready' }]);
  });

  it('ignores JSONL files placed directly in the root (not inside a project dir)', async () => {
    writeFileSync(path.join(dir, 'stray.jsonl'), jsonl([{ sessionId: 's', cwd: '/p' }]));
    watcher = watchSessionMeta({ dir });
    const events = await collectWithinMs(watcher, 300);
    expect(events).toEqual([{ kind: 'ready' }]);
  });

  it('silently drops JSONL files that lack usable session metadata', async () => {
    const projectDir = path.join(dir, '-Users-x-empty');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid.jsonl'),
      jsonl([{ type: 'file-history-snapshot' }, { type: 'queue-operation' }]),
    );
    watcher = watchSessionMeta({ dir });
    const events = await collectWithinMs(watcher, 400);
    expect(events.filter((e) => e.kind === 'discovered')).toHaveLength(0);
    expect(events.some((e) => e.kind === 'ready')).toBe(true);
  });

  it('normalizes an empty gitBranch string to null', async () => {
    const projectDir = path.join(dir, '-Users-x-app');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid.jsonl'),
      jsonl([{ sessionId: 'sid', cwd: '/Users/x/app', gitBranch: '' }]),
    );
    watcher = watchSessionMeta({ dir });
    const events = await collect(watcher, 2);
    const discovered = events.find((e) => e.kind === 'discovered');
    expect(discovered).toMatchObject({ gitBranch: null });
  });

  it('stops emitting after stop() and returns done on the iterator', async () => {
    watcher = watchSessionMeta({ dir });
    await collect(watcher, 1);
    const iter = watcher.events[Symbol.asyncIterator]();
    await watcher.stop();
    // Late file; must not produce a new event.
    const projectDir = path.join(dir, '-Users-x-late');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'sid-late.jsonl'),
      jsonl([{ sessionId: 'sid-late', cwd: '/Users/x/late' }]),
    );
    const result = await iter.next();
    expect(result.done).toBe(true);
    watcher = null;
  });

  it('ignores subagent JSONLs (which carry transient cwd that would clobber parent session)', async () => {
    // Set up a top-level parent jsonl with task_viewer cwd.
    const projectDir = path.join(dir, '-Users-x-task-viewer');
    mkdirSync(projectDir);
    writeFileSync(
      path.join(projectDir, 'parent-sid.jsonl'),
      jsonl([{ sessionId: 'parent-sid', cwd: '/Users/x/task_viewer', gitBranch: 'main' }]),
    );
    // Add a subagent jsonl with the same parent sessionId but a
    // different (subagent-local) cwd that should be ignored.
    const subDir = path.join(projectDir, 'parent-sid', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      path.join(subDir, 'agent-aaa.jsonl'),
      jsonl([
        { sessionId: 'parent-sid', cwd: '/Users/x/task_viewer/packages/core', gitBranch: 'main' },
      ]),
    );
    watcher = watchSessionMeta({ dir });
    const events = await collectWithinMs(watcher, 500);
    const discoveries = events.filter((e) => e.kind === 'discovered');
    expect(discoveries).toHaveLength(1);
    if (discoveries[0]?.kind === 'discovered') {
      expect(discoveries[0].cwd).toBe('/Users/x/task_viewer');
    }
  });

  it('is idempotent on repeated stop()', async () => {
    watcher = watchSessionMeta({ dir });
    await collect(watcher, 1);
    await watcher.stop();
    await watcher.stop();
    watcher = null;
  });
});
