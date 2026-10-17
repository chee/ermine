// runner.js: made from runner.ts (deno bundle); not edited by hand.
// deno-lint-ignore-file
// deno-fmt-ignore-file
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // playground/experimental_os/newos/js/kit.ts
  var kit_exports = {};
  __export(kit_exports, {
    compute: () => compute,
    data: () => data,
    drop: () => drop,
    effect: () => effect,
    first: () => first,
    front: () => front,
    handler: () => handler,
    idAt: () => idAt,
    isStatus: () => isStatus,
    key: () => key,
    make: () => make,
    put: () => put,
    snap: () => snap,
    val: () => val,
    vals: () => vals,
    whole: () => whole
  });
  var whole = (value) => [
    {
      path: [],
      value
    }
  ];
  var key = (k, value) => [
    {
      path: [
        k
      ],
      value
    }
  ];
  var isStatus = (v) => v.because?.place === "status";
  var first = (versions) => versions?.find((v) => !isStatus(v))?.content;
  function val(api, address) {
    return first(api.content(address).find((i) => i.versions)?.versions);
  }
  function vals(api, address) {
    return api.content(address).filter((i) => i.versions).map((i) => first(i.versions));
  }
  function idAt(api, address) {
    return api.look(address).find((i) => i.node)?.id;
  }
  function put(api, parent, name, value, o = {}) {
    const id = api.create(value, o);
    api.insert(parent, name, id);
    return id;
  }
  function make(api, address, name, value, o = {}) {
    const had = idAt(api, [
      ...address,
      name
    ]);
    if (had) return had;
    const parent = idAt(api, address);
    return parent ? put(api, parent, name, value, o) : void 0;
  }
  function snap(api, address, value, o = {}) {
    if (idAt(api, address)) api.write(address, whole(value));
    else make(api, address.slice(0, -1), address[address.length - 1], value, o);
  }
  function handler({ api, self, name }, list, f) {
    let on = idAt(api, [
      name,
      "on"
    ]);
    if (!on) on = put(api, self, "on", null, {
      ephemeral: true
    });
    put(api, on, list, f, {
      ephemeral: true
    });
    return [
      name,
      "on",
      list
    ];
  }
  function compute({ start, name }, child, f, o = {}) {
    return start({
      address: [
        name
      ],
      name: child,
      code: {
        compute: f
      },
      ...o
    });
  }
  function effect({ start, name }, child, c, e, o = {}) {
    return start({
      address: [
        name
      ],
      name: child,
      code: {
        compute: c,
        effect: e
      },
      ...o
    });
  }
  function drop(api, parent, name, id) {
    const at = idAt(api, parent);
    if (!at) return;
    const items = api.children(parent, name);
    const i = id === void 0 ? 0 : items.findIndex((it) => it.id === id);
    if (i >= 0 && i < items.length) api.remove(at, name, i);
  }
  function data({ api, name }) {
    return val(api, [
      name,
      "data"
    ]);
  }
  function front(address) {
    const parent = address.slice(0, -1), name = address[address.length - 1];
    let id;
    return {
      /** whether an item is in front */
      held: (api) => !!id && !!idAt(api, address),
      /** value in front: written into the item there, or placed there first */
      put(api, value, patches) {
        if (id && idAt(api, address) === id) api.write(address, patches ?? whole(value));
        else {
          const at = idAt(api, parent);
          if (!at) return;
          id = api.create(value, {
            ephemeral: true
          });
          api.insert(at, name, id, 0);
        }
      },
      /** over: the item in front let go, and value, if given, written into the document */
      done(api, value, patches) {
        if (id) drop(api, parent, name, id);
        id = void 0;
        if (value === void 0) return;
        if (patches && idAt(api, address)) api.write(address, patches);
        else snap(api, address, value);
      }
    };
  }

  // playground/experimental_os/newos/js/os.ts
  function os(n) {
    const here2 = (self) => {
      const at = n.here(self);
      if (!at) throw new Error(`ermine:os: where ${self} is is not known`);
      return at;
    };
    let timers = 0;
    const after2 = (part, ms, f) => {
      const list = `timer.${++timers}`;
      const me = here2(part.self);
      handler(part, list, (given) => {
        drop(given.api, [
          ...me,
          "on"
        ], list);
        return f(given);
      });
      n.after(ms, [
        ...me,
        "on",
        list
      ]);
      return (api) => drop(api, [
        ...me,
        "on"
      ], list);
    };
    const PLANES = [
      "/",
      "dev",
      "vram",
      "planes"
    ];
    const plane = (api, name, w, h) => {
      make(api, PLANES, name, {
        w,
        h
      }, {
        ephemeral: true
      });
      let bits = null, id = -1, stride = w, serial = 0, copy = false;
      const ready = (api2) => {
        if (bits) return true;
        const v = val(api2, [
          ...PLANES,
          name
        ]);
        if (typeof v?.shm !== "string") return false;
        id = v.id, stride = v.stride;
        bits = n.vram(id);
        if (!bits) bits = new Uint32Array(stride * h), copy = true;
        return true;
      };
      return {
        w,
        h,
        bits: (api2) => ready(api2) ? bits : null,
        stride: (api2) => (ready(api2), stride),
        /** what a layer holds as its plane to show it, or null before the driver has made it */
        value: (api2) => ready(api2) ? {
          source: "vram",
          id,
          serial
        } : null,
        /** x, y, dw × dh was drawn: the layer at address shows it; false before the plane is made */
        drawn(api2, call, layer, x = 0, y = 0, dw = w, dh = h) {
          if (!ready(api2)) return false;
          if (copy) {
            const part = new Uint32Array(dw * dh);
            for (let r = 0; r < dh; r++) {
              part.set(bits.subarray((y + r) * stride + x, (y + r) * stride + x + dw), r * dw);
            }
            call([
              "/",
              "dev",
              "vram",
              "driver",
              "on",
              "put"
            ], [
              id,
              x,
              y,
              dw,
              dh,
              part
            ]);
          }
          if (idAt(api2, layer)) {
            api2.write(layer, [
              {
                path: [
                  "plane",
                  "serial"
                ],
                value: ++serial
              },
              {
                path: [
                  "plane",
                  "dirty"
                ],
                value: {
                  x,
                  y,
                  w: dw,
                  h: dh
                }
              }
            ]);
          }
          return true;
        }
      };
    };
    const kill3 = (pid) => n.kill(pid);
    const end = (part) => n.kill(part.self);
    return {
      here: here2,
      after: after2,
      plane,
      kill: kill3,
      end
    };
  }

  // playground/experimental_os/newos/js/text.ts
  var TextEncoder2 = class {
    encoding = "utf-8";
    encode(text = "") {
      const s = String(text);
      const out = new Uint8Array(s.length * 3);
      let n = 0;
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 55296 && c < 56320 && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 56320 && d < 57344) {
            c = 65536 + (c - 55296 << 10) + (d - 56320);
            i++;
          }
        }
        if (c >= 55296 && c < 57344) c = 65533;
        if (c < 128) out[n++] = c;
        else if (c < 2048) {
          out[n++] = 192 | c >> 6;
          out[n++] = 128 | c & 63;
        } else if (c < 65536) {
          out[n++] = 224 | c >> 12;
          out[n++] = 128 | c >> 6 & 63;
          out[n++] = 128 | c & 63;
        } else {
          out[n++] = 240 | c >> 18;
          out[n++] = 128 | c >> 12 & 63;
          out[n++] = 128 | c >> 6 & 63;
          out[n++] = 128 | c & 63;
        }
      }
      return out.slice(0, n);
    }
  };
  var TextDecoder2 = class {
    encoding = "utf-8";
    #held = [];
    decode(input, options) {
      const bytes2 = input === void 0 ? new Uint8Array(0) : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      const b = this.#held.length ? Uint8Array.from([
        ...this.#held,
        ...bytes2
      ]) : bytes2;
      this.#held = [];
      const stream = !!options?.stream;
      let out = "";
      const units = [];
      const put2 = (c) => {
        if (c >= 65536) {
          units.push(55296 + (c - 65536 >> 10), 56320 + (c - 65536 & 1023));
        } else units.push(c);
        if (units.length > 8192) out += String.fromCharCode(...units.splice(0));
      };
      let i = 0;
      while (i < b.length) {
        const x = b[i];
        if (x < 128) {
          put2(x);
          i++;
          continue;
        }
        let need = 0, c = 0, lo = 128, hi = 191;
        if (x >= 194 && x <= 223) need = 1, c = x & 31;
        else if (x >= 224 && x <= 239) {
          need = 2, c = x & 15, lo = x === 224 ? 160 : 128, hi = x === 237 ? 159 : 191;
        } else if (x >= 240 && x <= 244) {
          need = 3, c = x & 7, lo = x === 240 ? 144 : 128, hi = x === 244 ? 143 : 191;
        } else {
          put2(65533);
          i++;
          continue;
        }
        let k = 1;
        for (; k <= need && i + k < b.length; k++) {
          const y = b[i + k];
          if (y < (k === 1 ? lo : 128) || y > (k === 1 ? hi : 191)) break;
          c = c << 6 | y & 63;
        }
        if (k > need) {
          put2(c);
          i += k;
        } else if (i + k >= b.length && stream) {
          this.#held = [
            ...b.subarray(i)
          ];
          break;
        } else {
          put2(65533);
          i += k;
        }
      }
      return out + String.fromCharCode(...units);
    }
  };

  // playground/experimental_os/newos/js/wasm.ts
  var LOG = 50;
  var encoder = new TextEncoder2();
  var decoder = new TextDecoder2();
  var NULL = 0;
  var BOOL = 1;
  var NUM = 2;
  var TEXT = 3;
  var BYTES = 4;
  var LIST = 5;
  var MAP = 6;
  var OTHER = 7;
  var isMap = (x) => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
  var bytesOf = (x) => ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : null;
  var kindOf = (x) => x === null || x === void 0 ? NULL : typeof x === "boolean" ? BOOL : typeof x === "number" ? NUM : typeof x === "string" ? TEXT : bytesOf(x) ? BYTES : Array.isArray(x) ? LIST : isMap(x) ? MAP : OTHER;
  var shown = (x) => {
    try {
      return JSON.stringify(x, (_, v) => bytesOf(v) ? `<${bytesOf(v).length} bytes>` : typeof v === "function" ? "<live>" : v) ?? "null";
    } catch {
      return String(x);
    }
  };
  var wrong = (code, message) => Object.assign(new Error(message), {
    code,
    name: ""
  });
  function wasm(os3) {
    const load2 = (bytes2, url) => {
      const module = new WebAssembly.Module(bytes2);
      return (given) => instance(module, url).setup(given);
    };
    const instance = (module, url) => {
      const frames = [];
      const lines = [];
      let ex;
      const frame = () => {
        const f = frames[frames.length - 1];
        if (!f) throw wrong("stopped", "no part of this program is running");
        return f;
      };
      const hold = (v) => frame().values.push(v === void 0 ? null : v) - 1;
      const at = (h) => h > 0 ? frame().values[h] ?? null : null;
      const memory = () => new Uint8Array(ex.memory.buffer);
      const text = (p, n) => decoder.decode(memory().slice(p, p + n));
      const cText = (p) => {
        const m = memory();
        let e = p;
        while (m[e]) e++;
        return decoder.decode(m.slice(p, e));
      };
      const names2 = (p, n) => {
        const d = new DataView(ex.memory.buffer);
        return Array.from({
          length: n
        }, (_, i) => cText(d.getUint32(p + 4 * i, true)));
      };
      const copy = (b, p, room) => {
        memory().set(b.subarray(0, Math.max(0, Math.min(room, b.length))), p);
        return b.length;
      };
      const call = (index, args) => {
        const f = ex.__indirect_function_table?.get(index);
        if (typeof f !== "function") {
          throw wrong("not-a-handler", `no function ${index} in its table`);
        }
        f(args);
      };
      const enter = (given, what, run2) => {
        const top = ex.__stack_pointer?.value;
        frames.push({
          given,
          values: [
            null
          ]
        });
        try {
          return run2();
        } catch (e) {
          if (top !== void 0 && ex.__stack_pointer) ex.__stack_pointer.value = top;
          const out = e instanceof WebAssembly.RuntimeError ? wrong("crashed", `crashed in ${what}: ${e.message.replace(/ \(evaluating .*\)$/, "").toLowerCase()}`) : e;
          failed(given, out.code === "crashed" ? String(out.message) : `failed in ${what}: ${out.code ? `${out.code}: ` : ""}${out.message ?? out}`);
          throw out;
        } finally {
          frames.pop();
        }
      };
      let failing = false;
      const failed = (g2, text2) => {
        const { api, self, name } = g2;
        if (!self || !name || text2 === null && !failing) return;
        try {
          if (idAt(api, [
            name,
            "failed"
          ])) api.write([
            name,
            "failed"
          ], whole(text2));
          else if (text2 !== null) put(api, self, "failed", text2, {
            ephemeral: true
          });
          failing = text2 !== null;
        } catch {
        }
      };
      const part = (what, index) => (given) => enter(given, what, () => call(index, hold(given.args ?? [])));
      const absolute = (g2, address) => {
        if (address[0] === "/") return address;
        const out = os3.here(g2.self).slice(0, -1);
        for (const n of address) n === ".." ? out.length > 1 && out.pop() : out.push(n);
        return out;
      };
      const say2 = (line) => {
        lines.push(line);
        while (lines.length > LOG) lines.shift();
        const { api, self, name } = frame().given;
        if (!self || !name) return;
        if (idAt(api, [
          name,
          "log"
        ])) api.write([
          name,
          "log"
        ], whole([
          ...lines
        ]));
        else put(api, self, "log", [
          ...lines
        ], {
          ephemeral: true
        });
        failed(frame().given, null);
      };
      const op = (word, address, a) => {
        const f = frame(), g2 = f.given;
        const api = f.cause !== void 0 ? g2.api.as({
          cause: f.cause
        }) : g2.api;
        const where = () => {
          if (!address) throw wrong("wrong-field", `${word} takes an address`);
          return address;
        };
        switch (word) {
          case "read":
            return val(api, where());
          case "id":
            return idAt(api, where()) ?? null;
          case "write": {
            if (idAt(api, where())) return api.write(where(), whole(a[0]));
            const to = absolute(g2, where());
            const parent = idAt(api, to.slice(0, -1));
            if (!parent) {
              throw wrong("nothing-there", `write: nothing at ${to.slice(0, -1).join("/").replace(/^\/\/?/, "/")}`);
            }
            return api.insert(parent, to[to.length - 1], api.create(a[0]));
          }
          case "patch":
            return api.write(where(), a[0]);
          case "set":
            return api.set(where(), a[0], whole(a[1]));
          case "look":
            return api.look(where());
          case "lookup":
            return api.lookup(where());
          case "lookups":
            return api.lookups(where());
          case "content":
            return api.content(where());
          case "info":
            return api.info(where(), a[0]);
          case "children":
            return a.length ? api.children(where(), a[0]) : api.children(where());
          case "create":
            return api.create(a[0], {
              ephemeral: !!a[1]
            });
          case "insert":
            return api.insert(a[0], a[1], a[2]);
          case "remove":
            return api.remove(a[0], a[1], a[2]);
          case "pop":
            return api.pop(a[0], a[1], a[2]);
          case "rename":
            return api.rename(a[0], a[1], a[2]);
          case "move":
            return api.move(a[0], a[1], a[2], a[3], a[4]);
          case "node":
            return api.node(a[0]);
          case "as":
            f.cause = a[0] ?? void 0;
            return null;
          case "self":
            return g2.self ?? null;
          case "name":
            return g2.name ?? null;
          case "handler":
            return handler(g2, a[0], part(a[0], a[1]));
          case "after":
            os3.after(g2, a[0], part("a timer", a[1]));
            return null;
          case "cleanup":
            if (!g2.onCleanup) {
              throw wrong("wrong-field", "a cleanup is set up by a setup or a handler");
            }
            g2.onCleanup(part("cleanup", a[0]));
            return null;
          case "start": {
            if (!g2.start) throw wrong("wrong-field", "this part starts nothing");
            return g2.start({
              address: where(),
              program: a[0],
              ...typeof a[1] === "string" ? {
                name: a[1]
              } : {}
            });
          }
          case "call":
            if (!g2.call) throw wrong("wrong-field", "this part calls nothing");
            return g2.call(where(), a[0]) ?? null;
          case "end":
            os3.end(g2);
            return null;
        }
        throw wrong("wrong-field", `no such operation: ${word}`);
      };
      const imports = {
        ermine: {
          num: (n) => hold(n),
          text: (p, n) => hold(text(p, n)),
          bytes: (p, n) => hold(memory().slice(p, p + n)),
          bool: (b) => hold(!!b),
          list: () => hold([]),
          map: () => hold({}),
          push: (l, v) => {
            const x = at(l);
            if (Array.isArray(x)) x.push(at(v));
          },
          put: (m, k, n, v) => {
            const x = at(m);
            if (isMap(x)) x[text(k, n)] = at(v);
          },
          kind: (h) => kindOf(at(h)),
          number: (h) => {
            const x = at(h);
            return typeof x === "number" ? x : typeof x === "boolean" ? Number(x) : 0;
          },
          length: (h) => {
            const x = at(h);
            return typeof x === "string" ? encoder.encode(x).length : bytesOf(x)?.length ?? (Array.isArray(x) ? x.length : isMap(x) ? Object.keys(x).length : 0);
          },
          copy: (h, p, room) => {
            const x = at(h);
            if (typeof x === "string") {
              const b2 = encoder.encode(x);
              if (b2.length < room) memory()[p + b2.length] = 0;
              return copy(b2, p, room);
            }
            const b = bytesOf(x);
            return b ? copy(b, p, room) : 0;
          },
          item: (h, i) => {
            const x = at(h);
            return hold(Array.isArray(x) ? x[i] : null);
          },
          get: (h, k, n) => {
            const x = at(h);
            return hold(isMap(x) ? x[text(k, n)] : null);
          },
          keys: (h) => {
            const x = at(h);
            return hold(isMap(x) ? Object.keys(x) : []);
          },
          show: (h, p, room) => copy(encoder.encode(shown(at(h))), p, room),
          op: (o, no, p, n, args) => {
            const a = at(args);
            return hold(op(text(o, no), n >= 0 ? names2(p, n) : null, Array.isArray(a) ? a : []));
          },
          say: (p, n) => say2(text(p, n))
        }
      };
      const setup = (given) => {
        try {
          ex = new WebAssembly.Instance(module, imports).exports;
        } catch (e) {
          throw wrong("not-a-program", `${url}: ${e.message}`);
        }
        if (typeof ex.setup !== "function") {
          throw wrong("not-a-program", "a program starts at setup(), and this one has none");
        }
        failing = true;
        failed(given, null);
        return enter(given, "setup", () => at(ex.setup()));
      };
      return {
        setup
      };
    };
    return {
      load: load2
    };
  }

  // playground/experimental_os/newos/js/blitter.ts
  var TRANSPARENT = 4278190080;
  var recording = (f) => "ops" in f;
  var Blitter = class {
    font;
    cell;
    #glyphs;
    constructor(font) {
      this.font = font;
      this.#glyphs = /* @__PURE__ */ new Map();
      this.cell = {
        w: font.w,
        h: font.h
      };
      [
        ...font.chars
      ].forEach((ch, i) => this.#glyphs.set(ch, i * font.w * font.h));
    }
    /** A form that records ops instead of pixels: draw on it as on a form, then put its ops in a layer. */
    list(w, h, fill) {
      return {
        w,
        h,
        ops: fill === void 0 ? [] : [
          {
            op: "fill",
            x: 0,
            y: 0,
            w,
            h,
            color: fill
          }
        ]
      };
    }
    form(w, h, fill = 0) {
      const bits = new Uint32Array(Math.max(0, w * h));
      if (fill) bits.fill(fill);
      return {
        w,
        h,
        bits
      };
    }
    /** The part of a rectangle inside a form, and inside clip if given. */
    #clip(f, r, clip) {
      let x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      let x1 = Math.min(f.w, r.x + r.w), y1 = Math.min(f.h, r.y + r.h);
      if (clip) {
        x0 = Math.max(x0, clip.x);
        y0 = Math.max(y0, clip.y);
        x1 = Math.min(x1, clip.x + clip.w);
        y1 = Math.min(y1, clip.y + clip.h);
      }
      return {
        x: x0,
        y: y0,
        w: Math.max(0, x1 - x0),
        h: Math.max(0, y1 - y0)
      };
    }
    fill(dst, x, y, w, h, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "fill",
          x,
          y,
          w,
          h,
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      const r = this.#clip(dst, {
        x,
        y,
        w,
        h
      }, clip);
      for (let ty = r.y; ty < r.y + r.h; ty++) {
        dst.bits.fill(color, ty * dst.w + r.x, ty * dst.w + r.x + r.w);
      }
    }
    /** A one-pixel frame. */
    frame(dst, x, y, w, h, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "frame",
          x,
          y,
          w,
          h,
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      this.fill(dst, x, y, w, 1, color, clip);
      this.fill(dst, x, y + h - 1, w, 1, color, clip);
      this.fill(dst, x, y, 1, h, color, clip);
      this.fill(dst, x + w - 1, y, 1, h, color, clip);
    }
    /**
    * src replicated to tile w × h at x, y, as Plan 9's repl does, from src's
    * corner at x, y: a pixels op with repl {w, h}, its bits src's, so a
    * pattern across a screen is one small form.
    */
    tile(dst, x, y, w, h, src, rule = "copy", clip) {
      if (recording(dst)) {
        const bits = src.bits.slice(0, src.w * src.h);
        return void dst.ops.push({
          op: "pixels",
          x,
          y,
          w,
          h,
          bits,
          repl: {
            w: src.w,
            h: src.h
          },
          ...rule !== "copy" ? {
            rule
          } : {},
          ...clip ? {
            clip
          } : {}
        });
      }
      if (src.w <= 0 || src.h <= 0) return;
      for (let ty = 0; ty < h; ty += src.h) {
        for (let tx = 0; tx < w; tx += src.w) {
          this.blit(dst, x + tx, y + ty, src, 0, 0, Math.min(src.w, w - tx), Math.min(src.h, h - ty), rule, clip);
        }
      }
    }
    /** BitBlt: src's rectangle at sx, sy, w × h, into dst at dx, dy, clipped to dst and to clip. */
    blit(dst, dx, dy, src, sx = 0, sy = 0, w = src.w, h = src.h, rule = "copy", clip) {
      if (recording(dst)) {
        w = Math.max(0, Math.min(w, src.w - sx));
        h = Math.max(0, Math.min(h, src.h - sy));
        const bits = new Uint32Array(w * h);
        for (let y = 0; y < h; y++) {
          bits.set(src.bits.subarray((sy + y) * src.w + sx, (sy + y) * src.w + sx + w), y * w);
        }
        return void dst.ops.push({
          op: "pixels",
          x: dx,
          y: dy,
          w,
          h,
          bits,
          ...rule !== "copy" ? {
            rule
          } : {},
          ...clip ? {
            clip
          } : {}
        });
      }
      if (sx < 0) {
        dx -= sx;
        w += sx;
        sx = 0;
      }
      if (sy < 0) {
        dy -= sy;
        h += sy;
        sy = 0;
      }
      w = Math.min(w, src.w - sx);
      h = Math.min(h, src.h - sy);
      const r = this.#clip(dst, {
        x: dx,
        y: dy,
        w,
        h
      }, clip);
      if (r.w <= 0 || r.h <= 0) return;
      const ox = sx + (r.x - dx), oy = sy + (r.y - dy);
      for (let y = 0; y < r.h; y++) {
        const s = (oy + y) * src.w + ox;
        const d = (r.y + y) * dst.w + r.x;
        if (rule === "copy") {
          dst.bits.set(src.bits.subarray(s, s + r.w), d);
          continue;
        }
        for (let x = 0; x < r.w; x++) {
          const p = src.bits[s + x];
          if (rule === "over") {
            if (p >>> 0 !== TRANSPARENT) dst.bits[d + x] = p & 16777215;
          } else {
            const a = 255 - (p >>> 24 & 255);
            if (a) dst.bits[d + x] = a === 255 ? p & 16777215 : mix(dst.bits[d + x], p, a);
          }
        }
      }
    }
    /**
    * A line from x0, y0 to x1, y1, both ends drawn, width pixels across in a
    * round pen (1 if less, or not given): Plan 9's line, whose thick t is
    * width 1 + 2t.
    */
    line(dst, x0, y0, x1, y1, width, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "line",
          x0,
          y0,
          x1,
          y1,
          ...width !== void 0 && width !== 1 ? {
            width
          } : {},
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      if (r.w <= 0 || r.h <= 0) return;
      const s = spans(r), p = pen(whole2(width ?? 1, 1, WIDEST));
      walk(s, p, whole2(x0, -FAR, FAR), whole2(y0, -FAR, FAR), whole2(x1, -FAR, FAR), whole2(y1, -FAR, FAR));
      paint(dst, s, color);
    }
    /**
    * Lines from each point to the next, each as line draws it: Plan 9's poly.
    * points are x, y, x, y...; closed only if the last point is the first.
    */
    poly(dst, points, width, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "poly",
          points: Array.from(points),
          ...width !== void 0 && width !== 1 ? {
            width
          } : {},
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      const n = (points?.length ?? 0) >> 1;
      if (r.w <= 0 || r.h <= 0 || !n) return;
      const s = spans(r), p = pen(whole2(width ?? 1, 1, WIDEST));
      const at = (i, k) => whole2(points[2 * i + k], -FAR, FAR);
      for (let i = 0; i < Math.max(1, n - 1); i++) {
        const j = Math.min(i + 1, n - 1);
        walk(s, p, at(i, 0), at(i, 1), at(j, 0), at(j, 1));
        paint(dst, s, color);
      }
    }
    /**
    * A polygon filled: Plan 9's fillpoly. points are x, y, x, y..., and the
    * last joins the first. A pixel is in when its centre is inside, by wind.
    */
    fillpoly(dst, points, wind, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "fillpoly",
          points: Array.from(points),
          ...wind === "odd" ? {
            wind
          } : {},
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      const n = (points?.length ?? 0) >> 1;
      if (r.w <= 0 || r.h <= 0 || !n) return;
      const xs = new Array(n), ys = new Array(n);
      let top = FAR, bottom = -FAR;
      for (let i = 0; i < n; i++) {
        xs[i] = whole2(points[2 * i], -FAR, FAR);
        ys[i] = whole2(points[2 * i + 1], -FAR, FAR);
        top = Math.min(top, ys[i]);
        bottom = Math.max(bottom, ys[i]);
      }
      top = Math.max(top, r.y);
      bottom = Math.min(bottom, r.y + r.h);
      const odd = wind === "odd";
      const cross = [];
      for (let y = top; y < bottom; y++) {
        cross.length = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          let x0 = xs[i], y0 = ys[i], x1 = xs[j], y1 = ys[j], dir = 1;
          if (y0 === y1) continue;
          if (y0 > y1) {
            ;
            [x0, y0, x1, y1, dir] = [
              x1,
              y1,
              x0,
              y0,
              -1
            ];
          }
          if (y < y0 || y >= y1) continue;
          cross.push([
            up((2 * x0 - 1) * (y1 - y0) + (2 * y + 1 - 2 * y0) * (x1 - x0), 2 * (y1 - y0)),
            dir
          ]);
        }
        cross.sort((a, b) => a[0] - b[0]);
        let turns = 0;
        for (let k = 0; k + 1 < cross.length; k++) {
          turns += cross[k][1];
          const a = Math.max(cross[k][0], r.x), b = Math.min(cross[k + 1][0], r.x + r.w);
          if ((odd ? turns % 2 !== 0 : turns !== 0) && a < b) {
            dst.bits.fill(color, y * dst.w + a, y * dst.w + b);
          }
        }
      }
    }
    /**
    * An ellipse's outline, centred on x, y, rx pixels across from it and ry
    * down, width pixels across in a round pen (1 if less, or not given):
    * Plan 9's ellipse.
    */
    ellipse(dst, x, y, rx, ry, width, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "ellipse",
          x,
          y,
          rx,
          ry,
          ...width !== void 0 && width !== 1 ? {
            width
          } : {},
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      const a = whole2(rx, -1, RADIUS), b = whole2(ry, -1, RADIUS);
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return;
      const cx = whole2(x, -FAR, FAR), cy = whole2(y, -FAR, FAR), p = pen(whole2(width ?? 1, 1, WIDEST));
      const q = [
        spans(r),
        spans(r),
        spans(r),
        spans(r)
      ];
      arc(a, b, (px, py) => {
        stamp(q[0], p, cx + px, cy + py);
        stamp(q[1], p, cx - px, cy + py);
        stamp(q[2], p, cx - px, cy - py);
        stamp(q[3], p, cx + px, cy - py);
      });
      for (const s of q) paint(dst, s, color);
    }
    /** An ellipse filled, its outline's pixels with it: Plan 9's fillellipse. */
    fillellipse(dst, x, y, rx, ry, color, clip) {
      if (recording(dst)) {
        return void dst.ops.push({
          op: "fillellipse",
          x,
          y,
          rx,
          ry,
          color,
          ...clip ? {
            clip
          } : {}
        });
      }
      const a = whole2(rx, -1, RADIUS), b = whole2(ry, -1, RADIUS);
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return;
      const cx = whole2(x, -FAR, FAR), cy = whole2(y, -FAR, FAR), s = spans(r);
      arc(a, b, (px, py) => {
        mark(s, cy + py, cx - px, cx + px);
        mark(s, cy - py, cx - px, cx + px);
      });
      paint(dst, s, color);
    }
    /**
    * Text, its top left at x, y; on bg, or over what is there. Gives the x it
    * ended at. In font if given, else in the font ROM's cells.
    */
    text(dst, x, y, s, fg, bg, clip, font) {
      if (recording(dst)) {
        dst.ops.push({
          op: "text",
          x,
          y,
          text: s,
          color: fg,
          font: font?.role ?? null,
          ...bg !== void 0 ? {
            bg
          } : {},
          ...clip ? {
            clip
          } : {}
        });
        return x + this.measure(s, font);
      }
      if (font) return this.#proportional(dst, x, y, s, fg, bg, clip, font);
      const { w: cw, h: ch, alpha } = this.font;
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      for (const c of s) {
        const at = this.#glyphs.get(c) ?? this.#glyphs.get("?");
        if (bg !== void 0) this.fill(dst, x, y, cw, ch, bg, clip);
        this.#coverage(dst, r, x, y, alpha, cw, at, cw, ch, fg);
        x += cw;
      }
      return x;
    }
    #proportional(dst, x, y, s, fg, bg, clip, font) {
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      let pen2 = x;
      for (const c of s) {
        const cp = c.codePointAt(0);
        const page = font.page(cp >> 8);
        if (!page) {
          pen2 += font.ascent / 2;
          continue;
        }
        const i = (cp & 255) * 4;
        const sx = page.info[i], left = page.info[i + 1], w = page.info[i + 2], advance = page.info[i + 3];
        if (bg !== void 0) {
          this.fill(dst, Math.round(pen2), y, Math.round(pen2 + advance) - Math.round(pen2), font.h, bg, clip);
        }
        if (w) {
          this.#coverage(dst, r, Math.round(pen2) + left, y, page.alpha, page.w, sx, w, font.h, fg);
        }
        pen2 += advance;
      }
      return Math.round(pen2);
    }
    /** w × h of coverage, from alpha at offset at with rows of stride, as fg onto dst at x, y, inside r. */
    #coverage(dst, r, x, y, alpha, stride, at, w, h, fg) {
      const y0 = Math.max(y, r.y), y1 = Math.min(y + h, r.y + r.h);
      const x0 = Math.max(x, r.x), x1 = Math.min(x + w, r.x + r.w);
      for (let ty = y0; ty < y1; ty++) {
        const row = at + (ty - y) * stride - x;
        const d = ty * dst.w;
        for (let tx = x0; tx < x1; tx++) {
          const a = alpha[row + tx];
          if (!a) continue;
          dst.bits[d + tx] = a === 255 ? fg : mix(dst.bits[d + tx], fg, a);
        }
      }
    }
    /** How wide a string is, in font if given. */
    measure(s, font) {
      if (!font) return [
        ...s
      ].length * this.font.w;
      let pen2 = 0;
      for (const c of s) {
        const cp = c.codePointAt(0);
        const page = font.page(cp >> 8);
        pen2 += page ? page.info[(cp & 255) * 4 + 3] : font.ascent / 2;
      }
      return Math.round(pen2);
    }
    /** The caret offset (UTF-16) in s nearest to dx pixels from its start, in font if given: for a click. */
    at(s, dx, font) {
      let pen2 = 0, i = 0;
      for (const c of s) {
        const cp = c.codePointAt(0);
        let advance;
        if (!font) advance = this.font.w;
        else {
          const page = font.page(cp >> 8);
          advance = page ? page.info[(cp & 255) * 4 + 3] : font.ascent / 2;
        }
        if (pen2 + advance / 2 > dx) return i;
        pen2 += advance;
        i += c.length;
      }
      return s.length;
    }
    /**
    * Plays ops into a form, as the compositor does a layer's: gives where
    * each text run went. marks are ranges of runs to draw on a highlighter,
    * by op: [from, to], UTF-16 offsets.
    */
    play(dst, ops2, fonts, marks, mark2 = 16777096) {
      const runs = [];
      ops2.forEach((o, i) => {
        if (o.op === "fill") this.fill(dst, o.x, o.y, o.w, o.h, o.color, o.clip);
        else if (o.op === "frame") this.frame(dst, o.x, o.y, o.w, o.h, o.color, o.clip);
        else if (o.op === "pixels" && o.repl) {
          this.tile(dst, o.x, o.y, o.w, o.h, {
            w: o.repl.w,
            h: o.repl.h,
            bits: o.bits
          }, o.rule ?? "copy", o.clip);
        } else if (o.op === "pixels") {
          this.blit(dst, o.x, o.y, {
            w: o.w,
            h: o.h,
            bits: o.bits
          }, 0, 0, o.w, o.h, o.rule ?? "copy", o.clip);
        } else if (o.op === "text") {
          const font = o.font ? fonts(o.font) : void 0;
          const w = this.measure(o.text, font), h = this.height(font);
          runs.push({
            op: i,
            x: o.x,
            y: o.y,
            w,
            h,
            text: o.text,
            font: o.font
          });
          if (o.bg !== void 0) this.fill(dst, o.x, o.y, w, h, o.bg, o.clip);
          const m = marks?.get(i);
          if (m) {
            const a = o.x + this.measure(o.text.slice(0, m[0]), font), b = o.x + this.measure(o.text.slice(0, m[1]), font);
            this.fill(dst, a, o.y, b - a, h, mark2, o.clip);
          }
          this.text(dst, o.x, o.y, o.text, o.color, void 0, o.clip, font);
        } else if (o.op === "line") {
          this.line(dst, o.x0, o.y0, o.x1, o.y1, o.width, o.color, o.clip);
        } else if (o.op === "ellipse") {
          this.ellipse(dst, o.x, o.y, o.rx, o.ry, o.width, o.color, o.clip);
        } else if (o.op === "fillellipse") {
          this.fillellipse(dst, o.x, o.y, o.rx, o.ry, o.color, o.clip);
        } else if (o.op === "poly") this.poly(dst, o.points, o.width, o.color, o.clip);
        else if (o.op === "fillpoly") this.fillpoly(dst, o.points, o.wind, o.color, o.clip);
      });
      return runs;
    }
    /**
    * The text between two points over a layer's runs, as a person drags
    * across it: in reading order, top to bottom, then left to right; a run on
    * a lower line starts a new line, and a gap on one line is a space.
    */
    select(runs, from, to, fonts) {
      const order2 = [
        ...runs
      ].sort((a2, b2) => a2.y - b2.y || a2.x - b2.x);
      if (!order2.length) return {
        ranges: [],
        text: ""
      };
      const font = (r) => r.font ? fonts(r.font) : void 0;
      const place = ([px, py]) => {
        const line = order2.map((r, k) => [
          r,
          k
        ]).filter(([r]) => py >= r.y && py < r.y + r.h);
        if (line.length) {
          const [first2, k0] = line[0], [last, k1] = line.at(-1);
          if (px < first2.x) return [
            k0,
            0
          ];
          for (const [r, k] of line) {
            if (px < r.x + r.w) return [
              k,
              this.at(r.text, px - r.x, font(r))
            ];
          }
          return [
            k1,
            last.text.length
          ];
        }
        const below = order2.findIndex((r) => r.y > py);
        return below >= 0 ? [
          below,
          0
        ] : [
          order2.length - 1,
          order2.at(-1).text.length
        ];
      };
      let a = place(from), b = place(to);
      if (b[0] < a[0] || b[0] === a[0] && b[1] < a[1]) [a, b] = [
        b,
        a
      ];
      const ranges = [];
      let text = "";
      let prev = null;
      for (let k = a[0]; k <= b[0]; k++) {
        const r = order2[k];
        const from2 = k === a[0] ? a[1] : 0, to2 = k === b[0] ? b[1] : r.text.length;
        if (to2 <= from2) continue;
        if (prev) {
          if (r.y >= prev.y + prev.h / 2) text += "\n";
          else if (r.x - (prev.x + prev.w) > prev.h / 4) text += " ";
        }
        ranges.push([
          r.op,
          from2,
          to2
        ]);
        text += r.text.slice(from2, to2);
        prev = r;
      }
      return {
        ranges,
        text
      };
    }
    /** How tall a line is, in font if given. */
    height(font) {
      return font ? font.h : this.font.h;
    }
    /** How many of s's characters fit in w pixels, in font if given: for wrapping and for finding a click. */
    fit(s, w, font) {
      if (!font) return Math.max(0, Math.min([
        ...s
      ].length, Math.floor(w / this.font.w)));
      let pen2 = 0, n = 0;
      for (const c of s) {
        const cp = c.codePointAt(0);
        const page = font.page(cp >> 8);
        pen2 += page ? page.info[(cp & 255) * 4 + 3] : font.ascent / 2;
        if (pen2 > w) break;
        n++;
      }
      return n;
    }
    toString() {
      return `blitter: copy, over and blend; text in ${this.font.w}x${this.font.h} cells, or in a font`;
    }
  };
  function mix(bg, fg, a) {
    const m = (s) => ((bg >> s & 255) * (255 - a) + (fg >> s & 255) * a) / 255 | 0;
    return m(16) << 16 | m(8) << 8 | m(0);
  }
  var FAR = 1 << 20;
  var RADIUS = 1 << 16;
  var WIDEST = 4096;
  function whole2(n, lo, hi) {
    const v = Math.floor(n);
    return Math.max(lo, Math.min(hi, Number.isNaN(v) ? 0 : v));
  }
  function up(n, d) {
    let q = Math.ceil(n / d);
    while (q * d < n) q++;
    while ((q - 1) * d >= n) q--;
    return q;
  }
  function spans(r) {
    return {
      r,
      lo: new Int32Array(r.h).fill(2147483647),
      hi: new Int32Array(r.h).fill(-2147483648),
      top: r.h,
      bottom: 0
    };
  }
  function mark(s, y, x0, x1) {
    const k = y - s.r.y;
    if (k < 0 || k >= s.r.h) return;
    if (x0 < s.lo[k]) s.lo[k] = x0;
    if (x1 > s.hi[k]) s.hi[k] = x1;
    if (k < s.top) s.top = k;
    if (k + 1 > s.bottom) s.bottom = k + 1;
  }
  function paint(dst, s, color) {
    const { r, lo, hi } = s;
    for (let k = s.top; k < s.bottom; k++) {
      const a = Math.max(lo[k], r.x), b = Math.min(hi[k], r.x + r.w - 1);
      if (a <= b) dst.bits.fill(color, (r.y + k) * dst.w + a, (r.y + k) * dst.w + b + 1);
      lo[k] = 2147483647;
      hi[k] = -2147483648;
    }
    s.top = r.h;
    s.bottom = 0;
  }
  function pen(w) {
    const c = w - 1, l = new Int32Array(w);
    let i = c >> 1;
    for (let j = 0; j <= c >> 1; j++) {
      while (i > 0 && (2 * i - 2 - c) ** 2 + (2 * j - c) ** 2 <= w * w) i--;
      l[j] = l[c - j] = i;
    }
    return l;
  }
  function stamp(s, p, x, y) {
    const w = p.length, bx = x - (w - 1 >> 1), by = y - (w - 1 >> 1), r = s.r;
    if (bx >= r.x + r.w || bx + w <= r.x || by >= r.y + r.h || by + w <= r.y) return;
    const j1 = Math.min(w, r.y + r.h - by);
    for (let j = Math.max(0, r.y - by); j < j1; j++) mark(s, by + j, bx + p[j], bx + w - 1 - p[j]);
  }
  function walk(s, p, x, y, ex, ey) {
    const dx = Math.abs(ex - x), dy = -Math.abs(ey - y), sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (; ; ) {
      stamp(s, p, x, y);
      if (x === ex && y === ey) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }
  function arc(a, b, plot) {
    let x = -a, y = 0, e2 = b * b, err = x * (2 * e2 + x) + e2;
    do {
      plot(-x, y);
      e2 = 2 * err;
      if (e2 >= (x * 2 + 1) * b * b) err += (++x * 2 + 1) * b * b;
      if (e2 <= (y * 2 + 1) * a * a) err += (++y * 2 + 1) * a * a;
    } while (x <= 0);
    while (y++ < b) plot(0, y);
  }

  // playground/experimental_os/newos/js/draw.ts
  function draw(running2) {
    let blit = null;
    const blitter = (api) => {
      if (blit) return blit;
      const rom = val(api, [
        "/",
        "hw",
        "font"
      ]);
      const alpha = rom.alpha instanceof Uint8Array ? rom.alpha : new Uint8Array(rom.alpha);
      blit = new Blitter({
        w: rom.w,
        h: rom.h,
        chars: rom.chars,
        alpha
      });
      return blit;
    };
    class RemoteFont {
      value;
      h;
      ascent;
      role;
      #pages;
      #missed;
      #asked;
      constructor(value) {
        this.value = value;
        this.#pages = /* @__PURE__ */ new Map();
        this.#missed = {
          part: null,
          pages: /* @__PURE__ */ new Set()
        };
        this.#asked = /* @__PURE__ */ new Set();
        this.h = value.h;
        this.ascent = value.ascent;
        this.role = value.font;
      }
      page(n) {
        const had = this.#pages.get(n);
        if (had) return had;
        const part = running2();
        if (!part) return void 0;
        if (this.#missed.part !== part) this.#missed = {
          part,
          pages: /* @__PURE__ */ new Set()
        };
        if (this.#missed.pages.has(n)) return void 0;
        const p = val(part.api, [
          "/",
          "dev",
          "font",
          this.role,
          "pages",
          String(n)
        ]);
        if (!p) {
          this.#missed.pages.add(n);
          if (this.#asked.has(n) || !part.call) return void 0;
          this.#asked.add(n);
          try {
            part.call([
              "/",
              "dev",
              "font",
              "on",
              "want"
            ], [
              this.role,
              n
            ]);
          } catch {
          }
          return void 0;
        }
        const alpha = p.alpha instanceof Uint8Array ? p.alpha : new Uint8Array(p.alpha);
        const page = {
          w: p.w,
          alpha,
          info: p.info
        };
        this.#pages.set(n, page);
        return page;
      }
      toString() {
        return `${this.value.family} ${this.value.size}px`;
      }
    }
    const fonts = /* @__PURE__ */ new Map();
    const font = (value) => {
      const key3 = `${value.font} ${value.h} ${value.ascent}`;
      let f = fonts.get(key3);
      if (!f) fonts.set(key3, f = new RemoteFont(value));
      return f;
    };
    return {
      blitter,
      font,
      Blitter
    };
  }

  // playground/experimental_os/newos/js/views.ts
  var views_exports = {};
  __export(views_exports, {
    addressOf: () => addressOf,
    away: () => away,
    changes: () => changes,
    clock: () => clock,
    did: () => did,
    head: () => head,
    ids: () => ids,
    itemOf: () => itemOf,
    make: () => make2,
    ops: () => ops,
    order: () => order,
    short: () => short,
    shown: () => shown2,
    site: () => site,
    size: () => size,
    when: () => when,
    who: () => who
  });

  // playground/experimental_os/newos/js/readline.ts
  var readline_exports = {};
  __export(readline_exports, {
    chord: () => chord,
    insert: () => insert,
    key: () => key2,
    keyName: () => keyName,
    normal: () => normal,
    selection: () => selection,
    type: () => type
  });
  var CLIP = [
    "/",
    "dev",
    "clip",
    "text"
  ];
  var NAMES = {
    Enter: "return",
    Tab: "tab",
    Space: "space",
    " ": "space",
    Backspace: "backspace",
    Escape: "escape",
    Delete: "delete",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    ".": "period",
    ",": "comma",
    "-": "minus",
    "=": "equal",
    "/": "slash",
    "\\": "backslash",
    ";": "semicolon",
    "'": "quote",
    "`": "grave",
    "[": "bracketleft",
    "]": "bracketright"
  };
  var MODS = [
    [
      "alt",
      "A"
    ],
    [
      "ctrl",
      "C"
    ],
    [
      "fn",
      "H"
    ],
    [
      "shift",
      "S"
    ],
    [
      "cmd",
      "s"
    ]
  ];
  function keyName(key3) {
    return NAMES[key3] ?? (key3.length === 1 ? key3.toLowerCase() : key3.toLowerCase());
  }
  function chord(r) {
    const mods = MODS.filter(([m]) => r.mods?.includes(m)).map(([, c]) => c);
    return [
      ...mods,
      keyName(String(r.key ?? ""))
    ].join("-");
  }
  function normal(text, meta = "A") {
    const parts2 = String(text).trim().split("-");
    let key3 = parts2.pop() ?? "";
    if (key3 === "" && parts2.length && parts2.at(-1) === "") {
      parts2.pop();
      key3 = "-";
    }
    const mods = new Set(parts2.map((p) => p === "m" ? meta : p === "M" || p === "s" ? "s" : p === "S" ? "S" : p.toUpperCase()));
    return [
      ...MODS.map(([, c]) => c).filter((c) => mods.has(c)),
      keyName(key3)
    ].join("-");
  }
  var isWord = (c) => /[\w]/.test(c ?? "");
  var wordBack = (t, i) => {
    while (i > 0 && !isWord(t[i - 1])) i--;
    while (i > 0 && isWord(t[i - 1])) i--;
    return i;
  };
  var wordOn = (t, i) => {
    while (i < t.length && !isWord(t[i])) i++;
    while (i < t.length && isWord(t[i])) i++;
    return i;
  };
  var lineStart = (t, i) => t.lastIndexOf("\n", i - 1) + 1;
  var lineEnd = (t, i) => {
    const e = t.indexOf("\n", i);
    return e < 0 ? t.length : e;
  };
  function whole3(f) {
    const text = String(f.text ?? "");
    return {
      text,
      pos: Math.max(0, Math.min(text.length, f.pos ?? text.length)),
      mark: f.mark ?? null,
      ring: [
        ...f.ring ?? []
      ],
      undo: [
        ...f.undo ?? []
      ],
      yank: f.yank ?? null,
      last: "",
      goal: f.goal ?? null
    };
  }
  function change(f, text, pos) {
    const top = f.undo.at(-1);
    if (text !== f.text && (!top || top.text !== f.text)) f.undo.push({
      text: f.text,
      pos: f.pos
    });
    if (f.undo.length > 200) f.undo.shift();
    f.text = text;
    f.pos = Math.max(0, Math.min(text.length, pos));
    f.mark = null;
    return f;
  }
  function kill(f, a, b, was) {
    if (a === b) return f;
    const text = f.text.slice(a, b);
    if (was === "kill" && f.ring.length) {
      f.ring[f.ring.length - 1] = a < f.pos ? text + f.ring.at(-1) : f.ring.at(-1) + text;
    } else f.ring.push(text);
    if (f.ring.length > 60) f.ring.shift();
    f.last = "kill";
    return change(f, f.text.slice(0, a) + f.text.slice(b), a);
  }
  function selection(f) {
    if (f.mark === null || f.mark === void 0 || f.mark === f.pos) return null;
    return f.mark < f.pos ? [
      f.mark,
      f.pos
    ] : [
      f.pos,
      f.mark
    ];
  }
  function insert(field, text) {
    const f = whole3(field);
    const sel = selection(f);
    const [a, b] = sel ?? [
      f.pos,
      f.pos
    ];
    f.goal = null;
    return change(f, f.text.slice(0, a) + text + f.text.slice(b), a + text.length);
  }
  function key2(field, k, o = {}) {
    const f = whole3(field);
    const was = field.last ?? "";
    const t = f.text, p = f.pos;
    let c = normal(k);
    const shifted = /(^|-)S-/.test(c);
    const bare = c.replace(/(^|-)S-/, "$1");
    const MOVES = [
      "left",
      "right",
      "up",
      "down",
      "home",
      "end",
      "A-left",
      "A-right",
      "C-left",
      "C-right",
      "s-left",
      "s-right",
      "s-up",
      "s-down",
      "C-a",
      "C-e",
      "C-b",
      "C-f",
      "A-b",
      "A-f",
      "C-p",
      "C-n"
    ];
    if (shifted && MOVES.includes(bare)) c = bare;
    const move = (to, vertical2 = false) => {
      if (shifted && o.select) f.mark = f.mark ?? p;
      else f.mark = null;
      if (!vertical2) f.goal = null;
      f.pos = Math.max(0, Math.min(t.length, to));
      return f;
    };
    const vertical = (dir) => {
      if (!o.lines) return null;
      const s = lineStart(t, p), col = f.goal ?? p - s;
      f.goal = col;
      if (dir < 0) {
        if (s === 0) return move(0, true);
        const ps = lineStart(t, s - 1);
        return move(Math.min(ps + col, s - 1), true);
      }
      const e = lineEnd(t, p);
      if (e >= t.length) return move(t.length, true);
      return move(Math.min(e + 1 + col, lineEnd(t, e + 1)), true);
    };
    const sel = selection(f);
    if (sel && o.select && [
      "backspace",
      "delete",
      "C-d",
      "C-h"
    ].includes(c)) {
      return change(f, t.slice(0, sel[0]) + t.slice(sel[1]), sel[0]);
    }
    switch (c) {
      case "C-a":
      case "home":
      case "s-left":
        return move(o.lines ? lineStart(t, p) : 0);
      case "C-e":
      case "end":
      case "s-right":
        return move(o.lines ? lineEnd(t, p) : t.length);
      case "C-b":
      case "left":
        return move(sel && !shifted && o.select ? sel[0] : p - 1);
      case "C-f":
      case "right":
        return move(sel && !shifted && o.select ? sel[1] : p + 1);
      case "A-b":
      case "A-left":
      case "C-left":
        return move(wordBack(t, p));
      case "A-f":
      case "A-right":
      case "C-right":
        return move(wordOn(t, p));
      case "C-p":
      case "up":
        return vertical(-1);
      case "C-n":
      case "down":
        return vertical(1);
      case "s-up":
        return move(0);
      case "s-down":
        return move(t.length);
      case "backspace":
      case "C-h":
        return p > 0 ? change(f, t.slice(0, p - 1) + t.slice(p), p - 1) : f;
      case "delete":
      case "C-d":
        return p < t.length ? change(f, t.slice(0, p) + t.slice(p + 1), p) : f;
      case "A-d":
        return kill(f, p, wordOn(t, p), was);
      case "A-backspace":
        return kill(f, wordBack(t, p), p, was);
      case "C-w": {
        let i = p;
        while (i > 0 && t[i - 1] === " ") i--;
        while (i > 0 && t[i - 1] !== " " && !(o.lines && t[i - 1] === "\n")) i--;
        return kill(f, i, p, was);
      }
      case "C-k": {
        const e = o.lines ? lineEnd(t, p) : t.length;
        return kill(f, p, e === p && e < t.length ? e + 1 : e, was);
      }
      case "C-u":
      case "s-backspace":
        return kill(f, o.lines ? lineStart(t, p) : 0, p, was);
      case "C-y": {
        if (!f.ring.length) return f;
        const text = f.ring.at(-1);
        const out = change(f, t.slice(0, p) + text + t.slice(p), p + text.length);
        out.yank = {
          i: f.ring.length - 1,
          at: p,
          length: text.length
        };
        out.last = "yank";
        return out;
      }
      case "A-y": {
        if (!f.ring.length || was !== "yank" || !f.yank) return f;
        const i = (f.yank.i - 1 + f.ring.length) % f.ring.length, text = f.ring[i], at = f.yank.at;
        const out = change(f, t.slice(0, at) + text + t.slice(at + f.yank.length), at + text.length);
        out.yank = {
          i,
          at,
          length: text.length
        };
        out.last = "yank";
        return out;
      }
      case "C-t": {
        if (t.length < 2 || p === 0) return f;
        const q = p === t.length ? p - 1 : p;
        return change(f, t.slice(0, q - 1) + t[q] + t[q - 1] + t.slice(q + 1), q + 1);
      }
      case "A-t": {
        let e2 = wordOn(t, p);
        if (e2 === p) {
          e2 = wordBack(t, t.length) === t.length ? t.length : wordOn(t, wordBack(t, t.length));
        }
        const s2 = wordBack(t, e2), s1 = wordBack(t, s2), e1 = wordOn(t, s1);
        if (s1 === s2 || e1 > s2) return f;
        return change(f, t.slice(0, s1) + t.slice(s2, e2) + t.slice(e1, s2) + t.slice(s1, e1) + t.slice(e2), e2);
      }
      case "A-u":
      case "A-l":
      case "A-c": {
        let a = p;
        while (a < t.length && !isWord(t[a])) a++;
        const b = wordOn(t, a);
        if (a === b) return f;
        const w = t.slice(a, b);
        const to = c === "A-u" ? w.toUpperCase() : c === "A-l" ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase();
        return change(f, t.slice(0, a) + to + t.slice(b), b);
      }
      case "C-_":
      case "C-slash":
      case "C-S-minus": {
        const top = f.undo.pop();
        if (!top) return f;
        Object.assign(f, {
          text: top.text,
          pos: Math.min(top.pos, top.text.length),
          mark: null,
          goal: null
        });
        return f;
      }
      case "A-r": {
        if (!f.undo.length) return f;
        Object.assign(f, {
          text: f.undo[0].text,
          pos: f.undo[0].text.length,
          undo: [],
          mark: null,
          goal: null
        });
        return f;
      }
      case "A-backslash": {
        let a = p, b = p;
        while (a > 0 && t[a - 1] === " ") a--;
        while (b < t.length && t[b] === " ") b++;
        return a === b ? f : change(f, t.slice(0, a) + t.slice(b), a);
      }
      case "s-a":
        return Object.assign(f, {
          mark: 0,
          pos: t.length,
          goal: null
        });
      case "s-c":
      case "s-x": {
        if (!o.api) return null;
        if (!sel) return f;
        o.api.write(CLIP, whole({
          text: t.slice(sel[0], sel[1])
        }));
        return c === "s-x" ? change(f, t.slice(0, sel[0]) + t.slice(sel[1]), sel[0]) : f;
      }
      case "s-v": {
        if (!o.api) return null;
        let text = val(o.api, CLIP)?.text;
        if (typeof text !== "string") return f;
        text = text.replace(/\r\n?/g, "\n");
        if (!o.lines) text = text.trim().replace(/\s*\n\s*/g, " ");
        return insert(f, text);
      }
    }
    return null;
  }
  function type(field, r, o = {}) {
    if (r.event === "commit") {
      if (!r.replace) return insert(field, r.text ?? "");
      const f = whole3(field);
      const n = Math.max(0, r.replace[1] - r.replace[0]);
      return change(f, f.text.slice(0, Math.max(0, f.pos - n)) + (r.text ?? "") + f.text.slice(f.pos), Math.max(0, f.pos - n) + (r.text ?? "").length);
    }
    if (!r.down) return null;
    const c = chord(r);
    const typing = r.text && !/[\x00-\x1f\x7f\uf700-\uf8ff]/.test(r.text) && !/(^|-)[MCAs]-/.test(c) && r.key !== "Enter" && r.key !== "Tab";
    if (typing) return insert(field, r.text);
    return key2(field, c, o);
  }

  // playground/experimental_os/newos/js/views.ts
  var encoder2 = null;
  var bytes = (t) => (encoder2 ??= new TextEncoder()).encode(t);
  function order(a, b) {
    const x = bytes(a), y = bytes(b);
    if (x.length !== y.length) return x.length - y.length;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  var ADDRESSY = [
    "owner",
    "node",
    "address",
    "at",
    "path",
    "line",
    "call",
    "ctl",
    "launch",
    "to",
    "program",
    "start",
    "cursor"
  ];
  var BUILT = [
    "picture"
  ];
  var proto = (v) => Object.getPrototypeOf(v);
  var names = (v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "string");
  var isAddress = (v, key3) => names(v) && (v[0] === "/" || ADDRESSY.includes(String(key3)) && !v.some((n) => n.includes(" ")));
  var typedKind = (v) => v.constructor.name.replace(/Array$/, "").replace(/^Big/, "").toLowerCase();
  var addressOf = (v) => typeof v === "string" ? [
    "/",
    ...v.split("/").filter((n) => n)
  ] : v[0] === "/" ? v : [
    "/",
    ...v
  ];
  var shown2 = (a) => "/" + a.filter((n) => n !== "/").join("/");
  var short = (pid) => {
    const p = pid;
    return typeof p === "string" && p.length > 9 && p.startsWith("@") ? "@\u2026" + p.slice(-6) : String(p);
  };
  var isColour = (v, key3, ctx) => Number.isInteger(v) && v >= 0 && v <= 16777215 && (/colou?r|paper|ink|line|chrome|desk|grain|^bg$|^fg$|fill|^hi$|^lo$|select|lemon|cherry|rose|mint|lilac|sky|teal|peach|butter|riso|acme|^tag$|check|mark|swatch/i.test(String(key3 ?? "")) || ctx === "colors");
  var hex = (v, n = 6) => v.toString(16).padStart(n, "0");
  var mix2 = (a, b, t) => [
    16,
    8,
    0
  ].reduce((c, k) => c | Math.round((a >> k & 255) * (1 - t) + (b >> k & 255) * t) << k, 0);
  var bytesOf2 = (v) => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  var utf8 = (b) => {
    for (let i = 0; i < b.length; ) {
      const c = b[i], n = c < 128 ? 0 : c >= 194 && c < 224 ? 1 : c >= 224 && c < 240 ? 2 : c >= 240 && c < 245 ? 3 : -1;
      if (n < 0 || i + n >= b.length + (n ? 0 : 1)) return null;
      for (let k = 1; k <= n; k++) if ((b[i + k] & 192) !== 128) return null;
      if (c === 0) return null;
      i += n + 1;
    }
    return new TextDecoder().decode(b);
  };
  var size = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  var escaped = (t, max = 400) => {
    let out = "";
    for (const ch of t.slice(0, max)) {
      const c = ch.codePointAt(0);
      out += ch === "\n" ? "\u23CE" : ch === "	" ? "\u2192" : c < 32 || c === 127 ? `\\x${hex(c, 2)}` : c === 160 ? "\u237D" : ch;
    }
    return out + (t.length > max ? "\u2026" : "");
  };
  var clock = (t) => {
    if (typeof t !== "number" || t < 1e15) return String(t);
    const d = new Date(t / 1e3);
    const p = (n, k = 2) => String(n).padStart(k, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  var who = (c, pids = {}) => {
    if (!c) return null;
    const actor = typeof c.actor === "string" ? c.actor : typeof c.actor?.actor === "string" ? c.actor.actor : null;
    if (typeof c.reader === "string") {
      return [
        actor,
        pids[c.reader] ?? short(c.reader)
      ].filter((x) => x && x !== "machine").join(" via ") || "machine";
    }
    if (actor) return actor;
    return "host";
  };
  var site = (s) => s && typeof s.file === "string" ? `${s.file}${s.line != null ? ":" + s.line : ""}` : null;
  var when = (c) => typeof c?.time !== "number" && c?.lamport !== void 0 ? `#${c.lamport}` : clock(c?.time);
  var head = (v, o = {}) => {
    const c = v?.change;
    if (!c) return "no change: the root's first value";
    return [
      when(c),
      who(c, o.pids),
      site(c.site)
    ].filter(Boolean).join(" \xB7 ");
  };
  var ids = (api) => {
    const pids = {};
    const dir = (a) => {
      try {
        return api.children(a).map((n) => [
          n,
          api.children(a, n)
        ]);
      } catch {
        return [];
      }
    };
    for (const [n, items] of dir([
      "/",
      "programs"
    ])) for (const i of items) if (i.id) pids[i.id] = n;
    for (const [n, items] of dir([
      "/",
      "drivers"
    ])) for (const i of items) if (i.id) pids[i.id] = n;
    for (const [app] of dir([
      "/",
      "apps"
    ])) {
      for (const [, items] of dir([
        "/",
        "apps",
        app
      ])) {
        for (const i of items) if (i.id?.startsWith("@")) pids[i.id] = app;
      }
    }
    try {
      for (const n of api.children([
        "/",
        "dev"
      ])) {
        for (const i of api.children([
          "/",
          "dev",
          n
        ], "driver")) {
          if (i.id) pids[i.id] = n;
        }
      }
    } catch {
    }
    for (const [n] of dir([
      "/",
      "dev",
      "wm",
      "client"
    ])) {
      try {
        const v = val(api, [
          "/",
          "dev",
          "wm",
          "client",
          n
        ]);
        const start = v?.start ?? {}, program = Array.isArray(start.program) ? start.program.at(-1) : typeof start.program === "string" ? start.program.split("/").at(-1) : null;
        if (v?.pid) {
          pids[v.pid] = typeof start.name === "string" && !start.name.startsWith("@") ? start.name : program ?? n;
        }
      } catch {
      }
    }
    return {
      pids
    };
  };
  var did = (c) => {
    if (c?.kind === "write") {
      const one = (p) => {
        const path = (p.path ?? []).join(".");
        if (!(p.path ?? []).length && !p.range) return p.value === void 0 ? "removed" : "whole";
        return `${p.range ? "splice" : p.value === void 0 ? "remove" : "set"} ${path}`;
      };
      return (c.patches ?? []).map(one).join(", ") || "write";
    }
    return `${c?.kind ?? "?"}${c?.name !== void 0 ? " " + c.name : ""}`;
  };
  var itemOf = (c) => ({
    change: {
      time: c?.time,
      lamport: c?.lamport,
      reader: c?.reader,
      actor: c?.actor,
      site: c?.site
    }
  });
  var changes = (h, key3 = []) => {
    const cs = Array.isArray(h?.changes) ? h.changes : [];
    const at = (v, k) => k.reduce((x, n) => x === null || x === void 0 ? void 0 : x[n], v);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const on = (p) => {
      const path = p.path ?? [];
      return path.every((n, i) => i >= key3.length || String(n) === String(key3[i])) || key3.every((n, i) => String(n) === String(path[i]));
    };
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], prev = i ? cs[i - 1] : null;
      if (key3.length && c.kind !== "write") continue;
      if (key3.length && "value" in c && (!prev || "value" in prev)) {
        if (same(at(c.value, key3), prev ? at(prev.value, key3) : void 0)) continue;
      } else if (key3.length && !(c.patches ?? []).some(on)) continue;
      out.push(c);
    }
    return out.reverse();
  };
  var away = (address) => {
    let doc = null, dir = null, docs = [], marked = /* @__PURE__ */ new Set();
    const leave = (api) => {
      if (dir === null || !doc) return;
      const seen = {
        ...doc.seen ?? {}
      };
      for (const d of docs) seen[d.id] = d.stamp;
      const next = {
        seen,
        dirs: {
          ...doc.dirs ?? {},
          [dir]: true
        }
      };
      if (JSON.stringify(next) === JSON.stringify(doc)) return;
      try {
        if (!idAt(api, address.slice(0, -1))) {
          make(api, address.slice(0, -2), address.at(-2), null);
        }
        snap(api, address, next);
        doc = next;
      } catch {
      }
    };
    return {
      at(api, path, now) {
        if (!doc) doc = val(api, address) ?? {
          seen: {},
          dirs: {}
        };
        const k = "/" + path.join("/");
        if (k !== dir) {
          leave(api);
          const was = doc.seen ?? {};
          marked = new Set(doc.dirs?.[k] ? now.filter((d) => was[d.id] === void 0 || d.stamp > was[d.id]).map((d) => d.id) : []);
          dir = k;
        }
        docs = now;
        return marked;
      },
      leave
    };
  };
  var ops = (list) => {
    const n = {};
    for (const o of list) n[o?.op] = (n[o?.op] ?? 0) + 1;
    return `${list.length} ops \xB7 ` + Object.entries(n).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(" \xB7 ");
  };
  var liveName = (v) => v?.constructor?.name === "Stand" ? String(v.kind ?? "") : String(v);
  var isOps = (v) => Array.isArray(v) && v.length > 0 && v.every((o) => o && typeof o === "object" && typeof o.op === "string");
  var isPixels = (v, w, h) => v instanceof Uint32Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w * h <= v.length;
  function make2(blit, style) {
    const u = style.u ?? 1;
    const C = style.colours;
    let F, FT, FX;
    let registered = {};
    const fonts = (f) => {
      F = f.text ?? void 0;
      FT = f.title ?? void 0;
      FX = f.fixed ?? void 0;
    };
    const kinds = (m) => {
      registered = m && typeof m === "object" && !Array.isArray(m) ? m : {};
    };
    const role = (r) => r === "text" ? F : r === "title" ? FT : r === "fixed" ? FX : void 0;
    const viewOf = (v) => v && typeof v.kind === "string" && !BUILT.includes(v.kind) && registered[v.kind] && typeof registered[v.kind] === "object" ? registered[v.kind] : null;
    const kind = (v, key3, _ctx, o = {}) => {
      if (v === void 0) return "none";
      if (v === null) return "null";
      if (typeof v === "boolean") return "bool";
      if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? "int" : "float";
      if (typeof v === "string") {
        return /^@\d{10,}(-\d+)?$/.test(v) ? "id" : key3 === "program" && /^[^/ ]+(\/[^/ ]+)+$/.test(v) ? "address" : "string";
      }
      if (typeof v === "function") return "fn";
      if (v instanceof Uint8Array) return "bytes";
      if (ArrayBuffer.isView(v)) return v instanceof DataView ? "bytes" : "typed";
      if (Array.isArray(v)) return isAddress(v, key3) ? "address" : "list";
      if (typeof v === "object") {
        if (proto(v) !== Object.prototype && proto(v) !== null) return "live";
        if (v.kind === "picture" && Array.isArray(v.rows)) return "picture";
        if (o.play && viewOf(v)) return "view";
        return "map";
      }
      return "live";
    };
    const number = (v, key3, ctx) => {
      if (Number.isNaN(v)) return "NaN";
      if (Object.is(v, -0)) return "-0";
      if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
      if (Number.isInteger(v) && (style.hex || isColour(v, key3, ctx)) && v >= 0) {
        return "0x" + hex(v, isColour(v, key3, ctx) ? 6 : 1);
      }
      return String(v);
    };
    const badge = (v, k) => {
      switch (k) {
        case "string":
          return `str ${v.length}`;
        case "int":
          return "int";
        case "float":
          return "num";
        case "bool":
          return "bool";
        case "null":
          return "null";
        case "none":
          return "\u2014";
        case "list":
          return `list ${v.length}`;
        case "map":
          return `map ${Object.keys(v).length}`;
        case "bytes":
          return `bytes ${v.byteLength}`;
        case "typed":
          return `${typedKind(v).replace("uint", "u").replace("int", "i").replace("float", "f")}\xD7${v.length}`;
        case "picture":
          return "picture";
        case "address":
          return "addr";
        case "id":
          return "id";
        case "fn":
          return "fn";
        case "view":
          return String(viewOf(v)?.label ?? v.kind);
        default:
          return "live";
      }
    };
    const brief = (x) => {
      const k = kind(x);
      return k === "string" ? JSON.stringify(x.length > 16 ? x.slice(0, 16) + "\u2026" : x) : k === "int" || k === "float" ? number(x) : k === "bool" || k === "null" ? String(x) : k === "address" ? shown2(addressOf(x)) : `\u2039${badge(x, k)}\u203A`;
    };
    const pieces = (v, k, key3, ctx, o = {}) => {
      switch (k) {
        case "string":
          return [
            [
              '"',
              C.dim
            ],
            [
              escaped(v, 120),
              C.ink
            ],
            [
              '"',
              C.dim
            ]
          ];
        case "int":
        case "float":
          return isColour(v, key3, ctx) ? [
            [
              "",
              C.ink,
              v
            ],
            [
              "#" + hex(v).toUpperCase(),
              C.blue
            ]
          ] : [
            [
              number(v, key3, ctx),
              C.blue
            ]
          ];
        case "bool":
          return [
            [
              String(v),
              v ? C.mint : C.cherry
            ]
          ];
        case "null":
          return [
            [
              "null",
              C.dim
            ]
          ];
        case "none":
          return [
            [
              "nothing",
              C.dim
            ]
          ];
        case "list":
          if (o.play && isOps(v)) return [
            [
              ops(v),
              C.ink2
            ]
          ];
          return [
            [
              "[",
              C.dim
            ],
            [
              v.slice(0, 6).map((x) => brief(x)).join(", ") + (v.length > 6 ? ", \u2026" : ""),
              C.ink2
            ],
            [
              "]",
              C.dim
            ]
          ];
        case "map": {
          const ks = Object.keys(v).sort(order);
          return [
            [
              "{",
              C.dim
            ],
            [
              ks.slice(0, 8).join(" ") + (ks.length > 8 ? " \u2026" : ""),
              C.ink2
            ],
            [
              "}",
              C.dim
            ]
          ];
        }
        case "bytes": {
          const b = bytesOf2(v), t = utf8(b);
          return t !== null && b.length ? [
            [
              "utf-8 ",
              C.dim
            ],
            [
              '"' + escaped(t, 80) + '"',
              C.lilac
            ]
          ] : [
            [
              [
                ...b.slice(0, 16)
              ].map((x) => hex(x, 2)).join(" ") + (b.length > 16 ? " \u2026" : ""),
              C.lilac
            ]
          ];
        }
        case "typed": {
          const xs = [
            ...v.slice(0, 8)
          ].map((x) => typeof x === "bigint" ? String(x) : number(Number(x)));
          return [
            [
              xs.join(" ") + (v.length > 8 ? " \u2026" : ""),
              C.teal
            ]
          ];
        }
        case "picture":
          return [
            [
              `${v.rows[0]?.length ?? 0}\xD7${v.rows.length}`,
              C.ink2
            ],
            ...Object.values(v.colors ?? {}).slice(0, 8).map((c) => [
              "",
              C.ink,
              c
            ]),
            [
              v.tile ? " tile" : "",
              C.dim
            ]
          ];
        case "address":
          return [
            [
              shown2(addressOf(v)),
              C.rose
            ]
          ];
        case "id":
          return [
            [
              v.slice(0, 22) + "\u2026",
              C.lilac
            ]
          ];
        case "fn":
          return [
            [
              "a function, the process's",
              C.dim
            ]
          ];
        case "view": {
          const view = viewOf(v);
          const ks = Array.isArray(view.line) ? view.line.filter((x) => x in v) : Object.keys(v).filter((x) => x !== "kind").sort(order);
          const out = [];
          for (const x of ks.slice(0, 6)) {
            if (out.length) out.push([
              "  ",
              C.dim
            ]);
            const xk = kind(v[x], x);
            out.push(...xk === "string" ? [
              [
                escaped(v[x], 80),
                C.ink
              ]
            ] : pieces(v[x], xk, x, v, o));
          }
          return out.length ? out : [
            [
              "{}",
              C.dim
            ]
          ];
        }
        default:
          return [
            [
              `live ${liveName(v)}`.trim(),
              C.lilac
            ]
          ];
      }
    };
    const fitted = (text2, w, font) => {
      const n = blit.fit(text2, w, font);
      return n >= text2.length ? text2 : text2.slice(0, Math.max(0, n - 1)) + "\u2026";
    };
    const swatch = (f, x, y, c, sz) => {
      blit.fill(f, x, y, sz, sz, C.line);
      blit.fill(f, x + u, y + u, sz - 2 * u, sz - 2 * u, c);
      return x + sz + 3 * u;
    };
    const text = (f, x, y, ps, clip, font = FX) => {
      for (const [t, c, sw] of ps) {
        if (x >= clip.x + clip.w) break;
        if (sw !== void 0) {
          const sz = blit.height(font) - 2 * u;
          if (x + sz < clip.x + clip.w) x = f ? swatch(f, x, y + u, sw, sz) : x + sz + 3 * u;
        }
        if (t) x = f ? blit.text(f, x, y, t, c, void 0, clip, font) : x + blit.measure(t, font);
      }
      return x;
    };
    const tag = (f, x, y, t, fg, bg, line) => {
      const pill = C.tag !== void 0 && bg === void 0 && line === void 0;
      const pad = pill ? 6 * u : 3 * u, w = blit.measure(t, FX) + 2 * pad, h = blit.height(FX);
      if (!f) return x + w + 4 * u;
      if (pill) {
        const r = Math.floor((h - 1) / 2), ring = mix2(C.tag, C.ink, 0.12);
        for (const [c, d] of [
          [
            ring,
            0
          ],
          [
            C.tag,
            u
          ]
        ]) {
          blit.fill(f, x + r, y + d, w - 2 * r, h - 2 * d, c);
          blit.fillellipse(f, x + r, y + r, r - d, r - d, c);
          blit.fillellipse(f, x + w - r - 1, y + r, r - d, r - d, c);
        }
      } else {
        if (bg !== void 0) blit.fill(f, x, y, w, h, bg);
        for (let i = 0; i < u; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, line ?? C.lo);
      }
      blit.text(f, x + pad, y, t, fg, void 0, void 0, FX);
      return x + w + 4 * u;
    };
    const summary = (f, x, y, v, o = {}) => {
      const k = o.kind ?? kind(v, o.key, o.ctx, o);
      const clip = o.clip ?? {
        x,
        y,
        w: 1 << 20,
        h: 1 << 20
      };
      const b = badge(v, k);
      x = k === "fn" ? tag(f, x, y, "fn", C.paper, C.line, C.line) : k === "live" ? tag(f, x, y, b, C.lilac, void 0, C.lilac) : tag(f, x, y, b, C.ink2);
      if (o.play && k === "null") return x;
      if (o.play && k === "picture" && v.rows.length) {
        const h = blit.height(FX), sc = Math.max(1, Math.floor(h / v.rows.length));
        const form = drawn(v, sc);
        if (f && x + form.w < clip.x + clip.w) {
          blit.blit(f, x, y + Math.max(0, Math.floor((h - form.h) / 2)), form, 0, 0, form.w, Math.min(form.h, h));
        }
        x += form.w + 4 * u;
      }
      return text(f, x, y, pieces(v, k, o.key, o.ctx, o), clip);
    };
    const about = (v, k, o = {}) => {
      switch (k) {
        case "string": {
          const lines = v.split("\n").length;
          return `string \xB7 ${v.length} characters \xB7 ${lines} ${lines === 1 ? "line" : "lines"} \xB7 ${bytes(v).length} bytes of UTF-8`;
        }
        case "int":
          return `whole number${isColour(v, o.key ?? o.name, o.ctx) ? " \xB7 a colour, 0xRRGGBB" : ""}`;
        case "float":
          return Number.isNaN(v) ? "NaN: not a number" : Number.isFinite(v) ? "number, binary64" : "an infinity";
        case "bool":
          return "boolean";
        case "null":
          return "null: nothing, or a folder";
        case "none":
          return o.pending ? "pending: its node is not here yet" : "no value";
        case "list":
          return `list \xB7 ${v.length} items`;
        case "map":
          return `map \xB7 ${Object.keys(v).length} ${Object.keys(v).length === 1 ? "key" : "keys"}, sorted as the graph sorts them`;
        case "bytes":
          return `bytes \xB7 ${v.byteLength}`;
        case "typed":
          return `typed array \xB7 ${typedKind(v)} \xD7 ${v.length} \xB7 ${size(v.byteLength)}`;
        case "picture":
          return `picture \xB7 ${v.rows[0]?.length ?? 0} \xD7 ${v.rows.length} \xB7 ${Object.keys(v.colors ?? {}).length} colours${v.tile ? " \xB7 a tile" : ""}${v.hot ? ` \xB7 hot ${v.hot.join(",")}` : ""}`;
        case "address":
          return "an address: f or Enter follows it";
        case "id":
          return "an id: a node's own, wherever it is placed";
        case "fn":
          return "a function: its process holds it, the scheduler calls it (the shell's call)";
        case "proc":
          return "a process: its node holds a run";
        case "view":
          return `${v.kind} \xB7 ${Object.keys(v).length} keys \xB7 its view in /etc/views`;
        default:
          return `a live value: its host holds it, the graph never looks inside${liveName(v) ? " \xB7 " + liveName(v) : ""}`;
      }
    };
    const blocks = (f, w) => {
      const cw = Math.max(1, blit.measure("m", FX));
      const B = {
        f,
        w,
        cols: Math.max(8, Math.floor(w / cw)),
        pad: 10 * u,
        items: [],
        zones: [],
        push: (h, draw2) => B.items.push({
          h,
          draw: draw2
        }),
        line: (ps, font = FX) => B.items.push({
          h: blit.height(font) + u,
          draw: (x, y, clip) => text(f, x, y, ps, clip, font)
        }),
        gap: (h = 6 * u) => B.items.push({
          h,
          draw: () => {
          }
        }),
        rule: () => B.items.push({
          h: 7 * u,
          draw: (x, y) => blit.fill(f, x, y + 3 * u, w, u, C.lo)
        }),
        // cut to the width, as a fixed font's columns
        text: (t, c = C.ink, font = FX) => {
          for (let i = 0; i < Math.max(1, t.length); i += B.cols) {
            B.line([
              [
                t.slice(i, i + B.cols),
                c
              ]
            ], font);
          }
        }
      };
      return B;
    };
    const lay = (B, R, scroll) => {
      const total = B.items.reduce((n, b) => n + b.h, 0);
      if (scroll > Math.max(0, total - R.h + 12 * u)) scroll = Math.max(0, total - R.h + 12 * u);
      let y = R.y + 6 * u - scroll;
      for (const b of B.items) {
        if (y + b.h > R.y && y < R.y + R.h) b.draw(R.x + B.pad, y, R);
        y += b.h;
      }
      return scroll;
    };
    const drawn = (v, sc) => {
      const pw = Math.max(0, ...v.rows.map((x) => x.length)), ph = v.rows.length;
      const fw = Math.max(1, pw * sc), fh = Math.max(1, ph * sc);
      const form = blit.form(fw, fh);
      const n = Math.max(1, Math.floor(sc / 2));
      for (let j = 0; j < fh; j++) {
        const rowText = v.rows[Math.floor(j / sc)] ?? "";
        for (let i = 0; i < fw; i++) {
          const c = v.colors?.[rowText[Math.floor(i / sc)]];
          form.bits[j * fw + i] = typeof c === "number" ? c : Math.floor(i / n) + Math.floor(j / n) & 1 ? C.check : C.hi;
        }
      }
      return form;
    };
    const picture = (B, v) => {
      const { f, w } = B;
      const pw = Math.max(0, ...v.rows.map((x) => x.length)), ph = v.rows.length;
      const sc = Math.max(1, Math.min(12 * u, Math.floor(Math.min(w, 280 * u) / Math.max(1, pw)), Math.floor(220 * u / Math.max(1, ph))));
      const fw = Math.max(1, pw * sc), fh = Math.max(1, ph * sc);
      B.push(fh + 10 * u, (x, y) => {
        const form = drawn(v, sc);
        blit.fill(f, x - u, y - u, fw + 2 * u, fh + 2 * u, C.line);
        blit.blit(f, x, y, form);
        if (Array.isArray(v.hot)) {
          const hx = x + v.hot[0] * sc, hy = y + v.hot[1] * sc;
          for (let i = 0; i < u; i++) {
            blit.frame(f, hx - u + i, hy - u + i, sc + 2 * u - 2 * i, sc + 2 * u - 2 * i, C.cherry);
          }
        }
      });
    };
    const pixels = (B, v, pw, ph, stride) => {
      const { f, w } = B;
      const sc = Math.max(1, Math.min(8 * u, Math.floor(Math.min(w, 260 * u) / pw), Math.floor(200 * u / ph)));
      const fw = Math.min(pw * sc, w), fh = Math.min(ph * sc, 240 * u);
      const alpha = v.some((x) => x >>> 24 === 255 && x & 16777215) && v.every((x) => x === 0 || x >>> 24 !== 0);
      B.push(fh + 8 * u, (x, y) => {
        const form = blit.form(fw, fh);
        for (let j = 0; j < fh; j++) {
          for (let i = 0; i < fw; i++) {
            const px = v[Math.floor(j / sc) * stride + Math.floor(i / sc)];
            form.bits[j * fw + i] = px === void 0 ? C.check : (alpha ? px >>> 24 < 128 : px & 2147483648) ? (i >> 2) + (j >> 2) & 1 ? C.check : C.hi : px & 16777215;
          }
        }
        blit.fill(f, x - u, y - u, fw + 2 * u, fh + 2 * u, C.line);
        blit.blit(f, x, y, form);
      });
      B.text(`${pw} \xD7 ${ph} pixels${sc > 1 ? `, ${sc}\xD7 ` : ""}`, C.dim);
    };
    let last = null;
    const played = (B, list, lw, lh) => {
      const { f, w } = B;
      if (!(lw > 0 && lh > 0) || lw * lh > 1 << 23) return;
      const sc = Math.min(1, Math.min(w, 520 * u) / lw, 320 * u / lh);
      const fw = Math.max(1, Math.round(lw * sc)), fh = Math.max(1, Math.round(lh * sc));
      B.push(fh + 8 * u, (x, y) => {
        if (last?.list !== list || last.fw !== fw || last.fh !== fh) {
          const whole4 = blit.form(lw, lh, C.check);
          try {
            blit.play(whole4, list, role);
          } catch {
          }
          const form = blit.form(fw, fh);
          for (let j = 0; j < fh; j++) {
            for (let i = 0; i < fw; i++) {
              form.bits[j * fw + i] = whole4.bits[Math.floor(j / sc) * lw + Math.floor(i / sc)] & 16777215;
            }
          }
          last = {
            list,
            fw,
            fh,
            form
          };
        }
        blit.fill(f, x - u, y - u, fw + 2 * u, fh + 2 * u, C.line);
        blit.blit(f, x, y, last.form);
      });
      B.text(`${lw} \xD7 ${lh}, played${sc < 1 ? ` at ${Math.round(sc * 100)}%` : ""} \xB7 ${ops(list)}`, C.dim);
    };
    const body = (B, v, k, o = {}) => {
      const { line, gap, text: say2, f, w, cols } = B;
      const push = B.push;
      const LH = blit.height(FX) + u;
      const key3 = o.key ?? o.name;
      switch (k) {
        case "string": {
          const ls = v.split("\n");
          ls.slice(0, 400).forEach((l, i) => {
            const ps = [];
            const trail = l.length - l.trimEnd().length;
            let run2 = "";
            const flush = () => {
              if (run2) ps.push([
                run2,
                C.ink
              ]);
              run2 = "";
            };
            [
              ...l.slice(0, l.length - trail)
            ].forEach((ch) => {
              const c = ch.codePointAt(0);
              const odd = c < 32 || c === 127 || c === 160 || c >= 8203 && c <= 8207 || c === 65279;
              if (ch !== "	" && !odd) return void (run2 += ch);
              flush();
              ps.push(ch === "	" ? [
                "\u2192",
                C.dim
              ] : [
                c === 160 ? "\u237D" : `\\u${hex(c, 4)}`,
                C.cherry
              ]);
            });
            flush();
            if (trail) ps.push([
              "\xB7".repeat(trail),
              C.dim
            ]);
            if (i < ls.length - 1) ps.push([
              "\xB6",
              C.lo
            ]);
            let row = [], n = 0;
            for (const [t, c] of ps) {
              let rest = t;
              while (rest.length) {
                const take = Math.max(0, cols - n);
                if (!take) {
                  line(row);
                  row = [];
                  n = 0;
                  continue;
                }
                row.push([
                  rest.slice(0, take),
                  c
                ]);
                n += Math.min(take, rest.length);
                rest = rest.slice(take);
              }
            }
            line(row.length ? row : [
              [
                "",
                C.ink
              ]
            ]);
          });
          if (ls.length > 400) say2(`\u2026 ${ls.length - 400} more lines`, C.dim);
          if (o.write) {
            gap();
            say2(v.includes("\n") ? "Enter or e opens it in the editor" : "Enter edits it in place", C.dim, F);
          }
          break;
        }
        case "int":
        case "float": {
          const colour = isColour(v, key3, o.ctx);
          push(blit.height(FT) * 2, (x, y, clip) => {
            let nx = x;
            if (colour) nx = swatch(f, x, y, v, blit.height(FT) * 2 - 4 * u) + 6 * u;
            blit.text(f, nx, y + Math.floor(blit.height(FT) / 2), colour ? "#" + hex(v).toUpperCase() : number(v, key3), C.blue, void 0, clip, FT);
          });
          if (Number.isInteger(v) && v >= 0) {
            say2(`decimal ${v}`, C.ink2);
            push(LH, (x, y) => {
              const end = blit.text(f, x, y, `hex 0x${hex(v, 1)}`, C.ink2, void 0, void 0, FX);
              const t = style.hex ? "[x] hex everywhere" : "[ ] hex everywhere";
              const e2 = blit.text(f, end + 16 * u, y, t, C.rose, void 0, void 0, FX);
              B.zones.push({
                x: end + 16 * u,
                y,
                w: e2 - end - 16 * u,
                h: LH,
                act: "hex",
                role: "checkbox",
                label: "hex everywhere"
              });
            });
            if (v < 2 ** 32) say2(`binary ${v.toString(2)}`, C.dim);
            if (colour) {
              say2(`red ${v >> 16 & 255} \xB7 green ${v >> 8 & 255} \xB7 blue ${v & 255}`, C.ink2);
            }
            if (v > 1e15 && v < 1e17) {
              say2(`as a time: ${new Date(v / 1e3).toISOString()}`, C.dim);
            }
          } else if (Number.isFinite(v)) {
            say2(`exactly ${v.toPrecision(17).replace(/\.?0+$/, "")}`, C.ink2);
          }
          if (o.write) {
            gap();
            say2("Enter edits it in place: a number, 0x\u2026 or #RRGGBB", C.dim, F);
          }
          break;
        }
        case "bool": {
          push(blit.height(FT) + 8 * u, (x, y) => {
            const b = blit.height(FT);
            blit.fill(f, x, y, b, b, C.line);
            blit.fill(f, x + u, y + u, b - 2 * u, b - 2 * u, C.hi);
            if (v) {
              blit.line(f, x + 2 * u, y + 2 * u, x + b - 3 * u, y + b - 3 * u, u, C.line);
              blit.line(f, x + b - 3 * u, y + 2 * u, x + 2 * u, y + b - 3 * u, u, C.line);
            }
            blit.text(f, x + b + 8 * u, y, String(v), v ? C.mint : C.cherry, void 0, void 0, FT);
            if (o.write) {
              B.zones.push({
                x,
                y,
                w: b + 60 * u,
                h: b,
                act: "toggle",
                role: "checkbox",
                label: String(v)
              });
            }
          });
          if (o.write) say2("a click, space or Enter turns it over", C.dim, F);
          break;
        }
        case "null":
        case "none":
          say2(k === "null" ? "null" : "\u2014", C.dim, FT);
          break;
        case "address": {
          const a = addressOf(v);
          push(blit.height(F) + 8 * u, (x, y) => {
            const end = blit.text(f, x, y, shown2(a), C.rose, void 0, {
              x,
              y,
              w,
              h: 40 * u
            }, F);
            blit.fill(f, x, y + blit.height(F), Math.min(end, x + w) - x, u, C.rose);
            B.zones.push({
              x,
              y,
              w: Math.min(end, x + w) - x,
              h: blit.height(F) + 2 * u,
              act: "follow",
              role: "link",
              label: shown2(a),
              address: a
            });
          });
          if (!o.api) break;
          let there;
          try {
            there = o.api.content(a).filter((i) => i.versions).map((i) => ({
              value: first(i.versions),
              change: i.versions[0]?.change,
              id: i.id
            }));
          } catch (e) {
            say2(o.why ? o.why(e) : String(e?.message ?? e), C.cherry);
            break;
          }
          if (!there.length) say2("nothing is there", C.cherry);
          else {
            const t = there[0], tk = kind(t.value);
            line([
              [
                "there: ",
                C.dim
              ],
              ...pieces(t.value, tk)
            ]);
            if (there.length > 1) say2(`${there.length} members`, C.dim);
          }
          break;
        }
        case "list":
        case "map": {
          if (o.play && k === "map" && isOps(v.draw)) played(B, v.draw, v.w, v.h);
          if (o.play && k === "list" && isOps(v) && o.parent) played(B, v, o.parent.w, o.parent.h);
          if (o.play && k === "map") {
            const px = Object.keys(v).find((x) => isPixels(v[x], v.w ?? v.cols, v.h ?? v.rows));
            if (px) pixels(B, v[px], v.w ?? v.cols, v.h ?? v.rows, v.stride ?? v.w ?? v.cols);
          }
          if (o.play && k === "list" && v.length && v.every((x) => typeof x === "string")) {
            const iw = String(v.length - 1).length;
            v.slice(0, 400).forEach((t, i) => {
              const row = [
                [
                  String(i).padStart(iw) + " ",
                  C.dim
                ],
                [
                  escaped(t, cols - iw - 1),
                  C.ink
                ]
              ];
              push(LH, (x, y, clip) => {
                text(f, x, y, row, clip);
                if (o.into) {
                  B.zones.push({
                    x,
                    y,
                    w,
                    h: LH,
                    act: "into",
                    key: i,
                    role: "button",
                    label: `[${i}]`
                  });
                }
              });
            });
            if (v.length > 400) say2(`\u2026 ${v.length - 400} more`, C.dim);
            break;
          }
          const ks = k === "list" ? v.map((_x, i) => i) : Object.keys(v).sort(order);
          const kw = Math.min(16, Math.max(3, ...ks.slice(0, 200).map((x) => String(x).length + (k === "list" ? 2 : 0))));
          for (const kk of ks.slice(0, 200)) {
            const x = v[kk], xk = kind(x, String(kk), void 0, o);
            const label = (k === "list" ? `[${kk}]` : String(kk)).padEnd(kw).slice(0, kw);
            const row = [
              [
                label + " ",
                k === "list" ? C.dim : C.ink
              ],
              ...pieces(x, xk, String(kk), o.key === "colors" || o.name === "colors" ? "colors" : void 0, o)
            ];
            if (!o.into) line(row);
            else {
              push(LH, (px, py, clip) => {
                text(f, px, py, row, clip);
                B.zones.push({
                  x: px,
                  y: py,
                  w,
                  h: LH,
                  act: "into",
                  key: kk,
                  role: "button",
                  label: String(kk)
                });
              });
            }
          }
          if (ks.length > 200) say2(`\u2026 ${ks.length - 200} more`, C.dim);
          if (o.name === "draw" && k === "list") {
            gap();
            say2(ops(v), C.ink2);
          }
          break;
        }
        case "bytes": {
          const b = bytesOf2(v), t = utf8(b);
          say2(t === null ? "not UTF-8" : `looks like UTF-8: ${[
            ...t
          ].length} characters`, t === null ? C.dim : C.mint, F);
          if (t !== null && b.length) {
            for (const l of t.slice(0, 2e3).split("\n").slice(0, 12)) {
              say2(escaped(l, 400), C.lilac);
            }
            gap();
          }
          const per = cols >= 70 ? 16 : 8;
          for (let at = 0; at < Math.min(b.length, 4096); at += per) {
            const row = [
              ...b.slice(at, at + per)
            ];
            const hx = row.map((x) => hex(x, 2)).join(" ").padEnd(per * 3 - 1);
            const as = row.map((x) => x >= 32 && x < 127 ? String.fromCharCode(x) : "\xB7").join("");
            line([
              [
                hex(at, 4) + "  ",
                C.dim
              ],
              [
                hx + "  ",
                C.ink
              ],
              [
                as,
                C.lilac
              ]
            ]);
          }
          if (b.length > 4096) say2(`\u2026 ${b.length - 4096} more bytes`, C.dim);
          break;
        }
        case "typed": {
          const xs = Array.from(v, (x) => Number(x));
          let lo = Infinity, hi = -Infinity, sum = 0;
          for (const x of xs) {
            if (x < lo) lo = x;
            if (x > hi) hi = x;
            sum += x;
          }
          if (xs.length) {
            say2(`min ${number(lo)} \xB7 max ${number(hi)} \xB7 mean ${number(+(sum / xs.length).toPrecision(6))}`, C.ink2);
          }
          const p = o.parent ?? o.ctx;
          const pw = p?.w ?? p?.cols, ph = p?.h ?? p?.rows;
          if (isPixels(v, pw, ph)) pixels(B, v, pw, ph, p.stride ?? pw);
          else if (xs.length > 1) {
            const n = Math.min(xs.length, Math.floor(w / (2 * u)));
            const hh = 40 * u;
            push(hh + 8 * u, (x, y) => {
              blit.fill(f, x, y + hh, n * 2 * u, u, C.lo);
              for (let i = 0; i < n; i++) {
                const a = Math.floor(i * xs.length / n), z = Math.max(a + 1, Math.floor((i + 1) * xs.length / n));
                let m = 0;
                for (let j = a; j < z; j++) m += xs[j];
                m /= z - a;
                const bh = hi > lo ? Math.max(u, Math.round((m - lo) / (hi - lo) * hh)) : u;
                blit.fill(f, x + i * 2 * u, y + hh - bh, u + (u > 1 ? u - 1 : 0), bh, C.teal);
              }
            });
          }
          const px = v instanceof Uint32Array && /pixels|bits|colou?rs/.test(String(key3));
          const per = Math.max(1, Math.floor(cols / 12));
          for (let i = 0; i < Math.min(xs.length, 512); i += per) {
            line([
              [
                `[${i}]`.padEnd(7),
                C.dim
              ],
              [
                Array.from(v.slice(i, i + per), (x) => typeof x === "bigint" ? String(x) : px ? hex(x, 8) : number(x)).map((t) => t.padStart(10)).join(" "),
                C.teal
              ]
            ]);
          }
          if (xs.length > 512) say2(`\u2026 ${xs.length - 512} more`, C.dim);
          break;
        }
        case "picture": {
          picture(B, v);
          for (const [letter, c] of Object.entries(v.colors ?? {}).sort((a, b) => order(a[0], b[0]))) {
            line([
              [
                `${letter}  `,
                C.ink
              ],
              [
                "",
                C.ink,
                c
              ],
              [
                `#${hex(c).toUpperCase()}`,
                C.blue
              ]
            ]);
          }
          gap();
          say2("e opens it in Paint", C.dim, F);
          break;
        }
        case "view": {
          const view = viewOf(v);
          if (typeof view.show === "string" && view.show in v) {
            const x = v[view.show];
            const xk = kind(x, view.show, void 0, o);
            say2(view.show, C.ink2, F);
            body(B, x, xk === "view" ? "map" : xk, {
              ...o,
              key: view.show,
              name: view.show,
              parent: v,
              ctx: v,
              write: false
            });
            B.rule();
          }
          body(B, v, "map", {
            ...o,
            play: false
          });
          break;
        }
        case "id":
          say2(v, C.lilac);
          break;
        case "fn":
          push(blit.height(FT) + 6 * u, (x, y) => tag(f, x, y, "fn", C.paper, C.line, C.line));
          if (o.address) say2(`call ${shown2(o.address)} [json\u2026]   in a shell`, C.dim);
          break;
        case "proc":
          say2("\u2192 goes into it", C.dim, F);
          break;
        default:
          push(blit.height(FT) + 6 * u, (x, y) => tag(f, x, y, `live ${liveName(v)}`.trim(), C.lilac, void 0, C.lilac));
      }
    };
    const pane = (f, R, v, o = {}) => {
      const k = o.kind ?? kind(v, o.key, o.ctx, o);
      const B = blocks(f, R.w - 20 * u);
      B.text(about(v, k, o), C.ink2, F);
      B.rule();
      body(B, v, k, o);
      const scroll = lay(B, R, o.scroll ?? 0);
      return {
        scroll,
        zones: B.zones,
        kind: k
      };
    };
    const hit = (zones, x, y) => [
      ...zones
    ].reverse().find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) ?? null;
    const simple = [
      "string",
      "int",
      "float",
      "null"
    ];
    const edit = (v, k, o = {}) => {
      if (!simple.includes(k) || k === "string" && v.includes("\n")) return null;
      const t = k === "string" ? v : k === "null" ? "" : number(v, o.key ?? o.name, o.ctx);
      return {
        text: t,
        pos: t.length,
        mark: t ? 0 : null
      };
    };
    const parse = (t, k) => {
      if (k === "string") return {
        value: t
      };
      if (k === "null") {
        if (t.trim() === "") return {
          none: true
        };
        try {
          return {
            value: JSON.parse(t)
          };
        } catch {
          return {
            value: t
          };
        }
      }
      const m = /^#([0-9a-f]{6})$/i.exec(t.trim());
      const n = m ? parseInt(m[1], 16) : /^-?0x[0-9a-f]+$/i.test(t.trim()) ? parseInt(t.trim(), 16) : t.trim() === "" ? NaN : Number(t.trim());
      if (Number.isNaN(n) && t.trim() !== "NaN") return {
        error: `not a number: ${t}`
      };
      return {
        value: n
      };
    };
    const field = (f, b, x) => {
      const t = x.text, room = b.w - 8 * u;
      let from = 0;
      while (from < x.pos && blit.measure(t.slice(from, x.pos), FX) > room) from++;
      const at = (i) => b.x + 4 * u + blit.measure(t.slice(from, Math.max(from, i)), FX);
      blit.fill(f, b.x, b.y, b.w, b.h, C.line);
      blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi);
      const clip = {
        x: b.x + u,
        y: b.y,
        w: b.w - 2 * u,
        h: b.h
      };
      const sel = selection(x);
      if (sel) {
        blit.fill(f, at(sel[0]), b.y + 2 * u, Math.max(u, at(sel[1]) - at(sel[0])), b.h - 4 * u, C.lemon, clip);
      }
      blit.text(f, b.x + 4 * u, b.y + Math.floor((b.h - blit.height(FX)) / 2), t.slice(from), C.ink, void 0, clip, FX);
      const cx = Math.min(b.x + b.w - 3 * u, at(x.pos));
      blit.fill(f, cx, b.y + 2 * u, 2 * u, b.h - 4 * u, C.rose);
      return {
        text: t,
        pos: x.pos,
        x: cx,
        y: b.y + 2 * u,
        h: b.h - 4 * u,
        from,
        b
      };
    };
    const click = (caret, x) => caret.from + blit.at(caret.text.slice(caret.from), x - caret.b.x - 4 * u, FX);
    return {
      fonts,
      kinds,
      kind,
      badge,
      pieces,
      number,
      summary,
      about,
      text,
      tag,
      swatch,
      fitted,
      blocks,
      body,
      lay,
      pane,
      hit,
      edit,
      parse,
      field,
      click,
      order,
      addressOf,
      shown: shown2,
      short,
      clock,
      when,
      who,
      head,
      ids,
      site,
      did,
      itemOf,
      changes,
      away,
      ops,
      size
    };
  }

  // playground/experimental_os/newos/js/icons.ts
  var icons_exports = {};
  __export(icons_exports, {
    SIZE: () => SIZE,
    clean: () => clean,
    dropped: () => dropped,
    folder: () => folder,
    keyed: () => keyed,
    layout: () => layout,
    make: () => make3,
    nearest: () => nearest,
    spots: () => spots
  });
  var isPicture = (v) => v?.kind === "picture" && Array.isArray(v.rows);
  var SIZE = 48;
  var ICONS = {
    folder: [
      "................",
      "................",
      "..kkkkk.........",
      ".kyyyyyk........",
      "kkkkkkkkkkkkkkk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kkkkkkkkkkkkkkk.",
      "................",
      "................"
    ],
    text: [
      "..kkkkkkkkk.....",
      "..kpppppppkk....",
      "..kpppppppkpk...",
      "..kpppppppkkkk..",
      "..kpkkkkpppppk..",
      "..kppppppppppk..",
      "..kpkkkkkkkppk..",
      "..kppppppppppk..",
      "..kpkkkkkkpppk..",
      "..kppppppppppk..",
      "..kpkkkkkkkppk..",
      "..kppppppppppk..",
      "..kpkkkkkppppk..",
      "..kppppppppppk..",
      "..kkkkkkkkkkkk..",
      "................"
    ],
    data: [
      "..kkkkkkkkk.....",
      "..kpppppppkk....",
      "..kpppppppkpk...",
      "..kpppppppkkkk..",
      "..kppppppppppk..",
      "..kppcpppcpppk..",
      "..kpcppppcpppk..",
      "..kpcpppppcppk..",
      "..kcppppppcppk..",
      "..kpcpppppcppk..",
      "..kpcppppcpppk..",
      "..kppcpppcpppk..",
      "..kppppppppppk..",
      "..kppppppppppk..",
      "..kkkkkkkkkkkk..",
      "................"
    ],
    program: [
      ".......kk.......",
      "......kcck......",
      ".....kcccck.....",
      "....kccppcck....",
      "...kccpkkpcck...",
      "..kccpkppkpcck..",
      ".kccpkppppkpcck.",
      "kccpkppppppkpcck",
      "kccpkppppppkpcck",
      ".kccpkppppkpcck.",
      "..kccpkppkpcck..",
      "...kccpkkpcck...",
      "....kccppcck....",
      ".....kcccck.....",
      "......kcck......",
      ".......kk......."
    ],
    trash: [
      "................",
      "......kkkk......",
      "..kkkkkkkkkkkk..",
      "..kppppppppppk..",
      "..kkkkkkkkkkkk..",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "....kkkkkkkk....",
      "................"
    ],
    full: [
      "...kkkk.kkk.....",
      "..kppppkpppk....",
      "..kpkpkkppkpk...",
      "..kkkkkkkkkkkk..",
      "..kppppppppppk..",
      "..kkkkkkkkkkkk..",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "...kpkpkpkpkk...",
      "....kkkkkkkk....",
      "................"
    ],
    pending: [
      "..d.d.d.d.d.....",
      "................",
      "..d.......d.d...",
      "................",
      "..d.........d...",
      "................",
      "..d.........d...",
      "................",
      "..d.........d...",
      "................",
      "..d.........d...",
      "................",
      "..d.........d...",
      "................",
      "..d.d.d.d.d.d...",
      "................"
    ],
    refused: [
      "..kkkkkkkkk.....",
      "..kpppppppkk....",
      "..kpppppppkpk...",
      "..kpppppppkkkk..",
      "..kppppppppppk..",
      "..kpcppppppcpk..",
      "..kppcppppcppk..",
      "..kpppcppcpppk..",
      "..kppppccppppk..",
      "..kpppcppcpppk..",
      "..kppcppppcppk..",
      "..kpcppppppcpk..",
      "..kppppppppppk..",
      "..kppppppppppk..",
      "..kkkkkkkkkkkk..",
      "................"
    ]
  };
  var dark = (c) => (c >> 1 & 8355711) + (c >> 2 & 4144959);
  var outline = (d) => {
    const t = d.match(/[MLHVQZ]|-?[\d.]+/g) ?? [];
    const out = [];
    let x = 0, y = 0, i = 0;
    const n = () => Number(t[i++]);
    while (i < t.length) {
      const c = t[i++];
      if (c === "M" || c === "L") {
        x = n();
        y = n();
        out.push(x, y);
      } else if (c === "H") {
        x = n();
        out.push(x, y);
      } else if (c === "V") {
        y = n();
        out.push(x, y);
      } else if (c === "Q") {
        const cx = n(), cy = n(), ex = n(), ey = n();
        for (let k = 1; k <= 8; k++) {
          const s = k / 8, r = 1 - s;
          out.push(r * r * x + 2 * r * s * cx + s * s * ex, r * r * y + 2 * r * s * cy + s * s * ey);
        }
        x = ex;
        y = ey;
      }
    }
    return out;
  };
  var box = (x, y, w, h, r) => outline(`M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`);
  var filled = (p, w, h, k) => {
    const cover = new Float32Array(w * h), N = 4, cross = [];
    for (let py = 0; py < h; py++) {
      for (let j = 0; j < N; j++) {
        const y = (py + (j + 0.5) / N) / k;
        cross.length = 0;
        for (let i = 0, m = p.length - 2; i < p.length; m = i, i += 2) {
          const x0 = p[m], y0 = p[m + 1], x1 = p[i], y1 = p[i + 1];
          if (y0 <= y === y1 <= y) continue;
          cross.push([
            (x0 + (y - y0) / (y1 - y0) * (x1 - x0)) * k,
            y1 > y0 ? 1 : -1
          ]);
        }
        cross.sort((a, b) => a[0] - b[0]);
        let wind = 0;
        for (let c = 0; c < cross.length - 1; c++) {
          wind += cross[c][1];
          if (!wind) continue;
          const xa = Math.max(0, cross[c][0]), xb = Math.min(w, cross[c + 1][0]);
          for (let px = Math.floor(xa); px < xb && px < w; px++) {
            cover[py * w + px] += (Math.min(px + 1, xb) - Math.max(px, xa)) / N;
          }
        }
      }
    }
    return cover;
  };
  var stroked = (p, closed, width, w, h, k) => {
    const cover = new Float32Array(w * h), n = p.length / 2, hw = width / 2 * k;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const x0 = p[2 * i] * k, y0 = p[2 * i + 1] * k, x1 = p[(2 * i + 2) % p.length] * k, y1 = p[(2 * i + 3) % p.length] * k;
      const dx = x1 - x0, dy = y1 - y0, l = dx * dx + dy * dy;
      for (let py = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1)); py < Math.min(h, Math.ceil(Math.max(y0, y1) + hw + 1)); py++) {
        for (let px = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1)); px < Math.min(w, Math.ceil(Math.max(x0, x1) + hw + 1)); px++) {
          const x = px + 0.5, y = py + 0.5, t = l ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l)) : 0;
          const c = Math.max(0, Math.min(1, hw + 0.5 - Math.hypot(x - x0 - t * dx, y - y0 - t * dy)));
          if (c > cover[py * w + px]) cover[py * w + px] = c;
        }
      }
    }
    return cover;
  };
  var ink = (a, b, t) => [
    16,
    8,
    0
  ].reduce((c, k) => c | Math.round((a >> k & 255) * (1 - t) + (b >> k & 255) * t) << k, 0);
  var raster = (w, h, k, shapes, clear) => {
    const covers = shapes.map((s) => s.fill ? filled(s.fill, w, h, k) : stroked(s.stroke, !!s.closed, s.width ?? 1, w, h, k));
    const bits = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      let a = 0, r = 0, g2 = 0, b = 0;
      shapes.forEach((s, n) => {
        const c = Math.min(1, covers[n][i]) * (s.alpha ?? 1);
        if (!c) return;
        r = r * (1 - c) + (s.color >> 16 & 255) * c;
        g2 = g2 * (1 - c) + (s.color >> 8 & 255) * c;
        b = b * (1 - c) + (s.color & 255) * c;
        a = a * (1 - c) + c;
      });
      const colour = a ? Math.round(r / a) << 16 | Math.round(g2 / a) << 8 | Math.round(b / a) : 0;
      bits[i] = clear ? a >= 0.5 ? colour : 4278190080 : (255 - Math.round(a * 255) << 24 | colour) >>> 0;
    }
    return bits;
  };
  var TINT = {
    root: [
      16767326,
      16773286
    ],
    pink: [
      16755151,
      16765670
    ],
    blue: [
      9750271,
      13165311
    ],
    mint: [
      9296821,
      12841178
    ],
    trash: [
      12825343,
      14735103
    ],
    lilac: [
      12825343,
      14735103
    ]
  };
  var AREA = {
    home: TINT.pink,
    programs: TINT.blue,
    lib: TINT.blue,
    Applications: TINT.blue,
    drivers: TINT.mint,
    dev: TINT.mint,
    hw: TINT.mint
  };
  var tinted = (path, own) => Array.isArray(own) && own.length === 2 && own.every((c) => typeof c === "number") ? own : AREA[path[0]] ?? (path.length <= 1 ? TINT.root : TINT.lilac);
  var BAND = {
    text: 14274525,
    data: 16767053,
    c: 16748480,
    javascript: 6279071,
    wasm: 7255295,
    builtin: 12034815,
    exec: 12034815,
    refused: 14828924
  };
  var LINE = 3811907;
  var FOLDER = (back, front2) => [
    {
      fill: outline("M3,9 Q3,4 8,4 H23 Q26,4 28,7 L30,10 H56 Q61,10 61,15 V45 Q61,49 57,49 H7 Q3,49 3,45 Z"),
      color: back
    },
    {
      fill: outline("M3,19 Q3,15 7,15 H57 Q61,15 61,19 V45 Q61,49 57,49 H7 Q3,49 3,45 Z"),
      color: front2
    },
    {
      stroke: [
        8,
        19.6,
        56,
        19.6
      ],
      width: 1.3,
      color: 16777215,
      alpha: 0.75
    }
  ];
  var PAGE = (band, faint = false) => {
    const body = outline("M8,2 H31 L44,15 V54 Q44,58 40,58 H8 Q4,58 4,54 V6 Q4,2 8,2 Z");
    const corner = outline("M31,2 V11 Q31,15 35,15 H44 Z");
    return [
      {
        fill: body,
        color: 16777215,
        alpha: faint ? 0.4 : 1
      },
      ...band === null ? [] : [
        {
          fill: box(4.5, 42, 39, 11, 0),
          color: band
        }
      ],
      {
        stroke: body,
        closed: true,
        width: 1,
        color: LINE,
        alpha: faint ? 0.18 : 0.24
      },
      {
        fill: corner,
        color: 16051959,
        alpha: faint ? 0.4 : 1
      },
      {
        stroke: corner,
        width: 1,
        color: LINE,
        alpha: faint ? 0.18 : 0.24
      }
    ];
  };
  var TRASH = (full, own) => {
    const [lid, body] = Array.isArray(own) && own.length === 2 ? own : TINT.trash;
    return [
      ...full ? [
        {
          fill: outline("M13,15 L17,3 L31,5 L34,15 Z"),
          color: 16777215
        },
        {
          stroke: outline("M13,15 L17,3 L31,5 L34,15"),
          width: 1,
          color: LINE,
          alpha: 0.24
        }
      ] : [],
      {
        fill: outline("M9,19 H39 L37,53 Q36.7,57 33,57 H15 Q11.3,57 11,53 Z"),
        color: body
      },
      {
        stroke: [
          19,
          24,
          19.6,
          51
        ],
        width: 2.2,
        color: 16777215,
        alpha: 0.8
      },
      {
        stroke: [
          24,
          24,
          24,
          51
        ],
        width: 2.2,
        color: 16777215,
        alpha: 0.8
      },
      {
        stroke: [
          29,
          24,
          28.4,
          51
        ],
        width: 2.2,
        color: 16777215,
        alpha: 0.8
      },
      {
        stroke: outline("M19,12 V9 Q19,7 21,7 H27 Q29,7 29,9 V12"),
        width: 2.4,
        color: lid
      },
      {
        fill: box(6, 12, 36, 6, 3),
        color: lid
      }
    ];
  };
  function make3(blit, style) {
    const C = style.colours;
    const kind = (e) => {
      const v = e.value;
      if (e.name === "Trash" && e.at.join("/") === "home") return "trash";
      if (e.kids) return "folder";
      if (isPicture(v)) return "picture";
      if (v?.kind === "app" && typeof v.run === "string") return "app";
      if (e.provisions?.needs?.length || e.provisions?.provides?.length) return "program";
      if (v === null || v === void 0) return "folder";
      if (typeof v === "string") return "text";
      return "data";
    };
    const entry = (api, at, n, items) => {
      const e = {
        at,
        name: n,
        ids: items.map((x) => x.id),
        e: false,
        kids: 0,
        value: null
      };
      if (items.length && items.every((x) => !x.node)) return {
        ...e,
        kind: "pending"
      };
      try {
        const v = api.content([
          "/",
          ...at,
          n
        ]).find((i) => i.versions)?.versions?.find((x) => !isStatus(x));
        e.value = v?.content ?? null;
        e.commit = v?.change?.time !== void 0 ? {
          lamport: v.change.time
        } : null;
        e.kids = api.children([
          "/",
          ...at,
          n
        ]).length;
        const p = api.info([
          "/",
          ...at,
          n
        ], "ermine.program.provisions").find((i) => i.versions)?.versions?.[0]?.content;
        e.provisions = p && typeof p === "object" ? p : null;
      } catch {
        return {
          ...e,
          kind: "refused"
        };
      }
      return {
        ...e,
        kind: kind(e)
      };
    };
    const program = (e) => {
      const needs2 = e.provisions?.needs ?? [], provides = e.provisions?.provides ?? [];
      const lines = typeof e.value === "string" ? `, ${e.value.split("\n").length} lines` : "";
      if (provides.length) {
        return `loader of ${provides.join(", ")}${needs2.length ? `, needs ${needs2.join(", ")}` : ""}`;
      }
      const what = {
        c: "C program",
        javascript: "JavaScript program",
        wasm: "wasm program",
        builtin: "driver built in",
        exec: "Mac program"
      }[needs2[0]];
      return `${what ?? `program, needs ${needs2.join(", ")}`}${lines}`;
    };
    const describe = (e) => {
      const more = [
        e.ids.length > 1 ? `${e.ids.length} members` : null,
        e.e ? "ephemeral" : null
      ].filter((x) => x);
      const what = {
        folder: `folder, ${e.kids} ${e.kids === 1 ? "item" : "items"}${e.kids && e.value !== null ? ", with a value" : ""}`,
        trash: e.kids ? `the Trash, ${e.kids} thrown away` : "the Trash, empty",
        text: `note, ${e.value?.length ?? 0} characters`,
        picture: `${e.value?.tile ? "pattern" : "picture"}, ${e.value?.rows?.[0]?.length ?? 0} \xD7 ${e.value?.rows?.length ?? 0}`,
        program: program(e),
        app: `application, runs ${e.value?.run}`,
        data: "data",
        pending: "arriving: it shows when it comes",
        refused: "refused"
      }[e.kind];
      return [
        what,
        ...more
      ].join(", ");
    };
    const art = (f, v, x, y, scale, clip) => {
      v.rows.forEach((row, j) => {
        let i = 0;
        while (i < row.length) {
          let k = i;
          while (k < row.length && row[k] === row[i]) k++;
          const color = v.colors?.[row[i]];
          if (typeof color === "number") {
            blit.fill(f, x + i * scale, y + j * scale, (k - i) * scale, scale, color, clip);
          }
          i = k;
        }
      });
    };
    const pattern = (v, scale) => {
      const w = Math.max(...v.rows.map((r) => r.length)), h = v.rows.length;
      const form = blit.form(w * scale, h * scale, C.desk);
      v.rows.forEach((row, j) => [
        ...row
      ].forEach((ch, i) => {
        const color = v.colors?.[ch];
        if (typeof color === "number") {
          blit.fill(form, i * scale, j * scale, scale, scale, color);
        }
      }));
      return form;
    };
    const framed = (f, v, x, y, w, h) => {
      const clip = {
        x,
        y,
        w,
        h
      };
      if (v.tile) {
        return blit.tile(f, x, y, w, h, pattern(v, Math.max(1, Math.floor(w / 32))), "copy", clip);
      }
      const pw = Math.max(...v.rows.map((r) => r.length)), ph = v.rows.length;
      const scale = Math.max(1, Math.floor(Math.min(w / pw, h / ph)));
      art(f, v, x + Math.floor((w - pw * scale) / 2), y + Math.floor((h - ph * scale) / 2), scale, clip);
    };
    const pixel = (f, e, x, y, on) => {
      const u = style.u, S = 2 * u;
      if (e.kind === "picture") {
        blit.fill(f, x + S, y + S, 14 * S, 14 * S, on ? dark(C.paper) : C.paper);
        framed(f, e.value, x + 2 * S, y + 2 * S, 12 * S, 12 * S);
        blit.frame(f, x + S, y + S, 14 * S, 14 * S, C.line);
        for (let i = 1; i < u; i++) {
          blit.frame(f, x + S + i, y + S + i, 14 * S - 2 * i, 14 * S - 2 * i, C.line);
        }
        if (on) blit.fill(f, x + S, y + 15 * S, 14 * S, S, C.line);
        return;
      }
      if (e.kind === "app" && isPicture(e.value.icon)) {
        const v = e.value.icon;
        art(f, on ? {
          ...v,
          colors: Object.fromEntries(Object.entries(v.colors ?? {}).map(([k, c]) => [
            k,
            dark(c)
          ]))
        } : v, x, y, S);
        return;
      }
      const rows = ICONS[e.kind === "trash" && e.kids ? "full" : e.kind === "app" ? "program" : e.kind] ?? ICONS.data;
      const tint = {
        k: C.line,
        p: C.paper,
        y: C.lemon,
        c: C.cherry,
        d: C.dim
      };
      art(f, {
        rows,
        colors: Object.fromEntries(Object.entries(tint).map(([k, c]) => [
          k,
          on && k !== "k" ? dark(c) : c
        ]))
      }, x, y, S);
      if (e.kind === "folder" && e.value !== null && e.kids) {
        blit.fill(f, x + 9 * S, y + 6 * S, 5 * S, 6 * S, C.paper);
        blit.frame(f, x + 9 * S, y + 6 * S, 5 * S, 6 * S, C.line);
      }
    };
    const drawn = /* @__PURE__ */ new Map();
    const shapes = (e) => {
      if (e.kind === "folder") {
        const [back, front2] = tinted([
          ...e.at,
          e.name
        ], C.icons?.folder);
        return [
          FOLDER(back, front2),
          64,
          52
        ];
      }
      if (e.kind === "trash") return [
        TRASH(!!e.kids, C.icons?.trash),
        48,
        60
      ];
      if (e.kind === "pending") return [
        PAGE(null, true),
        48,
        60
      ];
      if (e.kind === "program" || e.kind === "app") {
        const needs2 = e.provisions?.needs?.[0] ?? (e.kind === "app" ? "builtin" : "c");
        return [
          PAGE(BAND[needs2] ?? BAND.builtin),
          48,
          60
        ];
      }
      return [
        PAGE(BAND[e.kind] ?? BAND.data),
        48,
        60
      ];
    };
    const vector = () => C.icons?.style === "vector";
    const size2 = () => vector() ? SIZE : 32;
    const icon = (f, e, x, y, on, clear = false) => {
      if (!vector()) return pixel(f, e, x, y, on);
      const u = style.u, N = SIZE * u, S = SIZE / 16 * u;
      if (on) {
        const pad = 4 * u, r = 8 * u, c = C.select ?? 16771314;
        blit.fill(f, x - pad + r, y - pad, N + 2 * pad - 2 * r, N + 2 * pad, c);
        blit.fill(f, x - pad, y - pad + r, N + 2 * pad, N + 2 * pad - 2 * r, c);
        for (const [cx, cy] of [
          [
            x - pad + r,
            y - pad + r
          ],
          [
            x + N + pad - r - 1,
            y - pad + r
          ],
          [
            x - pad + r,
            y + N + pad - r - 1
          ],
          [
            x + N + pad - r - 1,
            y + N + pad - r - 1
          ]
        ]) {
          blit.fillellipse(f, cx, cy, r, r, c);
        }
      }
      if (e.kind === "picture") {
        blit.fill(f, x + S, y + S, 14 * S, 14 * S, C.paper);
        framed(f, e.value, x + 2 * S, y + 2 * S, 12 * S, 12 * S);
        for (let i = 0; i < u; i++) {
          blit.frame(f, x + S + i, y + S + i, 14 * S - 2 * i, 14 * S - 2 * i, C.line);
        }
        return;
      }
      if (e.kind === "app" && isPicture(e.value.icon)) return art(f, e.value.icon, x, y, S);
      const [list, uw, uh] = shapes(e);
      const k = Math.min((N - 2 * u) / uw, (N - 2 * u) / uh), w = Math.ceil(uw * k), h = Math.ceil(uh * k);
      const key3 = `${e.kind} ${e.kids ? 1 : 0} ${e.provisions?.needs?.[0] ?? ""} ${e.kind === "folder" ? tinted([
        ...e.at,
        e.name
      ]).join() : ""} ${N} ${clear}`;
      let made = drawn.get(key3);
      if (!made) {
        made = {
          w,
          h,
          bits: raster(w, h, k, list, clear)
        };
        if (drawn.size > 64) drawn.clear();
        drawn.set(key3, made);
      }
      blit.blit(f, x + Math.floor((N - w) / 2), y + N - u - h, {
        w: made.w,
        h: made.h,
        bits: made.bits
      }, 0, 0, made.w, made.h, clear ? "over" : "blend");
      if (e.kind === "folder" && e.value !== null && e.kids) {
        const px = x + 18 * u, py = y + 10 * u;
        blit.fill(f, px, py, 10 * u, 12 * u, 16777215);
        blit.frame(f, px, py, 10 * u, 12 * u, ink(16777215, LINE, 0.24));
      }
    };
    const start = (part, folder2, program2, d) => {
      const op = {
        address: [
          "/",
          "apps",
          folder2
        ],
        program: program2.split("/").filter((x) => x),
        ...d ? {
          data: d
        } : {}
      };
      const launch = val(part.api, [
        "/",
        "dev",
        "wm",
        "launch"
      ]);
      if (Array.isArray(launch)) return part.call(launch, [
        op
      ]);
      const { data: data2, ...rest } = op;
      const pid = part.start(rest);
      if (data2 !== void 0) put(part.api, pid, "data", data2);
      return pid;
    };
    const open = (part, path, e) => {
      const api = part.api;
      if (e.kind === "pending") return `${e.name} is still arriving`;
      if (e.kind === "refused") return `${e.name}: refused`;
      if (e.kind === "folder" || e.kind === "trash" || e.kind === "picture") {
        start(part, "computer", "programs/computer", {
          path
        });
      } else if (e.kind === "app") {
        const ctl = val(api, [
          "/",
          "dev",
          "wm",
          "ctl"
        ]);
        if (!Array.isArray(ctl)) return `${e.name}: no window manager to run it`;
        part.call(ctl, [
          `run ${e.value.run}`
        ]);
      } else if (path.join("/") === "etc/keys") start(part, "keys", "programs/keys");
      else start(part, "edit", "programs/edit", {
        path
      });
      return null;
    };
    const move = (api, e, to, toname) => {
      const from = [
        "/",
        ...e.at
      ];
      const at = idAt(api, from), into2 = idAt(api, to);
      if (!at || !into2) return null;
      const i = api.children(from, e.name).findIndex((x) => x.id === e.ids[0]);
      return api.move(at, e.name, Math.max(0, i), into2, toname);
    };
    const rename = (api, e, toname) => {
      const at = idAt(api, [
        "/",
        ...e.at
      ]);
      if (at && e.ids.length === 1) return api.rename(at, e.name, toname);
      return move(api, e, [
        "/",
        ...e.at
      ], toname);
    };
    const free = (api, at, n) => {
      const names2 = api.children([
        "/",
        ...at
      ]);
      let k = n, i = 2;
      while (names2.includes(k)) k = `${n} ${i++}`;
      return k;
    };
    const link = (api, e, to, toname) => api.insert(idAt(api, to), toname, e.ids[0]);
    const holds = (api, at, id) => {
      const names2 = api.children([
        "/",
        ...at
      ]);
      return names2.find((n) => api.children([
        "/",
        ...at
      ], n).some((x) => x.id === id)) ?? null;
    };
    const into = (api, e, at, linked = false) => {
      if (e.kind === "trash") throw new Error("the Trash stays where it is");
      if ([
        ...e.at,
        e.name
      ].every((n2, i) => at[i] === n2)) {
        throw new Error(`${e.name} can't go inside itself`);
      }
      if (!linked && e.at.join("/") === at.join("/")) return e.name;
      const had = holds(api, at, e.ids[0]);
      if (had !== null) {
        if (!linked) drop(api, [
          "/",
          ...e.at
        ], e.name, e.ids[0]);
        return had;
      }
      const n = free(api, at, e.name);
      (linked ? link : move)(api, e, [
        "/",
        ...at
      ], n);
      return n;
    };
    const land = (api, items, at, linked = false) => items.map((it) => {
      try {
        const there = api.children([
          "/",
          ...it.at
        ], it.name);
        if (!there.some((x) => x.id === it.id)) throw new Error(`${it.name} is gone`);
        const e = {
          ...entry(api, it.at, it.name, there),
          ids: [
            it.id
          ]
        };
        const already = holds(api, at, it.id) !== null;
        return {
          ...it,
          to: into(api, e, at, linked),
          already
        };
      } catch (x) {
        return {
          ...it,
          error: x.message
        };
      }
    });
    return {
      kind,
      entry,
      describe,
      art,
      pattern,
      framed,
      icon,
      size: size2,
      isPicture,
      open,
      start,
      move,
      rename,
      free,
      link,
      holds,
      into,
      land
    };
  }
  function folder(api, path) {
    if (!path.length) return "/";
    try {
      return api.children([
        "/",
        ...path.slice(0, -1)
      ], path[path.length - 1])[0]?.id ?? null;
    } catch {
      return null;
    }
  }
  var layout = {
    /** a layout's address: an id is a name less its ermine:// (and any / in it) */
    at: (id) => [
      "/",
      "apps",
      "computer",
      "layout",
      id === "/" ? "root" : id.replace(/^ermine:\/\//, "").replaceAll("/", "\u2215")
    ],
    /** made the first time: /apps/computer/layout, a folder */
    ready(api) {
      make(api, [
        "/",
        "apps",
        "computer"
      ], "layout", null);
    },
    /** one icon's spot (points) in a folder's layout, its desk's or its icons: a drop from elsewhere, written once */
    put(api, folder2, part, id, at) {
      layout.ready(api);
      const address = layout.at(folder2), was = val(api, address);
      if (was?.[part] && typeof was[part] === "object") {
        api.write(address, [
          {
            path: [
              part,
              id
            ],
            value: at
          }
        ]);
      } else if (was) api.write(address, [
        {
          path: [
            part
          ],
          value: {
            [id]: at
          }
        }
      ]);
      else make(api, address.slice(0, -1), address[address.length - 1], {
        [part]: {
          [id]: at
        }
      });
    }
  };
  function dropped(api, x, y) {
    const WINDOWS = [
      "/",
      "dev",
      "display",
      "windows"
    ];
    let best = null;
    for (const n of api.children(WINDOWS)) {
      const l = val(api, [
        ...WINDOWS,
        n
      ]);
      if (!l || l.hidden || !l.w || l.title == null && n !== "desk") continue;
      const f = l.parts?.frame ?? {
        x: 0,
        y: 0,
        w: l.w,
        h: l.h
      };
      if (x < l.x + f.x || x >= l.x + f.x + f.w || y < l.y + f.y || y >= l.y + f.y + f.h) continue;
      if (!best || (l.z ?? 0) > (best.z ?? 0)) best = {
        ...l,
        name: n
      };
    }
    if (!best) return null;
    const o = best.owner, drop2 = Array.isArray(o) ? [
      ...o,
      "on",
      "drop"
    ] : null;
    return {
      layer: best.name,
      drop: drop2 && idAt(api, drop2) ? drop2 : null
    };
  }
  var overlaps = (a, b, cell) => Math.abs(a[0] - b[0]) < cell.w && Math.abs(a[1] - b[1]) < cell.h;
  function keyed(entries) {
    const seen = /* @__PURE__ */ new Set();
    for (const e of entries) {
      const id = e.ids[0];
      e.key = seen.has(id) ? `${id}#${e.name}` : id;
      seen.add(id);
    }
    return entries;
  }
  function spots(ids2, saved, slot, cell) {
    const out = /* @__PURE__ */ new Map(), taken = [];
    for (const id of ids2) if (saved[id]) taken.push(saved[id]), out.set(id, saved[id]);
    let i = 0;
    for (const id of ids2) {
      if (out.has(id)) continue;
      let at = null;
      for (; ; i++) {
        const s = slot(i);
        if (!s) {
          at = slot(Math.max(0, i - 1)) ?? [
            0,
            0
          ];
          break;
        }
        if (!taken.some((t) => overlaps(t, s, cell))) {
          at = s;
          break;
        }
      }
      taken.push(at);
      out.set(id, at);
    }
    return out;
  }
  function clean(spots2, slot, cell) {
    const slots = [];
    for (let i = 0; slots.length < spots2.size * 4 + 16; i++) {
      const s = slot(i);
      if (!s) break;
      slots.push(s);
    }
    const used = /* @__PURE__ */ new Set(), out = /* @__PURE__ */ new Map();
    const order2 = [
      ...spots2
    ].sort(([, a], [, b]) => a[1] - b[1] || a[0] - b[0]);
    for (const [id, [x, y]] of order2) {
      let best = -1, d = Infinity;
      slots.forEach(([sx, sy], k) => {
        const dk = Math.hypot((sx - x) / cell.w, (sy - y) / cell.h);
        if (!used.has(k) && dk < d) [best, d] = [
          k,
          dk
        ];
      });
      if (best < 0) out.set(id, [
        x,
        y
      ]);
      else {
        used.add(best);
        out.set(id, slots[best]);
      }
    }
    return out;
  }
  function nearest(spots2, from, dx, dy) {
    const all = [
      ...spots2
    ];
    if (!all.length) return null;
    const at = from !== null ? spots2.get(from) : void 0;
    if (!at) return [
      ...all
    ].sort(([, a], [, b]) => a[1] - b[1] || a[0] - b[0])[0][0];
    let best = null, d = Infinity;
    for (const [id, [x, y]] of all) {
      if (id === from) continue;
      const along = (x - at[0]) * dx + (y - at[1]) * dy, across = Math.abs((x - at[0]) * dy) + Math.abs((y - at[1]) * dx);
      if (along <= 0) continue;
      const dk = along + 2 * across;
      if (dk < d) [best, d] = [
        id,
        dk
      ];
    }
    return best ?? from;
  }

  // playground/experimental_os/newos/js/program.ts
  var program_exports = {};
  __export(program_exports, {
    LOAD: () => LOAD,
    PROVISIONS: () => PROVISIONS,
    compiled: () => compiled,
    diagnostics: () => diagnostics,
    needs: () => needs,
    processes: () => processes,
    state: () => state
  });
  var PROVISIONS = "ermine.program.provisions";
  var LOAD = "ermine.program.load";
  var infoOf = (api, address, name) => api.info(address, name).find((i) => i.versions?.length)?.versions?.[0].content;
  function needs(api, address) {
    try {
      const p = infoOf(api, address, PROVISIONS);
      return Array.isArray(p?.needs) ? p.needs.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  }
  function processes(api, address) {
    const folder2 = address.slice(0, -1);
    const node = api.look(address).find((i) => i.node)?.id;
    if (!node) return [];
    const out = [];
    for (const name of api.children(folder2)) {
      try {
        for (const it of api.info([
          ...folder2,
          name
        ], LOAD)) {
          const load2 = it.versions?.[0]?.content;
          if (load2?.program !== node) continue;
          const at = [
            ...folder2,
            name
          ];
          const item = api.content(at).find((i) => i.id === it.id);
          const versions = item?.versions;
          const said2 = val(api, [
            ...at,
            "log"
          ]);
          const failed = val(api, [
            ...at,
            "failed"
          ]);
          const on = api.children([
            ...at,
            "on"
          ]).filter((n) => !n.startsWith("timer."));
          out.push({
            id: it.id,
            name,
            address: at,
            status: versions?.find(isStatus)?.content ?? null,
            value: first(versions) ?? null,
            said: Array.isArray(said2) ? said2.filter((l) => typeof l === "string") : [],
            failed: typeof failed === "string" ? failed : null,
            handlers: on,
            load: load2
          });
        }
      } catch {
      }
    }
    return out;
  }
  function diagnostics(api, load2) {
    if (!load2?.leaf) return [];
    const leaf = val(api, [
      "/",
      "cache",
      "c",
      load2.leaf
    ]);
    return Array.isArray(leaf?.diagnostics) ? leaf.diagnostics.filter((d) => typeof d?.message === "string") : [];
  }
  var plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  var said = (d) => `${d.file ? `${d.file}:` : ""}${d.line ? `${d.line}:${d.column ?? 0} ` : ""}${d.message}`;
  function compiled(load2, diags, line) {
    if (!load2?.compile) return null;
    const pick = (level) => {
      const all = diags.filter((d) => d.level === level);
      return {
        n: all.length,
        at: all.find((d) => !d.file && d.line === line) ?? all[0]
      };
    };
    if (load2.compile === "compiling") return {
      text: "compiling\u2026",
      tone: "dim"
    };
    const errors = pick("error"), warnings = pick("warning");
    if (load2.compile === "failed") {
      const n = errors.n || load2.errors || 1;
      return {
        text: `${plural(n, "error")}${errors.at ? ` \xB7 ${said(errors.at)}` : ""}`,
        tone: "bad"
      };
    }
    const how = load2.compile === "cached" ? "cached" : `compiled in ${load2.ms ?? 0} ms`;
    const warned = warnings.n ? ` \xB7 ${plural(warnings.n, "warning")} \xB7 ${said(warnings.at)}` : "";
    return {
      text: `ok \xB7 ${load2.bytes ?? 0} bytes \xB7 ${how}${warned}`,
      tone: warnings.n ? "warn" : "ok"
    };
  }
  var shown3 = (v) => {
    let t;
    try {
      t = typeof v === "string" ? v : JSON.stringify(v, (_k, x) => ArrayBuffer.isView(x) ? `<${x.byteLength} bytes>` : x) ?? String(v);
    } catch {
      t = String(v);
    }
    return t.length > 60 ? t.slice(0, 60) + "\u2026" : t;
  };
  function state(p, stopped = false) {
    if (!p) return {
      text: stopped ? "stopped" : "not running",
      tone: "dim"
    };
    const st = p.status ?? {};
    const e = st.error;
    if (e) {
      const why = e.code === "not-a-program" ? `not running: ${String(e.message).replace(/^(it did not compile):.*$/s, "$1")}` : e.code === "crashed" ? e.message : `${e.code ?? e.name ?? "error"}: ${e.message}`;
      return {
        text: why,
        tone: "bad"
      };
    }
    if ("pending" in st) {
      return {
        text: p.load.waits ? `waiting: ${p.load.waits}` : "starting\u2026",
        tone: "dim"
      };
    }
    if (p.failed) return {
      text: p.failed,
      tone: "bad"
    };
    const parts2 = [
      "running"
    ];
    if (p.value !== null && p.value !== void 0) parts2.push(shown3(p.value));
    if (p.said.length) parts2.push(`said ${p.said[p.said.length - 1]}`);
    const fresh = st.new;
    if (fresh && typeof fresh === "object" && "node" in fresh) {
      parts2.push("Run Again runs the new code");
    } else if (fresh && typeof fresh === "object") parts2.push("the new code did not compile");
    return {
      text: parts2.join(" \xB7 "),
      tone: "ink"
    };
  }

  // playground/experimental_os/newos/js/budget.ts
  var BUDGET = 5e6;
  var STEP = "__b";
  var puncts = [
    ">>>=",
    "...",
    "===",
    "!==",
    "**=",
    "<<=",
    ">>=",
    ">>>",
    "&&=",
    "||=",
    "??=",
    "=>",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "??",
    "?.",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "<<",
    ">>",
    "**",
    "{",
    "}",
    "(",
    ")",
    "[",
    "]",
    ";",
    ",",
    "<",
    ">",
    "+",
    "-",
    "*",
    "/",
    "%",
    "&",
    "|",
    "^",
    "!",
    "~",
    "?",
    ":",
    "=",
    ".",
    "@",
    "#"
  ];
  var regexAfter = /* @__PURE__ */ new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "case",
    "do",
    "else",
    "yield",
    "await"
  ]);
  var continues = /* @__PURE__ */ new Set([
    ".",
    "?.",
    "?",
    ":",
    "=>",
    "(",
    "[",
    "+",
    "-",
    "*",
    "/",
    "%",
    "**",
    "&&",
    "||",
    "??",
    "&",
    "|",
    "^",
    "<",
    ">",
    "<=",
    ">=",
    "==",
    "!=",
    "===",
    "!==",
    "<<",
    ">>",
    ">>>",
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**=",
    "&=",
    "|=",
    "^=",
    "<<=",
    ">>=",
    ">>>=",
    "&&=",
    "||=",
    "??=",
    ",",
    "in",
    "of",
    "instanceof"
  ]);
  var identStart = /[\p{ID_Start}$_\\]/u;
  var identPart = /[\p{ID_Continue}$‌‍\\]/u;
  function tokens(s) {
    const out = [];
    const n = s.length;
    let i = 0, nl = false;
    const tmpl = [];
    let braces = 0;
    const push = (kind, at, end) => {
      out.push({
        kind,
        text: s.slice(at, end),
        at,
        end,
        nl
      });
      nl = false;
    };
    const regexAllowed = () => {
      const p = out[out.length - 1];
      if (!p) return true;
      if (p.kind === "ident") return regexAfter.has(p.text);
      if (p.kind === "punct") return p.text !== ")" && p.text !== "]";
      return p.kind === "thead" || p.kind === "tmid";
    };
    const template = (at, opening) => {
      let k = i;
      for (; ; ) {
        if (k >= n) throw new Error("budget: an unterminated template literal");
        const c = s[k];
        if (c === "\\") k += 2;
        else if (c === "`") {
          i = k + 1;
          push(opening ? "tmpl" : "ttail", at, i);
          return;
        } else if (c === "$" && s[k + 1] === "{") {
          i = k + 2;
          push(opening ? "thead" : "tmid", at, i);
          tmpl.push(braces);
          return;
        } else k++;
      }
    };
    while (i < n) {
      const c = s[i];
      if (c === "\n") nl = true, i++;
      else if (c === " " || c === "	" || c === "\r" || c === "\f" || c === "\v" || c === "\xA0" || c === "\uFEFF") i++;
      else if (c === "/" && s[i + 1] === "/") {
        while (i < n && s[i] !== "\n") i++;
      } else if (c === "/" && s[i + 1] === "*") {
        const e = s.indexOf("*/", i + 2);
        if (e < 0) throw new Error("budget: an unterminated comment");
        if (s.slice(i, e).includes("\n")) nl = true;
        i = e + 2;
      } else if (c === "'" || c === '"') {
        const at = i++;
        while (i < n && s[i] !== c) {
          if (s[i] === "\\") i++;
          if (s[i] === "\n") throw new Error("budget: an unterminated string");
          i++;
        }
        i++;
        push("str", at, i);
      } else if (c === "`") {
        const at = i++;
        template(at, true);
      } else if (c === "}" && tmpl.length && tmpl[tmpl.length - 1] === braces) {
        tmpl.pop();
        const at = i++;
        template(at, false);
      } else if (c === "/" && regexAllowed()) {
        const at = i++;
        let cls = false;
        for (; i < n; i++) {
          const d = s[i];
          if (d === "\\") i++;
          else if (d === "\n") throw new Error("budget: an unterminated regular expression");
          else if (cls) cls = d !== "]";
          else if (d === "[") cls = true;
          else if (d === "/") break;
        }
        i++;
        while (i < n && identPart.test(s[i])) i++;
        push("regex", at, i);
      } else if (c >= "0" && c <= "9" || c === "." && s[i + 1] >= "0" && s[i + 1] <= "9") {
        const at = i++;
        while (i < n && (identPart.test(s[i]) || s[i] === "." || (s[i] === "+" || s[i] === "-") && (s[i - 1] === "e" || s[i - 1] === "E") && !/^0[xob]/i.test(s.slice(at, i)))) i++;
        push("num", at, i);
      } else if (identStart.test(c)) {
        const at = i++;
        while (i < n && identPart.test(s[i])) i++;
        push("ident", at, i);
      } else {
        const p = puncts.find((x) => s.startsWith(x, i));
        if (!p) {
          throw new Error(`budget: a character that is no token, ${JSON.stringify(c)} at ${i}`);
        }
        if (p === "{") braces++;
        else if (p === "}") braces--;
        const at = i;
        i += p.length;
        push("punct", at, i);
      }
    }
    return out;
  }
  function budget(source) {
    const t = tokens(source);
    const ins = [];
    const is = (k, text) => k < t.length && t[k].kind === "punct" && t[k].text === text;
    const word = (k, text) => k < t.length && t[k].kind === "ident" && t[k].text === text && !(k > 0 && is(k - 1, ".") && !t[k - 1].nl);
    const opens = (k) => is(k, "(") || is(k, "[") || is(k, "{") || t[k].kind === "thead";
    const closes = (k) => is(k, ")") || is(k, "]") || is(k, "}") || t[k].kind === "ttail";
    const past = (k) => {
      let depth = 0;
      for (; k < t.length; k++) {
        if (opens(k)) depth++;
        else if (closes(k) && --depth === 0) return k + 1;
      }
      return k;
    };
    const endOf = (k, comma) => {
      let depth = 0, asks = 0;
      for (let j = k; j < t.length; j++) {
        if (j > k && t[j].nl && depth === 0 && !goesOn(t[j]) && !wants(t[j - 1])) return j;
        if (opens(j)) depth++;
        else if (closes(j)) {
          if (depth === 0) return j;
          depth--;
        } else if (depth === 0 && t[j].kind === "punct") {
          if (t[j].text === ";" || comma && t[j].text === ",") return j;
          if (t[j].text === "?") asks++;
          else if (t[j].text === ":" && asks-- === 0) return j;
        }
      }
      return t.length;
    };
    const goesOn = (x) => (x.kind === "punct" || x.kind === "ident") && continues.has(x.text);
    const wants = (x) => x.kind === "punct" && x.text !== ")" && x.text !== "]" && x.text !== "}" && x.text !== "++" && x.text !== "--" || x.kind === "ident" && (continues.has(x.text) || x.text === "typeof" || x.text === "new" || x.text === "await" || x.text === "void" || x.text === "delete") || x.kind === "thead" || x.kind === "tmid";
    const after2 = (k) => t[k].end;
    const before = (k) => k < t.length ? t[k].at : source.length;
    const close = (k) => k > 0 ? t[k - 1].end : 0;
    const step2 = `${STEP}();`;
    for (let k = 0; k < t.length; k++) {
      const tk = t[k];
      if (tk.kind === "punct" && tk.text === "{" && k > 0 && !tk.nl) {
        const p = t[k - 1];
        if (p.kind === "punct" && p.text === "=>") {
          ins.push({
            at: after2(k),
            text: step2,
            from: tk.at
          });
        } else if (p.kind === "ident" && p.text === "do") {
          ins.push({
            at: after2(k),
            text: step2,
            from: tk.at
          });
        } else if (p.kind === "punct" && p.text === ")") {
          let depth = 0, j = k - 1;
          for (; j >= 0; j--) {
            if (closes(j)) depth++;
            else if (opens(j) && --depth === 0) break;
          }
          const h = j > 0 ? t[j - 1] : null;
          const head2 = h && h.kind === "ident" ? h.text : null;
          if (head2 !== "if" && head2 !== "switch" && head2 !== "catch" && head2 !== "with") {
            ins.push({
              at: after2(k),
              text: step2,
              from: tk.at
            });
          }
        }
      } else if (tk.kind === "punct" && tk.text === "=>" && !is(k + 1, "{")) {
        const e = endOf(k + 1, true);
        ins.push({
          at: after2(k),
          text: ` (${STEP}(),`,
          from: tk.at
        });
        ins.push({
          at: close(e),
          text: ")",
          from: tk.at
        });
      } else if ((word(k, "for") || word(k, "while")) && (is(k + 1, "(") || word(k + 1, "await") && is(k + 2, "("))) {
        if (word(k, "while") && k > 0 && is(k - 1, "}")) continue;
        const open = is(k + 1, "(") ? k + 1 : k + 2;
        const body = past(open);
        if (is(body, "{")) continue;
        if (word(k, "while")) ins.push({
          at: after2(open),
          text: `${STEP}(), `,
          from: tk.at
        });
        else {
          let semi = -1, depth = 0;
          for (let j = open + 1; j < body - 1 && semi < 0; j++) {
            if (opens(j)) depth++;
            else if (closes(j)) depth--;
            else if (depth === 0 && is(j, ";")) semi = j;
          }
          if (semi >= 0) {
            ins.push({
              at: after2(semi),
              text: is(semi + 1, ";") ? ` ${STEP}()` : ` ${STEP}(),`,
              from: tk.at
            });
          } else {
            const e = endOf(body, false);
            ins.push({
              at: before(body),
              text: `{${STEP}(); `,
              from: tk.at
            });
            ins.push({
              at: close(e),
              text: "}",
              from: tk.at
            });
          }
        }
      }
    }
    ins.sort((a, b) => a.at - b.at || b.from - a.from);
    let out = "", last = 0;
    for (const x of ins) {
      out += source.slice(last, x.at) + x.text;
      last = x.at;
    }
    return out + source.slice(last);
  }

  // playground/experimental_os/newos/js/runner.ts
  var g = globalThis;
  var opOn = g.__ermineOp;
  var say = g.__ermineSay;
  var evaluate = g.__ermineEval;
  var vram = g.__ermineVram;
  var here = g.__ermineHere;
  var after = g.__ermineAfter;
  var kill2 = g.__ermineKill;
  delete g.__ermineOp;
  delete g.__ermineSay;
  delete g.__ermineEval;
  delete g.__ermineVram;
  delete g.__ermineHere;
  delete g.__ermineAfter;
  delete g.__ermineKill;
  var PENDING = Symbol.for("ermine.pending");
  var Stand = class {
    kind;
    constructor(kind) {
      this.kind = kind;
    }
  };
  var parts = [];
  var running = () => parts[parts.length - 1] ?? null;
  var os2 = os({
    here,
    after,
    vram,
    kill: kill2
  });
  var wasm2 = wasm(os2);
  var libraries = {
    kit: kit_exports,
    os: os2,
    wasm: wasm2,
    draw: draw(running),
    views: views_exports,
    icons: icons_exports,
    readline: readline_exports,
    program: program_exports
  };
  function script(source) {
    const named = (names2) => names2.replace(/\s+as\s+/g, ": ");
    return source.replace(/import\s*\{([^}]*)\}\s*from\s*["']ermine:([\w-]+)["'];?/g, (_, n, l) => `const {${named(n)}} = __library("${l}");`).replace(/import\s+\*\s+as\s+(\w+)\s+from\s*["']ermine:([\w-]+)["'];?/g, (_, n, l) => `const ${n} = __library("${l}");`).replace(/import\s+(\w+)\s+from\s*["']ermine:([\w-]+)["'];?/g, (_, n, l) => `const ${n} = __library("${l}").default;`).replace(/\bexport\s+default\s+/, "__default = ").replace(/\bexport\s+(?=(async\s+)?(function|const|let|class)\b)/g, "");
  }
  var steps = BUDGET;
  function step() {
    if (--steps < 0) {
      steps = 0;
      const e = new Error(`the run took more than ${BUDGET} steps (loop turns and functions entered), and was stopped`);
      e.name = "budget";
      throw e;
    }
  }
  function load(source, url) {
    const wrapped = `(function (__library, ${STEP}) { let __default;
${budget(script(source))}
;return __default })`;
    const f = evaluate(wrapped, url);
    steps = BUDGET;
    return f((name) => {
      if (!(name in libraries)) throw new Error(`no library ermine:${name}`);
      return libraries[name];
    }, step);
  }
  function apiOf(h, cause) {
    const op = cause === void 0 ? opOn : (h2, name, ...a) => opOn(h2, `@${name}`, cause, ...a);
    return {
      as: (o) => apiOf(h, o.cause),
      node: (id) => op(h, "node", id),
      look: (address) => op(h, "look", address),
      lookup: (path) => op(h, "lookup", path),
      lookups: (path) => op(h, "lookups", path),
      children: (address, name) => op(h, "children", address, name),
      content: (address) => op(h, "content", address),
      info: (address, name) => op(h, "info", address, name),
      write: (address, patches, index, slotindex) => op(h, "write", address, patches, index, slotindex),
      set: (address, name, patches, index, slotindex) => op(h, "set", address, name, patches, index, slotindex),
      insert: (id, name, child, index, slotindex) => op(h, "insert", id, name, child, index, slotindex),
      remove: (id, name, index, slotindex) => op(h, "remove", id, name, index, slotindex),
      pop: (id, name, slotindex) => op(h, "pop", id, name, slotindex),
      rename: (id, name, to) => op(h, "rename", id, name, to),
      move: (id, name, index, toid, toname, toindex) => op(h, "move", id, name, index, toid, toname, toindex),
      create: (value, o) => op(h, "create", value, o)
    };
  }
  function run(f, info) {
    const h = info.handle;
    const start = (o) => opOn(h, "start", o);
    let given;
    if (info.part === "cleanup") given = {
      killed: info.killed,
      api: apiOf(h)
    };
    else if (info.part === "compute") {
      given = {
        api: apiOf(h),
        peep: apiOf(h + 1),
        start,
        by: info.by ?? [],
        pending: PENDING,
        self: info.self,
        name: info.name
      };
    } else {
      given = {
        api: apiOf(h),
        start,
        call: (address, args) => opOn(h, "call", address, args),
        onCleanup: (c) => opOn(h, "onCleanup", c),
        self: info.self,
        name: info.name
      };
      if ("value" in info) given.value = info.value;
      if ("previous" in info) given.previous = info.previous;
      if ("args" in info) given.args = info.args;
    }
    parts.push(given);
    const left = steps;
    steps = BUDGET;
    try {
      return f(given);
    } finally {
      parts.pop();
      steps = left;
    }
  }
  var show = (args) => args.map((a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a);
    }
  }).join(" ");
  var console = {
    log: (...a) => say(show(a)),
    info: (...a) => say(show(a)),
    debug: (...a) => say(show(a)),
    warn: (...a) => say(show(a)),
    error: (...a) => say(show(a))
  };
  Object.assign(globalThis, {
    TextEncoder: TextEncoder2,
    TextDecoder: TextDecoder2,
    console
  });
  g.__ermine = {
    load,
    wasm: (bytes2, url) => wasm2.load(bytes2, url),
    run,
    stand: (kind) => new Stand(kind),
    isStand: (v) => v instanceof Stand ? v : null,
    pending: PENDING
  };
})();
