import { useEffect, useRef, useState } from "react";
import type { TaskId, WorkspaceId } from "@/lib/bindings";

/**
 * What the main area shows, kept in the address so a copied link, a reload, and the
 * browser's back and forward buttons all return to it:
 *
 * - `?view=review`: the review page.
 * - `?workspace=<id>`: a workspace's task list.
 * - neither: every workspace, on the timeline or, with `view=list`, in the list.
 *
 * `task=<id>` adds the task selected there, whose details are open.
 */
export type Route =
  | { page: "review" }
  | { page: "all"; view: "timeline" | "list"; task: TaskId | null }
  | { page: "workspace"; workspace: WorkspaceId; task: TaskId | null };

function idParam(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/** The route of an address's query string; anything it does not name falls back to the timeline. */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "review") {
    return { page: "review" };
  }
  const task = idParam(params.get("task"));
  const workspace = idParam(params.get("workspace"));
  if (workspace !== null) {
    return { page: "workspace", workspace, task };
  }
  return { page: "all", view: view === "list" ? "list" : "timeline", task };
}

/** The query string of `route`, empty for the timeline without a selected task. */
export function routeSearch(route: Route): string {
  const params = new URLSearchParams();
  if (route.page === "review") {
    params.set("view", "review");
  } else if (route.page === "workspace") {
    params.set("workspace", String(route.workspace));
  } else if (route.view === "list") {
    params.set("view", "list");
  }
  if (route.page !== "review" && route.task !== null) {
    params.set("task", String(route.task));
  }
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
}

/**
 * The route of the address, and the function that moves to another one as a new history entry.
 * `onEnter` is called with the route the page opened at and with each one back or forward
 * returns to, but not for routes passed to `navigate`.
 */
export function useRoute(onEnter: (route: Route) => void): [Route, (next: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.search));
  const enter = useRef(onEnter);
  enter.current = onEnter;
  useEffect(() => {
    enter.current(parseRoute(location.search));
    const onPopState = () => {
      const next = parseRoute(location.search);
      setRoute(next);
      enter.current(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = (next: Route) => {
    const search = routeSearch(next);
    if (search !== location.search) {
      history.pushState(null, "", `${location.pathname}${search}${location.hash}`);
    }
    setRoute(next);
  };
  return [route, navigate];
}
