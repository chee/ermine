// /programs/menu: the world menu, as Squeak's is, opened by wmiirc on a
// click on the root or the menu bar's rabbit. A layer of its own at x, y (none: the middle of the
// screen), above everything; a click on an item does it, and the menu ends. Any click elsewhere ends
// it too: it reads /dev/wm/event, so it hears every click the wm sees.
//
// Its items are /etc/menu, a document, [{label, run, key?} | "-"]: run a command as /etc/keys
// has them (a program and its words, or an address), which wmiirc runs (ctl run); the chord
// shown beside one is the one /etc/keys binds to the same command, else its key. The Mac's
// menu bar shows the same items (/dev/display/menus).
export default ({ api, effect, handler, self, name, cwd, data, readline }) => {
  // this process's own node: the menu's owner, whose on/pointer the window manager calls
  const here = ["/", ...cwd, name]
  const blit = api.read({ address: ["/", "hw", "devices", "blitter", "port"] })[0].value
  const WM = ["/", "dev", "wm"]
  // the items, and beside each the chord /etc/keys binds to its command
  const bound = {}
  const keys = api.read({ address: ["/", "etc", "keys"] })[0]?.value
  if (keys && typeof keys === "object") for (const [k, c] of Object.entries(keys)) if (typeof c === "string" && !(c.trim() in bound)) bound[c.trim()] = readline.normal(k)
  const listed = api.read({ address: ["/", "etc", "menu"] })[0]?.value
  const ITEMS = (Array.isArray(listed) ? listed : []).flatMap((it) => {
    if (it === "-") return [["-", "", null]]
    if (typeof it?.label !== "string" || typeof it.run !== "string") return []
    return [[it.label, bound[it.run.trim()] ?? it.key ?? "", it.run]]
  })
  // what an item runs, wmiirc runs: the window manager's ctl, run <command>, a Run event
  const run = (api, command) => {
    const ctl = api.read({ address: [...WM, "ctl"] })[0]?.value
    if (Array.isArray(ctl)) api.call({ address: ctl, args: [`run ${command}`] })
  }
  const u = api.read({ address: ["/", "dev", "display", "mode"] })[0]?.value?.unit ?? 1
  const LAYER = ["/", "dev", "display", "layers", `menu-${self}`]
  const mode = api.read({ address: ["/", "dev", "display", "mode"] })[0]?.value ?? { w: 1280, h: 800 }
  // System 7's menu, in its Chicago: /dev/font/title, or the font ROM until it comes
  const FONT = ["/", "dev", "font", "title"]
  const F0 = api.read({ address: FONT })[0]?.value ?? undefined
  // a line between items is a row of its own, shorter
  const ROW = blit.height(F0) + 6 * u, SEP = 8 * u, W = 300 * u, S = 2 * u
  const tops = []
  let H = 4 * u
  for (const [label] of ITEMS) {
    tops.push(H)
    H += label === "-" ? SEP : ROW
  }
  H += 4 * u
  const at = data[0]?.value ?? {}
  const x = Math.max(0, Math.min(mode.w - W, Number.isFinite(at.x) ? at.x : Math.floor((mode.w - W) / 2)))
  const y = Math.max(0, Math.min(mode.h - H, Number.isFinite(at.y) ? at.y : Math.floor(mode.h / 3)))
  // paper, a hard black frame, a drop shadow
  const T = { paper: 0xfdf8ea, ink: 0x2a2228, ink3: 0xa89aa2, line: 0x1c1a17, ...(api.read({ address: ["/", "etc", "theme"] })[0]?.value ?? {}) }
  const draw = (F) => {
    const f = blit.list(W + S, H + S)
    blit.fill(f, S, S, W, H, T.line)
    blit.fill(f, 0, 0, W, H, T.paper)
    for (let i = 0; i < u; i++) blit.frame(f, i, i, W - 2 * i, H - 2 * i, T.line)
    ITEMS.forEach(([label, key], i) => {
      if (label === "-") return blit.fill(f, u, tops[i] + Math.floor(SEP / 2), W - 2 * u, u, T.ink3)
      const ty = tops[i] + 3 * u
      blit.text(f, 12 * u, ty, label, T.ink, undefined, undefined, F)
      if (key) blit.text(f, W - 12 * u - blit.measure(key, F), ty, key, T.ink3, undefined, undefined, F)
    })
    return f.ops
  }
  // to VoiceOver, a menu of items; pressing one is a click on it
  const access = [{
    role: "menu", label: "world menu", x: 0, y: 0, w: W, h: H,
    children: ITEMS.flatMap(([label, key], i) => (label === "-" ? [] : [{ role: "menuitem", label: key ? `${label}, ${key}` : label, x: u, y: tops[i], w: W - 2 * u, h: ROW }])),
  }]
  api.place({ address: LAYER.slice(0, -1), name: LAYER.at(-1), value: { x, y, w: W + S, h: H + S, z: 200000, owner: here, draw: draw(F0), access, over: true }, ephemeral: true })
  // drawn again when a page of the font comes
  effect("draw", ({ api }) => api.read({ address: FONT })[0]?.value ?? null, (F, { api }) => {
    if (F && F !== F0 && api.read({ address: LAYER }).length) api.write({ address: LAYER, patches: [{ type: "set", path: [], key: "draw", value: draw(F) }] })
  })

  const end = (api) => {
    api.unplace({ address: [], name, id: self })
  }
  handler("pointer", ({ api }, recs) => {
    const r = recs.find((r) => r.event === "down")
    if (!r) return
    const i = tops.findIndex((t, k) => r.y >= t && r.y < (tops[k + 1] ?? H - 4 * u))
    const item = ITEMS[i]
    if (item?.[2]) {
      try {
        run(api, item[2])
      } catch {
        // no window manager to run it
      }
    }
    end(api)
  })
  // any other click, anywhere the wm hears one, ends it
  const opened = api.read({ address: [...WM, "event"] })[0]?.value?.n ?? 0
  effect("elsewhere", ({ api }) => {
    const ev = api.read({ address: [...WM, "event"] })[0]?.value ?? { events: [] }
    return ev.events.some((e) => e.n > opened && ["ClientClick", "RootClick", "LeftBarClick", "RightBarClick", "MenuBarClick", "TaskBarClick", "FocusTag"].includes(e.type))
  }, (clicked, { api }) => {
    if (clicked) end(api)
  })
}
