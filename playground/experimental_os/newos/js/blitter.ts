// blitter.ts: the machine's 2D engine, at /hw/devices/blitter/port, as
// Amiga's blitter was hardware, and as BitBlt is Squeak's one graphics
// primitive. A form is a w × h array of pixels, 0x00RRGGBB, rows of w (a
// frame buffer is one, rows of maxw). The blitter copies a rectangle of one
// form into another, clipped, by a rule, and draws text: in the firmware's
// font ROM's cells, or in a font from the font chip. Any program may use it:
// it touches only the forms it is given.

export type Form = { w: number; h: number; bits: Uint32Array }
export type Rect = { x: number; y: number; w: number; h: number }
/**
 * copy: the source as it is. over: the source, but for its transparent
 * pixels, 0xff000000. blend: the source mixed by the alpha in its top byte
 * (0 is opaque, as 0x00RRGGBB has it; 0xff transparent).
 */
export type Rule = "copy" | "over" | "blend"

export const TRANSPARENT = 0xff000000

/**
 * A font from the font chip, as /drivers/font serves it at /dev/font: h
 * pixels a line, the baseline ascent down from its top, and its glyphs in
 * pages of 256 code points. A page is a strip w pixels wide and h high of
 * coverage (0 to 255), and info, four numbers a code point: where its box
 * starts in the strip, its left edge from the pen, its box's width, and how
 * far it moves the pen (in fractions of a pixel). page(n) is undefined while
 * that page is coming.
 */
export type Font = {
	h: number
	ascent: number
	role?: string
	page(n: number): FontPage | undefined
}
export type FontPage = { w: number; alpha: Uint8Array; info: ArrayLike<number> }

/**
 * The draw device's ops: what a layer draws, as data, which can be read,
 * sent and searched, as Plan 9's /dev/draw messages are. A text op is a text
 * run: its string, where its line's top left is, and its font's role
 * (/dev/font/<role>), or null for the font ROM. Colours are 0xRRGGBB.
 */
export type Op =
	| { op: "fill"; x: number; y: number; w: number; h: number; color: number; clip?: Rect }
	| { op: "frame"; x: number; y: number; w: number; h: number; color: number; clip?: Rect }
	| {
		op: "text"
		x: number
		y: number
		text: string
		color: number
		font: string | null
		bg?: number
		clip?: Rect
	}
	| {
		op: "pixels"
		x: number
		y: number
		w: number
		h: number
		bits: Uint32Array
		repl?: { w: number; h: number }
		rule?: Rule
		clip?: Rect
	}
	| {
		op: "line"
		x0: number
		y0: number
		x1: number
		y1: number
		width?: number
		color: number
		clip?: Rect
	}
	| {
		op: "ellipse"
		x: number
		y: number
		rx: number
		ry: number
		width?: number
		color: number
		clip?: Rect
	}
	| { op: "fillellipse"; x: number; y: number; rx: number; ry: number; color: number; clip?: Rect }
	| { op: "poly"; points: number[]; width?: number; color: number; clip?: Rect }
	| { op: "fillpoly"; points: number[]; wind?: Wind; color: number; clip?: Rect }
/** How fillpoly tells inside: nonzero, a point the edges wind round at all; odd, one they cross an odd number of times. */
export type Wind = "nonzero" | "odd"
/** A form that records: the blitter's calls on it become ops, in order. */
export type List = { w: number; h: number; ops: Op[] }
/** Where a text run was drawn, in its layer; op is its index among the ops. */
export type Run = {
	op: number
	x: number
	y: number
	w: number
	h: number
	text: string
	font: string | null
}
/** What is selected: [op, from, to] for each run, UTF-16 offsets in its text, and the text. */
export type Selected = { ranges: [number, number, number][]; text: string }
type Target = Form | List
const recording = (f: Target): f is List => "ops" in f

export class Blitter {
	readonly cell: { w: number; h: number }
	#glyphs = new Map<string, number>()

