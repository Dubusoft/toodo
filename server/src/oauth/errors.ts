// The OAuth error responses of `src-tauri/src/oauth/routes.rs`: `{"error", "error_description"}`
// as JSON, `401` with a Basic challenge for client authentication failures.

/** JSON as the Rust server writes a `serde_json::Value`, with its keys sorted, and never
 * cached. */
export function jsonResponse(status: number, value: Record<string, unknown>): Response {
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return new Response(JSON.stringify(sorted), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export class OAuthError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, description: string) {
    super(description);
    this.name = "OAuthError";
    this.status = status;
    this.error = error;
  }

  get description(): string {
    return this.message;
  }

  static bad(error: string, description: string): OAuthError {
    return new OAuthError(400, error, description);
  }

  static internal(): OAuthError {
    return new OAuthError(
      500,
      "server_error",
      "Check the server database and random source, then start the connection again from the app.",
    );
  }

  static client(): OAuthError {
    return new OAuthError(
      401,
      "invalid_client",
      "Authenticate using the registered client method and secret, or register the client again.",
    );
  }

  static grant(): OAuthError {
    return OAuthError.bad(
      "invalid_grant",
      "Start the connection again from the app to obtain a fresh authorization code or refresh token.",
    );
  }

  response(): Response {
    const response = jsonResponse(this.status, { error: this.error, error_description: this.message });
    if (this.status === 401) response.headers.set("www-authenticate", 'Basic realm="oauth"');
    return response;
  }
}
