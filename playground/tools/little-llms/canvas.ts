// a pretend 2D context: it draws nothing, it records what was drawn (shapes with their bounds and colours, texts)

export type Shape = {
	kind: "fill" | "stroke" | "clear"
	style: string
	box: { x0: number; y0: number; x1: number; y1: number }
	from: string
}
export type Text = { text: string; x: number; y: number; style: string }
export type Drawing = {
	shapes: Shape[]
	texts: Text[]
	calls: number
	width: number
	height: number
}

type Matrix = [number, number, number, number, number, number]
const identity = (): Matrix => [1, 0, 0, 1, 0, 0]
const multiply = (m: Matrix, n: Matrix): Matrix => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
]

export function createContext(canvas: { width: number; height: number }) {
	const drawing: Drawing = {
		shapes: [],
		texts: [],
		calls: 0,
		get width() {
			return canvas.width
		},
		get height() {
			return canvas.height
		},
	}
	let m = identity()
	const stack: { m: Matrix; fillStyle: string; strokeStyle: string }[] = []
	let path: [number, number][] = []
	let fillStyle = "#000000"
	let strokeStyle = "#000000"
	const point = (
		x: number,
		y: number,
	): [number, number] => [
		m[0] * x + m[2] * y + m[4],
		m[1] * x + m[3] * y + m[5],
	]
	const add = (x: number, y: number) => path.push(point(x, y))
	const bounds = (pts: [number, number][]) => {
		const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
		return {
			x0: Math.min(...xs),
			y0: Math.min(...ys),
			x1: Math.max(...xs),
			y1: Math.max(...ys),
		}
	}
	const shape = (
		kind: Shape["kind"],
		pts: [number, number][],
		from: string,
	) => {
		if (
			!pts.length ||
			pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
		) return
		drawing.shapes.push({
			kind,
			style: kind == "stroke" ? strokeStyle : fillStyle,
			box: bounds(pts),
			from,
		})
	}
	const rect = (
		x: number,
		y: number,
		w: number,
		h: number,
	) => [point(x, y), point(x + w, y), point(x, y + h), point(x + w, y + h)]
	const oval = (x: number, y: number, rx: number, ry: number) => {
		const pts: [number, number][] = []
		for (let a = 0; a < 8; a++) {
			pts.push(
				point(
					x + rx * Math.cos(a * Math.PI / 4),
					y + ry * Math.sin(a * Math.PI / 4),
				),
			)
		}
		return pts
	}
	const gradient = () => ({ addColorStop() {}, toString: () => "gradient" })
	const ctx: Record<string, unknown> = {
		canvas,
		get fillStyle() {
			return fillStyle
		},
		set fillStyle(v: unknown) {
			fillStyle = String(v)
		},
		get strokeStyle() {
			return strokeStyle
		},
		set strokeStyle(v: unknown) {
			strokeStyle = String(v)
		},
		lineWidth: 1,
		font: "10px sans-serif",
		textAlign: "start",
		textBaseline: "alphabetic",
		globalAlpha: 1,
		lineCap: "butt",
		lineJoin: "miter",
		shadowBlur: 0,
		shadowColor: "",
		globalCompositeOperation: "source-over",
		save() {
			stack.push({ m: [...m] as Matrix, fillStyle, strokeStyle })
		},
		restore() {
			const s = stack.pop()
			if (s) ({ m, fillStyle, strokeStyle } = s)
		},
		translate(x: number, y: number) {
			m = multiply(m, [1, 0, 0, 1, x, y])
		},
		scale(x: number, y: number) {
			m = multiply(m, [x, 0, 0, y, 0, 0])
		},
		rotate(a: number) {
			m = multiply(m, [
				Math.cos(a),
				Math.sin(a),
				-Math.sin(a),
				Math.cos(a),
				0,
				0,
			])
		},
		transform(
			a: number,
			b: number,
			c: number,
			d: number,
			e: number,
			f: number,
		) {
			m = multiply(m, [a, b, c, d, e, f])
		},
		setTransform(
			a?: number,
			b?: number,
			c?: number,
			d?: number,
			e?: number,
			f?: number,
		) {
			m = typeof a == "number" ? [a, b!, c!, d!, e!, f!] : identity()
		},
		resetTransform() {
			m = identity()
		},
		beginPath() {
			path = []
		},
		closePath() {},
		moveTo: add,
		lineTo: add,
		quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
			add(cx, cy)
			add(x, y)
		},
		bezierCurveTo(
			a: number,
			b: number,
			c: number,
			d: number,
			x: number,
			y: number,
		) {
			add(a, b)
			add(c, d)
			add(x, y)
		},
		arc(x: number, y: number, r: number) {
			path.push(...oval(x, y, r, r))
		},
		arcTo(a: number, b: number, x: number, y: number) {
			add(a, b)
			add(x, y)
		},
		ellipse(x: number, y: number, rx: number, ry: number) {
			path.push(...oval(x, y, rx, ry))
		},
		rect(x: number, y: number, w: number, h: number) {
			path.push(...rect(x, y, w, h))
		},
		roundRect(x: number, y: number, w: number, h: number) {
			path.push(...rect(x, y, w, h))
		},
		fill() {
			shape("fill", path, "path")
		},
		stroke() {
			shape("stroke", path, "path")
		},
		fillRect(x: number, y: number, w: number, h: number) {
			shape("fill", rect(x, y, w, h), "rect")
		},
		strokeRect(x: number, y: number, w: number, h: number) {
			shape("stroke", rect(x, y, w, h), "rect")
		},
		clearRect(x: number, y: number, w: number, h: number) {
			shape("clear", rect(x, y, w, h), "rect")
		},
		fillText(text: unknown, x: number, y: number) {
			const [px, py] = point(x, y)
			drawing.texts.push({
				text: String(text),
				x: px,
				y: py,
				style: fillStyle,
			})
		},
		strokeText(text: unknown, x: number, y: number) {
			const [px, py] = point(x, y)
			drawing.texts.push({
				text: String(text),
				x: px,
				y: py,
				style: strokeStyle,
			})
		},
		measureText: (t: string) => ({
			width: String(t).length * 6,
			actualBoundingBoxAscent: 8,
			actualBoundingBoxDescent: 2,
		}),
		createLinearGradient: gradient,
		createRadialGradient: gradient,
		createConicGradient: gradient,
		createPattern: () => ({}),
		getImageData: (_x: number, _y: number, w: number, h: number) => ({
			width: w,
			height: h,
			data: new Uint8ClampedArray(w * h * 4),
		}),
		putImageData() {},
		drawImage() {},
		clip() {},
		setLineDash() {},
		getLineDash: () => [],
		isPointInPath: () => false,
		createImageData: (w: number, h: number) => ({
			width: w,
			height: h,
			data: new Uint8ClampedArray(w * h * 4),
		}),
	}
	const counted = new Proxy(ctx, {
		get(target, key) {
			const v = target[key as string]
			if (typeof v == "function") drawing.calls++
			return v
		},
	})
	return { ctx: counted, drawing }
}

