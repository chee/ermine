// hand-written answers: every checker must pass a right answer, on the data the model sees and on the hidden data

import { assert } from "@std/assert"
import { createSandbox } from "./sandbox.ts"
import { taskById } from "./tasks.ts"
import type { Job } from "./worker.ts"

type Ref = Omit<Job, "data" | "mode">

const refs: Ref[] = [
	{
		task: "join-names",
		kit: "js",
		code: `function transform(d){ const n=d.people.map(p=>p.name); return n.slice(0,-1).join(", ")+" and "+n.at(-1) }`,
	},
	{
		task: "join-names",
		kit: "sql",
		code: `WITH n AS (SELECT name, ROW_NUMBER() OVER () AS i, COUNT(*) OVER () AS c FROM people)
SELECT (SELECT GROUP_CONCAT(name, ', ') FROM n WHERE i < c) || ' and ' || (SELECT name FROM n WHERE i = c) AS s`,
	},
	{
		task: "sum-paid",
		kit: "js",
		code: `const transform = (d) => d.orders.filter(o => o.status === "paid").reduce((s, o) => s + o.amount, 0)`,
	},
	{
		task: "sum-paid",
		kit: "sql",
		code: `SELECT SUM(amount) FROM orders WHERE status = 'paid';`,
	},
	{
		task: "by-category",
		kit: "js",
		code:
			`function transform(d){ const m={}; for(const o of d.orders) m[o.category]=(m[o.category]||0)+o.amount; return Object.entries(m).map(([category,total])=>({category,total})).sort((a,b)=>b.total-a.total) }`,
	},
	{
		task: "by-category",
		kit: "sql",
		code: `SELECT category, SUM(amount) AS total FROM orders GROUP BY category ORDER BY total DESC`,
	},
	{
		task: "top-3",
		kit: "js",
		code: `function transform(d){ return [...d.products].sort((a,b)=>b.price-a.price).slice(0,3).map(p=>p.name) }`,
	},
	{
		task: "top-3",
		kit: "sql",
		code: `SELECT name FROM products ORDER BY price DESC LIMIT 3`,
	},
	{
		task: "format-people",
		kit: "js",
		code:
			`function transform(d){ return d.people.slice().sort((a,b)=>a.last.localeCompare(b.last)).map(p=>\`\${p.last}, \${p.first} (\${p.age})\`) }`,
	},
	{
		task: "format-people",
		kit: "sql",
		code: `SELECT last || ', ' || first || ' (' || age || ')' FROM people ORDER BY last`,
	},
	{
		task: "count-fish",
		kit: "js",
		code: `function transform(d){ return d.notes.filter(n=>/fish/i.test(n.text)).length }`,
	},
	{
		task: "count-fish",
		kit: "sql",
		code: `SELECT COUNT(*) FROM notes WHERE LOWER(text) LIKE '%fish%'`,
	},

	{
		task: "counter",
		kit: "dom",
		code:
			`let n=0; const b=document.createElement("button"); b.textContent=n; b.onclick=()=>{n++; b.textContent=n; out(n)}; root.appendChild(b)`,
	},
	{
		task: "counter",
		kit: "html",
		code: `<button onclick="n++; this.textContent=n; out(n)">0</button><script>var n = 0</script>`,
	},
	{
		task: "counter",
		kit: "jsx",
		code:
			`import React, { useState } from "react"\nexport default function App(){ const [n,setN]=useState(0); return <button onClick={()=>{setN(n+1); out(n+1)}}>{n}</button> }`,
	},
	{
		task: "counter",
		kit: "reactive",
		code:
			`let state={n:0}\nfunction view(){ return \`<button onclick="inc()">\${state.n}</button>\` }\nfunction inc(){ state.n++; out(state.n) }`,
	},
	{
		task: "counter",
		kit: "ermine",
		code:
			`function program({open,read,edit,method,out}){ const n=open("n",0); method("inc",()=>{edit(n,v=>v+1); out(read(n))}); return ()=>\`<button onclick="send('inc')">\${read(n)}</button>\` }`,
	},

	{
		task: "todo",
		kit: "reactive",
		code: `let state = { text: "", items: [] }
function view() {
  return \`<input value="\${state.text}" oninput="setText(this.value)"><button onclick="add()">Add</button>
  <ul>\${state.items.map((t, i) => \`<li class="\${t.done ? "done" : ""}" onclick="toggle(\${i})">\${t.text}</li>\`).join("")}</ul>\`
}
function setText(v) { state.text = v }
function add() { state.items.push({ text: state.text, done: false }); state.text = "" }
function toggle(i) { state.items[i].done = !state.items[i].done }`,
	},
	{
		task: "todo",
		kit: "jsx",
		code: `function App() {
  const [text, setText] = useState("")
  const [items, setItems] = useState([])
  return <div>
    <input value={text} onInput={e => setText(e.target.value)} />
    <button onClick={() => { setItems([...items, { text, done: false }]); setText("") }}>Add</button>
    <ul>{items.map((t, i) => <li className={t.done ? "done" : ""} onClick={() => setItems(items.map((x, j) => j == i ? { ...x, done: !x.done } : x))}>{t.text}</li>)}</ul>
  </div>
}`,
	},
	{
		task: "todo",
		kit: "html",
		code: `<input id="t"><button onclick="add()">Add</button><ul id="list"></ul>
<script>
function add() {
  const li = document.createElement("li")
  li.textContent = document.getElementById("t").value
  li.onclick = () => li.classList.toggle("done")
  document.getElementById("list").appendChild(li)
  document.getElementById("t").value = ""
}
</script>`,
	},
	{
		task: "todo",
		kit: "dom",
		code: `const input = document.createElement("input"); const add = document.createElement("button"); add.textContent = "Add"
const ul = document.createElement("ul"); root.append(input, add, ul)
add.addEventListener("click", () => { const li = document.createElement("li"); li.textContent = input.value; li.addEventListener("click", () => li.classList.toggle("done")); ul.append(li); input.value = "" })`,
	},
	{
		task: "todo",
		kit: "ermine",
		code: `function program({ open, read, edit, method }) {
  const text = open("text", ""), items = open("items", [])
  method("type", v => edit(text, () => v))
  method("add", () => { edit(items, d => { d.push({ text: read(text), done: false }) }); edit(text, () => "") })
  method("toggle", i => edit(items, d => { d[i].done = !d[i].done }))
  return () => \`<input value="\${read(text)}" oninput="send('type', this.value)"><button onclick="send('add')">Add</button>
    <ul>\${read(items).map((t, i) => \`<li class="\${t.done ? "done" : ""}" onclick="send('toggle', \${i})">\${t.text}</li>\`).join("")}</ul>\`
}`,
	},
	{
		task: "price-table",
		kit: "reactive",
		code:
			`let state={}\nfunction view(){ return "<table><tr><th>Name</th><th>Price</th></tr>"+data.map(p=>\`<tr><td>\${p.name}</td><td>$\${p.price.toFixed(2)}</td></tr>\`).join("")+"</table>" }`,
	},
	{
		task: "filter",
		kit: "reactive",
		code:
			`let state={q:""}\nfunction view(){ return \`<input oninput="state.q=this.value"><ul>\${data.filter(f=>f.toLowerCase().includes(state.q.toLowerCase())).map(f=>\`<li>\${f}</li>\`).join("")}</ul>\` }`,
	},
	{
		task: "filter",
		kit: "html",
		code: `<input id="q" onkeyup="go()"><ul id="l"></ul><script>
function go(){ const q=document.getElementById("q").value.toLowerCase(); for (const li of document.querySelectorAll("#l li")) li.style.display = li.textContent.toLowerCase().includes(q) ? "" : "none" }
for (const f of data) { const li=document.createElement("li"); li.textContent=f; document.getElementById("l").appendChild(li) }
</script>`,
	},
	{
		task: "swatches",
		kit: "dom",
		code:
			`for (const c of data) { const d=document.createElement("div"); d.style.width="50px"; d.style.height="50px"; d.style.backgroundColor=c.hex; d.onclick=()=>out(c.name); root.appendChild(d) }`,
	},
	{
		task: "bar-chart",
		kit: "jsx",
		code:
			`const App = () => <div style={{display:"flex"}}>{data.map(b => <div><div style={{height: b.value*20+"px", width:"20px", background:"teal"}}></div><span>{b.label}</span></div>)}</div>`,
	},
	{
		task: "bar-chart",
		kit: "html",
		code:
			`<svg id="s" width="300" height="200"></svg><script>const max=Math.max(...data.map(d=>d.value)); data.forEach((d,i)=>{ document.getElementById("s").innerHTML += \`<rect x="\${i*40}" y="\${150-d.value/max*150}" width="30" height="\${d.value/max*150}"></rect><text x="\${i*40}" y="170">\${d.label}</text>\` })</script>`,
	},
	{
		task: "fish-tank",
		kit: "canvas",
		code: `ctx.fillStyle = "#1e90ff"; ctx.fillRect(0, 0, canvas.width, canvas.height)
for (const f of data.fish) {
  ctx.fillStyle = f.color
  ctx.beginPath(); ctx.ellipse(f.x, f.y, f.size / 2, f.size / 4, 0, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.moveTo(f.x - f.size / 2, f.y); ctx.lineTo(f.x - f.size, f.y - 10); ctx.lineTo(f.x - f.size, f.y + 10); ctx.fill()
}`,
	},
	{
		task: "fish-tank",
		kit: "dom",
		code: `const c=document.createElement("canvas"); c.width=400; c.height=300; root.appendChild(c); const g=c.getContext("2d")
function draw(){ g.fillStyle="blue"; g.fillRect(0,0,400,300); for(const f of data.fish){ g.save(); g.translate(f.x,f.y); g.fillStyle=f.color; g.beginPath(); g.ellipse(0,0,f.size/2,f.size/4,0,0,7); g.fill(); g.restore() } requestAnimationFrame(draw) }
draw()`,
	},
	{
		task: "canvas-chart",
		kit: "canvas",
		code: `const max = Math.max(...data.map(d => d.value))
data.forEach((d, i) => { const h = d.value / max * 200; ctx.fillStyle = "teal"; ctx.fillRect(20 + i * 60, 250 - h, 40, h); ctx.fillStyle = "black"; ctx.fillText(d.label, 20 + i * 60, 270) })`,
	},
	{
		task: "spend-chart",
		kit: "canvas",
		before: {
			kit: "sql",
			code: `SELECT category, SUM(amount) AS total FROM orders GROUP BY category ORDER BY total DESC`,
		},
		code:
			`data.forEach((d, i) => { ctx.fillRect(20 + i * 60, 250 - d.total * 4, 40, d.total * 4); ctx.fillText(d.category, 20 + i * 60, 270) })`,
	},
	{
		task: "spend-chart",
		kit: "reactive",
		code: `const t = {}; for (const o of data.orders) t[o.category] = (t[o.category] || 0) + o.amount
const rows = Object.entries(t).sort((a, b) => b[1] - a[1])
let state = {}
function view() { return rows.map(([c, v]) => \`<div><div style="height:\${v * 3}px;width:20px"></div>\${c}</div>\`).join("") }`,
	},
	{
		task: "unpaid-table",
		kit: "dom",
		before: {
			kit: "js",
			code: `function transform(d){ return d.orders.filter(o=>o.status!=="paid").sort((a,b)=>b.amount-a.amount) }`,
		},
		code:
			`const t=document.createElement("table"); let s=0; for(const o of data){ s+=o.amount; t.innerHTML+=\`<tr><td>\${o.customer}</td><td>\${o.amount}</td></tr>\` } t.innerHTML+=\`<tr><td>Total</td><td>\${s}</td></tr>\`; root.appendChild(t)`,
	},
	{
		task: "done-stats",
		kit: "html",
		before: {
			kit: "sql",
			code: `SELECT person, SUM(done) AS done, COUNT(*) AS total FROM todos GROUP BY person ORDER BY person`,
		},
		code:
			`<div id="o"></div><script>document.getElementById("o").innerHTML = data.map(r => \`<p>\${r.person}: \${r.done}/\${r.total} done</p>\`).join("")</script>`,
	},
]

