/// <reference lib="dom" />
// the book's pages, in order, and the shell each chapter page shares: the header (the book, the
// chapter's number and title, back and on, a notes toggle) and the notes' foot (back and on again)
//
// a chapter page: book/<slug>/index.html with <header class="bar"></header>, <main class="chapter">
// holding #stage and <aside id="notes">, and its main.ts calling shell(slug) first

// part: the book's two halves. "how": how the core works, a page an idea. "why": moments that
// show what it's for, each beside what other software does instead
export type Chapter = {
	slug: string
	title: string
	about: string
	href?: string
	part?: "how" | "why"
}

export const CHAPTERS: Chapter[] = [
	{ slug: "node", title: "inside a node", about: "a fish is entries in tables, at one id" },
	{ slug: "patches", title: "where a write lands", about: "patches, paths and undo" },
	{ slug: "squish", title: "many edits, one", about: "squishing patches as you type" },
	{ slug: "tracking", title: "who read what", about: "a computer reruns when what it read changes" },
	{ slug: "rounds", title: "a round", about: "order, stopping early, effects last" },
	{ slug: "waiting", title: "waiting", about: "pending, promises and what waits on them" },
	{ slug: "loops", title: "loops", about: "what happens when a computer feeds itself" },
	{ slug: "scopes", title: "who made whom", about: "scopes, children kept, cleanups" },
	{ slug: "unread", title: "copies nobody sees", about: "writes in place until someone reads" },
	{ slug: "why", title: "why is she so big?", about: "ask anything why, and follow it back", part: "why" },
	{ slug: "together", title: "one pig, two places", about: "the same farm on two computers", part: "why" },
	{ slug: "rewind", title: "rewind the farm", about: "go back to this morning, really", part: "why" },
	{ slug: "live", title: "change the rules", about: "edit a program while it runs", part: "why" },
]

const $ = (id: string) => document.getElementById(id)!

// a chapter's href from another chapter's page (book/<slug>/), or from the book's own (book/)
export function hrefOf(c: Chapter, from: "chapter" | "book" = "chapter"): string {
	if (c.href) return from === "book" ? c.href.replace(/^\.\.\//, "") : c.href
	return from === "book" ? `${c.slug}/` : `../${c.slug}/`
}

export function shell(slug: string): Chapter {
	const i = CHAPTERS.findIndex((c) => c.slug === slug)
	const c = CHAPTERS[i]
	const prev = CHAPTERS[i - 1], next = CHAPTERS[i + 1]
	document.title = `${c.title} · the ermine book`
	const bar = document.querySelector("header.bar")!
	bar.innerHTML = `<a class="name" href="../../">🐰 ermine demos</a>
		<a href="../">the book</a>
		<span class="title"><b>${i + 1}</b>${c.title}</span>
		<button id="t-notes" aria-pressed="true" title="show or hide the notes">notes</button>
		<a class="btn ${prev ? "" : "off"}" href="${prev ? hrefOf(prev) : "#"}" title="${
		prev ? `back: ${prev.title}` : ""
	}">←</a>
		<a class="btn ${next ? "" : "off"}" href="${next ? hrefOf(next) : "#"}" title="${
		next ? `on: ${next.title}` : ""
	}">→</a>`
	$("t-notes").onclick = () => {
		const b = $("t-notes")
		const on = b.getAttribute("aria-pressed") !== "true"
		b.setAttribute("aria-pressed", String(on))
		$("notes").classList.toggle("hidden", !on)
		document.querySelector("main.chapter")!.classList.toggle("no-notes", !on)
		dispatchEvent(new Event("resize"))
	}
	return c
}

// the notes' foot: back and on, with names
export function chapterNav(slug: string): string {
	const i = CHAPTERS.findIndex((c) => c.slug === slug)
	const prev = CHAPTERS[i - 1], next = CHAPTERS[i + 1]
	return `<div class="chapters">${
		prev ? `<a class="b" href="${hrefOf(prev)}">← ${prev.title}</a>` : ""
	}<span class="grow"></span>${
		next ? `<a class="b" href="${hrefOf(next)}">${next.title} →</a>` : ""
	}</div>`
}
