// The CBOR encoding of values (CORE.tex, Values): RFC 8949's core
// deterministic encoding, with typed arrays as RFC 8746 has them.
//
// - every number is the shortest float that holds it exactly, so 1 is a half
//   float and never an integer; -0 is kept; NaN is the one NaN, f9 7e 00
// - bytes are major type 2, strings major type 3, lists 4, maps 5
// - a map's keys are strings, sorted bytewise by their encodings
// - a typed array is its tag over a byte string of its elements, little-endian:
//   uint8 64, uint16 69, uint32 70, uint64 71, int8 72, int16 77, int32 78,
//   int64 79, float32 85, float64 86; a NaN element is written as the quiet
//   NaN with no payload (7fc00000, 7ff8000000000000)
// - a live value has no encoding
//
// Bytes are an ArrayBuffer; a typed array is its own class, a Uint8Array
// being a uint8 typed array. Decoding accepts exactly what encoding gives.

/** A value as this codec holds it. */
export type Value =
  | null
  | boolean
  | number
  | string
  | ArrayBuffer
  | Typed
  | readonly Value[]
  | { readonly [key: string]: Value };

export type Typed =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array;

/** What cannot be encoded, or bytes that are not an encoding. */
export class CborError extends Error {
  override name = "CborError";
}

// Each kind: its class, its tag, its element size.
type Kind = { tag: number; size: number; make: new (n: number) => Typed };
const KINDS: Kind[] = [
  { tag: 64, size: 1, make: Uint8Array },
  { tag: 69, size: 2, make: Uint16Array },
  { tag: 70, size: 4, make: Uint32Array },
  { tag: 71, size: 8, make: BigUint64Array },
  { tag: 72, size: 1, make: Int8Array },
  { tag: 77, size: 2, make: Int16Array },
  { tag: 78, size: 4, make: Int32Array },
  { tag: 79, size: 8, make: BigInt64Array },
  { tag: 85, size: 4, make: Float32Array },
  { tag: 86, size: 8, make: Float64Array },
];
const BY_CLASS = new Map<unknown, Kind>(KINDS.map((k) => [k.make, k]));
const BY_TAG = new Map<number, Kind>(KINDS.map((k) => [k.tag, k]));

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// encoding -------------------------------------------------------------------

