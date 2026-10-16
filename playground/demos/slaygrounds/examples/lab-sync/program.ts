/** @jsxImportSource ermine-h */
import type { Tools } from "./host.ts"
import { bind } from "ermine-h"

// program.ts: everyone who opens this example is in one room on wss://galaxy.observer. each device
// that joins brings a note of its own; when it leaves, its heartbeat stops and its note drops away.
// type in anyone's note: your cursor shows on theirs. edit me while it runs.
//
// try: open this in a second window. type in both at once in one note: two versions, the one in
// the agreed order shows; settle keeps it. switch merge on: the versions show merged (eg-walker),
// and typing in both at once keeps every keystroke. type 300 in yours: fragments form now and then
// (a commit whose hash starts with a zero byte heads one) and the loose commits they cover are let
// go
export default function program(t: Tools) {
	return (
		<main style={{ padding: "4px", display: "grid", gap: "4px" }}>
			{bind("/me", (m) => (
				<header style={{ display: "flex", gap: "8px", alignItems: "center" }}>
					<b style={{ color: m.colour }}>{m.name}</b>
					<small>server: {m.server}</small>
					<small>
						yours: {m.commits ?? 0} commits · {m.loose ?? 0} loose · {m.fragments ?? 0}{" "}
						fragments ({m.covered ?? 0} commits in them)
					</small>
					<button onClick={() => t.type(300)}>type 300 in yours</button>
					<button onClick={() => t.merge(!m.merging)}>
						merge: {m.merging ? "on" : "off"}
					</button>
				</header>
			))}
			{bind("/peers", (peers) => (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
						gap: "4px",
					}}
				>
					{peers.map((p) => (
						<section
							key={p.who}
							style={{ border: "1px solid #111", background: "#fff", padding: "6px" }}
						>
							<div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
								<span
									style={{
										width: "10px",
										height: "10px",
										borderRadius: "50%",
										background: p.colour,
									}}
								/>
								<b>{p.name}</b>
								{p.me ? <small>(you)</small> : null}
								{p.versions > 1
									? (
										<small>
											{p.versions} versions{" "}
											<button onClick={() => t.settle(p.note)}>settle</button>
										</small>
									)
									: null}
							</div>
							{t.pad(p.note)}
						</section>
					))}
				</div>
			))}
		</main>
	)
}
