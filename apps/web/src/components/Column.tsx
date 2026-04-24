import { useColumn } from '../hooks/useColumn.js';
import type { TodoStatus } from '../types/wire.js';
import { TodoCard } from './TodoCard.js';

const TITLES: Record<TodoStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
};

const COLORS: Record<TodoStatus, string> = {
  pending: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
};

export type ColumnProps = { status: TodoStatus };

export function Column({ status }: ColumnProps) {
  const cards = useColumn(status);
  return (
    <section
      className="flex min-w-0 flex-1 flex-col rounded-lg border border-slate-200 bg-slate-50"
      aria-label={`${TITLES[status]} column`}
    >
      <header
        className={`rounded-t-lg px-3 py-2 text-sm font-semibold flex items-center justify-between ${COLORS[status]}`}
      >
        <span>{TITLES[status]}</span>
        <span className="rounded bg-white/60 px-2 py-0.5 text-xs font-medium tabular-nums">
          {cards.length}
        </span>
      </header>
      <div className="flex flex-col gap-2 overflow-y-auto p-2">
        {cards.length === 0 ? (
          <p className="text-xs text-slate-400 italic py-4 text-center">empty</p>
        ) : (
          cards.map((c) => <TodoCard key={c.key} file={c.file} item={c.item} />)
        )}
      </div>
    </section>
  );
}
