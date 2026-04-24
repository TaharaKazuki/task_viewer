import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KanbanBoard } from '../src/components/KanbanBoard.js';
import { SSEProvider } from '../src/sse/SSEProvider.js';
import { SSEStore } from '../src/sse/SSEStore.js';

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
      new MessageEvent(event, {
        data: typeof data === 'string' ? data : JSON.stringify(data),
      }),
    );
  }
}

const meta = (sid: string) => ({ sessionId: sid, agentId: sid, isSubagent: false });

const file = (path: string, content: string, status: 'pending' | 'in_progress' | 'completed') => ({
  meta: meta('aaaaaaaa'),
  path,
  items: [{ id: '1', content, status }],
  mtimeMs: 10_000,
});

describe('KanbanBoard (integration)', () => {
  it('renders a snapshot across three columns and updates on live events', async () => {
    let source: MockEventSource | null = null;
    const factory = (url: string) => {
      source = new MockEventSource(url);
      return source as unknown as EventSource;
    };
    const store = new SSEStore(factory);

    render(
      <SSEProvider url="/events" store={store}>
        <KanbanBoard />
      </SSEProvider>,
    );

    // Empty initial state: three columns with "empty" placeholders.
    const pendingCol = screen.getByLabelText('Pending column');
    const inProgressCol = screen.getByLabelText('In Progress column');
    const completedCol = screen.getByLabelText('Completed column');
    expect(within(pendingCol).getByText('empty')).toBeInTheDocument();
    expect(within(inProgressCol).getByText('empty')).toBeInTheDocument();
    expect(within(completedCol).getByText('empty')).toBeInTheDocument();

    // Server pushes a snapshot with one file in each status.
    act(() => {
      source?.emit('snapshot', {
        files: [
          file('/p/a.json', 'pending task', 'pending'),
          file('/p/b.json', 'working task', 'in_progress'),
          file('/p/c.json', 'done task', 'completed'),
        ],
      });
    });

    expect(within(pendingCol).getByText('pending task')).toBeInTheDocument();
    expect(within(inProgressCol).getByText('working task')).toBeInTheDocument();
    expect(within(completedCol).getByText('done task')).toBeInTheDocument();

    // Live upsert: advance /p/a.json from pending to completed.
    act(() => {
      source?.emit('upsert', {
        meta: meta('aaaaaaaa'),
        path: '/p/a.json',
        items: [{ id: '1', content: 'pending task', status: 'completed' }],
        mtimeMs: 20_000,
      });
    });

    expect(within(pendingCol).queryByText('pending task')).toBeNull();
    expect(within(completedCol).getByText('pending task')).toBeInTheDocument();

    // Live remove: /p/b.json disappears.
    act(() => {
      source?.emit('remove', { meta: meta('aaaaaaaa'), path: '/p/b.json' });
    });

    expect(within(inProgressCol).queryByText('working task')).toBeNull();
    expect(within(inProgressCol).getByText('empty')).toBeInTheDocument();
  });
});
