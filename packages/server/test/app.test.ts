import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrichedTodoFileEvent } from '../src/enrich.js';
import { EventBus, StateStore, createApp } from '../src/index.js';

const UUID_A = '01205cda-ff84-4259-9f77-8e898c0cf748';

const meta = (sid: string, aid = sid) => ({
  sessionId: sid,
  agentId: aid,
  isSubagent: sid !== aid,
});

const enrichmentDefaults = {
  cwd: null as string | null,
  gitBranch: null as string | null,
  project: '(Unknown)',
  source: 'todos' as const,
};

type SSEMessage = { event: string; data: string };

class SSEChunkReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending = '';

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(timeoutMs = 2000): Promise<SSEMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (!this.pending.includes('\n\n')) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('SSE read timeout');
      const readP = this.reader.read();
      const timeoutP = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SSE read timeout')), remaining),
      );
      const res = await Promise.race([readP, timeoutP]);
      if (res.done) return null;
      this.pending += this.decoder.decode(res.value, { stream: true });
    }
    const idx = this.pending.indexOf('\n\n');
    const raw = this.pending.slice(0, idx);
    this.pending = this.pending.slice(idx + 2);
    return parseSSE(raw);
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

function parseSSE(raw: string): SSEMessage {
  let event = '';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trimStart();
  }
  return { event, data };
}

describe('createApp', () => {
  let state: StateStore;
  let bus: EventBus<EnrichedTodoFileEvent>;
  let reader: SSEChunkReader | null = null;

  beforeEach(() => {
    state = new StateStore();
    bus = new EventBus<EnrichedTodoFileEvent>();
  });

  afterEach(async () => {
    if (reader) await reader.cancel().catch(() => undefined);
    reader = null;
    bus.closeAll();
  });

  it('GET /healthz returns 200 ok', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /events sends a snapshot first with the current state', async () => {
    state.apply({
      kind: 'upsert',
      meta: meta(UUID_A),
      path: '/p/a.json',
      items: [{ id: '1', content: 'x', status: 'pending' }],
      mtimeMs: 42,
      cwd: '/Users/x/task_viewer',
      gitBranch: 'main',
      project: 'task_viewer',
      source: 'todos',
    });
    const app = createApp({ state, bus });
    const res = await app.request('/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    const msg = await reader.next();
    expect(msg?.event).toBe('snapshot');
    const payload = JSON.parse(msg?.data ?? '{}');
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].path).toBe('/p/a.json');
    expect(payload.files[0].mtimeMs).toBe(42);
  });

  it('GET /events forwards a live upsert after the snapshot', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/events');
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    const snap = await reader.next();
    expect(snap?.event).toBe('snapshot');

    bus.publish({
      kind: 'upsert',
      meta: meta(UUID_A),
      path: '/p/b.json',
      items: [{ id: '1', content: 'hello', status: 'in_progress' }],
      mtimeMs: 99,
      cwd: '/Users/x/other',
      gitBranch: 'feat',
      project: 'other',
      source: 'jsonl',
    });
    const up = await reader.next();
    expect(up?.event).toBe('upsert');
    const payload = JSON.parse(up?.data ?? '{}');
    expect(payload.path).toBe('/p/b.json');
    expect(payload.items[0].content).toBe('hello');
    expect(payload.cwd).toBe('/Users/x/other');
    expect(payload.gitBranch).toBe('feat');
    expect(payload.project).toBe('other');
    expect(payload.source).toBe('jsonl');
  });

  it('forwards remove events with meta and path only', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/events');
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    await reader.next();
    bus.publish({ kind: 'remove', meta: meta(UUID_A), path: '/p/c.json' });
    const msg = await reader.next();
    expect(msg?.event).toBe('remove');
    const payload = JSON.parse(msg?.data ?? '{}');
    expect(payload.path).toBe('/p/c.json');
    expect(payload.meta.sessionId).toBe(UUID_A);
  });

  it('forwards error events with message string only (no stack)', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/events');
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    await reader.next();
    const err = new Error('boom');
    bus.publish({ kind: 'error', path: '/p/c.json', reason: 'json', error: err });
    const msg = await reader.next();
    expect(msg?.event).toBe('error');
    const payload = JSON.parse(msg?.data ?? '{}');
    expect(payload).toEqual({ path: '/p/c.json', reason: 'json', message: 'boom' });
    // Explicitly no stack leakage:
    expect(payload.stack).toBeUndefined();
  });

  it('forwards ready events as empty-object payload', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/events');
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    await reader.next();
    bus.publish({ kind: 'ready' });
    const msg = await reader.next();
    expect(msg?.event).toBe('ready');
    expect(msg?.data).toBe('{}');
  });

  it('unsubscribes from the bus when the client disconnects', async () => {
    const app = createApp({ state, bus });
    expect(bus.size()).toBe(0);
    const res = await app.request('/events');
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    await reader.next();
    expect(bus.size()).toBe(1);
    await reader.cancel();
    // Give the abort a tick to propagate through streamSSE + onAbort.
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.size()).toBe(0);
    reader = null;
  });

  it('subscribes before snapshot so events during snapshot emission are not lost', async () => {
    // After subscribe-first, a publish that races the snapshot write must
    // reach the new subscriber (possibly as a duplicate of the snapshot).
    const app = createApp({ state, bus });
    const res = await app.request('/events');
    reader = new SSEChunkReader(res.body as ReadableStream<Uint8Array>);
    // Publish immediately; with subscribe-after-snapshot this would be lost.
    bus.publish({
      kind: 'upsert',
      meta: meta(UUID_A),
      path: '/p/race.json',
      items: [{ id: '1', content: 'race', status: 'in_progress' }],
      mtimeMs: 1,
      ...enrichmentDefaults,
    });
    const snap = await reader.next();
    expect(snap?.event).toBe('snapshot');
    const next = await reader.next();
    expect(next?.event).toBe('upsert');
    expect(JSON.parse(next?.data ?? '{}').path).toBe('/p/race.json');
  });

  it('echoes a whitelisted Origin in CORS headers', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/healthz', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('refuses to echo a non-whitelisted Origin', async () => {
    const app = createApp({ state, bus });
    const res = await app.request('/healthz', {
      headers: { Origin: 'http://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('http://evil.example');
  });

  it('accepts a custom corsOrigin override', async () => {
    const app = createApp({ state, bus, corsOrigin: 'http://my-ui.local' });
    const res = await app.request('/healthz', {
      headers: { Origin: 'http://my-ui.local' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://my-ui.local');
  });
});
