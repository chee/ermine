/// <reference lib="dom" />
// the pond's pictures: little pixel sprites drawn from letter maps, a pond to put them in, and a
// chart of a number over time. all drawn on a canvas, pixelated, so they stay crisp at any zoom.
//
//   const pond = createPond(canvas, { width: 240, height: 140 })
//   pond.draw({ fish: 6, minnows: 12, pike: 1, lilies: 3, rain: 0.5 })
//
// letters: K ink, W white, O orange, o dark orange, G green, g dark green, B blue, b pale blue,
// Y yellow, y dark yellow, P cherry, S grey, s pale grey, N brown, n dark brown, . nothing

export const COLOURS: Record<string, string> = {
	p: "#f6a9c4",
	q: "#e27aa0",
	r: "#c0392b",
	K: "#000",
	W: "#fff",
	O: "#ff8a1f",
	o: "#d9520a",
	G: "#40dcba",
	g: "#13917a",
	B: "#2269ff",
	b: "#9fc0ff",
	Y: "#ffe23d",
	y: "#d3a800",
	P: "#ff2284",
	S: "#9a9a9a",
	s: "#dadada",
	N: "#b9844f",
	n: "#7a5230",
}

export const SPRITES = {
	fish: [
		"......oooo..",
		"o...oOOOOOo.",
		"oo.oOOOOOWKo",
		"oOoOOOOOOOOo",
		"oo.oOOOOOOOo",
		"o...oOOOOOo.",
		"......oooo..",
	],
	minnow: [
		"g..ggg.",
		"gggGGKg",
		"g..ggg.",
	],
	pike: [
		".......gggggg...",
		"g...ggGGGGGGGGg.",
		"gg.gGGGGGGGGGWKg",
		"g...ggGGGGGGGGg.",
		".......gggggg...",
	],
	lily: [
		"..gggg..",
		".gGGGGg.",
		"gGGG..Gg",
		".gGGGGg.",
		"..gggg..",
	],
	flower: [
		".P.P.",
		"PPWPP",
		".PPP.",
		"..g..",
	],
	cloud: [
		"....WWW.....",
		"..WWWWWWW...",
		".WWWWWWWWWW.",
		"WWWWWWWWWWWW",
		".ssssssssss.",
	],
	letter: [
		"KKKKKKKKKK",
		"KWKWWWWKWK",
		"KWWKWWKWWK",
		"KWWWKKWWWK",
		"KWWWWWWWWK",
		"KKKKKKKKKK",
	],
	egg: [
		".YY.",
		"YWYY",
		"YYYY",
		".YY.",
	],
	duck: [
		"....yYY...",
		"...YYKY...",
		"...YYYYOO.",
		"Y..YYYY...",
		"YYYYYYYYY.",
		"YYYYYYYYYY",
		".yyyyyyyy.",
	],
	camera: [
		"..KKK.....",
		"KKKKKKKKKK",
		"KsssKKKssK",
		"KssKWWKssK",
		"KssKWBKssK",
		"KsssKKsssK",
		"KKKKKKKKKK",
	],
	pig: [
		"..KK.........KK...",
		".KppK.......KppK..",
		".KpppKKKKKKKKpppK.",
		"KppppppppppppppppK",
		"KpppKppKppppppppqK",
		"KqqqqppppppppppppK",
		"KqKqKppppppppppppK",
		"KqqqqppppppppppppK",
		".KpppppppppppppqK.",
		"..KKpKKKKKKKKpKK..",
		"...KK........KK...",
	],
	apple: [
		"..g.",
		".rrr",
		"rrrr",
		"rrrr",
		".rr.",
	],
	ermine: [
		"..W...W.....",
		".WWW.WWW....",
		".WKWWWKW....",
		".WWWKWWW....",
		"..WWWWW.....",
		"..WWWWWW....",
		".WWWWWWWW...",
		".WWWWWWWW.WK",
		".WWWWWWWWWWK",
		"..WW..WW....",
	],
} satisfies Record<string, string[]>

