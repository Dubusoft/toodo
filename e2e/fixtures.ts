import { expect, test as base, type Page } from "@playwright/test";
import { startServer, type ScratchServer, type ServerOptions } from "./server";

type Fixtures = {
  /** How the scratch server starts; set with `test.use({ serverOptions })`. */
  serverOptions: ServerOptions;
  server: ScratchServer;
  /** A page signed in to the scratch server with its web token. */
  app: Page;
};

export const test = base.extend<Fixtures>({
  serverOptions: [{}, { option: true }],
  server: async ({ serverOptions }, use) => {
    const server = await startServer(serverOptions);
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
  app: async ({ page, server }, use) => {
    await page.goto(server.url);
    await page.getByLabel("Access token").fill(server.webToken);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: "Open menu" }).or(page.getByText("Workspaces").first())).toBeVisible();
    await use(page);
  },
});

export { expect };
