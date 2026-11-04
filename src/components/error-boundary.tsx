import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  /** What the boundary shows, for the fallback ("The timeline could not be shown.") and the log. */
  label: string;
  /** Clears a caught error when it changes, e.g. when the user moves to another view. */
  resetKey?: unknown;
  /** The fallback's element: `li` where the boundary sits directly in a list. */
  as?: "div" | "li";
  className?: string;
  children: ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Toodo: ${this.props.label} failed to render`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const Element = this.props.as ?? "div";
    return (
      <Element
        role="alert"
        className={cn(
          "flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm",
          this.props.className,
        )}
      >
        <p className="flex items-center gap-2 font-medium">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          {capitalize(this.props.label)} could not be shown.
        </p>
        <p className="text-muted-foreground">
          Something went wrong while showing it. Try again, or reload the page if it keeps happening.
        </p>
        {error.message && <p className="font-mono text-xs break-all text-muted-foreground">{error.message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
            <RotateCcw />
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </Element>
    );
  }
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
