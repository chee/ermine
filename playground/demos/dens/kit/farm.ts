/// <reference lib="dom" />
// the farm: a field with a mud puddle and a trough, and pigs on it. a pig is drawn bigger the more
// it weighs, with its name over it. still: pigs wander a little unless the reader asked for less
// motion.
//
//   const farm = createFarm(canvas)
//   farm.draw({ pigs: [{ name: "wilbur", weight: 12, x: 0.3, y: 0.6 }], apples: 3 })
import { pixels, sharpness, sprite, SPRITES } from "./sprites.ts"

export type FarmPig = {
	name: string
	weight: number
	// where it stands, as fractions of the field
	x: number
	y: number
	tone?: "hot" | "ok" | "dim" | "pick"
	// a word bubble over it
	says?: string
}

export type FarmScene = {
	pigs: FarmPig[]
	apples?: number
	night?: boolean
	sign?: string
	// greyed: an old picture
	stale?: boolean
}

// how big a pig of this weight is drawn: 1x to 3x
export const pigScale = (w: number) => Math.max(1, Math.min(3, Math.round(1 + (w - 5) / 10)))

export function createFarm(
	canvas: HTMLCanvasElement,
	{ width = 240, height = 140 }: { width?: number; height?: number } = {},
) {
	// drawn at the screen's own resolution, a whole number of device pixels per picture pixel:
	// pixels stay square and sharp, and the words on it are drawn sharp, not blown up
	const S = sharpness()
	canvas.width = width * S
	canvas.height = height * S
	canvas.classList.add("pond")
	const ctx = canvas.getContext("2d")!
	const still = matchMedia("(prefers-reduced-motion: reduce)").matches
	let scene: FarmScene = { pigs: [] }
	let t = 0
	const where = (p: FarmPig) => {
		const k = pigScale(p.weight)
		const w = SPRITES.pig[0].length * k, h = SPRITES.pig.length * k
		const wob = still ? 0 : Math.sin(t / 1300 + p.x * 17) * 2
		return {
			x: Math.round(6 + p.x * (width - 12 - w) + wob),
			y: Math.round(14 + p.y * (height - 24 - h)),
			w,
			h,
			k,
		}
	}
	function frame() {
		const s = scene
		ctx.setTransform(S, 0, 0, S, 0, 0)
		ctx.imageSmoothingEnabled = false
		ctx.fillStyle = s.night ? "#2c3e66" : "#fff6c9"
		ctx.fillRect(0, 0, width, height)
		// grass tufts
		ctx.fillStyle = s.night ? "#3d5287" : "#d8e38a"
		for (let i = 0; i < 70; i++) {
			const x = (i * 53) % width, y = (i * 97) % height
			ctx.fillRect(x, y, 1, 2)
			ctx.fillRect(x + 2, y + 1, 1, 1)
		}
		// mud
		ctx.fillStyle = s.night ? "#4a3a3a" : "#b9844f"
		ctx.beginPath()
		ctx.ellipse(width * 0.78, height * 0.78, 30, 10, 0, 0, 6.29)
		ctx.fill()
		// trough with apples
		ctx.fillStyle = "#7a5230"
		ctx.fillRect(10, height - 18, 44, 8)
		ctx.fillStyle = "#b9844f"
		ctx.fillRect(12, height - 17, 40, 4)
		for (let i = 0; i < Math.min(8, s.apples ?? 0); i++) {
			sprite(ctx, "apple", 13 + i * 5, height - 23)
		}
		for (const p of [...s.pigs].sort((a, b) => a.y - b.y)) {
			const at = where(p)
			if (p.tone === "dim") ctx.globalAlpha = 0.35
			if (p.tone === "hot" || p.tone === "pick") {
				ctx.fillStyle = p.tone === "hot" ? "rgba(255,34,132,.35)" : "rgba(34,105,255,.3)"
				ctx.beginPath()
				ctx.ellipse(at.x + at.w / 2, at.y + at.h - 1, at.w / 2 + 3, 4, 0, 0, 6.29)
				ctx.fill()
			}
			pixels(ctx, SPRITES.pig, at.x, at.y, at.k)
			ctx.globalAlpha = 1
			ctx.font = "7px Monaco, ui-monospace, monospace"
			const label = `${p.name} ${Math.round(p.weight)}`
			const tw = ctx.measureText(label).width
			ctx.fillStyle = p.tone === "hot"
				? "#ff2284"
				: p.tone === "pick"
				? "#2269ff"
				: p.tone === "ok"
				? "#13917a"
				: "#000"
			const lx = Math.round(at.x + at.w / 2 - tw / 2 - 2)
			ctx.fillRect(lx, at.y - 9, Math.ceil(tw) + 4, 8)
			ctx.fillStyle = "#fff"
			ctx.fillText(label, lx + 2, at.y - 3)
			if (p.says) {
				const sw = ctx.measureText(p.says).width
				const bx = Math.min(width - sw - 8, at.x + at.w), by = Math.max(2, at.y - 20)
				ctx.fillStyle = "#fff"
				ctx.fillRect(bx, by, sw + 6, 10)
				ctx.strokeStyle = "#000"
				ctx.lineWidth = 1
				ctx.strokeRect(bx + 0.5, by + 0.5, sw + 5, 9)
				ctx.fillStyle = "#000"
				ctx.fillText(p.says, bx + 3, by + 7)
			}
		}
		if (s.sign) {
			ctx.font = "8px Monaco, ui-monospace, monospace"
			const tw = ctx.measureText(s.sign).width
			ctx.fillStyle = "#fff"
			ctx.fillRect(width - tw - 12, 3, tw + 8, 11)
			ctx.strokeStyle = "#000"
			ctx.strokeRect(width - tw - 11.5, 3.5, tw + 7, 10)
			ctx.fillStyle = "#000"
			ctx.fillText(s.sign, width - tw - 8, 11)
		}
		if (s.stale) {
			ctx.fillStyle = "rgba(235,235,235,.6)"
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
		draw(s: FarmScene) {
			scene = s
			frame()
			if (!still && !running) {
				running = true
				requestAnimationFrame(loop)
			}
		},
		// the pig under a point on the canvas (client coordinates), if any
		pigAt(cx: number, cy: number): FarmPig | undefined {
			const r = canvas.getBoundingClientRect()
			const x = (cx - r.left) * (width / r.width), y = (cy - r.top) * (height / r.height)
			let best: FarmPig | undefined, bd = 30
			for (const p of scene.pigs) {
				const at = where(p)
				const d = Math.hypot(x - (at.x + at.w / 2), y - (at.y + at.h / 2))
				if (d < Math.max(bd, at.w / 2) && d < bd + at.w) (bd = d, best = p)
			}
			return best
		},
	}
}

export type Farm = ReturnType<typeof createFarm>
