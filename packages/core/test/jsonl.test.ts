import { describe, expect, it } from 'vitest';
import { extractSessionMeta, parseJsonlLine } from '../src/jsonl.js';

describe('parseJsonlLine', () => {
  it('parses a valid JSON line and returns only the fields we care about', () => {
    const line = JSON.stringify({
      parentUuid: 'abc',
      sessionId: 'sid-1',
      cwd: '/Users/x/project',
      gitBranch: 'main',
      type: 'user',
      timestamp: '2026-04-25T00:00:00Z',
      message: { role: 'user', content: 'x' },
    });
    const out = parseJsonlLine(line);
    expect(out?.sessionId).toBe('sid-1');
    expect(out?.cwd).toBe('/Users/x/project');
    expect(out?.gitBranch).toBe('main');
  });

  it('returns null for malformed JSON', () => {
    expect(parseJsonlLine('not json')).toBeNull();
    expect(parseJsonlLine('{broken')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseJsonlLine('')).toBeNull();
  });

  it('accepts lines that lack sessionId or cwd (extractor will skip them)', () => {
    const line = JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' });
    const out = parseJsonlLine(line);
    expect(out).not.toBeNull();
    expect(out?.sessionId).toBeUndefined();
  });

  it('rejects lines larger than the byte ceiling', () => {
    const huge = `{"sessionId":"${'x'.repeat(5_000_001)}"}`;
    expect(parseJsonlLine(huge)).toBeNull();
  });
});

describe('extractSessionMeta', () => {
  it('returns the first line with both sessionId and cwd', () => {
    const chunk = [
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' }),
      JSON.stringify({
        sessionId: 'sid-1',
        cwd: '/Users/x/project',
        gitBranch: 'main',
        type: 'user',
      }),
      JSON.stringify({ sessionId: 'sid-1', cwd: '/elsewhere', type: 'user' }),
    ].join('\n');
    const meta = extractSessionMeta(chunk);
    expect(meta).toEqual({
      sessionId: 'sid-1',
      cwd: '/Users/x/project',
      gitBranch: 'main',
    });
  });

  it('returns null when no line has session metadata', () => {
    const chunk = [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    ].join('\n');
    expect(extractSessionMeta(chunk)).toBeNull();
  });

  it('returns null for an empty chunk', () => {
    expect(extractSessionMeta('')).toBeNull();
  });

  it('tolerates blank lines and trailing whitespace', () => {
    const chunk = [
      '',
      '   ',
      JSON.stringify({ sessionId: 'sid-1', cwd: '/p', gitBranch: '' }),
    ].join('\n');
    expect(extractSessionMeta(chunk)).toEqual({
      sessionId: 'sid-1',
      cwd: '/p',
      gitBranch: null,
    });
  });

  it('treats an empty gitBranch string as null', () => {
    const line = JSON.stringify({ sessionId: 's', cwd: '/p', gitBranch: '' });
    const meta = extractSessionMeta(line);
    expect(meta?.gitBranch).toBeNull();
  });

  it('treats a missing gitBranch as null', () => {
    const line = JSON.stringify({ sessionId: 's', cwd: '/p' });
    const meta = extractSessionMeta(line);
    expect(meta?.gitBranch).toBeNull();
  });

  it('skips lines with sessionId but no cwd', () => {
    const chunk = [
      JSON.stringify({ sessionId: 's-only' }),
      JSON.stringify({ sessionId: 'sid', cwd: '/real' }),
    ].join('\n');
    expect(extractSessionMeta(chunk)).toEqual({
      sessionId: 'sid',
      cwd: '/real',
      gitBranch: null,
    });
  });
});
