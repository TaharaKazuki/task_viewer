type Resolver<T> = (r: IteratorResult<T>) => void;

type Subscriber<T> = {
  queue: T[];
  pendingResolves: Array<Resolver<T>>;
  closed: boolean;
};

export type Subscription<T> = {
  events: AsyncIterable<T>;
  unsubscribe: () => void;
};

export type EventBusOptions = {
  // Per-subscriber buffer cap. On overflow the oldest event is dropped.
  // This is a lossy backpressure policy: we prefer dropping old events
  // over growing unbounded memory when a slow client can't keep up.
  // See docs/learnings/2026-04-24-server-adversary-insights.md.
  maxBufferSize?: number;
};

// Fan-out event bus. See docs/learnings/2026-04-24-watcher-adversary-insights.md
// for the single-slot resolver footgun and iterator.return() cleanup contract
// this implementation inherits.
export class EventBus<T> {
  private readonly subs = new Set<Subscriber<T>>();
  private readonly maxBufferSize: number;
  private allClosed = false;

  constructor(opts: EventBusOptions = {}) {
    this.maxBufferSize = opts.maxBufferSize ?? 10_000;
  }

  publish(ev: T): void {
    if (this.allClosed) return;
    // Iterate a snapshot of subs: if a resolver callback synchronously calls
    // unsubscribe() on another subscription, mutating this.subs during
    // iteration is undefined for Set semantics in all engines.
    for (const sub of Array.from(this.subs)) {
      if (sub.closed) continue;
      const resolver = sub.pendingResolves.shift();
      if (resolver) {
        resolver({ value: ev, done: false });
        continue;
      }
      if (sub.queue.length >= this.maxBufferSize) {
        sub.queue.shift();
      }
      sub.queue.push(ev);
    }
  }

  subscribe(): Subscription<T> {
    const sub: Subscriber<T> = { queue: [], pendingResolves: [], closed: false };
    this.subs.add(sub);

    const drainResolversAsDone = (): void => {
      while (sub.pendingResolves.length > 0) {
        const r = sub.pendingResolves.shift();
        if (r) r({ value: undefined as never, done: true });
      }
    };

    const unsubscribe = (): void => {
      if (sub.closed) return;
      sub.closed = true;
      this.subs.delete(sub);
      drainResolversAsDone();
    };

    const events: AsyncIterable<T> = {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const queued = sub.queue.shift();
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false });
            }
            if (sub.closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve) => {
              sub.pendingResolves.push(resolve);
            });
          },
          async return(): Promise<IteratorResult<T>> {
            unsubscribe();
            return { value: undefined as never, done: true };
          },
        };
      },
    };

    return { events, unsubscribe };
  }

  closeAll(): void {
    if (this.allClosed) return;
    this.allClosed = true;
    for (const sub of this.subs) {
      sub.closed = true;
      while (sub.pendingResolves.length > 0) {
        const r = sub.pendingResolves.shift();
        if (r) r({ value: undefined as never, done: true });
      }
    }
    this.subs.clear();
  }

  size(): number {
    return this.subs.size;
  }
}