export type SpriteName = keyof typeof SPRITES

// draw a sprite at (x, y) in sprite pixels times scale; flip faces it left
export function sprite(
	ctx: CanvasRenderingContext2D,
	name: SpriteName,
	x: number,
	y: number,
	scale = 1,
	flip = false,
) {
	pixels(ctx, SPRITES[name], x, y, scale, flip)
}

// draw any letter map (a page's own sprite), with the same letters as SPRITES
export function pixels(
	ctx: CanvasRenderingContext2D,
	rows: readonly string[],
	x: number,
	y: number,
	scale = 1,
	flip = false,
) {
	const w = rows[0].length
	for (let j = 0; j < rows.length; j++) {
		for (let i = 0; i < w; i++) {
			const c = rows[j][flip ? w - 1 - i : i]
			if (c === ".") continue
			ctx.fillStyle = COLOURS[c]
			ctx.fillRect(Math.round(x + i * scale), Math.round(y + j * scale), scale, scale)
		}
	}
}

// a sprite as its own little canvas element, for putting inline in a box or a label
export function icon(name: SpriteName, scale = 2): HTMLCanvasElement {
	const rows = SPRITES[name]
	const c = document.createElement("canvas")
	c.width = rows[0].length * scale
	c.height = rows.length * scale
	c.className = "icon"
	sprite(c.getContext("2d")!, name, 0, 0, scale)
	return c
}

// a sprite with some letters swapped: recolour("fish", { O: "P", o: "P" }) is a pink fish
export function recolour(name: SpriteName, swap: Record<string, string>): string[] {
	return SPRITES[name].map((r) => [...r].map((c) => swap[c] ?? c).join(""))
}

// device pixels per picture pixel for the big pictures: shown at about 2x and zoomed up to 2.5x on
// the board, times the screen's own density, whole
export const sharpness = () => Math.max(2, Math.ceil((globalThis.devicePixelRatio || 1) * 3))

// a seeded wobble, so the same creature swims the same way every draw
function rand(seed: number) {
	let s = seed * 9301 + 49297
	return () => (s = (s * 9301 + 49297) % 233280) / 233280
}

export type PondScene = {
	fish?: number
	minnows?: number
	pike?: number
	lilies?: number
	eggs?: number
	// 0..1: how much rain is falling
	rain?: number
	// 0..1: how green the water is
	algae?: number
	// a word or two on a little sign in the corner
	sign?: string
	// creatures that have names: drawn with their name over them, at their own spot
	// rows: a letter map of its own, drawn in place of kind's (a fish in another colour)
	named?: {
		name: string
		kind: SpriteName
		rows?: readonly string[]
		x: number
		y: number
		tone?: "hot" | "ok" | "dim"
	}[]
	// grey it out: "this is the old picture"
	stale?: boolean
}

export type Pond = {
	readonly canvas: HTMLCanvasElement
	draw(s: PondScene): void
}

