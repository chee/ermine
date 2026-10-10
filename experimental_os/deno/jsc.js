// jsc.js: made from jsc.ts by c/jsc.sh (deno bundle); not edited by hand.
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // experimental_os/typescript/blitter.ts
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
      if (recording(dst)) return void dst.ops.push({
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
      const r = this.#clip(dst, {
        x,
        y,
        w,
        h
      }, clip);
      for (let ty = r.y; ty < r.y + r.h; ty++) dst.bits.fill(color, ty * dst.w + r.x, ty * dst.w + r.x + r.w);
    }
    /** A one-pixel frame. */
    frame(dst, x, y, w, h, color, clip) {
      if (recording(dst)) return void dst.ops.push({
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
        for (let tx = 0; tx < w; tx += src.w) this.blit(dst, x + tx, y + ty, src, 0, 0, Math.min(src.w, w - tx), Math.min(src.h, h - ty), rule, clip);
      }
    }
    /** BitBlt: src's rectangle at sx, sy, w × h, into dst at dx, dy, clipped to dst and to clip. */
    blit(dst, dx, dy, src, sx = 0, sy = 0, w = src.w, h = src.h, rule = "copy", clip) {
      if (recording(dst)) {
        w = Math.max(0, Math.min(w, src.w - sx));
        h = Math.max(0, Math.min(h, src.h - sy));
        const bits = new Uint32Array(w * h);
        for (let y = 0; y < h; y++) bits.set(src.bits.subarray((sy + y) * src.w + sx, (sy + y) * src.w + sx + w), y * w);
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
      const s = spans(r), p = pen(whole(width ?? 1, 1, WIDEST));
      walk(s, p, whole(x0, -FAR, FAR), whole(y0, -FAR, FAR), whole(x1, -FAR, FAR), whole(y1, -FAR, FAR));
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
      const s = spans(r), p = pen(whole(width ?? 1, 1, WIDEST));
      const at = (i, k) => whole(points[2 * i + k], -FAR, FAR);
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
        xs[i] = whole(points[2 * i], -FAR, FAR);
        ys[i] = whole(points[2 * i + 1], -FAR, FAR);
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
          if ((odd ? turns % 2 !== 0 : turns !== 0) && a < b) dst.bits.fill(color, y * dst.w + a, y * dst.w + b);
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
      const a = whole(rx, -1, RADIUS), b = whole(ry, -1, RADIUS);
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return;
      const cx = whole(x, -FAR, FAR), cy = whole(y, -FAR, FAR), p = pen(whole(width ?? 1, 1, WIDEST));
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
      if (recording(dst)) return void dst.ops.push({
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
      const a = whole(rx, -1, RADIUS), b = whole(ry, -1, RADIUS);
      const r = this.#clip(dst, {
        x: 0,
        y: 0,
        w: dst.w,
        h: dst.h
      }, clip);
      if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return;
      const cx = whole(x, -FAR, FAR), cy = whole(y, -FAR, FAR), s = spans(r);
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
        if (bg !== void 0) this.fill(dst, Math.round(pen2), y, Math.round(pen2 + advance) - Math.round(pen2), font.h, bg, clip);
        if (w) this.#coverage(dst, r, Math.round(pen2) + left, y, page.alpha, page.w, sx, w, font.h, fg);
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
        else if (o.op === "pixels" && o.repl) this.tile(dst, o.x, o.y, o.w, o.h, {
          w: o.repl.w,
          h: o.repl.h,
          bits: o.bits
        }, o.rule ?? "copy", o.clip);
        else if (o.op === "pixels") this.blit(dst, o.x, o.y, {
          w: o.w,
          h: o.h,
          bits: o.bits
        }, 0, 0, o.w, o.h, o.rule ?? "copy", o.clip);
        else if (o.op === "text") {
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
        } else if (o.op === "line") this.line(dst, o.x0, o.y0, o.x1, o.y1, o.width, o.color, o.clip);
        else if (o.op === "ellipse") this.ellipse(dst, o.x, o.y, o.rx, o.ry, o.width, o.color, o.clip);
        else if (o.op === "fillellipse") this.fillellipse(dst, o.x, o.y, o.rx, o.ry, o.color, o.clip);
        else if (o.op === "poly") this.poly(dst, o.points, o.width, o.color, o.clip);
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
          const [first, k0] = line[0], [last, k1] = line.at(-1);
          if (px < first.x) return [
            k0,
            0
          ];
          for (const [r, k] of line) if (px < r.x + r.w) return [
            k,
            this.at(r.text, px - r.x, font(r))
          ];
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
  function whole(n, lo, hi) {
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

  // experimental_os/deno/readline.ts
  var readline_exports = {};
  __export(readline_exports, {
    chord: () => chord,
    insert: () => insert,
    key: () => key,
    keyName: () => keyName,
    normal: () => normal,
    selection: () => selection,
    type: () => type
  });
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
      "cmd",
      "M"
    ],
    [
      "ctrl",
      "C"
    ],
    [
      "alt",
      "A"
    ],
    [
      "shift",
      "S"
    ]
  ];
  function keyName(key2) {
    return NAMES[key2] ?? (key2.length === 1 ? key2.toLowerCase() : key2.toLowerCase());
  }
  function chord(r) {
    const mods = MODS.filter(([m]) => r.mods?.includes(m)).map(([, c]) => c);
    return [
      ...mods,
      keyName(String(r.key ?? ""))
    ].join("-");
  }
  function normal(text) {
    const parts = String(text).trim().split("-");
    let key2 = parts.pop() ?? "";
    if (key2 === "" && parts.length && parts.at(-1) === "") {
      parts.pop();
      key2 = "-";
    }
    const mods = new Set(parts.map((p) => p.toUpperCase()));
    return [
      ...MODS.map(([, c]) => c).filter((c) => mods.has(c)),
      keyName(key2)
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
  function whole2(f) {
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
    if (was === "kill" && f.ring.length) f.ring[f.ring.length - 1] = a < f.pos ? text + f.ring.at(-1) : f.ring.at(-1) + text;
    else f.ring.push(text);
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
    const f = whole2(field);
    const sel = selection(f);
    const [a, b] = sel ?? [
      f.pos,
      f.pos
    ];
    f.goal = null;
    return change(f, f.text.slice(0, a) + text + f.text.slice(b), a + text.length);
  }
  function key(field, k, o = {}) {
    const f = whole2(field);
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
      "M-left",
      "M-right",
      "M-up",
      "M-down",
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
    ].includes(c)) return change(f, t.slice(0, sel[0]) + t.slice(sel[1]), sel[0]);
    switch (c) {
      case "C-a":
      case "home":
      case "M-left":
        return move(o.lines ? lineStart(t, p) : 0);
      case "C-e":
      case "end":
      case "M-right":
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
      case "M-up":
        return move(0);
      case "M-down":
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
      case "M-backspace":
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
        if (e2 === p) e2 = wordBack(t, t.length) === t.length ? t.length : wordOn(t, wordBack(t, t.length));
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
    }
    return null;
  }
  function type(field, r, o = {}) {
    if (r.event === "commit") {
      if (!r.replace) return insert(field, r.text ?? "");
      const f = whole2(field);
      const n = Math.max(0, r.replace[1] - r.replace[0]);
      return change(f, f.text.slice(0, Math.max(0, f.pos - n)) + (r.text ?? "") + f.text.slice(f.pos), Math.max(0, f.pos - n) + (r.text ?? "").length);
    }
    if (!r.down) return null;
    const c = chord(r);
    const typing = r.text && !/[\x00-\x1f\x7f\uf700-\uf8ff]/.test(r.text) && !/(^|-)[MCA]-/.test(c) && r.key !== "Enter" && r.key !== "Tab";
    if (typing) return insert(field, r.text);
    return key(field, c, o);
  }

  // experimental_os/deno/views.ts
  var views_exports = {};
  __export(views_exports, {
    addressOf: () => addressOf,
    clock: () => clock,
    make: () => make,
    ops: () => ops,
    order: () => order,
    short: () => short,
    shown: () => shown,
    size: () => size,
    who: () => who
  });
  var encoder = null;
  var bytes = (t) => (encoder ??= new TextEncoder()).encode(t);
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
  var isAddress = (v, key2) => names(v) && (v[0] === "/" || ADDRESSY.includes(String(key2)) && !v.some((n) => n.includes(" ")));
  var typedKind = (v) => v.constructor.name.replace(/Array$/, "").replace(/^Big/, "").toLowerCase();
  var addressOf = (v) => typeof v === "string" ? [
    "/",
    ...v.split("/").filter((n) => n)
  ] : v[0] === "/" ? v : [
    "/",
    ...v
  ];
  var shown = (a) => "/" + a.filter((n) => n !== "/").join("/");
  var short = (pid) => typeof pid === "string" && pid.length > 9 && pid.startsWith("@") ? "@\u2026" + pid.slice(-6) : String(pid);
  var isColour = (v, key2, ctx) => Number.isInteger(v) && v >= 0 && v <= 16777215 && (/colou?r|paper|ink|line|chrome|desk|grain|^bg$|^fg$|fill|^hi$|^lo$|select|lemon|cherry|rose|mint|lilac|sky|teal|peach|butter|riso|acme|^tag$|check|mark|swatch/i.test(String(key2 ?? "")) || ctx === "colors");
  var hex = (v, n = 6) => v.toString(16).padStart(n, "0");
  var bytesOf = (v) => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
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
    const a = c.agent ?? {};
    const code = Array.isArray(a.code) ? [
      ...a.code
    ].reverse() : [];
    const via = code.slice(0, 3).map((k) => `${short(pids[k.process] ?? k.process)}${k.handler ? " on/" + k.handler : k.run ? " run " + k.run : ""}`);
    return `${typeof a.actor === "string" ? a.actor : typeof a === "string" ? a : "?"}${via.length ? " via " + via.join(" \u2190 ") : ""}${code.length > 3 ? " \u2190 \u2026" : ""}`;
  };
  var ops = (list) => {
    const n = {};
    for (const o of list) n[o?.op] = (n[o?.op] ?? 0) + 1;
    return `${list.length} ops \xB7 ` + Object.entries(n).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(" \xB7 ");
  };
  var isOps = (v) => Array.isArray(v) && v.length > 0 && v.every((o) => o && typeof o === "object" && typeof o.op === "string");
  var isPixels = (v, w, h) => v instanceof Uint32Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w * h <= v.length;
  function make(blit, style) {
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
    const kind = (v, key2, _ctx, o = {}) => {
      if (v === void 0) return "none";
      if (v === null) return "null";
      if (typeof v === "boolean") return "bool";
      if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? "int" : "float";
      if (typeof v === "string") return /^ermine:\/\/[0-9a-f]+$/.test(v) ? "id" : key2 === "program" && /^[^/ ]+(\/[^/ ]+)+$/.test(v) ? "address" : "string";
      if (typeof v === "function") return "fn";
      if (v instanceof ArrayBuffer) return "bytes";
      if (ArrayBuffer.isView(v)) return v instanceof DataView ? "bytes" : "typed";
      if (Array.isArray(v)) return isAddress(v, key2) ? "address" : "list";
      if (typeof v === "object") {
        if (proto(v) !== Object.prototype && proto(v) !== null) return "live";
        const ks = Object.keys(v);
        if (ks.length === 1 && typeof v.fn === "number") return "fn";
        if (typeof v.live === "string") return v.live === "function" ? "fn" : "live";
        if (v.kind === "picture" && Array.isArray(v.rows)) return "picture";
        if (o.play && viewOf(v)) return "view";
        return "map";
      }
      return "live";
    };
    const number = (v, key2, ctx) => {
      if (Number.isNaN(v)) return "NaN";
      if (Object.is(v, -0)) return "-0";
      if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
      if (Number.isInteger(v) && (style.hex || isColour(v, key2, ctx)) && v >= 0) return "0x" + hex(v, isColour(v, key2, ctx) ? 6 : 1);
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
      return k === "string" ? JSON.stringify(x.length > 16 ? x.slice(0, 16) + "\u2026" : x) : k === "int" || k === "float" ? number(x) : k === "bool" || k === "null" ? String(x) : k === "address" ? shown(addressOf(x)) : `\u2039${badge(x, k)}\u203A`;
    };
    const pieces = (v, k, key2, ctx, o = {}) => {
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
          return isColour(v, key2, ctx) ? [
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
              number(v, key2, ctx),
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
          const b = bytesOf(v), t = utf8(b);
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
              shown(addressOf(v)),
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
              typeof v?.live === "string" ? `live ${v.live}` : String(v),
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
      const w = blit.measure(t, FX) + 6 * u, h = blit.height(FX);
      if (!f) return x + w + 4 * u;
      if (bg !== void 0) blit.fill(f, x, y, w, h, bg);
      for (let i = 0; i < u; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, line ?? C.lo);
      blit.text(f, x + 3 * u, y, t, fg, void 0, void 0, FX);
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
        if (f && x + form.w < clip.x + clip.w) blit.blit(f, x, y + Math.max(0, Math.floor((h - form.h) / 2)), form, 0, 0, form.w, Math.min(form.h, h));
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
          return "an id: a node's own, wherever it is mounted (the shell's mount path id)";
        case "fn":
          return "a function: its process holds it, the scheduler calls it (the shell's call path [json\u2026])";
        case "proc":
          return "a process: its node holds a run";
        case "view":
          return `${v.kind} \xB7 ${Object.keys(v).length} keys \xB7 its view in /etc/views`;
        default:
          return `a live value: its host holds it, the graph never looks inside${v?.live ? " \xB7 " + v.live : ""}`;
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
        push: (h, draw) => B.items.push({
          h,
          draw
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
          for (let i = 0; i < Math.max(1, t.length); i += B.cols) B.line([
            [
              t.slice(i, i + B.cols),
              c
            ]
          ], font);
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
          for (let i = 0; i < u; i++) blit.frame(f, hx - u + i, hy - u + i, sc + 2 * u - 2 * i, sc + 2 * u - 2 * i, C.cherry);
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
        for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) {
          const px = v[Math.floor(j / sc) * stride + Math.floor(i / sc)];
          form.bits[j * fw + i] = px === void 0 ? C.check : (alpha ? px >>> 24 < 128 : px & 2147483648) ? (i >> 2) + (j >> 2) & 1 ? C.check : C.hi : px & 16777215;
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
          const whole3 = blit.form(lw, lh, C.check);
          try {
            blit.play(whole3, list, role);
          } catch {
          }
          const form = blit.form(fw, fh);
          for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) form.bits[j * fw + i] = whole3.bits[Math.floor(j / sc) * lw + Math.floor(i / sc)] & 16777215;
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
      const key2 = o.key ?? o.name;
      switch (k) {
        case "string": {
          const ls = v.split("\n");
          ls.slice(0, 400).forEach((l, i) => {
            const ps = [];
            const trail = l.length - l.trimEnd().length;
            let run = "";
            const flush = () => {
              if (run) ps.push([
                run,
                C.ink
              ]);
              run = "";
            };
            [
              ...l.slice(0, l.length - trail)
            ].forEach((ch) => {
              const c = ch.codePointAt(0);
              const odd = c < 32 || c === 127 || c === 160 || c >= 8203 && c <= 8207 || c === 65279;
              if (ch !== "	" && !odd) return void (run += ch);
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
          const colour = isColour(v, key2, o.ctx);
          push(blit.height(FT) * 2, (x, y, clip) => {
            let nx = x;
            if (colour) nx = swatch(f, x, y, v, blit.height(FT) * 2 - 4 * u) + 6 * u;
            blit.text(f, nx, y + Math.floor(blit.height(FT) / 2), colour ? "#" + hex(v).toUpperCase() : number(v, key2), C.blue, void 0, clip, FT);
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
            if (colour) say2(`red ${v >> 16 & 255} \xB7 green ${v >> 8 & 255} \xB7 blue ${v & 255}`, C.ink2);
            if (v > 1e15 && v < 1e17) say2(`as a time: ${new Date(v / 1e3).toISOString()}`, C.dim);
          } else if (Number.isFinite(v)) say2(`exactly ${v.toPrecision(17).replace(/\.?0+$/, "")}`, C.ink2);
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
            if (o.write) B.zones.push({
              x,
              y,
              w: b + 60 * u,
              h: b,
              act: "toggle",
              role: "checkbox",
              label: String(v)
            });
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
            const end = blit.text(f, x, y, shown(a), C.rose, void 0, {
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
              label: shown(a),
              address: a
            });
          });
          if (!o.api) break;
          let there;
          try {
            there = o.api.read({
              address: a
            });
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
                if (o.into) B.zones.push({
                  x,
                  y,
                  w,
                  h: LH,
                  act: "into",
                  key: i,
                  role: "button",
                  label: `[${i}]`
                });
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
          const b = bytesOf(v), t = utf8(b);
          say2(t === null ? "not UTF-8" : `looks like UTF-8: ${[
            ...t
          ].length} characters`, t === null ? C.dim : C.mint, F);
          if (t !== null && b.length) {
            for (const l of t.slice(0, 2e3).split("\n").slice(0, 12)) say2(escaped(l, 400), C.lilac);
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
          if (xs.length) say2(`min ${number(lo)} \xB7 max ${number(hi)} \xB7 mean ${number(+(sum / xs.length).toPrecision(6))}`, C.ink2);
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
          const px = v instanceof Uint32Array && /pixels|bits|colou?rs/.test(String(key2));
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
          for (const [letter, c] of Object.entries(v.colors ?? {}).sort((a, b) => order(a[0], b[0]))) line([
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
          if (o.address) say2(`call ${shown(o.address)} [json\u2026]   in a shell`, C.dim);
          break;
        case "proc":
          say2("\u2192 goes into it", C.dim, F);
          break;
        default:
          push(blit.height(FT) + 6 * u, (x, y) => tag(f, x, y, v?.live ? `live ${v.live}` : `live ${String(v)}`, C.lilac, void 0, C.lilac));
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
      if (sel) blit.fill(f, at(sel[0]), b.y + 2 * u, Math.max(u, at(sel[1]) - at(sel[0])), b.h - 4 * u, C.lemon, clip);
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
      shown,
      short,
      clock,
      who,
      ops,
      size
    };
  }

  // experimental_os/deno/tools.ts
  var codes = /* @__PURE__ */ new Map();
  var fns = /* @__PURE__ */ new Map();
  var nextFn = 1;
  var current = null;
  var way = () => {
    throw new Error("the runner has no way to the OS");
  };
  function connect(w) {
    way = w;
  }
  var mapping = null;
  function vram(f) {
    mapping = f;
  }
  var Thrown = class extends Error {
    why;
    constructor(why) {
      super(String(why.text ?? why.code ?? "error")), this.why = why;
    }
  };
  function ask(pid, api, op, fields) {
    const answer = way(pid, api, op, plain(fields));
    if ("error" in answer) throw new Thrown(answer.error);
    return living(pid, api, answer.ok ?? null);
  }
  function fnOf(pid, kind, f, depth = 0) {
    const id = nextFn++;
    fns.set(id, {
      pid,
      kind,
      f,
      depth
    });
    return {
      fn: id
    };
  }
  function plain(v) {
    if (v === void 0) return null;
    if (v instanceof Blitter || v instanceof RemoteFont) return null;
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== void 0) out[k] = plain(x);
      return out;
    }
    return v;
  }
  var blitter = null;
  function blitterFor(pid, api) {
    if (blitter) return blitter;
    const rom = ask(pid, api, "read", {
      address: [
        "/",
        "hw",
        "font"
      ]
    }).items[0]?.value;
    const alpha = rom.alpha instanceof Uint8Array ? rom.alpha : new Uint8Array(rom.alpha);
    blitter = new Blitter({
      w: rom.w,
      h: rom.h,
      chars: rom.chars,
      alpha
    });
    return blitter;
  }
  var RemoteFont = class {
    value;
    h;
    ascent;
    role;
    #pages;
    constructor(value) {
      this.value = value;
      this.#pages = /* @__PURE__ */ new Map();
      this.h = value.h;
      this.ascent = value.ascent;
      this.role = value.font;
    }
    page(n) {
      const had = this.#pages.get(n);
      if (had) return had;
      if (!current) return void 0;
      const { pid, api } = current;
      const at = [
        "/",
        "dev",
        "font",
        this.role,
        "pages",
        String(n)
      ];
      const items = ask(pid, api, "read", {
        address: at
      }).items;
      const p = items[0]?.value;
      if (!p) {
        try {
          ask(pid, api, "call", {
            address: [
              "/",
              "dev",
              "font",
              "on",
              "want"
            ],
            args: [
              this.role,
              n
            ]
          });
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
  };
  function living(pid, api, v) {
    const turn = (x) => {
      if (Array.isArray(x)) return x.map(turn);
      if (x && typeof x === "object" && !ArrayBuffer.isView(x) && !(x instanceof ArrayBuffer)) {
        const m = x;
        if (m.live === "blitter") return blitterFor(pid, api);
        if (typeof m.font === "string" && typeof m.h === "number" && typeof m.ascent === "number") return new RemoteFont(m);
        const out = {};
        for (const [k, y] of Object.entries(m)) out[k] = turn(y);
        return out;
      }
      return x;
    };
    return turn(v);
  }
  var made = 0;
  function apiOf(pid, api, depth = 0) {
    const up2 = (fields) => {
      const at = fields.address;
      if (!depth || !Array.isArray(at) || at[0] === "/") return fields;
      return {
        ...fields,
        address: [
          ...Array(depth).fill(".."),
          ...at
        ]
      };
    };
    const op = (name) => (fields = {}) => ask(pid, api, name, up2(fields));
    const items = (name) => (fields = {}) => ask(pid, api, name, up2(fields)).items;
    return {
      read: items("read"),
      directory: op("directory"),
      lookup: items("lookup"),
      lookups: items("lookups"),
      cwd: (fields = {}) => ask(pid, api, "cwd", fields).cwd,
      write: op("write"),
      place: (fields) => ask(pid, api, "place", up2(fields.id !== void 0 ? fields : {
        ...fields,
        id: fields.ephemeral ? `${pid}.${++made}` : ""
      })),
      unplace: op("unplace"),
      move: op("move"),
      // a path as a string, "programs/term", is the names it holds; data goes in a node inside the new process
      start(fields) {
        const { data, ...rest } = fields;
        const program = typeof rest.program === "string" ? rest.program.split("/").filter((n) => n) : rest.program;
        const answer = ask(pid, api, "start", up2({
          ...rest,
          program
        }));
        if (data !== void 0) {
          const id = String(answer.change.id);
          const name = String(rest.name ?? id);
          ask(pid, api, "place", up2({
            address: [
              ...rest.address,
              name
            ],
            name: "data",
            id: `${id}.data`,
            value: data,
            ephemeral: true
          }));
        }
        return answer;
      },
      call: op("call")
    };
  }
  function tools(pid, given, depth = 0) {
    const api = apiOf(pid, given.api ?? 0, depth);
    const self = given.self ?? pid;
    const name = given.name ?? self;
    const me = depth ? [] : [
      name
    ];
    let on = false;
    return {
      api,
      self,
      name,
      cwd: given.cwd ?? [],
      data: given.data === void 0 || given.data === null ? [] : [
        {
          value: given.data
        }
      ],
      pending: given.pending,
      compute(n, f) {
        return api.start({
          address: me,
          name: n,
          program: {
            compute: fnOf(pid, "compute", f, depth + 1)
          }
        });
      },
      effect(n, c, run) {
        return api.start({
          address: me,
          name: n,
          program: {
            compute: fnOf(pid, "compute", c, depth + 1),
            effect: fnOf(pid, "effect", run, depth + 1)
          }
        });
      },
      handler(n, f) {
        if (!on) {
          try {
            api.place({
              address: me,
              name: "on",
              value: null,
              ephemeral: true
            });
          } catch {
          }
          on = true;
        }
        api.place({
          address: [
            ...me,
            "on"
          ],
          name: n,
          value: fnOf(pid, "handler", f),
          ephemeral: true
        });
        return (...args) => api.call({
          address: [
            ...me,
            "on",
            n
          ],
          args
        });
      },
      onCleanup(f) {
        ask(pid, given.api ?? 0, "onCleanup", {
          fn: fnOf(pid, "cleanup", f, depth)
        });
      },
      plane(n, w, h) {
        return planeOf(pid, api, n, w, h);
      },
      readline: readline_exports,
      views: views_exports,
      front
    };
  }
  function front(address) {
    const slot = {
      address: address.slice(0, -1),
      name: address[address.length - 1]
    };
    let id = null;
    const held = (api) => {
      if (id) return id;
      const first = api.directory(slot).items?.[0];
      if (first?.ephemeral) id = String(first.id);
      return id;
    };
    return {
      /** whether an item is in front */
      held: (api) => !!held(api),
      /** value in front: written into the item there (as patches, if given), or placed there first */
      put(api, value, patches) {
        if (held(api)) api.write({
          address,
          patches: patches ?? [
            {
              type: "snapshot",
              value
            }
          ]
        });
        else id = String(api.place({
          ...slot,
          value,
          ephemeral: true,
          position: "start"
        }).change.id);
      },
      /** over: the item in front let go, and value, if given, written into the document once (patches, if given), or placed */
      done(api, value, patches) {
        if (held(api)) {
          try {
            api.unplace({
              ...slot,
              id
            });
          } catch {
          }
          id = null;
        }
        if (value === void 0) return;
        if (api.read({
          address
        }).length) api.write({
          address,
          patches: patches ?? [
            {
              type: "snapshot",
              value
            }
          ]
        });
        else api.place({
          ...slot,
          value
        });
      }
    };
  }
  var PLANES = [
    "/",
    "dev",
    "vram",
    "planes"
  ];
  function planeOf(pid, api, n, w, h) {
    const via = () => current ? apiOf(current.pid, current.api) : api;
    via().place({
      address: PLANES,
      name: n,
      value: {
        w,
        h
      },
      ephemeral: true
    });
    let bits = null, id = -1, stride = w, serial = 0, copy = false;
    const ready = () => {
      if (bits) return true;
      const v = via().read({
        address: [
          ...PLANES,
          n
        ]
      })[0]?.value;
      if (typeof v?.shm !== "string") return false;
      id = v.id, stride = v.stride;
      bits = mapping ? mapping(id) : null;
      if (!bits) bits = new Uint32Array(stride * h), copy = true;
      return true;
    };
    return {
      w,
      h,
      get bits() {
        return ready() ? bits : null;
      },
      get stride() {
        ready();
        return stride;
      },
      /** what a layer holds as its plane to show it, or null before the driver has made it */
      value() {
        return ready() ? {
          source: "vram",
          id,
          serial
        } : null;
      },
      /** x, y, dw × dh was drawn: the layer at the address shows it; false before the driver has made the plane */
      drawn(layer, x = 0, y = 0, dw = w, dh = h) {
        if (!ready()) return false;
        if (copy) {
          const part = new Uint32Array(dw * dh);
          for (let r = 0; r < dh; r++) part.set(bits.subarray((y + r) * stride + x, (y + r) * stride + x + dw), r * dw);
          via().call({
            address: [
              "/",
              "dev",
              "vram",
              "driver",
              "on",
              "put"
            ],
            args: [
              id,
              x,
              y,
              dw,
              dh,
              part
            ]
          });
        }
        via().write({
          address: layer,
          patches: [
            {
              type: "set",
              path: [
                "plane"
              ],
              key: "serial",
              value: ++serial
            },
            {
              type: "set",
              path: [
                "plane"
              ],
              key: "dirty",
              value: {
                x,
                y,
                w: dw,
                h: dh
              }
            }
          ]
        });
        return true;
      }
    };
  }
  function serve(frame) {
    const pid = String(frame.pid ?? "");
    if ("load" in frame) {
      try {
        const body = String(frame.source).replace(/\bexport\s+default\s+/, "return ");
        const setup = new Function(body)();
        if (typeof setup !== "function") throw new TypeError("a program's default export is its setup");
        codes.set(String(frame.load), setup);
        return {
          returned: null
        };
      } catch (e) {
        return {
          threw: {
            code: "thrown",
            text: String(e.message ?? e)
          }
        };
      }
    }
    const given = frame.given ?? {};
    const was = current;
    current = {
      pid,
      api: given.api ?? 0
    };
    if (given.part === "setup") {
      lastPid = pid;
      lastApi = given.api ?? 0;
    }
    try {
      const call = frame.call;
      let out;
      if (typeof call === "object" && call && "code" in call) {
        const setup = codes.get(String(call.code));
        if (!setup) throw new Error(`no code ${call.code}`);
        out = setup(tools(pid, given));
        if (out && typeof out === "object" && "change" in out) out = null;
      } else {
        const fn = fns.get(call);
        if (!fn) throw new Error(`no function ${call}`);
        const t = tools(pid, given, fn.depth);
        if (fn.kind === "compute") out = fn.f({
          ...t,
          changes: given.changes ?? [],
          pending: given.pending
        });
        else if (fn.kind === "effect") out = fn.f(given.value ?? null, t);
        else if (fn.kind === "handler") out = fn.f({
          api: t.api,
          caller: given.caller ?? null
        }, ...given.args ?? []);
        else if (fn.kind === "timer") {
          fns.delete(call);
          if (!cancelled.delete(call)) out = fn.f();
        } else out = fn.f({
          killed: !!given.killed,
          api: t.api
        });
      }
      return {
        returned: plain(out)
      };
    } catch (e) {
      return {
        threw: thrown(e)
      };
    } finally {
      current = was;
    }
  }
  function thrown(e) {
    return e instanceof Thrown ? e.why : {
      code: "thrown",
      text: String(e?.message ?? e)
    };
  }
  var cancelled = /* @__PURE__ */ new Set();
  var lastPid = "";
  var lastApi = 0;
  Object.assign(globalThis, {
    setTimeout(f, ms = 0) {
      const pid = current?.pid ?? lastPid, api = current?.api ?? lastApi;
      const fn = fnOf(pid, "timer", f);
      ask(pid, api, "timer", {
        ms: Math.max(0, Math.round(ms)),
        id: fn.fn
      });
      return fn.fn;
    },
    clearTimeout(id) {
      if (fns.has(id)) cancelled.add(id);
    }
  });

  // experimental_os/deno/jsc.ts
  var g = globalThis;
  var ask2 = g.__ermineAsk;
  var say = g.__ermineSay;
  delete g.__ermineAsk;
  delete g.__ermineSay;
  connect(ask2);
  var map = g.__ermineVram;
  delete g.__ermineVram;
  vram(map);
  g.__ermine = {
    serve
  };
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
      const put = (c) => {
        if (c >= 65536) units.push(55296 + (c - 65536 >> 10), 56320 + (c - 65536 & 1023));
        else units.push(c);
        if (units.length > 8192) out += String.fromCharCode(...units.splice(0));
      };
      let i = 0;
      while (i < b.length) {
        const x = b[i];
        if (x < 128) {
          put(x);
          i++;
          continue;
        }
        let need = 0, c = 0, lo = 128, hi = 191;
        if (x >= 194 && x <= 223) need = 1, c = x & 31;
        else if (x >= 224 && x <= 239) need = 2, c = x & 15, lo = x === 224 ? 160 : 128, hi = x === 237 ? 159 : 191;
        else if (x >= 240 && x <= 244) need = 3, c = x & 7, lo = x === 240 ? 144 : 128, hi = x === 244 ? 143 : 191;
        else {
          put(65533);
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
          put(c);
          i += k;
        } else if (i + k >= b.length && stream) {
          this.#held = [
            ...b.subarray(i)
          ];
          break;
        } else {
          put(65533);
          i += k;
        }
      }
      return out + String.fromCharCode(...units);
    }
  };
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
})();
