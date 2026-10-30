// Line-protocol harness for update.ts, one JSON request per line. State lasts for the process.
//   { op: "start", value?, header? }  -> {}   starts a fresh entry
//   { op: "update", patches, header? } -> {} | { error: { code, patch } }
//     the header defaults to { time: 1, actor: "me" }; a refused update changes nothing
//   { op: "entry" }  -> { entry: { value?, change } }
// Values use the JSON form of conformance/typescript/form.ts. Other errors are { error: text }.
import type { Changeable, ChangeHeader } from "@ermine/changeable"
import update from "@ermine/changeable/update"
import { ApplyError, type Patch } from "@ermine/changeable/apply"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { fromList, toList } from "../../conformance/typescript/frames.ts"

const createChangeable = <V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
): Changeable<V> => {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const c: Changeable<V> = { change }
	if (value !== undefined) c.value = value
	return c
}
let entry: Changeable<unknown> = createChangeable(undefined)

const pick = (o: Record<string, unknown>, keys: string[]) => {
	const out: Record<string, unknown> = {}
	for (const k of keys) if (k in o) out[k] = o[k]
	return out
}
const patchShape = (p: Patch) =>
	pick(p as unknown as Record<string, unknown>, ["path", "range", "value", "move"])
const changeShape = (c: Changeable<unknown>["change"]) => {
	const out = pick(c, ["time", "actor", "reader"])
	if (c.frame !== undefined) out.frame = toList(c.frame)
	if (c.op) {
		out.op = {
			patches: c.op.patches.map(patchShape),
			undo: c.op.undo.map(patchShape),
		}
	}
	return toJson(out)
}

const given = (h: ChangeHeader | undefined) => {
	if (h === undefined || !("frame" in h)) return h
	const frame = fromList(h.frame)
	if (frame === undefined) throw new Error("frame is not a list of objects")
	return { ...h, frame }
}

function answer(r: Request) {
	try {
		return run(r)
	} catch (e) {
		if (e instanceof ApplyError) return { error: { code: e.code, patch: e.patch } }
		throw e
	}
}

function run(r: Request) {
	switch (r.op) {
		case "start":
			entry = createChangeable(
				r.value === undefined ? undefined : revive(r.value),
				given(r.header),
			)
			return {}
		case "entry": {
			const change = changeShape(entry.change)
			return {
				entry: { ...("value" in entry ? { value: toJson(entry.value) } : {}), change },
			}
		}
		case "update": {
			const header = given(r.header) ?? { time: 1, actor: "me" } as ChangeHeader
			const patches = (r.patches as Patch[]).map((p) => revive(p) as Patch)
			update(entry, patches, header)
			return {}
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