	constructor(readonly font: { w: number; h: number; chars: string; alpha: Uint8Array }) {
		this.cell = { w: font.w, h: font.h }
		;[...font.chars].forEach((ch, i) => this.#glyphs.set(ch, i * font.w * font.h))
	}

	/** A form that records ops instead of pixels: draw on it as on a form, then put its ops in a layer. */
	list(w: number, h: number, fill?: number): List {
		return {
			w,
			h,
			ops: fill === undefined ? [] : [{ op: "fill", x: 0, y: 0, w, h, color: fill }],
		}
	}

	form(w: number, h: number, fill = 0): Form {
		const bits = new Uint32Array(Math.max(0, w * h))
		if (fill) bits.fill(fill)
		return { w, h, bits }
	}

	/** The part of a rectangle inside a form, and inside clip if given. */
	#clip(f: Form, r: Rect, clip?: Rect): Rect {
		let x0 = Math.max(0, r.x), y0 = Math.max(0, r.y)
		let x1 = Math.min(f.w, r.x + r.w), y1 = Math.min(f.h, r.y + r.h)
		if (clip) {
			x0 = Math.max(x0, clip.x)
			y0 = Math.max(y0, clip.y)
			x1 = Math.min(x1, clip.x + clip.w)
			y1 = Math.min(y1, clip.y + clip.h)
		}
		return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
	}

	fill(dst: Target, x: number, y: number, w: number, h: number, color: number, clip?: Rect) {
		if (recording(dst)) {
			return void dst.ops.push({ op: "fill", x, y, w, h, color, ...(clip ? { clip } : {}) })
		}
		const r = this.#clip(dst, { x, y, w, h }, clip)
		for (let ty = r.y; ty < r.y + r.h; ty++) {
			dst.bits.fill(color, ty * dst.w + r.x, ty * dst.w + r.x + r.w)
		}
	}

	/** A one-pixel frame. */
	frame(dst: Target, x: number, y: number, w: number, h: number, color: number, clip?: Rect) {
		if (recording(dst)) {
			return void dst.ops.push({ op: "frame", x, y, w, h, color, ...(clip ? { clip } : {}) })
		}
		this.fill(dst, x, y, w, 1, color, clip)
		this.fill(dst, x, y + h - 1, w, 1, color, clip)
		this.fill(dst, x, y, 1, h, color, clip)
		this.fill(dst, x + w - 1, y, 1, h, color, clip)
	}

	/**
	 * src replicated to tile w × h at x, y, as Plan 9's repl does, from src's
	 * corner at x, y: a pixels op with repl {w, h}, its bits src's, so a
	 * pattern across a screen is one small form.
	 */
	tile(
		dst: Target,
		x: number,
		y: number,
		w: number,
		h: number,
		src: Form,
		rule: Rule = "copy",
		clip?: Rect,
	) {
		if (recording(dst)) {
			const bits = src.bits.slice(0, src.w * src.h)
			return void dst.ops.push({
				op: "pixels",
				x,
				y,
				w,
				h,
				bits,
				repl: { w: src.w, h: src.h },
				...(rule !== "copy" ? { rule } : {}),
				...(clip ? { clip } : {}),
			})
		}
		if (src.w <= 0 || src.h <= 0) return
		for (let ty = 0; ty < h; ty += src.h) {
			for (let tx = 0; tx < w; tx += src.w) {
				this.blit(
					dst,
					x + tx,
					y + ty,
					src,
					0,
					0,
					Math.min(src.w, w - tx),
					Math.min(src.h, h - ty),
					rule,
					clip,
				)
			}
		}
	}

