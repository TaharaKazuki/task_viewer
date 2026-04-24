import { useCallback, useSyncExternalStore } from 'react';
import { useSSEStore } from '../sse/SSEProvider.js';
import type { TodoFiles } from '../sse/applyEvent.js';

export function useTodoFiles(): TodoFiles {
  const store = useSSEStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.getSnapshot().files, [store]),
  );
}
