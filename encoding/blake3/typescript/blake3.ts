// blake3, one-shot: a tiny wasm build and the noble js one, chosen with use()
import { blake3 as noble } from "npm:@noble/hashes@1.8.0/blake3"
import { bytes } from "./wasm.ts"

type Exports = {
	memory: WebAssembly.Memory
	room(n: number): number
	hash(n: number): number
}

let lib: Exports | undefined
let which: "wasm" | "js" = "wasm"

export function js(bytes: Uint8Array): Uint8Array {
	return noble(bytes)
}

// instantiated synchronously on first use; throws when there is no wasm to be had
function load(): Exports {
	return lib ??= new WebAssembly.Instance(new WebAssembly.Module(bytes))
		.exports as unknown as Exports
}

export function wasm(input: Uint8Array): Uint8Array {
	const lib = load()
	const at = lib.room(input.length)
	// memory may have grown, so look it up after room
	new Uint8Array(lib.memory.buffer, at, input.length).set(input)
	const out = lib.hash(input.length)
	return new Uint8Array(lib.memory.buffer.slice(out, out + 32))
}

export function use(choice: "wasm" | "js"): void {
	which = choice
}

// the js one is used only when wasm is unavailable; a failure of the hash itself is not hidden
export function blake3(bytes: Uint8Array): Uint8Array {
	if (which === "wasm") {
		try {
			load()
		} catch {
			which = "js"
		}
	}
	return which === "wasm" ? wasm(bytes) : js(bytes)
}