	/** BitBlt: src's rectangle at sx, sy, w × h, into dst at dx, dy, clipped to dst and to clip. */
	blit(
		dst: Target,
		dx: number,
		dy: number,
		src: Form,
		sx = 0,
		sy = 0,
		w = src.w,
		h = src.h,
		rule: Rule = "copy",
		clip?: Rect,
	) {
		if (recording(dst)) {
			// the rectangle's pixels, copied: the op is data, and the source may change
			w = Math.max(0, Math.min(w, src.w - sx))
			h = Math.max(0, Math.min(h, src.h - sy))
			const bits = new Uint32Array(w * h)
			for (let y = 0; y < h; y++) {
				bits.set(src.bits.subarray((sy + y) * src.w + sx, (sy + y) * src.w + sx + w), y * w)
			}
			return void dst.ops.push({
				op: "pixels",
				x: dx,
				y: dy,
				w,
				h,
				bits,
				...(rule !== "copy" ? { rule } : {}),
				...(clip ? { clip } : {}),
			})
		}
		// the source rectangle, inside the source
		if (sx < 0) {
			dx -= sx
			w += sx
			sx = 0
		}
		if (sy < 0) {
			dy -= sy
			h += sy
			sy = 0
		}
		w = Math.min(w, src.w - sx)
		h = Math.min(h, src.h - sy)
		const r = this.#clip(dst, { x: dx, y: dy, w, h }, clip)
		if (r.w <= 0 || r.h <= 0) return
		const ox = sx + (r.x - dx), oy = sy + (r.y - dy)
		for (let y = 0; y < r.h; y++) {
			const s = (oy + y) * src.w + ox
			const d = (r.y + y) * dst.w + r.x
			if (rule === "copy") {
				dst.bits.set(src.bits.subarray(s, s + r.w), d)
				continue
			}
			for (let x = 0; x < r.w; x++) {
				const p = src.bits[s + x]
				if (rule === "over") {
					if (p >>> 0 !== TRANSPARENT) dst.bits[d + x] = p & 0xffffff
				} else {
					const a = 255 - ((p >>> 24) & 255)
					if (a) dst.bits[d + x] = a === 255 ? p & 0xffffff : mix(dst.bits[d + x], p, a)
				}
			}
		}
	}

	/**
	 * A line from x0, y0 to x1, y1, both ends drawn, width pixels across in a
	 * round pen (1 if less, or not given): Plan 9's line, whose thick t is
	 * width 1 + 2t.
	 */
	line(
		dst: Target,
		x0: number,
		y0: number,
		x1: number,
		y1: number,
		width: number | undefined,
		color: number,
		clip?: Rect,
	) {
		if (recording(dst)) {
			return void dst.ops.push({
				op: "line",
				x0,
				y0,
				x1,
				y1,
				...(width !== undefined && width !== 1 ? { width } : {}),
				color,
				...(clip ? { clip } : {}),
			})
		}
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		if (r.w <= 0 || r.h <= 0) return
		const s = spans(r), p = pen(whole(width ?? 1, 1, WIDEST))
		walk(
			s,
			p,
			whole(x0, -FAR, FAR),
			whole(y0, -FAR, FAR),
			whole(x1, -FAR, FAR),
			whole(y1, -FAR, FAR),
		)
		paint(dst, s, color)
	}

	/**
	 * Lines from each point to the next, each as line draws it: Plan 9's poly.
	 * points are x, y, x, y...; closed only if the last point is the first.
	 */
	poly(
		dst: Target,
		points: ArrayLike<number>,
		width: number | undefined,
		color: number,
		clip?: Rect,
	) {
		if (recording(dst)) {
			return void dst.ops.push({
				op: "poly",
				points: Array.from(points),
				...(width !== undefined && width !== 1 ? { width } : {}),
				color,
				...(clip ? { clip } : {}),
			})
		}
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		const n = (points?.length ?? 0) >> 1
		if (r.w <= 0 || r.h <= 0 || !n) return
		const s = spans(r), p = pen(whole(width ?? 1, 1, WIDEST))
		const at = (i: number, k: number) => whole(points[2 * i + k], -FAR, FAR)
		// one point is a dot; each line is painted alone, as its rows are one span each
		for (let i = 0; i < Math.max(1, n - 1); i++) {
			const j = Math.min(i + 1, n - 1)
			walk(s, p, at(i, 0), at(i, 1), at(j, 0), at(j, 1))
			paint(dst, s, color)
		}
	}

