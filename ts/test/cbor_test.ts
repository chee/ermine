import { assertEquals, assertThrows } from "@std/assert";
import { CborError, decode, encode, type Value } from "../src/cbor.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const bytes = (...xs: number[]) => new Uint8Array(xs).buffer;

/** Equal as CORE.tex has it: numbers as Object.is, kinds kept apart, maps in any order. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number") return typeof b === "number" && Object.is(a, b);
  if (a === null || typeof a !== "object") return a === b;
  if (b === null || typeof b !== "object") return false;
  if (a instanceof ArrayBuffer) {
    return b instanceof ArrayBuffer &&
      same(Array.from(new Uint8Array(a)), Array.from(new Uint8Array(b)));
  }
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false;
    const x = Array.from(a as unknown as ArrayLike<unknown>),
      y = Array.from(b as unknown as ArrayLike<unknown>);
    return x.length === y.length && x.every((e, i) => same(e, y[i]));
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((e, i) => same(e, b[i]));
  }
  if (Array.isArray(b) || b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b, k) && same((a as never)[k], (b as never)[k]));
}

const VECTORS: [string, Value, string][] = [
  ["null", null, "f6"],
  ["false", false, "f4"],
  ["true", true, "f5"],
  ["0", 0, "f90000"],
  ["-0", -0, "f98000"],
  ["1 is a half, not an integer", 1, "f93c00"],
  ["-1", -1, "f9bc00"],
  ["1.5", 1.5, "f93e00"],
  ["largest half", 65504, "f97bff"],
  ["smallest half subnormal", 2 ** -24, "f90001"],
  ["smallest half normal", 2 ** -14, "f90400"],
  ["a half subnormal", 3 * 2 ** -20, "f90030"],
  ["65505 needs a float32", 65505, "fa477fe100"],
  ["100000", 100000, "fa47c35000"],
  ["2^-25 needs a float32", 2 ** -25, "fa33000000"],
  ["largest float32", 3.4028234663852886e38, "fa7f7fffff"],
  ["1.1 needs a float64", 1.1, "fb3ff199999999999a"],
  ["1e300", 1e300, "fb7e37e43c8800759c"],
  ["2^53", 2 ** 53, "fa5a000000"],
  ["2^53+2", 2 ** 53 + 2, "fb4340000000000001"],
  ["Infinity", Infinity, "f97c00"],
  ["-Infinity", -Infinity, "f9fc00"],
  ["NaN", NaN, "f97e00"],
  ["empty string", "", "60"],
  ["a", "a", "6161"],
  ["ü", "ü", "62c3bc"],
  ["水", "水", "63e6b0b4"],
  ["😀", "😀", "64f09f9880"],
  ["24-byte string", "x".repeat(24), "7818" + "78".repeat(24)],
  ["empty bytes", bytes(), "40"],
  ["bytes", bytes(1, 2, 3, 4), "4401020304"],
  ["empty list", [], "80"],
  ["nested list", [1, [2, 3]], "82f93c0082f94000f94200"],
  ["empty map", {}, "a0"],
  ["map keys sorted by encoding", { b: 1, aa: 3, a: 2 }, "a36161f940006162f93c00626161f94200"],
  ["uint8", new Uint8Array([1, 2]), "d840420102"],
  ["uint16", new Uint16Array([1, 0x0203]), "d84544" + "0100" + "0302"],
  ["uint32", new Uint32Array([1]), "d8464401000000"],
  ["uint64", new BigUint64Array([2n ** 64n - 1n]), "d84748ffffffffffffffff"],
  ["int8", new Int8Array([-1, 1]), "d84842ff01"],
  ["int16", new Int16Array([-2]), "d84d42feff"],
  ["int32", new Int32Array([-1]), "d84e44ffffffff"],
  ["int64", new BigInt64Array([-2n]), "d84f48feffffffffffffff"],
  ["float32", new Float32Array([1.5]), "d855440000c03f"],
  ["float64", new Float64Array([1]), "d85648000000000000f03f"],
  ["empty float64", new Float64Array(0), "d85640"],
  ["typed arrays in a map", { u: new Uint8Array([7]), b: bytes(7) }, "a2616241076175d8404107"],
];

for (const [name, value, want] of VECTORS) {
  Deno.test(`cbor: ${name}`, () => {
    const got = encode(value);
    assertEquals(hex(got), want);
    const back = decode(got);
    if (!same(back, value)) throw new Error(`round trip of ${name} gave ${String(back)}`);
    assertEquals(hex(encode(back)), want);
  });
}

Deno.test("cbor: a NaN element is the one NaN", () => {
  const f32 = new Float32Array(1);
  new Uint32Array(f32.buffer)[0] = 0x7fc00001;
  assertEquals(hex(encode(f32)), "d855440000c07f");
  const f64 = new Float64Array(1);
  new BigUint64Array(f64.buffer)[0] = 0xfff0000000000001n;
  assertEquals(hex(encode(f64)), "d85648000000000000f87f");
  assertThrows(() => decode(unhex("d855440100c07f")), CborError);
  assertThrows(() => decode(unhex("d85648010000000000f87f")), CborError);
});

Deno.test("cbor: a view into a larger buffer encodes only its elements", () => {
  const whole = new Uint16Array([1, 2, 3, 4]);
  assertEquals(hex(encode(whole.subarray(1, 3))), "d84544" + "0200" + "0300");
});

Deno.test("cbor: decoding gives fresh values of their own class", () => {
  const t = decode(unhex("d84544" + "0100" + "0302"));
  if (!(t instanceof Uint16Array)) throw new Error("not a Uint16Array");
  assertEquals(Array.from(t), [1, 0x0203]);
  assertEquals(t.byteOffset, 0);
  const b = decode(unhex("4401020304"));
  if (!(b instanceof ArrayBuffer)) throw new Error("bytes are not an ArrayBuffer");
  const m = decode(unhex("a1695f5f70726f746f5f5ff6")) as { [k: string]: Value };
  assertEquals(Object.keys(m), ["__proto__"]);
  assertEquals(Object.getPrototypeOf(m), Object.prototype);
});

const REJECTED: [string, string][] = [
  ["an unsigned integer", "01"],
  ["a negative integer", "20"],
  ["a longer integer", "1818"],
  ["1 as a float32", "fa3f800000"],
  ["1 as a float64", "fb3ff0000000000000"],
  ["1.5 as a float64", "fb3ff8000000000000"],
  ["100000 as a float64", "fb40f86a0000000000"],
  ["a NaN with a payload", "f97e01"],
  ["a signalling NaN", "f97c01"],
  ["a negative NaN", "f9fe00"],
  ["NaN as a float32", "fa7fc00000"],
  ["NaN as a float64", "fb7ff8000000000000"],
  ["Infinity as a float32", "fa7f800000"],
  ["undefined", "f7"],
  ["a simple value", "f820"],
  ["a low simple value", "e0"],
  ["a break", "ff"],
  ["an indefinite string", "7f6161ff"],
  ["an indefinite list", "9fff"],
  ["an indefinite map", "bfff"],
  ["a reserved head", "7c"],
  ["a string head longer than needed", "780161"],
  ["a list head longer than needed", "990000"],
  ["a bytes head longer than needed", "5a0000000101"],
  ["a list head of 8 bytes", "9b0000000000000000"],
  ["a string that is not UTF-8", "62c328"],
  ["a string with a surrogate", "63eda080"],
  ["a map key that is not a string", "a14161f6"],
  ["a map key that is a number", "a1f93c00f6"],
  ["map keys out of order", "a26162f66161f6"],
  ["longer key first", "a2626161f66162f6"],
  ["a repeated key", "a26161f66161f6"],
  ["an unknown tag", "c140"],
  ["a big-endian tag", "d84142000100"],
  ["a typed array tag head longer than needed", "d9004042 0102"],
  ["a typed array over a list", "d84080"],
  ["a typed array with part of an element", "d8454101"],
  ["a typed array with a long bytes head", "d840580102"],
  ["a tagged tag", "d840d84040"],
  ["bytes after the value", "f6f6"],
  ["nothing", ""],
  ["a value that ends early", "82f6"],
  ["a float that ends early", "f93c"],
  ["a string that ends early", "6261"],
  ["a length past the input", "5bffffffffffffffff"],
];

for (const [name, h] of REJECTED) {
  Deno.test(`cbor: decoding rejects ${name}`, () => {
    assertThrows(() => decode(unhex(h.replaceAll(" ", ""))), CborError);
  });
}

class Canvas {}

const UNENCODABLE: [string, unknown][] = [
  ["a live value", new Canvas()],
  ["a live value in a list", [new Canvas()]],
  ["undefined", undefined],
  ["a function", () => 1],
  ["a bigint", 1n],
  ["a symbol", Symbol("s")],
  ["a Date", new Date(0)],
  ["a Map", new Map()],
  ["a clamped array", new Uint8ClampedArray(1)],
  ["a DataView", new DataView(new ArrayBuffer(1))],
  ["a lone surrogate", "\ud800"],
  ["a lone surrogate as a key", { "\udc00": 1 }],
  ["undefined in a map", { a: undefined }],
];

for (const [name, x] of UNENCODABLE) {
  Deno.test(`cbor: ${name} has no encoding`, () => {
    assertThrows(() => encode(x as Value), CborError);
  });
}

Deno.test("cbor: a value that holds itself has no encoding", () => {
  const a: Value[] = [];
  a.push(a);
  assertThrows(() => encode(a), CborError);
  const shared = [1];
  assertEquals(hex(encode([shared, shared])), "8281f93c0081f93c00");
});

// a small deterministic generator for round trips
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.5,
  1 / 3,
  65504,
  65505,
  2 ** -24,
  2 ** -25,
  2 ** -1074,
  1e308,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER,
  2 ** 64,
];

function text(r: () => number): string {
  return Array.from(
    { length: Math.floor(r() * 6) },
    () => String.fromCodePoint([0x61, 0xfc, 0x6c34, 0x1f600][Math.floor(r() * 4)]),
  ).join("");
}

function generate(r: () => number, depth: number): Value {
  const n = Math.floor(r() * (depth > 3 ? 7 : 10));
  switch (n) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2: {
      const pick = r();
      if (pick < 0.4) return NUMBERS[Math.floor(r() * NUMBERS.length)];
      if (pick < 0.7) return Math.floor((r() - 0.5) * 2 ** Math.floor(r() * 60));
      const f = new Float64Array(1);
      new Uint32Array(f.buffer).set([Math.floor(r() * 2 ** 32), Math.floor(r() * 2 ** 32)]);
      return f[0];
    }
    case 3:
      return text(r);
    case 4:
      return bytes(...Array.from({ length: Math.floor(r() * 5) }, () => Math.floor(r() * 256)));
    case 5: {
      const kinds = [
        Int8Array,
        Uint8Array,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
        Float32Array,
        Float64Array,
      ];
      const len = Math.floor(r() * 4);
      if (r() < 0.2) {
        return new (r() < 0.5 ? BigInt64Array : BigUint64Array)(len).map(() =>
          BigInt(Math.floor(r() * 2 ** 40)) - 2n ** 39n
        );
      }
      const t = new kinds[Math.floor(r() * kinds.length)](len);
      new Uint8Array(t.buffer).forEach((_, i, a) => a[i] = Math.floor(r() * 256));
      return t;
    }
    case 6:
      return Math.floor(r() * 3) - 1;
    case 7:
    case 8:
      return Array.from({ length: Math.floor(r() * 4) }, () => generate(r, depth + 1));
    default: {
      const m: { [k: string]: Value } = {};
      for (let i = Math.floor(r() * 4); i > 0; i--) m[text(r)] = generate(r, depth + 1);
      return m;
    }
  }
}

Deno.test("cbor: round trips", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    for (let i = 0; i < 50; i++) {
      const v = generate(r, 0);
      const e = encode(v);
      const back = decode(e);
      if (!same(back, v)) throw new Error(`seed ${seed}: round trip changed ${hex(e)}`);
      assertEquals(hex(encode(back)), hex(e), `seed ${seed}`);
    }
  }
});

// vectors the C codec wrote, if it has: each a value in PROTOCOL.tex's JSON
// form and its encoding in hex, or bytes in hex that no value encodes as

const TYPED: { [kind: string]: new (xs: never[]) => ArrayBufferView } = {
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
};

const special = (x: unknown) => typeof x === "string" ? Number(x) : x as number;

/** A value from PROTOCOL.tex's JSON form. */
function fromJson(x: unknown): Value {
  if (x === null || typeof x !== "object") return x as Value;
  if (Array.isArray(x)) return x.map(fromJson);
  const keys = Object.keys(x);
  if (keys.length === 1 && keys[0] === "/") {
    const [[tag, body]] = Object.entries((x as { "/": object })["/"]);
    if (tag === "bytes") {
      return Uint8Array.from(atob(body as string), (c) => c.charCodeAt(0)).buffer;
    }
    if (tag === "number") return Number(body);
    if (tag === "map") return { "/": fromJson((body as { "/": unknown })["/"]) };
    const T = TYPED[tag];
    if (!T) throw new Error(`no value for ${tag}`);
    const big = tag === "int64" || tag === "uint64";
    return new T(
      (body as unknown[]).map((e) => big ? BigInt(e as string) : special(e)) as never[],
    ) as Value;
  }
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fromJson(v)]));
}

