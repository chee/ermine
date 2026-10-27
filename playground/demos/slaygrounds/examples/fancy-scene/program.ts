/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	hasNode,
	list,
	patch,
	peep,
	place,
	read,
	ref,
	unplace,
} from "@ermine/system"
import { inspect, up } from "@ermine/slaygrounds/tools"
import { bind, handler } from "ermine-h"

// fancy-scene: a 3D scene graph on the ermine graph.
//   every object is a node at /scene/…: its transform, colour and shape are nodes under it, and
//   every other name under it is a child object. a transform is relative to its parent: turn the
//   carousel and everything on it goes round
//   the pony is one node placed under arm-a and arm-b (a mount): it is drawn twice, and an edit to
//   it (its colour, its body, its transform) is seen at both places
//   /spin is a process that turns whatever is mounted at /spin/target, by writing that object's
//   transform node; explain shows that one node changing, and what ran because of it
//   it is drawn on a canvas by the painter's way (no webgl): far pieces first, near ones over them
//   drag to orbit, the wheel to zoom, click to pick: the object picked is picked in the graph tab
//   too, where an edit to its transform moves it here

type M4 = number[]
type Transform = { p: number[]; r: number[]; s: number[] }
// one object as drawn: its place (a path from the root), its node's id, and its matrix (its
// parent's times its own). its three nodes are at path/transform, path/colour and path/shape
type Item = {
	path: string
	name: string
	depth: number
	id: string
	shape: string
	colour: string
	n?: number
	spun?: boolean
	m?: M4
}

const PROPS = new Set(["transform", "colour", "shape"])
const COLOURS = ["#ff2284", "#40dcba", "#2269ff", "#ffff88", "#ffd9ea", "#ffffff", "#000000"]
const SHAPES = ["cube", "sphere", "line", "none"]
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const r1 = (x: number) => Math.round(x * 10) / 10

// ---- matrices: column-major ----
const ID: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function mul(a: M4, b: M4): M4 {
	const o = new Array(16)
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			let s = 0
			for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
			o[c * 4 + r] = s
		}
	}
	return o
}
// an object's own matrix: moved by p, turned by r (y, then x, then z, in degrees), sized by s
function local(tr: Transform): M4 {
	const [px, py, pz] = tr?.p ?? [0, 0, 0]
	const [ax, ay, az] = (tr?.r ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180)
	const [sx, sy, sz] = tr?.s ?? [1, 1, 1]
	const [cx, nx, cy, ny, cz, nz] = [
		Math.cos(ax),
		Math.sin(ax),
		Math.cos(ay),
		Math.sin(ay),
		Math.cos(az),
		Math.sin(az),
	]
	const m3 = (a: number[][], b: number[][]) =>
		a.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * b[k][j], 0)))
	const R = m3(
		m3([[cy, 0, ny], [0, 1, 0], [-ny, 0, cy]], [[1, 0, 0], [0, cx, -nx], [0, nx, cx]]),
		[
			[cz, -nz, 0],
			[nz, cz, 0],
			[0, 0, 1],
		],
	)
	return [
		R[0][0] * sx,
		R[1][0] * sx,
		R[2][0] * sx,
		0,
		R[0][1] * sy,
		R[1][1] * sy,
		R[2][1] * sy,
		0,
		R[0][2] * sz,
		R[1][2] * sz,
		R[2][2] * sz,
		0,
		px,
		py,
		pz,
		1,
	]
}
function perspective(fovy: number, aspect: number, near: number, far: number): M4 {
	const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
	return [
		f / aspect,
		0,
		0,
		0,
		0,
		f,
		0,
		0,
		0,
		0,
		(far + near) * nf,
		-1,
		0,
		0,
		2 * far * near * nf,
		0,
	]
}
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i])
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (
	a: number[],
	b: number[],
) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: number[]) => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1
	return a.map((x) => x / l)
}
function lookAt(eye: number[], at: number[], up: number[]): M4 {
	const z = unit(sub(eye, at)), x = unit(cross(up, z)), y = cross(z, x)
	return [
		x[0],
		y[0],
		z[0],
		0,
		x[1],
		y[1],
		z[1],
		0,
		x[2],
		y[2],
		z[2],
		0,
		-dot(x, eye),
		-dot(y, eye),
		-dot(z, eye),
		1,
	]
}
function invert(a: M4): M4 | undefined {
	const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
	const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
	const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
	if (!det) return undefined
	det = 1 / det
	return [
		(a11 * b11 - a12 * b10 + a13 * b09) * det,
		(a02 * b10 - a01 * b11 - a03 * b09) * det,
		(a31 * b05 - a32 * b04 + a33 * b03) * det,
		(a22 * b04 - a21 * b05 - a23 * b03) * det,
		(a12 * b08 - a10 * b11 - a13 * b07) * det,
		(a00 * b11 - a02 * b08 + a03 * b07) * det,
		(a32 * b02 - a30 * b05 - a33 * b01) * det,
		(a20 * b05 - a22 * b02 + a23 * b01) * det,
		(a10 * b10 - a11 * b08 + a13 * b06) * det,
		(a01 * b08 - a00 * b10 - a03 * b06) * det,
		(a30 * b04 - a31 * b02 + a33 * b00) * det,
		(a21 * b02 - a20 * b04 - a23 * b00) * det,
		(a11 * b07 - a10 * b09 - a12 * b06) * det,
		(a00 * b09 - a01 * b07 + a02 * b06) * det,
		(a31 * b01 - a30 * b03 - a32 * b00) * det,
		(a20 * b03 - a21 * b01 + a22 * b00) * det,
	]
}
const xf = (m: M4, [x, y, z, w]: number[]) =>
	[0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w)
