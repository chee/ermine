// RFC 8032's first test vector (7.1, TEST 1), signed and checked through WebCrypto; what strict
// takes and refuses, beside it
import { assert, assertEquals } from "@std/assert"
import { publicKeyOf, sign, strict, verify } from "./ed25519.ts"

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const SECRET = unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
const KEY = unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
const SIGNATURE = unhex(
	"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
)
const EMPTY = new Uint8Array()

Deno.test("RFC 8032 test 1: the secret's key, its signature of the empty message, and the check", async () => {
	assertEquals(await publicKeyOf(SECRET), KEY)
	assertEquals(await sign(SECRET, EMPTY), SIGNATURE)
	assert(await verify(KEY, EMPTY, SIGNATURE))
})

Deno.test("verify: false, never a throw, for another message, a changed signature, a short key, a key of small order", async () => {
	assert(!(await verify(KEY, Uint8Array.of(1), SIGNATURE)))
	const changed = SIGNATURE.slice()
	changed[0] ^= 1
	assert(!(await verify(KEY, EMPTY, changed)))
	assert(!(await verify(KEY.subarray(1), EMPTY, SIGNATURE)))
	const identity = unhex("0100000000000000000000000000000000000000000000000000000000000000")
	assert(!strict(SIGNATURE, identity))
	assert(!(await verify(identity, EMPTY, SIGNATURE)))
})
