/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	hasNode,
	patch,
	peep,
	read as readNode,
	ref,
	unplace,
} from "@ermine/system"
import { createPatch, layers } from "@ermine/patchy/feature"
import { bind, handler } from "ermine-h"

// fancy-layers: a pixel editor on patch nodes. the picture is a node, ./picture, an array of 256
// colours. the layers over it are patch nodes (patch/land/layers, patchy's overlay) placed under
// it, made in the order they come, so a read of ./picture gives the picture with them all laid
// over it, and the stored value is never written while you draw:
//
//   preview  ./picture/preview  a filter's result, shown before it is applied (one whole patch)
//   draft    ./picture/draft    your strokes, one patch per pixel: only what you drew
//   stored   ./picture          the picture itself. a commit lands the draft on it
//
// pending (a slow blur is out) is not a node: it is the stage's busy note, in front of the stack.
// the order is the order they came; a draft made while a preview is out takes the preview out and
// puts it back, so the preview stays in front. the pad is a canvas, kept across reloads (./pad).
// a program holds no patch entry (a node's "patch" part is the feature's): each stroke is kept in
// ./strokes too, and the draft is made again from them (createPatch). land is the host's service,
// /system/land: a commit sends it the draft

const N = 16
const palette = [
	"#000000",
	"#ffffff",
	"#ff2284",
	"#40dcba",
	"#2269ff",
	"#fff7a8",
	"#ff9a3c",
	"#9b6bff",
]

// a heart with a black outline and a glint, on cream
function sprite(): string[] {
	const inside = (x: number, y: number) => {
		const u = (x - 7.5) / 6.4, v = (7.2 - y) / 6.2
		return (u * u + v * v - 1) ** 3 - u * u * v ** 3 <= 0
	}
	const out: string[] = []
	for (let y = 0; y < N; y++) {
		for (let x = 0; x < N; x++) {
			const here = inside(x, y)
			const edge = here &&
				[[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inside(x + dx, y + dy))
			out.push(
				!here ? "#fffbe0" : edge ? "#000000" : (x === 4 && y === 3) || (x === 5 && y === 3) ||
						(x === 4 && y === 4)
					? "#ffffff"
					: "#ff2284",
			)
		}
	}
	return out
}

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
const hex = (r: number, g: number, b: number) =>
	"#" +
	[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
		.join("")

// the quick filters: a picture in, a picture out
const filters: Record<string, (px: string[]) => string[]> = {
	invert: (px) =>
		px.map((c) => {
			const [r, g, b] = rgb(c)
			return hex(255 - r, 255 - g, 255 - b)
		}),
	mirror: (px) => px.map((_, i) => px[Math.floor(i / N) * N + (N - 1 - (i % N))]),
	mono: (px) =>
		px.map((c) => {
			const [r, g, b] = rgb(c)
			const y = 0.3 * r + 0.59 * g + 0.11 * b
			return hex(y, y, y)
		}),
	rotate: (px) => px.map((_, i) => px[(N - 1 - (i % N)) * N + Math.floor(i / N)]),
}

// the slow one: a box blur, two passes, that takes its time
function blur(px: string[]): string[] {
	let now = px
	for (let pass = 0; pass < 2; pass++) {
		now = now.map((_, i) => {
			const x = i % N, y = Math.floor(i / N)
			let r = 0, g = 0, b = 0, k = 0
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx, yy = y + dy
					if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue
					const c = rgb(now[yy * N + xx])
					r += c[0], g += c[1], b += c[2], k++
				}
			}
			return hex(r / k, g / k, b / k)
		})
	}
	return now
}
const slowBlur = (job: { n: number; pixels: string[] }) =>
	new Promise<{ n: number; pixels: string[] }>((done) =>
		setTimeout(() => done({ n: job.n, pixels: blur(job.pixels) }), 2400)
	)

// a layer as a picture: a data url the card shows, kept per array
const urls = new WeakMap<object, string>()
function thumb(v: unknown) {
	if (!Array.isArray(v)) return ""
	let u = urls.get(v)
	if (u) return u
	const c = Object.assign(document.createElement("canvas"), { width: N, height: N })
	const g = c.getContext("2d")!
	v.forEach((col, i) => {
		if (col) g.fillStyle = col, g.fillRect(i % N, Math.floor(i / N), 1, 1)
	})
	urls.set(v, u = c.toDataURL())
	return u
}