// the normal matrix: the inverse transpose of the upper 3×3 (cofactors over the determinant)
function normals(m: M4): number[] {
	const [a, d, g, , b, e, h, , c, f, i] = m
	const C = [
		e * i - f * h,
		-(d * i - f * g),
		d * h - e * g,
		-(b * i - c * h),
		a * i - c * g,
		-(a * h - b * g),
		b * f - c * e,
		-(a * f - c * d),
		a * e - b * d,
	]
	const det = a * C[0] + b * C[1] + c * C[2] || 1
	// column-major: column j is row j of the cofactors
	return [C[0], C[3], C[6], C[1], C[4], C[7], C[2], C[5], C[8]].map((x) => x / det)
}

// ---- the camera: around a point, by yaw and pitch (degrees) and a distance ----
type Camera = { yaw: number; pitch: number; dist: number }
const TARGET = [0, 1.6, 0]
function eyes(cam: Camera, w: number, h: number) {
	const yaw = (cam.yaw * Math.PI) / 180, pitch = (cam.pitch * Math.PI) / 180
	const eye = [
		TARGET[0] + cam.dist * Math.cos(pitch) * Math.sin(yaw),
		TARGET[1] + cam.dist * Math.sin(pitch),
		TARGET[2] + cam.dist * Math.cos(pitch) * Math.cos(yaw),
	]
	return mul(
		perspective((38 * Math.PI) / 180, w / Math.max(1, h), 0.1, 100),
		lookAt(eye, TARGET, [0, 1, 0]),
	)
}

// ---- picking: a ray from the pointer, tried against each cube and sphere in its own space ----
function pick(items: Item[], cam: Camera, w: number, h: number, x: number, y: number) {
	const inv = invert(eyes(cam, w, h))
	if (!inv) return ""
	const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2
	const a = xf(inv, [nx, ny, -1, 1]), b = xf(inv, [nx, ny, 1, 1])
	const o = a.slice(0, 3).map((v) => v / a[3]), far = b.slice(0, 3).map((v) => v / b[3])
	const d = sub(far, o)
	let best = Infinity, found = ""
	for (const it of items) {
		if (it.shape !== "cube" && it.shape !== "sphere") continue
		const mi = invert(it.m!)
		if (!mi) continue
		const lo = xf(mi, [...o, 1]), ld = xf(mi, [...d, 0])
		let t = Infinity
		if (it.shape === "sphere") {
			const A = dot(ld, ld), B = 2 * dot(lo, ld), C = dot(lo, lo) - 0.25
			const disc = B * B - 4 * A * C
			if (disc >= 0) t = (-B - Math.sqrt(disc)) / (2 * A)
		} else {
			let t0 = -Infinity, t1 = Infinity
			for (let k = 0; k < 3; k++) {
				if (Math.abs(ld[k]) < 1e-12) {
					if (Math.abs(lo[k]) > 0.5) t0 = Infinity
					continue
				}
				const u = (-0.5 - lo[k]) / ld[k], v = (0.5 - lo[k]) / ld[k]
				t0 = Math.max(t0, Math.min(u, v))
				t1 = Math.min(t1, Math.max(u, v))
			}
			if (t0 <= t1) t = t0
		}
		if (t > 0 && t < best) (best = t, found = it.path)
	}
	return found
}

// ---- the renderer: a canvas, no webgl. every face cut into pieces about half a unit across
// (so the floor sorts piece by piece), all pieces of every object sorted far to near and painted
// (the painter's way), lit in three tones. a cube's edges are 1px black lines; a sphere's outline
// is its back faces, stroked thick in black before its front faces cover them ----
type Piece = {
	ground?: boolean
	z: number
	pts: number[][]
	fill?: string
	line?: string
	width?: number
	alpha?: number
}

