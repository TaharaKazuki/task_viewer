import type { TodoItem, UpsertSnapshot } from '../types/wire.js';

function shortId(id: string): string {
  return id.slice(0, 8);
}

function relativeTime(mtimeMs: number, now = Date.now()): string {
  const deltaSec = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h ago`;
  const deltaDay = Math.round(deltaHour / 24);
  return `${deltaDay}d ago`;
}

export type TodoCardProps = {
  file: UpsertSnapshot;
  item: TodoItem;
  now?: number;
};

export function TodoCard({ file, item, now }: TodoCardProps) {
  return (
    <article className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm hover:shadow-md transition-shadow">
      <header className="flex items-center justify-between gap-2 text-xs text-slate-500 mb-1">
        <span
          className="truncate font-medium text-slate-700 max-w-[60%]"
          title={file.cwd ?? '(unknown)'}
        >
          {file.project}
          {file.gitBranch ? (
            <span className="ml-1 text-[10px] text-slate-400 font-mono">@{file.gitBranch}</span>
          ) : null}
        </span>
        {file.meta.isSubagent && (
          <span className="rounded bg-amber-100 text-amber-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            sub
          </span>
        )}
        <span className="ml-auto tabular-nums">{relativeTime(file.mtimeMs, now)}</span>
      </header>
      <p className="text-sm leading-snug text-slate-900 whitespace-pre-wrap break-words">
        {item.content}
      </p>
      <footer className="mt-1 text-[10px] font-mono text-slate-400" title={file.meta.sessionId}>
        {shortId(file.meta.sessionId)}
      </footer>
    </article>
  );
}
