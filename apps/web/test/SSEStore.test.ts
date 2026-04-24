import { beforeEach, describe, expect, it } from 'vitest';
import { SSEStore } from '../src/sse/SSEStore.js';

// Minimal mock that implements just enough of the EventSource surface used by
// SSEStore. Extending EventTarget gives us addEventListener/dispatchEvent.
class MockEventSource extends EventTarget {
  closed = false;
  constructor(public url: string) {
    super();
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, data: unknown): void {
    this.dispatchEvent(
      new MessageEvent(event, { data: typeof data === 'string' ? data : JSON.stringify(data) }),
    );
  }
  emitNativeError(): void {
    this.dispatchEvent(new Event('error'));
  }
  emitOpen(): void {
    this.dispatchEvent(new Event('open'));
  }
}

type Created = { source: MockEventSource; url: string };

function factoryWith(collected: Created[]): (url: string) => EventSource {
  return (url) => {
    const source = new MockEventSource(url);
    collected.push({ source, url });
    return source as unknown as EventSource;
  };
}

describe('SSEStore', () => {
  let created: Created[];
  let store: SSEStore;

  beforeEach(() => {
    created = [];
    store = new SSEStore(factoryWith(created));
  });

  it('starts in connecting state with no files', () => {
    const s = store.getSnapshot();
    expect(s.connection).toBe('connecting');
    expect(s.files).toEqual({});
    expect(s.ready).toBe(false);
  });

  it('connect() opens one EventSource at the given url', () => {
    store.connect('/events');
    expect(created).toHaveLength(1);
    expect(created[0]?.url).toBe('/events');
  });

  it('connect() is idempotent — a second call does not open a second EventSource', () => {
    store.connect('/events');
    store.connect('/events');
    expect(created).toHaveLength(1);
  });

  it('open event flips connection to open', () => {
    store.connect('/events');
    created[0]?.source.emitOpen();
    expect(store.getSnapshot().connection).toBe('open');
  });

  it('snapshot event populates files', () => {
    store.connect('/events');
    created[0]?.source.emit('snapshot', {
      files: [
        {
          meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
          path: '/p/a',
          items: [{ id: '1', content: 'x', status: 'pending' }],
          mtimeMs: 1,
        },
      ],
    });
    expect(Object.keys(store.getSnapshot().files)).toEqual(['/p/a']);
  });

  it('upsert event appends or replaces a file', () => {
    store.connect('/events');
    created[0]?.source.emit('upsert', {
      meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
      path: '/p/b',
      items: [{ id: '1', content: 'hi', status: 'in_progress' }],
      mtimeMs: 42,
    });
    expect(store.getSnapshot().files['/p/b']?.mtimeMs).toBe(42);
  });

  it('remove event deletes a file', () => {
    store.connect('/events');
    created[0]?.source.emit('snapshot', {
      files: [
        {
          meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
          path: '/p/a',
          items: [],
          mtimeMs: 1,
        },
      ],
    });
    created[0]?.source.emit('remove', {
      meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
      path: '/p/a',
    });
    expect(store.getSnapshot().files).toEqual({});
  });

  it('ready event sets the ready flag', () => {
    store.connect('/events');
    created[0]?.source.emit('ready', {});
    expect(store.getSnapshot().ready).toBe(true);
  });

  it('server-sent error message populates errorMessage', () => {
    store.connect('/events');
    created[0]?.source.emit('error', {
      path: '/p/broken.json',
      reason: 'json',
      message: 'bad json',
    });
    expect(store.getSnapshot().errorMessage).toContain('json');
    // Receiving any data event (including server-sent 'error') promotes
    // connection from 'connecting' to 'open' — we're clearly reachable.
    expect(store.getSnapshot().connection).toBe('open');
  });

  it('native connection error flips connection to error', () => {
    store.connect('/events');
    created[0]?.source.emitNativeError();
    expect(store.getSnapshot().connection).toBe('error');
  });

  it('close() terminates the EventSource and flips connection to closed', () => {
    store.connect('/events');
    store.close();
    expect(created[0]?.source.closed).toBe(true);
    expect(store.getSnapshot().connection).toBe('closed');
  });

  it('subscribers are notified on every state change', () => {
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.connect('/events');
    created[0]?.source.emit('snapshot', { files: [] });
    expect(calls).toBeGreaterThan(0);
  });

  it('unsubscribe stops notifications', () => {
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls++;
    });
    unsub();
    store.connect('/events');
    created[0]?.source.emit('snapshot', { files: [] });
    expect(calls).toBe(0);
  });

  it('getConnectionView reference is stable across unrelated file updates', () => {
    store.connect('/events');
    created[0]?.source.emit('snapshot', {
      files: [
        {
          meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
          path: '/p/a',
          items: [],
          mtimeMs: 1,
        },
      ],
    });
    const view1 = store.getConnectionView();
    // Subsequent upserts don't touch connection/errorMessage/ready.
    created[0]?.source.emit('upsert', {
      meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
      path: '/p/b',
      items: [],
      mtimeMs: 2,
    });
    const view2 = store.getConnectionView();
    expect(view2).toBe(view1);
  });

  it('no-op state updates (same reference) do not notify subscribers', () => {
    store.connect('/events');
    created[0]?.source.emit('snapshot', {
      files: [
        {
          meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
          path: '/p/a',
          items: [],
          mtimeMs: 1,
        },
      ],
    });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    created[0]?.source.emit('remove', {
      meta: { sessionId: 'a', agentId: 'a', isSubagent: false },
      path: '/p/does-not-exist',
    });
    expect(calls).toBe(0);
  });
});
