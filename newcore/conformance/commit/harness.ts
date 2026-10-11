// The reference commit.ts on the line protocol (../apply/session.ts): the apply ops, and commit.
// A live value in a change, which JSON cannot hold: the marker {"$live": kind}, kind any value in
// its JSON form (null too), made here into an object of a class, Live; the host's kind(value)
// is that kind. So the blop has a stand-in over the kind where the marker was (COMMIT.tex).
import { commit } from "../../sync/ts/commit.ts"
import { fromJson } from "../pack/form.ts"
import { answer, blopOut, type Request, serve, state, toArray, unhex } from "../apply/session.ts"

class Live {
	constructor(readonly kind: unknown) {}
}
function lives(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(lives)
	if (x === null || typeof x !== "object" || x instanceof ArrayBuffer || ArrayBuffer.isView(x)) {
		return x
	}
	const o = x as Record<string, unknown>
	const keys = Object.keys(o)
	if (keys.length === 1 && keys[0] === "$live") return new Live(lives(o.$live))
	return Object.fromEntries(keys.map((k) => [k, lives(o[k])]))
}
const kind = (x: unknown) => x instanceof Live ? x.kind : null

type At = { version?: number; span?: [number, number]; pop?: number | [number, number] }

function answerCommit(r: Request): unknown {
	if (r.op !== "commit") return answer(r)
	const c = lives(fromJson(r.change)) as Record<string, unknown>
	const change = { ...c, signer: toArray(c.signer as ArrayBuffer) }
	const at = r.at as At
	const where = at.version ?? at.span ?? { pop: at.pop }
	const random = unhex(r.random as string)
	let used = 0
	const take = (n: number) => {
		if (used + n > random.length) throw new Error("random: none left")
		return random.slice(used, used += n)
	}
	try {
		return {
			blop: blopOut(commit(state.chains, change as never, where as never, r.roots, take, kind)),
		}
	} catch (e) {
		const code = (e as { code?: unknown }).code
		if (typeof code === "string") return { code }
		throw e
	}
}

await serve(answerCommit)
