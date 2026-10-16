// (a copy of playground/demos/_tools/shot.ts for port 8051) deno run -A shot.ts <path> [out.png] [width] [height] [wait ms] [js to run first]
// a screenshot and the page's console, through one long-lived headless chrome (DevTools protocol).
// chrome is started on port 9333 if it is not up, and left running for the next shot
const [
	demo = "",
	out = `/tmp/ermine-slay-${demo || "index"}.png`,
	w = "1400",
	h = "900",
	wait = "2500",
	js = "",
] = Deno.args
const port = 9333
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

async function version() {
	try {
		return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
	} catch {
		return undefined
	}
}
if (!(await version())) {
	new Deno.Command(chrome, {
		args: [
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
			`--remote-debugging-port=${port}`,
			"--user-data-dir=/tmp/chrome-shots",
			"about:blank",
		],
		stdout: "null",
		stderr: "null",
	}).spawn().unref()
	for (let i = 0; i < 50 && !(await version()); i++) await new Promise((r) => setTimeout(r, 200))
}
const target =
	await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let n = 0
const waiting = new Map<number, (v: any) => void>()
const logs: string[] = []
ws.onmessage = (e) => {
	const m = JSON.parse(e.data)
	if (m.id && waiting.has(m.id)) return waiting.get(m.id)!(m.result ?? m.error)
	if (m.method === "Runtime.consoleAPICalled") {
		logs.push(
			`console.${m.params.type}: ${
				m.params.args.map((a: any) => a.value ?? a.description).join(" ")
			}`,
		)
	}
	if (m.method === "Runtime.exceptionThrown") {
		const d = m.params.exceptionDetails
		logs.push(`UNCAUGHT: ${d.exception?.description ?? d.text}`)
	}
}
const send = (method: string, params = {}) =>
	new Promise<any>((r) => {
		const id = ++n
		waiting.set(id, r)
		ws.send(JSON.stringify({ id, method, params }))
	})
await send("Runtime.enable")
await send("Page.enable")
await send("Emulation.setDeviceMetricsOverride", {
	width: +w,
	height: +h,
	deviceScaleFactor: 1,
	mobile: false,
})
// "life" → /life/; "order/?case=x" or "order/#y" as given
const path = !demo || /[/?#]/.test(demo) ? demo : `${demo}/`
await send("Page.bringToFront") // a background tab stops requestAnimationFrame: the camera demo would read 0 fps
await send("Page.navigate", { url: `http://localhost:8051/${path}` })
await new Promise((r) => setTimeout(r, +wait))
// parts of js split by //SHOT: each part but the last is followed by a screenshot, <out>.<n>.png
const parts = js.split("//SHOT")
for (const [n, part] of parts.entries()) {
	if (!part.trim()) continue
	if (n > 0) {
		await send("Page.bringToFront")
		const mid = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
		await Deno.writeFile(
			out.replace(/\.png$/, `.${n}.png`),
			Uint8Array.from(atob(mid.data), (c) => c.charCodeAt(0)),
		)
	}
	const r = await send("Runtime.evaluate", {
		expression: `(async () => { ${part} })()`,
		awaitPromise: true,
		returnByValue: true,
	})
	logs.push(
		`eval: ${JSON.stringify(r?.result?.value ?? r?.exceptionDetails?.exception?.description)}`,
	)
	// a returned [x, y] is where the mouse then rests, for hovers; [x, y, text] types text there too
	const at = r?.result?.value
	if (Array.isArray(at) && typeof at[0] === "number") {
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0] - 6, y: at[1] })
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0], y: at[1] })
	}
	await new Promise((r) => setTimeout(r, n < parts.length - 1 ? 600 : 2000))
}
// parallel shots share one chrome: bring this tab forward so its frame is the one painted
await send("Page.bringToFront")
await new Promise((r) => setTimeout(r, 150))
const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
await Deno.writeFile(out, Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)))
ws.close()
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
console.log(logs.slice(0, 30).join("\n"))
console.log(out)
Deno.exit(0)
