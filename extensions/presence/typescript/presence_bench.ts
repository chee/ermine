// bytes sent for a 300-point live stroke grown one point at a time, whole rows against patches.
//   deno run typescript/presence_bench.ts
import { createPair } from "./channel.ts"
import { connect, editPresence, setPresence } from "./presence.ts"
import { device } from "./world.ts"

function run(patches: boolean, points: number) {
	const clock = { t: 0 }
	const a = device("a", clock), b = device("b", clock)
	const pair = createPair("a", "b")
	connect(a, pair.a, { topic: "canvas", patches })
	connect(b, pair.b, { topic: "canvas", patches })
	setPresence(a, "canvas", "stroke", { pts: [] }, 5000)
	for (let i = 0; i < points; i++) {
		clock.t += 16
		editPresence(a, "canvas", "stroke", [
			{
				path: ["pts"],
				range: [i, i],
				value: [[Math.round(Math.random() * 1000), Math.round(Math.random() * 1000)]],
			},
		], 5000)
	}
	const sent = pair.sent.filter((m) => m.from === "a")
	const bytes = sent.reduce((n, m) => n + m.bytes.length, 0)
	const row = JSON.stringify((b.table.get("presence", "canvas")!.value as any).a.value)
	const mine = JSON.stringify((a.table.get("presence", "canvas")!.value as any).stroke.value)
	return { messages: sent.length, bytes, same: row === mine }
}

for (const patches of [false, true]) {
	const r = run(patches, 300)
	console.log(
		`patches ${
			patches ? "on " : "off"
		}: ${r.messages} messages, ${r.bytes} bytes total, receiver matches: ${r.same}`,
	)
}
