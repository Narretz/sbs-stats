import { Component, type ReactNode } from "react";

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
            color: "#dc2626",
            border: "1px solid #dc2626",
            borderRadius: 8,
            margin: 40,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 10 }}>✖ Something went wrong</div>
          <div style={{ whiteSpace: "pre-wrap", color: "#555" }}>{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
