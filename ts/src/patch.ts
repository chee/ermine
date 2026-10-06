// Values, patches and slots (CORE.tex, Patches and Placement). Values held by
// the graph are frozen copies, and a patch builds a new value, copying only
// what lies on its path, so a write whose later patch is invalid leaves
// nothing changed. Errors carry PROTOCOL.tex's codes, with the patch's index.
//
// A value is any JSON value, nested as deep as it likes (CORE.tex, Nodes), so
// nothing here recurses on a value or a path: each walk keeps its own stack.

import { type Id, Invalid, invalid, type Json, ours, type Patch, wrongField } from "./types.ts";

ours(import.meta.url);

type Obj = { readonly [key: string]: Json };
type Holder = Json[] | { [key: string]: Json };

export function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Thrown by own() for what is not JSON; callers say which field it was. */
export class NotJson extends Error {}

/** On a walk's stack, in place of a holder: the walk is leaving the container in its source. */
const LEAVE = Symbol("leave");

/**
 * A frozen copy of a JSON value. A member of an object that is undefined is
 * left out, as JSON.stringify leaves it out; anything else that is not JSON,
 * a value that holds itself among them, throws NotJson.
 */
export function own(value: unknown): Json {
  const out: Json[] = [null];
  // each entry copies its source into its holder at its key, or leaves a container
  const holders: (Holder | typeof LEAVE)[] = [out];
  const keys: (string | number)[] = [0];
  const sources: unknown[] = [value];
  /** the containers being copied, from the top down to where the walk is */
  const open = new Set<object>();
  const made: Holder[] = [];
  while (sources.length) {
    const holder = holders.pop()!;
    const key = keys.pop()!;
    const source = sources.pop();
    if (holder === LEAVE) {
      open.delete(source as object);
      continue;
    }
    let copy: Json;
    switch (typeof source) {
      case "string":
      case "boolean":
        copy = source;
        break;
      case "number":
        if (!Number.isFinite(source)) throw new NotJson(`${source} is not a JSON number`);
        copy = source;
        break;
      case "object": {
        if (source === null) {
          copy = null;
          break;
        }
        if (open.has(source)) throw new NotJson("a value that holds itself is not JSON");
        const list = Array.isArray(source);
        if (!list) {
          const proto = Object.getPrototypeOf(source);
          if (proto !== Object.prototype && proto !== null) {
            throw new NotJson("only plain objects are JSON");
          }
        }
        const container: Holder = list ? new Array(source.length) : {};
        made.push(container);
        open.add(source);
        holders.push(LEAVE);
        keys.push(0);
        sources.push(source);
        // the members go on last first, so the first is copied first, and all of it before the second
        if (list) {
          for (let i = source.length - 1; i >= 0; i--) {
            if (!(i in source)) continue; // as map() copies a list: a hole stays a hole
            holders.push(container);
            keys.push(i);
            sources.push(source[i]);
          }
        } else {
          const names = Object.keys(source);
          for (let i = names.length - 1; i >= 0; i--) {
            const member = (source as { [key: string]: unknown })[names[i]];
            if (member === undefined) continue;
            holders.push(container);
            keys.push(names[i]);
            sources.push(member);
          }
        }
        copy = container;
        break;
      }
      default:
        throw new NotJson(`a ${typeof source} is not JSON`);
    }
    if (Array.isArray(holder)) holder[key as number] = copy;
    else define(holder, key as string, copy);
  }
  for (const container of made) Object.freeze(container);
  return out[0];
}

