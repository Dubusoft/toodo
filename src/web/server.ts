/**
 * The `toodo-server` the app talks to: the one that serves the app, reached with
 * relative URLs.
 */

export interface Server {
  /** The URL of `path` (starting with "/") on the server. */
  url(path: string): string;
  /** The local storage key of `name` for this server. */
  key(name: string): string;
  /** `fetch` for `path` (starting with "/") on the server. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** The server this app talks to. */
export const activeServer: Server = {
  url: (path) => path,
  key: (name) => name,
  fetch: (path, init) => fetch(path, init),
};
