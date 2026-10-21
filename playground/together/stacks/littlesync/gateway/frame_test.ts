// frames (frame.ts) against known vectors and the C side's own bytes
import { assert, assertEquals } from "@std/assert"
import { cobs, crc32, frame, uncobs, unframe, Unframer } from "./frame.ts"
import { decode, encode } from "./wire.ts"

const b = (...xs: number[]) => Uint8Array.from(xs)

Deno.test("frame: CRC-32 is zlib's", () => {
	assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926)
	assertEquals(crc32(new Uint8Array(0)), 0)
})

Deno.test("frame: COBS vectors (Cheshire and Baker's), both ways", () => {
	const cases: [Uint8Array, Uint8Array][] = [
		[b(0x00), b(0x01, 0x01)],
		[b(0x00, 0x00), b(0x01, 0x01, 0x01)],
		[b(0x11, 0x22, 0x00, 0x33), b(0x03, 0x11, 0x22, 0x02, 0x33)],
		[b(0x11, 0x22, 0x33, 0x44), b(0x05, 0x11, 0x22, 0x33, 0x44)],
		[b(0x11, 0x00, 0x00, 0x00), b(0x02, 0x11, 0x01, 0x01, 0x01)],
	]
	for (const [plain, coded] of cases) {
		assertEquals(cobs(plain), coded)
		assertEquals(uncobs(coded), plain)
	}
	// 254 non-zero bytes: one full block
	const long = Uint8Array.from({ length: 254 }, (_, i) => i + 1)
	const c = cobs(long)
	assertEquals(c[0], 0xff)
	assertEquals(uncobs(c), long)
	assert(!c.includes(0))
	assertEquals(uncobs(b(0x05, 0x11)), undefined)
	assertEquals(uncobs(b(0x00)), undefined)
})

Deno.test("frame: round trip, random sizes, no zero inside", () => {
	for (let n = 0; n < 1200; n += 37) {
		const m = crypto.getRandomValues(new Uint8Array(n))
		const f = frame(m)
		assertEquals(f[0], 0)
		assertEquals(f[f.length - 1], 0)
		assert(!f.subarray(1, -1).includes(0))
		assertEquals(unframe(f.subarray(1, -1)), n === 0 ? undefined : m)
	}
})

Deno.test("frame: an unframer finds frames among text and half frames; junk counted", () => {
	// nodes: fresh ermine ids (ermine:0010, then 16 bytes in hex)
	const m1 = encode({
		t: "ack",
		node: "ermine:0010" + "01".repeat(16),
		names: [],
	})
	const m2 = encode({
		t: "want",
		node: "ermine:0010" + "02".repeat(16),
		names: [],
	})
	const f1 = frame(m1), f2 = frame(m2)
	const bad = frame(m2).slice()
	bad[5] ^= 0x40
	const text = new TextEncoder().encode("I (123) boot: console text\n")
	const stream = new Uint8Array([...text, ...f1, ...bad, ...text, ...f2])
	const u = new Unframer()
	const got: Uint8Array[] = []
	// one byte at a time: frames cut anywhere
	for (const x of stream) got.push(...u.feed(b(x)))
	assertEquals(got.length, 2)
	assertEquals(decode(got[0]), decode(m1))
	assertEquals(decode(got[1]), decode(m2))
	// the text before the first zero, the bad frame, the text between
	assertEquals(u.junk, 3)
})

// the frame littlesync-pigs sends first, from a run of the C side (its key aside): a hello
Deno.test("frame: a hello the C side made decodes", () => {
	const c = Uint8Array.from(
		("004a4ca361746568656c6c6f636b65795822ed01ebfd917303a12f6ab130c7ca827d75c5c65f3667dac36bdaeb9" +
			"02af460d9335765737461636b6c6c6974746c6573796e632f307e2348f200").match(/../g)!
			.map((x) => parseInt(x, 16)),
	)
	const u = new Unframer()
	const [m] = u.feed(c)
	const hello = decode(m)!
	assertEquals(hello.t, "hello")
	if (hello.t !== "hello") return
	assertEquals(hello.stack, "littlesync/0")
	assertEquals([...hello.key.subarray(0, 2)], [0xed, 0x01])
	// and the TS side makes the same bytes for the same message
	assertEquals(frame(encode(hello)), c)
})
