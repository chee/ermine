// Values, patches and slots (CORE.tex, Values, Patches and Placement). Values
// held by the graph are copies, their lists and maps frozen, and a patch
// builds a new value, copying only what lies on its path, so a write whose
// later patch is invalid leaves nothing changed. Bytes and typed arrays are
// copied in, and a splice of one makes a new buffer; whoever reads one must
// not change it. Errors carry PROTOCOL.tex's codes, with the patch's index.
//
// A value is nested as deep as it likes (CORE.tex, Nodes), so nothing here
// recurses on a value or a path: each walk keeps its own stack.

import {
  type Id,
  Invalid,
  invalid,
  type Json,
  ours,
  type Patch,
  type Typed,
  wrongField,
} from "./types.ts";

ours(import.meta.url);

type Obj = { readonly [key: string]: Json };
type Holder = Json[] | { [key: string]: Json };

/** A map: a plain object, not a list, bytes, a typed array or a live value. */
export function isObject(value: unknown): value is Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The typed array kinds of CORE.tex, by name. */
export const KINDS = {
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  int64: BigInt64Array,
  uint64: BigUint64Array,
  float32: Float32Array,
  float64: Float64Array,
} as const;
export type Kind = keyof typeof KINDS;

/** A typed array's kind; undefined for anything else, other views included. */
export function kindOf(value: unknown): Kind | undefined {
  if (!ArrayBuffer.isView(value)) return;
  for (const kind in KINDS) if (value.constructor === KINDS[kind as Kind]) return kind as Kind;
}

