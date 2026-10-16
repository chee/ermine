// cursor: draws the cursor. /dev/pointer/cursor says what is wanted: null,
// the arrow (/etc/cursors/arrow); an address, the picture there; or a
// picture itself. A picture is pixel art, as My Computer shows and edits it:
// {kind: "picture", colors: {letter: 0xRRGGBB}, rows: [...], hot: [x, y]},
// a letter not in colors clear, hot the pixel that points. This draws it at
// the screen's unit (pixels a point) into /dev/pointer/plane, {w, h, hot,
// pixels}, which the pointer driver gives the metal's cursor plane; the metal
// moves the plane with the pointer itself, so no turn of this delays it.
// Replace this program to draw the cursor another way; edit the pictures to
// change how it looks.
import { effect, idAt, val, whole } from "ermine:kit"

export default (given) => {
	const WANT = ["/", "dev", "pointer", "cursor"]
	const PLANE = ["/", "dev", "pointer", "plane"]
	const ARROW = ["/", "etc", "cursors", "arrow"]
	const isPicture = (v) =>
		v?.kind === "picture" && Array.isArray(v.rows) && v.rows.every((r) => typeof r === "string")

	effect(given, "plane", ({ api }) => {
		const want = val(api, WANT) ?? null
		const picture = isPicture(want) ? want : Array.isArray(want) ? val(api, want) : null
		return {
			picture: isPicture(picture) ? picture : val(api, ARROW) ?? null,
			unit: Math.max(1, Math.round(val(api, ["/", "dev", "display", "mode"])?.unit ?? 1)),
		}
	}, ({ value: { picture, unit }, api }) => {
		if (!isPicture(picture)) return
		const rows = picture.rows.slice(0, 64)
		const cols = Math.min(64, Math.max(0, ...rows.map((r) => r.length)))
		if (!rows.length || !cols) return
		const w = cols * unit, h = rows.length * unit
		const pixels = new Uint32Array(w * h)
		for (let y = 0; y < h; y++) {
			const row = rows[Math.floor(y / unit)]
			for (let x = 0; x < w; x++) {
				const c = picture.colors?.[row[Math.floor(x / unit)] ?? " "]
				if (typeof c === "number") pixels[y * w + x] = (0xff000000 | c) >>> 0
			}
		}
		const [hx, hy] = Array.isArray(picture.hot) ? picture.hot : [0, 0]
		const value = { w, h, hot: [hx * unit, hy * unit], pixels }
		if (idAt(api, PLANE)) api.write(PLANE, whole(value))
	})
}
