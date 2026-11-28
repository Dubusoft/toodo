import { launchQueue, launchQueueText, queueFor } from "./routing.ts";

import type { FlowDeps } from "./done-flow.ts";
import { redactMeta, redactSecrets } from "./redact.ts";
import { type Event, type EventMeta, JournalCore } from "./supervise-journal.ts";
import { AnnouncementOutbox, type SupervisorHooks } from "./supervise-owner-tracking.ts";
import { LeadLifecycle } from "./supervise-lead-lifecycle.ts";
import { Delivery } from "./supervise-delivery.ts";
import { OutcomeTracking } from "./lane-outcomes.ts";
import { DecisionTracking } from "./decision-obligations.ts";

export {
  type EventMeta, type Journal, type JournalEvent, type OutboxItem, type Restart, RETAIN_EVERY_MS,
  SuperviseError, TransientSuperviseError,
} from "./supervise-journal.ts";
export {
  OUTBOX_ATTEMPTS, OUTBOX_RETRY_MS, type SupervisorHooks,
} from "./supervise-owner-tracking.ts";
export {
  LEAD_SKILL,
} from "./supervise-lead-lifecycle.ts";
export {
  BACKOFF_MAX_MS, BACKOFF_MIN_MS, eventPriority, RetryingDelivery, STUCK_AFTER_MS,
} from "./supervise-delivery.ts";

/**
 * The log is the delivery boundary, not an assertion that the LLM completed the task.
 * Stable source IDs in the durable inbox and log make recovery idempotent. Keep both
 * files: removing either discards the deduplication history.
 */
export class Supervisor {
  readonly eventLog: string;
  private readonly core: JournalCore;
  private readonly outbox: AnnouncementOutbox;
  private readonly lead: LeadLifecycle;
  private readonly delivery: Delivery;
  private readonly outcomes: OutcomeTracking;
  private readonly decisions: DecisionTracking;

  constructor(deps: FlowDeps, hooks: SupervisorHooks = {}) {
    this.core = new JournalCore(deps);
    this.eventLog = this.core.eventLog;
    const enqueue = (id: string, line: string): void => { this.enqueue(id, line); };
    this.outbox = new AnnouncementOutbox(this.core, hooks);
    this.outcomes = new OutcomeTracking(this.core, enqueue);
    this.decisions = new DecisionTracking(this.core, enqueue);
    this.lead = new LeadLifecycle(this.core, this.outbox, hooks, enqueue, () => { this.outcomes.publish(); this.decisions.publish(); });
    this.delivery = new Delivery(this.core, this.outbox, this.lead, this.outcomes);
    const { tail, cursor } = this.core.recoverLog();
    this.core.initInbox();
    this.core.persist();
    if (cursor !== this.core.store.logCursor()) this.core.store.recordDeliveries(tail, cursor, deps.clock.now());
    // Announcements a previous run could not post (or crashed before posting) go out now.
    this.outbox.drainOutbox();
    this.outcomes.publish();
    this.decisions.publish();
  }

  /** The lead pane in use now: repairLeadPane replaces the configured one when it recreates the pane. */
  get leadPane(): string { return this.core.deps.config.leadPane; }

  /** The config object the supervisor core reads now (a recreated lead pane replaces it with a copy). */
  get config(): FlowDeps["config"] { return this.core.deps.config; }

  /** Releases the store (tests and shutdown); the supervisor must not be used afterwards. */
  close(): void { this.core.close(); }

  private enqueuing = false;

  /**
   * Synchronous durable enqueue: callers may enqueue while flush awaits a restart. False: a duplicate id, dropped.
   * `meta` (the lane, thread, cwd it concerns) is journaled with the event and rides along in the delivery log.
   */
  enqueue(id: string, line: string, meta?: EventMeta): boolean {
    if (this.core.known(id)) return false;
    // A LAUNCH_READY lists the queued launches of its machine (`LAUNCH_READY machine=<label> ...`; none named: local).
    const queued = line === "LAUNCH_READY" || line.startsWith("LAUNCH_READY ")
      ? launchQueueText(queueFor(launchQueue(this.core.deps.config.stateDir), /^LAUNCH_READY machine=(\S+)/.exec(line)?.[1]))
      : "";
    const event: Event = { id, line: redactSecrets(`${line}${queued}`).replace(/[\r\n]+/g, " "), at: this.core.deps.clock.now(), ...(meta ? { meta: redactMeta(meta) } : {}) };
    const before = this.core.journal;
    const length = before.events.length;
    const nested = this.enqueuing;
    this.enqueuing = true;
    try {
      // Append in place, but roll back the whole staged tail (including nested notices) on failure.
      (before.events as Event[]).push(event);
      this.core.eventIds.add(id);
      this.outcomes.track(event);
      this.decisions.track(event);
      // Nested notices commit with their triggering event, never ahead of it.
      if (!nested) this.core.persist("normal");
    } catch (e) {
      for (const added of before.events.slice(length)) this.core.eventIds.delete(added.id);
      (before.events as Event[]).length = length;
      this.core.journal = before;
      throw e;
    } finally { this.enqueuing = nested; }
    if (!nested) this.outbox.drainOutbox();
    return true;
  }

  /** Event `id` is journaled, or was and left a dedupe tombstone: a scheduled run's read-back. */
  journaled(id: string): boolean { return this.core.known(id); }

  /** Consumes `dori reported` receipts and enqueues UNREPORTED for finished lanes the owner was not told about in time. */
  reportTick(): Promise<void> {
    // Due outbox lines (a retried announcement) go out on this pass too, even while lead delivery is backing off.
    this.core.consumeTakes();
    this.core.retain(this.core.deps.clock.now());
    this.core.persist("normal");
    this.core.store.sync();
    this.lead.refreshCarried();
    this.outbox.drainOutbox();
    return this.outcomes.tick(this.core.deps.registry);
  }

  /** Consumes `dori resolved` receipts and enqueues UNRESOLVED for decision events the lead left open past resolveTimeoutMin. */
  resolveTick(): void { this.decisions.tick(); }

  announcementsSettled(): Promise<void> { return this.outbox.settled(); }

  flush(): Promise<void> { return this.delivery.flush(); }

  /**
   * The lead has received event `id`: it is in the delivery log and not in a cold start that has not confirmed yet (that
   * batch is logged before the new lead starts). A pruned or unknown id reads false.
   */
  leadDelivered(id: string): boolean {
    return this.core.delivered.has(id) && !this.core.journal.restart?.events.some((event) => event.id === id);
  }

  /**
   * Recreate a vanished lead pane: a new hc terminal at leadCwd.
   * The runtime leadPane changes and persistLeadPane records it in dori state (managed-panes.ts). Returns the new
   * pane id, or undefined when the pane exists or cannot be recreated cleanly (retries continue).
   */
  repairLeadPane(): Promise<string | undefined> { return this.lead.repairLeadPane(); }
}
