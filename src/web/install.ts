/**
 * Offers to install the web app. Chromium browsers announce that they can install it with
 * `beforeinstallprompt`, which is kept so a click can show their install dialog later; iOS
 * and iPadOS have no such event, so there the offer is a hint to add Toodo to the Home Screen.
 * Once dismissed, or once Toodo runs installed, nothing is offered on this browser.
 */

/** The `beforeinstallprompt` event, which only Chromium browsers have. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallOffer = "prompt" | "home-screen" | "none";

const DISMISSED_KEY = "toodo-install-dismissed";

/** Whether this is an iPhone or iPad; iPadOS Safari presents itself as a Mac, told apart by its touch screen. */
export function isAppleMobile(): boolean {
  const { userAgent, maxTouchPoints } = navigator;
  return /iPhone|iPad|iPod/.test(userAgent) || (userAgent.includes("Macintosh") && maxTouchPoints > 1);
}

export function runsInstalled(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true)
  );
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((listener) => listener());
}

export function subscribeInstallOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installOffer(): InstallOffer {
  if (installed || runsInstalled() || localStorage.getItem(DISMISSED_KEY) !== null) {
    return "none";
  }
  if (deferred !== null) {
    return "prompt";
  }
  return isAppleMobile() ? "home-screen" : "none";
}

export function dismissInstall(): void {
  localStorage.setItem(DISMISSED_KEY, "1");
  changed();
}

/** Shows the browser's install dialog; declining it there counts as dismissing the offer. */
export async function install(): Promise<void> {
  const event = deferred;
  if (event === null) {
    return;
  }
  // The event shows its dialog only once.
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "dismissed") {
    dismissInstall();
  } else {
    changed();
  }
}

/** Starts listening for the browser's install events; before the app renders, since they may come early. */
export function watchInstallOffer(): void {
  addEventListener("beforeinstallprompt", (event) => {
    // Keeps the browser's own install bar away; the app offers to install instead.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    changed();
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    changed();
  });
}
