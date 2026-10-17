// two devices in one process: cursors move, one leaves. run:
//   deno run --allow-all extensions/presence/typescript/example.ts
import { createPair } from "./channel.ts"
import { clear, connect, readPresence, renew, setPresence, sweep } from "./presence.ts"
import { device } from "./world.ts"

const clock = { t: 0 }
const juno = device("juno", clock), chee = device("chee", clock)
const pair = createPair("juno", "chee")
const anchor = "juno-pad"
connect(juno, pair.a, { topic: anchor })
connect(chee, pair.b, { topic: anchor })

const show = (d: typeof juno, as: string) => {
	const rows = readPresence(d, anchor).map((r) => `${r.who} ${JSON.stringify(r.value)}`)
	console.log(`  t=${clock.t}ms ${as} sees: ${rows.join(", ") || "nobody"}`)
}

// chee's screen: a computation, rerun as rows arrive, change or leave
let reruns = 0
chee.scheduler.runWithScope(
	chee.scope,
	() => chee.scheduler.createComputer(() => (reruns++, readPresence(chee, anchor)), () => {}),
)
chee.scheduler.pulse()

console.log("juno arrives and moves her cursor")
for (let i = 0; i < 4; i++) {
	clock.t += 16
	setPresence(juno, anchor, "juno", { cursor: [10 + i * 5, 40] }, 2000)
	chee.scheduler.pulse()
	show(chee, "chee")
}
console.log("chee arrives too")
setPresence(chee, anchor, "chee", { cursor: [1, 1] }, 2000)
show(juno, "juno")

console.log("juno heartbeats; chee goes quiet")
clock.t += 1500
renew(juno, anchor, "juno", 2000)
clock.t += 600
console.log("  swept on juno's side:", sweep(juno).map((r) => r.who).join(", "))
show(juno, "juno")

console.log("juno leaves")
clear(juno, anchor, "juno")
chee.scheduler.pulse()
show(chee, "chee")
console.log(`chee's screen reran ${reruns} times; ${pair.sent.length} messages crossed`)