class Out {
  buf = new Uint8Array(64);
  n = 0;
  room(k: number) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  byte(b: number) {
    this.room(1);
    this.buf[this.n++] = b;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  /** A head: the major type and its argument, in the fewest bytes. */
  head(major: number, arg: number) {
    const m = major << 5;
    if (arg < 24) this.byte(m | arg);
    else if (arg < 0x100) this.bytes(new Uint8Array([m | 24, arg]));
    else if (arg < 0x10000) this.bytes(new Uint8Array([m | 25, arg >> 8, arg & 0xff]));
    else if (arg < 0x100000000) {
      this.bytes(
        new Uint8Array([m | 26, arg >>> 24, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff]),
      );
    } else {
      const hi = Math.floor(arg / 0x100000000), lo = arg >>> 0;
      const b = new Uint8Array(9);
      b[0] = m | 27;
      const v = new DataView(b.buffer);
      v.setUint32(1, hi);
      v.setUint32(5, lo);
      this.bytes(b);
    }
  }
}

const f32 = new DataView(new ArrayBuffer(4));

/** The bits of x as a half float, if a half float holds it exactly. */
function half(x: number): number | undefined {
  if (Math.fround(x) !== x) return;
  f32.setFloat32(0, x);
  const bits = f32.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  const mant = bits & 0x7fffff;
  if (exp === 0xff) return mant === 0 ? sign | 0x7c00 : undefined; // the infinities
  if (exp === 0) return mant === 0 ? sign : undefined; // zeros; float32 subnormals are too small
  const e = exp - 127;
  if (e > 15) return;
  if (e >= -14) return (mant & 0x1fff) === 0 ? sign | ((e + 15) << 10) | (mant >>> 13) : undefined;
  if (e < -24) return;
  const sig = 0x800000 | mant, shift = -(e + 1); // a subnormal: sig * 2^(e+1) units of 2^-24
  return (sig & ((1 << shift) - 1)) === 0 ? sign | (sig >>> shift) : undefined;
}

function number(out: Out, x: number) {
  if (Number.isNaN(x)) return out.bytes(new Uint8Array([0xf9, 0x7e, 0x00]));
  const h = half(x);
  if (h !== undefined) return out.bytes(new Uint8Array([0xf9, h >> 8, h & 0xff]));
  if (Math.fround(x) === x) {
    const b = new Uint8Array(5);
    b[0] = 0xfa;
    new DataView(b.buffer).setFloat32(1, x);
    return out.bytes(b);
  }
  const b = new Uint8Array(9);
  b[0] = 0xfb;
  new DataView(b.buffer).setFloat64(1, x);
  out.bytes(b);
}

/** A typed array's elements, little-endian, each NaN the quiet NaN with no payload. */
function elements(t: Typed, kind: Kind): Uint8Array {
  const raw = new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
  const b = new Uint8Array(t.byteLength);
  if (LITTLE || kind.size === 1) b.set(raw);
  else {
    for (let i = 0; i < raw.length; i += kind.size) {
      for (let j = 0; j < kind.size; j++) b[i + j] = raw[i + kind.size - 1 - j];
    }
  }
  if (kind.tag === 85 || kind.tag === 86) {
    const v = new DataView(b.buffer);
    for (let i = 0; i < t.length; i++) {
      if (!Number.isNaN(t[i] as number)) continue;
      if (kind.size === 4) v.setUint32(i * 4, 0x7fc00000, true);
      else v.setBigUint64(i * 8, 0x7ff8000000000000n, true);
    }
  }
  return b;
}

/** A string's UTF-8; a string with a lone surrogate has none. */
function text(s: string): Uint8Array {
  if (!s.isWellFormed()) throw new CborError("a string with a lone surrogate has no encoding");
  return utf8.encode(s);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function value(out: Out, x: unknown, open: Set<object>) {
  if (x === null) return out.byte(0xf6);
  if (x === false) return out.byte(0xf4);
  if (x === true) return out.byte(0xf5);
  if (typeof x === "number") return number(out, x);
  if (typeof x === "string") {
    const b = text(x);
    out.head(3, b.length);
    return out.bytes(b);
  }
  if (typeof x !== "object") throw new CborError(`a ${typeof x} is not a value`);
  if (x instanceof ArrayBuffer) {
    out.head(2, x.byteLength);
    return out.bytes(new Uint8Array(x));
  }
  if (ArrayBuffer.isView(x)) {
    const kind = BY_CLASS.get(x.constructor);
    if (!kind) throw new CborError(`a ${x.constructor.name} is not a value`);
    const b = elements(x as Typed, kind);
    out.head(6, kind.tag);
    out.head(2, b.length);
    return out.bytes(b);
  }
  if (open.has(x)) throw new CborError("a value cannot hold itself");
  open.add(x);
  if (Array.isArray(x)) {
    out.head(4, x.length);
    for (const item of x) value(out, item, open);
  } else {
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) {
      throw new CborError("a live value has no encoding");
    }
    const keys = Object.keys(x).map((k) => {
      const key = new Out();
      value(key, k, open);
      return { k, b: key.buf.subarray(0, key.n) };
    }).sort((a, b) => compare(a.b, b.b));
    out.head(5, keys.length);
    for (const { k, b } of keys) {
      out.bytes(b);
      value(out, (x as { [k: string]: unknown })[k], open);
    }
  }
  open.delete(x);
}

/** The deterministic CBOR of a value. A live value, or anything not a value, throws. */
export function encode(x: Value): Uint8Array {
  const out = new Out();
  value(out, x, new Set());
  return out.buf.slice(0, out.n);
}

// decoding -------------------------------------------------------------------

const wrong = (why: string) => new CborError(`not an encoding of a value: ${why}`);

function halfValue(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f, mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant === 0 ? sign * Infinity : NaN;
  return sign * (1024 + mant) * 2 ** (exp - 25);
}

class In {
  view: DataView;
  at = 0;
  constructor(readonly b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(k: number) {
    if (this.at + k > this.b.length) throw wrong("it ends early");
  }
  /** A head's argument, which must be in the fewest bytes. */
  arg(info: number): number {
    if (info < 24) return info;
    let n: number;
    if (info === 24) {
      this.need(1);
      n = this.b[this.at];
      this.at += 1;
      if (n < 24) throw wrong("a head is longer than it needs to be");
    } else if (info === 25) {
      this.need(2);
      n = this.view.getUint16(this.at);
      this.at += 2;
      if (n < 0x100) throw wrong("a head is longer than it needs to be");
    } else if (info === 26) {
      this.need(4);
      n = this.view.getUint32(this.at);
      this.at += 4;
      if (n < 0x10000) throw wrong("a head is longer than it needs to be");
    } else if (info === 27) {
      this.need(8);
      const big = this.view.getBigUint64(this.at);
      this.at += 8;
      if (big < 0x100000000n) throw wrong("a head is longer than it needs to be");
      if (big > BigInt(this.b.length)) throw wrong("a length is longer than the input");
      n = Number(big);
    } else throw wrong(info === 31 ? "an indefinite length" : "a reserved head");
    return n;
  }
  take(k: number): Uint8Array {
    this.need(k);
    const s = this.b.subarray(this.at, this.at + k);
    this.at += k;
    return s;
  }
}

function read(input: In): Value {
  input.need(1);
  const start = input.at;
  const ib = input.b[input.at++];
  const major = ib >> 5, info = ib & 0x1f;
  switch (major) {
    case 0:
    case 1:
      throw wrong("an integer; numbers are floats");
    case 2:
      return input.take(input.arg(info)).slice().buffer;
    case 3:
      try {
        return strict.decode(input.take(input.arg(info)));
      } catch (e) {
        if (e instanceof CborError) throw e;
        throw wrong("a string that is not UTF-8");
      }
    case 4: {
      const n = input.arg(info);
      if (n > input.b.length - input.at) throw wrong("a list is longer than the input");
      const list: Value[] = [];
      for (let i = 0; i < n; i++) list.push(read(input));
      return list;
    }
    case 5: {
      const n = input.arg(info);
      if (n > input.b.length - input.at) throw wrong("a map is longer than the input");
      const entries: [string, Value][] = [];
      let last: Uint8Array | undefined;
      for (let i = 0; i < n; i++) {
        const from = input.at;
        if (input.at < input.b.length && input.b[input.at] >> 5 !== 3) {
          throw wrong("a map key that is not a string");
        }
        const key = read(input) as string;
        const kb = input.b.subarray(from, input.at);
        if (last && compare(last, kb) >= 0) throw wrong("map keys out of order or repeated");
        last = kb;
        entries.push([key, read(input)]);
      }
      return Object.fromEntries(entries);
    }
    case 6: {
      const kind = BY_TAG.get(input.arg(info));
      if (!kind) throw wrong("a tag that is not a typed array's");
      input.need(1);
      const bb = input.b[input.at++];
      if (bb >> 5 !== 2) throw wrong("a typed array's tag over something not bytes");
      const raw = input.take(input.arg(bb & 0x1f));
      if (raw.length % kind.size !== 0) throw wrong("a typed array's bytes are not whole elements");
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      if (kind.tag === 85) {
        for (let i = 0; i < raw.length; i += 4) {
          const u = view.getUint32(i, true);
          if ((u & 0x7f800000) === 0x7f800000 && (u & 0x7fffff) !== 0 && u !== 0x7fc00000) {
            throw wrong("a NaN element that is not the one NaN");
          }
        }
      } else if (kind.tag === 86) {
        for (let i = 0; i < raw.length; i += 8) {
          const u = view.getBigUint64(i, true);
          if (
            (u & 0x7ff0000000000000n) === 0x7ff0000000000000n &&
            (u & 0xfffffffffffffn) !== 0n && u !== 0x7ff8000000000000n
          ) throw wrong("a NaN element that is not the one NaN");
        }
      }
      const t = new kind.make(raw.length / kind.size);
      const out = new Uint8Array(t.buffer);
      if (LITTLE || kind.size === 1) out.set(raw);
      else {
        for (let i = 0; i < raw.length; i += kind.size) {
          for (let j = 0; j < kind.size; j++) out[i + j] = raw[i + kind.size - 1 - j];
        }
      }
      return t;
    }
    default: {
      if (ib === 0xf4) return false;
      if (ib === 0xf5) return true;
      if (ib === 0xf6) return null;
      let x: number;
      if (ib === 0xf9) {
        x = halfValue(input.view.getUint16((input.need(2), input.at)));
        input.at += 2;
      } else if (ib === 0xfa) {
        input.need(4);
        x = input.view.getFloat32(input.at);
        input.at += 4;
      } else if (ib === 0xfb) {
        input.need(8);
        x = input.view.getFloat64(input.at);
        input.at += 8;
      } else throw wrong("a simple value that is not false, true or null");
      const again = new Out();
      number(again, x);
      if (compare(again.buf.subarray(0, again.n), input.b.subarray(start, input.at)) !== 0) {
        throw wrong("a number not in its shortest float");
      }
      return x;
    }
  }
}

/** The value a deterministic encoding encodes; anything else throws. */
export function decode(bytes: Uint8Array | ArrayBuffer): Value {
  const input = new In(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  const x = read(input);
  if (input.at !== input.b.length) throw wrong("bytes after the value");
  return x;
}
