import type { TodoItem } from '@task-viewer/core';
import { describe, expect, it } from 'vitest';
import type { EnrichedTodoFileEvent } from '../src/enrich.js';
import { StateStore } from '../src/state.js';

const meta = (sid: string, aid = sid) => ({
  sessionId: sid,
  agentId: aid,
  isSubagent: sid !== aid,
});

const upsert = (
  path: string,
  items: TodoItem[] = [],
  mtimeMs = 1,
  overrides: Partial<{ cwd: string | null; gitBranch: string | null; project: string }> = {},
): EnrichedTodoFileEvent => ({
  kind: 'upsert',
  meta: meta('aaa'),
  path,
  items,
  mtimeMs,
  cwd: overrides.cwd ?? null,
  gitBranch: overrides.gitBranch ?? null,
  project: overrides.project ?? '(Unknown)',
});

describe('StateStore', () => {
  it('starts empty', () => {
    const s = new StateStore();
    expect(s.snapshot()).toEqual([]);
    expect(s.size()).toBe(0);
  });

  it('adds a file on upsert', () => {
    const s = new StateStore();
    s.apply(upsert('/p/a.json', [{ id: '1', content: 'x', status: 'pending' }]));
    expect(s.size()).toBe(1);
    expect(s.snapshot()[0]?.path).toBe('/p/a.json');
  });

  it('overwrites on repeated upsert for the same path', () => {
    const s = new StateStore();
    s.apply(upsert('/p/a.json', [{ id: '1', content: 'old', status: 'pending' }], 1));
    s.apply(upsert('/p/a.json', [{ id: '1', content: 'new', status: 'completed' }], 2));
    expect(s.size()).toBe(1);
    expect(s.snapshot()[0]?.mtimeMs).toBe(2);
    expect(s.snapshot()[0]?.items[0]?.content).toBe('new');
  });

  it('removes on remove event', () => {
    const s = new StateStore();
    s.apply(upsert('/p/a.json'));
    s.apply(upsert('/p/b.json'));
    s.apply({ kind: 'remove', meta: meta('aaa'), path: '/p/a.json' });
    expect(s.size()).toBe(1);
    expect(s.snapshot()[0]?.path).toBe('/p/b.json');
  });

  it('ignores ready events', () => {
    const s = new StateStore();
    s.apply({ kind: 'ready' });
    expect(s.snapshot()).toEqual([]);
  });

  it('ignores error events (no state mutation)', () => {
    const s = new StateStore();
    s.apply(upsert('/p/a.json'));
    s.apply({
      kind: 'error',
      path: '/p/a.json',
      reason: 'json',
      error: new Error('boom'),
    });
    expect(s.size()).toBe(1);
  });

  it('is idempotent on remove of an unknown path', () => {
    const s = new StateStore();
    s.apply({ kind: 'remove', meta: meta('aaa'), path: '/p/none.json' });
    expect(s.size()).toBe(0);
  });

  it('pathsForSession returns only entries for the matching sessionId', () => {
    const s = new StateStore();
    s.apply(upsert('/p/a.json', [], 1, { project: 'alpha' }));
    s.apply(upsert('/p/b.json', [], 1, { project: 'beta' }));
    const paths = s.pathsForSession('aaa').map((sn) => sn.path);
    // Both entries use meta('aaa') so both should be indexed together.
    expect(paths.sort()).toEqual(['/p/a.json', '/p/b.json']);
    expect(s.pathsForSession('missing')).toEqual([]);
  });

  it('carries cwd / gitBranch / project into the snapshot', () => {
    const s = new StateStore();
    s.apply(
      upsert('/p/a.json', [], 1, {
        cwd: '/Users/x/app',
        gitBranch: 'main',
        project: 'app',
      }),
    );
    const [snap] = s.snapshot();
    expect(snap).toMatchObject({ cwd: '/Users/x/app', gitBranch: 'main', project: 'app' });
  });
});
