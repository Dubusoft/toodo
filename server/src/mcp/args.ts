// Reading the arguments of a tool call as the Rust server does (`src-tauri/src/mcp/mod.rs`
// and the `serde` derives of `src-tauri/src/mcp/tools/requests.rs`): digit strings become
// numbers where the tool's input schema takes an integer, then the arguments are read into the
// tool's request, failing with the message `serde` gives for the same arguments.

import { debugString } from "../domain/rust.ts";

/** The arguments do not fit the tool's request; the message is the one `serde` gives. */
export class ArgumentError extends Error {}

/** Reads one JSON value as a `T`, or throws an `ArgumentError`. */
export type Decoder<T> = (value: unknown) => T;

/** How `serde` names a JSON value it did not expect. */
function unexpected(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  }
  if (typeof value === "string") return `string ${debugString(value)}`;
  return Array.isArray(value) ? "sequence" : "map";
}

function invalidType(value: unknown, expected: string): ArgumentError {
  return new ArgumentError(`invalid type: ${unexpected(value)}, expected ${expected}`);
}

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function integer(name: string, min: number, max: number): Decoder<number> {
  return (value) => {
    if (!isInteger(value)) throw invalidType(value, name);
    if (value < min || value > max) throw new ArgumentError(`invalid value: integer \`${value}\`, expected ${name}`);
    return value;
  };
}

export const i64: Decoder<number> = integer("i64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
export const u32: Decoder<number> = integer("u32", 0, 0xffff_ffff);
export const usize: Decoder<number> = integer("usize", 0, Number.MAX_SAFE_INTEGER);

export const f64: Decoder<number> = (value) => {
  if (typeof value !== "number") throw invalidType(value, "f64");
  return value;
};

export const string: Decoder<string> = (value) => {
  if (typeof value !== "string") throw invalidType(value, "a string");
  return value;
};

export const bool: Decoder<boolean> = (value) => {
  if (typeof value !== "boolean") throw invalidType(value, "a boolean");
  return value;
};

export function vec<T>(item: Decoder<T>): Decoder<T[]> {
  return (value) => {
    if (!Array.isArray(value)) throw invalidType(value, "a sequence");
    return value.map(item);
  };
}

/** A unit-variant enum, named in JSON by the strings `variants`. */
export function variants<const V extends string>(...names: V[]): Decoder<V> {
  return (value) => {
    if (typeof value !== "string") throw invalidType(value, "string or map");
    if (!(names as string[]).includes(value)) {
      throw new ArgumentError(`unknown variant \`${value}\`, expected ${oneOf(names)}`);
    }
    return value as V;
  };
}

/** One of `decoders`, the first that reads the value, as an untagged enum with an
 * `expecting` message. */
export function untagged<T>(expecting: string, ...decoders: Decoder<T>[]): Decoder<T> {
  return (value) => {
    for (const decode of decoders) {
      try {
        return decode(value);
      } catch (error) {
        if (!(error instanceof ArgumentError)) throw error;
      }
    }
    throw new ArgumentError(expecting);
  };
}

function oneOf(names: readonly string[]): string {
  return names.length === 1 ? `\`${names[0]}\`` : `one of ${names.map((name) => `\`${name}\``).join(", ")}`;
}

/** A field of a struct: how it reads its value, and the value it takes when it is missing,
 * or `undefined` for a field that must be given. */
export type Field<T> = { decode: Decoder<T>; missing?: () => T; alias?: string };

/** A field that must be given. */
export const required = <T>(decode: Decoder<T>): Field<T> => ({ decode });

/** An `Option<T>`: `null` when omitted or given as `null`. */
export const optional = <T>(decode: Decoder<T>): Field<T | null> => ({
  decode: (value) => (value === null ? null : decode(value)),
  missing: () => null,
});

/** A `#[serde(default)]` field: `fallback` when omitted. */
export const defaulted = <T>(decode: Decoder<T>, fallback: () => T): Field<T> => ({ decode, missing: fallback });

/** A patch field that tells a value given as `null` (`null`) from an omitted one
 * (`undefined`). */
export const present = <T>(decode: Decoder<T>): Field<T | null | undefined> => ({
  decode: (value) => (value === null ? null : decode(value)),
  missing: () => undefined,
});

/** `field` also read under the name `alias`. */
export const aliased = <T>(field: Field<T>, alias: string): Field<T> => ({ ...field, alias });

type Fields = Record<string, Field<unknown>>;
type Read<F extends Fields> = { [K in keyof F]: F[K] extends Field<infer T> ? T : never };

/** A struct named `name`, read field by field in the order the JSON gives them, then
 * checked for missing fields in declaration order. It denies unknown fields unless `deny` is
 * false, which ignores them. */
