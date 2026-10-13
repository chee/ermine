// runs measure.ts on every version given, RUNS times each, interleaved, and prints a table of
// the median of each run's medians, relative to the first version; noise is the spread of the
// RUNS medians as a share of their median
//
//   deno run --allow-read --allow-run core/places/typescript/optim/compare.ts ../trie.ts ./v1-single-kid.ts

const RUNS = Number(Deno.env.get("RUNS") ?? 5)
const versions = Deno.args.length ? Deno.args : ["../trie.ts"]
const here = new URL(".", import.meta.url).pathname
const results = new Map<string, Record<string, number>[]>(versions.map((v) => [v, []]))

for (let run = 0; run < RUNS; run++) {
	for (const v of versions) {
		const cmd = new Deno.Command(Deno.execPath(), {
			args: ["run", "--allow-read", `${here}measure.ts`, v],
			stdout: "piped",
			stderr: "inherit",
		})
		const out = await cmd.output()
		results.get(v)!.push(JSON.parse(new TextDecoder().decode(out.stdout).trim()))
	}
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	return s[s.length >> 1]
}
const cases = Object.keys(results.get(versions[0])![0])
const base: Record<string, number> = {}
const show = (v: string) => v.replace(/^\.\.?\//, "").replace(/\.ts$/, "")

console.log(`${RUNS} runs × 20 rounds; µs, median; ×: vs ${show(versions[0])}; ±: noise`)
console.log(["case", ...versions.map(show)].join("\t"))
for (const c of cases) {
	const row = [c]
	for (const v of versions) {
		const xs = results.get(v)!.map((r) => r[c])
		const m = median(xs)
		if (v === versions[0]) base[c] = m
		const noise = (Math.max(...xs) - Math.min(...xs)) / m
		const n = m >= 1000 ? `${(m / 1000).toFixed(2)}ms` : `${m.toFixed(0)}µs`
		row.push(`${n} ${(m / base[c]).toFixed(2)}× ±${(noise * 100).toFixed(0)}%`)
	}
	console.log(row.join("\t"))
}
