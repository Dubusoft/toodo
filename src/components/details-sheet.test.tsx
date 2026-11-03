import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsSheet } from "@/components/details-sheet";

function onPhone(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: phone, addEventListener() {}, removeEventListener() {} })),
  );
}

function swipe(from: number, to: number) {
  const grabber = screen.getByRole("complementary").querySelector("[data-grabber]")!.parentElement!;
  fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: from });
  fireEvent.pointerMove(grabber, { pointerId: 1, clientY: to });
  fireEvent.pointerUp(grabber, { pointerId: 1, clientY: to });
}

describe("DetailsSheet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes on a swipe down on a phone, but not on a short drag or on a wider screen", () => {
    const onClose = vi.fn();
    onPhone(true);
    const { unmount } = render(
      <DetailsSheet width="480px" onClose={onClose}>
        <li>Details</li>
      </DetailsSheet>,
    );

    swipe(100, 130);
    expect(onClose).not.toHaveBeenCalled();
    swipe(100, 250);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    onPhone(false);
    render(
      <DetailsSheet width="480px" onClose={onClose}>
        <li>Details</li>
      </DetailsSheet>,
    );
    swipe(100, 250);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes the focus when it opens and gives it back when it closes", () => {
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Show details</button>
          {open && (
            <DetailsSheet width="480px" onClose={() => setOpen(false)}>
              <li>Details</li>
            </DetailsSheet>
          )}
        </>
      );
    }
    render(<Page />);
    const opener = screen.getByRole("button", { name: "Show details" });
    opener.focus();

    fireEvent.click(opener);
    expect(screen.getByRole("heading", { name: "Task details" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(opener).toHaveFocus();
  });
});
