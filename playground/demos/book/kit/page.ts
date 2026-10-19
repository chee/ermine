/// <reference lib="dom" />
// a pond page: the board fills the window; the notes are a card floating on it, top left, which
// folds away; a caption at the bottom says, in words, what just happened.
//
//   const page = pondPage("rounds", {
//     say: "<p>…two or three sentences…</p>",
//     tries: [{ id: "rain", text: "Make it rain." }, …],
//     rules: "<p>…</p>",              // folded away under "how it works"
//     real: "Runs the real …",        // the small print: what's ermine's, what's the page's
//   })
//   page.tick("rain")                 // a try done: crossed off, and the next one lit
//   page.say("Rain fell. The algae grew, so the minnows ran.")
import { createBoard } from "./board.ts"
import { chapterNav, shell } from "../book.ts"

export type Try = { id: string; text: string }

export function pondPage(
	slug: string,
	{ say, tries, rules, real }: { say: string; tries: Try[]; rules?: string; real: string },
) {
	const chapter = shell(slug)
	const main = document.querySelector("main")!
	main.className = "pondpage notes-open"
	main.innerHTML = `<div id="board"></div>
		<aside id="notes" class="notes-card">
			<button class="fold" title="fold the notes away">–</button>
			<h1>${chapter.title}</h1>
			<div class="say">${say}</div>
			<div class="try"><p class="label">try</p><ol>${
		tries.map((t) => `<li data-try="${t.id}">${t.text}</li>`).join("")
	}</ol></div>
			${rules ? `<details class="rules"><summary>how it works</summary>${rules}</details>` : ""}
			${chapterNav(slug)}
			<p class="true">${real}</p>
		</aside>
		<div class="caption" aria-live="polite"></div>`
	const notes = main.querySelector<HTMLElement>("#notes")!
	const fold = () => {
		const folded = notes.classList.toggle("folded")
		main.classList.toggle("notes-open", !folded)
		notes.querySelector<HTMLElement>(".fold")!.textContent = folded ? "notes" : "–"
		document.getElementById("t-notes")?.setAttribute("aria-pressed", String(!folded))
	}
	notes.querySelector<HTMLElement>(".fold")!.onclick = fold
	// a narrow window: the board gets the room, the notes start folded
	if (innerWidth < 1100) fold()
	// the header's notes button folds the card instead of hiding a column
	const t = document.getElementById("t-notes")
	if (t) t.onclick = fold
	const next = () => {
		for (const li of notes.querySelectorAll("li[data-try]")) li.classList.remove("next")
		notes.querySelector("li[data-try]:not(.done)")?.classList.add("next")
	}
	next()
	const caption = main.querySelector<HTMLElement>(".caption")!
	let timer: ReturnType<typeof setTimeout> | undefined
	const board = createBoard(main.querySelector<HTMLElement>("#board")!)
	return {
		board,
		notes,
		tick(id: string) {
			const li = notes.querySelector(`li[data-try="${id}"]`)
			if (!li || li.classList.contains("done")) return
			li.classList.add("done")
			next()
		},
		// what just happened, in words; tone: hot (cherry) or ok (stem) or plain
		say(html: string, tone?: "hot" | "ok") {
			caption.innerHTML = html
			caption.className = `caption shown ${tone ? `tone-${tone}` : ""}`
			clearTimeout(timer)
			timer = setTimeout(() => caption.classList.remove("shown"), 9000)
		},
	}
}
