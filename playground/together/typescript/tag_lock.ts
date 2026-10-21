// the harnesses' test lock, no cryptography: it closes by putting a byte, 0xff, before the bytes (no
// seal, commit or fragment starts with it, so a device with no lock refuses what it is sent) and opens
// by taking it off, refusing bytes that have none; or, as its mode says from the request "lock", it
// waits or refuses. it remembers what it was asked to close, and whether and how often it was asked
// to open.
// as c/tag_lock.h. for lock_harness.ts and sync_harness.ts
import type { Lock } from "./lock.ts"

export const TAG = 0xff

export type Tag = {
	lock: Lock
	// what its open does: takes the tag off (refusing bytes with none), waits, or refuses
	open: "tag" | "wait" | "refuse"
	// what it was asked to close since last cleared
	closed: { doc: Uint8Array; name: Uint8Array; parents: Uint8Array[] }[]
	opened: boolean
	// how often open was asked since last cleared
	opens: number
}

export const tagged = (bytes: Uint8Array) => {
	const out = new Uint8Array(bytes.length + 1)
	out[0] = TAG
	out.set(bytes, 1)
	return out
}

export function createTag(): Tag {
	const t: Tag = {
		open: "tag",
		closed: [],
		opened: false,
		opens: 0,
		lock: {
			close(doc, name, parents, bytes) {
				t.closed.push({ doc, name, parents })
				return tagged(bytes)
			},
			open(_doc, bytes) {
				t.opened = true
				t.opens++
				if (t.open === "wait") return { wait: true }
				if (t.open === "refuse") return { refused: "the test lock refuses" }
				if (bytes[0] !== TAG) return { refused: "no tag on the bytes" }
				return bytes.subarray(1)
			},
		},
	}
	return t
}
