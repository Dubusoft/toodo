import { describe, expect, it } from "vitest";
import { parseRoute, routeSearch, type Route } from "@/lib/route";

describe("route", () => {
  it("writes each route to an address it reads back", () => {
    const routes: [Route, string][] = [
      [{ page: "all", view: "timeline", task: null }, ""],
      [{ page: "all", view: "timeline", task: 12 }, "?task=12"],
      [{ page: "all", view: "list", task: 3 }, "?view=list&task=3"],
      [{ page: "all", view: "plan", task: null }, "?view=plan"],
      [{ page: "workspace", workspace: 2, task: null }, "?workspace=2"],
      [{ page: "workspace", workspace: 2, task: 7 }, "?workspace=2&task=7"],
      [{ page: "review" }, "?view=review"],
    ];
    for (const [route, search] of routes) {
      expect(routeSearch(route)).toBe(search);
      expect(parseRoute(search)).toEqual(route);
    }
  });

  it("falls back to the timeline for parameters it does not understand", () => {
    expect(parseRoute("?workspace=abc&task=-1&view=graph")).toEqual({ page: "all", view: "timeline", task: null });
  });
});
