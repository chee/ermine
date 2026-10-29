// the reference scheduler on the line protocol: one JSON request per line in, one answer per line
// out, in order. another implementation joins by speaking this (SCHEDULER_HARNESS).
//
//   {"op":"new","rules"?,"site"?} -> {}  root "root", clock 0; rules: a "rules" node in the root
//   {"op":op,...} -> {"ok":a}  a host operation (normal.ts)
//   {"op":"start","address","program","name"?,"id"?} -> {"ok":pid}
//   {"op":"call","address","args"?,"actor"?,"person"?,"trusted"?} -> {"ok":answer}
//   {"op":"replace","address"} / {"op":"outro","id"} -> {"ok":null}
//   {"op":"batch","ops":[request...]} -> {"ok":[answer]}  all in one batch
//   {"op":"moments"}  moments since last asked, then forgotten
//   {"op":"log"}  what programs logged since last asked
//   {"op":"node","id"}  {value:[version], info:{n:[version]}, children:{n:[version]}, ephemeral}
//                       or null: not loaded
//   {"op":"header","id"}  its value's first change: {time, cause?, site?} or null
//   {"op":"clock"}  the last time given
//
// program: as steps.ts, or a path (list) read from the process's place; none there: pending.
// moment: as SCHEDULER.tex's, reads without items, errors as codes.
// error: {"error": code} (normal.ts); the harness goes on.
import createNode from "@ermine/graph/node"
import { rules } from "@ermine/protect"
import {
	type Api,
	createScheduler as reference,
	type Finder,
	type Moment,
	PENDING,
} from "@ermine/reactivity"
import { code, json, operate, version } from "./normal.ts"
import { load, program } from "./steps.ts"

const createScheduler = reference
type S = ReturnType<typeof reference>

let moments: unknown[] = []
let clock = { time: 0 }
let logged: unknown[] = []
const log = (v: unknown) => void logged.push(v)

function moment(m: Moment): unknown {
	const out = { ...m } as Record<string, unknown>
	if ("reads" in m) delete out.items
	if ("error" in out) out.error = code((m as { error: unknown }).error)
	return json(out)
}

// the host's code: the program at the path, read as the process
const finder: Finder = (process, view: Api) => {
	const found = view.content(process.program).find((it) => it.versions?.length)
	if (!found) return PENDING
	const v = found.versions![0]
	return { code: load(v.content, log), program: { node: found.id, time: v.change.time! } }
}

function make(q: Record<string, unknown>): S {
	moments = []
	logged = []
	clock = { time: 0 }
	const s = createScheduler({
		root: createNode("root", {}),
		clock,
		hooks: [(m) => moments.push(moment(m))],
		code: finder,
		...(q.rules ? { may: rules("rules") } : {}),
		...(q.site ? { site: () => q.site as never } : {}),
	})
	if (q.rules) {
		s.intro(
			createNode("rules", {
				value: [{ content: [], change: { time: 0, actor: "host", node: "rules" } }],
			}),
		)
		s.insert("root", "rules", "rules")
		s.write(["rules"], [{ path: [], value: q.rules }])
	}
	return s
}

let s = make({})

// deno-lint-ignore no-explicit-any
function answer(q: Record<string, any>): unknown {
	switch (q.op) {
		case "new":
			s = make(q)
			return undefined
		case "start": {
			const op: Record<string, unknown> = {
				address: q.address,
				program: program(q.program, log),
			}
			for (const f of ["name", "id"]) if (q[f] !== undefined) op[f] = q[f]
			return s.start(op as never).id
		}
		case "call": {
			const { op: _, ...rest } = q
			return json(s.call(rest as never))
		}
		case "replace":
			s.replace({ address: q.address })
			return null
		case "outro":
			s.outro(q.id)
			return null
		case "batch": {
			const out: unknown[] = []
			s.batch(() => {
				for (const r of q.ops) out.push(answer(r))
			})
			return out
		}
		case "moments": {
			const out = moments
			moments = []
			return out
		}
		case "log": {
			const out = logged
			logged = []
			return out
		}
		case "header": {
			const c = s.get(q.id)?.value[0]?.change
			if (!c) return null
			const out: Record<string, unknown> = { time: c.time }
			if (c.cause !== undefined) out.cause = c.cause
			if (c.site !== undefined) out.site = c.site
			return out
		}
		case "node": {
			const n = s.get(q.id)
			if (!n) return null
			const of = (m: Map<string, unknown[]>) =>
				Object.fromEntries([...m].map(([k, vs]) => [k, vs.map((v) => version(v as never))]))
			return {
				value: n.value.map((v) => version(v)),
				info: of(n.info),
				children: of(n.children as Map<string, unknown[]>),
				ephemeral: s.ephemeral(q.id),
			}
		}
		case "clock":
			return clock.time
		default: {
			const { op, ...fields } = q
			return operate(s, op, fields)
		}
	}
}

const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
let buffer = ""
const out = (v: unknown) =>
	Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(v) + "\n"))
for await (const chunk of lines) {
	buffer += chunk
	let i
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		try {
			const a = answer(JSON.parse(line))
			out(a === undefined ? {} : { ok: a })
		} catch (e) {
			out({ error: code(e) })
		}
	}
}