/** Bytes: an ArrayBuffer. */
export function isBytes(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

/** A live value: an object or function that is no other kind of value, which only its host holds. */
export function isLive(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (isObject(value) || ArrayBuffer.isView(value)) return false;
  // a page that is not cross-origin isolated has no SharedArrayBuffer at all
  return !isBytes(value) &&
    !(typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer);
}

/** Thrown by own() for what is not a value; callers say which field it was. */
export class NotJson extends Error {}

/** On a walk's stack, in place of a holder: the walk is leaving the container in its source. */
const LEAVE = Symbol("leave");

/**
 * A copy of a value, its lists and maps frozen, its bytes and typed arrays
 * copied. A member of a map that is undefined is left out, as JSON.stringify
 * leaves it out. A live value is taken as it is, but only as the whole value
 * and only where live says one may be. Anything else that is not a value, a
 * value that holds itself among them, throws NotJson.
 */
export function own(value: unknown, live = false): Json {
  if (live && isLive(value)) return value as Json;
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
        copy = source;
        break;
      case "object": {
        if (source === null) {
          copy = null;
          break;
        }
        if (isBytes(source)) {
          copy = source.slice(0);
          break;
        }
        if (kindOf(source)) {
          copy = (source as Typed).slice();
          break;
        }
        if (open.has(source)) throw new NotJson("a value that holds itself is not a value");
        const list = Array.isArray(source);
        if (!list && !isObject(source)) {
          throw new NotJson(
            live ? "a live value is only ever the whole value" : "a live value cannot be here",
          );
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
        throw new NotJson(`a ${typeof source} is not a value`);
    }
    if (Array.isArray(holder)) holder[key as number] = copy;
    else define(holder, key as string, copy);
  }
  for (const container of made) Object.freeze(container);
  return out[0];
}

/** own(value), or wrong-field naming the field. */
export function ownField(value: unknown, field: string, live = false): Json {
  try {
    return own(value, live);
  } catch (e) {
    if (e instanceof NotJson) throw wrongField(field, `${field}: ${e.message}`);
    throw e;
  }
}

/** Sets an own key: a plain assignment of "__proto__" would set the prototype. */
export function define(object: { [key: string]: Json }, key: string, value: Json) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Whether two values are equal (CORE.tex, Values): of the same kind, with
 * equal parts. Numbers as Object.is tells them apart, so 0 and -0 differ and
 * NaN equals NaN; bytes octet by octet; typed arrays only of the same kind,
 * element by element as numbers are; lists with equal elements in order;
 * maps with the same keys holding equal values, in any order; live values
 * only when they are the same thing. A pair met again inside itself, as only
 * values that hold themselves can be, is taken as equal there, so it always
 * ends.
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
    if (typeof x === "number" || typeof y === "number") {
      if (Object.is(x, y)) continue;
      return false;
    }
    if (x === y) continue;
    if (isBytes(x) || kindOf(x)) {
      if (!sameElements(x, y)) return false;
      continue;
    }
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

/** Whether two buffers are the same kind holding the same elements, compared as numbers are. */
function sameElements(x: unknown, y: unknown): boolean {
  if (isBytes(x)) {
    if (!isBytes(y) || x.byteLength !== y.byteLength) return false;
    x = new Uint8Array(x);
    y = new Uint8Array(y);
  } else if (kindOf(x) !== kindOf(y)) return false;
  const a = x as Typed;
  const b = y as Typed;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
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
export function applyPatch(value: Json, patch: Patch, index = 0, live = false): Json {
  const fail = (code: string, text: string, details: { [k: string]: Json } = {}) =>
    invalid(code, `patch ${index}: ${text}`, { index, ...details });
  if (!isObject(patch)) throw fail("not-a-patch", "a patch is an object");
  const p = patch as { [key: string]: unknown };
  const given = Object.hasOwn(p, "value") && p.value !== undefined;
  const json = (v: unknown, whole = false) => {
    try {
      return own(v, whole && live);
    } catch (e) {
      if (e instanceof NotJson) throw fail("not-a-patch", e.message);
      throw e;
    }
  };
  switch (p.type) {
    case "snapshot":
      if (!given) throw fail("not-a-patch", "a snapshot needs a value");
      return json(p.value, true);
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
      throw fail("wrong-kind", `the path goes into a ${describe(here)} at ${where(path, i)}`);
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

/**
 * A splice of a string, counted in code points, with a string; of a list,
 * with a list; of bytes, with bytes; of a typed array, with a typed array of
 * the same kind. The kinds are checked before the range.
 */
function splice(target: Json, range: unknown, value: Json | undefined, fail: Fail): Json {
  const sort = sortOf(target);
  if (!sort) throw fail("wrong-kind", `a ${describe(target)} cannot be spliced`);
  if (value !== undefined && sortOf(value) !== sort) {
    throw fail("wrong-kind", `a ${sort} is spliced with a ${sort}, not a ${describe(value)}`);
  }
  const length = typeof target === "string"
    ? codePoints(target).length
    : isBytes(target)
    ? target.byteLength
    : (target as readonly Json[] | Typed).length;
  const ok = Array.isArray(range) && range.length === 2 && range.every(whole) &&
    range[0] <= range[1] && range[1] <= length;
  if (!ok) {
    throw fail("range", `${JSON.stringify(range)} is not a range in the ${length} there`, {
      length,
    });
  }
  const [from, to] = range as [number, number];
  if (typeof target === "string") {
    const points = codePoints(target);
    return points.slice(0, from).join("") + ((value as string) ?? "") + points.slice(to).join("");
  }
  if (Array.isArray(target)) {
    const added = (value ?? []) as readonly Json[];
    return Object.freeze([...target.slice(0, from), ...added, ...target.slice(to)]);
  }
  const bytes = isBytes(target);
  const items = (bytes ? new Uint8Array(target) : target) as Typed;
  const middle =
    (value === undefined
      ? items.subarray(0, 0)
      : bytes
      ? new Uint8Array(value as ArrayBuffer)
      : value) as Typed;
  // deno-lint-ignore no-explicit-any
  const out = new (items.constructor as any)(length - (to - from) + middle.length) as Typed;
  // deno-lint-ignore no-explicit-any
  const put = out.set.bind(out) as (part: any, at: number) => void;
  put(items.subarray(0, from), 0);
  put(middle, from);
  put(items.subarray(to), from + middle.length);
  return bytes ? out.buffer as ArrayBuffer : out;
}

/** What a splice works on: a string, a list, bytes, or a typed array of one kind. */
function sortOf(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "list";
  if (isBytes(value)) return "bytes";
  return kindOf(value);
}

function set(target: Json, key: string | number, value: Json | undefined, fail: Fail): Json {
  if (!isObject(target)) {
    throw fail("wrong-kind", `a set needs an object, not a ${describe(target)}`);
  }
  if (typeof key !== "string") throw fail("wrong-kind", `the number ${key} leads into an object`);
  const copy = { ...target };
  if (value !== undefined) define(copy, key, value);
  else delete copy[key];
  return Object.freeze(copy);
}

function describe(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (isObject(value)) return "object";
  if (isBytes(value)) return "bytes";
  return kindOf(value) ?? (typeof value === "object" ? "live value" : typeof value);
}

function where(path: readonly unknown[], i: number): string {
  return JSON.stringify(path.slice(0, i));
}
