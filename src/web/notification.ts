/** Browser notifications for the alerts the page shows. */
import { pushCovers } from "@/web/push";

export async function isPermissionGranted(): Promise<boolean> {
  return "Notification" in window && Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  return "Notification" in window ? Notification.requestPermission() : "denied";
}

/**
 * Shows a notification, unless the server pushes the same alert to this device: it would
 * then show twice. Alerts the server does not push still show here.
 */
export function sendNotification(options: { title: string; body?: string }): void {
  if (pushCovers(options.title)) {
    return;
  }
  new Notification(options.title, { body: options.body });
}
