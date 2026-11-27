import { isToodoRef, parseToodoRef, TOODO_DEFAULT_ROOM, type ToodoChat, type ToodoPlace } from "./messenger/toodo-chat.ts";
import type { DecisionTransport } from "./owner-decisions.ts";

/*
 * Owner decisions on the Toodo chat, for a config whose platforms have no discord: a decision is posted into its task's
 * thread, else the default room, and recorded with that place's chat ref as its thread. The Toodo chat has no answer
 * buttons, edits or archive: the owner answers there, the lead closes the decision with `dori decision close`, and the
 * close's confirmation is posted in the same place.
 */

/** The `channel` a decision on the Toodo chat is recorded with (its thread is the place's chat ref). */
export const TOODO_DECISION_CHANNEL = "toodo";

/** Where a decision goes on the Toodo chat: task `task`'s thread (opened when it has none), else the default room. */
export const toodoDecisionPlace = async (chat: Pick<ToodoChat, "taskThread">, task: number | undefined): Promise<ToodoPlace> =>
  task === undefined ? TOODO_DEFAULT_ROOM : chat.taskThread(task, "");

/**
 * The decision transport that sends a channel named by a Toodo chat ref to the Toodo chat and any other to `discord`
 * (reached only then, so a Toodo decision needs no Discord token). On the Toodo chat a post is a chat message whose id
 * is the message id, answer buttons are left out, and a place reads as an open thread with no parent; the calls only a
 * Discord thread needs are refused.
 */
export const routedDecisionTransport = (discord: () => DecisionTransport, toodo: () => Pick<ToodoChat, "reply">): DecisionTransport => {
  const refused = (what: string, channel: string): Promise<never> => Promise.reject(new Error(`${what} is not available on the Toodo chat (${channel})`));
  return {
    send: async (channel, content, stableId, components) =>
      isToodoRef(channel) ? String((await toodo().reply(parseToodoRef(channel), content)).id) : discord().send(channel, content, stableId, components),
    edit: (channel, messageId, content) => (isToodoRef(channel) ? refused("editing a message", channel) : discord().edit(channel, messageId, content)),
    editComponents: async (channel, messageId, components) => { if (!isToodoRef(channel)) await discord().editComponents(channel, messageId, components); },
    content: (channel, messageId) => (isToodoRef(channel) ? refused("reading a message", channel) : discord().content(channel, messageId)),
    deleteMessage: (channel, messageId) => (isToodoRef(channel) ? refused("deleting a message", channel) : discord().deleteMessage(channel, messageId)),
    messagesAfter: (channel, afterId) => (isToodoRef(channel) ? refused("listing messages", channel) : discord().messagesAfter(channel, afterId)),
    startThread: (channel, messageId, name, memberId, autoArchiveMin) =>
      isToodoRef(channel) ? refused("starting a thread", channel) : discord().startThread(channel, messageId, name, memberId, autoArchiveMin),
    setThread: (threadId, patch) => (isToodoRef(threadId) ? refused("changing a thread", threadId) : discord().setThread(threadId, patch)),
    threadState: async (threadId) => (isToodoRef(threadId) ? { archived: false, parent: undefined } : discord().threadState(threadId)),
    threadArchived: async (threadId) => (isToodoRef(threadId) ? false : discord().threadArchived(threadId)),
  };
};
