import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, applyEvent } from '../src/sse/applyEvent.js';
import type { UpsertSnapshot, WireEvent } from '../src/types/wire.js';

const meta = (sid: string, aid = sid) => ({
  sessionId: sid,
  agentId: aid,
  isSubagent: sid !== aid,
});

const snap = (path: string, mtimeMs = 1, content = 'x'): UpsertSnapshot => ({
  meta: meta('aaa'),
  path,
  items: [{ id: '1', content, status: 'pending' }],
  mtimeMs,
  cwd: null,
  gitBranch: null,
  project: '(Unknown)',
});

const enrichDefaults = {
  cwd: null as string | null,
  gitBranch: null as string | null,
  project: '(Unknown)',
};

describe('applyEvent', () => {
  it('snapshot replaces the files map with the payload', () => {
    const ev: WireEvent = { kind: 'snapshot', files: [snap('/p/a'), snap('/p/b')] };
    const next = applyEvent(INITIAL_STATE, ev);
    expect(Object.keys(next.files)).toEqual(['/p/a', '/p/b']);
  });

  it('snapshot overwrites any existing files', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a'), snap('/p/b')],
    });
    const next = applyEvent(start, { kind: 'snapshot', files: [snap('/p/c')] });
    expect(Object.keys(next.files)).toEqual(['/p/c']);
  });

  it('upsert adds a file keyed by path', () => {
    const next = applyEvent(INITIAL_STATE, {
      kind: 'upsert',
      meta: meta('aaa'),
      path: '/p/x',
      items: [{ id: '1', content: 'hi', status: 'in_progress' }],
      mtimeMs: 42,
      ...enrichDefaults,
    });
    expect(next.files['/p/x']).toMatchObject({
      meta: meta('aaa'),
      path: '/p/x',
      items: [{ id: '1', content: 'hi', status: 'in_progress' }],
      mtimeMs: 42,
    });
  });

  it('upsert replaces the file at the same path', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/x', 1, 'old')],
    });
    const next = applyEvent(start, {
      kind: 'upsert',
      meta: meta('aaa'),
      path: '/p/x',
      items: [{ id: '1', content: 'new', status: 'completed' }],
      mtimeMs: 99,
      ...enrichDefaults,
    });
    expect(next.files['/p/x']?.mtimeMs).toBe(99);
    expect(next.files['/p/x']?.items[0]?.content).toBe('new');
  });

  it('upsert carries cwd / gitBranch / project into the stored snapshot', () => {
    const next = applyEvent(INITIAL_STATE, {
      kind: 'upsert',
      meta: meta('aaa'),
      path: '/p/y',
      items: [],
      mtimeMs: 5,
      cwd: '/Users/x/task_viewer',
      gitBranch: 'main',
      project: 'task_viewer',
    });
    expect(next.files['/p/y']).toMatchObject({
      cwd: '/Users/x/task_viewer',
      gitBranch: 'main',
      project: 'task_viewer',
    });
  });

  it('remove deletes a file by path', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a'), snap('/p/b')],
    });
    const next = applyEvent(start, {
      kind: 'remove',
      meta: meta('aaa'),
      path: '/p/a',
    });
    expect(Object.keys(next.files)).toEqual(['/p/b']);
  });

  it('remove of an unknown path is a no-op (returns the same state reference)', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a')],
    });
    const next = applyEvent(start, {
      kind: 'remove',
      meta: meta('aaa'),
      path: '/p/does-not-exist',
    });
    expect(next).toBe(start);
  });

  it('error stores a human-readable errorMessage', () => {
    const next = applyEvent(INITIAL_STATE, {
      kind: 'error',
      path: '/p/broken.json',
      reason: 'json',
      message: 'Unexpected token',
    });
    expect(next.errorMessage).toContain('json');
    expect(next.errorMessage).toContain('Unexpected token');
  });

  it('ready flips the ready flag but preserves files', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a')],
    });
    const next = applyEvent(start, { kind: 'ready' });
    expect(next.ready).toBe(true);
    expect(next.files).toBe(start.files);
  });

  it('snapshot clears the ready flag (a new initial scan has started)', () => {
    const afterReady = applyEvent(INITIAL_STATE, { kind: 'ready' });
    const nextSnap = applyEvent(afterReady, { kind: 'snapshot', files: [] });
    expect(nextSnap.ready).toBe(false);
  });

  it('upsert with the same mtime and enrichment returns the same state reference (short-circuit)', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a', 42)],
    });
    const next = applyEvent(start, {
      kind: 'upsert',
      meta: meta('aaa'),
      path: '/p/a',
      items: [{ id: '1', content: 'x', status: 'pending' }],
      mtimeMs: 42,
      ...enrichDefaults,
    });
    expect(next).toBe(start);
  });

  it('upsert with same mtime but NEW enrichment updates (handles late JSONL discovery)', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a', 42)],
    });
    const next = applyEvent(start, {
      kind: 'upsert',
      meta: meta('aaa'),
      path: '/p/a',
      items: [{ id: '1', content: 'x', status: 'pending' }],
      mtimeMs: 42,
      cwd: '/Users/x/late',
      gitBranch: 'main',
      project: 'late',
    });
    expect(next).not.toBe(start);
    expect(next.files['/p/a']?.project).toBe('late');
  });

  it('snapshot clears a stale errorMessage (fresh start after reconnect)', () => {
    const withError = applyEvent(INITIAL_STATE, {
      kind: 'error',
      path: '/p/broken.json',
      reason: 'json',
      message: 'boom',
    });
    expect(withError.errorMessage).not.toBeNull();
    const afterSnap = applyEvent(withError, { kind: 'snapshot', files: [] });
    expect(afterSnap.errorMessage).toBeNull();
  });

  it('any data event promotes connection from connecting to open', () => {
    expect(INITIAL_STATE.connection).toBe('connecting');
    const afterSnap = applyEvent(INITIAL_STATE, { kind: 'snapshot', files: [] });
    expect(afterSnap.connection).toBe('open');
    const afterUpsert = applyEvent(INITIAL_STATE, {
      kind: 'upsert',
      ...snap('/p/a'),
    });
    expect(afterUpsert.connection).toBe('open');
    const afterReady = applyEvent(INITIAL_STATE, { kind: 'ready' });
    expect(afterReady.connection).toBe('open');
  });

  it('data events do not un-close a deliberately closed connection', () => {
    const closed: typeof INITIAL_STATE = { ...INITIAL_STATE, connection: 'closed' };
    const next = applyEvent(closed, { kind: 'snapshot', files: [] });
    expect(next.connection).toBe('closed');
  });

  it('never mutates the input state', () => {
    const start = applyEvent(INITIAL_STATE, {
      kind: 'snapshot',
      files: [snap('/p/a')],
    });
    const before = JSON.stringify(start);
    applyEvent(start, { kind: 'upsert', ...snap('/p/b') });
    applyEvent(start, { kind: 'remove', meta: meta('aaa'), path: '/p/a' });
    expect(JSON.stringify(start)).toBe(before);
  });
});
