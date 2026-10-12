// a new document id for a demo that syncs through a Subduction server with no Keyhive grant for it,
// such as wss://galaxy.observer: such a server stores a sedimentree only when its id's last 16 bytes
// are zero. So: ermine:// and 16 random bytes, then 16 zero bytes. Temporary, until Keyhive gives
// the server grants; it does not bind a lock (ID.tex), which is harmless while every lock is unlocked.
// Give it as the id when making a node: nothing in sync changes.
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

export function fresh(): string {
	return "ermine://" + hex(crypto.getRandomValues(new Uint8Array(16))) + "0".repeat(32)
}
