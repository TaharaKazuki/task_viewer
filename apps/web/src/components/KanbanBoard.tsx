import { Column } from './Column.js';

export function KanbanBoard() {
  return (
    <main className="flex flex-1 min-h-0 gap-3 p-3">
      <Column status="pending" />
      <Column status="in_progress" />
      <Column status="completed" />
    </main>
  );
}
