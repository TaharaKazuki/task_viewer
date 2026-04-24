import { ConnectionStatusBar } from './components/ConnectionStatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { KanbanBoard } from './components/KanbanBoard.js';
import { SSEProvider } from './sse/SSEProvider.js';

function Fallback(error: Error) {
  return (
    <div className="p-6 text-sm font-mono text-rose-800 bg-rose-50 min-h-screen">
      <p className="font-semibold mb-2">Something crashed. Reload the page to retry.</p>
      <pre className="whitespace-pre-wrap">{error.message}</pre>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary fallback={Fallback}>
      <SSEProvider url="/events">
        <div className="flex h-screen flex-col">
          <ConnectionStatusBar />
          <KanbanBoard />
        </div>
      </SSEProvider>
    </ErrorBoundary>
  );
}
