import { z } from 'zod';
import type { TodoItem } from './todo.js';

// JSONL-sourced TodoWrite payloads historically carried {id, content, status}.
// Current Claude Code payloads are {content, activeForm, status} — no id,
// with a required activeForm. Accept both. `id` is synthesized from array
// position when absent; unknown fields like activeForm are ignored.
const todoItemSchema = z
  .object({
    id: z.string().optional(),
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .passthrough();

const toolUseSchema = z
  .object({
    type: z.literal('tool_use'),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const todoWriteInputSchema = z
  .object({
    todos: z.array(todoItemSchema),
  })
  .passthrough();

// Per-line shape. Most fields are optional; we only require enough to
// recognize an assistant tool_use payload.
const jsonlAssistantLineSchema = z
  .object({
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    type: z.string().optional(),
    timestamp: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ExtractedTodoWrite = {
  sessionId: string;
  agentId: string;
  items: TodoItem[];
  timestamp: string | null;
};

// Walk the lines of a JSONL chunk forward and return the LAST TodoWrite
// tool_use payload encountered, plus the sessionId/agentId attached to that
// line. Returns null when no TodoWrite is present in the chunk.
//
// Pure function: takes the chunk string, returns the extracted payload.
// The caller (jsonlTodoWatcher) handles fs I/O and incremental tailing.
export function extractLatestTodoWrite(chunk: string): ExtractedTodoWrite | null {
  let latest: ExtractedTodoWrite | null = null;
  for (const raw of chunk.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const found = extractFromLine(line);
    if (found) latest = found;
  }
  return latest;
}

// Process a single line; returns the extracted TodoWrite if the line is
// an assistant tool_use with name=TodoWrite, otherwise null.
export function extractFromLine(line: string): ExtractedTodoWrite | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const meta = jsonlAssistantLineSchema.safeParse(parsed);
  if (!meta.success) return null;
  const content = meta.data.message?.content;
  if (!Array.isArray(content)) return null;
  // Search forward through tool_use entries; if a single line carries multiple
  // TodoWrite calls (rare but possible), the last one wins.
  let extracted: ExtractedTodoWrite | null = null;
  for (const entry of content) {
    const tu = toolUseSchema.safeParse(entry);
    if (!tu.success) continue;
    if (tu.data.name !== 'TodoWrite') continue;
    const input = todoWriteInputSchema.safeParse(tu.data.input);
    if (!input.success) continue;
    const sessionId = meta.data.sessionId;
    if (!sessionId) continue;
    extracted = {
      sessionId,
      // For top-level session JSONLs the agentId equals sessionId.
      // Subagent JSONLs carry a distinct agentId in the same line.
      agentId: meta.data.agentId ?? sessionId,
      items: input.data.todos.map((t, i) => ({
        id: t.id ?? `#${i}`,
        content: t.content,
        status: t.status,
      })),
      timestamp: meta.data.timestamp ?? null,
    };
  }
  return extracted;
}

// Cheap signature for change detection. Two extractions with identical
// signatures can be deduped by the watcher to avoid pointless emits.
export function todoWriteSignature(extraction: ExtractedTodoWrite): string {
  // Order matters; tasks reordered by the user count as a change.
  const items = extraction.items.map((i) => `${i.id}:${i.status}:${i.content}`).join('|');
  return `${extraction.sessionId}/${extraction.agentId}#${items}`;
}
