// The commands take and return the types of `src/lib/bindings.ts`, the web app's client
// generated from `src-tauri/src/bindings.rs`, so the TypeScript server answers in exactly
// the shapes the web app expects. That file imports its runtime from the web app; these
// declarations stand in for those two modules, whose browser code the server does not
// build. The server only imports types from it.

declare module "@/web/core" {
  export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare module "@/web/event" {
  export type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void;
  export function listen<T>(event: string, handler: EventCallback<T>): Promise<() => void>;
}
