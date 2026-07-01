import React from 'react';

interface State {
  error: Error | null;
}

/**
 * §5.9 — top-level error boundary. An uncaught render error anywhere in the app
 * shows a recoverable panel (the message + a trimmed stack + Reload / Copy /
 * Dismiss) instead of a blank white window, so a single bad render never wedges
 * the whole desktop.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[BrainRouter] uncaught render error:', error, info?.componentStack);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="errbnd">
        <div className="errbnd-card">
          <div className="errbnd-title">Something went wrong</div>
          <div className="errbnd-msg">{error.message || String(error)}</div>
          {error.stack ? <pre className="errbnd-stack">{error.stack.split('\n').slice(0, 8).join('\n')}</pre> : null}
          <div className="errbnd-actions">
            <button className="btn" onClick={() => window.location.reload()}>Reload</button>
            <button
              className="btn"
              onClick={() => { void navigator.clipboard?.writeText(`${error.message}\n\n${error.stack ?? ''}`); }}
            >Copy error</button>
            <button className="btn" onClick={() => this.setState({ error: null })}>Dismiss</button>
          </div>
        </div>
      </div>
    );
  }
}
