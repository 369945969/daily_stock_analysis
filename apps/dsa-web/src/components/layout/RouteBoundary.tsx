import type React from 'react';
import { Component, Suspense } from 'react';
import type { ErrorInfo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

type PageLoadingFallbackProps = {
  fullPage?: boolean;
};

export const PageLoadingFallback: React.FC<PageLoadingFallbackProps> = ({ fullPage = true }) => (
  <div
    className={
      fullPage
        ? 'flex min-h-screen items-center justify-center bg-base'
        : 'flex min-h-[60vh] items-center justify-center'
    }
  >
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan/20 border-t-cyan" />
  </div>
);

type RouteErrorBoundaryProps = {
  children: React.ReactNode;
  resetKey: string;
  fullPage: boolean;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
  errorMessage?: string;
  errorStack?: string;
  componentStack?: string;
};

class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = {
    hasError: false,
    errorMessage: undefined,
    errorStack: undefined,
    componentStack: undefined,
  };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true, errorMessage: undefined, errorStack: undefined, componentStack: undefined };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Route page failed to render or load', error, errorInfo);
    const msg = String((error && (error as unknown as { message?: unknown }).message) || error || '');
    this.setState({
      errorMessage: msg,
      errorStack: typeof error?.stack === 'string' ? error.stack : undefined,
      componentStack: typeof errorInfo?.componentStack === 'string' ? errorInfo.componentStack : undefined,
    });
    const isChunkLoadError = /Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
      msg,
    );
    if (!isChunkLoadError) {
      return;
    }
    try {
      const key = `dsa_route_autoreload:${this.props.resetKey}`;
      const alreadyReloaded = sessionStorage.getItem(key) === '1';
      if (!alreadyReloaded) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
      }
    } catch {
      // ignore
    }
  }

  override componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, errorMessage: undefined, errorStack: undefined, componentStack: undefined });
    }
  }

  override render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        className={
          this.props.fullPage
            ? 'flex min-h-screen items-center justify-center bg-base px-4'
            : 'flex min-h-[60vh] items-center justify-center px-2 py-8'
        }
      >
        <div className="w-full max-w-md rounded-2xl border border-border bg-card/94 p-6 text-center shadow-soft-card">
          <h1 className="text-xl font-semibold text-foreground">页面加载失败</h1>
          <p className="mt-3 text-sm leading-6 text-secondary-text">
            当前页面资源或组件未能正常加载，可能是网络中断或页面版本已更新。请重新加载页面，或返回首页后再试。
          </p>
          {this.state.errorMessage ? (
            <p className="mt-3 rounded-xl border border-border/70 bg-card px-3 py-2 text-left text-xs font-mono text-muted-text">
              {this.state.errorMessage}
            </p>
          ) : null}
          {this.state.errorStack ? (
            <p className="mt-3 rounded-xl border border-border/70 bg-card px-3 py-2 text-left text-xs font-mono text-muted-text whitespace-pre-wrap">
              {this.state.errorStack}
            </p>
          ) : null}
          {this.state.componentStack ? (
            <p className="mt-3 rounded-xl border border-border/70 bg-card px-3 py-2 text-left text-xs font-mono text-muted-text whitespace-pre-wrap">
              {this.state.componentStack}
            </p>
          ) : null}
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              className="btn-primary"
              onClick={() => window.location.reload()}
            >
              重新加载页面
            </button>
            <button
              type="button"
              className="rounded-xl border border-border/70 bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover"
              onClick={() => window.location.assign('/')}
            >
              返回首页
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export const RouteBoundary: React.FC<{ children: React.ReactNode; fullPage?: boolean }> = ({
  children,
  fullPage = true,
}) => {
  const location = useLocation();
  const resetKey = `${location.pathname}${location.search}`;

  return (
    <RouteErrorBoundary resetKey={resetKey} fullPage={fullPage}>
      <Suspense fallback={<PageLoadingFallback fullPage={fullPage} />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
};

export const RouteOutletBoundary: React.FC = () => (
  <RouteBoundary fullPage={false}>
    <Outlet />
  </RouteBoundary>
);

export const StandaloneRouteBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <RouteBoundary fullPage>
    {children}
  </RouteBoundary>
);
