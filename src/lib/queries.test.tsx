import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
// First, so the queries below load the mocked bindings.
import { mockedEvents } from "@/test/app";
import { queryKeys, useServerEvents } from "@/lib/queries";

test("a tasks-changed event refetches the tasks, their links, the archive, and reviews", () => {
  const client = new QueryClient();
  const changed: QueryKey[] = [
    queryKeys.tasks,
    queryKeys.taskRelations,
    queryKeys.archive,
    queryKeys.review("2026-11-01", "2026-11-30"),
  ];
  const unchanged: QueryKey[] = [queryKeys.workspaces, queryKeys.reviewSnapshots, queryKeys.chat];
  client.setQueryData(queryKeys.tasks, { pages: [], pageParams: [] });
  for (const key of [...changed.slice(1), ...unchanged]) client.setQueryData(key, []);
  for (const event of [
    mockedEvents.tasksChanged,
    mockedEvents.workspacesChanged,
    mockedEvents.guidelinesChanged,
    mockedEvents.chatChanged,
  ]) {
    event.listen.mockResolvedValue(() => {});
  }
  renderHook(() => useServerEvents(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });

  const onTasksChanged = mockedEvents.tasksChanged.listen.mock.lastCall?.[0];
  expect(onTasksChanged).toBeDefined();
  onTasksChanged?.({ event: "tasks-changed", id: 1, payload: { workspaceId: 1 } });

  for (const key of changed) expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
  for (const key of unchanged) expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
});

test("a chat-changed event refetches the chat and nothing else", () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.chat, { pages: [], pageParams: [] });
  client.setQueryData(queryKeys.workspaces, []);
  for (const event of [
    mockedEvents.tasksChanged,
    mockedEvents.workspacesChanged,
    mockedEvents.guidelinesChanged,
    mockedEvents.chatChanged,
  ]) {
    event.listen.mockResolvedValue(() => {});
  }
  renderHook(() => useServerEvents(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });

  mockedEvents.chatChanged.listen.mock.lastCall?.[0]({ event: "chat-changed", id: 2, payload: null });

  expect(client.getQueryState(queryKeys.chat)?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.workspaces)?.isInvalidated).toBe(false);
});
