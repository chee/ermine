// Values, patches and slots (CORE.tex, Patches and Placement). Values held by
// the graph are frozen copies, and a patch builds a new value, copying only
// what lies on its path, so a write whose later patch is invalid leaves
// nothing changed.

import { type Id, Invalid, type Json, type Patch } from "./types.ts";

type Obj = { readonly [key: string]: Json };

export function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A frozen copy of a JSON value; invalid if it is not JSON. */
export function own(value: unknown): Json {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Invalid(`${value} is not a JSON number`);
      return value;
    case "object": {
      if (value === null) return null;
      if (Array.isArray(value)) return Object.freeze(value.map(own));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Invalid("only plain objects are JSON");
      }
      const copy: { [key: string]: Json } = {};
      for (const key of Object.keys(value)) {
        define(copy, key, own((value as Obj)[key]));
      }
      return Object.freeze(copy);
    }
    default:
      throw new Invalid(`a ${typeof value} is not JSON`);
  }
}

// a plain assignment of "__proto__" would set the prototype
function define(object: { [key: string]: Json }, key: string, value: Json) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Whether two values are equal: the same null, boolean, string or number,
 * lists with equal elements in order, or objects with the same keys holding
 * equal values, in any order.
 */
export function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

/** Code points of a string. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Compares two strings by code point, not by UTF-16 unit. */
export function byCodePoint(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

/**
 * A slot after placing an id: moved to the position if one is given, counted
 * in the slot after the move; otherwise at the end, unless it is already there.
 * The position is checked by whoever places.
 */
export function placed(slot: readonly Id[], id: Id, position?: number): Id[] {
  if (position === undefined) return slot.includes(id) ? [...slot] : [...slot, id];
  const rest = slot.filter((x) => x !== id);
  return [...rest.slice(0, position), id, ...rest.slice(position)];
}

/** Applies the patches in order; invalid if any does not apply. */
export function applyPatches(value: Json, patches: readonly Patch[]): Json {
  if (!Array.isArray(patches)) throw new Invalid("patches must be a list");
  let next = value;
  for (const patch of patches) next = applyPatch(next, patch);
  return next;
}

export function applyPatch(value: Json, patch: Patch): Json {
  if (!isObject(patch)) throw new Invalid("a patch must be an object");
  switch (patch.type) {
    case "snapshot":
      if (!("value" in patch)) throw new Invalid("a snapshot needs a value");
      return own(patch.value);
    case "splice":
      return at(value, patch.path, 0, (target) => splice(target, patch.range, patch));
    case "set":
      return at(value, patch.path, 0, (target) => set(target, patch.key, patch));
    default:
      throw new Invalid(`no patch has type ${JSON.stringify((patch as Obj).type)}`);
  }
}

/** The value with fn applied at the path. */
function at(value: Json, path: unknown, i: number, fn: (target: Json) => Json): Json {
  if (!Array.isArray(path)) throw new Invalid("a patch path must be a list");
  if (i === path.length) return fn(value);
  const key = path[i];
  if (Array.isArray(value)) {
    if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key >= value.length) {
      throw new Invalid(`${JSON.stringify(key)} is not an index of the list at ${where(path, i)}`);
    }
    const copy = value.slice();
    copy[key] = at(value[key], path, i + 1, fn);
    return Object.freeze(copy);
  }
  if (isObject(value)) {
    if (typeof key !== "string" || !Object.hasOwn(value, key)) {
      throw new Invalid(`${JSON.stringify(key)} is not a key of the object at ${where(path, i)}`);
    }
    const copy = { ...value };
    define(copy, key, at(value[key], path, i + 1, fn));
    return Object.freeze(copy);
  }
  throw new Invalid(`the path goes into a ${kindOf(value)} at ${where(path, i)}`);
}

function splice(target: Json, range: unknown, patch: Patch): Json {
  if (
    !Array.isArray(range) || range.length !== 2 ||
    !range.every((n) => typeof n === "number" && Number.isInteger(n))
  ) {
    throw new Invalid("a range is two whole numbers");
  }
  const [from, to] = range as [number, number];
  const given = "value" in patch;
  if (typeof target === "string") {
    if (given && typeof patch.value !== "string") {
      throw new Invalid("a string is spliced with a string");
    }
    const points = codePoints(target);
    inRange(from, to, points.length);
    return points.slice(0, from).join("") + (given ? patch.value : "") +
      points.slice(to).join("");
  }
  if (Array.isArray(target)) {
    if (given && !Array.isArray(patch.value)) {
      throw new Invalid("a list is spliced with a list");
    }
    inRange(from, to, target.length);
    const added = given ? (own(patch.value) as Json[]) : [];
    return Object.freeze([...target.slice(0, from), ...added, ...target.slice(to)]);
  }
  throw new Invalid(`a ${kindOf(target)} cannot be spliced`);
}

function inRange(from: number, to: number, length: number) {
  if (from < 0 || from > to || to > length) {
    throw new Invalid(`[${from}, ${to}) is outside the ${length} there`);
  }
}

function set(target: Json, key: unknown, patch: Patch): Json {
  if (!isObject(target)) throw new Invalid(`a set needs an object, not a ${kindOf(target)}`);
  if (typeof key !== "string") throw new Invalid("a set's key is a string");
  const copy = { ...target };
  if ("value" in patch) define(copy, key, own(patch.value));
  else delete copy[key];
  return Object.freeze(copy);
}

function kindOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value === "object" ? "object" : typeof value;
}

function where(path: readonly unknown[], i: number): string {
  return JSON.stringify(path.slice(0, i));
}
