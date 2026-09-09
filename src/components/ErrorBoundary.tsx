import { Component, type ReactNode } from "react";

// A class component can't read the theme context hook, and this fallback has to
// render even when the tree above it is broken — so it reaches for the CSS
// variables ThemeProvider publishes on <html> instead (see src/theme.ts).

interface Props {
  children: ReactNode;
  fallback?: (error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Log once so the error survives the boundary in devtools.
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error);
      return (
        <div
          style={{
            padding: 40,
            fontFamily: "monospace",
            fontSize: 13,
            color: "var(--color-danger)",
            border: "1px solid var(--color-danger)",
            borderRadius: 8,
            margin: 40,
            background: "var(--color-surface)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 10 }}>✖ Something went wrong</div>
          <div style={{ whiteSpace: "pre-wrap", color: "var(--color-text-muted)" }}>{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
