import { z } from 'zod';

// Schema mirrors the fields we actually consume. Other JSONL fields
// (parentUuid, message, uuid, isMeta, etc.) are ignored.
const jsonlMessageSchema = z.object({
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  timestamp: z.string().optional(),
  type: z.string().optional(),
});

export type JsonlMessage = z.infer<typeof jsonlMessageSchema>;

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  gitBranch: string | null;
};

// Reasonable ceiling for a single JSONL line. Claude Code's largest observed
// lines (inline tool_result payloads) are well under 2 MB.
const MAX_LINE_BYTES = 5_000_000;

export function parseJsonlLine(raw: string): JsonlMessage | null {
  if (raw.length === 0) return null;
  if (raw.length > MAX_LINE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = jsonlMessageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// Pull the first usable session metadata out of the head of a JSONL file.
// Skips `file-history-snapshot` and other entries that lack sessionId+cwd.
export function extractSessionMeta(chunk: string): SessionMeta | null {
  const lines = chunk.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const msg = parseJsonlLine(trimmed);
    if (!msg) continue;
    if (typeof msg.sessionId !== 'string' || typeof msg.cwd !== 'string') continue;
    if (msg.sessionId.length === 0 || msg.cwd.length === 0) continue;
    return {
      sessionId: msg.sessionId,
      cwd: msg.cwd,
      gitBranch:
        typeof msg.gitBranch === 'string' && msg.gitBranch.length > 0 ? msg.gitBranch : null,
    };
  }
  return null;
}
