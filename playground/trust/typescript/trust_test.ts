// what the harness can't say: a claim whose ids are no key ids
import { assertEquals } from "@std/assert"
import * as ed25519 from "@ermine/ed25519"
import { text } from "@ermine/ids"
import { startSession } from "@ermine/sessions"
import { trusted } from "./trust.ts"

Deno.test("a session or an install that is no key id: not believed, never a throw", async () => {
	const secret = new Uint8Array(32).fill(1)
	const install = {
		id: text(Uint8Array.of(0xed, 0x01, ...await ed25519.publicKeyOf(secret)))!,
		secret,
	}
	const s = await startSession(install, ed25519)
	const message = new TextEncoder().encode("hello")
	const signature = await ed25519.sign(s.secret, message)
	const keys = { [install.id]: {}, "ermine:00100123456789abcdef0123456789abcdef": {} }
	const claim = { session: s.id, install: install.id, vouch: s.vouch }
	assertEquals(await trusted(keys, claim, message, signature, ed25519), true)
	const fresh = "ermine:00100123456789abcdef0123456789abcdef"
	assertEquals(
		await trusted(keys, { ...claim, session: fresh }, message, signature, ed25519),
		false,
	)
	assertEquals(
		await trusted(keys, { ...claim, install: fresh }, message, signature, ed25519),
		false,
	)
	assertEquals(
		await trusted(keys, { ...claim, session: "nonsense" }, message, signature, ed25519),
		false,
	)
})