const LIGHT = unit([0.45, 0.85, 0.35])
const rgb = (hex: string) => [1, 3, 5].map((j) => parseInt((hex + "000000").slice(j, j + 2), 16))
const tone = (hex: string, k: number) => `rgb(${rgb(hex).map((c) => Math.round(c * k)).join(",")})`
const lit = (n: number[]) => {
	const l = dot(unit(n), LIGHT)
	return l > 0.5 ? 1 : l > -0.1 ? 0.86 : 0.72
}
// a sphere of radius 0.5 as a grid of quads, each corner a point on it
const LAT = 10, LON = 16
const ball: number[][] = []
for (let i = 0; i <= LAT; i++) {
	for (let j = 0; j <= LON; j++) {
		const th = (i / LAT) * Math.PI, ph = (j / LON) * 2 * Math.PI
		ball.push([
			Math.sin(th) * Math.cos(ph) / 2,
			Math.cos(th) / 2,
			Math.sin(th) * Math.sin(ph) / 2,
		])
	}
}
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

type Frame = {
	items: Item[]
	cam: Camera
	picked: string
	size: { w: number; h: number }
	tags?: unknown
}
function createRenderer(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!
	function draw({ items, cam, picked, size }: Frame) {
		const dpr = devicePixelRatio || 1
		const w = size.w, h = size.h
		if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
		if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.fillStyle = "#ffffeb"
		ctx.fillRect(0, 0, w, h)
		const vp = eyes(cam, w, h)
		const pieces: Piece[] = []
		const hot = (it: Item) => !!picked && (it.path === picked || it.path.startsWith(picked + "/"))
		for (const it of items) {
			if (!it.m || it.shape === "none") continue
			const mvp = mul(vp, it.m)
			// a point of the object, on the screen: x, y and its distance (w); behind the eye: none
			const screen = (p: number[]) => {
				const c = xf(mvp, [p[0], p[1], p[2], 1])
				return c[3] > 0.05
					? [(c[0] / c[3] * 0.5 + 0.5) * w, (0.5 - c[1] / c[3] * 0.5) * h, c[3]]
					: undefined
			}
			const nm = normals(it.m)
			const world = (n: number[]) =>
				[0, 1, 2].map((r) => nm[r] * n[0] + nm[3 + r] * n[1] + nm[6 + r] * n[2])
			const ink = hot(it) ? "#ff2284" : "#000000"
			// the ground: what lies wholly at or under y = 0 is painted first, everything stands on it
			const ground = it.shape === "cube" &&
				[-0.5, 0.5].every((x) =>
					[-0.5, 0.5].every((y) =>
						[-0.5, 0.5].every((z) => xf(it.m!, [x, y, z, 1])[1] <= 0.001)
					)
				)
			// how far a piece is: its farthest corner (the floor under a thing sorts behind it), then
			// its middle
			const z = (pts: number[][]) =>
				Math.max(...pts.map((p) => p[2])) +
				pts.reduce((s, p) => s + p[2], 0) / pts.length / 1000
			// facing the eye: drawn clockwise on the screen (y runs down)
			const front = (pts: number[][]) => {
				let a = 0
				for (let i = 0; i < pts.length; i++) {
					const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
					a += x1 * y2 - x2 * y1
				}
				return a < 0
			}
			if (it.shape === "line") {
				const n = 6
				for (let i = 0; i < n; i++) {
					const a = screen([0, i / n, 0]), b = screen([0, (i + 1) / n, 0])
					if (a && b) {
						pieces.push({
							z: z([a, b]),
							pts: [a, b],
							line: hot(it) ? ink : it.colour,
							width: hot(it) ? 2 : 1,
						})
					}
				}
			} else if (it.shape === "cube") {
				// each face cut by its size in the world: about half a unit a piece
				const len = (k: number) => Math.hypot(it.m![k * 4], it.m![k * 4 + 1], it.m![k * 4 + 2])
				for (const n of FACES) {
					const u = Math.abs(n[1]) === 1 ? [1, 0, 0] : [0, 1, 0]
					const v = cross(n, u)
					const at = (a: number, b: number) =>
						[0, 1, 2].map((k) => 0.5 * n[k] + (a - 0.5) * u[k] + (b - 0.5) * v[k])
					const cut = (axis: number[]) =>
						Math.min(16, Math.max(1, Math.ceil(len(axis.findIndex((x) => x !== 0)) / 0.5)))
					const ku = cut(u), kv = cut(v)
					const corners = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)].map(screen)
					if (corners.some((c) => !c) || !front(corners as number[][])) continue
					const fill = tone(it.colour, lit(world(n)))
					for (let i = 0; i < ku; i++) {
						for (let j = 0; j < kv; j++) {
							const q = [
								at(i / ku, j / kv),
								at((i + 1) / ku, j / kv),
								at((i + 1) / ku, (j + 1) / kv),
								at(i / ku, (j + 1) / kv),
							].map(screen)
							if (q.some((c) => !c)) continue
							pieces.push({
								ground,
								z: z(q as number[][]),
								pts: q as number[][],
								fill,
								line: "#000000",
								alpha: ku * kv > 1 ? 0.1 : 0,
							})
						}
					}
					// the face's edges, in pieces too, a hair nearer than the face
					const edge = (a: number[], b: number[], k: number) => {
						for (let i = 0; i < k; i++) {
							const p = screen(a.map((x, d) => x + (b[d] - x) * (i / k))),
								q = screen(a.map((x, d) => x + (b[d] - x) * ((i + 1) / k)))
							if (p && q) {
								pieces.push({
									ground,
									z: z([p, q]) - 0.02,
									pts: [p, q],
									line: ink,
									width: hot(it) ? 2 : 1,
								})
							}
						}
					}
					edge(at(0, 0), at(1, 0), ku)
					edge(at(1, 0), at(1, 1), kv)
					edge(at(1, 1), at(0, 1), ku)
					edge(at(0, 1), at(0, 0), kv)
				}
			} else if (it.shape === "sphere") {
				const pts = ball.map(screen)
				for (let i = 0; i < LAT; i++) {
					for (let j = 0; j < LON; j++) {
						const a = i * (LON + 1) + j, b = a + LON + 1
						const q = [pts[a], pts[a + 1], pts[b + 1], pts[b]]
						if (q.some((c) => !c)) continue
						const c = [a, a + 1, b + 1, b].map((k) => ball[k])
						const mid = [0, 1, 2].map((d) => c.reduce((s, p) => s + p[d], 0) / 4)
						if (front(q as number[][])) {
							const fill = tone(it.colour, lit(world(mid)))
							pieces.push({
								z: z(q as number[][]),
								pts: q as number[][],
								fill,
								line: fill,
								width: 0.6,
							})
						} else {
							// a back face: stroked thick in ink, so a band shows round the front ones
							pieces.push({
								z: z(q as number[][]),
								pts: q as number[][],
								line: ink,
								width: hot(it) ? 5 : 3,
							})
						}
					}
				}
			}
		}
		pieces.sort((a, b) => (!a.ground === !b.ground ? b.z - a.z : a.ground ? -1 : 1))
		ctx.lineJoin = "round"
		ctx.lineCap = "round"
		for (const p of pieces) {
			ctx.beginPath()
			ctx.moveTo(p.pts[0][0], p.pts[0][1])
			for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i][0], p.pts[i][1])
			if (p.fill) {
				ctx.closePath()
				ctx.fillStyle = p.fill
				ctx.fill()
				// the seams: the fill's own colour (no hairline gaps), or a faint grid on a big face
				ctx.globalAlpha = 1
				ctx.strokeStyle = p.fill
				ctx.lineWidth = 0.7
				ctx.stroke()
				if (p.alpha) {
					ctx.globalAlpha = p.alpha
					ctx.strokeStyle = "#000000"
					ctx.lineWidth = 1
					ctx.stroke()
					ctx.globalAlpha = 1
				}
			} else {
				if (p.pts.length > 2) ctx.closePath()
				ctx.strokeStyle = p.line!
				ctx.lineWidth = p.width ?? 1
				ctx.stroke()
			}
		}
	}
	return { draw, drop: () => {} }
}

