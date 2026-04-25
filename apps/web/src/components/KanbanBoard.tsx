import { Column } from './Column.js';

export type KanbanBoardProps = { project: string };

export function KanbanBoard({ project }: KanbanBoardProps) {
  return (
    <main className="flex flex-1 min-h-0 gap-3 p-3">
      <Column status="pending" project={project} />
      <Column status="in_progress" project={project} />
      <Column status="completed" project={project} />
    </main>
  );
}