	/**
	 * A polygon filled: Plan 9's fillpoly. points are x, y, x, y..., and the
	 * last joins the first. A pixel is in when its centre is inside, by wind.
	 */
	fillpoly(
		dst: Target,
		points: ArrayLike<number>,
		wind: Wind | undefined,
		color: number,
		clip?: Rect,
	) {
		if (recording(dst)) {
			return void dst.ops.push({
				op: "fillpoly",
				points: Array.from(points),
				...(wind === "odd" ? { wind } : {}),
				color,
				...(clip ? { clip } : {}),
			})
		}
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		const n = (points?.length ?? 0) >> 1
		if (r.w <= 0 || r.h <= 0 || !n) return
		const xs = new Array<number>(n), ys = new Array<number>(n)
		let top = FAR, bottom = -FAR
		for (let i = 0; i < n; i++) {
			xs[i] = whole(points[2 * i], -FAR, FAR)
			ys[i] = whole(points[2 * i + 1], -FAR, FAR)
			top = Math.min(top, ys[i])
			bottom = Math.max(bottom, ys[i])
		}
		top = Math.max(top, r.y)
		bottom = Math.min(bottom, r.y + r.h)
		const odd = wind === "odd"
		const cross: [number, number][] = []
		for (let y = top; y < bottom; y++) {
			// where each edge crosses the row's centre line: the first pixel whose centre is right of it, and which way it goes
			cross.length = 0
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n
				let x0 = xs[i], y0 = ys[i], x1 = xs[j], y1 = ys[j], dir = 1
				if (y0 === y1) continue
				if (y0 > y1) {
					;[x0, y0, x1, y1, dir] = [x1, y1, x0, y0, -1]
				}
				if (y < y0 || y >= y1) continue
				// x at y + 1/2, less 1/2, rounded up: ((2x0 - 1)(y1 - y0) + (2y + 1 - 2y0)(x1 - x0)) / 2(y1 - y0)
				cross.push([
					up((2 * x0 - 1) * (y1 - y0) + (2 * y + 1 - 2 * y0) * (x1 - x0), 2 * (y1 - y0)),
					dir,
				])
			}
			cross.sort((a, b) => a[0] - b[0])
			let turns = 0
			for (let k = 0; k + 1 < cross.length; k++) {
				turns += cross[k][1]
				const a = Math.max(cross[k][0], r.x), b = Math.min(cross[k + 1][0], r.x + r.w)
				if ((odd ? turns % 2 !== 0 : turns !== 0) && a < b) {
					dst.bits.fill(color, y * dst.w + a, y * dst.w + b)
				}
			}
		}
	}

	/**
	 * An ellipse's outline, centred on x, y, rx pixels across from it and ry
	 * down, width pixels across in a round pen (1 if less, or not given):
	 * Plan 9's ellipse.
	 */
	ellipse(
		dst: Target,
		x: number,
		y: number,
		rx: number,
		ry: number,
		width: number | undefined,
		color: number,
		clip?: Rect,
	) {
		if (recording(dst)) {
			return void dst.ops.push({
				op: "ellipse",
				x,
				y,
				rx,
				ry,
				...(width !== undefined && width !== 1 ? { width } : {}),
				color,
				...(clip ? { clip } : {}),
			})
		}
		const a = whole(rx, -1, RADIUS), b = whole(ry, -1, RADIUS)
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return
		const cx = whole(x, -FAR, FAR),
			cy = whole(y, -FAR, FAR),
			p = pen(whole(width ?? 1, 1, WIDEST))
		// a quarter at a time, so that each quarter's pixels on a row are one span
		const q = [spans(r), spans(r), spans(r), spans(r)]
		arc(a, b, (px, py) => {
			stamp(q[0], p, cx + px, cy + py)
			stamp(q[1], p, cx - px, cy + py)
			stamp(q[2], p, cx - px, cy - py)
			stamp(q[3], p, cx + px, cy - py)
		})
		for (const s of q) paint(dst, s, color)
	}

	/** An ellipse filled, its outline's pixels with it: Plan 9's fillellipse. */
	fillellipse(
		dst: Target,
		x: number,
		y: number,
		rx: number,
		ry: number,
		color: number,
		clip?: Rect,
	) {
		if (recording(dst)) {
			return void dst.ops.push({
				op: "fillellipse",
				x,
				y,
				rx,
				ry,
				color,
				...(clip ? { clip } : {}),
			})
		}
		const a = whole(rx, -1, RADIUS), b = whole(ry, -1, RADIUS)
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return
		const cx = whole(x, -FAR, FAR), cy = whole(y, -FAR, FAR), s = spans(r)
		arc(a, b, (px, py) => {
			mark(s, cy + py, cx - px, cx + px)
			mark(s, cy - py, cx - px, cx + px)
		})
		paint(dst, s, color)
	}

	/**
	 * Text, its top left at x, y; on bg, or over what is there. Gives the x it
	 * ended at. In font if given, else in the font ROM's cells.
	 */
	text(
		dst: Target,
		x: number,
		y: number,
		s: string,
		fg: number,
		bg?: number,
		clip?: Rect,
		font?: Font,
	): number {
		if (recording(dst)) {
			dst.ops.push({
				op: "text",
				x,
				y,
				text: s,
				color: fg,
				font: font?.role ?? null,
				...(bg !== undefined ? { bg } : {}),
				...(clip ? { clip } : {}),
			})
			return x + this.measure(s, font)
		}
		if (font) return this.#proportional(dst, x, y, s, fg, bg, clip, font)
		const { w: cw, h: ch, alpha } = this.font
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		for (const c of s) {
			const at = this.#glyphs.get(c) ?? this.#glyphs.get("?")!
			if (bg !== undefined) this.fill(dst, x, y, cw, ch, bg, clip)
			this.#coverage(dst, r, x, y, alpha, cw, at, cw, ch, fg)
			x += cw
		}
		return x
	}

	#proportional(
		dst: Form,
		x: number,
		y: number,
		s: string,
		fg: number,
		bg: number | undefined,
		clip: Rect | undefined,
		font: Font,
	): number {
		const r = this.#clip(dst, { x: 0, y: 0, w: dst.w, h: dst.h }, clip)
		let pen = x
		for (const c of s) {
			const cp = c.codePointAt(0)!
			const page = font.page(cp >> 8)
			// a page still coming: a gap, until it comes and the text is drawn again
			if (!page) {
				pen += font.ascent / 2
				continue
			}
			const i = (cp & 255) * 4
			const sx = page.info[i],
				left = page.info[i + 1],
				w = page.info[i + 2],
				advance = page.info[i + 3]
			if (bg !== undefined) {
				this.fill(
					dst,
					Math.round(pen),
					y,
					Math.round(pen + advance) - Math.round(pen),
					font.h,
					bg,
					clip,
				)
			}
			if (w) {
				this.#coverage(dst, r, Math.round(pen) + left, y, page.alpha, page.w, sx, w, font.h, fg)
			}
			pen += advance
		}
		return Math.round(pen)
	}

	/** w × h of coverage, from alpha at offset at with rows of stride, as fg onto dst at x, y, inside r. */
	#coverage(
		dst: Form,
		r: Rect,
		x: number,
		y: number,
		alpha: Uint8Array,
		stride: number,
		at: number,
		w: number,
		h: number,
		fg: number,
	) {
		const y0 = Math.max(y, r.y), y1 = Math.min(y + h, r.y + r.h)
		const x0 = Math.max(x, r.x), x1 = Math.min(x + w, r.x + r.w)
		for (let ty = y0; ty < y1; ty++) {
			const row = at + (ty - y) * stride - x
			const d = ty * dst.w
			for (let tx = x0; tx < x1; tx++) {
				const a = alpha[row + tx]
				if (!a) continue
				dst.bits[d + tx] = a === 255 ? fg : mix(dst.bits[d + tx], fg, a)
			}
		}
	}

	/** How wide a string is, in font if given. */
	measure(s: string, font?: Font): number {
		if (!font) return [...s].length * this.font.w
		let pen = 0
		for (const c of s) {
			const cp = c.codePointAt(0)!
			const page = font.page(cp >> 8)
			pen += page ? page.info[(cp & 255) * 4 + 3] : font.ascent / 2
		}
		return Math.round(pen)
	}

	/** The caret offset (UTF-16) in s nearest to dx pixels from its start, in font if given: for a click. */
	at(s: string, dx: number, font?: Font): number {
		let pen = 0, i = 0
		for (const c of s) {
			const cp = c.codePointAt(0)!
			let advance: number
			if (!font) advance = this.font.w
			else {
				const page = font.page(cp >> 8)
				advance = page ? page.info[(cp & 255) * 4 + 3] : font.ascent / 2
			}
			if (pen + advance / 2 > dx) return i
			pen += advance
			i += c.length
		}
		return s.length
	}

	/**
	 * Plays ops into a form, as the compositor does a layer's: gives where
	 * each text run went. marks are ranges of runs to draw on a highlighter,
	 * by op: [from, to], UTF-16 offsets.
	 */
	play(
		dst: Form,
		ops: readonly Op[],
		fonts: (role: string) => Font | undefined,
		marks?: Map<number, [number, number]>,
		mark = 0xffff88,
	): Run[] {
		const runs: Run[] = []
		ops.forEach((o, i) => {
			if (o.op === "fill") this.fill(dst, o.x, o.y, o.w, o.h, o.color, o.clip)
			else if (o.op === "frame") this.frame(dst, o.x, o.y, o.w, o.h, o.color, o.clip)
			else if (o.op === "pixels" && o.repl) {
				this.tile(
					dst,
					o.x,
					o.y,
					o.w,
					o.h,
					{ w: o.repl.w, h: o.repl.h, bits: o.bits },
					o.rule ?? "copy",
					o.clip,
				)
			} else if (o.op === "pixels") {
				this.blit(
					dst,
					o.x,
					o.y,
					{ w: o.w, h: o.h, bits: o.bits },
					0,
					0,
					o.w,
					o.h,
					o.rule ?? "copy",
					o.clip,
				)
			} else if (o.op === "text") {
				const font = o.font ? fonts(o.font) : undefined
				const w = this.measure(o.text, font), h = this.height(font)
				runs.push({ op: i, x: o.x, y: o.y, w, h, text: o.text, font: o.font })
				if (o.bg !== undefined) this.fill(dst, o.x, o.y, w, h, o.bg, o.clip)
				const m = marks?.get(i)
				if (m) {
					const a = o.x + this.measure(o.text.slice(0, m[0]), font),
						b = o.x + this.measure(o.text.slice(0, m[1]), font)
					this.fill(dst, a, o.y, b - a, h, mark, o.clip)
				}
				this.text(dst, o.x, o.y, o.text, o.color, undefined, o.clip, font)
			} else if (o.op === "line") {
				this.line(dst, o.x0, o.y0, o.x1, o.y1, o.width, o.color, o.clip)
			} else if (o.op === "ellipse") {
				this.ellipse(dst, o.x, o.y, o.rx, o.ry, o.width, o.color, o.clip)
			} else if (o.op === "fillellipse") {
				this.fillellipse(dst, o.x, o.y, o.rx, o.ry, o.color, o.clip)
			} else if (o.op === "poly") this.poly(dst, o.points, o.width, o.color, o.clip)
			else if (o.op === "fillpoly") this.fillpoly(dst, o.points, o.wind, o.color, o.clip)
		})
		return runs
	}

	/**
	 * The text between two points over a layer's runs, as a person drags
	 * across it: in reading order, top to bottom, then left to right; a run on
	 * a lower line starts a new line, and a gap on one line is a space.
	 */
	select(
		runs: readonly Run[],
		from: [number, number],
		to: [number, number],
		fonts: (role: string) => Font | undefined,
	): Selected {
		const order = [...runs].sort((a, b) => a.y - b.y || a.x - b.x)
		if (!order.length) return { ranges: [], text: "" }
		const font = (r: Run) => (r.font ? fonts(r.font) : undefined)
		// a point's place: [run, offset] in reading order
		const place = ([px, py]: [number, number]): [number, number] => {
			const line = order.map((r, k) => [r, k] as const).filter(([r]) =>
				py >= r.y && py < r.y + r.h
			)
			if (line.length) {
				const [first, k0] = line[0], [last, k1] = line.at(-1)!
				if (px < first.x) return [k0, 0]
				for (const [r, k] of line) {
					if (px < r.x + r.w) return [k, this.at(r.text, px - r.x, font(r))]
				}
				return [k1, last.text.length]
			}
			const below = order.findIndex((r) => r.y > py)
			return below >= 0 ? [below, 0] : [order.length - 1, order.at(-1)!.text.length]
		}
		let a = place(from), b = place(to)
		if (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1])) [a, b] = [b, a]
		const ranges: [number, number, number][] = []
		let text = ""
		let prev: Run | null = null
		for (let k = a[0]; k <= b[0]; k++) {
			const r = order[k]
			const from = k === a[0] ? a[1] : 0, to = k === b[0] ? b[1] : r.text.length
			if (to <= from) continue
			if (prev) {
				if (r.y >= prev.y + prev.h / 2) text += "\n"
				else if (r.x - (prev.x + prev.w) > prev.h / 4) text += " "
			}
			ranges.push([r.op, from, to])
			text += r.text.slice(from, to)
			prev = r
		}
		return { ranges, text }
	}

	/** How tall a line is, in font if given. */
	height(font?: Font): number {
		return font ? font.h : this.font.h
	}

	/** How many of s's characters fit in w pixels, in font if given: for wrapping and for finding a click. */
	fit(s: string, w: number, font?: Font): number {
		if (!font) return Math.max(0, Math.min([...s].length, Math.floor(w / this.font.w)))
		let pen = 0, n = 0
		for (const c of s) {
			const cp = c.codePointAt(0)!
			const page = font.page(cp >> 8)
			pen += page ? page.info[(cp & 255) * 4 + 3] : font.ascent / 2
			if (pen > w) break
			n++
		}
		return n
	}

	toString() {
		return `blitter: copy, over and blend; text in ${this.font.w}x${this.font.h} cells, or in a font`
	}
}

