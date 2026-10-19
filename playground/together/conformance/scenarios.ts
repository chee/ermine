// The generators' one way of writing a scenario in the main run's format (conformance/run.ts):
// { title, steps: [{ ...request, expect }] }. The generators say a scenario in the old shapes,
// { title, steps: [{ request, expect }] }, { title, ask: [...], expect: [...] } or
// { title, request, expect } (fragment), and this turns it into the new.
// an answer must be an object: what the harnesses answer that was not one is a field named by its op
// (heads, waiting, refused, checked, versions, fragments, stored), and an add's answer is { added }
// deno-lint-ignore-file no-explicit-any
type Step = { request: Record<string, any>; expect: unknown }

const WRAPPED = ["heads", "waiting", "refused", "checked", "versions", "fragments", "stored"]
const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

export function step({ request, expect }: Step) {
	for (const k of ["expect", "fails", "skip"]) {
		if (k in request) throw new Error(`a request has a field ${k}: ${JSON.stringify(request)}`)
	}
	const op = request.op
	let want = expect
	if (op === "add") want = { added: expect }
	else if (!isMap(expect)) {
		if (!WRAPPED.includes(op)) throw new Error(`${op}: an answer that is no object: ${expect}`)
		want = { [op]: expect }
	}
	return { ...request, expect: want }
}

export function scenario(
	s: Record<string, any>,
): { title: string; steps: ReturnType<typeof step>[] } & Record<string, unknown> {
	const { title, steps, ask, expect, request, ...rest } = s
	const list: Step[] = steps ??
		(ask
			? ask.map((r: any, i: number) => ({
				request: typeof r === "string" ? { op: r } : r,
				expect: expect[i],
			}))
			: [{ request, expect }])
	return { title, ...rest, steps: list.map(step) }
}

// the file's text
export const text = (s: any) => JSON.stringify(scenario(s), null, "\t") + "\n"