// ---- the walk: every object reached from /scene, depth first, its matrix its parent's times its
// own. a node met again on its own way down (mounted under itself) is not gone into ----
function walk(): Item[] {
	const out: Item[] = []
	const count = new Map<string, number>()
	// the node at a path: its id, found by up (names from the root), tracked
	const idOf = (path: string) => up(path.split("/").filter(Boolean), [])?.found
	// a node under an object, none if it has no such name (tracked as the list is)
	const maybe = (path: string, name: string) =>
		list(path).includes(name) ? read(`${path}/${name}`) : undefined
	const visit = (path: string, parent: M4, depth: number, chain: string[]) => {
		for (const name of list(path)) {
			const here = `${path}/${name}`, id = idOf(here)
			if (PROPS.has(name) || id === undefined || chain.includes(id) || depth > 12) continue
			const M = mul(parent, local(maybe(here, "transform") as Transform))
			count.set(id, (count.get(id) ?? 0) + 1)
			out.push({
				path: here,
				name,
				depth,
				id,
				shape: (maybe(here, "shape") as string | undefined) ?? "none",
				colour: (maybe(here, "colour") as string | undefined) ?? "#ffffff",
				m: M,
			})
			visit(here, M, depth + 1, [...chain, id])
		}
	}
	visit("/scene", ID, 0, [idOf("/scene")!])
	for (const x of out) x.n = count.get(x.id)
	return out
}

