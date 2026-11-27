// The owner and scopes of OAuth grants. Port of the parts of `src-tauri/src/oauth/mod.rs`
// that storage needs.

/** The single-user identity attached to OAuth grants. */
export type OwnerKey = string & { readonly __brand: "OwnerKey" };

export function ownerKey(value: string): OwnerKey {
  return value as OwnerKey;
}

type Scope = "read" | "write";

const SCOPES: readonly Scope[] = ["read", "write"];

function scopeBit(scope: Scope): number {
  switch (scope) {
    case "read":
      return 1;
    case "write":
      return 2;
  }
}

function scopeName(scope: Scope): string {
  switch (scope) {
    case "read":
      return "toodo.read";
    case "write":
      return "toodo.write";
  }
}

/** A non-empty set of scopes; made only by `parseScopes` or the constants below. */
export type Scopes = number & { readonly __brand: "Scopes" };

export const ALL_SCOPES = 3 as Scopes;
export const READ_SCOPES = 1 as Scopes;

export class ScopesError extends Error {
  constructor() {
    super(
      "Request only toodo.read and toodo.write scopes, then start the connection again from the app.",
    );
    this.name = "ScopesError";
  }
}

/** Parses a space-separated scope list; `null` (no `scope` parameter) means every scope. */
export function parseScopes(value: string | null): Scopes {
  if (value === null) {
    return ALL_SCOPES;
  }
  let scopes = 0;
  for (const scope of value.split(/[\t\n\f\r ]+/).filter((part) => part !== "")) {
    const known = SCOPES.find((candidate) => scopeName(candidate) === scope);
    if (known === undefined) {
      throw new ScopesError();
    }
    scopes |= scopeBit(known);
  }
  if (scopes === 0) {
    throw new ScopesError();
  }
  return scopes as Scopes;
}

export function isSubsetOf(scopes: Scopes, other: Scopes): boolean {
  return (scopes & ~other) === 0;
}

/** The space-separated scope names, as grants store them. */
export function formatScopes(scopes: Scopes): string {
  return SCOPES.filter((scope) => (scopes & scopeBit(scope)) !== 0)
    .map(scopeName)
    .join(" ");
}
