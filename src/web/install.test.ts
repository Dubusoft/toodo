import { afterEach, describe, expect, it, vi } from "vitest";

const iPhone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

/** A fresh copy of the module with its listeners, since it keeps the browser's install event. */
async function freshInstall() {
  vi.resetModules();
  const install = await import("@/web/install");
  install.watchInstallOffer();
  return install;
}

function standalone(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query === "(display-mode: standalone)" }));
}

function offerInstall(outcome: "accepted" | "dismissed") {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome }),
  });
  dispatchEvent(event);
  return event;
}

describe("installOffer", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "userAgent");
  });

  it("offers the browser's install dialog once the browser can install Toodo", async () => {
    standalone(false);
    const install = await freshInstall();
    expect(install.installOffer()).toBe("none");

    const event = offerInstall("accepted");

    expect(event.defaultPrevented).toBe(true);
    expect(install.installOffer()).toBe("prompt");
    await install.install();
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(install.installOffer()).toBe("none");
  });

  it("remembers a dismissal, also one in the browser's dialog", async () => {
    standalone(false);
    let install = await freshInstall();
    offerInstall("dismissed");
    await install.install();
    expect(install.installOffer()).toBe("none");

    install = await freshInstall();
    offerInstall("accepted");

    expect(install.installOffer()).toBe("none");
  });

  it("hints at the Home Screen on iOS until dismissed", async () => {
    standalone(false);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: iPhone });
    const install = await freshInstall();
    expect(install.installOffer()).toBe("home-screen");

    install.dismissInstall();

    expect(install.installOffer()).toBe("none");
  });

  it("offers nothing to the installed app", async () => {
    standalone(true);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: iPhone });
    const install = await freshInstall();
    offerInstall("accepted");

    expect(install.installOffer()).toBe("none");
  });
});
