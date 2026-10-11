// The reference commit.ts on the line protocol (../apply/session.ts): the apply ops, and commit.
import { commit } from "../../sync/ts/commit.ts"
import { fromJson } from "../pack/form.ts"
import { answer, blopOut, type Request, serve, state, toArray, unhex } from "../apply/session.ts"

type At = { version?: number; span?: [number, number]; pop?: number | [number, number] }

function answerCommit(r: Request): unknown {
	if (r.op !== "commit") return answer(r)
	const c = fromJson(r.change) as Record<string, unknown>
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
		return { blop: blopOut(commit(state.chains, change as never, where as never, r.roots, take)) }
	} catch (e) {
		const code = (e as { code?: unknown }).code
		if (typeof code === "string") return { code }
		throw e
	}
}

await serve(answerCommit)
