import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus.js';

async function takeN<T>(events: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  const iter = events[Symbol.asyncIterator]();
  while (out.length < n) {
    const r = await iter.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe('EventBus', () => {
  it('delivers events to a single subscriber', async () => {
    const bus = new EventBus<string>();
    const sub = bus.subscribe();
    bus.publish('a');
    bus.publish('b');
    const got = await takeN(sub.events, 2);
    expect(got).toEqual(['a', 'b']);
  });

  it('fans out to multiple subscribers', async () => {
    const bus = new EventBus<number>();
    const s1 = bus.subscribe();
    const s2 = bus.subscribe();
    bus.publish(1);
    bus.publish(2);
    expect(await takeN(s1.events, 2)).toEqual([1, 2]);
    expect(await takeN(s2.events, 2)).toEqual([1, 2]);
  });

  it('drops events published before there are any subscribers', async () => {
    const bus = new EventBus<number>();
    bus.publish(1);
    const sub = bus.subscribe();
    bus.publish(2);
    expect(await takeN(sub.events, 1)).toEqual([2]);
  });

  it('stops delivering after unsubscribe()', async () => {
    const bus = new EventBus<string>();
    const sub = bus.subscribe();
    bus.publish('a');
    await takeN(sub.events, 1);
    sub.unsubscribe();
    expect(bus.size()).toBe(0);
  });

  it('survives interleaved next() calls (FIFO resolver queue)', async () => {
    const bus = new EventBus<number>();
    const sub = bus.subscribe();
    const iter = sub.events[Symbol.asyncIterator]();
    const p1 = iter.next();
    const p2 = iter.next();
    const p3 = iter.next();
    bus.publish(1);
    bus.publish(2);
    bus.publish(3);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect([r1.value, r2.value, r3.value]).toEqual([1, 2, 3]);
  });

  it('closeAll() ends all pending subscribers with done=true', async () => {
    const bus = new EventBus<string>();
    const sub1 = bus.subscribe();
    const sub2 = bus.subscribe();
    const iter1 = sub1.events[Symbol.asyncIterator]();
    const iter2 = sub2.events[Symbol.asyncIterator]();
    const p1 = iter1.next();
    const p2 = iter2.next();
    bus.closeAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
    expect(bus.size()).toBe(0);
  });

  it('for-await break triggers unsubscribe via iterator.return()', async () => {
    const bus = new EventBus<string>();
    const sub = bus.subscribe();
    expect(bus.size()).toBe(1);
    bus.publish('x');
    for await (const _ of sub.events) {
      break;
    }
    expect(bus.size()).toBe(0);
  });

  it('drops oldest events when a subscribers queue exceeds maxBufferSize', async () => {
    const bus = new EventBus<number>({ maxBufferSize: 3 });
    const sub = bus.subscribe();
    for (let i = 1; i <= 5; i++) bus.publish(i);
    const got = await takeN(sub.events, 3);
    expect(got).toEqual([3, 4, 5]);
  });

  it('tolerates a subscriber unsubscribing during publish (defensive iteration)', async () => {
    const bus = new EventBus<number>();
    const s1 = bus.subscribe();
    const s2 = bus.subscribe();
    // Arrange a pending next() on s1 whose resolver synchronously kicks off
    // an unsubscribe of s2 (simulating onAbort behavior during a publish fan-out).
    const iter1 = s1.events[Symbol.asyncIterator]();
    const p1 = iter1.next().then((r) => {
      s2.unsubscribe();
      return r;
    });
    bus.publish(10);
    const r1 = await p1;
    expect(r1).toEqual({ value: 10, done: false });
    expect(bus.size()).toBe(1);
  });
});
