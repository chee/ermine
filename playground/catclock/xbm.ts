// xbm.ts: the X bitmaps in xbm/ as C arrays, bitmaps.h, kept as XBM keeps
// them: rows of whole bytes, the leftmost pixel in a byte's low bit.
// build.sh runs it.
//
//   deno run --allow-read --allow-write playground/catclock/xbm.ts

const here = new URL(".", import.meta.url).pathname
const names = ["catback", "catwhite", "cattie", "tail", "eyes"]

let out = `// bitmaps.h: made from xbm/*.xbm by xbm.ts (build.sh); not edited by hand.
// Rows of whole bytes, the leftmost pixel in a byte's low bit, as XBM has them.

#include <stdint.h>
`
for (const name of names) {
	const text = Deno.readTextFileSync(`${here}xbm/${name}.xbm`)
	const size = (what: string) => {
		const m = text.match(new RegExp(`_${what}\\s+(\\d+)`))
		if (!m) throw new Error(`${name}.xbm: no ${what}`)
		return Number(m[1])
	}
	const w = size("width"), h = size("height"), stride = Math.ceil(w / 8)
	const bytes = [...text.slice(text.indexOf("{")).matchAll(/0x([0-9a-f]{1,2})/gi)].map((m) =>
		parseInt(m[1], 16)
	)
	if (bytes.length !== stride * h) {
		throw new Error(`${name}.xbm: ${bytes.length} bytes, not ${stride} × ${h}`)
	}
	const N = name.toUpperCase()
	out +=
		`\n#define ${N}_W ${w}\n#define ${N}_H ${h}\nstatic const uint8_t ${name}_bits[${h}][${stride}] = {\n`
	for (let y = 0; y < h; y++) {
		const row = bytes.slice(y * stride, (y + 1) * stride).map((b) =>
			`0x${b.toString(16).padStart(2, "0")}`
		)
		out += `\t{ ${row.join(", ")} },\n`
	}
	out += "};\n"
}
Deno.writeTextFileSync(`${here}bitmaps.h`, out)
