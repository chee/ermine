// the gateway against a real server (UPSTREAM, default wss://galaxy.observer), in lab-pig's room:
// main.ts as its own process, littlesync-pigs (C) over --pipe relayed to its /littlesync WebSocket,
// and a lab-pig-style sync.ts device on the same server. what the room refuses is printed, not
// failed on: the merge gap (gateway.ts, merges) is the thing to see
import { assert } from "@std/assert"
import { createHost } from "./host_harness.ts"
import { type Pigs, row, spawnPigs, until } from "./pigs_harness.ts"

const UPSTREAM = Deno.env.get("UPSTREAM") ?? "wss://galaxy.observer"
const ROOM = "ermine://bf04115f9b284145026eab6801219d6e" + "0".repeat(32)
const opts = { sanitizeOps: false, sanitizeResources: false }

// main.ts, on a free port: its log lines kept
async function gateway() {
	const port = 20000 + Math.floor(Math.random() * 20000)
	const child = new Deno.Command(Deno.execPath(), {
		args: [
			"run",
			"--allow-net",
			"--allow-env",
			"--allow-read",
			new URL("./main.ts", import.meta.url).pathname,
		],
		env: { PORT: String(port), UPSTREAM },
		stdout: "piped",
		stderr: "piped",
	}).spawn()
	const lines: string[] = []
	for (const s of [child.stdout, child.stderr]) {
		;(async () => {
			let buf = ""
			for await (const t of s.pipeThrough(new TextDecoderStream())) {
				buf += t
				const parts = buf.split("\n")
				buf = parts.pop()!
				lines.push(...parts)
			}
		})()
	}
	await until(
		() => lines.some((l) => l.includes("upstream") && l.includes("connected")),
		30000,
		"the gateway joins upstream",
	)
		.catch((e) => {
			throw new Error(`${e.message}\n${lines.join("\n")}`)
		})
	const status = async () => await (await fetch(`http://localhost:${port}/`)).json()
	return {
		port,
		lines,
		status,
		async stop() {
			child.kill("SIGTERM")
			await child.status
		},
	}
}

// a C peer through the gateway's WebSocket
async function cPeer(port: number, o: Parameters<typeof spawnPigs>[0]): Promise<Pigs> {
	const pigs = await spawnPigs(o)
	const ws = new WebSocket(`ws://localhost:${port}/littlesync`)
	ws.binaryType = "arraybuffer"
	await new Promise((r, j) => (ws.onopen = r, ws.onerror = j))
	ws.onmessage = (e) => void pigs.write(new Uint8Array(e.data as ArrayBuffer))
	pigs.on((b) => ws.readyState === WebSocket.OPEN && ws.send(b))
	pigs.done.then(() => ws.close())
	return pigs
}

Deno.test({
	name: `galaxy: a C pig through the gateway reaches a TS device on ${UPSTREAM}, and back`,
	...opts,
	async fn() {
		const g = await gateway()
		const host = await createHost("ts-galaxy")
		let pigs: Pigs | undefined
		const report: string[] = []
		try {
			await host.device.connectDiscover(UPSTREAM)
			await host.sync.follow(ROOM)
			const before = await until(() => host.read(ROOM), 30000, "the room on the TS device")
			report.push(`room on the TS device: ${Object.keys(before).length} keys`)
			const dir = await Deno.makeTempDir({ prefix: "littlesync-galaxy-" })
			// the C peer: 10 s for the room to come, adds a pig, then picks it up and carries it
			pigs = await cPeer(g.port, { dir, keys: ".".repeat(20) + "a" + ".".repeat(8) + " lll" })
			let followed: string[] = []
			const poll = setInterval(() => g.status().then((st) => followed = st.followed), 500)
			const id = await until(
				() => {
					const d = pigs!.dump()
					const sel = d.split("\n").find((l) => l.startsWith("selected "))?.[9]
					if (!sel || sel === "-" || !d.includes("carrying " + sel)) return
					const r = d.split("\n").find((l) => l.startsWith(sel + " "))
					return r && followed.find((f) => f.startsWith("ermine://" + r.slice(2, 10)))
				},
				40000,
				"the C peer's new pig, carried, followed at the gateway",
			).finally(() => clearInterval(poll))
			assert(id)
			report.push(`C pig ${id}`)
			await host.sync.follow(id)
			const value = await until(() => host.read(id), 30000, "the C pig's value on the TS device")
			report.push(`C pig on the TS device: ${JSON.stringify(value)}`)
			const held = await until(
				() => host.read(id)?.held === true && host.read(id),
				30000,
				"the C hold on the TS device",
			)
			report.push(`C hold on the TS device: ${JSON.stringify(held)}`)
			// the room: whether the C peer's key landed, or what refused it
			await new Promise((r) => setTimeout(r, 2000))
			report.push(`room key on the TS device: ${JSON.stringify(host.read(ROOM)?.[id])}`)
			const refused = host.device.history(ROOM).refused()
			report.push(
				`room refusals on the TS device: ${
					JSON.stringify(refused.slice(-5))
				} (${refused.length})`,
			)
			const rh = pigs.log().split("\n").filter((l) =>
				l.includes("heads bf04115f") || l.includes("refused")
			)
			report.push(`C log, the room's heads and refusals: ${rh.slice(-4).join(" | ")}`)
			await pigs.stop()

			// TS → C
			pigs = await cPeer(g.port, { dir })
			host.store(id, { x: 0.25, y: 0.75, at: Date.now(), seed: 9 })
			await until(
				() => row(pigs!.dump(), id)?.includes("x=0.25 y=0.75"),
				30000,
				"the TS move on the C screen",
			)
			report.push(`TS move on the C screen: ${row(pigs.dump(), id)}`)
			const wave = () =>
				host.wave(id, { x: 0.5, y: 0.5, held: true, by: "tsdev", colour: "#000000", who: "ts" })
			wave()
			const beat = setInterval(wave, 500)
			try {
				await until(
					() => row(pigs!.dump(), id)?.includes("held by tsdev"),
					30000,
					"the TS hold on the C screen",
				)
			} finally {
				clearInterval(beat)
			}
			report.push(`TS hold on the C screen: ${row(pigs.dump(), id)}`)
			// tidy: the test pig binned for everyone (lab-pig's format)
			host.store(id, { x: 0.96, y: 0.96, at: Date.now(), seed: 1, binned: true })
			host.set(ROOM, id, false)
			await host.sync.idle()
			const st = await g.status()
			report.push(`gateway stats: ${JSON.stringify(st.stats)}`)
			report.push(`gateway refusals: ${JSON.stringify(st.refusals)}`)
		} catch (e) {
			report.push(`gateway log:\n${g.lines.join("\n")}`)
			if (pigs) {
				report.push(
					`C screen:\n${pigs.dump()}\nC log (tail):\n${
						pigs.log().split("\n").slice(-30).join("\n")
					}`,
				)
			}
			throw e
		} finally {
			console.log(report.join("\n"))
			console.log(
				"gateway log, merges and refusals:\n" +
					g.lines.filter((l) => /merge|refused|can't send|waiting/.test(l)).slice(0, 40).join(
						"\n",
					),
			)
			await pigs?.stop()
			await host.close()
			await g.stop()
		}
	},
})
