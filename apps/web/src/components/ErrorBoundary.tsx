import { Component, type ErrorInfo, type ReactNode } from 'react';

export type ErrorBoundaryProps = {
  children: ReactNode;
  fallback: (error: Error) => ReactNode;
};

type State = { error: Error | null };

// Minimal React 19-compatible ErrorBoundary. Catches render-time exceptions
// so a malformed SSE payload or a buggy component doesn't white-screen the
// entire app.
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[task-viewer/web] ErrorBoundary caught:', error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) return this.props.fallback(error);
    return this.props.children;
  }
}
