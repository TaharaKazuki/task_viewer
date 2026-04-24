import { useConnectionStatus } from '../hooks/useConnectionStatus.js';
import type { ConnectionState } from '../sse/applyEvent.js';

const LABEL: Record<ConnectionState, { text: string; className: string }> = {
  connecting: { text: 'connecting…', className: 'bg-slate-200 text-slate-700' },
  open: { text: 'connected', className: 'bg-emerald-200 text-emerald-800' },
  closed: { text: 'closed', className: 'bg-slate-300 text-slate-700' },
  error: { text: 'connection error', className: 'bg-rose-200 text-rose-800' },
};

export function ConnectionStatusBar() {
  const { state, errorMessage, ready } = useConnectionStatus();
  const label = LABEL[state];
  return (
    <div className="flex h-12 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4">
      <h1 className="text-sm font-semibold text-slate-700">task_viewer</h1>
      <div className="flex items-center gap-2 text-xs">
        {ready && (
          <span className="rounded bg-sky-100 text-sky-800 px-2 py-0.5 font-medium">
            initial scan complete
          </span>
        )}
        {errorMessage && (
          <span
            className="rounded bg-rose-100 text-rose-800 px-2 py-0.5 font-mono max-w-xs truncate"
            title={errorMessage}
          >
            {errorMessage}
          </span>
        )}
        <span className={`rounded px-2 py-0.5 font-medium ${label.className}`}>{label.text}</span>
      </div>
    </div>
  );
}
