import { describe, expect, it } from 'vitest';
import {
  extractFromLine,
  extractLatestTodoWrite,
  todoWriteSignature,
} from '../src/jsonlTodoExtractor.js';

const todoLine = (
  sessionId: string,
  agentId: string,
  todos: { id: string; content: string; status: string }[],
  timestamp = '2026-04-25T00:00:00Z',
) =>
  JSON.stringify({
    parentUuid: 'p',
    sessionId,
    agentId,
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking…' },
        {
          type: 'tool_use',
          id: 'toolu_x',
          name: 'TodoWrite',
          input: { todos },
        },
      ],
    },
  });

describe('extractFromLine', () => {
  it('extracts TodoWrite items from an assistant tool_use line', () => {
    const line = todoLine('sid-1', 'sid-1', [
      { id: '1', content: 'first', status: 'pending' },
      { id: '2', content: 'second', status: 'in_progress' },
    ]);
    const out = extractFromLine(line);
    expect(out).toMatchObject({
      sessionId: 'sid-1',
      agentId: 'sid-1',
      items: [
        { id: '1', content: 'first', status: 'pending' },
        { id: '2', content: 'second', status: 'in_progress' },
      ],
    });
  });

  it('keeps the agentId when sessionId !== agentId (subagent jsonl)', () => {
    const line = todoLine('parent-sid', 'subagent-aid', [
      { id: '1', content: 'sub', status: 'completed' },
    ]);
    const out = extractFromLine(line);
    expect(out?.sessionId).toBe('parent-sid');
    expect(out?.agentId).toBe('subagent-aid');
  });

  it('returns null for non-assistant lines', () => {
    const userLine = JSON.stringify({
      type: 'user',
      sessionId: 'sid',
      message: { role: 'user', content: 'hi' },
    });
    expect(extractFromLine(userLine)).toBeNull();
  });

  it('returns null for assistant lines that do not include a TodoWrite tool_use', () => {
    const line = JSON.stringify({
      sessionId: 'sid',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    });
    expect(extractFromLine(line)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractFromLine('not json')).toBeNull();
    expect(extractFromLine('{broken')).toBeNull();
  });

  it('returns null when the input.todos array is malformed', () => {
    const line = JSON.stringify({
      sessionId: 'sid',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ id: 1, content: 'x', status: 'pending' }] }, // id should be string
          },
        ],
      },
    });
    expect(extractFromLine(line)).toBeNull();
  });

  it('returns null when sessionId is missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }],
      },
    });
    expect(extractFromLine(line)).toBeNull();
  });

  it('accepts modern TodoWrite payload shape (content/activeForm/status, no id)', () => {
    // Real Claude Code payloads today omit `id` and carry an `activeForm`
    // sibling alongside content. We must not reject these and should
    // synthesize a stable `id` from array position.
    const line = JSON.stringify({
      sessionId: 'sid',
      agentId: 'sid',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'first', activeForm: 'firsting', status: 'pending' },
                { content: 'second', activeForm: 'seconding', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    });
    const out = extractFromLine(line);
    expect(out?.items).toEqual([
      { id: '#0', content: 'first', status: 'pending' },
      { id: '#1', content: 'second', status: 'in_progress' },
    ]);
  });

  it('takes the LAST TodoWrite when a single line has multiple', () => {
    const line = JSON.stringify({
      sessionId: 'sid',
      agentId: 'sid',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ id: '1', content: 'old', status: 'pending' }] },
          },
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ id: '1', content: 'new', status: 'completed' }] },
          },
        ],
      },
    });
    expect(extractFromLine(line)?.items[0]?.content).toBe('new');
  });
});

describe('extractLatestTodoWrite', () => {
  it('returns null for an empty chunk', () => {
    expect(extractLatestTodoWrite('')).toBeNull();
  });

  it('returns the last TodoWrite across multiple lines', () => {
    const chunk = [
      JSON.stringify({ type: 'queue-operation' }),
      todoLine('sid', 'sid', [{ id: '1', content: 'first', status: 'pending' }]),
      JSON.stringify({ type: 'user', sessionId: 'sid' }),
      todoLine('sid', 'sid', [{ id: '1', content: 'second', status: 'in_progress' }]),
      todoLine('sid', 'sid', [{ id: '1', content: 'third', status: 'completed' }]),
    ].join('\n');
    expect(extractLatestTodoWrite(chunk)?.items[0]?.content).toBe('third');
  });

  it('tolerates blank and whitespace-only lines', () => {
    const chunk = [
      '',
      '   ',
      todoLine('sid', 'sid', [{ id: '1', content: 'x', status: 'pending' }]),
      '',
    ].join('\n');
    expect(extractLatestTodoWrite(chunk)?.items).toHaveLength(1);
  });

  it('returns null when no TodoWrite is present', () => {
    const chunk = [
      JSON.stringify({ type: 'queue-operation' }),
      JSON.stringify({ type: 'user', sessionId: 's' }),
    ].join('\n');
    expect(extractLatestTodoWrite(chunk)).toBeNull();
  });
});

describe('todoWriteSignature', () => {
  it('produces stable signatures for identical extractions', () => {
    const a = extractLatestTodoWrite(
      todoLine('s', 's', [{ id: '1', content: 'x', status: 'pending' }]),
    );
    const b = extractLatestTodoWrite(
      todoLine('s', 's', [{ id: '1', content: 'x', status: 'pending' }]),
    );
    expect(a && b).toBeTruthy();
    expect(a && b && todoWriteSignature(a)).toBe(b && todoWriteSignature(b));
  });

  it('changes when status flips', () => {
    const a = extractLatestTodoWrite(
      todoLine('s', 's', [{ id: '1', content: 'x', status: 'pending' }]),
    );
    const b = extractLatestTodoWrite(
      todoLine('s', 's', [{ id: '1', content: 'x', status: 'completed' }]),
    );
    expect(a && b).toBeTruthy();
    expect(a && b && todoWriteSignature(a)).not.toBe(b && todoWriteSignature(b));
  });

  it('changes when items are reordered', () => {
    const a = extractLatestTodoWrite(
      todoLine('s', 's', [
        { id: '1', content: 'a', status: 'pending' },
        { id: '2', content: 'b', status: 'pending' },
      ]),
    );
    const b = extractLatestTodoWrite(
      todoLine('s', 's', [
        { id: '2', content: 'b', status: 'pending' },
        { id: '1', content: 'a', status: 'pending' },
      ]),
    );
    expect(a && b && todoWriteSignature(a)).not.toBe(b && todoWriteSignature(b));
  });
});
