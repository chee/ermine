/** @jsxImportSource ermine-h */
import { bind, handler, under } from "ermine-h"

// program.ts: a place to drop a graph. any example's 💾 save graph (in the header) makes a .ermine
// file: everything its root reached, packed, a live value (a view, a handler) as a stand-in that
// says what it was. drop one here, or pick one: the host's method /host/on/load puts its nodes in the
// table and places its root under /loaded, then the graph tab shows it. drop more: each gets a name
export default function program() {
	// the file a drop or a pick carries: none, no call. a drop is the browser's to open unless
	// stopped here
	const dropped = (e: DragEvent) => {
		e.preventDefault()
		const file = e.dataTransfer?.files[0]
		return file ? [file] : undefined
	}
	const picked = (e: Event) => {
		const input = e.target as HTMLInputElement
		const file = input.files?.[0]
		input.value = ""
		return file ? [file] : undefined
	}
	return (
		<div>
			<label
				style={{
					display: "block",
					padding: "40px 16px",
					border: "2px dashed #000",
					borderRadius: "2px",
					textAlign: "center",
					cursor: "pointer",
				}}
				onDragOver={(e: DragEvent) => e.preventDefault()}
				onDrop={handler("/host/on/load", dropped)}
			>
				drop a .ermine file here, or click to pick one
				<input
					type="file"
					accept=".ermine"
					hidden
					onChange={handler("/host/on/load", picked)}
				/>
			</label>
			<p>{bind("/host/said")}</p>
			<ul>{under("/loaded", (item) => <li>/loaded/{item.name}</li>)}</ul>
		</div>
	)
}
