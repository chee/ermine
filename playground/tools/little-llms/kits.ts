// an API kit: what the model is told it has, the language it answers in, a worked example and a skeleton

export type KitName =
	| "js"
	| "sql"
	| "dom"
	| "html"
	| "jsx"
	| "reactive"
	| "ermine"
	| "canvas"
export type Kit = {
	name: KitName
	lang: string
	role: "data" | "view"
	api: string
	example: { task: string; answer: string }
	scaffold?: string
}

export const kits: Record<KitName, Kit> = {
	js: {
		name: "js",
		lang: "js",
		role: "data",
		api: `Write a JavaScript function \`transform(data)\` that returns the answer.
\`data\` is an object of tables; each table is an array of row objects, like data.people.
No imports, no console.log, no I/O. Only the function.`,
		example: {
			task: "How many people are older than 30?",
			answer: `function transform(data) {
  return data.people.filter(p => p.age > 30).length
}`,
		},
	},
	sql: {
		name: "sql",
		lang: "sql",
		role: "data",
		api: `Write one SQLite SELECT query that returns the answer.
The tables already exist and hold the data. Do not create or insert anything.`,
		example: {
			task: "How many people are older than 30?",
			answer: `SELECT COUNT(*) AS n FROM people WHERE age > 30;`,
		},
	},
	dom: {
		name: "dom",
		lang: "js",
		role: "view",
		api: `Write browser JavaScript. Globals you can use:
- \`root\`: an empty <div> to put your UI in
- \`data\`: input data
- \`out(value)\`: send a value to the outlet
Build the UI with document.createElement and append it to root. No frameworks, no imports.`,
		example: {
			task: "A button that says 'off'. Clicking it switches between 'on' and 'off' and sends the new word to the outlet.",
			answer: `let on = false
const button = document.createElement("button")
button.textContent = "off"
button.onclick = () => {
  on = !on
  button.textContent = on ? "on" : "off"
  out(button.textContent)
}
root.appendChild(button)`,
		},
		scaffold: `// state
let state = /* ... */

// build elements
const el = document.createElement("div")
root.appendChild(el)

// update the page after a change
function update() {
  /* ... */
}

// event handlers: el.onclick = () => { ...; update(); out(...) }`,
	},
	html: {
		name: "html",
		lang: "html",
		role: "view",
		api: `Write an HTML fragment (no <html>, <head> or <body>). It goes inside a page that has these globals:
- \`data\`: input data
- \`out(value)\`: send a value to the outlet
Use inline event attributes like onclick="..." and a <script> tag for code. No frameworks, no imports.`,
		example: {
			task: "A button that says 'off'. Clicking it switches between 'on' and 'off' and sends the new word to the outlet.",
			answer: `<button id="light" onclick="toggle()">off</button>
<script>
  let on = false
  function toggle() {
    on = !on
    const word = on ? "on" : "off"
    document.getElementById("light").textContent = word
    out(word)
  }
</script>`,
		},
		scaffold: `<div id="ui">
  <!-- elements, with onclick="..." etc -->
</div>
<script>
  // state
  // functions called from the onclick attributes; update the elements and call out(...)
</script>`,
	},
	jsx: {
		name: "jsx",
		lang: "jsx",
		role: "view",
		api: `Write a React-style component named \`App\` using JSX. \`useState\`, \`useEffect\` and \`useRef\` are globals: no imports.
Globals: \`data\` (input data), \`out(value)\` (send a value to the outlet).
Do not call render yourself; App is rendered for you.`,
		example: {
			task: "A button that says 'off'. Clicking it switches between 'on' and 'off' and sends the new word to the outlet.",
			answer: `function App() {
  const [on, setOn] = useState(false)
  const toggle = () => {
    setOn(!on)
    out(!on ? "on" : "off")
  }
  return <button onClick={toggle}>{on ? "on" : "off"}</button>
}`,
		},
		scaffold: `function App() {
  const [state, setState] = useState(/* ... */)
  // handlers: change state with setState(...) and call out(...)
  return (
    <div>
      {/* ... */}
    </div>
  )
}`,
	},
	reactive: {
		name: "reactive",
		lang: "js",
		role: "view",
		api: `Write browser JavaScript with this tiny API:
- Declare \`let state = {...}\`. Change it freely: state.count++, state.items.push(x).
- Define \`function view()\` that returns an HTML string made from state.
- Handlers are plain functions called from inline attributes: onclick="add()", oninput="setText(this.value)".
- The page calls view() again by itself after every event.
Globals: \`data\` (input data), \`out(value)\` (send a value to the outlet).`,
		example: {
			task: "A button that says 'off'. Clicking it switches between 'on' and 'off' and sends the new word to the outlet.",
			answer: `let state = { on: false }

function view() {
  return \`<button onclick="toggle()">\${state.on ? "on" : "off"}</button>\`
}

function toggle() {
  state.on = !state.on
  out(state.on ? "on" : "off")
}`,
		},
		scaffold: `let state = { /* ... */ }

function view() {
  return \`
    <div>
      <!-- HTML made from state, with onclick="handler()" -->
    </div>\`
}

// handlers: change state, call out(...)
function handler() {
  /* ... */
}`,
	},
	ermine: {
		name: "ermine",
		lang: "js",
		role: "view",
		api: `Write \`function program({ open, read, edit, method, data, out })\` with this API:
- \`const n = open("name", initial)\` makes a stored value
- \`read(n)\` gets its value
- \`edit(n, v => newValue)\` changes it; for lists you can mutate: edit(list, d => { d.push(x) })
- \`method("name", (...args) => {...})\` defines an action; call it from HTML with onclick="send('name', arg)"
- return a function that returns an HTML string; it re-renders after every edit
\`out(value)\` sends a value to the outlet. \`data\` is input data.`,
		example: {
			task: "A button that says 'off'. Clicking it switches between 'on' and 'off' and sends the new word to the outlet.",
			answer: `function program({ open, read, edit, method, out }) {
  const on = open("on", false)
  method("toggle", () => {
    edit(on, v => !v)
    out(read(on) ? "on" : "off")
  })
  return () => \`<button onclick="send('toggle')">\${read(on) ? "on" : "off"}</button>\`
}`,
		},
		scaffold: `function program({ open, read, edit, method, data, out }) {
  const thing = open("thing", /* initial */)

  method("change", (arg) => {
    edit(thing, v => /* new value */)
    out(/* ... */)
  })

  return () => \`
    <div>
      <!-- HTML made from read(thing), with onclick="send('change', ...)" -->
    </div>\`
}`,
	},
	canvas: {
		name: "canvas",
		lang: "js",
		role: "view",
		api: `Write browser JavaScript that draws on a canvas. Globals:
- \`canvas\`: a 400x300 <canvas>; \`ctx\`: its 2D context
- \`data\`: input data
Use the Canvas 2D API. No imports.`,
		example: {
			task:
				"Draw a green field: fill the bottom third of the canvas green, then a yellow sun circle (radius 30) at data.sun.x, data.sun.y.",
			answer: `ctx.fillStyle = "green"
ctx.fillRect(0, 200, 400, 100)
ctx.fillStyle = "yellow"
ctx.beginPath()
ctx.arc(data.sun.x, data.sun.y, 30, 0, Math.PI * 2)
ctx.fill()`,
		},
		scaffold: `// background
ctx.fillStyle = /* ... */
ctx.fillRect(0, 0, canvas.width, canvas.height)

// one shape per item
for (const item of /* ... */) {
  ctx.fillStyle = /* ... */
  ctx.beginPath()
  /* ... */
  ctx.fill()
}`,
	},
}

