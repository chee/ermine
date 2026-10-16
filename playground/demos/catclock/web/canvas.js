// canvas.js: a loader. Runs a wasm that draws into a buffer of its own
// (cc_init, cc_frame: catclock.c) on a canvas: each animation frame, the
// time in, the buffer out through ImageData (CC_RGBA, its bytes as
// ImageData's). The canvas is a whole number of the cat's pixels, as many
// as its box has room for, so they stay square. Gives back stop.
//
//   import run from "./canvas.js"
//   const stop = await run({ wasm: bytes, canvas })

const CAT_W = 150, CAT_H = 300, CC_RGBA = 0

export default async function run({ wasm, canvas }) {
	const { instance } = await WebAssembly.instantiate(wasm)
	const { memory, cc_init, cc_frame } = instance.exports
	const ctx = canvas.getContext("2d")
	const box = canvas.parentElement
	let image = null, frame = 0

	const size = () => {
		const dpr = devicePixelRatio || 1
		const k = Math.max(
			1,
			Math.floor(Math.min(box.clientWidth / CAT_W, box.clientHeight / CAT_H) * dpr),
		)
		if (image && canvas.width === CAT_W * k) return
		canvas.width = CAT_W * k
		canvas.height = CAT_H * k
		canvas.style.width = `${(CAT_W * k) / dpr}px`
		canvas.style.height = `${(CAT_H * k) / dpr}px`
		const at = cc_init(canvas.width, canvas.height, CC_RGBA)
		image = new ImageData(
			new Uint8ClampedArray(memory.buffer, at, canvas.width * canvas.height * 4),
			canvas.width,
			canvas.height,
		)
	}
	const tick = () => {
		const now = new Date()
		cc_frame(now.getTime(), -now.getTimezoneOffset())
		ctx.putImageData(image, 0, 0)
		frame = requestAnimationFrame(tick)
	}

	size()
	const watch = new ResizeObserver(size)
	watch.observe(box)
	tick()
	return () => {
		cancelAnimationFrame(frame)
		watch.disconnect()
	}
}