/** own(value), or wrong-field naming the field. */
export function ownField(value: unknown, field: string): Json {
  try {
    return own(value);
  } catch (e) {
    if (e instanceof NotJson) throw wrongField(field, `${field}: ${e.message}`);
    throw e;
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
 * equal values, in any order. A pair met again inside itself, as only values
 * that hold themselves can be, is taken as equal there, so it always ends.
 */
export function equal(a: Json, b: Json): boolean {
  // each entry compares its x with its y, or, where x is LEAVE, leaves the container y
  const xs: unknown[] = [a];
  const ys: unknown[] = [b];
  /** each container being compared, from the top down to where the walk is, with what it is compared to */
  const open = new Map<object, unknown[]>();
  while (xs.length) {
    const x = xs.pop();
    const y = ys.pop();
    if (x === LEAVE) {
      const paired = open.get(y as object)!;
      paired.pop();
      if (!paired.length) open.delete(y as object);
      continue;
    }
    if (x === y) continue;
    let names: string[] | undefined;
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
    } else if (isObject(x)) {
      if (!isObject(y)) return false;
      names = Object.keys(x);
      if (names.length !== Object.keys(y).length) return false;
      for (const k of names) if (!Object.hasOwn(y, k)) return false;
    } else return false;
    let paired = open.get(x);
    if (paired?.includes(y)) continue;
    if (!paired) open.set(x, paired = []);
    paired.push(y);
    xs.push(LEAVE);
    ys.push(x);
    const from = x as { readonly [key: string | number]: unknown };
    const to = y as { readonly [key: string | number]: unknown };
    if (names) {
      for (let i = names.length - 1; i >= 0; i--) {
        xs.push(from[names[i]]);
        ys.push(to[names[i]]);
      }
    } else {
      for (let i = (x as unknown[]).length - 1; i >= 0; i--) {
        if (!(i in from)) continue; // as every() goes: a hole is passed over
        xs.push(from[i]);
        ys.push(to[i]);
      }
    }
  }
  return true;
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

/** Whether a number is whole: an integer, 0 or more. */
export function whole(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * A slot after placing an id. With a position, a gap in the slot as it is,
 * from 0 to its length, the id is put in at that gap and its old place, if it
 * had one, taken out; without one, it goes at the end, unless it is already
 * there. The position is checked by whoever places.
 */
export function placed(slot: readonly Id[], id: Id, position?: number): Id[] {
  if (position === undefined) return slot.includes(id) ? [...slot] : [...slot, id];
  const out: Id[] = [];
  for (let i = 0; i <= slot.length; i++) {
    if (i === position) out.push(id);
    if (i < slot.length && slot[i] !== id) out.push(slot[i]);
  }
  return out;
}

/** Applies the patches in order; invalid if any does not apply, naming its index. */
export function applyPatches(value: Json, patches: readonly Patch[]): Json {
  if (!Array.isArray(patches)) throw wrongField("patches", "patches are a list");
  let next = value;
  patches.forEach((patch, index) => {
    next = applyPatch(next, patch, index);
  });
  return next;
}

/**
 * Applies one patch; invalid, with the index given, if it does not apply
 * (PROTOCOL.tex, Errors). What the patch is comes first, whatever the value:
 * not a patch, or of an unknown type, or with a path key, or a set's key,
 * that is neither a string nor a whole number, is not-a-patch. Then its path
 * is followed: an object that lacks the key, or a list shorter than the
 * index, is no-key; a key of the wrong kind for where it leads, a string into
 * a list or a number into an object, or any key into a string, number,
 * boolean or null, is wrong-kind. Then the splice or set: a target, range,
 * splice value or set's key of the wrong kind is wrong-kind, and a range that
 * is not one, or is outside the value, is range.
 */
export function applyPatch(value: Json, patch: Patch, index = 0): Json {
  const fail = (code: string, text: string, details: { [k: string]: Json } = {}) =>
    invalid(code, `patch ${index}: ${text}`, { index, ...details });
  if (!isObject(patch)) throw fail("not-a-patch", "a patch is an object");
  const p = patch as { [key: string]: unknown };
  const given = Object.hasOwn(p, "value") && p.value !== undefined;
  const json = (v: unknown) => {
    try {
      return own(v);
    } catch (e) {
      if (e instanceof NotJson) throw fail("not-a-patch", e.message);
      throw e;
    }
  };
  switch (p.type) {
    case "snapshot":
      if (!given) throw fail("not-a-patch", "a snapshot needs a value");
      return json(p.value);
    case "splice":
    case "set": {
      if (!Array.isArray(p.path)) throw fail("not-a-patch", "a patch's path is a list");
      const bad = p.path.findIndex((key) => typeof key !== "string" && !whole(key));
      if (bad >= 0) {
        throw fail(
          "not-a-patch",
          `the path's key ${bad} is ${
            JSON.stringify(p.path[bad]) ?? String(p.path[bad])
          }, neither a string nor a whole number`,
        );
      }
      if (p.type === "set" && typeof p.key !== "string" && !whole(p.key)) {
        throw fail(
          "not-a-patch",
          "a set's key is neither a string nor a whole number",
        );
      }
      const v = given ? json(p.value) : undefined;
      return at(
        value,
        p.path,
        fail,
        (target) =>
          p.type === "splice"
            ? splice(target, p.range, v, fail)
            : set(target, p.key as string | number, v, fail),
      );
    }
    default:
      throw fail("not-a-patch", `no patch has type ${JSON.stringify(p.type)}`);
  }
}

type Fail = (code: string, text: string, details?: { [k: string]: Json }) => Invalid;

/**
 * The value with fn applied at the path, whose keys are strings and whole
 * numbers: each list or object along the path is copied, and the rest is
 * shared. The path is walked down, then the copies are made coming back up,
 * so a long path needs no deep stack.
 */
function at(
  value: Json,
  path: readonly unknown[],
  fail: Fail,
  fn: (target: Json) => Json,
): Json {
  const along: (readonly Json[] | Obj)[] = [];
  let here = value;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    if (Array.isArray(here)) {
      if (typeof key === "string") {
        throw fail(
          "wrong-kind",
          `the string ${JSON.stringify(key)} leads into the list at ${where(path, i)}`,
        );
      }
      if ((key as number) >= here.length) {
        throw fail(
          "no-key",
          `${key} is past the end of the list of ${here.length} at ${where(path, i)}`,
        );
      }
      along.push(here);
      here = here[key as number];
    } else if (isObject(here)) {
      if (typeof key !== "string") {
        throw fail("wrong-kind", `the number ${key} leads into the object at ${where(path, i)}`);
      }
      if (!Object.hasOwn(here, key)) {
        throw fail(
          "no-key",
          `${JSON.stringify(key)} is not a key of the object at ${where(path, i)}`,
        );
      }
      along.push(here);
      here = here[key];
    } else {
      throw fail("wrong-kind", `the path goes into a ${kindOf(here)} at ${where(path, i)}`);
    }
  }
  let next = fn(here);
  for (let i = along.length - 1; i >= 0; i--) {
    const parent = along[i];
    if (Array.isArray(parent)) {
      const copy = parent.slice();
      copy[path[i] as number] = next;
      next = Object.freeze(copy);
    } else {
      const copy = { ...parent as Obj };
      define(copy, path[i] as string, next);
      next = Object.freeze(copy);
    }
  }
  return next;
}

function splice(target: Json, range: unknown, value: Json | undefined, fail: Fail): Json {
  let length: number;
  if (typeof target === "string") length = codePoints(target).length;
  else if (Array.isArray(target)) length = target.length;
  else throw fail("wrong-kind", `a ${kindOf(target)} cannot be spliced`);
  const ok = Array.isArray(range) && range.length === 2 && range.every(whole) &&
    range[0] <= range[1] && range[1] <= length;
  if (!ok) {
    throw fail("range", `${JSON.stringify(range)} is not a range in the ${length} there`, {
      length,
    });
  }
  const [from, to] = range as [number, number];
  if (typeof target === "string") {
    if (value !== undefined && typeof value !== "string") {
      throw fail("wrong-kind", "a string is spliced with a string");
    }
    const points = codePoints(target);
    return points.slice(0, from).join("") + (value ?? "") + points.slice(to).join("");
  }
  if (value !== undefined && !Array.isArray(value)) {
    throw fail("wrong-kind", "a list is spliced with a list");
  }
  const added = (value ?? []) as readonly Json[];
  return Object.freeze([
    ...(target as Json[]).slice(0, from),
    ...added,
    ...(target as Json[]).slice(to),
  ]);
}

function set(target: Json, key: string | number, value: Json | undefined, fail: Fail): Json {
  if (!isObject(target)) throw fail("wrong-kind", `a set needs an object, not a ${kindOf(target)}`);
  if (typeof key !== "string") throw fail("wrong-kind", `the number ${key} leads into an object`);
  const copy = { ...target };
  if (value !== undefined) define(copy, key, value);
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