// a pond on a canvas: water, bank, lilies, creatures. it swims gently unless the reader asked
// for less motion; the same scene always puts each creature at the same home spot
export function createPond(
	canvas: HTMLCanvasElement,
	{ width = 240, height = 140 }: { width?: number; height?: number } = {},
): Pond {
	// drawn at the screen's own resolution, a whole number of device pixels per picture pixel:
	// pixels stay square and sharp, and the words on it are drawn sharp, not blown up
	const S = sharpness()
	canvas.width = width * S
	canvas.height = height * S
	canvas.classList.add("pond")
	const ctx = canvas.getContext("2d")!
	let scene: PondScene = {}
	const still = matchMedia("(prefers-reduced-motion: reduce)").matches
	let t = 0
	const water = (a: number) => {
		// blue to green with algae
		const b = [0x22, 0x69, 0xff], g = [0x2a, 0xa8, 0x6a]
		const m = b.map((v, i) => Math.round(v + (g[i] - v) * a))
		return `rgb(${m.join(",")})`
	}
	function frame() {
		const s = scene
		ctx.setTransform(S, 0, 0, S, 0, 0)
		ctx.imageSmoothingEnabled = false
		// bank
		ctx.fillStyle = "#e9d9a6"
		ctx.fillRect(0, 0, width, height)
		ctx.fillStyle = "#cdb877"
		for (let i = 0; i < 40; i++) {
			const r = rand(i + 7)
			ctx.fillRect(Math.floor(r() * width), Math.floor(r() * height), 1, 1)
		}
		// water: a rounded pond
		const pad = 8
		ctx.fillStyle = water(Math.min(1, Math.max(0, s.algae ?? 0)))
		ctx.beginPath()
		ctx.roundRect(pad, pad, width - pad * 2, height - pad * 2, 18)
		ctx.fill()
		ctx.strokeStyle = "#7a5230"
		ctx.lineWidth = 2
		ctx.stroke()
		// ripples
		ctx.fillStyle = "rgba(255,255,255,.35)"
		for (let i = 0; i < 10; i++) {
			const r = rand(i + 100)
			const x = pad + 10 + r() * (width - pad * 2 - 30)
			const y = pad + 8 + r() * (height - pad * 2 - 16)
			const len = 4 + Math.floor(r() * 6)
			ctx.fillRect(Math.round(x + Math.sin(t / 900 + i) * 2), Math.round(y), len, 1)
		}
		const inner = { x: pad + 6, y: pad + 6, w: width - pad * 2 - 12, h: height - pad * 2 - 12 }
		const place = (seed: number, w: number, hgt: number, drift = 6) => {
			const r = rand(seed)
			const hx = inner.x + r() * Math.max(1, inner.w - w)
			const hy = inner.y + r() * Math.max(1, inner.h - hgt)
			const ph = r() * 6.28, sp = 0.4 + r() * 0.6
			const dx = still ? 0 : Math.sin(t / 1400 * sp + ph) * drift
			const dy = still ? 0 : Math.cos(t / 1900 * sp + ph) * 1.5
			return { x: hx + dx, y: hy + dy, left: !still && Math.cos(t / 1400 * sp + ph) < 0 }
		}
		for (let i = 0; i < Math.min(40, s.lilies ?? 0); i++) {
			const p = place(500 + i, 8, 5, 0)
			sprite(ctx, i % 3 === 2 ? "flower" : "lily", p.x, p.y)
		}
		for (let i = 0; i < Math.min(60, s.eggs ?? 0); i++) {
			const p = place(700 + i, 4, 4, 0)
			sprite(ctx, "egg", p.x, p.y)
		}
		for (let i = 0; i < Math.min(80, Math.round(s.minnows ?? 0)); i++) {
			const p = place(300 + i, 7, 3, 10)
			sprite(ctx, "minnow", p.x, p.y, 1, p.left)
		}
		for (let i = 0; i < Math.min(40, Math.round(s.fish ?? 0)); i++) {
			const p = place(1 + i, 12, 7, 8)
			sprite(ctx, "fish", p.x, p.y, 1, p.left)
		}
		for (let i = 0; i < Math.min(6, Math.round(s.pike ?? 0)); i++) {
			const p = place(900 + i, 16, 5, 14)
			sprite(ctx, "pike", p.x, p.y, 1, p.left)
		}
		for (const n of s.named ?? []) {
			const rows = n.rows ?? SPRITES[n.kind]
			const x = inner.x + n.x * (inner.w - rows[0].length)
			const y = inner.y + 7 + n.y * (inner.h - rows.length - 7)
			const wob = still ? 0 : Math.sin(t / 1100 + n.x * 9) * 1.5
			if (n.tone === "dim") ctx.globalAlpha = 0.35
			pixels(ctx, rows, x + wob, y)
			ctx.globalAlpha = 1
			ctx.font = "7px Monaco, ui-monospace, monospace"
			const tw = ctx.measureText(n.name).width
			ctx.fillStyle = n.tone === "hot" ? "#ff2284" : n.tone === "ok" ? "#13917a" : "#000"
			ctx.fillRect(
				Math.round(x + rows[0].length / 2 - tw / 2 - 2),
				Math.round(y - 9),
				Math.ceil(tw) + 4,
				8,
			)
			ctx.fillStyle = "#fff"
			ctx.fillText(n.name, Math.round(x + rows[0].length / 2 - tw / 2), Math.round(y - 3))
		}
		// rain
		const rain = Math.min(1, Math.max(0, s.rain ?? 0))
		if (rain > 0) {
			ctx.fillStyle = "rgba(255,255,255,.75)"
			const n = Math.round(rain * 60)
			for (let i = 0; i < n; i++) {
				const r = rand(i + 2000)
				const x = r() * width
				const y = (r() * height + (still ? 0 : t / 6)) % height
				ctx.fillRect(Math.round(x), Math.round(y), 1, 3)
			}
			sprite(ctx, "cloud", width - 40, 2, 2)
		}
		if (s.sign) {
			ctx.font = "8px Monaco, ui-monospace, monospace"
			const tw = ctx.measureText(s.sign).width
			ctx.fillStyle = "#fff"
			ctx.fillRect(4, height - 15, tw + 8, 11)
			ctx.strokeStyle = "#000"
			ctx.lineWidth = 1
			ctx.strokeRect(4.5, height - 14.5, tw + 7, 10)
			ctx.fillStyle = "#000"
			ctx.fillText(s.sign, 8, height - 6)
		}
		if (s.stale) {
			ctx.fillStyle = "rgba(240,240,240,.55)"
			ctx.fillRect(0, 0, width, height)
		}
	}
	let running = false
	const loop = (now: number) => {
		t = now
		frame()
		if (!still && canvas.isConnected) requestAnimationFrame(loop)
		else running = false
	}
	return {
		canvas,
		draw(s) {
			scene = s
			frame()
			if (!still && !running) {
				running = true
				requestAnimationFrame(loop)
			}
		},
	}
}

