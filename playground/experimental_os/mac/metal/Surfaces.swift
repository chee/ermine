// Surfaces.swift: windows mode. Each of the OS's windows is a Mac window of
// its own, among the person's others: the Mac's window server places it and
// says which is in front, and the OS draws its content. Positions are in the
// Mac's desktop, in frame buffer pixels from the top left of the main
// screen (../METAL.md, Windows mode).

import AppKit
import IOSurface
import QuartzCore

@MainActor
final class Surfaces: NSObject, NSWindowDelegate {
    private let bus: Bus
    private let keyboard: Keyboard
    let scale: CGFloat
    private var byId: [String: SurfaceWindow] = [:]
    /// set while the metal moves a window itself, so the move is not reported back
    private var placing = false
    private var lastKey: String?? = .none
    /// the OS's text input and accessibility tree, for each surface's view
    var textInput: TextInput?
    var access: Access?

    init(bus: Bus, keyboard: Keyboard, scale: Double) {
        self.bus = bus
        self.keyboard = keyboard
        self.scale = CGFloat(scale)
    }

    func owns(_ window: NSWindow) -> Bool {
        guard let w = window as? SurfaceWindow else { return false }
        return byId[w.id] === w
    }

    /// The top of the main screen, the one with the menu bar, in Cocoa's
    /// screen coordinates, which go up from its bottom left.
    private var top: CGFloat { NSScreen.screens.first?.frame.maxY ?? 0 }

    /// A content rectangle in Cocoa's coordinates from one in the desktop's.
    private func cocoa(x: Int, y: Int, w: Int, h: Int) -> NSRect {
        NSRect(x: CGFloat(x) * scale, y: top - CGFloat(y + h) * scale, width: CGFloat(w) * scale, height: CGFloat(h) * scale)
    }

    /// A point in the desktop's frame buffer pixels from one in Cocoa's screen coordinates.
    func desktop(_ p: NSPoint) -> (Int, Int) {
        (Int((p.x / scale).rounded(.down)), Int(((top - p.y) / scale).rounded(.down)))
    }

    func update(id: String, x: Int, y: Int, w: Int, h: Int, title: String, key: Bool) {
        let rect = cocoa(x: x, y: y, w: w, h: h)
        let win: SurfaceWindow
        if let existing = byId[id] {
            win = existing
            let frame = win.frameRect(forContentRect: rect)
            if win.frame != frame {
                placing = true
                win.setFrame(frame, display: true)
                placing = false
            }
            (win.contentView as? SurfaceView)?.resize(w: w, h: h)
        } else {
            win = SurfaceWindow(id: id, contentRect: rect)
            let view = SurfaceView(frame: NSRect(origin: .zero, size: rect.size), bus: bus, keyboard: keyboard, surfaces: self, id: id)
            view.textInput = textInput
            view.access = access
            view.resize(w: w, h: h)
            win.contentView = view
            win.delegate = self
            win.makeFirstResponder(view)
            byId[id] = win
            placing = true
            win.setFrame(win.frameRect(forContentRect: rect), display: false)
            placing = false
            win.orderFront(nil)
            log("surface \(id): \(w)x\(h) at \(x),\(y)")
        }
        if win.title != title { win.title = title }
        if key {
            NSApp.activate(ignoringOtherApps: true)
            win.makeKeyAndOrderFront(nil)
        }
    }

    /// The view a surface's content is in.
    func content(_ id: String) -> NSView? { byId[id]?.contentView }

    /// The view that shows a surface's pixels.
    func view(_ id: String) -> SurfaceView? { byId[id]?.contentView as? SurfaceView }

    /// Shows a surface's pixels from the next refresh: an IOSurface (Pane).
    func present(id: String, image: AnyObject) {
        (byId[id]?.contentView as? SurfaceView)?.show(image)
    }

    func remove(id: String) {
        guard let win = byId.removeValue(forKey: id) else { return }
        win.delegate = nil
        win.orderOut(nil)
        log("surface \(id) closed")
    }

