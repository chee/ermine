// pullynode harness: places' harness (filesystem/places/typescript/places_harness.ts: its world,
// its computes by name, its programs, its requests) and the providers (pullynode.ts), on the line
// protocol. a reader is a watch whose program reads the node; it stops reading when its program
// stops (an if on a switch) or it is disposed. a status is read with places' read: { op: "read",
// part: "attributes", id, path: ["ermine.provider.status"] }.
// { op: "providers" }                        → {}   the providers, made once
// { op: "provide", name, id, info?, first?, once? } → {} | { error: "provided" }
//    a provider named name, of id: its start says so (said), keeps the write it is given (the
//    latest, kept after its stop too) and, given first, writes first at once (path []); its stop
//    says so. once: { value } (once gives value) | { throw: message }; none: no once. info: its
//    writes' scope (none: the providers' own, actor the id)
// { op: "unprovide", name }                  → {}   provide's stop
// { op: "put", name, value }                 → {}   value written (path []) through its write;
//    never started: { error: "never started" }
// { op: "said", name }                       → { said }   since last asked, in order:
//    "start" (a check's) | { start: name } (woken by a run of the compute named; null: unnamed) |
//    "stop"
// { op: "check", id, as }                    → {}   a check begun, its answer kept as as
// { op: "checked", as }                      → {} (not yet) | { value } | { error: message }
//    asked after any promise ready has settled
// { op: "reading", id }                      → { reading }
// { op: "actor", part, id }                  → { actor }   the entry's change's; none there: null
// { op: "stopAll" }                          → {}   the providers' stop
// program e, besides places' harness's:
//   {"keys":[part,id,path?]}    the names of the value there (places' readKeys); tracked
import type { Provider, Write } from "./pullynode.ts"
import { createProviders, type Providers } from "./pullynode.ts"
import {
	answered,
	names,
	places,
	s,
	table,
} from "../../../filesystem/places/typescript/world_harness.ts"
import {
	answer as placesAnswer,
	forms,
} from "../../../filesystem/places/typescript/places_harness.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import type { Key } from "@ermine/table"

type Json = unknown

let providers: Providers | undefined
type Hand = { said: Json[]; write?: Write; stop?: () => void }
const hands = new Map<string, Hand>()
const checks = new Map<string, Json>()

forms.push((m) => {
	if (!("keys" in m)) return
	const [part, id, path] = m.keys
	return { value: places.readKeys(part, id, path) }
})

function hand(name: string): Hand {
	const h = hands.get(name)
	if (h === undefined) throw new Error(`no provider ${name}`)
	return h
}

function provider(h: Hand, r: Request): Provider {
	const p: Provider = {
		start(write, woke) {
			h.said.push(woke ? { start: names.get(woke.computer) ?? null } : "start")
			h.write = write
			if ("first" in r) write([{ path: [], value: r.first }])
			return () => void h.said.push("stop")
		},
	}
	if (r.once !== undefined) {
		p.once = "throw" in r.once
			? () => {
				throw new Error(r.once.throw)
			}
			: () => r.once.value
	}
	return p
}

function own(r: Request): Json | undefined {
	switch (r.op) {
		case "providers":
			providers ??= createProviders({ scheduler: s, places, table })
			return {}
		case "provide": {
			if (providers === undefined) throw new Error("no providers")
			const h: Hand = { said: [] }
			try {
				h.stop = providers.provide(r.id, provider(h, r), r.info)
			} catch {
				return { error: "provided" }
			}
			hands.set(r.name, h)
			return {}
		}
		case "unprovide":
			hand(r.name).stop!()
			return {}
		case "put": {
			const h = hand(r.name)
			if (h.write === undefined) return { error: "never started" }
			h.write([{ path: [], value: r.value }])
			return {}
		}
		case "said": {
			const h = hand(r.name)
			const said = h.said
			h.said = []
			return { said }
		}
		case "check":
			if (providers === undefined) throw new Error("no providers")
			checks.set(r.as, undefined)
			providers.check(r.id).then(
				(value) => checks.set(r.as, { value: value ?? null }),
				(e) => checks.set(r.as, { error: e instanceof Error ? e.message : String(e) }),
			)
			return {}
		case "reading":
			return { reading: providers?.reading(r.id) ?? false }
		case "actor":
			return { actor: table.get(r.part as Key, r.id)?.change.actor ?? null }
		case "stopAll":
			providers?.stop()
			return {}
	}
	return placesAnswer(r)
}

async function answer(r: Request) {
	if (r.op !== "checked") return answered(own, r)
	// what is ready settles first
	await new Promise((ok) => setTimeout(ok, 0))
	return (checks.get(r.as) ?? {}) as Record<string, unknown>
}

if (import.meta.main) await serve(answer)
