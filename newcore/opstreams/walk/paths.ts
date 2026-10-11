// fast paths for walk(s, a, b, all), benched against each other (walk_bench.ts) and fuzzed
// against walk.ts (walk_test.ts). each answers exactly as walk.ts does; the winner went into walk.ts
import { stepped, walk } from "../walk.ts"

export type Walk = (
	s: string,
	a: number,
	b: number,
	all: boolean,
) => [number, number, number] | null

const sur = /[\uD800-\uDFFF]/
const pair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g
const isHigh = (c: number) => (c & 0xfc00) === 0xd800
const isLow = (c: number) => (c & 0xfc00) === 0xdc00

// positions as units, b checked against the length
const direct = (s: string, a: number, b: number, all: boolean): [number, number, number] | null =>
	b <= s.length ? [a, b, all ? s.length : -1] : null

// walk.ts's walk, begun at unit and position `from`: positions before it are units
function from(
	s: string,
	f: number,
	a: number,
	b: number,
	all: boolean,
): [number, number, number] | null {
	const u = s.length
	let i = Math.min(f, a), k = i
	for (; k < a; k++) {
		if (i >= u) return null
		if (isHigh(s.charCodeAt(i++)) && isLow(s.charCodeAt(i))) i++
	}
	const x = i
	for (; k < b; k++) {
		if (i >= u) return null
		if (isHigh(s.charCodeAt(i++)) && isLow(s.charCodeAt(i))) i++
	}
	const y = i
	if (!all) return [x, y, -1]
	for (; i < u; k++) if (isHigh(s.charCodeAt(i++)) && isLow(s.charCodeAt(i))) i++
	return [x, y, k]
}

// from unit and position `f` on, by jumping pair to pair: each pair before a position moves it
// one unit on; lone surrogates move nothing
function jump(
	s: string,
	f: number,
	a: number,
	b: number,
	all: boolean,
): [number, number, number] | null {
	pair.lastIndex = f
	let shift = 0, pairs = 0, x = -1, y = -1, m
	while ((m = pair.exec(s)) !== null) {
		const at = m.index - shift // the pair's position, if nothing before it moved
		if (x < 0 && at >= a) x = a + shift
		if (y < 0 && at >= b) {
			y = b + shift
			if (!all) break
		}
		shift++
		pairs++
	}
	if (x < 0) x = a + shift
	if (y < 0) y = b + shift
	if (y > s.length || x > s.length) return null
	return [x, y, all ? s.length - pairs : -1]
}

// step unit by unit from unit i, position k, until a's and b's units are found (and, all, the end)
// x, y: already found, or -1
function finish(
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

// how many pairs, and how close, before stepping beats jumping: more than one in 16 units
const DENSE = 16, AFTER = 8

// to the first surrogate at once, then pair to pair while pairs are sparse, then unit by unit
function adaptive(s: string, a: number, b: number, all: boolean): [number, number, number] | null {
	const f = s.search(sur)
	if (f < 0) return direct(s, a, b, all)
	const u = s.length
	// unit i is position k; before f, every position is its unit
	let i = f, k = f
	let x = a <= f ? a : -1, y = b <= f ? b : -1
	if (y >= 0 && !all) return [x, y, -1]
	pair.lastIndex = f
	let pairs = 0, m
	while ((m = pair.exec(s)) !== null) {
		const at = k + (m.index - i) // the pair's position
		if (x < 0 && a <= at) x = i + (a - k)
		if (y < 0 && b <= at) {
			y = i + (b - k)
			if (!all) return [x, y, -1]
		}
		i = m.index + 2
		k = at + 1
		if (++pairs >= AFTER && (i - f) < pairs * DENSE) return finish(s, i, k, a, b, all, x, y)
	}
	// no pair left: the rest is one unit a position
	if (x < 0) x = i + (a - k)
	if (y < 0) y = i + (b - k)
	if (y > u) return null
	return [x, y, all ? k + (u - i) : -1]
}

export const paths: Record<string, Walk> = {
	// unit by unit from the start, as walk.ts was
	"as now": (s, a, b, all) => stepped(s, a, b, all),
	// walk.ts now: what follows was tried to find it
	"walk.ts": (s, a, b, all) => walk(s, a, b, all),
	// no surrogate at all: positions are units
	plain: (s, a, b, all) => sur.test(s) ? stepped(s, a, b, all) : direct(s, a, b, all),
	// positions before the first surrogate are units: walk only from there
	first: (s, a, b, all) => {
		const f = s.search(sur)
		return f < 0 ? direct(s, a, b, all) : from(s, f, a, b, all)
	},
	// from the start, pair to pair
	pairs: (s, a, b, all) => jump(s, 0, a, b, all),
	// walk.ts's loop, one compare a unit
	tight: (s, a, b, all) => from(s, 0, a, b, all),
	"sparse jump, dense walk": adaptive,
	"first + pairs": (s, a, b, all) => {
		const f = s.search(sur)
		return f < 0 ? direct(s, a, b, all) : jump(s, f, a, b, all)
	},
}