function mix(bg: number, fg: number, a: number): number {
	const m = (s: number) => ((((bg >> s) & 255) * (255 - a) + ((fg >> s) & 255) * a) / 255) | 0
	return (m(16) << 16) | (m(8) << 8) | m(0)
}

// The limits of line, poly, fillpoly, ellipse and fillellipse: past them a
// number is held at them, so that doubles here and integers in C draw the
// same pixels, and a far point never runs long.
const FAR = 1 << 20, RADIUS = 1 << 16, WIDEST = 4096

/** n as a whole number (floor), from lo to hi; not a number is 0 */
function whole(n: number, lo: number, hi: number): number {
	const v = Math.floor(n)
	return Math.max(lo, Math.min(hi, Number.isNaN(v) ? 0 : v))
}

/** n / d rounded up, exactly, for whole n and d > 0 */
function up(n: number, d: number): number {
	let q = Math.ceil(n / d)
	while (q * d < n) q++
	while ((q - 1) * d >= n) q--
	return q
}

/** For each row of r, the leftmost and rightmost pixel marked on it; top to bottom, the rows marked. */
type Spans = { r: Rect; lo: Int32Array; hi: Int32Array; top: number; bottom: number }

function spans(r: Rect): Spans {
	return {
		r,
		lo: new Int32Array(r.h).fill(0x7fffffff),
		hi: new Int32Array(r.h).fill(-0x80000000),
		top: r.h,
		bottom: 0,
	}
}

