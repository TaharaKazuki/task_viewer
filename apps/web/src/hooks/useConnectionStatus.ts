import { useSyncExternalStore } from 'react';
import { useSSEStore } from '../sse/SSEProvider.js';
import type { ConnectionView } from '../sse/SSEStore.js';

export type ConnectionStatus = ConnectionView;

export function useConnectionStatus(): ConnectionStatus {
  const store = useSSEStore();
  // getConnectionView returns a cached projection whose identity is stable
  // across unrelated file mutations — critical for avoiding re-renders on
  // every upsert. See the SSEStore docstring.
  return useSyncExternalStore(store.subscribe, store.getConnectionView);
}
