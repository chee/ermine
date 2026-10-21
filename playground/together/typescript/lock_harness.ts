// lock_harness: transport_harness.ts's devices with a lock that makes its effects visible, on the line
// protocol (harness.ts). the "tag" lock is tag_lock.ts's. every request of transport_harness.ts is taken, and these.
// conventions: playground/together/conformance/README.md
//
// { op: "device", ..., lock? }  lock: "unlocked" (typescript/lock.ts's) | "tag" (the test lock); none:
//    the device's default, which is unlocked
// { op: "lock", device, open }  → {}  what the tag lock's open does from now: "tag" (takes the tag off,
//    refusing bytes that have none), "wait" (not yet), "refuse" (never)
// { op: "calls", device }       → { closed, opened }  what the tag lock was asked since last asked:
//    closed: [{doc?, name, parents}] in order, doc when not the default; name: the commit's label (else
//    hex: a fragment's is the multihash of its bytes); parents: labels (else hex); opened: whether open
//    was asked at all
// { op: "opens", device }       → { opens }  how often the tag lock's open was asked since last asked
// put's and fragment's closed: the tag put before the blob, as another device with the tag lock closes
//    it (not in calls)
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { unlocked } from "./lock.ts"
import { createTag, type Tag, tagged } from "./tag_lock.ts"
import { answer, finish, hooks, label } from "./transport_harness.ts"

const DOC = "ermine:0010" + "2a".repeat(16)

const tests = new Map<string, Tag>()

// made as the device is: the request's name is what the later requests call it
hooks.lock = (r) => {
	if (r.lock === "unlocked") return unlocked
	if (r.lock !== "tag") return undefined
	const t = createTag()
	tests.set(r.name, t)
	return t.lock
}
hooks.close = (_device, _doc, _name, _parents, bytes) => tagged(bytes)

const of = (name: unknown) => {
	const t = tests.get(name as string)
	if (!t) throw new Error(`no tag lock on ${name}`)
	return t
}

async function lock(r: Request): Promise<Answer> {
	switch (r.op) {
		case "lock":
			of(r.device).open = r.open
			return {}
		case "calls": {
			const t = of(r.device)
			const closed = t.closed.splice(0).map((c) => {
				// the id's UTF-8
				const doc = new TextDecoder().decode(c.doc)
				return {
					...(doc === DOC ? {} : { doc }),
					name: label(c.name),
					parents: c.parents.map(label),
				}
			})
			const opened = t.opened
			t.opened = false
			return { closed, opened }
		}
		case "opens": {
			const t = of(r.device), opens = t.opens
			t.opens = 0
			return { opens }
		}
	}
	return await answer(r)
}

if (import.meta.main) {
	// Subduction's logging (a connection closed, …) is not an answer
	console.warn = () => {}
	await serve(lock)
	await finish()
	Deno.exit(0)
}