// a transform said short: only what is not the default
function short(tr: Transform) {
	if (!tr) return ""
	const out: string[] = []
	if (tr.p.some((v) => v)) out.push(`@${tr.p.map(r1).join(",")}`)
	if (tr.r.some((v) => v)) out.push(`↻${tr.r.map((v) => Math.round(v)).join(",")}`)
	if (tr.s.some((v) => v !== 1)) out.push(`×${tr.s.map(r1).join(",")}`)
	return out.join(" ") || "·"
}
const said = (tr: Transform) =>
	tr
		? `move ${tr.p.map(r1).join(" ")} · turn ${
			tr.r.map((v) => Math.round(v)).join(" ")
		}° · size ${tr.s.map(r1).join(" ")}`
		: ""

// =================================================================================================
// the view: the canvas, a tag over each object it names, the outline, the panel of the one picked
// =================================================================================================
// a node's value now, from an action (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0]) => peep(() => read(x)) as T
const put = (x: Parameters<typeof read>[0], v: unknown) => patch(x, [{ path: [], value: v }])

export function view() {
	const camera = ensureNode("./camera", { yaw: 32, pitch: 22, dist: 10.5 })
	const picked = ensureNode("./picked", "")
	const tags = ensureNode("./tags", false)
	const canvas = peep(() =>
		read(ref("./canvas", () => document.createElement("canvas")))
	) as HTMLCanvasElement
	const sceneId = up(["scene"], [])?.found as string
	// the node mounted at /spin/target: its id (what the spinner turns)
	const target = () => up(["spin", "target"], [])?.found

	// everything drawn, each with its matrix (any transform written: this runs again)
	const world = createMemo("world", () => walk())
	// the same, without the matrices: it changes only when the tree, a colour or a shape does
	const outline = createMemo("outline", () => {
		const spun = target()
		return (read(world) as Item[]).map(({ m: _, ...x }) => ({ ...x, spun: x.id === spun }))
	}, { equal: same })
	// the picked object, and every object it could be placed under too (not one under it)
	createMemo("chosen", () => {
		const p = read(picked) as string
		const items = read(outline) as Item[]
		const c = items.find((x) => x.path === p)
		if (!c) return ""
		const seen = new Set([c.id])
		const parents = [{ path: "/scene", id: sceneId }]
		for (const x of items) {
			if (x.path.startsWith(c.path + "/") || seen.has(x.id) || x.shape === "line") continue
			seen.add(x.id)
			parents.push({ path: x.path, id: x.id })
		}
		return { ...c, parents }
	}, { equal: same })
	// what gets a tag over it in the view: the picked and the spun, or (tags on) everything
	const tagged = createMemo("tagged", () => {
		const all = read(tags), p = read(picked)
		return (read(outline) as Item[])
			.filter((x) => (all ? x.shape !== "line" : x.path === p || x.spun))
			.map((x) => ({ path: x.path, name: x.name, n: x.n, spun: x.spun }))
	}, { equal: same })

	// the drawing: an effect, so it acts once a round, after the world and the camera settled
	const r = createRenderer(canvas)
	let layer: HTMLElement | undefined
	// the canvas's size is not a node: an observer can write nothing (nothing is open in its
	// callback), so the act takes it off the canvas as it draws, and the observer draws the last
	// frame again when the box changes
	let frame: Omit<Frame, "size"> | undefined
	const drawn = () => {
		const b = canvas.getBoundingClientRect()
		return { w: Math.round(b.width) || 640, h: Math.round(b.height) || 420 }
	}
	const paint = (v: Omit<Frame, "size">) => {
		const f = { ...v, size: drawn() }
		r.draw(f)
		// the tags: once this round's bindings have acted (a new tag is in the page by then)
		queueMicrotask(() => layer && tagsAt(layer, f))
	}
	createEffect("draw", () => ({
		items: read(world),
		cam: read(camera),
		picked: read(picked),
		tags: read(tagged),
	}), (v) => paint(frame = v as Omit<Frame, "size">))
	addTeardown(() => r.drop())
	// each tag where its object's origin is on the screen
	function tagsAt(into: HTMLElement, v: Frame) {
		const vp = eyes(v.cam, v.size.w, v.size.h)
		for (const el of into.querySelectorAll<HTMLElement>("[data-path]")) {
			const it = v.items.find((x) => x.path === el.dataset.path)
			const c = it?.m && xf(vp, [it.m[12], it.m[13], it.m[14], 1])
			if (!c || c[3] <= 0) {
				el.style.visibility = "hidden"
				continue
			}
			el.style.visibility = ""
			const x = (c[0] / c[3] * 0.5 + 0.5) * v.size.w, y = (0.5 - c[1] / c[3] * 0.5) * v.size.h
			el.style.transform = `translate(${x.toFixed(1)}px,${
				y.toFixed(1)
			}px) translate(-50%,-160%) skew(-8deg)`
		}
	}

	// ---- actions: what a person does ----
	createAction("on/orbit", (dx: number, dy: number) => {
		const c = get<Camera>(camera)
		patch(camera, [
			{ path: ["yaw"], value: Math.round((c.yaw - dx * 0.45) * 10) / 10 },
			{
				path: ["pitch"],
				value: Math.round(Math.max(-8, Math.min(80, c.pitch + dy * 0.35)) * 10) / 10,
			},
		])
	})
	createAction("on/zoom", (way: number) => {
		const c = get<Camera>(camera)
		patch(camera, [{
			path: ["dist"],
			value: r1(Math.max(4, Math.min(30, c.dist * (way > 0 ? 1.1 : 1 / 1.1)))),
		}])
	})
	// a pick: the place picked here, and its node picked in the graph tab
	const choose = (path: string) => {
		put(picked, path)
		if (path) inspect(path.split("/").filter(Boolean))
	}
	createAction("on/pick", choose)
	createAction(
		"on/point",
		(x: number, y: number, w: number, h: number) =>
			choose(pick(get<Item[]>(world), get<Camera>(camera), w, h, x, y)),
	)
	// an object's three nodes are at its path: transform, colour, shape
	createAction("on/set", (path: string, at: [string, number], value: number) => {
		if (!Number.isFinite(value)) return
		patch(`${path}/transform`, [{ path: [at[0], at[1]], value }])
	})
	createAction("on/colour", (path: string, colour: string) => put(`${path}/colour`, colour))
	createAction("on/shape", (path: string, shape: string) => put(`${path}/shape`, shape))
	// the spinner's target: whatever is placed at /spin/target
	createAction("on/spin", (path: string) => {
		if (hasNode("/spin/target")) unplace("/spin/target")
		place("/spin/target", path)
	})
	createAction("on/pause", () => put("/spin/speed", get("/spin/speed") ? 0 : 45))
	createAction("on/tags", () => put(tags, !get(tags)))
	// one node placed under another parent too: an instance
	createAction("on/mount", (path: string, name: string, parent: string) => {
		if (!parent) return
		// a name holds one id: under a name taken already, the instance takes name-2, name-3...
		let own = name
		const have = peep(() => list(parent))
		for (let n = 2; have.includes(own); n++) own = `${name}-${n}`
		place(`${parent}/${own}`, path)
	})
	createAction("on/unmount", (parent: string, name: string) => {
		unplace(`${parent}/${name}`)
		put(picked, "")
	})

	// the canvas's size changes: the last frame is drawn again (the page tells the observer, and the
	// observer tells no node)
	const watcher = new ResizeObserver(() => frame && paint(frame))
	watcher.observe(canvas)
	addTeardown(() => watcher.disconnect())

	// the pointer: a drag orbits, a click (barely moved) picks
	let last: number[] | undefined, moved = 0
	const down = (e: PointerEvent) => {
		last = [e.clientX, e.clientY]
		moved = 0
		try {
			canvas.setPointerCapture(e.pointerId)
		} catch { /* a script's pointer */ }
	}
	const orbit = (e: PointerEvent) => {
		if (!e.buttons || !last) return undefined
		const dx = e.clientX - last[0], dy = e.clientY - last[1]
		last = [e.clientX, e.clientY]
		moved += Math.abs(dx) + Math.abs(dy)
		return moved > 4 ? [dx, dy] : undefined
	}
	const point = (e: PointerEvent) => {
		const was = last
		last = undefined
		if (!was || moved > 4) return undefined
		const b = canvas.getBoundingClientRect()
		return [e.clientX - b.left, e.clientY - b.top, b.width, b.height]
	}

	const Tag = ({ x }) => (
		<span
			key={x.path}
			class={x.spun ? "t3 spun" : "t3"}
			data-path={x.path}
			title={bind(`${x.path}/transform`, said)}
		>
			{x.spun ? "↻ " : ""}
			{x.name}
			{x.n > 1 ? " ⧉" : ""}
		</span>
	)
	const Row = ({ x }: { x: Item }) => (
		<li
			key={x.path}
			class={bind("picked", (p) => (p === x.path ? "row on" : "row"))}
			style={{ paddingLeft: `${6 + x.depth * 13}px` }}
			title={x.path}
			onClick={handler("on/pick", [x.path])}
		>
			<i
				class={`shp ${x.shape}`}
				style={bind(
					`${x.path}/colour`,
					(c) => ({
						background: x.shape === "line" ? "none" : c,
						borderColor: x.shape === "line" ? c : "#000",
					}),
				)}
			/>
			<b>{x.name}</b>
			{x.n! > 1
				? <span class="inst" title="one node, placed at more than one place">⧉{x.n}</span>
				: ""}
			{x.spun
				? <span class="spun" title="what /spin turns: mounted at /spin/target">↻</span>
				: ""}
			<span class="tr">{bind(`${x.path}/transform`, short)}</span>
		</li>
	)
	let parentPick: HTMLSelectElement
	const Panel = ({ c }: { c: Item & { parents: { path: string; id: string }[] } }) => (
		<div class="panel card">
			<div class="ph">
				<b>{c.name}</b>
				<span class="tag">{c.path}</span>
			</div>
			{c.n! > 1
				? (
					<p class="inst">
						⧉ one node, placed at {c.n} places: an edit here is an edit at each
					</p>
				)
				: ""}
			<div class="xyz">
				{(["p", "r", "s"] as const).map((k) => (
					<label>
						<span>{k === "p" ? "move" : k === "r" ? "turn°" : "size"}</span>
						{[0, 1, 2].map((i) => (
							<input
								type="number"
								step={k === "r" ? "15" : "0.1"}
								value={bind(
									`${c.path}/transform`,
									(tr: Transform) =>
										String(k === "r" ? Math.round(tr[k][i]) : r1(tr[k][i])),
								)}
								onChange={handler(
									"on/set",
									(e) => [c.path, [k, i], Number(e.target.value)],
								)}
							/>
						))}
					</label>
				))}
			</div>
			<div class="swatches">
				{COLOURS.map((col) => (
					<button
						class={bind(`${c.path}/colour`, (v) => (v === col ? "sw on" : "sw"))}
						style={{ background: col }}
						title={col}
						onClick={handler("on/colour", [c.path, col])}
					/>
				))}
			</div>
			<div class="shapes">
				{SHAPES.map((sh) => (
					<button
						class={bind(`${c.path}/shape`, (v) => (v === sh ? "on" : ""))}
						onClick={handler("on/shape", [c.path, sh])}
					>
						{sh}
					</button>
				))}
			</div>
			<div class="acts">
				{c.depth > 0
					? (
						<button onClick={handler("on/pick", [c.path.split("/").slice(0, -1).join("/")])}>
							↑ its parent
						</button>
					)
					: ""}
				<button onClick={handler("on/spin", [c.path])}>↻ spin this</button>
				<button onClick={handler("on/pick", [c.path])}>⌖ in the graph</button>
				{c.n! > 1
					? (
						<button
							onClick={handler("on/unmount", [
								c.path.split("/").slice(0, -1).join("/"),
								c.name,
							])}
						>
							unmount here
						</button>
					)
					: ""}
			</div>
			<div class="mount">
				<span>place it under</span>
				<select ref={(e) => void (parentPick = e)}>
					{c.parents.map((x) => <option value={x.path}>{x.path}</option>)}
				</select>
				<button onClick={handler("on/mount", () => [c.path, c.name, parentPick?.value])}>
					too
				</button>
			</div>
		</div>
	)

	return (
		<div class="sc">
			<style>{css}</style>
			<div class="stage">
				<div
					class="paper"
					onPointerDown={(e) => {
						down(e)
					}}
					onPointerMove={handler("on/orbit", orbit)}
					onPointerUp={handler("on/point", point)}
					onWheel={handler("on/zoom", (e) => {
						e.preventDefault()
						return [Math.sign(e.deltaY)]
					})}
				>
					{canvas}
				</div>
				<div class="tags" ref={(e) => void (layer = e)}>
					{bind("tagged", (list) => list.map((x) => <Tag x={x} />))}
				</div>
				<div class="hud">
					<span class="tag">fancy-scene</span>
					<button onClick={handler("on/pause")}>
						{bind("spin/speed", (v) => (v ? "■ stop the spinner" : "↻ spin"))}
					</button>
					<button onClick={handler("on/tags")}>
						{bind("tags", (v) => (v ? "tags: every object" : "tags: picked + spun"))}
					</button>
				</div>
				<p class="help">drag: orbit · wheel: zoom · click: pick</p>
			</div>
			<aside class="side">
				<div class="card tree">
					<h3>
						/scene{" "}
						<span class="dim">
							an object is a node; its children are its places' children
						</span>
					</h3>
					<ul>{bind("outline", (list: Item[]) => list.map((x) => <Row x={x} />))}</ul>
				</div>
				{bind("chosen", (c) => (c
					? <Panel c={c} />
					: <p class="dim pickme">click an object, or a row, to pick it</p>))}
			</aside>
		</div>
	)
}

