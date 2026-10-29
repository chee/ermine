// a place in code. external: from outside the graph (a stack parsed where a change came in), else
// code inside it (later, with programs)
export type Location = {
	file: string
	line: number
	column?: number
	function?: string
	external: boolean
}

// one line of a stack, as V8 writes it ("    at fn (file:1:2)", "    at file:1:2")
// or as JavaScriptCore and SpiderMonkey do ("fn@file:1:2", "@file:1:2")
const V8 = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
const AT = /^(.*?)@(.+?):(\d+):(\d+)\s*$/

// the locations of a stack, top first, each external; lines that are not frames are left out.
// one way of writing per stack: a V8 stack's message line is never read as a frame
export function frames(stack: string): Location[] {
	const lines = stack.split("\n")
	const way = lines.some((l) => V8.test(l)) ? V8 : AT
	const out: Location[] = []
	for (const raw of lines) {
		const m = way.exec(raw)
		if (!m) continue
		const [, name, file, line, column] = m
		const at: Location = { file, line: Number(line), column: Number(column), external: true }
		if (name) at.function = name
		out.push(at)
	}
	return out
}

type V8Error = { stackTraceLimit?: number }

// every line of the stack now, parsed (top first, this function's own too): nothing is skipped, so
// no one needs to know which lines are whose. the limit raised for the capture and put back. build,
// a location known without a stack (@ermine/bundling's), stands in for it
export function capture(build?: Location): Location[] {
	if (build !== undefined) return [build]
	const E = Error as unknown as V8Error
	const limit = E.stackTraceLimit
	E.stackTraceLimit = Infinity
	try {
		return frames(new Error().stack ?? "")
	} finally {
		E.stackTraceLimit = limit
	}
}
