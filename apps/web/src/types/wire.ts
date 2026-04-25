// Wire types mirroring @task-viewer/server's SSE payload shapes.
// We duplicate rather than import @task-viewer/core types because ADR-0001
// forbids apps/web from importing core directly; the HTTP boundary is the
// only contract.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
};

export type TodoFileMeta = {
  sessionId: string;
  agentId: string;
  isSubagent: boolean;
};

// ADR-0005: which underlying watcher emitted this card.
export type TodoSource = 'todos' | 'jsonl';

export type UpsertSnapshot = {
  meta: TodoFileMeta;
  path: string;
  items: TodoItem[];
  mtimeMs: number;
  cwd: string | null;
  gitBranch: string | null;
  project: string;
  source: TodoSource;
};

export const UNKNOWN_PROJECT = '(Unknown)';

export type WireEvent =
  | { kind: 'snapshot'; files: UpsertSnapshot[] }
  | {
      kind: 'upsert';
      meta: TodoFileMeta;
      path: string;
      items: TodoItem[];
      mtimeMs: number;
      cwd: string | null;
      gitBranch: string | null;
      project: string;
      source: TodoSource;
    }
  | { kind: 'remove'; meta: TodoFileMeta; path: string }
  | { kind: 'error'; path: string; reason: string; message: string }
  | { kind: 'ready' };
