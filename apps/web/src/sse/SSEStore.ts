import type { WireEvent } from '../types/wire.js';
import { INITIAL_STATE, type StoreState, applyEvent } from './applyEvent.js';

export type EventSourceFactory = (url: string) => EventSource;

const defaultFactory: EventSourceFactory = (url) => new EventSource(url);

// The store exposes two snapshots:
// - getSnapshot(): full state. Any consumer calling this via
//   useSyncExternalStore re-renders on every change.
// - getConnectionView(): a stable-reference projection of just
//   { connection, errorMessage, ready }. Changes identity only when one of
//   those fields actually changes, so useSyncExternalStore doesn't consider
//   unrelated `files` updates as changes. See
//   docs/learnings/2026-04-24-web-adversary-insights.md.
export type ConnectionView = {
  state: StoreState['connection'];
  errorMessage: string | null;
  ready: boolean;
};

function deriveConnectionView(s: StoreState): ConnectionView {
  return { state: s.connection, errorMessage: s.errorMessage, ready: s.ready };
}

export class SSEStore {
  private state: StoreState = INITIAL_STATE;
  private connectionView: ConnectionView = deriveConnectionView(INITIAL_STATE);
  private readonly listeners = new Set<() => void>();
  private source: EventSource | null = null;

  constructor(private readonly factory: EventSourceFactory = defaultFactory) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): StoreState => this.state;

  getConnectionView = (): ConnectionView => this.connectionView;

  connect(url: string): void {
    if (this.source) return;
    const es = this.factory(url);
    this.source = es;

    es.addEventListener('open', () => {
      this.setState((s) => ({ ...s, connection: 'open', errorMessage: null }));
    });

    es.addEventListener('snapshot', (e) => {
      this.dispatchMessage(e, (data) => ({
        kind: 'snapshot',
        files: data.files,
      }));
    });

    es.addEventListener('upsert', (e) => {
      this.dispatchMessage(e, (data) => ({
        kind: 'upsert',
        meta: data.meta,
        path: data.path,
        items: data.items,
        mtimeMs: data.mtimeMs,
        cwd: data.cwd ?? null,
        gitBranch: data.gitBranch ?? null,
        project: data.project ?? '(Unknown)',
        source: data.source === 'jsonl' ? 'jsonl' : 'todos',
      }));
    });

    es.addEventListener('remove', (e) => {
      this.dispatchMessage(e, (data) => ({
        kind: 'remove',
        meta: data.meta,
        path: data.path,
      }));
    });

    es.addEventListener('ready', () => {
      this.dispatch({ kind: 'ready' });
    });

    // 'error' is overloaded in the EventSource API: a server-sent event named
    // 'error' arrives as a MessageEvent with data, while native connection
    // failures arrive as a plain Event with no data. Dispatch differently.
    es.addEventListener('error', (e: Event) => {
      if (e instanceof MessageEvent && typeof e.data === 'string') {
        try {
          const data = JSON.parse(e.data);
          this.dispatch({
            kind: 'error',
            path: data.path,
            reason: data.reason,
            message: data.message,
          });
        } catch {
          // Malformed error payload — treat as connection error.
          this.setState((s) => ({ ...s, connection: 'error' }));
        }
        return;
      }
      this.setState((s) => ({ ...s, connection: 'error' }));
    });
  }

  close(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.setState((s) => ({ ...s, connection: 'closed' }));
  }

  private dispatchMessage(
    e: Event,
    toEvent: (data: ReturnType<typeof JSON.parse>) => WireEvent,
  ): void {
    if (!(e instanceof MessageEvent) || typeof e.data !== 'string') return;
    let data: ReturnType<typeof JSON.parse>;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    this.dispatch(toEvent(data));
  }

  private dispatch(ev: WireEvent): void {
    this.setState((s) => applyEvent(s, ev));
  }

  private setState(update: (prev: StoreState) => StoreState): void {
    const prev = this.state;
    const next = update(prev);
    if (next === prev) return;
    this.state = next;
    if (
      next.connection !== prev.connection ||
      next.errorMessage !== prev.errorMessage ||
      next.ready !== prev.ready
    ) {
      this.connectionView = deriveConnectionView(next);
    }
    for (const l of this.listeners) l();
  }
}
