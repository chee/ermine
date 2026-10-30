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

type V8Error = {
	stackTraceLimit?: number
	captureStackTrace?: (holder: object, cut?: unknown) => void
	// how many lines ermine keeps: the host's Error.stackTraceLimit as createErmine booted (keepStackTraceLimit);
	// none: whatever the limit is now
	_ermineStackTraceLimit?: number
}

// ermine's limit: Error.stackTraceLimit as it is now, kept on Error as _ermineStackTraceLimit for
// every capture after, so a limit something else sets later changes nothing of ermine's [chee 10-30:
// "set at createErmine boot to Error.stackTraceLimit and then we read the limit from there"]. on
// Error, so every ermine in the realm shares it: the last booted's
export function keepStackTraceLimit() {
	const E = Error as unknown as V8Error
	E._ermineStackTraceLimit = E.stackTraceLimit
}

// the lines of the stack now, parsed, top first, up to ermine's limit. cut: the function called from
// outside (one of ermine's public ones); where the engine has captureStackTrace (every one ermine
// runs on), the lines from it inwards are left out, so the first line is its caller's and none are
// ermine's [chee 10-30]. else every line, this function's own too. build, a location known without a
// stack (@ermine/bundling's), stands in for it
export function capture(build?: Location, cut?: unknown): Location[] {
	if (build !== undefined) return [build]
	const E = Error as unknown as V8Error
	const limit = E.stackTraceLimit
	if (E._ermineStackTraceLimit !== undefined) E.stackTraceLimit = E._ermineStackTraceLimit
	try {
		const holder: { stack?: string } = {}
		if (typeof E.captureStackTrace === "function" && typeof cut === "function") {
			E.captureStackTrace(holder, cut)
		} else holder.stack = new Error().stack
		return frames(holder.stack ?? "")
	} finally {
		E.stackTraceLimit = limit
	}
}