    func removeAll() {
        for id in Array(byId.keys) { remove(id: id) }
    }

    private func report(key id: String?) {
        if case .some(let last) = lastKey, last == id { return }
        lastKey = .some(id)
        bus.send(33, [("event", "key"), ("id", id)])
    }

    // MARK: the person, among the windows

    func windowDidMove(_ notification: Notification) {
        guard !placing, let win = notification.object as? SurfaceWindow, byId[win.id] === win else { return }
        let content = win.contentRect(forFrameRect: win.frame)
        let (x, _) = desktop(NSPoint(x: content.minX, y: content.maxY))
        let y = Int(((top - content.maxY) / scale).rounded())
        bus.send(33, [("event", "moved"), ("id", win.id), ("x", x), ("y", y)])
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let win = sender as? SurfaceWindow else { return true }
        bus.send(33, [("event", "close"), ("id", win.id)])
        return false
    }

    func windowDidBecomeKey(_ notification: Notification) {
        guard let win = notification.object as? SurfaceWindow, byId[win.id] === win else { return }
        report(key: win.id)
    }

    func windowDidResignKey(_ notification: Notification) {
        keyboard.releaseAll()
        // another of ours may be next; if none is, say so
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let k = NSApp.keyWindow, self.owns(k) { return }
            self.report(key: nil)
        }
    }
}

final class SurfaceWindow: NSWindow {
    let id: String

