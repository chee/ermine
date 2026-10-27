// how a map's keys are ordered: by length in UTF-8 bytes, shorter first, then bytewise. the order
// of their CBOR encodings, which is canonical CBOR's (encoding's cbor.ts), without the encoding
const utf8 = /* @__PURE__ */ new TextEncoder()
const bytes = /* @__PURE__ */ new Map<string, Uint8Array>()
function of(k: string): Uint8Array {
	let b = bytes.get(k)
	if (b === undefined) {
		b = utf8.encode(k)
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
