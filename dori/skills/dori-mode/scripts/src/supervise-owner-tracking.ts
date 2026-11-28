import type { JournalCore } from "./supervise-journal.ts";

/**
 * Outbox id prefixes of removed owner posts (the lane-finish line, the owner-only event class); a leftover row from an
 * older store or journal is dropped, never posted.
 */
const STALE_OUTBOX = [
  { prefix: "lane-finish:", why: "lane-finish lines are no longer posted" },
  { prefix: "owner-only:", why: "owner-only events are no longer posted" },
] as const;

export type SupervisorHooks = {
  readonly persistLeadPane?: (pane: string) => void;
  /**
   * One plain line for the owner's main channel (lead model switches); `id` is stable across retries of the same line.
   * `thread` is a lane's thread ref: post there, falling back to the main channel.
   */
  readonly announce?: (text: string, id: string, thread?: string) => Promise<void>;
};

/** A failed owner announcement is retried this often, at most OUTBOX_ATTEMPTS times. */
export const OUTBOX_RETRY_MS = 60_000;
export const OUTBOX_ATTEMPTS = 60;

export class AnnouncementOutbox {
  private pending: Promise<void> = Promise.resolve();
  private draining = false;

  constructor(private readonly core: JournalCore, private readonly hooks: SupervisorHooks) {}
  settled(): Promise<void> { return this.pending; }


  /**
   * One line for the owner's main channel, through a durable outbox: it is journaled first (with a stable id, so a
   * repeat is a no-op) and removed only once the post succeeded; failures retry every OUTBOX_RETRY_MS.
   */
  announce(id: string, text: string): void {
    if (!this.hooks.announce) return;
    if (this.core.journal.outbox?.some((item) => item.id === id)) return;
    this.core.journal = { ...this.core.journal, outbox: [...(this.core.journal.outbox ?? []), { id, text }] };
    this.core.persist();
    this.drainOutbox();
  }

  /** Posts due outbox lines in order on the announcement chain; never runs twice at once. */
  drainOutbox(): void {
    const announce = this.hooks.announce;
    if (!announce || this.draining || !this.core.journal.outbox?.length) return;
    this.draining = true;
    this.pending = this.pending.then(async () => {
      for (const item of this.core.journal.outbox ?? []) {
        // A lane-finish line or owner-only event left by an older version (the supervisor no longer posts them) is dropped unposted.
        const stale = STALE_OUTBOX.find(({ prefix }) => item.id.startsWith(prefix));
        if (!stale && (item.retryAt ?? 0) > this.core.deps.clock.now()) continue;
        let posted = false;
        if (stale) console.error(`OWNER_ANNOUNCE_DROPPED ${item.id}: ${stale.why}`);
        else try {
          await announce(item.text, item.id);
          posted = true;
        } catch (e) {
          console.error(`OWNER_ANNOUNCE_FAILED ${item.id} ${e instanceof Error ? e.message : String(e)}`);
        }
        const attempts = (item.attempts ?? 0) + 1;
        const drop = stale !== undefined || (!posted && attempts >= OUTBOX_ATTEMPTS);
        if (drop && !stale) console.error(`OWNER_ANNOUNCE_DROPPED ${item.id} after ${attempts} attempts`);
        const outbox = (this.core.journal.outbox ?? []).flatMap((entry) => entry.id !== item.id ? [entry]
          : posted || drop ? [] : [{ ...entry, attempts, retryAt: this.core.deps.clock.now() + OUTBOX_RETRY_MS }]);
        this.core.journal = { ...this.core.journal, outbox };
        this.core.persist();
      }
    }).finally(() => { this.draining = false; });
  }
}
