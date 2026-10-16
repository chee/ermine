// draw.ts: "ermine:draw", the blitter (blitter.ts) made from
// /hw/font, the font ROM; and fonts from the font driver, whose glyph pages
// are read from /dev/font/<role>/pages/<n> as they are needed, through the
// part running (the runner says which), asking /dev/font/on/want for one not
// there.

import { Blitter, type Font, type FontPage } from "./blitter.ts"
import { val } from "./kit.ts"
import type { Api } from "./kit.ts"

type Running = () => { api: Api; call?: (address: string[], args?: unknown) => unknown } | null

export function draw(running: Running) {
	let blit: Blitter | null = null
	/** the blitter, the font ROM's: made once */
	const blitter = (api: Api): Blitter => {
		if (blit) return blit
		const rom = val<{ w: number; h: number; chars: string; alpha: ArrayBuffer | Uint8Array }>(
			api,
			["/", "hw", "font"],
		)
		const alpha = rom.alpha instanceof Uint8Array ? rom.alpha : new Uint8Array(rom.alpha)
		blit = new Blitter({ w: rom.w, h: rom.h, chars: rom.chars, alpha })
		return blit
	}

	class RemoteFont implements Font {
		readonly h: number
		readonly ascent: number
		readonly role: string
		readonly #pages = new Map<number, FontPage>()
		#missed: { part: unknown; pages: Set<number> } = { part: null, pages: new Set() }
		readonly #asked = new Set<number>()
		constructor(readonly value: Record<string, unknown>) {
			this.h = value.h as number
			this.ascent = value.ascent as number
			this.role = value.font as string
		}
		page(n: number): FontPage | undefined {
			const had = this.#pages.get(n)
			if (had) return had
			const part = running()
			if (!part) return undefined
			if (this.#missed.part !== part) this.#missed = { part, pages: new Set() }
			if (this.#missed.pages.has(n)) return undefined
			const p = val<{ w: number; alpha: ArrayBuffer | Uint8Array; info: ArrayLike<number> }>(
				part.api,
				["/", "dev", "font", this.role, "pages", String(n)],
			)
			if (!p) {
				this.#missed.pages.add(n)
				if (this.#asked.has(n) || !part.call) return undefined
				this.#asked.add(n)
				try {
					part.call(["/", "dev", "font", "on", "want"], [this.role, n])
				} catch {
					// a compute cannot call: the next setup, effect or handler asks
				}
				return undefined
			}
			const alpha = p.alpha instanceof Uint8Array ? p.alpha : new Uint8Array(p.alpha)
			const page = { w: p.w, alpha, info: p.info }
			this.#pages.set(n, page)
			return page
		}
		toString() {
			return `${this.value.family} ${this.value.size}px`
		}
	}

	const fonts = new Map<string, RemoteFont>()
	/** a font from what the font driver wrote ({font, h, ascent, …}), one per role */
	const font = (value: Record<string, unknown>): Font => {
		const key = `${value.font} ${value.h} ${value.ascent}`
		let f = fonts.get(key)
		if (!f) fonts.set(key, f = new RemoteFont(value))
		return f
	}

	return { blitter, font, Blitter }
}
