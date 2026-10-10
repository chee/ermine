// /programs/menu: the world menu, as Squeak's is, opened by wmiirc on a
// click on the root. A layer of its own at x, y, above everything; a click
// on an item does it, and the menu ends. Any click elsewhere ends it too: it
// reads /dev/wm/event, so it hears every click the wm sees.
export default ({ api, effect, handler, self, name, cwd, data }) => {
  // this process's own node: the menu's owner, whose on/pointer the window manager calls
  const here = ["/", ...cwd, name]
  const blit = api.read({ address: ["/", "hw", "devices", "blitter", "port"] })[0].value
  const WM = ["/", "dev", "wm"]
  const snap = (value) => [{ type: "snapshot", value }]
  // started by the window manager's policy, so what starts outlives this menu
  const start = (api, folder, program, d) => {
    const op = { address: ["/", "apps", folder], program, ...(d ? { data: d } : {}) }
    const launch = api.read({ address: ["/", "dev", "wm", "launch"] })[0]?.value
    return Array.isArray(launch) ? api.call({ address: launch, args: [op] }) : api.start(op)
  }
  const ITEMS = [
    ["My Computer", "alt-f", (api) => start(api, "computer", "programs/computer")],
    ["a shell", "alt-enter", (api) => start(api, "term", "programs/term")],
    ["a browser", "alt-b", (api) => start(api, "browser", "programs/browser")],
    ["the graph", "alt-g", (api) => start(api, "graph", "programs/graph")],
    ["a workspace", "alt-e", (api) => start(api, "edit", "programs/edit", { path: ["apps", "workspace", "text"] })],
    ["the window manager's policy", "", (api) => start(api, "edit", "programs/edit", { path: ["programs", "wmiirc"] })],
    ["the cat clock", "", (api) => start(api, "catclock", "programs/catclock")],
    ["Mac windows", "ctrl-cmd-w", (api) => api.write({ address: ["/", "dev", "display", "want"], patches: snap({ windows: true }) })],
    ["power off", "", (api) => api.write({ address: ["/", "dev", "power", "switch"], patches: snap({ off: true }) })],
  ]
  const u = api.read({ address: ["/", "dev", "display", "mode"] })[0]?.value?.unit ?? 1
  const LAYER = ["/", "dev", "display", "layers", `menu-${self}`]
  const mode = api.read({ address: ["/", "dev", "display", "mode"] })[0]?.value ?? { w: 1280, h: 800 }
  // System 7's menu, in its Chicago: /dev/font/title, or the font ROM until it comes
  const FONT = ["/", "dev", "font", "title"]
  const F0 = api.read({ address: FONT })[0]?.value ?? undefined
  const ROW = blit.height(F0) + 6 * u, W = 300 * u, H = ITEMS.length * ROW + 8 * u, S = 2 * u
  const x = Math.max(0, Math.min(mode.w - W, data[0]?.value?.x ?? 100))
  const y = Math.max(0, Math.min(mode.h - H, data[0]?.value?.y ?? 100))
  // paper, a hard black frame, a drop shadow
  const T = { paper: 0xfdf8ea, ink: 0x2a2228, ink3: 0xa89aa2, line: 0x1c1a17, ...(api.read({ address: ["/", "etc", "theme"] })[0]?.value ?? {}) }
  const draw = (F) => {
    const f = blit.list(W + S, H + S)
    blit.fill(f, S, S, W, H, T.line)
    blit.fill(f, 0, 0, W, H, T.paper)
    for (let i = 0; i < u; i++) blit.frame(f, i, i, W - 2 * i, H - 2 * i, T.line)
    ITEMS.forEach(([label, key], i) => {
      const ty = 4 * u + i * ROW + 3 * u
      if (label === "power off") blit.fill(f, u, ty - 4 * u, W - 2 * u, u, T.ink3)
      blit.text(f, 12 * u, ty, label, T.ink, undefined, undefined, F)
      if (key) blit.text(f, W - 12 * u - blit.measure(key, F), ty, key, T.ink3, undefined, undefined, F)
    })
    return f.ops
  }
  // to VoiceOver, a menu of items; pressing one is a click on it
  const access = [{
    role: "menu", label: "world menu", x: 0, y: 0, w: W, h: H,
    children: ITEMS.map(([label, key], i) => ({ role: "menuitem", label: key ? `${label}, ${key}` : label, x: u, y: 4 * u + i * ROW, w: W - 2 * u, h: ROW })),
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
    const item = ITEMS[Math.floor((r.y - 4 * u) / ROW)]
    if (item) item[2](api)
    end(api)
  })
  // any other click, anywhere the wm hears one, ends it
  const opened = api.read({ address: [...WM, "event"] })[0]?.value?.n ?? 0
  effect("elsewhere", ({ api }) => {
    const ev = api.read({ address: [...WM, "event"] })[0]?.value ?? { events: [] }
    return ev.events.some((e) => e.n > opened && ["ClientClick", "RootClick", "LeftBarClick", "RightBarClick", "FocusTag"].includes(e.type))
  }, (clicked, { api }) => {
    if (clicked) end(api)
  })
}
