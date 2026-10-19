// the C peer for tests: littlesync-pigs --pipe (playground/demos/pigs/littlesync/peer.c), speaking
// littlesync on its stdin and stdout, its screen in a dump file and its protocol events in a log.
// PIGS: the binary (make pigs builds it into build/ here)
export const PIGS = Deno.env.get("PIGS") ??
	new URL("./build/littlesync-pigs", import.meta.url).pathname

export type Pigs = {
	dir: string
	// bytes to its stdin
	write(bytes: Uint8Array): Promise<void>
	// each chunk of its stdout
	on(fn: (bytes: Uint8Array) => void): void
	// its screen now, and its protocol log ("" before there is one)
	dump(): string
	log(): string
	// SIGTERM (it saves its nodes), then waits for it
	stop(): Promise<void>
	done: Promise<Deno.CommandStatus>
}

export async function spawnPigs(
	o: { dir?: string; keys?: string; name?: string; exitAfter?: number; room?: string } = {},
): Promise<Pigs> {
	try {
		await Deno.stat(PIGS)
	} catch {
		throw new Error(`no ${PIGS}: make pigs (in this folder) builds it`)
	}
	const dir = o.dir ?? await Deno.makeTempDir({ prefix: "littlesync-gateway-" })
	const args = [
		"--pipe",
		"--state",
		`${dir}/state`,
		"--dump",
		`${dir}/dump.txt`,
		"--log",
		`${dir}/log.txt`,
	]
	if (o.keys) args.push("--keys", o.keys)
	if (o.name) args.push("--name", o.name)
	if (o.room) args.push("--room", o.room)
	args.push("--exit-after", String(o.exitAfter ?? 120000))
	const child = new Deno.Command(PIGS, {
		args,
		stdin: "piped",
		stdout: "piped",
		stderr: "inherit",
	})
		.spawn()
	const writer = child.stdin.getWriter()
	const fns: ((b: Uint8Array) => void)[] = []
	;(async () => {
		for await (const chunk of child.stdout) for (const f of fns) f(chunk)
	})()
	const read = (f: string) => {
		try {
			return Deno.readTextFileSync(`${dir}/${f}`)
		} catch {
			return ""
		}
	}
	return {
		dir,
		write: (b) => writer.write(b).catch(() => {}),
		on: (fn) => void fns.push(fn),
		dump: () => read("dump.txt"),
		log: () => read("log.txt"),
		async stop() {
			try {
				child.kill("SIGTERM")
			} catch { /* gone already */ }
			await child.status
			await writer.close().catch(() => {})
		},
		done: child.status,
	}
}

// until f gives something truthy, or ms pass (then throws what: the message)
export async function until<T>(
	f: () => T,
	ms: number,
	what: string,
): Promise<Exclude<T, undefined | null | false | "" | 0>> {
	const stop = Date.now() + ms
	for (;;) {
		const v = f()
		if (v) return v as Exclude<T, undefined | null | false | "" | 0>
		if (Date.now() > stop) throw new Error(`${what}: not in ${ms} ms`)
		await new Promise((r) => setTimeout(r, 50))
	}
}

// a pig's row on the C peer's screen: "a d3b58353 x=0.50 y=0.50 ...", by the first 8 hex of its id
export function row(dump: string, id: string): string | undefined {
	const h = id.replace("ermine://", "").slice(0, 8)
	return dump.split("\n").find((l) => l.slice(2, 10) === h)
}

// the pig ids the C peer's room lists, by their first 8 hex
export const rows = (dump: string) =>
	dump.split("\n").filter((l) => /^[a-z] [0-9a-f]{8} x=/.test(l)).map((l) => l.slice(2, 10))
