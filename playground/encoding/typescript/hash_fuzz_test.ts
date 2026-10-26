// the hash fuzz: values of every kind (ermine/encoding's fuzz values), each and a copy with its
// keys in another order named by BLAKE3 of the value's encoding. a few dozen seeds (SEEDS for more)
import { assertEquals } from "@std/assert"
import { blake3 } from "@ermine/core/blake3"
import { encode } from "@ermine/encoding/cbor"
import { hash } from "./hash.ts"
import {
	hex,
	rand,
	show,
	shuffled,
	value,
} from "../../../ermine/encoding/typescript/fuzz_values.ts"

const SEEDS = Number(Deno.env.get("SEEDS") ?? 40)

Deno.test(`hash fuzz: ${SEEDS} seeds, one hash, BLAKE3 of the encoding, whatever the key order`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		for (let n = 0; n < 20; n++) {
			const v = value(pick)
			const b = encode(v)
			const at = `seed ${seed}.${n}: ${show(v)}`
			assertEquals(hex(hash(v)), hex(blake3(b)), `${at}: hash`)
			assertEquals(hex(hash(shuffled(pick, v))), hex(blake3(b)), `${at}: keys in another order`)
		}
	}
})
