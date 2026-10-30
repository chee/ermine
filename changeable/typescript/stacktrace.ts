// A place in code. `external` means it came from outside the graph (a parsed stack).
export type Location = {
	file: string
	line: number
	column?: number
	function?: string
	external: boolean
}

// One line of a stack, as V8 writes it ("    at fn (file:1:2)") or as JavaScriptCore and
// SpiderMonkey do ("fn@file:1:2").
const V8 = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
const AT = /^(.*?)@(.+?):(\d+):(\d+)\s*$/

// Only one style is read per stack, so a V8 message line is never taken as a frame.
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
	_ermineStackTraceLimit?: number
}

// Remembers Error.stackTraceLimit as booted; it lives on Error, so every ermine shares it.
export function keepStackTraceLimit() {
	const E = Error as unknown as V8Error
	E._ermineStackTraceLimit = E.stackTraceLimit
}

// Returns the current stack parsed, top first. Lines from `cut` inwards are left out; `build` is a
// location known without a stack, standing in for it.
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
