import { assert } from "@std/assert"
import { createSigner, verify } from "./sign.ts"

const message = new TextEncoder().encode("anything at all")

Deno.test("verify refuses the identity key, whose signature of R the identity and S 0 webcrypto takes for every message", async () => {
	const identity = "01" + "00".repeat(31)
	const sig = new Uint8Array(64)
	sig[0] = 1
	assert(!(await verify(identity, message, sig)))
})

Deno.test("verify takes a device's own signature and refuses it on another message", async () => {
	const signer = await createSigner(new Uint8Array(32).fill(7))
	const sig = await signer.sign(message)
	assert(await verify(signer.device, message, sig))
	assert(!(await verify(signer.device, new TextEncoder().encode("something else"), sig)))
})
