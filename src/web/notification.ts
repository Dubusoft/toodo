/** Browser notifications for the alerts the page shows. */
import { pushCovers, type PushSettings } from "@/web/push";

export async function isPermissionGranted(): Promise<boolean> {
  return "Notification" in window && Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  return "Notification" in window ? Notification.requestPermission() : "denied";
}

/**
 * Shows a notification, unless the server pushes the same alert to this device: it would
 * then show twice. `pushedAs` is the setting under which the server pushes it; alerts the
 * server does not push still show here.
 */
export function sendNotification(options: { title: string; body?: string; pushedAs?: keyof PushSettings | null }): void {
  if (options.pushedAs && pushCovers(options.pushedAs)) {
    return;
  }
  new Notification(options.title, { body: options.body });
}