// a number over time: a little line chart, the last point marked
export function chart(
	canvas: HTMLCanvasElement,
	points: number[],
	{ width = 220, height = 90, colour = "#ff2284", min, max }: {
		width?: number
		height?: number
		colour?: string
		min?: number
		max?: number
	} = {},
) {
	const dpr = sharpness()
	canvas.width = width * dpr
	canvas.height = height * dpr
	canvas.style.width = `${width}px`
	canvas.style.height = `${height}px`
	const ctx = canvas.getContext("2d")!
	ctx.scale(dpr, dpr)
	ctx.clearRect(0, 0, width, height)
	ctx.fillStyle = "#fff"
	ctx.fillRect(0, 0, width, height)
	const lo = min ?? Math.min(0, ...points), hi = max ?? Math.max(1, ...points)
	const px = (i: number) => 24 + (i / Math.max(1, points.length - 1)) * (width - 32)
	const py = (v: number) => height - 14 - ((v - lo) / (hi - lo || 1)) * (height - 24)
	ctx.strokeStyle = "#e6e6e6"
	ctx.lineWidth = 1
	for (let g = 0; g <= 4; g++) {
		const y = Math.round(10 + g * (height - 24) / 4) + 0.5
		ctx.beginPath()
		ctx.moveTo(24, y)
		ctx.lineTo(width - 8, y)
		ctx.stroke()
	}
	ctx.fillStyle = "#666"
	ctx.font = "9px Monaco, ui-monospace, monospace"
	ctx.fillText(String(Math.round(hi)), 2, 14)
	ctx.fillText(String(Math.round(lo)), 2, height - 12)
	if (!points.length) return
	ctx.strokeStyle = colour
	ctx.lineWidth = 2
	ctx.beginPath()
	points.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))))
	ctx.stroke()
	const l = points.length - 1
	ctx.fillStyle = colour
	ctx.beginPath()
	ctx.arc(px(l), py(points[l]), 3.5, 0, 6.29)
	ctx.fill()
}
