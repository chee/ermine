// Web.swift: WebKit as a device (irq 49). Each page is a real WKWebView in
// a hidden window of its own (borderless, off every screen, never key),
// steered by the web driver: web, webpost, webclose.
//
// frames: takeSnapshot into the driver's plane (two halves of maxw × maxh
// u32, as Capture.swift's), at most one a refresh while a layer shows it
// (webshow), only when changed, with the rectangle that differs; nothing
// more until webtook. 30 same frames in a row: looked at an eighth as
// often until it changes or gets input. _setWindowOcclusionDetectionEnabled:
// (private, asked only if answered) keeps the off-screen page drawing.
// input: webinput, the Mac's events given to the view.
// records back: title, URL, loading, progress, focus, window.ermine.post
// messages, open (a new window, window.open, cmd or middle click), cursor,
// state (interactionState, a second after it settles), list (back and
// forward; web's go may be a number), dom (a script in its own world sends
// what changed; webdo acts on an element).

import AppKit
import WebKit

/// The window a page draws in, off every screen. WebKit asks its window
/// whether it is key to say whether the page has the keyboard (the caret,
/// :focus); this says so while the OS gives the page the keyboard, and
/// never becomes key, so the monitor keeps the Mac's keys.
final class Host: NSWindow {
    var key = false
    override var isKeyWindow: Bool { key }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    /// where it is put, kept: a screen added or gone never pulls it on screen
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// A page's view. Its context menu is never opened: off every screen it would track unseen.
final class WebView: WKWebView {
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.cancelTrackingWithoutAnimation()
    }
}

/// One page: its view, its window, its plane and its frames.
@MainActor
final class Page {
    let id: String
    let view: WebView
    let host: Host
    var watching: [NSKeyValueObservation] = []
    /// its window moved by the Mac (onto a screen, as a Space or the presentation changes): put back
    var moved: NSObjectProtocol?
    var progress = -1
    // the plane: two halves of maxw × maxh
    var plane: UnsafeMutableRawPointer?
    var bytes = 0
    var maxw = 0, maxh = 0
    /// the size a layer shows it at, frame buffer pixels; 0: not shown
    var w = 0, h = 0
    /// frames: the count, the half the last is in (-1: none), its size, the one not yet taken
    var n = 0, half = -1, fw = 0, fh = 0, waiting = 0
    var busy = false
    /// frames the same as the last, in a row; ticks skipped since
    var same = 0, skipped = 0
    // input: buttons held, for drags; the last down, for double clicks; scroll under a whole point
    var buttons = Set<Int>()
    var click = (at: 0.0, x: 0.0, y: 0.0, button: -1, count: 0)
    var rest = (dx: 0.0, dy: 0.0)
    /// the state last said, and the wait before it is said again
    var said: String?
    var settle: Timer?
    /// its back and forward list as last said
    var listed: String?

    init(id: String, view: WebView, host: Host) {
        self.id = id
        self.view = view
        self.host = host
    }
}