const says: Record<string, string> = {
	pending: "a slow blur is out. in front until it lands",
	preview: "a filter's result, not applied yet",
	draft: "your strokes. null where nothing is drawn",
	stored: "the picture. a commit writes here",
}
const short = (path: unknown) => (Array.isArray(path) ? "/" + path.join("/") : String(path))

const css = `
.fx{font-family:Jost,system-ui,sans-serif;color:#000;max-width:760px;margin:0 auto;padding:6px 4px 20px}
.fx *{box-sizing:border-box}
.fx h1{font-size:22px;margin:4px 0 2px;font-weight:600}
.fx h1 span{display:inline-block;background:#fff7a8;border:1px solid #000;padding:0 8px;transform:skew(-8deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:6px}
.fx .lede{margin:0 0 12px;font-size:14px;line-height:1.35;max-width:620px}
.fx code{font-family:ui-monospace,Menlo,monospace;font-size:11px}
.fx .cols{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
.fx .card{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:12px}
.fx .left{width:352px}
.fx .right{flex:1;min-width:290px}
.fx .stage{position:relative;width:320px;height:320px;border:1px solid #000;line-height:0;background:#fff}
.fx .stage canvas{width:320px;height:320px;touch-action:none;cursor:crosshair}
.fx .stage[data-busy=yes]::after{content:"blurring... (pending, in front)";position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:8px;line-height:1;font-size:13px;font-weight:600;background:repeating-linear-gradient(135deg,#fff7a8cc 0 10px,#ffffffcc 10px 20px);animation:fxslide 1s linear infinite;pointer-events:none}
@keyframes fxslide{to{background-position:28px 0}}
.fx .pal{display:flex;gap:6px;margin:10px 0 8px}
.fx .pal b{width:28px;height:28px;border:1px solid #000;border-radius:2px;cursor:pointer;box-shadow:1px 1px 0 #000}
.fx .pal b.on{outline:3px solid #ff2284;outline-offset:1px}
.fx .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
.fx .row .lab{font-size:12px;font-weight:600;min-width:52px}
.fx button{font:inherit;font-size:13px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:2px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.fx button:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:3px 3px 0 #000}
.fx button:active:not(:disabled){transform:translate(1px,1px);box-shadow:0 0 0 #000}
.fx button:disabled{opacity:.35;cursor:default;box-shadow:none}
.fx button.on{background:#40dcba}
.fx button.go{background:#ff2284;color:#fff}
.fx button.cool{background:#2269ff;color:#fff}
.fx h2{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fx h2 em{font-style:normal;background:#fff7a8;border:1px solid #000;padding:0 6px;transform:skew(-8deg);font-size:12px;font-weight:500}
.fx .stack{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.fx .layer{display:flex;gap:10px;border:1px solid #000;border-radius:2px;background:#fff;padding:6px;position:relative;box-shadow:2px 2px 0 #000}
.fx .layer.draft{box-shadow:2px 2px 0 #ff2284;margin-left:6px}
.fx .layer.preview{box-shadow:2px 2px 0 #40dcba;margin-left:12px}
.fx .layer.pending{box-shadow:2px 2px 0 #2269ff;margin-left:0;background:repeating-linear-gradient(135deg,#fff7a8 0 8px,#fff 8px 16px);animation:fxslide 1s linear infinite}
.fx .layer.stored{margin-left:0}
.fx .thumb{position:relative;width:64px;height:64px;flex:none;border:1px solid #000;background-color:#fff;background-image:linear-gradient(45deg,#0001 25%,#0000 25% 75%,#0001 75%),linear-gradient(45deg,#0001 25%,#0000 25% 75%,#0001 75%);background-size:16px 16px;background-position:0 0,8px 8px}
.fx .thumb i{position:absolute;inset:0;image-rendering:pixelated;background-size:100% 100%}
.fx .meta{display:flex;flex-direction:column;gap:2px;min-width:0}
.fx .line{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.fx .tag{background:#fff7a8;border:1px solid #000;padding:0 7px;transform:skew(-8deg);font-size:12px;font-weight:600}
.fx .draft .tag{background:#ff2284;color:#fff}
.fx .preview .tag{background:#40dcba}
.fx .pending .tag{background:#2269ff;color:#fff}
.fx .front{font-style:normal;font-size:11px;font-weight:600;color:#ff2284}
.fx .what{font-size:12.5px;line-height:1.25}
.fx .size{font-size:11.5px;opacity:.65}
.fx .read{margin:10px 0 0;font-size:13px;line-height:1.35;border-top:1px dashed #000;padding-top:8px}
.fx .empty{font-size:12.5px;opacity:.6;margin:4px 0 0}
.fx label{font-size:12px;display:flex;gap:4px;align-items:center;cursor:pointer}
`

