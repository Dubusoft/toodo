import { redactSecrets } from "../redact.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
};
export type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const HTTP_TIMEOUT_MS = 30_000;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$(")) throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return redactSecrets(text);
};
