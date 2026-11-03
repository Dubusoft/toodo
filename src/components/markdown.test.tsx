import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Markdown from "./markdown";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/web/opener", () => ({ openUrl }));

describe("Markdown", () => {
  beforeEach(() => openUrl.mockClear());

  it("renders headings, task lists, and code blocks", () => {
    const { container } = render(<Markdown source={"## Plan\n\n- [x] done\n- [ ] next\n\n```ts\nconst a = 1;\n```"} />);

    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("img").map((glyph) => glyph.getAttribute("aria-label"))).toEqual(["Done", "Not done"]);
    expect(container.querySelector("pre")).toHaveTextContent("const a = 1;");
  });

  it("shows raw HTML as text instead of rendering it", () => {
    const { container } = render(
      <Markdown source={'<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">'} />,
    );

    expect(container.querySelector("script, img")).toBeNull();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
  });

  it("drops links that are not web or mail links", () => {
    const { container } = render(<Markdown source={"[run](javascript:alert(1)) and [file](docs/a.md)"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("run and file");
  });

  it("opens web links in the system browser instead of navigating", () => {
    render(<Markdown source={"See [docs](https://example.com/docs) and ![logo](https://example.com/a.png)"} />);

    const link = screen.getByRole("link", { name: "docs" });
    expect(fireEvent.click(link)).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "logo" })).toHaveAttribute("href", "https://example.com/a.png");
  });
});
