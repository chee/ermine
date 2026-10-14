// a harness asked: one request per line in, one answer per line out
import { assertEquals } from "@std/assert"
import { line } from "./form.ts"

type Request = Record<string, unknown> & { op: string }
export type Answer = Record<string, unknown> & {
	entries?: unknown[][]
	nodes?: { value?: unknown; change: Record<string, unknown> }[]
	node?: { value?: unknown; change: Record<string, unknown> }
	bytes?: string
	code?: string
	part?: string
	id?: string
	error?: string
}

export async function ask(command: string[], requests: Request[]): Promise<Answer[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(60_000),
	}).spawn()
	// answers read while requests are written: a full pipe either way never stops both
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => line(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l)
		.map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}
