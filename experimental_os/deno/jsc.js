// jsc.js: made from jsc.ts by c/jsc.sh (deno bundle); not edited by hand.
(() => {
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
    play(dst, ops, fonts, marks, mark2 = 16777096) {
      const runs = [];
      ops.forEach((o, i) => {
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
      const order = [
        ...runs
      ].sort((a2, b2) => a2.y - b2.y || a2.x - b2.x);
      if (!order.length) return {
        ranges: [],
        text: ""
      };
      const font = (r) => r.font ? fonts(r.font) : void 0;
      const place = ([px, py]) => {
        const line = order.map((r, k) => [
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
        const below = order.findIndex((r) => r.y > py);
        return below >= 0 ? [
          below,
          0
        ] : [
          order.length - 1,
          order.at(-1).text.length
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
        const r = order[k];
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
          fn: fnOf(pid, "cleanup", f)
        });
      },
      plane(n, w, h) {
        return planeOf(pid, api, n, w, h);
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
    api.place({
      address: PLANES,
      name: n,
      value: {
        w,
        h
      },
      ephemeral: true
    });
    const via = () => current && current.pid === pid ? apiOf(pid, current.api) : api;
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
          killed: !!given.killed
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
  var TextEncoder = class {
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
  var TextDecoder = class {
    encoding = "utf-8";
    #held = [];
    decode(input, options) {
      const bytes = input === void 0 ? new Uint8Array(0) : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      const b = this.#held.length ? Uint8Array.from([
        ...this.#held,
        ...bytes
      ]) : bytes;
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
    TextEncoder,
    TextDecoder,
    console
  });
})();