export function struct<F extends Fields>(name: string, fields: F, deny = true): Decoder<Read<F>> {
  const byName = new Map<string, string>();
  const expected: string[] = [];
  for (const [field, spec] of Object.entries(fields)) {
    byName.set(field, field);
    expected.push(field);
    if (spec.alias !== undefined) {
      byName.set(spec.alias, field);
      expected.push(spec.alias);
    }
  }
  return (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw invalidType(value, `struct ${name}`);
    }
    const read: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const [key, item] of Object.entries(value)) {
      const field = byName.get(key);
      if (field === undefined && !deny) continue;
      if (field === undefined) {
        throw new ArgumentError(
          expected.length === 0 ? `unknown field \`${key}\`, there are no fields` : `unknown field \`${key}\`, expected ${oneOf(expected)}`,
        );
      }
      if (seen.has(field)) throw new ArgumentError(`duplicate field \`${field}\``);
      seen.add(field);
      read[field] = fields[field].decode(item);
    }
    for (const [field, spec] of Object.entries(fields)) {
      if (seen.has(field)) continue;
      if (spec.missing === undefined) throw new ArgumentError(`missing field \`${field}\``);
      read[field] = spec.missing();
    }
    return read as Read<F>;
  };
}

/** The pattern ID schemas give the digit strings they take. */
export const ID_DIGITS = "^[0-9]+$";

type Schema = Record<string, unknown>;

const asObject = (value: unknown): Schema | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : null;

/** The JSON values a set of alternative schemas takes, as far as `numbersFromStrings`
 * cares, following `anyOf`, `oneOf`, and `$ref`s into the `$defs` of `root`. */
class Accepts {
  integer = false;
  /** Strings other than the digits of an ID. */
  string = false;
  items: unknown[] = [];
  properties: Schema[] = [];

  static of(schemas: readonly unknown[], root: Schema): Accepts {
    const accepts = new Accepts();
    for (const schema of schemas) accepts.add(asObject(schema) ?? {}, root);
    return accepts;
  }

  add(schema: Schema, root: Schema): void {
    const reference = schema.$ref;
    if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
      const definition = asObject(asObject(root.$defs)?.[reference.slice("#/$defs/".length)]);
      if (definition !== null) this.add(definition, root);
    }
    const type = schema.type;
    const types = Array.isArray(type) ? type.filter((kind) => typeof kind === "string") : typeof type === "string" ? [type] : [];
    for (const kind of types) {
      if (kind === "integer") this.integer = true;
      else if (kind === "string") this.string ||= schema.pattern !== ID_DIGITS;
      else if (kind === "array" && schema.items !== undefined) this.items.push(schema.items);
      else if (kind === "object") {
        const properties = asObject(schema.properties);
        if (properties !== null) this.properties.push(properties);
      }
    }
    for (const branches of ["anyOf", "oneOf"]) {
      const list = schema[branches];
      if (Array.isArray(list)) for (const branch of list) this.add(asObject(branch) ?? {}, root);
    }
  }
}

/** `text`, a non-negative whole number written with digits only, for the field `name`. */
function number(name: string, text: string): number {
  if (/^[0-9]+$/.test(text)) {
    const parsed = BigInt(text);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  const lookup = name.includes("workspace")
    ? "; list_workspaces lists the workspace IDs"
    : name.includes("criterion") || name.startsWith("criteria")
      ? "; get_task lists a task's criteria with their IDs"
      : name.endsWith("id") || name.includes("depends_on") || name.includes("related")
        ? "; search_tasks or list_tasks finds the task IDs"
        : "";
  throw new ArgumentError(
    `${name} must be a whole number such as 12 or "12", not ${debugString(text)}: call the tool again with ${name} as a number${lookup}`,
  );
}

function convert(value: unknown, schemas: readonly unknown[], root: Schema, path: string): unknown {
  const accepts = Accepts.of(schemas, root);
  if (typeof value === "string" && accepts.integer && !accepts.string) return number(path, value);
  if (Array.isArray(value) && accepts.items.length > 0) {
    return value.map((item, index) => convert(item, accepts.items, root, `${path}[${index}]`));
  }
  const fields = asObject(value);
  if (fields !== null && accepts.properties.length > 0) {
    const converted: Schema = {};
    for (const [name, field] of Object.entries(fields)) {
      const fieldSchemas = accepts.properties.map((properties) => properties[name]).filter((schema) => schema !== undefined);
      converted[name] = fieldSchemas.length > 0 ? convert(field, fieldSchemas, root, `${path}.${name}`) : field;
    }
    return converted;
  }
  return value;
}

/**
 * `arguments` with every digit string the tool's input `schema` takes as an integer turned
 * into the number, at the top level or nested in arrays and objects such as
 * `criteria[0].id`; any other string there is rejected with the field and what to send.
 * Agents often send IDs as strings, e.g. `"12"`, so the first call works. An argument sent
 * under an alias, which the schema records in `x-aliases` as alias to property name, is read
 * with the schema of that property. The rejection is an `ArgumentError` whose message the
 * caller reports as invalid input.
 */
export function numbersFromStrings(schema: Schema, args: Schema): Schema {
  const properties = asObject(schema.properties);
  if (properties === null) return args;
  const aliases = asObject(schema["x-aliases"]);
  const converted: Schema = {};
  for (const [name, value] of Object.entries(args)) {
    const target = aliases?.[name];
    const property = properties[name] ?? (typeof target === "string" ? properties[target] : undefined);
    converted[name] = property === undefined ? value : convert(value, [property], schema, name);
  }
  return converted;
}