// colours, enough to tell blue water and compare a fish's colour to the one it was given

const named: Record<string, string> = {
	black: "#000000",
	white: "#ffffff",
	red: "#ff0000",
	green: "#008000",
	blue: "#0000ff",
	yellow: "#ffff00",
	orange: "#ffa500",
	purple: "#800080",
	pink: "#ffc0cb",
	gray: "#808080",
	grey: "#808080",
	cyan: "#00ffff",
	aqua: "#00ffff",
	teal: "#008080",
	navy: "#000080",
	skyblue: "#87ceeb",
	lightblue: "#add8e6",
	deepskyblue: "#00bfff",
	dodgerblue: "#1e90ff",
	steelblue: "#4682b4",
	royalblue: "#4169e1",
	lightskyblue: "#87cefa",
	cornflowerblue: "#6495ed",
	mediumblue: "#0000cd",
	darkblue: "#00008b",
	powderblue: "#b0e0e6",
	lightcyan: "#e0ffff",
	aquamarine: "#7fffd4",
	turquoise: "#40e0d0",
	coral: "#ff7f50",
	gold: "#ffd700",
	salmon: "#fa8072",
	tomato: "#ff6347",
	lime: "#00ff00",
	magenta: "#ff00ff",
	violet: "#ee82ee",
	brown: "#a52a2a",
	silver: "#c0c0c0",
	cadetblue: "#5f9ea0",
}

export function rgb(color: string): [number, number, number] | undefined {
	const c = color.trim().toLowerCase()
	const hex = named[c] ?? c
	let m = hex.match(/^#([0-9a-f]{6})$/)
	if (m) {
		return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [
			number,
			number,
			number,
		]
	}
	m = hex.match(/^#([0-9a-f]{3})$/)
	if (m) {
		return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [
			number,
			number,
			number,
		]
	}
	m = c.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/)
	if (m) return [+m[1], +m[2], +m[3]]
	m = c.match(/^hsla?\(\s*([\d.]+)/)
	if (m) {
		const h = +m[1]
		return h >= 170 && h <= 260 ? [40, 120, 220] : [200, 100, 50]
	}
}

export const sameColor = (a: string, b: string) => {
	const x = rgb(a), y = rgb(b)
	return !!x && !!y && x.every((v, i) => Math.abs(v - y[i]) <= 8)
}

export const bluish = (color: string) => {
	if (color == "gradient") return true
	const c = rgb(color)
	return !!c && c[2] > c[0] + 20 && c[2] >= c[1] - 30
}
