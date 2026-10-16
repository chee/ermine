// walk_check.ts: ermine-pigs walks as the web page does. program.ts's own hash, random, pathOf and
// walk (everything above its program, taken from the file as it is now) and walk-test are asked the
// same cases, half with the corner of shame open; the answers must agree to a few ulps (the sines
// of two libms)
const dir = new URL(".", import.meta.url).pathname
const source = await Deno.readTextFile(
	`${dir}../ermine-slaygrounds/examples/lab-pig/program.ts`,
)
const top = source.slice(0, source.indexOf("export default function program"))
	.split("\n").filter((l) => !/^import |@jsxImportSource/.test(l)).join("\n")
const file = await Deno.makeTempFile({ suffix: ".ts" })
await Deno.writeTextFile(file, top + "\nexport { hash, pathOf, random, walk }\n")
const m = await import(`file://${file}`)
await Deno.remove(file)

const ids = [
	"ermine://f849ff1304dc7e0cba4d758258a6a907" + "0".repeat(32),
	"ermine://1a42463ee0b3694e305ac7dd448832e0" + "0".repeat(32),
	"ermine://0123456789abcdef0123456789abcdef" + "0".repeat(32),
]
const cases: string[] = []
const now = Date.now()
const r = m.random(12345)
for (let i = 0; i < 300; i++) {
	const id = ids[i % ids.length]
	const x = r(), y = r(), seed = Math.floor(r() * 2 ** 32)
	const at = now - Math.floor(r() * 1e9), t = at + Math.floor(r() * 3e8)
	cases.push(`${id} ${x} ${y} ${at} ${seed} ${t} ${i % 2}`)
}
const run = new Deno.Command(`${dir}walk-test`, { stdin: "piped", stdout: "piped" }).spawn()
const w = run.stdin.getWriter()
await w.write(new TextEncoder().encode(cases.join("\n") + "\n"))
await w.close()
const out = new TextDecoder().decode((await run.output()).stdout).trim().split("\n")
let worst = 0, bad = 0
for (const [i, line] of cases.entries()) {
	const [id, x, y, at, seed, t, open] = line.split(" ")
	const c = JSON.parse(out[i])
	const path = m.pathOf({ held: false, x: +x, y: +y, at: +at, seed: +seed })
	const js = m.walk(path, +at, +t, open === "1")
	const size = 0.86 + 0.24 * m.random(m.hash(id))()
	if (c.hash !== m.hash(id)) bad++, console.log("hash", id, c.hash, m.hash(id))
	for (const [k, a, b] of [["x", c.x, js.x], ["y", c.y, js.y], ["size", c.size, size]] as const) {
		const d = Math.abs(a - b)
		worst = Math.max(worst, d)
		if (d > 1e-9) bad++, console.log(k, line, a, b)
	}
}
console.log(`${cases.length} cases, worst difference in x, y ${worst.toExponential(2)}, ${bad} bad`)
Deno.exit(bad ? 1 : 0)
