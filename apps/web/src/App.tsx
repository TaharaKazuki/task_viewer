import { useCallback, useState } from 'react';
import { ConnectionStatusBar } from './components/ConnectionStatusBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { KanbanBoard } from './components/KanbanBoard.js';
import { ALL_PROJECTS } from './hooks/useProjects.js';
import { SSEProvider } from './sse/SSEProvider.js';

const PROJECT_STORAGE_KEY = 'task-viewer.selected-project';

function loadInitialProject(): string {
  if (typeof window === 'undefined') return ALL_PROJECTS;
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? ALL_PROJECTS;
  } catch {
    return ALL_PROJECTS;
  }
}

function Fallback(error: Error) {
  return (
    <div className="p-6 text-sm font-mono text-rose-800 bg-rose-50 min-h-screen">
      <p className="font-semibold mb-2">Something crashed. Reload the page to retry.</p>
      <pre className="whitespace-pre-wrap">{error.message}</pre>
    </div>
  );
}

export function App() {
  const [project, setProject] = useState<string>(loadInitialProject);

  const handleProjectChange = useCallback((value: string) => {
    setProject(value);
    try {
      window.localStorage.setItem(PROJECT_STORAGE_KEY, value);
    } catch {
      // Ignore storage failures (Safari private mode, etc.).
    }
  }, []);

  return (
    <ErrorBoundary fallback={Fallback}>
      <SSEProvider url="/events">
        <div className="flex h-screen flex-col">
          <ConnectionStatusBar project={project} onProjectChange={handleProjectChange} />
          <KanbanBoard project={project} />
        </div>
      </SSEProvider>
    </ErrorBoundary>
  );
}