    init(id: String, contentRect: NSRect) {
        self.id = id
        super.init(contentRect: contentRect, styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        isReleasedWhenClosed = false
        backgroundColor = .black
        collectionBehavior = [.managed, .participatesInCycle]
        tabbingMode = .disallowed
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// A surface's content: the pixels the OS presents, and the pointer over them.
@MainActor
final class SurfaceView: PixelView {
    private let bus: Bus
    private let keyboard: Keyboard
    private weak var surfaces: Surfaces?
    private let id: String
    private let picture = CALayer()
    private var lastMove: UInt64 = 0
    private var pending: Fields?
    private var armed = false
    private static let interval: UInt64 = 1_000_000_000 / 120

    init(frame: NSRect, bus: Bus, keyboard: Keyboard, surfaces: Surfaces, id: String) {
        self.bus = bus
        self.keyboard = keyboard
        self.surfaces = surfaces
        self.id = id
        super.init(frame: frame)
        let root = CALayer()
        root.backgroundColor = CGColor(gray: 0, alpha: 1)
        layer = root
        wantsLayer = true
        picture.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "frame": NSNull()]
        picture.magnificationFilter = .nearest
        picture.minificationFilter = .nearest
        picture.contentsGravity = .resize
        picture.isOpaque = true
        picture.frame = bounds
        root.addSublayer(picture)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var isOpaque: Bool { true }
    override var surface: String? { id }

    /// A rectangle in the content's frame buffer pixels, from its top left, in the view's points.
    override func local(_ r: NSRect) -> NSRect {
        let s = surfaces?.scale ?? 1
        return NSRect(x: r.minX * s, y: bounds.height - r.maxY * s, width: r.width * s, height: r.height * s)
    }

    func resize(w: Int, h: Int) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.frame = bounds
        CATransaction.commit()
    }

    func show(_ image: AnyObject) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.contents = image
        CATransaction.commit()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        picture.frame = bounds
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        _ = keyboard.handle(event)
        return true
    }

    override func keyDown(with event: NSEvent) { _ = keyboard.handle(event) }
    override func keyUp(with event: NSEvent) { _ = keyboard.handle(event) }
    override func flagsChanged(with event: NSEvent) { _ = keyboard.handle(event) }

    // MARK: pointer, in the desktop's coordinates

    private func fields(_ event: String, _ e: NSEvent, _ extra: Fields = []) -> Fields {
        let screenPoint = window?.convertPoint(toScreen: e.locationInWindow) ?? e.locationInWindow
        let (x, y) = surfaces?.desktop(screenPoint) ?? (0, 0)
        let pressed = NSEvent.pressedMouseButtons
        var buttons: [Any?] = []
        if pressed & 1 != 0 { buttons.append(0) }
        if pressed & 2 != 0 { buttons.append(1) }
        if pressed & ~3 != 0 { buttons.append(2) }
        return [("event", event), ("x", x), ("y", y), ("surface", id)] + extra
            + [("mods", modsList(e.modifierFlags, fn: keyboard.fn)), ("buttons", buttons)]
    }

    private func send(_ f: Fields) {
        flush()
        bus.send(35, f)
    }

    private func move(_ e: NSEvent) {
        let f = fields("move", e)
        let t = DispatchTime.now().uptimeNanoseconds
        if pending == nil, t &- lastMove >= SurfaceView.interval {
            lastMove = t
            bus.send(35, f)
            return
        }
        pending = f
        guard !armed else { return }
        armed = true
        DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(SurfaceView.interval))) { [weak self] in
            self?.armed = false
            self?.flush()
        }
    }

    private func flush() {
        guard let f = pending else { return }
        pending = nil
        lastMove = DispatchTime.now().uptimeNanoseconds
        bus.send(35, f)
    }

    private func button(_ e: NSEvent) -> Int {
        switch e.type {
        case .leftMouseDown, .leftMouseUp: return 0
        case .rightMouseDown, .rightMouseUp: return 1
        default: return 2
        }
    }

    override func mouseMoved(with e: NSEvent) { move(e) }
    override func mouseDragged(with e: NSEvent) { move(e) }
    override func rightMouseDragged(with e: NSEvent) { move(e) }
    override func otherMouseDragged(with e: NSEvent) { move(e) }
    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)  // the keyboard comes back to the OS from a web view
        send(fields("down", e, [("button", button(e))]))
    }
    override func rightMouseDown(with e: NSEvent) { send(fields("down", e, [("button", button(e))])) }
    override func otherMouseDown(with e: NSEvent) { send(fields("down", e, [("button", button(e))])) }
    override func mouseUp(with e: NSEvent) { send(fields("up", e, [("button", button(e))])) }
    override func rightMouseUp(with e: NSEvent) { send(fields("up", e, [("button", button(e))])) }
    override func otherMouseUp(with e: NSEvent) { send(fields("up", e, [("button", button(e))])) }
    override func mouseEntered(with e: NSEvent) { send(fields("enter", e)) }
    override func mouseExited(with e: NSEvent) { send(fields("exit", e)) }

    override func scrollWheel(with e: NSEvent) {
        let perPoint = 1 / (surfaces?.scale ?? 1)
        let unit = e.hasPreciseScrollingDeltas ? perPoint : 16 * perPoint
        let dx = Double(-e.scrollingDeltaX * unit), dy = Double(-e.scrollingDeltaY * unit)
        guard dx != 0 || dy != 0 else { return }
        send(fields("scroll", e, [("dx", (dx * 100).rounded() / 100), ("dy", (dy * 100).rounded() / 100)]))
    }

    override func magnify(with e: NSEvent) { send(fields("magnify", e, [("amount", Double(e.magnification))])) }
    override func rotate(with e: NSEvent) { send(fields("rotate", e, [("amount", Double(e.rotation))])) }

    /// A press from VoiceOver: a click at a point in the content's frame
    /// buffer pixels, sent in the desktop's, as the pointer's are.
    override func accessClick(x: Int, y: Int) {
        let p = screenRect(NSRect(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5, width: 0, height: 0)).origin
        let (dx, dy) = surfaces?.desktop(p) ?? (x, y)
        send([("event", "down"), ("x", dx), ("y", dy), ("surface", id), ("button", 0), ("mods", [Any?]()), ("buttons", [0] as [Any?]), ("access", true)])
        send([("event", "up"), ("x", dx), ("y", dy), ("surface", id), ("button", 0), ("mods", [Any?]()), ("buttons", [Any?]()), ("access", true)])
    }
}

