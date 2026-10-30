// A seeded generator for the fuzzers: n -> a whole number in 0 ... n - 1 (xorshift).
export function rand(seed: number): (n: number) => number {
	let x = seed * 2654435761 >>> 0 || 1
	return (n) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}
