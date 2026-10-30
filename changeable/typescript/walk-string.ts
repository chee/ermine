// String positions count code points (a pair or a lone surrogate is one); with utf16 they are
// UTF-16 units. The walk jumps by regex to the first surrogate, then pair to pair, then unit by unit.

const sur = /[\uD800-\uDFFF]/
const pair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g

function step(
	s: string,
	i: number,
	k: number,
	a: number,
	b: number,
	all: boolean,
	x: number,
	y: number,
): [number, number, number] | null {
	const u = s.length
	if (x < 0) {
		for (; k < a; k++) {
			if (i >= u) return null
			const c = s.charCodeAt(i)
			i += c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
		}
		x = i
	}
	if (y < 0) {
		for (; k < b; k++) {
			if (i >= u) return null
			const c = s.charCodeAt(i)
			i += c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
		}
		y = i
	}
	if (!all) return [x, y, -1]
	for (; i < u; k++) {
		const c = s.charCodeAt(i)
		i += c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
	}
	return [x, y, k]
}

const DENSE = 16, AFTER = 8

export function walk(
	s: string,
	a: number,
	b: number,
	all = false,
	utf16 = false,
): [number, number, number] | null {
	const u = s.length
	if (utf16) return b <= u ? [a, b, all ? u : -1] : null
	const f = s.search(sur)
	if (f < 0) return b <= u ? [a, b, all ? u : -1] : null
	let i = f, k = f
	let x = a <= f ? a : -1, y = b <= f ? b : -1
	if (y >= 0 && !all) return [x, y, -1]
	pair.lastIndex = f
	let pairs = 0, m
	while ((m = pair.exec(s)) !== null) {
		const at = k + (m.index - i)
		if (x < 0 && a <= at) x = i + (a - k)
		if (y < 0 && b <= at) {
			y = i + (b - k)
			if (!all) return [x, y, -1]
		}
		i = m.index + 2
		k = at + 1
		if (++pairs >= AFTER && i - f < pairs * DENSE) return step(s, i, k, a, b, all, x, y)
	}
	if (x < 0) x = i + (a - k)
	if (y < 0) y = i + (b - k)
	if (y > u) return null
	return [x, y, all ? k + (u - i) : -1]
}

export type Hint = { n: number; k: number; i: number }

function back(s: string, i: number, k: number, a: number): number {
	for (; k > a; k--) {
		const c = s.charCodeAt(--i)
		if ((c & 0xfc00) === 0xdc00 && i > 0 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800) i--
	}
	return i
}

export function near(
	s: string,
	a: number,
	b: number,
	all: boolean,
	h: Hint,
): [number, number, number] | null {
	const { n, k, i } = h
	if (n >= 0 && b > n) return null
	const fromEnd = n >= 0 ? n - a : Infinity
	const fromHint = Math.abs(a - k)
	if (a <= fromHint && a <= fromEnd) {
		const w = walk(s, a, b, all && n < 0)
		return w && n >= 0 ? [w[0], w[1], n] : w
	}
	let x: number
	if (fromEnd < fromHint) x = back(s, s.length, n, a)
	else if (a < k) x = back(s, i, k, a)
	else {
		const w = step(s, i, k, a, a, false, -1, -1)
		if (!w) return null
		x = w[0]
	}
	const w = step(s, x, a, a, b, all && n < 0, x, -1)
	if (!w) return null
	return [x, w[1], n >= 0 ? n : w[2]]
}

export function joins(s: string, u: number): boolean {
	return u > 0 && (s.charCodeAt(u - 1) & 0xfc00) === 0xd800 &&
		(s.charCodeAt(u) & 0xfc00) === 0xdc00
}

export function count(s: string, utf16 = false): number {
	return utf16 ? s.length : walk(s, 0, 0, true)![2]
}

export function unit(s: string, n: number, utf16 = false): number {
	return walk(s, n, n, false, utf16)?.[0] ?? -1
}

export function slice(s: string, a: number, b: number, utf16 = false): string {
	if (a < 0 || b <= a) return ""
	if (utf16) return s.slice(a, b)
	const w = walk(s, a, b)
	if (w) return s.slice(w[0], w[1])
	const x = unit(s, a)
	return x < 0 ? "" : s.slice(x)
}

export function stepped(
	s: string,
	a: number,
	b: number,
	all = false,
): [number, number, number] | null {
	return step(s, 0, 0, a, b, all, -1, -1)
}
