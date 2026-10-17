// the loop of every suite's TypeScript harness: one JSON request per line in, one answer per line
// out, in order. a suite's adapter (<package>/typescript/<suite>_harness.ts) is the function from
// a request to its answer; what lasts between lines is the adapter's. a line that is not JSON, or
// an adapter that throws, is answered { error: "text" } and the loop goes on
import { line } from "./form.ts"
import { parse } from "./json.ts"

// deno-lint-ignore no-explicit-any
export type Request = Record<string, any>
export type Answer = Record<string, unknown>

export async function serve(answer: (request: Request) => Answer | Promise<Answer>) {
	const out = Deno.stdout.writable.getWriter()
	const encoder = new TextEncoder()
	const one = async (text: string): Promise<string> => {
		try {
			return line(await answer(parse(text) as Request))
		} catch (e) {
			return JSON.stringify({ error: String(e) })
		}
	}
	let buffer = ""
	for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
		buffer += chunk
		let i
		let lines = ""
		while ((i = buffer.indexOf("\n")) !== -1) {
			const text = buffer.slice(0, i)
			buffer = buffer.slice(i + 1)
			if (text.trim() === "") continue
			lines += (await one(text)) + "\n"
		}
		if (lines) await out.write(encoder.encode(lines))
	}
}
