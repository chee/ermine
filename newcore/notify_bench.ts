// deno bench newcore/notify_bench.ts
// patched() only: the content is made once, the patch never applied (notify never applies one)
import { createNotify, facts, type Patch } from "./notify.ts"

const N = 10_000
const items = Array.from({ length: N }, (_, i) => `e${i}`)
const rows = Array.from({ length: N }, (_, i) => ({ id: `r${i}`, v: i }))
const text = "x".repeat(100_000)
const meta = Object.fromEntries(Array.from({ length: N }, (_, i) => [`k${i}`, i]))
const content = { items, rows, text, meta }

function setup(reads: (n: ReturnType<typeof createNotify>) => void) {
	const n = createNotify(() => content)
	reads(n)
	return n
}
function bench(name: string, group: string, n: ReturnType<typeof createNotify>, patch: Patch) {
	// the facts made once: the caller's, as the content is
	const f = facts(patch, content)
	Deno.bench(name, { group }, () => n.patched(patch, f))
}

const first: Patch = { path: ["items"], range: [0, 0], value: ["t"] }
const append: Patch = { path: ["items"], range: [N, N], value: ["t"] }
const middle: Patch = { path: ["items"], range: [N / 2, N / 2 + 1], value: ["t"] }

// nothing read
bench("insert first, no reads", "no reads", setup(() => {}), first)
bench("put a row's field, no reads", "no reads", setup(() => {}), {
	path: ["rows", 5000, "v"],
	value: 1,
})

// one read per element: what a list view showing all of them has
const every = (chase: boolean) => (n: ReturnType<typeof createNotify>) => {
	for (let i = 0; i < N; i++) n.read(["items", i], { chase }).on(() => {})
}
bench("insert first: every one fires", "10k item reads", setup(every(false)), first)
bench("append: none fire", "10k item reads", setup(every(false)), append)
bench("same-length put in the middle: one fires", "10k item reads", setup(every(false)), middle)
bench("insert first, chased: every one moves", "10k chased reads", setup(every(true)), first)
bench("append, chased: none move", "10k chased reads", setup(every(true)), append)

// one read per row field, a patch to one of them
bench(
	"put one row's field",
	"10k row field reads",
	setup((n) => {
		for (let i = 0; i < N; i++) n.read(["rows", i, "v"]).on(() => {})
	}),
	{ path: ["rows", 5000, "v"], value: 1 },
)

// one read per key, a new key
bench(
	"put a new key",
	"10k key reads",
	setup((n) => {
		for (let i = 0; i < N; i++) n.read(["meta", `k${i}`]).on(() => {})
		n.read(["meta"]).on(() => {})
	}),
	{ path: ["meta", "new"], value: 1 },
)

// typing: a caret in 100k characters, one character typed before it
bench(
	"type before a caret in 100k chars",
	"text",
	setup((n) => {
		n.read(["text", [50_000, 50_000]], { chase: true, edges: ["out", "out"] }).on(() => {})
	}),
	{ path: ["text"], range: [49_999, 49_999], value: "a" },
)
bench(
	"type, 100 carets",
	"text",
	setup((n) => {
		for (let i = 0; i < 100; i++) {
			n.read(["text", [i * 1000, i * 1000]], { chase: true }).on(() => {})
		}
	}),
	{ path: ["text"], range: [0, 0], value: "a" },
)

// a move inside the list, 10k chased
bench("move last to first, chased", "10k chased reads", setup(every(true)), {
	path: ["items"],
	range: [0, 0],
	move: { path: ["items", N - 1] },
})
