// json: a tool for any datatype ("*"): the doc as JSON, drawn again at each change. written to
// patchwork's contract, (handle, element) => cleanup, and nothing else: no imports
export const plugins = [
	{
		type: "patchwork:tool",
		id: "json",
		name: "JSON",
		supportedDatatypes: "*",
		load: () => json,
	},
]

function json(handle, element) {
	const pre = element.ownerDocument.createElement("pre")
	const draw = () => {
		pre.textContent = JSON.stringify(handle.doc(), null, "\t")
	}
	draw()
	element.append(pre)
	handle.on("change", draw)
	return () => {
		handle.off("change", draw)
		pre.remove()
	}
}
