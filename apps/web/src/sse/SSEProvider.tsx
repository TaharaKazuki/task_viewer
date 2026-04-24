import { type ReactNode, createContext, useContext, useEffect, useRef } from 'react';
import { type EventSourceFactory, SSEStore } from './SSEStore.js';

const SSEStoreContext = createContext<SSEStore | null>(null);

export type SSEProviderProps = {
  url: string;
  children: ReactNode;
  // Tests can inject a mock factory to avoid touching the real EventSource.
  factory?: EventSourceFactory;
  // Tests can inject a preconstructed store instead of creating one.
  store?: SSEStore;
};

export function SSEProvider({ url, children, factory, store: storeProp }: SSEProviderProps) {
  // useRef lazy-init captures the store on first render. A plain useMemo
  // would recreate the store on every factory-prop identity change, leaking
  // the previous EventSource because useEffect cleanup runs AFTER the new
  // instance is assigned. See docs/learnings/2026-04-24-web-adversary-insights.md.
  const storeRef = useRef<SSEStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = storeProp ?? new SSEStore(factory);
  }
  const instance = storeRef.current;

  useEffect(() => {
    instance.connect(url);
    return () => {
      instance.close();
    };
  }, [instance, url]);

  return <SSEStoreContext.Provider value={instance}>{children}</SSEStoreContext.Provider>;
}

export function useSSEStore(): SSEStore {
  const store = useContext(SSEStoreContext);
  if (!store) {
    throw new Error('useSSEStore must be used inside <SSEProvider>');
  }
  return store;
}
