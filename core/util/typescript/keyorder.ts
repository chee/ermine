// how a map's keys are ordered: by length in UTF-8 bytes, shorter first, then bytewise. the order
// of their CBOR encodings, which is canonical CBOR's (encoding's cbor.ts), without the encoding.
// a lone surrogate is its own three bytes (WTF-8, as the C has it), never U+FFFD: distinct keys
// never compare equal
const utf8 = /* @__PURE__ */ new TextEncoder()
const bytes = /* @__PURE__ */ new Map<string, Uint8Array>()
function wtf8(k: string): Uint8Array {
	const parts: Uint8Array[] = []
	let from = 0
	for (let i = 0; i < k.length; i++) {
		const c = k.charCodeAt(i)
		if (c < 0xd800 || c > 0xdfff) continue
		const next = k.charCodeAt(i + 1)
		if (c < 0xdc00 && next >= 0xdc00 && next <= 0xdfff) {
			i++
			continue
		}
		parts.push(
			utf8.encode(k.slice(from, i)),
			Uint8Array.of(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63),
		)
		from = i + 1
	}
	parts.push(utf8.encode(k.slice(from)))
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) out.set(p, at), at += p.length
	return out
}

function of(k: string): Uint8Array {
	let b = bytes.get(k)
	if (b === undefined) {
		b = k.isWellFormed() ? utf8.encode(k) : wtf8(k)
		if (bytes.size > 4096) bytes.clear()
		bytes.set(k, b)
	}
	return b
}

export function keyorder(a: string, b: string): number {
	const x = of(a), y = of(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}