Deno.test("cbor: agrees with conformance/cbor_vectors.json", async () => {
  let text: string;
  try {
    text = await Deno.readTextFile(new URL("../../conformance/cbor_vectors.json", import.meta.url));
  } catch {
    console.log("no conformance/cbor_vectors.json yet");
    return;
  }
  const doc = JSON.parse(text);
  const list: { [k: string]: unknown }[] = Array.isArray(doc) ? doc : doc.vectors;
  const disagree: string[] = [];
  for (const v of list) {
    const want = String(v.cbor ?? v.hex ?? v.encoding ?? v.bytes).toLowerCase();
    const name = String(v.name ?? want);
    const has = (k: string) => Object.hasOwn(v, k);
    if (has("value") || has("json")) {
      const value = fromJson(has("value") ? v.value : v.json);
      let got: string;
      try {
        got = hex(encode(value));
      } catch (e) {
        got = `throws ${e}`;
      }
      if (got !== want) disagree.push(`${name}: encodes as ${got}, the vector says ${want}`);
      try {
        if (!same(decode(unhex(want)), value)) disagree.push(`${name}: decodes to another value`);
      } catch (e) {
        disagree.push(`${name}: decoding throws ${e}`);
      }
    } else {
      try {
        decode(unhex(want));
        disagree.push(`${name}: decodes, the vector says it is no encoding`);
      } catch {
        // rejected, as it should be
      }
    }
  }
  assertEquals(disagree, []);
});
