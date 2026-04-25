import type { SessionMetaEvent } from '@task-viewer/core';
import { describe, expect, it } from 'vitest';
import { SessionIndex, cwdToProject } from '../src/sessionIndex.js';

const discovered = (
  sid: string,
  cwd: string,
  gitBranch: string | null = null,
): SessionMetaEvent => ({
  kind: 'discovered',
  sessionId: sid,
  cwd,
  gitBranch,
  path: `/tmp/${sid}.jsonl`,
});

describe('cwdToProject', () => {
  it('returns the basename of the cwd', () => {
    expect(cwdToProject('/Users/x/products/task_viewer')).toBe('task_viewer');
  });

  it('falls back to the whole cwd when basename is empty', () => {
    expect(cwdToProject('/')).toBe('/');
  });
});

describe('SessionIndex', () => {
  it('starts empty', () => {
    const idx = new SessionIndex();
    expect(idx.size()).toBe(0);
    expect(idx.get('sid')).toBeNull();
  });

  it('applies discovered events and exposes them via get()', () => {
    const idx = new SessionIndex();
    idx.apply(discovered('sid-1', '/Users/x/app', 'main'));
    expect(idx.size()).toBe(1);
    expect(idx.get('sid-1')).toEqual({
      cwd: '/Users/x/app',
      gitBranch: 'main',
      project: 'app',
    });
  });

  it('later discovered event overwrites earlier metadata', () => {
    const idx = new SessionIndex();
    idx.apply(discovered('sid-1', '/Users/x/app', 'main'));
    idx.apply(discovered('sid-1', '/Users/x/app', 'feature-a'));
    expect(idx.get('sid-1')?.gitBranch).toBe('feature-a');
  });

  it('apply returns changed:false for idempotent re-discovery', () => {
    const idx = new SessionIndex();
    const first = idx.apply(discovered('sid-1', '/Users/x/app', 'main'));
    expect(first).toEqual({ changed: true, collided: false });
    const again = idx.apply(discovered('sid-1', '/Users/x/app', 'main'));
    expect(again).toEqual({ changed: false, collided: false });
  });

  it('apply returns collided:true when two distinct cwds share a basename', () => {
    const idx = new SessionIndex();
    idx.apply(discovered('sid-a', '/foo/web'));
    const collision = idx.apply(discovered('sid-b', '/bar/web'));
    expect(collision.changed).toBe(true);
    expect(collision.collided).toBe(true);
  });

  it('ignores ready and error events', () => {
    const idx = new SessionIndex();
    idx.apply({ kind: 'ready' });
    idx.apply({ kind: 'error', path: '/x', error: new Error('boom') });
    expect(idx.size()).toBe(0);
  });

  it('get() returns null for unknown sessionId', () => {
    const idx = new SessionIndex();
    idx.apply(discovered('sid-1', '/Users/x/app'));
    expect(idx.get('sid-missing')).toBeNull();
  });
});
