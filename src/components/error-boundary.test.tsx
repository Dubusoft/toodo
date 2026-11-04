import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorBoundary } from "@/components/error-boundary";

function Panel({ broken }: { broken: { current: boolean } }) {
  if (broken.current) throw new Error("panel exploded");
  return <p>Panel content</p>;
}

function quietConsole() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  return spy;
}

describe("ErrorBoundary", () => {
  it("shows a fallback for a part that fails to render, logs the error, and keeps its siblings", () => {
    const consoleError = quietConsole();
    render(
      <>
        <ErrorBoundary label="the timeline">
          <Panel broken={{ current: true }} />
        </ErrorBoundary>
        <p>Sidebar</p>
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The timeline could not be shown.");
    expect(screen.getByText("panel exploded")).toBeInTheDocument();
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "Toodo: the timeline failed to render",
      expect.objectContaining({ message: "panel exploded" }),
      expect.any(String),
    );
  });

  it("renders the part again on Try again", () => {
    quietConsole();
    const broken = { current: true };
    render(
      <ErrorBoundary label="the timeline">
        <Panel broken={broken} />
      </ErrorBoundary>,
    );
    broken.current = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Panel content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the error when its reset key changes", () => {
    quietConsole();
    const broken = { current: true };
    const view = (key: string) => (
      <ErrorBoundary label="this view" resetKey={key}>
        <Panel broken={broken} />
      </ErrorBoundary>
    );
    const { rerender } = render(view("review"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    broken.current = false;
    rerender(view("all"));
    expect(screen.getByText("Panel content")).toBeInTheDocument();
  });
});
