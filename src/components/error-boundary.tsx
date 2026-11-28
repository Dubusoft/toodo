import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/button";
import { errorMessage } from "@/lib/error-messages";
import { useMessages } from "@/lib/i18n";
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
    return (
      <ErrorFallback boundary={this.props} error={error} retry={() => this.setState({ error: null })} />
    );
  }
}

function ErrorFallback({ boundary, error, retry }: {
  boundary: Pick<Props, "as" | "className" | "label">;
  error: Error;
  retry: () => void;
}) {
  const m = useMessages();
  const Element = boundary.as ?? "div";
  const copy = m.app.errorBoundary;
  const detail = errorMessage(error, m);
  return (
    <Element
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm",
        boundary.className,
      )}
    >
      <p className="break-words-keep flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        {copy.title(boundary.label)}
      </p>
      <p className="break-words-keep text-muted-foreground">{copy.description}</p>
      {detail && <p className="font-mono text-xs break-all text-muted-foreground">{detail}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" label={copy.tryAgain} icon={<RotateCcw />} onClick={retry} />
        <Button size="sm" variant="ghost" label={copy.reload} onClick={() => window.location.reload()} />
      </div>
    </Element>
  );
}
