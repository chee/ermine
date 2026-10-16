// web.ts: lab-pig in a headless Chrome page, for interop.ts. A Chrome of its own (port 9334, its own
// profile), one tab per page; the example runs in the editor's iframe, which the editor swaps for a
// fresh one now and then, so it is looked up again at each call
const port = 9334
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const profile = `${Deno.env.get("TMPDIR") ?? "/tmp"}/ermine-pigs-chrome`

async function version() {
	try {
		return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
	} catch {
		return undefined
	}
}

export async function start() {
	if (await version()) return
	new Deno.Command(chrome, {
		args: [
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			// a tab in the background is not slowed: every page here is one
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		stdout: "null",
		stderr: "null",
	}).spawn().unref()
	for (let i = 0; i < 50 && !(await version()); i++) await new Promise((r) => setTimeout(r, 200))
}

export type Page = {
	eval<T = unknown>(js: string): Promise<T>
	// js in the example's iframe (its window as w, its document as d)
	inFrame<T = unknown>(js: string): Promise<T>
	mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number): Promise<void>
	shot(path: string): Promise<void>
	logs: string[]
	close(): Promise<void>
}

export async function open(url: string, width = 1400, height = 900): Promise<Page> {
	const target =
		await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }))
			.json()
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
				`${m.params.type}: ${
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
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	})
	await send("Emulation.setFocusEmulationEnabled", { enabled: true })
	await send("Page.navigate", { url })
	const evaluate = async (expression: string) => {
		const r = await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})
		if (r?.exceptionDetails) {
			throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
		}
		return r?.result?.value
	}
	return {
		logs,
		eval: (js) => evaluate(`(async () => { ${js} })()`),
		inFrame: (js) =>
			evaluate(`(async () => {
				const f = [...document.querySelectorAll("iframe")].find((f) => f.contentDocument?.querySelector(".field"))
				if (!f) return undefined
				const w = f.contentWindow, d = f.contentDocument, fr = f.getBoundingClientRect();
				${js}
			})()`),
		async mouse(type, x, y) {
			await send("Input.dispatchMouseEvent", {
				type,
				x,
				y,
				button: "left",
				buttons: type === "mouseReleased" ? 0 : 1,
				clickCount: 1,
			})
		},
		async shot(path) {
			await send("Page.bringToFront")
			const s = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
			await Deno.writeFile(path, Uint8Array.from(atob(s.data), (c) => c.charCodeAt(0)))
		},
		async close() {
			ws.close()
			await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
		},
	}
}

// what the page shows: its pigs (feet, as fractions of the field; held, by whom; ashamed), the others'
// pointers, its name, the field's place on the page (for the mouse)
export type Seen = {
	name: string
	field: { left: number; top: number; width: number; height: number }
	pigs: {
		x: number
		y: number
		held: boolean
		by: string
		shame: boolean
		binned: boolean
		right: boolean
		cx: number
		cy: number
	}[]
	pointers: {
		name: string
		x: number
		y: number
		look: string
		stuck: boolean
		cx: number
		cy: number
	}[]
	count: string
}

export const seen = (p: Page) =>
	p.inFrame<Seen>(`
		const field = d.querySelector(".field"), r = field.getBoundingClientRect()
		const pigs = [...field.querySelectorAll(".pig[data-ready]:not(.gone)")].map((el) => {
			const m = /translate3d\\(([-0-9.]+)px, ([-0-9.]+)px/.exec(el.style.transform) ?? [0, 0, 0]
			const lift = el.querySelector(".lift").getBoundingClientRect()
			return {
				x: +m[1] / r.width, y: +m[2] / r.height,
				held: el.classList.contains("held"), shame: el.classList.contains("shame"),
				binned: el.classList.contains("binned"), right: !!el.querySelector(".face.right"),
				by: el.querySelector(".by")?.textContent ?? "",
				// the pig's middle on the page, for a mouse to take it by
				cx: fr.left + lift.left + lift.width / 2, cy: fr.top + lift.top + lift.height * 0.55,
			}
		})
		const arrows = [...field.querySelectorAll("div")].filter((c) => c.style?.zIndex === "9000").map((c) => ({
			name: c.querySelector("small")?.textContent ?? "",
			x: parseFloat(c.style.left) / 100, y: parseFloat(c.style.top) / 100, look: "", stuck: false, cx: 0, cy: 0,
		}))
		// a NetHack player: a small @ tile (its middle on the page, for a mouse to take it by)
		const tiles = [...field.querySelectorAll(".hacker")].map((c) => {
			const g = c.querySelector(".glyph").getBoundingClientRect()
			return {
				name: c.querySelector("small")?.textContent ?? "",
				x: parseFloat(c.style.left) / 100, y: parseFloat(c.style.top) / 100, look: "nethack", stuck: c.classList.contains("stuck"),
				cx: fr.left + g.left + g.width / 2, cy: fr.top + g.top + g.height / 2,
			}
		})
		const pointers = [...arrows, ...tiles]
		const header = d.querySelector("header")
		return {
			name: header?.querySelector("b")?.textContent ?? "",
			field: { left: fr.left + r.left, top: fr.top + r.top, width: r.width, height: r.height },
			pigs, pointers,
			count: [...(header?.querySelectorAll("small") ?? [])].map((s) => s.textContent).join(" | "),
		}
	`)