@MainActor
final class Web: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let bus: Bus
    private var pages: [String: Page] = [:]
    private var ticker: Timer?
    /// points per frame buffer pixel
    var scale: CGFloat = 1

    init(bus: Bus) { self.bus = bus }

    /// The page's side of the bridge.
    private static let bridge = """
    window.ermine = {
      post: (data) => window.webkit.messageHandlers.ermine.postMessage(data),
      onmessage: null,
    };
    """

    /// The page's document, mirrored: in a world of its own, so the page's
    /// scripts neither see nor change it. Bounded as drv_mac's AX mirror is:
    /// depth, children an element, elements in all, text; cut where it
    /// stops, with how many it left. Sent again at most four times a second
    /// while the document changes, only what changed: drops first, then
    /// adds (a parent before its children) and sets. Also: the pointer's
    /// shape where it is, scrolling (for state), and a select's own menu
    /// kept shut (off every screen it would track unseen; its value is
    /// set through its node).
    private static let mirror = """
    (() => {
      if (window.top !== window || window.__ermineDom) return
      const post = (m) => { try { window.webkit.messageHandlers.ermineDom.postMessage(m) } catch (e) {} }
      const DEPTH = 24, ROWS = 200, TOTAL = 2000, TEXT = 200
      const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"])
      let next = 1, fresh = true, queued = false, last = 0, wait = 250
      const ids = new WeakMap(), nodes = new Map()
      const cut = (t) => (t.length > TEXT ? t.slice(0, TEXT) : t)
      const own = (el) => {
        let t = ""
        for (const c of el.childNodes) if (c.nodeType === 3) t += c.data
        return cut(t.replace(/\\s+/g, " ").trim())
      }
      const kidsOf = (el) => [...el.children].filter((c) => !SKIP.has(c.tagName))
      const valueOf = (el) => {
        const r = el.getBoundingClientRect()
        const v = { tag: el.tagName.toLowerCase(), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }
        const role = el.getAttribute("role")
        if (role) v.role = role
        const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title")
        if (label) v.label = cut(label)
        const text = own(el)
        if (text) v.text = text
        if (typeof el.href === "string" && el.href) v.href = el.href
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
          v.value = el.type === "password" ? "" : cut(String(el.value ?? ""))
          if (el.tagName === "INPUT") v.type = el.type
          if (el.checked === true) v.checked = true
          if (el.placeholder) v.placeholder = cut(el.placeholder)
        }
        return v
      }
      const flush = () => {
        queued = false
        last = Date.now()
        const root = document.documentElement
        if (!root) return
        const found = [], seen = new Set()
        let count = 0, cuts = 0
        const visit = (el, parent, depth, taken) => {
          let n = ids.get(el), k = n !== undefined ? nodes.get(n) : undefined
          if (k && k.parent !== parent) k = undefined
          const all = kidsOf(el)
          let kids = depth + 1 < DEPTH ? all : []
          const v = valueOf(el)
          count++
          if (!kids.length && all.length) (v.cut = "deep"), (v.more = all.length)
          else if (kids.length > ROWS) (v.cut = "rows"), (v.more = kids.length - ROWS), (kids = kids.slice(0, ROWS))
          if (kids.length > TOTAL - count) (v.cut = "budget"), (v.more = kids.length - Math.max(0, TOTAL - count)), (kids = kids.slice(0, Math.max(0, TOTAL - count)))
          if (v.cut) cuts++
          const tag = v.tag
          let name = k?.name
          if (!name) {
            let i = 1
            while (taken.has(tag + "-" + i)) i++
            name = tag + "-" + i
          }
          taken.add(name)
          const json = JSON.stringify(v)
          if (!k) {
            n = next++
            ids.set(el, n)
            nodes.set(n, { ref: new WeakRef(el), parent, name, json })
            found.push({ add: n, parent, name, value: v })
          } else if (k.json !== json) {
            k.json = json
            found.push({ set: n, value: v })
          }
          seen.add(n)
          const mine = new Set()
          for (const c of kids) {
            const cn = ids.get(c), ck = cn !== undefined ? nodes.get(cn) : undefined
            if (ck && ck.parent === n) mine.add(ck.name)
          }
          for (const c of kids) visit(c, n, depth + 1, mine)
        }
        visit(root, 0, 0, new Set())
        const drops = []
        for (const [n, k] of nodes) if (!seen.has(n)) {
          if (k.parent === 0 || seen.has(k.parent)) drops.push({ drop: n })
        }
        for (const [n] of nodes) if (!seen.has(n)) nodes.delete(n)
        const items = [...drops, ...found]
        if (items.length || fresh) post({ reset: fresh, items, count, cut: cuts })
        wait = !fresh && items.length > 100 ? 1000 : 250
        fresh = false
      }
      // again at most four times a second; a page that changes a lot at once (an animation, a feed) once a second, so its
      // mirror is not hundreds of changes a second kept in the graph
      const schedule = () => {
        if (queued) return
        queued = true
        setTimeout(flush, Math.max(0, wait - (Date.now() - last)))
      }
      new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
      addEventListener("DOMContentLoaded", schedule)
      addEventListener("load", schedule)
      addEventListener("resize", schedule)
      addEventListener("input", schedule, true)
      addEventListener("change", schedule, true)
      let shape = "", scrolled = 0
      addEventListener("mousemove", (e) => {
        const t = e.target instanceof Element ? e.target : null
        if (!t) return
        let c = getComputedStyle(t).cursor
        if (c === "auto") c = t.closest("a[href]") ? "pointer" : t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName) || own(t) ? "text" : "default"
        if (c !== shape) post({ cursor: (shape = c) })
      }, { capture: true, passive: true })
      addEventListener("scroll", () => {
        if (Date.now() - scrolled < 500) return
        scrolled = Date.now()
        post({ scroll: true })
      }, { capture: true, passive: true })
      addEventListener("mousedown", (e) => {
        const s = e.target instanceof Element ? e.target.closest("select") : null
        if (s) {
          e.preventDefault()
          s.focus()
        }
      }, true)
      window.__ermineDom = {
        act: (n, act, value) => {
          const el = nodes.get(n)?.ref.deref()
          if (!el || !el.isConnected) return "gone"
          if (act === "scroll") el.scrollIntoView({ block: "center" })
          else if (act === "focus") el.focus()
          else if (act === "click") {
            el.scrollIntoView({ block: "nearest" })
            el.click()
          } else if (act === "set") {
            el.focus()
            const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")
            if (d && d.set) d.set.call(el, String(value ?? ""))
            else el.value = String(value ?? "")
            el.dispatchEvent(new Event("input", { bubbles: true }))
            el.dispatchEvent(new Event("change", { bubbles: true }))
          } else if (act === "type") {
            el.focus()
            document.execCommand("insertText", false, String(value ?? ""))
          } else return "bad"
          schedule()
          return null
        },
      }
    })()
    """

    private func send(_ id: String, _ event: String, _ fields: Fields = []) {
        bus.send(49, [("event", event), ("id", id)] + fields)
    }

    /// A page it would open beside it: said, not opened; behind (cmd or a middle click) or in front.
    private func opened(_ webView: WKWebView, _ action: WKNavigationAction) {
        guard let id = webView.identifier?.rawValue, let url = action.request.url?.absoluteString, !url.isEmpty else { return }
        let behind = action.modifierFlags.contains(.command) || action.buttonNumber == 2
        send(id, "open", [("url", url), ("behind", behind)])
    }

    private func make(_ id: String) -> Page {
        if let p = pages[id] { return p }
        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: Web.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        content.add(self, name: "ermine")
        content.addUserScript(WKUserScript(source: Web.mirror, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        content.add(self, contentWorld: .defaultClient, name: "ermineDom")
        config.userContentController = content
        // an element full screen would be a window on the Mac's screen
        config.preferences.isElementFullscreenEnabled = false
        let v = WebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: config)
        v.identifier = NSUserInterfaceItemIdentifier(id)
        v.navigationDelegate = self
        v.uiDelegate = self
        v.allowsBackForwardNavigationGestures = true
        v.isHidden = true
        // drawn though its window is off every screen
        let visible = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if v.responds(to: visible) { v.perform(visible, with: false) }
        let host = Host(contentRect: NSRect(x: -32000, y: -32000, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        host.isReleasedWhenClosed = false
        host.collectionBehavior = [.transient, .ignoresCycle, .fullScreenNone]
        host.isExcludedFromWindowsMenu = true
        host.ignoresMouseEvents = true
        host.hasShadow = false
        host.animationBehavior = .none
        // never seen, wherever the Mac puts it: WebKit draws, and its timers run, in a window of alpha 0
        host.alphaValue = 0
        host.contentView = v
        // ordered in, so it draws; off every screen, so no one sees it
        host.orderFrontRegardless()
        let p = Page(id: id, view: v, host: host)
        pages[id] = p
        // the Mac moves windows itself as a full screen Space comes or goes, past constrainFrameRect
        p.moved = NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: host, queue: .main) { [weak host] _ in
            MainActor.assumeIsolated {
                guard let host, NSScreen.screens.contains(where: { $0.frame.intersects(host.frame) }) else { return }
                log("web view \(id): its window was moved on screen, to \(host.frame.origin); put back")
                host.setFrameOrigin(NSPoint(x: -32000, y: -32000))
            }
        }
        p.watching = [
            v.observe(\.title, options: [.new]) { [weak self] v, _ in
                MainActor.assumeIsolated { self?.send(id, "title", [("title", v.title ?? "")]) }
            },
            v.observe(\.url, options: [.new]) { [weak self] v, _ in
                MainActor.assumeIsolated {
                    self?.send(id, "url", [("url", v.url?.absoluteString ?? "")])
                    // pushState and replaceState change the list with no navigation
                    if let self, let p = self.pages[id] { self.listed(p) }
                }
            },
            v.observe(\.isLoading, options: [.new]) { [weak self] v, _ in
                MainActor.assumeIsolated {
                    self?.send(id, "loading", [("loading", v.isLoading), ("back", v.canGoBack), ("forward", v.canGoForward)])
                    if let self, let p = self.pages[id] { self.listed(p) }
                }
            },
            v.observe(\.estimatedProgress, options: [.new]) { [weak self] v, _ in
                MainActor.assumeIsolated {
                    guard let self, let p = self.pages[id] else { return }
                    // a record each tenth, not each tick
                    let tenth = Int(v.estimatedProgress * 10)
                    guard p.progress != tenth else { return }
                    p.progress = tenth
                    self.send(id, "progress", [("progress", Double(tenth) / 10)])
                }
            },
        ]
        log("web view \(id) made")
        return p
    }

    /// The plane file at path, mapped (and unlinked: both sides have it, so nothing is left after a crash).
    private func map(_ p: Page, path: String, maxw: Int, maxh: Int) {
        guard p.plane == nil, maxw > 0, maxh > 0 else { return }
        let fd = Darwin.open(path, O_RDWR | O_CLOEXEC)
        guard fd >= 0 else { return log("web \(p.id): no plane \(path)") }
        defer { Darwin.close(fd) }
        var st = stat()
        let want = 2 * maxw * maxh * 4
        guard fstat(fd, &st) == 0, Int(st.st_size) >= want, let m = mmap(nil, want, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), m != MAP_FAILED else {
            return log("web \(p.id): cannot map \(path)")
        }
        p.plane = m
        p.bytes = want
        p.maxw = maxw
        p.maxh = maxh
        Darwin.unlink(path)
    }

    /// web {id, path?, maxw?, maxh?, url?, html?, state?, go?, focus?}: makes the view if it is new, with its plane, then
    /// brings it back where state says, loads, goes, or gives it the keyboard or takes it back.
    func open(_ c: [String: Any]) {
        guard let id = c["id"] as? String else { return }
        let p = make(id)
        if let path = c["path"] as? String { map(p, path: path, maxw: int(c["maxw"]) ?? 0, maxh: int(c["maxh"]) ?? 0) }
        let url = (c["url"] as? String).flatMap { URL(string: $0) }
        if let state = c["state"] as? String, let data = Data(base64Encoded: state) {
            p.view.interactionState = data
            p.said = state
        }
        if let html = c["html"] as? String {
            p.view.loadHTMLString(html, baseURL: nil)
        } else if let url, c["state"] == nil || p.view.backForwardList.currentItem == nil {
            if url.isFileURL { p.view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) } else { p.view.load(URLRequest(url: url)) }
        }
        // a number: that far along its back and forward list, as the OS found it there (list)
        if let k = int(c["go"]) {
            if let item = p.view.backForwardList.item(at: k) { p.view.go(to: item) }
        }
        switch c["go"] as? String {
        case "back": p.view.goBack()
        case "forward": p.view.goForward()
        case "reload": p.view.reload()
        case "stop": p.view.stopLoading()
        default: break
        }
        if let on = bool(c["focus"]) { focus(p, on) }
    }

    /// The page has the keyboard, or not: its window says it is key, and the view is its first responder.
    private func focus(_ p: Page, _ on: Bool) {
        guard p.host.key != on else { return }
        p.host.key = on
        if on { p.host.makeFirstResponder(p.view) }
        NotificationCenter.default.post(name: on ? NSWindow.didBecomeKeyNotification : NSWindow.didResignKeyNotification, object: p.host)
        send(p.id, "focus", [("on", on)])
    }

    /// webpost {id, data}: hands data to the page's window.ermine.onmessage.
    func post(id: String, data: Any?) {
        guard let p = pages[id] else { return }
        p.view.evaluateJavaScript("window.ermine && window.ermine.onmessage && window.ermine.onmessage(\(json(data)))", completionHandler: nil)
    }

    func close(id: String) {
        guard let p = pages.removeValue(forKey: id) else { return }
        p.watching.removeAll()
        if let m = p.moved { NotificationCenter.default.removeObserver(m) }
        p.settle?.invalidate()
        let content = p.view.configuration.userContentController
        content.removeScriptMessageHandler(forName: "ermine")
        content.removeScriptMessageHandler(forName: "ermineDom", contentWorld: .defaultClient)
        p.view.stopLoading()
        p.host.orderOut(nil)
        p.host.contentView = nil
        p.host.close()
        if let plane = p.plane { munmap(plane, p.bytes) }
        p.plane = nil
        tick()
        log("web view \(id) closed")
    }

    func closeAll() {
        for id in Array(pages.keys) { close(id: id) }
    }

    // MARK: frames

    /// webshow {id, w, h}: a layer shows it that big (frame buffer pixels), or none does (w 0): then it draws nothing.
    func show(id: String, w: Int, h: Int) {
        guard let p = pages[id] else { return }
        let on = w > 0 && h > 0
        if on && (w != p.w || h != p.h) {
            p.host.setContentSize(NSSize(width: CGFloat(w) * scale, height: CGFloat(h) * scale))
            p.view.frame = NSRect(origin: .zero, size: p.host.contentRect(forFrameRect: p.host.frame).size)
        }
        p.w = on ? w : 0
        p.h = on ? h : 0
        p.view.isHidden = !on
        p.same = 0
        tick()
    }

    /// webtook {id, n}: frame n is shown, so the other half is free.
    func took(id: String, n: Int) {
        guard let p = pages[id], p.waiting == n else { return }
        p.waiting = 0
    }

    /// A refresh's ticks while a page is shown; none while none is.
    private func tick() {
        let any = pages.values.contains { $0.w > 0 }
        if any && ticker == nil {
            let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.frames() }
            }
            RunLoop.main.add(t, forMode: .common)
            ticker = t
        } else if !any {
            ticker?.invalidate()
            ticker = nil
        }
    }

    private func frames() {
        for p in pages.values where p.w > 0 && p.plane != nil && p.waiting == 0 && !p.busy {
            // a page that has looked the same a while: looked at an eighth as often
            if p.same >= 30 {
                p.skipped += 1
                if p.skipped % 8 != 0 { continue }
            }
            p.busy = true
            let cfg = WKSnapshotConfiguration()
            cfg.afterScreenUpdates = false
            p.view.takeSnapshot(with: cfg) { [weak self] image, _ in
                MainActor.assumeIsolated { self?.drawn(p, image) }
            }
        }
    }

    /// A snapshot into the half not shown; said as a frame if it differs from the last, with what differs.
    private func drawn(_ p: Page, _ image: NSImage?) {
        p.busy = false
        guard pages[p.id] === p, p.w > 0, p.waiting == 0, let plane = p.plane,
              let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        let w = min(p.w, p.maxw), h = min(p.h, p.maxh), stride = p.maxw * 4
        let half = p.half == 0 ? 1 : 0
        let next = plane + half * p.maxw * p.maxh * 4
        // opaque, as a browser shows a page: white under it, so what the page leaves clear is white, never
        // what was in the half before nor the windows under this one; every pixel's alpha written, 0xFF
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        guard let ctx = CGContext(data: next, width: w, height: h, bitsPerComponent: 8, bytesPerRow: stride,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info) else { return }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.interpolationQuality = .medium
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var dirty: (x: Int, y: Int, w: Int, h: Int)?
        if p.half >= 0, p.fw == w, p.fh == h {
            // what differs from the last frame, in the other half
            let was = plane + p.half * p.maxw * p.maxh * 4
            var y0 = -1, y1 = -1, x0 = w, x1 = 0
            for y in 0..<h {
                let a = (was + y * stride).assumingMemoryBound(to: UInt32.self), b = (next + y * stride).assumingMemoryBound(to: UInt32.self)
                if memcmp(a, b, w * 4) == 0 { continue }
                if y0 < 0 { y0 = y }
                y1 = y
                var l = 0, r = w - 1
                while a[l] == b[l] { l += 1 }
                while a[r] == b[r] { r -= 1 }
                x0 = min(x0, l)
                x1 = max(x1, r + 1)
            }
            guard y0 >= 0 else {
                p.same += 1
                return
            }
            dirty = (x0, y0, x1 - x0, y1 - y0 + 1)
        }
        p.same = 0
        p.skipped = 0
        p.n += 1
        p.half = half
        p.fw = w
        p.fh = h
        p.waiting = p.n
        var fields: Fields = [("n", p.n), ("half", half), ("w", w), ("h", h)]
        if let d = dirty { fields.append(("dirty", [("x", d.x), ("y", d.y), ("w", d.w), ("h", d.h)] as Fields)) }
        send(p.id, "frame", fields)
    }

    // MARK: input

    /// The characters AppKit gives keys that type none: arrows, function keys and the rest.
    private static let special: [String: String] = [
        "Enter": "\r", "Tab": "\t", "Backspace": "\u{7f}", "Escape": "\u{1b}", "Space": " ", "Delete": "\u{F728}",
        "ArrowUp": "\u{F700}", "ArrowDown": "\u{F701}", "ArrowLeft": "\u{F702}", "ArrowRight": "\u{F703}",
        "Home": "\u{F729}", "End": "\u{F72B}", "PageUp": "\u{F72C}", "PageDown": "\u{F72D}", "Help": "\u{F746}",
        "F1": "\u{F704}", "F2": "\u{F705}", "F3": "\u{F706}", "F4": "\u{F707}", "F5": "\u{F708}", "F6": "\u{F709}",
        "F7": "\u{F70A}", "F8": "\u{F70B}", "F9": "\u{F70C}", "F10": "\u{F70D}", "F11": "\u{F70E}", "F12": "\u{F70F}",
    ]

    private func flags(_ mods: Any?) -> NSEvent.ModifierFlags {
        var f: NSEvent.ModifierFlags = []
        for m in mods as? [Any] ?? [] {
            switch m as? String {
            case "shift": f.insert(.shift)
            case "ctrl": f.insert(.control)
            case "alt": f.insert(.option)
            case "cmd": f.insert(.command)
            case "caps": f.insert(.capsLock)
            case "fn": f.insert(.function)
            default: break
            }
        }
        return f
    }

    /// webinput {id, events}: irq 34 and 35 records, x and y in the page's
    /// frame buffer pixels, given to the view as the Mac's events. A right
    /// click is not: its menu would track unseen.
    func input(id: String, events: [[String: Any]]) {
        guard let p = pages[id] else { return }
        p.same = 0
        let now = ProcessInfo.processInfo.systemUptime, number = p.host.windowNumber
        for e in events {
            let mods = flags(e["mods"])
            switch e["event"] as? String {
            case "key":
                let key = e["key"] as? String ?? "", text = e["text"] as? String ?? "", down = bool(e["down"]) ?? true
                // a modifier alone changes only the flags the next key carries
                if ["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"].contains(key) { continue }
                let chars = text.isEmpty ? Web.special[key] ?? (key.count == 1 ? key : "") : text
                let bare = Web.special[key] ?? (key.count == 1 ? key : chars)
                guard let ev = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: mods, timestamp: now, windowNumber: number,
                                                context: nil, characters: chars, charactersIgnoringModifiers: bare, isARepeat: bool(e["repeat"]) ?? false,
                                                keyCode: UInt16(clamping: int(e["code"]) ?? 0)) else { continue }
                // cmd with c, v, x, a, z: the edit menu's actions, which the monitor's menu would send to a web view in it
                let edits: [String: String] = ["c": "copy:", "v": "paste:", "x": "cut:", "a": "selectAll:", "z": mods.contains(.shift) ? "redo:" : "undo:"]
                if down, mods.subtracting([.shift, .capsLock, .function]) == .command, let action = edits[key],
                   NSApp.sendAction(Selector(action), to: p.view, from: nil) {
                    continue
                }
                if !down {
                    p.view.keyUp(with: ev)
                } else if !(mods.contains(.command) && p.view.performKeyEquivalent(with: ev)) {
                    p.view.keyDown(with: ev)
                }
            case "commit":
                // press and hold: the letter it replaces taken back first
                if let r = e["replace"] as? [Any], r.count == 2, let from = int(r[0]), let to = int(r[1]), to > from {
                    for _ in 0..<min(to - from, 64) {
                        for down in [true, false] {
                            if let ev = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: [], timestamp: now, windowNumber: number,
                                                         context: nil, characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 0x33) {
                                down ? p.view.keyDown(with: ev) : p.view.keyUp(with: ev)
                            }
                        }
                    }
                }
                (p.view as AnyObject).insertText?(e["text"] as? String ?? "", replacementRange: NSRange(location: NSNotFound, length: 0))
            case "compose":
                let text = e["text"] as? String ?? ""
                let sel = (e["selected"] as? [Any]).flatMap { r -> NSRange? in
                    guard r.count == 2, let a = int(r[0]), let b = int(r[1]) else { return nil }
                    return NSRange(location: a, length: max(0, b - a))
                } ?? NSRange(location: (text as NSString).length, length: 0)
                (p.view as AnyObject).setMarkedText?(text, selectedRange: sel, replacementRange: NSRange(location: NSNotFound, length: 0))
            case let kind?:
                guard ["move", "down", "up", "scroll"].contains(kind) else { continue }
                let at = NSPoint(x: (double(e["x"]) ?? 0) * scale, y: p.view.bounds.height - (double(e["y"]) ?? 0) * scale)
                let button = int(e["button"]) ?? 0
                if button == 1 && (kind == "down" || kind == "up") { continue }
                switch kind {
                case "scroll":
                    // ermine's dy is frame buffer pixels, positive scrolling the content down; a wheel's is
                    // points, positive scrolling up. What is under a whole point is kept for the next.
                    let dy = -(double(e["dy"]) ?? 0) * scale + p.rest.dy, dx = -(double(e["dx"]) ?? 0) * scale + p.rest.dx
                    let wy = dy.rounded(.towardZero), wx = dx.rounded(.towardZero)
                    p.rest = (dx - wx, dy - wy)
                    guard wy != 0 || wx != 0,
                          let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(clamping: Int(wy)), wheel2: Int32(clamping: Int(wx)), wheel3: 0)
                    else { continue }
                    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    // where the point would be on the screens, for the event's place in its window
                    let g = p.host.convertPoint(toScreen: at), top = NSScreen.screens.first?.frame.maxY ?? 0
                    cg.location = CGPoint(x: g.x, y: top - g.y)
                    cg.flags = CGEventFlags(rawValue: UInt64(mods.rawValue))
                    if let under = CGEventField(rawValue: 91), let takes = CGEventField(rawValue: 92) {
                        cg.setIntegerValueField(under, value: Int64(number))
                        cg.setIntegerValueField(takes, value: Int64(number))
                    }
                    if let ev = NSEvent(cgEvent: cg) { p.view.scrollWheel(with: ev) }
                case "down", "up":
                    let down = kind == "down"
                    if down { p.buttons.insert(button) } else { p.buttons.remove(button) }
                    // a second down soon after and near the last: a double click, a third a triple
                    if down {
                        let near = abs(at.x - p.click.x) <= 4 && abs(at.y - p.click.y) <= 4
                        let count = near && button == p.click.button && now - p.click.at <= NSEvent.doubleClickInterval ? p.click.count + 1 : 1
                        p.click = (now, at.x, at.y, button, count)
                    }
                    let type: NSEvent.EventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
                    guard let ev = NSEvent.mouseEvent(with: type, location: at, modifierFlags: mods, timestamp: now, windowNumber: number, context: nil,
                                                      eventNumber: 0, clickCount: max(1, p.click.count), pressure: down ? 1 : 0) else { continue }
                    switch type {
                    case .leftMouseDown: p.view.mouseDown(with: ev)
                    case .leftMouseUp: p.view.mouseUp(with: ev)
                    case .otherMouseDown: p.view.otherMouseDown(with: ev)
                    default: p.view.otherMouseUp(with: ev)
                    }
                default:
                    let held = p.buttons.subtracting([1]).min()
                    let type: NSEvent.EventType = held == nil ? .mouseMoved : held == 0 ? .leftMouseDragged : .otherMouseDragged
                    guard let ev = NSEvent.mouseEvent(with: type, location: at, modifierFlags: mods, timestamp: now, windowNumber: number, context: nil,
                                                      eventNumber: 0, clickCount: held == nil ? 0 : max(1, p.click.count), pressure: held == nil ? 0 : 1) else { continue }
                    switch type {
                    case .mouseMoved:
                        // WebKit takes a move only through its tracking area, from that area's owner
                        let move = #selector(NSResponder.mouseMoved(with:))
                        if let owner = p.view.trackingAreas.lazy.compactMap({ $0.owner as? NSObject }).first(where: { $0.responds(to: move) }) {
                            owner.perform(move, with: ev)
                        }
                    case .leftMouseDragged: p.view.mouseDragged(with: ev)
                    default: p.view.otherMouseDragged(with: ev)
                    }
                }
            default:
                continue
            }
        }
    }

    /// webdo {id, req, n, act, value?}: an act on element n of the page's document, then done.
    func act(id: String, req: Int, n: Int, act: String, value: Any?) {
        guard let p = pages[id] else { return send(id, "done", [("req", req), ("error", "gone")]) }
        p.same = 0
        let call = "window.__ermineDom ? window.__ermineDom.act(\(n), \(json(act)), \(json(value))) : 'gone'"
        p.view.evaluateJavaScript(call, in: nil, in: .defaultClient) { [weak self] result in
            MainActor.assumeIsolated {
                var error: String? = nil
                switch result {
                case .success(let v): error = v as? String
                case .failure: error = "gone"
                }
                self?.send(id, "done", [("req", req), ("error", error)])
            }
        }
    }

    // MARK: state

    /// Its back and forward list: every item's URL, at most 50 each way, and where the current one is;
    /// said when it changed, so the OS can tell going back or on (the same URLs, another at) from a new page.
    func listed(_ p: Page) {
        let l = p.view.backForwardList
        guard let current = l.currentItem else { return }
        let back = l.backList.suffix(50), forward = l.forwardList.prefix(50)
        let urls = back.map { $0.url.absoluteString } + [current.url.absoluteString] + forward.map { $0.url.absoluteString }
        let key = "\(back.count) " + urls.joined(separator: "\n")
        guard key != p.listed else { return }
        p.listed = key
        send(p.id, "list", [("urls", urls), ("at", back.count)])
    }

    /// Its history and scroll, a second after they settle: said when they changed.
    private func settle(_ p: Page) {
        p.settle?.invalidate()
        let t = Timer(timeInterval: 1, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.pages[p.id] === p, let data = p.view.interactionState as? Data else { return }
                // a large one (a long history with forms) is not kept
                guard data.count <= 256 * 1024 else { return }
                let state = data.base64EncodedString()
                guard state != p.said else { return }
                p.said = state
                self.send(p.id, "state", [("state", state)])
            }
        }
        RunLoop.main.add(t, forMode: .common)
        p.settle = t
    }

    // MARK: WebKit's delegates

    nonisolated func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let v = message.webView, let id = v.identifier?.rawValue, let p = pages[id] else { return }
            if message.name == "ermine" {
                let body: Any? = JSONSerialization.isValidJSONObject([message.body]) ? message.body : String(describing: message.body)
                return send(id, "message", [("body", body)])
            }
            // the mirror's
            guard let m = message.body as? [String: Any] else { return }
            if let shape = m["cursor"] as? String { send(id, "cursor", [("cursor", shape)]) }
            if m["scroll"] != nil { settle(p) }
            if let items = m["items"] {
                send(id, "dom", [("reset", bool(m["reset"]) ?? false), ("items", items), ("count", m["count"]), ("cut", m["cut"])])
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            guard let id = webView.identifier?.rawValue, let p = pages[id] else { return }
            listed(p)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            guard let id = webView.identifier?.rawValue, let p = pages[id] else { return }
            listed(p)
            settle(p)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { failed(webView, error) }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { failed(webView, error) }
    }

    private func failed(_ webView: WKWebView, _ error: Error) {
        guard let id = webView.identifier?.rawValue else { return }
        let e = error as NSError
        if e.code == NSURLErrorCancelled { return }
        send(id, "error", [("error", e.localizedDescription)])
    }

    /// A link to a new window, or window.open: the OS is told (open), and no window is made.
    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        MainActor.assumeIsolated { opened(webView, navigationAction) }
        return nil
    }

    /// A link cmd-clicked or middle-clicked in the page: the OS is told (open), and this page stays.
    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            let beside = navigationAction.navigationType == .linkActivated && navigationAction.targetFrame != nil
                && (navigationAction.modifierFlags.contains(.command) || navigationAction.buttonNumber == 2)
            if beside { opened(webView, navigationAction) }
            decisionHandler(beside ? .cancel : .allow)
        }
    }
}