type Flat = { px: string[]; from: string[] }
type Stroke = { path: number[]; value?: string[] | string }
type Layer = { value: unknown; from: unknown }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const put = (v: unknown) => [{ path: [], value: v }]

export default function program() {
	// what a node holds, as the editor takes it (any: its values are its own); the actions run
	// untracked (peep)
	// deno-lint-ignore no-explicit-any
	const read = (x: Parameters<typeof readNode>[0], key?: readonly string[]): any =>
		readNode(x, key)
	const method = (name: string, f: (...a: any[]) => unknown) =>
		createAction(name, (...a: unknown[]) => peep(() => f(...a)))
	const picture = ensureNode("./picture", sprite())
	const ink = ensureNode("./ink", palette[4])
	const filter = ensureNode("./filter", "")
	const lens = ensureNode("./lens", true)
	const request = ensureNode("./request", null)
	const serial = ensureNode("./serial", 0)
	const landed = ensureNode("./landed", 0)
	// the draft's strokes, and the preview's whole patch, as this program wrote them
	const drawn = ensureNode("./strokes", [] as Stroke[])
	const draftAt = "./picture/draft", previewAt = "./picture/preview"
	const exists = (at: string) => hasNode(at)
	// a patch node taken out: unplaced, but a layer is the node's patch entry, which no program can
	// delete (the overlay goes on laying it over the picture). so it is emptied first, and what is
	// left, unplaced, is a layer of nothing (named null by layers, left out of the stack)
	const drop = (at: string) => {
		if (!exists(at)) return
		createPatch(at, picture, [])
		unplace(at)
	}
	const strokes = () => read(drawn) as Stroke[]
	// the draft, made again from its strokes (the patch node is the feature's: createPatch writes it)
	const draft = (list: Stroke[]) => {
		patch(drawn, put(list))
		createPatch(draftAt, picture, list as never)
	}

	// the layers of the picture, front first, with the stored one last: what layers() gives, each
	// named by the patch node it came from (its path)
	const named = (): (Layer & { name: string })[] => {
		const at = (p: string) => "/" + ["picture", p].join("/")
		return layers(picture).filter((l) => l.from !== null).map((l) => {
			const from = Array.isArray(l.from) ? "/" + l.from.join("/") : undefined
			return {
				...l,
				name: from?.endsWith(at("preview"))
					? "preview"
					: from?.endsWith(at("draft"))
					? "draft"
					: "stored",
			}
		})
	}
	// what is under the preview: the layer behind it (all of them, if there is no preview)
	const under = () => {
		const l = named(), k = l.findIndex((x) => x.name === "preview")
		return (l[k + 1] ?? l[0]).value as string[]
	}

	// ---- derived, as memos: a node each in the graph ----
	const busy = createMemo("busy", () => {
		const job = read(request) as { n: number } | null
		return job !== null && job.n > (read(landed) as number)
	})
	const stack = createMemo("stack", () => {
		const l = named()
		const out = []
		if (read(busy)) out.push({ name: "pending", id: "", url: "", size: "" })
		for (const x of l) {
			const touched = x.name === "draft" ? (read(drawn) as Stroke[]) : undefined
			out.push({
				name: x.name,
				id: x.name === "stored" ? short(["picture"]) : short(x.from),
				url: thumb(x.value),
				size: x.name === "draft"
					? touched?.some((p) => p.path.length === 0)
						? "all 256 px"
						: `${new Set(touched?.map((p) => p.path[0])).size} px drawn`
					: x.name === "preview"
					? "all 256 px"
					: "256 px",
			})
		}
		return out
	})
	createMemo("front", () => (read(stack) as { name: string }[])[0]?.name)
	createMemo("count", () => (read(stack) as unknown[]).length)
	createMemo("drafted", () => exists(draftAt))
	// the picture a read gives, and which layer decided each pixel
	const shown = createMemo("shown", () => {
		const px = read(picture) as string[]
		const preview = exists(previewAt)
		const set = new Set<number>()
		let all = false
		for (const p of read(drawn) as Stroke[]) p.path.length ? set.add(p.path[0]) : (all = true)
		const from = px.map((_, i) => preview ? "preview" : all || set.has(i) ? "draft" : "stored")
		return { px, from } as Flat
	}, { equal: sameJson })

	// a draft: made when first wanted, and in front of nothing but the preview
	function ensure() {
		if (exists(draftAt)) return
		const was = exists(previewAt) ? (read(previewing) as Stroke[] | null) : null
		if (was) drop(previewAt)
		draft([])
		if (was) createPatch(previewAt, picture, was as never)
	}
	const take = () => {
		drop(draftAt)
		patch(drawn, put([]))
	}

	// the preview follows the filter and what is under it: made, rewritten, taken out. it reads the
	// layers it is one of, so its own write comes back as the same result: equal cuts it off there.
	// ./previewing holds the patch it wrote
	const previewing = ensureNode("./previewing", null)
	createEffect("previewing", () => {
		const f = filters[read(filter) as string]
		return f ? f(under()) : null
	}, (result: string[] | null) => {
		if (!result) {
			drop(previewAt)
			patch(previewing, put(null))
		} else {
			patch(previewing, put(put(result)))
			createPatch(previewAt, picture, put(result) as never)
		}
	}, { equal: sameJson })

	// the slow filter: a compute that awaits. while it is out the stage says so; when it lands the
	// result goes in the draft. landing writes only ./landed, which blurred does not read
	const blurred = createMemo("blurred", () => {
		const job = read(request) as { n: number; pixels: string[] } | null
		return job ? slowBlur(job) : null
	})
	createEffect("landing", () => {
		const v = read(blurred) as { n: number; pixels: string[] } | null
		return v && typeof v === "object" ? v : null
	}, (v: { n: number; pixels: string[] } | null) => {
		if (!v) return
		peep(() => {
			ensure()
			draft(put(v.pixels) as Stroke[])
			patch(landed, put(v.n))
		})
	})

	// ---- methods ----
	method("on/paint", (i: number) => {
		const c = read(ink) as string
		ensure()
		// the last patch that touches pixel i: one of its own is set, else a new one goes on
		const list = strokes().map((p) => ({ ...p }))
		let k = list.length - 1
		while (k >= 0 && list[k].path.length && list[k].path[0] !== i) k--
		if (k >= 0 && list[k].path.length) list[k].value = c
		else list.push({ path: [i], value: c })
		draft(list)
	})
	method("on/ink", (c: string) => patch(ink, put(c)))
	method("on/filter", (name: string) => patch(filter, put(read(filter) === name ? "" : name)))
	method("on/apply", () => {
		if (!exists(previewAt)) return
		const result = (read(previewing) as Stroke[])[0].value
		ensure()
		draft(put(result) as Stroke[])
		patch(filter, put(""))
	})
	method("on/blur", () => {
		const n = (read(serial) as number) + 1
		patch(serial, put(n))
		patch(request, put({ n, pixels: under() }))
	})
	method("on/commit", () => {
		if (!exists(draftAt)) return
		executeAction("/system/land", draftAt)
		unplace(draftAt)
		patch(drawn, put([]))
		patch(request, put(null))
	})
	// discard also calls off a blur in flight: it would land in a draft that is gone
	method("on/discard", () => {
		patch(request, put(null))
		take()
	})
	method("on/reset", () => {
		patch(request, put(null))
		take()
		patch(filter, put(""))
		patch(picture, put(sprite()))
	})
	method("on/lens", () => patch(lens, put(!read(lens))))

	// ---- the pad: a canvas, made once and kept (./pad), drawn from the shown picture ----
	const pad = peep(() =>
		readNode(
			ref(
				"./pad",
				() =>
					Object.assign(document.createElement("canvas"), { width: N * 20, height: N * 20 }),
			),
		)
	) as HTMLCanvasElement
	// the pointer is heard on the stage (a plain listener has nothing open, so no
	// writer is made here): a pixel the pointer is on, while it is down, is a paint call
	let down = false, last = -1
	const hit = (e: PointerEvent) => {
		const r = pad.getBoundingClientRect()
		const x = Math.floor(((e.clientX - r.left) / r.width) * N)
		const y = Math.floor(((e.clientY - r.top) / r.height) * N)
		const i = y * N + x
		if (x < 0 || y < 0 || x >= N || y >= N || i === last) return
		last = i
		return [i]
	}
	const onDown = (e: PointerEvent) => {
		pad.setPointerCapture(e.pointerId)
		down = true, last = -1
		return hit(e)
	}
	const onMove = (e: PointerEvent) => down ? hit(e) : undefined
	const onUp = () => void (down = false)

	createEffect(
		"draw",
		() => [read(shown), read(lens)] as [Flat, boolean],
		([flat, who]: [Flat, boolean]) => {
			if (!flat?.px) return
			const g = pad.getContext("2d")!, k = 20
			flat.px.forEach((c, i) => {
				const x = (i % N) * k, y = Math.floor(i / N) * k
				g.fillStyle = c
				g.fillRect(x, y, k, k)
				if (who && flat.from[i] === "draft") {
					g.fillStyle = "#ff228430", g.fillRect(x, y, k, k)
					g.fillStyle = "#ff2284", g.fillRect(x, y, 6, 6)
				} else if (who && flat.from[i] === "preview") {
					g.fillStyle = "#40dcba40", g.fillRect(x, y, k, k)
					g.fillStyle = "#40dcba", g.fillRect(x, y, 6, 6)
				}
			})
			g.strokeStyle = "#0000001a"
			g.lineWidth = 1
			g.beginPath()
			for (let i = 1; i < N; i++) {
				g.moveTo(i * k + 0.5, 0), g.lineTo(i * k + 0.5, N * k)
				g.moveTo(0, i * k + 0.5), g.lineTo(N * k, i * k + 0.5)
			}
			g.stroke()
		},
	)

	const chip = (name: string) => (
		<button
			class={bind("filter", (v) => (v === name ? "on" : ""))}
			onClick={handler("on/filter", [name])}
		>
			{name}
		</button>
	)

	return (
		<div class="fx">
			<style>{css}</style>
			<h1>
				layers<span>one picture, named layers</span>
			</h1>
			<p class="lede">
				draw and the strokes go into a draft node under the stored picture, in front of it. the
				stored picture is not touched until you commit. discard takes the draft node out.
			</p>
			<div class="cols">
				<section class="card left">
					<div
						class="stage"
						data-busy={bind("busy", (b) => (b ? "yes" : "no"))}
						onPointerDown={handler("on/paint", onDown)}
						onPointerMove={handler("on/paint", onMove)}
						onPointerUp={handler("on/paint", onUp)}
						onPointerCancel={handler("on/paint", onUp)}
					>
						{pad}
					</div>
					<div class="pal">
						{palette.map((c) => (
							<b
								key={c}
								style={{ background: c }}
								class={bind("ink", (v) => (v === c ? "on" : ""))}
								onClick={handler("on/ink", [c])}
							/>
						))}
					</div>
					<div class="row">
						<span class="lab">preview</span>
						{chip("invert")}
						{chip("mirror")}
						{chip("mono")}
						{chip("rotate")}
					</div>
					<div class="row">
						<span class="lab" />
						<button
							class="cool"
							onClick={handler("on/apply")}
							disabled={bind("filter", (v) => !v)}
						>
							apply preview
						</button>
						<button onClick={handler("on/blur")} disabled={bind("busy")}>slow blur</button>
					</div>
					<div class="row">
						<span class="lab">draft</span>
						<button
							class="go"
							onClick={handler("on/commit")}
							disabled={bind("drafted", (d) => !d)}
						>
							commit
						</button>
						<button onClick={handler("on/discard")} disabled={bind("drafted", (d) => !d)}>
							discard
						</button>
						<button onClick={handler("on/reset")}>reset</button>
						<label>
							<input
								type="checkbox"
								checked={bind("lens")}
								onChange={handler("on/lens")}
							/>
							who wins
						</label>
					</div>
				</section>
				<section class="card right">
					<h2>
						the stack at <code>/layers/picture</code>
						<em>{bind("count")} here, front first</em>
					</h2>
					<ol class="stack">
						{bind(
							"stack",
							(rows: { name: string; id: string; url: string; size: string }[]) =>
								rows.map((row, i) => (
									<li key={row.name} class={`layer ${row.name}`}>
										<div class="thumb">
											<i style={row.url ? { backgroundImage: `url(${row.url})` } : {}} />
										</div>
										<div class="meta">
											<div class="line">
												<b class="tag">{row.name}</b>
												<code>{row.id}</code>
												{i === 0
													? <em class="front">front: a read takes this</em>
													: null}
											</div>
											<div class="what">{says[row.name]}</div>
											<div class="size">{row.size}</div>
										</div>
									</li>
								)),
						)}
					</ol>
					<p class="read">
						the stored picture is the picture's own node; draft and preview are patch nodes
						under it. a read goes through to <b>{bind("front")}</b>.
					</p>
				</section>
			</div>
		</div>
	)
}
