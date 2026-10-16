import { js, wasm } from "./blake3.ts"

for (const [name, n] of [["1KB", 1024], ["64KB", 65536], ["2MB", 2 * 1024 * 1024]] as const) {
	const data = crypto.getRandomValues(new Uint8Array(n % 65536 || 65536))
	const input = new Uint8Array(n)
	for (let o = 0; o < n; o += data.length) {
		input.set(data.subarray(0, Math.min(data.length, n - o)), o)
	}
	Deno.bench(`js ${name}`, { group: name }, () => void js(input))
	Deno.bench(`wasm ${name}`, { group: name, baseline: true }, () => void wasm(input))
}