// and wrong answers each checker must fail
const wrongs: Ref[] = [
	{ task: "sum-paid", kit: "js", code: `function transform(){ return 49.75 }` },
	{
		task: "counter",
		kit: "dom",
		code: `const b=document.createElement("button"); b.textContent="0"; root.appendChild(b)`,
	},
	{ task: "todo", kit: "html", code: `<input><button>Add</button><ul></ul>` },
	{
		task: "fish-tank",
		kit: "canvas",
		code: `ctx.fillStyle="blue"; ctx.fillRect(0,0,400,300); ctx.fillStyle="#ff7f50"; ctx.fillRect(80,90,10,10)`,
	},
	{ task: "filter", kit: "dom", code: `while(true){}` },
]

const sandbox = createSandbox(3)
const both = async (r: Ref) => {
	const t = taskById(r.task) as any
	const seen = await sandbox.run({ ...r, data: t.data, mode: "check" })
	const hidden = await sandbox.run({ ...r, data: t.hidden, mode: "check" })
	const pass = (o: typeof seen) => !!o.checks?.every((c) => c.ok || !c.required)
	return { seen, hidden, pass: pass(seen) && pass(hidden) }
}

Deno.test("right answers pass", async () => {
	const failed: string[] = []
	await Promise.all(refs.map(async (r) => {
		const { seen, hidden, pass } = await both(r)
		if (!pass) {
			failed.push(
				`${r.task}/${r.kit}: ${
					JSON.stringify({
						seen: [seen.checks, seen.errors],
						hidden: [hidden.checks, hidden.errors],
					})
				}`,
			)
		}
	}))
	assert(failed.length == 0, failed.join("\n"))
})

Deno.test("wrong answers fail", async () => {
	const passed: string[] = []
	await Promise.all(wrongs.map(async (r) => {
		if ((await both(r)).pass) passed.push(`${r.task}/${r.kit}`)
	}))
	sandbox.close()
	assert(passed.length == 0, passed.join("\n"))
})
