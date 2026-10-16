// text.ts: UTF-8 as the WHATWG's TextEncoder and TextDecoder have it, which JavaScriptCore alone lacks (from deno/jsc.ts).

export class TextEncoder {
	readonly encoding = "utf-8"
	encode(text = ""): Uint8Array {
		const s = String(text)
		const out = new Uint8Array(s.length * 3)
		let n = 0
		for (let i = 0; i < s.length; i++) {
			let c = s.charCodeAt(i)
			if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
				const d = s.charCodeAt(i + 1)
				if (d >= 0xdc00 && d < 0xe000) {
					c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
					i++
				}
			}
			if (c >= 0xd800 && c < 0xe000) c = 0xfffd
			if (c < 0x80) out[n++] = c
			else if (c < 0x800) {
				out[n++] = 0xc0 | c >> 6
				out[n++] = 0x80 | c & 63
			} else if (c < 0x10000) {
				out[n++] = 0xe0 | c >> 12
				out[n++] = 0x80 | c >> 6 & 63
				out[n++] = 0x80 | c & 63
			} else {
				out[n++] = 0xf0 | c >> 18
				out[n++] = 0x80 | c >> 12 & 63
				out[n++] = 0x80 | c >> 6 & 63
				out[n++] = 0x80 | c & 63
			}
		}
		return out.slice(0, n)
	}
}

/** decodes UTF-8; with {stream: true}, a character cut at the end waits for the next call's bytes */
export class TextDecoder {
	readonly encoding = "utf-8"
	#held: number[] = []
	decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string {
		const bytes = input === undefined
			? new Uint8Array(0)
			: input instanceof ArrayBuffer
			? new Uint8Array(input)
			: new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
		const b = this.#held.length ? Uint8Array.from([...this.#held, ...bytes]) : bytes
		this.#held = []
		const stream = !!options?.stream
		let out = ""
		const units: number[] = []
		const put = (c: number) => {
			if (c >= 0x10000) {
				units.push(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff))
			} else units.push(c)
			if (units.length > 8192) out += String.fromCharCode(...units.splice(0))
		}
		let i = 0
		while (i < b.length) {
			const x = b[i]
			if (x < 0x80) {
				put(x)
				i++
				continue
			}
			// the sequence's length, and the bounds its second byte has (WHATWG's)
			let need = 0, c = 0, lo = 0x80, hi = 0xbf
			if (x >= 0xc2 && x <= 0xdf) need = 1, c = x & 0x1f
			else if (x >= 0xe0 && x <= 0xef) {
				need = 2, c = x & 0xf, lo = x === 0xe0 ? 0xa0 : 0x80, hi = x === 0xed ? 0x9f : 0xbf
			} else if (x >= 0xf0 && x <= 0xf4) {
				need = 3, c = x & 0x7, lo = x === 0xf0 ? 0x90 : 0x80, hi = x === 0xf4 ? 0x8f : 0xbf
			} else {
				put(0xfffd)
				i++
				continue
			}
			let k = 1
			for (; k <= need && i + k < b.length; k++) {
				const y = b[i + k]
				if (y < (k === 1 ? lo : 0x80) || y > (k === 1 ? hi : 0xbf)) break
				c = c << 6 | y & 63
			}
			if (k > need) {
				put(c)
				i += k
			} else if (i + k >= b.length && stream) {
				this.#held = [...b.subarray(i)]
				break
			} else {
				put(0xfffd)
				i += k
			}
		}
		return out + String.fromCharCode(...units)
	}
}
