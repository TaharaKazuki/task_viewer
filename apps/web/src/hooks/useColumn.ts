import { useMemo } from 'react';
import type { TodoFiles } from '../sse/applyEvent.js';
import type { TodoItem, TodoStatus, UpsertSnapshot } from '../types/wire.js';
import { useTodoFiles } from './useTodoFiles.js';

export type ColumnCard = {
  // Stable identity across renders so React's keyed reconciliation is happy.
  key: string;
  file: UpsertSnapshot;
  item: TodoItem;
};

function compareCards(a: ColumnCard, b: ColumnCard): number {
  // Most recently updated files first so the eye catches changes.
  const dt = b.file.mtimeMs - a.file.mtimeMs;
  if (dt !== 0) return dt;
  // Deterministic tiebreaker: fs mtime collisions happen in tests and under
  // rapid writes, and insertion-order sort makes unrelated items jump around.
  if (a.file.path !== b.file.path) return a.file.path < b.file.path ? -1 : 1;
  return a.item.id < b.item.id ? -1 : 1;
}

function buildColumn(files: TodoFiles, status: TodoStatus): ColumnCard[] {
  const cards: ColumnCard[] = [];
  for (const path of Object.keys(files)) {
    const file = files[path];
    if (!file) continue;
    for (const item of file.items) {
      if (item.status !== status) continue;
      cards.push({ key: `${file.path}::${item.id}`, file, item });
    }
  }
  cards.sort(compareCards);
  return cards;
}

export function useColumn(status: TodoStatus): ColumnCard[] {
  const files = useTodoFiles();
  return useMemo(() => buildColumn(files, status), [files, status]);
}