/// A surface's pixels: two IOSurfaces, its view's contents in turn, as
/// Front has the screen's. A present brings only a piece, what changed in
/// that window, from wherever in a buffer the OS packed it; the one written
/// first takes from the one shown what it lacks, the last present's piece,
/// so each holds the whole window. Used on the command thread only. A
/// layer's (Layers.swift) is keyed: a pixel 0xFF000000 is none, transparent.
final class Pane {
    private let fb: FrameBuffer
    private let keyed: Bool
    private(set) var w: Int
    private(set) var h: Int
    private var surfaces: [IOSurface] = []
    private var next = 0
    /// what the one shown has and the next lacks: the last present's piece
    private var lacks: (x: Int, y: Int, w: Int, h: Int)?
    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!.copyPropertyList()

    init(fb: FrameBuffer, w: Int, h: Int, keyed: Bool = false) {
        self.fb = fb
        self.keyed = keyed
        self.w = w
        self.h = h
    }

    /// A new size: new surfaces at the next present, which the OS sends whole.
    func resize(w: Int, h: Int) {
        guard w != self.w || h != self.h else { return }
        self.w = w
        self.h = h
        surfaces = []
    }

    /// A piece presented: dirty's w × h pixels (the whole window without
    /// one) at sx, sy of a buffer, to dirty's place in the window. The
    /// surface to show, or nil when out of range.
    func present(buffer: Int, sx: Int, sy: Int, dirty: (x: Int, y: Int, w: Int, h: Int)?) -> IOSurface? {
        let piece = dirty ?? (x: 0, y: 0, w: w, h: h)
        guard (0..<FrameBuffer.buffers).contains(buffer), piece.w >= 0, piece.h >= 0, piece.x >= 0, piece.y >= 0,
              piece.x + piece.w <= w, piece.y + piece.h <= h, sx >= 0, sy >= 0, sx + piece.w <= fb.maxw, sy + piece.h <= fb.maxh else { return nil }
        if surfaces.isEmpty {
            surfaces = (0..<2).compactMap { _ in
                let s = IOSurface(properties: [.width: w, .height: h, .bytesPerElement: 4, .pixelFormat: 0x4247_5241])  // 'BGRA'
                if let s, let cs = Pane.sRGB { IOSurfaceSetValue(s, "IOSurfaceColorSpace" as CFString, cs) }
                return s
            }
            guard surfaces.count == 2 else { surfaces = []; return nil }
            next = 0
            lacks = nil
        }
        let s = surfaces[next]
        s.lock(options: [], seed: nil)
        defer { s.unlock(options: [], seed: nil) }
        let row = s.bytesPerRow
        let base = s.baseAddress
        if let r = lacks, r.w > 0, r.h > 0 {
            let shown = surfaces[1 - next]
            shown.lock(options: .readOnly, seed: nil)
            let from = shown.baseAddress, fromRow = shown.bytesPerRow
            for y in r.y..<(r.y + r.h) {
                memcpy(base + y * row + r.x * 4, from + y * fromRow + r.x * 4, r.w * 4)
            }
            shown.unlock(options: .readOnly, seed: nil)
        }
        if piece.w > 0 && piece.h > 0 {
            // the frame buffer's 0x00RRGGBB, opaque, as BGRA; keyed, 0xFF000000 transparent (premultiplied: all 0)
            let src = fb.pixels(buffer)
            for y in 0..<piece.h {
                let from = src + (sy + y) * fb.maxw + sx
                let to = (base + (piece.y + y) * row).assumingMemoryBound(to: UInt32.self) + piece.x
                if keyed {
                    for x in 0..<piece.w { to[x] = from[x] == 0xFF00_0000 ? 0 : from[x] | 0xFF00_0000 }
                } else {
                    for x in 0..<piece.w { to[x] = from[x] | 0xFF00_0000 }
                }
            }
        }
        lacks = piece
        next = 1 - next
        return s
    }
}
