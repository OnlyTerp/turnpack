/**
 * Tool arguments arrive as arbitrary JSON chosen by a model. These helpers turn the common
 * mistakes (a string where a list was expected, a number as a string) into either a usable
 * value or an error message the model can act on, instead of a stack trace.
 */

/** Names under which a call may say which directory to work in. `root` is the documented one. */
export const ROOT_KEYS = ["root", "cwd", "workdir", "directory"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

/** Accepts a list, or a single item where a list was expected. */
export function optionalList(value: unknown, name: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string" || isRecord(value)) return [value];
  throw new Error(`${name} must be an array`);
}

export function optionalStringList(value: unknown, name: string): string[] {
  return optionalList(value, name).map((item, idx) => {
    if (typeof item !== "string") {
      throw new Error(`${name}[${idx}] must be a string`);
    }
    return item;
  });
}

/**
 * Models reach for the argument names of the tools they were trained on (`old_string`,
 * `file_path`, `oldText`). Reading the first name that is present costs nothing and saves the
 * round trip a "missing field" error would cost.
 */
export function pick(raw: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = raw[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Some clients deliver a list or object argument as its JSON text. If `value` is a string that
 * parses to a list or object, that is returned; anything else comes back unchanged.
 */
export function unwrapJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]")) && !(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Argument names a tool does not know that look like they carry work: a list, an object, or a
 * long text of several lines (a diff, a file's contents). Dropping those silently would drop
 * part of what the model asked for. A one-line string of any length is not reported: some apps
 * add a "reason" or "explanation" to every call, and a sentence is not a change.
 */
export function unknownWorkKeys(raw: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(raw).filter((key) => {
    if (known.includes(key) || key.startsWith("_")) return false;
    const value = raw[key];
    if (typeof value === "string") return value.length > 80 && value.includes("\n");
    return typeof value === "object" && value !== null;
  });
}