// =================================================================================================
// the spinner: turns whatever is placed at its target, by writing that object's transform node
// =================================================================================================
export function spin() {
	const speed = ensureNode("./spin/speed", 45) // degrees a second
	let last = performance.now()
	// the turn is an action, called by a handler: a timer has nothing open to write with, so the
	// beat is an element in the spinner's own view whose css animation cycles every 50ms, and each
	// cycle's animationiteration calls on/turn. it holds still when the speed is 0
	createAction("on/turn", () => {
		const now = performance.now()
		const dt = Math.min(0.1, (now - last) / 1000)
		last = now
		const v = get<number>(speed)
		if (!v || !hasNode("./spin/target/transform")) return
		const r = get<Transform>("./spin/target/transform").r
		patch("./spin/target/transform", [{
			path: ["r", 1],
			value: Math.round(((r[1] + v * dt) % 360) * 10) / 10,
		}])
	})
	return (
		<div>
			<style>
				{`@keyframes beat { to { opacity: 0 } }
.beat { position: fixed; width: 0; height: 0; pointer-events: none; animation: beat 50ms linear infinite }`}
			</style>
			<i
				class="beat"
				style={bind("spin/speed", (v) => `animation-play-state:${v ? "running" : "paused"}`)}
				onAnimationIteration={handler("on/turn")}
			/>
		</div>
	)
}

