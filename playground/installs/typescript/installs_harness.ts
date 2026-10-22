// installs (installs.ts) on the line protocol: one JSON request per line in, one answer per line
// out, in order. one store in memory for the run; the key is Ed25519 (installs' ed25519). bytes
// are lowercase hex
//
// { op: "put", name, hex }      -> {}   the store's name set to those bytes, as a host left it
// { op: "open", root? }         -> { id, root, kinds, wrote, same }
//    kinds: the id's and the root's (ids' kind); wrote: the names this open wrote, in order;
//    same: the id and root are the first open's
// { op: "stored" }              -> { sizes }   each stored name's length in bytes
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { kind } from "@ermine/ids"
import { ed25519, openInstall, type Store } from "./installs.ts"

function unhex(s: unknown): Uint8Array {
	if (typeof s !== "string" || !/^([0-9a-f]{2})*$/.test(s)) {
		throw new Error(`not hex: ${s}`)
	}
	return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
}

const stored = new Map<string, Uint8Array>()
let wrote: string[] = []
const store: Store = {
	read: (name) => stored.get(name),
	write: (name, bytes) => {
		stored.set(name, bytes)
		wrote.push(name)
	},
}
let first: { id: string; root: string } | undefined

export async function answer(r: Request): Promise<Record<string, unknown>> {
	switch (r.op) {
		case "put":
			stored.set(String(r.name), unhex(r.hex))
			return {}
		case "open": {
			wrote = []
			const install = await openInstall(
				store,
				ed25519,
				r.root === undefined ? {} : { root: r.root },
			)
			first ??= { id: install.id, root: install.root }
			return {
				id: install.id,
				root: install.root,
				kinds: { id: kind(install.id), root: kind(install.root) },
				wrote,
				same: install.id === first.id && install.root === first.root,
			}
		}
		case "stored":
			return {
				sizes: Object.fromEntries(
					[...stored].map(([k, v]) => [k, v.length]),
				),
			}
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
