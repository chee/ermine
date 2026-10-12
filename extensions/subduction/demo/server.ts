// a Subduction server on this machine: subduction_cli (a build of inkandswitch/subduction), from
// SUBDUCTION_CLI, the PATH, or ../../../../inkandswitch/subduction/target/ beside this repository
const HERE = new URL(".", import.meta.url).pathname

function find(): string | undefined {
	const candidates = [
		Deno.env.get("SUBDUCTION_CLI"),
		...(Deno.env.get("PATH") ?? "").split(":").map((d) => `${d}/subduction_cli`),
		`${HERE}../../../../inkandswitch/subduction/target/release/subduction_cli`,
		`${HERE}../../../../inkandswitch/subduction/target/debug/subduction_cli`,
		`${Deno.env.get("HOME")}/soft/inkandswitch/subduction/target/debug/subduction_cli`,
	]
	for (const c of candidates) {
		if (!c) continue
		try {
			if (Deno.statSync(c).isFile) return c
		} catch { /* not there */ }
	}
}

// starts it on the port (open auth: any device may put and fetch), data in a fresh temp
// directory; resolves once it listens
export async function local(port = 8321): Promise<{ url: string; service: string; stop(): void }> {
	const cli = find()
	if (!cli) {
		throw new Error(
			"no subduction_cli: build one (cargo build -p subduction_cli in inkandswitch/subduction), " +
				"or set SUBDUCTION_CLI, or pass --server wss://galaxy.observer",
		)
	}
	const data = await Deno.makeTempDir({ prefix: "ermine-demo-subduction-" })
	const child = new Deno.Command(cli, {
		args: [
			"server",
			"--auth",
			"open",
			"--socket",
			`127.0.0.1:${port}`,
			"--service-name",
			`localhost:${port}`,
			"--data-dir",
			data,
			"--ephemeral-key",
			"--longpoll=false",
		],
		stdout: "null",
		stderr: "null",
	}).spawn()
	for (let i = 0; i < 50; i++) {
		try {
			;(await Deno.connect({ hostname: "127.0.0.1", port })).close()
			return {
				url: `ws://localhost:${port}`,
				service: `localhost:${port}`,
				stop() {
					try {
						child.kill()
					} catch { /* gone */ }
					Deno.remove(data, { recursive: true }).catch(() => {})
				},
			}
		} catch {
			await new Promise((r) => setTimeout(r, 100))
		}
	}
	child.kill()
	throw new Error(`subduction_cli did not listen on ${port}`)
}
