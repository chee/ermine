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
//
// Peers' pointers too: each peer whose live state stands at a shared document
// (/dev/sync/presence/<hex>/<key>, card/drv_sync.c) is drawn where its pointer
// is, a dot and its name, in one layer over everything, "cursors", with no
// owner (so nothing is clicked through it); the layer goes when no peer stands.
import { drop, effect, idAt, make, val, whole } from "ermine:kit"

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

	const PRESENCE = ["/", "dev", "sync", "presence"]
	const LAYERS = ["/", "dev", "display", "layers"]
	const CURSORS = [...LAYERS, "cursors"]
	effect(given, "peers", ({ api }) => {
		// one a peer, by key, from the first document it stands at
		const peers = new Map()
		for (const hex of api.children(PRESENCE)) {
			for (const key of api.children([...PRESENCE, hex])) {
				const v = val(api, [...PRESENCE, hex, key])
				const p = v?.pointer
				if (peers.has(key) || typeof p?.x !== "number" || typeof p?.y !== "number") continue
				peers.set(key, { x: p.x, y: p.y, name: String(v.presence?.name ?? key.slice(0, 8)) })
			}
		}
		const mode = val(api, ["/", "dev", "display", "mode"]) ?? {}
		const theme = val(api, ["/", "etc", "theme"]) ?? {}
		return {
			peers: [...peers.values()],
			w: mode.w ?? 0,
			h: mode.h ?? 0,
			unit: Math.max(1, Math.round(mode.unit ?? 1)),
			ink: theme.cherry ?? 0xd2244a,
			paper: theme.paper ?? 0xfdf8ea,
		}
	}, ({ value: { peers, w, h, unit: u, ink, paper }, api }) => {
		if (!peers.length || !w || !h) {
			if (idAt(api, CURSORS)) drop(api, LAYERS, "cursors")
			return
		}
		const draw = []
		for (const p of peers) {
			draw.push({ op: "fillellipse", x: p.x, y: p.y, rx: 4 * u, ry: 4 * u, color: ink })
			draw.push({ op: "ellipse", x: p.x, y: p.y, rx: 4 * u, ry: 4 * u, color: paper })
			draw.push({
				op: "text",
				x: p.x + 7 * u,
				y: p.y + 2 * u,
				text: p.name,
				color: ink,
				bg: paper,
			})
		}
		const layer = { x: 0, y: 0, w, h, z: 900000, over: true, draw }
		if (idAt(api, CURSORS)) api.write(CURSORS, whole(layer))
		else make(api, LAYERS, "cursors", layer, { ephemeral: true })
	})
}
