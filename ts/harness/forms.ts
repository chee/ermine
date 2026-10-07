// Values in JSON (PROTOCOL.tex, Values in JSON). JSON values stand for
// themselves; the other kinds are a map whose one key is "/": bytes, typed
// arrays, live values, a map whose only key is "/", and numbers JSON cannot
// write. A harness holds bytes and typed arrays as buffers, so these forms
// are only how a line carries them. A live value never crosses a line: a
// request that gives one asks for a new stand-in of that kind.
//
// Values nest as deep as they like, so decoding keeps its own stack.

import { isObject, type Kind, kindOf, KINDS } from "../src/patch.ts";
import type { Json, Typed } from "../src/types.ts";

/** A live value the harness holds for a request that gave one: only its kind shows. */
export class Stand {
  constructor(readonly kind: string) {}
}

/** A form that is not one of PROTOCOL.tex's, or a live value where none may be: wrong-field. */
export class Malformed extends Error {}

const NUMBERS: { readonly [name: string]: number } = {
  NaN: NaN,
  Infinity: Infinity,
  "-Infinity": -Infinity,
};
const DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const BASE64 = /^[A-Za-z0-9+/]*$/;

type Holder = unknown[] | { [key: string]: unknown };

/**
 * A value from its JSON form. A live value is taken only as the whole value,
 * and only where live says one may be; anything malformed throws Malformed.
 */
export function decode(json: unknown, live = false): Json {
  const out: unknown[] = [undefined];
  const holders: Holder[] = [out];
  const keys: (string | number)[] = [0];
  const sources: unknown[] = [json];
  const push = (holder: Holder, key: string | number, source: unknown) => {
    holders.push(holder);
    keys.push(key);
    sources.push(source);
  };
  while (sources.length) {
    const holder = holders.pop()!;
    const key = keys.pop()!;
    const source = sources.pop();
    let copy = source;
    if (Array.isArray(source)) {
      const list = new Array(source.length);
      for (let i = source.length - 1; i >= 0; i--) push(list, i, source[i]);
      copy = list;
    } else if (isObject(source)) {
      const names = Object.keys(source);
      if (names.length === 1 && names[0] === "/") {
        copy = form(source["/"], live && holder === out, (map, inner) => push(map, "/", inner));
      } else {
        const map: { [key: string]: unknown } = {};
        for (let i = names.length - 1; i >= 0; i--) push(map, names[i], source[names[i]]);
        copy = map;
      }
    }
    put(holder, key, copy);
  }
  return out[0] as Json;
}

/** One of the forms under "/"; a map form's member is decoded by the caller, through more. */
function form(
  x: unknown,
  live: boolean,
  more: (map: { [key: string]: unknown }, inner: unknown) => void,
): unknown {
  if (!isObject(x) || Object.keys(x).length !== 1) throw new Malformed();
  const [tag] = Object.keys(x);
  const body = x[tag];
  switch (tag) {
    case "bytes":
      return bytesOf(body);
    case "number":
      if (typeof body !== "string" || !Object.hasOwn(NUMBERS, body)) throw new Malformed();
      return NUMBERS[body];
    case "live":
      if (!live || typeof body !== "string") throw new Malformed();
      return new Stand(body);
    case "map": {
      if (!isObject(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "/")) {
        throw new Malformed();
      }
      const map = {};
      more(map, body["/"]);
      return map;
    }
  }
  if (!Object.hasOwn(KINDS, tag)) throw new Malformed();
  return typedOf(tag as Kind, body);
}

function put(holder: Holder, key: string | number, value: unknown) {
  if (Array.isArray(holder)) holder[key as number] = value;
  else {
    Object.defineProperty(holder, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

function base64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "");
}

/** Base64, standard alphabet, no padding, and only the one spelling of its bytes. */
function bytesOf(x: unknown): ArrayBuffer {
  if (typeof x !== "string" || !BASE64.test(x) || x.length % 4 === 1) throw new Malformed();
  const s = atob(x + "=".repeat((4 - x.length % 4) % 4));
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0)).buffer;
  if (base64(bytes) !== x) throw new Malformed();
  return bytes;
}

/** A typed array from its elements; one out of range, or a fraction in an integer kind, is malformed. */
function typedOf(kind: Kind, x: unknown): Typed {
  if (!Array.isArray(x)) throw new Malformed();
  if (kind === "int64" || kind === "uint64") {
    const elements = x.map((e) => {
      if (typeof e !== "string" || !DECIMAL.test(e)) throw new Malformed();
      const n = BigInt(e);
      if ((kind === "int64" ? BigInt.asIntN(64, n) : BigInt.asUintN(64, n)) !== n) {
        throw new Malformed();
      }
      return n;
    });
    return KINDS[kind].from(elements);
  }
  const float = kind === "float32" || kind === "float64";
  const elements = x.map((e) => {
    if (float && typeof e === "string" && Object.hasOwn(NUMBERS, e)) return NUMBERS[e];
    if (typeof e !== "number") throw new Malformed();
    if (kind === "float32" && !Number.isFinite(Math.fround(e))) throw new Malformed();
    if (!float && new KINDS[kind]([e])[0] !== e) throw new Malformed();
    return e;
  });
  return KINDS[kind].from(elements);
}

/** The shortest number that reads back as the same float32. */
function shortest32(x: number): number {
  for (let p = 1; p < 17; p++) {
    const n = Number(x.toPrecision(p));
    if (Math.fround(n) === x) return n;
  }
  return x;
}

/** A number's JSON text: -0 written -0, and what JSON cannot write in its form. */
export function number(n: number): string {
  if (Number.isNaN(n)) return '{"/":{"number":"NaN"}}';
  if (!Number.isFinite(n)) return `{"/":{"number":"${n > 0 ? "Infinity" : "-Infinity"}"}}`;
  return Object.is(n, -0) ? "-0" : JSON.stringify(n);
}

function element(kind: Kind, e: number | bigint): string {
  if (typeof e === "bigint") return `"${e}"`;
  if (Number.isNaN(e)) return '"NaN"';
  if (!Number.isFinite(e)) return e > 0 ? '"Infinity"' : '"-Infinity"';
  if (Object.is(e, -0)) return "-0";
  return JSON.stringify(kind === "float32" ? shortest32(e) : e);
}

/** The JSON text of bytes, a typed array or a live value; undefined for anything else. */
export function binary(value: unknown): string | undefined {
  if (value instanceof ArrayBuffer) return `{"/":{"bytes":"${base64(value)}"}}`;
  if (value instanceof Stand) return `{"/":{"live":${JSON.stringify(value.kind)}}}`;
  const kind = kindOf(value);
  if (!kind) return;
  const elements = Array.from(value as Typed, (e: number | bigint) => element(kind, e));
  return `{"/":{"${kind}":[${elements.join(",")}]}}`;
}
