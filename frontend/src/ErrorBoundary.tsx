import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-tab error boundary: a render crash inside one tabpanel (e.g. an
 * unexpected /api/metrics payload shape crashing MetricsView) must not
 * white-screen the whole SPA — the other tab keeps working and the broken
 * one shows an inline fallback card instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the crash visible in the console for debugging — the boundary
    // swallows the propagation, not the report.
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="tab-error" role="alert">
          something broke rendering this tab — {this.state.error.message} — try refresh
        </div>
      );
    }
    return this.props.children;
  }
}
