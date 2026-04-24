import { describe, expect, it } from 'vitest';
import {
  type TodoItem,
  parseTodoContent,
  parseTodoFilename,
  safeParseTodoContent,
} from '../src/index.js';

const UUID_A = '01205cda-ff84-4259-9f77-8e898c0cf748';
const UUID_B = 'ddb95474-a044-4449-a973-221d19610629';

// Verbatim fixture from ~/.claude/todos/08a9f766-...-agent-08a9f766-....json
// (shape: Japanese UTF-8 content, status all completed)
const REAL_FIXTURE = `[
  {
    "content": "shadcn/uiのDialogコンポーネントを追加",
    "status": "completed",
    "id": "1"
  },
  {
    "content": "ServiceModalをDialogベースに変更",
    "status": "completed",
    "id": "2"
  }
]`;

describe('parseTodoFilename', () => {
  it('returns parent-agent meta when sessionId === agentId', () => {
    expect(parseTodoFilename(`${UUID_A}-agent-${UUID_A}.json`)).toEqual({
      sessionId: UUID_A,
      agentId: UUID_A,
      isSubagent: false,
    });
  });

  it('returns subagent meta when sessionId !== agentId', () => {
    expect(parseTodoFilename(`${UUID_A}-agent-${UUID_B}.json`)).toEqual({
      sessionId: UUID_A,
      agentId: UUID_B,
      isSubagent: true,
    });
  });

  it('accepts a full POSIX path and extracts the basename', () => {
    expect(parseTodoFilename(`/Users/foo/.claude/todos/${UUID_A}-agent-${UUID_A}.json`)).toEqual({
      sessionId: UUID_A,
      agentId: UUID_A,
      isSubagent: false,
    });
  });

  it('accepts a Windows-style path with backslashes', () => {
    expect(
      parseTodoFilename(`C:\\Users\\foo\\.claude\\todos\\${UUID_A}-agent-${UUID_A}.json`),
    ).toEqual({ sessionId: UUID_A, agentId: UUID_A, isSubagent: false });
  });

  it('normalizes uppercase UUIDs to lowercase', () => {
    const upper = UUID_A.toUpperCase();
    expect(parseTodoFilename(`${upper}-agent-${upper}.json`)).toEqual({
      sessionId: UUID_A,
      agentId: UUID_A,
      isSubagent: false,
    });
  });

  it('normalizes mixed-case UUIDs to lowercase', () => {
    const mixed = '01205CDA-ff84-4259-9F77-8e898c0cf748';
    const result = parseTodoFilename(`${mixed}-agent-${mixed}.json`);
    expect(result?.sessionId).toBe(UUID_A);
    expect(result?.agentId).toBe(UUID_A);
  });

  it('returns null when the .json extension is missing', () => {
    expect(parseTodoFilename(`${UUID_A}-agent-${UUID_A}`)).toBeNull();
  });

  it('returns null when the filename does not match the UUID shape', () => {
    expect(parseTodoFilename('not-a-real-filename.json')).toBeNull();
    expect(parseTodoFilename('12345-agent-67890.json')).toBeNull();
    expect(parseTodoFilename(`${UUID_A}.json`)).toBeNull();
  });
});

describe('parseTodoContent', () => {
  it('parses an empty array', () => {
    expect(parseTodoContent('[]')).toEqual([]);
  });

  it('parses a valid array and preserves order', () => {
    const items: TodoItem[] = [
      { id: '1', content: 'first', status: 'completed' },
      { id: '2', content: 'second', status: 'in_progress' },
      { id: '3', content: 'third', status: 'pending' },
    ];
    expect(parseTodoContent(JSON.stringify(items))).toEqual(items);
  });

  it('parses a real UTF-8 fixture', () => {
    const parsed = parseTodoContent(REAL_FIXTURE);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.content).toBe('shadcn/uiのDialogコンポーネントを追加');
    expect(parsed[0]?.status).toBe('completed');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseTodoContent('[')).toThrow();
    expect(() => parseTodoContent('[{"id":')).toThrow();
  });

  it('throws on an unknown status value', () => {
    const raw = JSON.stringify([{ id: '1', content: 'x', status: 'done' }]);
    expect(() => parseTodoContent(raw)).toThrow();
  });

  it('throws when the root is not an array', () => {
    expect(() => parseTodoContent('{}')).toThrow();
    expect(() => parseTodoContent('null')).toThrow();
  });

  it('throws when an item is missing a required field', () => {
    const raw = JSON.stringify([{ id: '1', status: 'pending' }]);
    expect(() => parseTodoContent(raw)).toThrow();
  });

  it('rejects unknown fields via .strict() (defends against prototype pollution and schema drift)', () => {
    // Hand-written JSON: `__proto__` in an object *literal* is assigned via
    // setPrototypeOf and gets dropped by JSON.stringify, so we must construct
    // the string directly to simulate a hostile payload on disk.
    const raw1 = '[{"id":"1","content":"x","status":"pending","__proto__":{"polluted":1}}]';
    expect(() => parseTodoContent(raw1)).toThrow();
    const raw2 = JSON.stringify([{ id: '1', content: 'x', status: 'pending', constructor: 'bad' }]);
    expect(() => parseTodoContent(raw2)).toThrow();
    const raw3 = JSON.stringify([{ id: '1', content: 'x', status: 'pending', extra: 1 }]);
    expect(() => parseTodoContent(raw3)).toThrow();
  });

  it('throws when input exceeds the size guard', () => {
    // One-char short-circuit before JSON.parse even runs.
    const huge = 'x'.repeat(5_000_001);
    expect(() => parseTodoContent(huge)).toThrow(/exceeds/);
  });
});

describe('safeParseTodoContent', () => {
  it('returns ok:true with items on valid input', () => {
    const items: TodoItem[] = [{ id: '1', content: 'x', status: 'pending' }];
    const result = safeParseTodoContent(JSON.stringify(items));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual(items);
  });

  it('returns ok:true with [] on empty array', () => {
    const result = safeParseTodoContent('[]');
    expect(result).toEqual({ ok: true, items: [] });
  });

  it('returns ok:false reason=json on malformed JSON', () => {
    const result = safeParseTodoContent('[');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('json');
  });

  it('returns ok:false reason=json on mid-write truncation', () => {
    const result = safeParseTodoContent('[{"id":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('json');
  });

  it('returns ok:false reason=schema on wrong status value', () => {
    const raw = JSON.stringify([{ id: '1', content: 'x', status: 'done' }]);
    const result = safeParseTodoContent(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema');
  });

  it('returns ok:false reason=too_large when input exceeds the size guard', () => {
    const huge = 'x'.repeat(5_000_001);
    const result = safeParseTodoContent(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
  });
});