// ---- the look: chee.party ----
const css = `
body{margin:0;overflow:hidden}
.sc{position:fixed;inset:0;display:flex;background:#ffff88;font:13px Jost,system-ui,sans-serif;color:#000}
.sc button{font:inherit;color:#000;background:#fff;border:1px solid #000;border-radius:2px;padding:1px 10px;box-shadow:1px 1px 0 #000;cursor:pointer;transition:transform 100ms,box-shadow 100ms}
.sc button:hover{transform:translateY(-1px);box-shadow:2px 2px 0 #000}
.sc button:active{transform:none;box-shadow:none}
.tag{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 7px;transform:skew(-8deg);font-size:11px;line-height:16px;white-space:nowrap}
.dim{color:#0008;font-weight:400}
.card{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 0 10px 2px #66003322}
.stage{position:relative;flex:1;min-width:0;border-right:1px solid #000}
.paper{position:absolute;inset:0;cursor:grab;touch-action:none}
.paper:active{cursor:grabbing}
.paper canvas{width:100%;height:100%;display:block}
.tags{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.t3{position:absolute;left:0;top:0;background:#ffff88;border:1px solid #000;padding:0 7px;font-size:11px;line-height:16px;white-space:nowrap;box-shadow:0 0 8px 1px #66003322}
.t3.spun{background:#40dcba}
.hud{position:absolute;left:10px;top:10px;display:flex;gap:6px;align-items:center}
.help{position:absolute;left:10px;bottom:6px;margin:0;font-size:11px;color:#0009}
.side{width:300px;flex:none;display:flex;flex-direction:column;gap:8px;padding:8px;overflow:hidden;box-sizing:border-box}
.tree{flex:1 1 auto;min-height:90px;overflow:auto}
.panel{flex:none}
.tree h3{position:sticky;top:0;background:#fff;margin:0;padding:6px 8px;font-size:13px;border-bottom:1px solid #000;display:flex;flex-direction:column;z-index:1}
.tree h3 .dim{font-size:11px}
.tree ul{list-style:none;margin:0;padding:3px 0;font-size:12px}
.row{display:flex;align-items:center;gap:5px;padding:1px 6px;cursor:pointer;white-space:nowrap}
.row:hover{background:#ffd9ea}
.row.on{background:#000;color:#fff}
.row .tr{margin-left:auto;font-family:Monaco,ui-monospace,monospace;font-size:9.5px;color:#0009;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.row.on .tr{color:#fffb}
.shp{display:inline-block;width:10px;height:10px;border:1px solid #000;flex:none}
.shp.sphere{border-radius:50%}
.shp.none{border-style:dashed;background:none!important}
.shp.line{border-width:0 0 0 2px;transform:skew(-30deg);width:2px}
.inst{background:#2269ff;color:#fff;font-size:10px;padding:0 4px;border-radius:2px}
.spun{background:#40dcba;border:1px solid #000;font-size:10px;padding:0 3px;border-radius:2px;color:#000}
.panel{padding:8px;display:flex;flex-direction:column;gap:7px}
.ph{display:flex;align-items:center;gap:8px}
.ph .tag{overflow:hidden;text-overflow:ellipsis;max-width:200px}
p.inst{margin:0;padding:3px 6px;font-size:11px}
.xyz{display:flex;flex-direction:column;gap:3px}
.xyz label{display:grid;grid-template-columns:44px 1fr 1fr 1fr;gap:4px;align-items:center;font-size:11px}
.xyz input{font:inherit;font-size:12px;width:100%;box-sizing:border-box;border:1px solid #000;border-radius:2px;padding:1px 3px}
.swatches,.shapes,.acts{display:flex;gap:4px;flex-wrap:wrap}
.sw{width:22px;height:20px;padding:0!important}
.sw.on{outline:2px solid #ff2284;outline-offset:1px}
.shapes button{font-size:12px;padding:0 8px}
.shapes button.on{background:#000;color:#fff}
.acts button{font-size:12px}
.mount{display:flex;gap:5px;align-items:center;font-size:11px}
.mount select{font:inherit;flex:1;min-width:0;border:1px solid #000;border-radius:2px;background:#fff}
.pickme{margin:4px}
`