// how the answer is wrapped: a fenced block in markdown, bare code, or code inside JSON
export type Wrap = "fence" | "raw" | "json"
export type Prompting = "min" | "example" | "scaffold"

export const wrapping = (wrap: Wrap, langs: string[]) => {
	if (wrap == "raw") {
		return "Reply with only the code. No markdown fences, no explanation."
	}
	if (wrap == "json") {
		return `Reply with only a JSON object like {"code": "..."} where code is the program as a JSON string.`
	}
	if (langs.length == 1) {
		return `Reply with exactly one \`\`\`${langs[0]} code block and nothing else.`
	}
	return `Reply with ${langs.map((l) => `one \`\`\`${l} code block`).join(", then ")}. Nothing else.`
}

export const fence = (lang: string, code: string) => "```" + lang + "\n" + code + "\n```"

// the system prompt for one kit (or two, when a query and a view come in one answer)
export function system(kit: Kit, prompting: Prompting, wrap: Wrap, also?: Kit) {
	const parts = [
		"You write small programs that run in a sandboxed web page.",
		kit.api,
	]
	if (also) {
		parts.push(
			`Before that, ${also.api.charAt(0).toLowerCase()}${
				also.api.slice(1)
			}\nIn the view, \`data\` is the array of rows your query returned.`,
		)
	}
	if (prompting == "example") {
		parts.push(
			`Example task: ${kit.example.task}\nExample answer:\n${wrap == "fence" ? fence(kit.lang, kit.example.answer) : kit.example.answer}`,
		)
	}
	if (prompting == "scaffold" && kit.scaffold) {
		parts.push(`Fill in this skeleton:\n${fence(kit.lang, kit.scaffold)}`)
	}
	parts.push(wrapping(wrap, also ? [also.lang, kit.lang] : [kit.lang]))
	return parts.join("\n\n")
}
