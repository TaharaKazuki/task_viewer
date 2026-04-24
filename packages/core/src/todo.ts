import { z } from 'zod';

const todoItemSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .strict();

const todoArraySchema = z.array(todoItemSchema);

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoStatus = TodoItem['status'];

export type TodoFileMeta = {
  sessionId: string;
  agentId: string;
  isSubagent: boolean;
};

export type ParseReason = 'json' | 'schema' | 'too_large';

export type ParseResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; reason: ParseReason; error: Error };

// Guard against pathological input. chokidar fan-out + a malicious multi-MB file
// would otherwise block the event loop on JSON.parse.
const MAX_TODO_BYTES = 5_000_000;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TODO_FILENAME_RE = new RegExp(`^(${UUID})-agent-(${UUID})\\.json$`);

export function parseTodoFilename(filename: string): TodoFileMeta | null {
  const basename = filename.split(/[\\/]/).pop() ?? '';
  const match = TODO_FILENAME_RE.exec(basename);
  if (!match) return null;
  const rawSession = match[1];
  const rawAgent = match[2];
  if (!rawSession || !rawAgent) return null;
  // Normalize to lowercase: downstream uses these as Map keys; macOS/APFS is
  // case-insensitive-but-preserving and a rename roundtrip can flip the case.
  const sessionId = rawSession.toLowerCase();
  const agentId = rawAgent.toLowerCase();
  return { sessionId, agentId, isSubagent: sessionId !== agentId };
}

export function parseTodoContent(raw: string): TodoItem[] {
  if (raw.length > MAX_TODO_BYTES) {
    throw new Error(`todo payload exceeds ${MAX_TODO_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(raw);
  return todoArraySchema.parse(parsed);
}

export function safeParseTodoContent(raw: string): ParseResult<TodoItem> {
  if (raw.length > MAX_TODO_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      error: new Error(`todo payload exceeds ${MAX_TODO_BYTES} bytes`),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'json', error: e as Error };
  }
  const result = todoArraySchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: 'schema', error: result.error };
  }
  return { ok: true, items: result.data };
}
