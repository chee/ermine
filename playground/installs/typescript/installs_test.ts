// what the harness can't say: a key that fails leaves the store as it was
import { assertEquals, assertRejects } from "@std/assert"
import { openInstall } from "./installs.ts"

const store = () => {
	const m = new Map<string, Uint8Array>()
	return {
		m,
		read: (n: string) => m.get(n),
		write: (n: string, b: Uint8Array) => void m.set(n, b),
	}
}

Deno.test("a public key that can't be worked out, or isn't 32 bytes: an error, nothing written", async () => {
	const s = store()
	await assertRejects(() => openInstall(s, () => Promise.reject(new Error("no key"))))
	await assertRejects(() => openInstall(s, () => new Uint8Array(31)))
	assertEquals([...s.m.keys()], [])
})