/** x0 to x1 on row y, if it is one of r's */
function mark(s: Spans, y: number, x0: number, x1: number) {
	const k = y - s.r.y
	if (k < 0 || k >= s.r.h) return
	if (x0 < s.lo[k]) s.lo[k] = x0
	if (x1 > s.hi[k]) s.hi[k] = x1
	if (k < s.top) s.top = k
	if (k + 1 > s.bottom) s.bottom = k + 1
}

/** Each marked row's span, inside r, in color; then no row is marked. */
function paint(dst: Form, s: Spans, color: number) {
	const { r, lo, hi } = s
	for (let k = s.top; k < s.bottom; k++) {
		const a = Math.max(lo[k], r.x), b = Math.min(hi[k], r.x + r.w - 1)
		if (a <= b) dst.bits.fill(color, (r.y + k) * dst.w + a, (r.y + k) * dst.w + b + 1)
		lo[k] = 0x7fffffff
		hi[k] = -0x80000000
	}
	s.top = r.h
	s.bottom = 0
}

/**
 * A round pen w pixels across: for each of its rows, how far in from its
 * box's left the row's span starts. A pixel is in when its centre is within
 * w / 2 of the box's centre.
 */
function pen(w: number): Int32Array {
	const c = w - 1, l = new Int32Array(w)
	let i = c >> 1
	for (let j = 0; j <= c >> 1; j++) {
		while (i > 0 && (2 * i - 2 - c) ** 2 + (2 * j - c) ** 2 <= w * w) i--
		l[j] = l[c - j] = i
	}
	return l
}

