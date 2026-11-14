import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface AppErrorBoundaryProps {
  readonly children?: ReactNode;
  readonly onResetSettings?: (() => void) | undefined;
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
}

declare global {
  interface Window {
    __minibookBootErrors?: string[];
    __minibookCSPViolations?: string[];
    __minibookMounted?: boolean;
  }
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof window !== 'undefined') {
      const list = (window.__minibookBootErrors = window.__minibookBootErrors ?? []);
      const summary = `react:${error.message || String(error)}`;
      if (!list.includes(summary)) {
        list.push(summary);
      }
      if (info?.componentStack) {
        console.error('[minibook:error-boundary]', error, info.componentStack);
      }
    }
  }

  private readonly handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  private readonly handleResetAndRetry = (): void => {
    try {
      this.props.onResetSettings?.();
    } catch {
      // ignore reset failure
    }
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <main className="mb-boot-error" role="alert" data-testid="boot-error-card">
        <div className="mb-boot-error-card">
          <h1 className="mb-boot-error-title">Books</h1>
          <p className="mb-boot-error-desc">
            Something interrupted startup. Your books and reading progress are safe.
          </p>
          <pre className="mb-boot-error-detail">{error.message || String(error)}</pre>
          <div className="mb-boot-error-actions">
            <button type="button" className="mb-primary-btn" onClick={this.handleReload}>
              Reload
            </button>
            {this.props.onResetSettings && (
              <button type="button" className="mb-icon-btn" onClick={this.handleResetAndRetry}>
                Retry with defaults
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }
}
