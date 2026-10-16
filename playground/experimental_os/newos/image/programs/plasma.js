// /programs/plasma: a demo of video memory (/dev/vram): a window whose
// pixels are a plane the program draws into itself, every frame, and the
// compositor shows without them going through the graph. Each frame is the
// old demoscene plasma, four waves summed, in lemon and cherry, about 30
// a second; drawn says all of it changed. The world menu starts it.
import { make, val } from "ermine:kit"
import { after, here, plane } from "ermine:os"

export default (given) => {
	const { api, self, onCleanup } = given
	// this process's own node: the window's owner, which the window manager unplaces to close it
	const me = here(self)
	const u = val(api, ["/", "dev", "display", "mode"])?.unit ?? 1
	const w = 200, h = 150, W = w * u, H = h * u
	const LAYERS = ["/", "dev", "display", "layers"], LAYER = `plasma-${self}`
	const p = plane(api, `plasma-${self}`, W, H)
	// a sine of 256 steps a turn, and 256 colours: cream to lemon to cherry and back
	const SIN = new Int32Array(256).map((_, i) => Math.round(Math.sin((i / 256) * 2 * Math.PI) * 63))
	const mix = (a, b, t) =>
		[16, 8, 0].reduce(
			(c, s) => c | Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s,
			0,
		)
	const STOPS = [0xfdf8ea, 0xfff07a, 0xd2214a, 0x2a2228, 0xfdf8ea]
	const PAL = new Uint32Array(256).map((_, i) => {
		const at = (i / 256) * (STOPS.length - 1), k = Math.floor(at)
		return mix(STOPS[k], STOPS[k + 1], at - k)
	})
	const row = new Uint32Array(W)
	let t = 0, stopped = false, cancel = null, placed = false
	const draw = (bits, stride) => {
		for (let y = 0; y < h; y++) {
			const a = SIN[(y * 3 + t) & 255] + SIN[(y * 2 - t * 2) & 255]
			for (let x = 0; x < w; x++) {
				const c =
					PAL[(a + SIN[(x * 2 + t * 3) & 255] + SIN[((x + y) * 2 + t) & 255] + 256) & 255]
				for (let i = 0; i < u; i++) row[x * u + i] = c
			}
			for (let j = 0; j < u; j++) bits.set(row, (y * u + j) * stride)
		}
		t++
	}
	// each frame a handler a timer calls, as its own part: the setup's api stops when it returns.
	// Once the driver has made the plane, it is drawn, the window placed the first time, and said drawn
	const frame = (given) => {
		const { api, call } = given
		cancel = null
		if (stopped) return
		const bits = p.bits(api)
		if (bits) {
			draw(bits, p.stride(api))
			if (!placed) {
				make(api, LAYERS, LAYER, {
					x: 160 * u,
					y: 120 * u,
					w: W,
					h: H,
					title: "plasma",
					owner: me,
					plane: p.value(api),
				}, { ephemeral: true })
				placed = true
			}
			p.drawn(api, call, [...LAYERS, LAYER])
		}
		cancel = after(given, 33, frame)
	}
	cancel = after(given, 0, frame)
	onCleanup(({ api }) => {
		stopped = true
		if (cancel) cancel(api)
	})
}