/**
 * The pen at x, y, its box's centre (an even pen's extra row and column
 * right and below), marked if its box meets r: it does not reach r
 * otherwise, and the pens around it fill each row's span.
 */
function stamp(s: Spans, p: Int32Array, x: number, y: number) {
	const w = p.length, bx = x - ((w - 1) >> 1), by = y - ((w - 1) >> 1), r = s.r
	if (bx >= r.x + r.w || bx + w <= r.x || by >= r.y + r.h || by + w <= r.y) return
	const j1 = Math.min(w, r.y + r.h - by)
	for (let j = Math.max(0, r.y - by); j < j1; j++) mark(s, by + j, bx + p[j], bx + w - 1 - p[j])
}

/** The pen along a line, Bresenham's: a step in x, in y, or both, whichever stays nearer the line. */
function walk(s: Spans, p: Int32Array, x: number, y: number, ex: number, ey: number) {
	const dx = Math.abs(ex - x), dy = -Math.abs(ey - y), sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1
	let err = dx + dy
	for (;;) {
		stamp(s, p, x, y)
		if (x === ex && y === ey) return
		const e2 = 2 * err
		if (e2 >= dy) {
			err += dy
			x += sx
		}
		if (e2 <= dx) {
			err += dx
			y += sy
		}
	}
}

/**
 * A quarter of an ellipse a across and b down, from (a, 0) to (0, b), each
 * point a step from the last: Zingl's, its errors whole numbers.
 */
function arc(a: number, b: number, plot: (x: number, y: number) => void) {
	let x = -a, y = 0, e2 = b * b, err = x * (2 * e2 + x) + e2
	do {
		plot(-x, y)
		e2 = 2 * err
		if (e2 >= (x * 2 + 1) * b * b) err += (++x * 2 + 1) * b * b
		if (e2 <= (y * 2 + 1) * a * a) err += (++y * 2 + 1) * a * a
	} while (x <= 0)
	// a flat ellipse stops early: its tip
	while (y++ < b) plot(0, y)
}
