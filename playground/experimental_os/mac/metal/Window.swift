// Window.swift: the monitor, the keyboard and the pointer.
//
// The window's view shows the last flipped frame buffer, scaled to fill it
// with nearest-neighbour sampling, and above it the cursor plane. Keys are
// taken in the application's sendEvent, before the menu or any key
// equivalent can see them: Cmd-Q, Ctrl-Cmd-F and Ctrl-Cmd-W are the
// metal's, every other key goes to the OS.

import AppKit
import QuartzCore

/// The application, which hands every key event in its window to the keyboard.
final class MetalApp: NSApplication {
    var keys: ((NSEvent) -> Bool)?

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .keyDown, .keyUp, .flagsChanged:
            if let keys, keys(event) { return }
        default:
            break
        }
        super.sendEvent(event)
    }
}

// MARK: - keyboard (irq 34)

@MainActor
final class Keyboard {
    private let bus: Bus
    weak var window: NSWindow?
    /// whether a window is one of the metal's: the monitor, or a surface in windows mode
    var owns: (NSWindow) -> Bool = { _ in false }
    var quit: () -> Void = {}
    var toggleFullScreen: () -> Void = {}
    var toggleWindows: () -> Void = {}
    /// the OS's text input: while it is on, keys go through the Mac's input method first
    var textInput: TextInput?
    private var down = Set<UInt16>()  // keys the OS has been told are down
    private var swallowed = Set<UInt16>()  // keys whose down was the metal's or the input method's
    private(set) var fn = false

    init(bus: Bus) { self.bus = bus }

    /// Takes a key event if it is for the window. Returns whether it was taken.
    func handle(_ e: NSEvent) -> Bool {
        let ours = e.window.map { $0 === window || owns($0) } ?? NSApp.keyWindow.map { $0 === window || owns($0) } ?? false
        guard ours else { return false }
        switch e.type {
        case .keyDown: keyDown(e)
        case .keyUp: keyUp(e)
        case .flagsChanged: flagsChanged(e)
        default: return false
        }
        return true
    }

    /// A key the tap took from the system (Tap.swift), whatever window the Mac says it is for: as handle takes it.
    func take(_ e: NSEvent) {
        switch e.type {
        case .keyDown: keyDown(e)
        case .keyUp: keyUp(e)
        case .flagsChanged: flagsChanged(e)
        default: break
        }
    }

    private func record(_ code: UInt16, down isDown: Bool, text: String, flags: NSEvent.ModifierFlags, repeating: Bool) {
        bus.send(34, [("event", "key"), ("down", isDown), ("code", Int(code)), ("key", keyName(code)), ("text", text),
                      ("mods", modsList(flags, fn: fn)), ("repeat", repeating)])
    }

    /// Cmd-Q and Ctrl-Cmd-F, matched by the character the layout gives, or by
    /// the key's place when there is none.
    private func metalKey(_ e: NSEvent) -> (() -> Void)? {
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let base = e.charactersIgnoringModifiers?.lowercased() ?? ""
        let printable = base.unicodeScalars.first.map { $0.value >= 0x20 } ?? false
        func its(_ c: String, _ code: UInt16) -> Bool { printable ? base == c : e.keyCode == code }
        if flags.contains(.command), !flags.contains(.control), !flags.contains(.option), its("q", 0x0C) {
            return quit
        }
        if flags.contains([.command, .control]), !flags.contains(.option), its("f", 0x03) {
            return toggleFullScreen
        }
        if flags.contains([.command, .control]), !flags.contains(.option), its("w", 0x0D) {
            return toggleWindows
        }
        return nil
    }

    private func keyDown(_ e: NSEvent) {
        if let action = metalKey(e) {
            swallowed.insert(e.keyCode)
            if !e.isARepeat { action() }
            return
        }
        var text = typedText(e)
        if let input = textInput, let view = client(e) {
            let outcome = input.key(e, in: view)
            for fields in outcome.records { bus.send(34, fields) }
            guard let typed = outcome.key else {
                // the input method took it: no key record, down or up
                swallowed.insert(e.keyCode)
                return
            }
            text = typed
        }
        down.insert(e.keyCode)
        record(e.keyCode, down: true, text: text, flags: e.modifierFlags, repeating: e.isARepeat)
    }

    /// The window manager's keys, which it takes with Option: return space
    /// tab t h j k l d s m c b g e p 1-9. With Option they are its chords,
    /// not characters, so neither WebKit nor an input method gets them
    /// (Option-E, a dead key, would otherwise never reach it).
    static let wmKeys: Set<UInt16> = [0x24, 0x31, 0x30, 0x11, 0x04, 0x26, 0x28, 0x25, 0x02, 0x01, 0x2E, 0x08, 0x0B, 0x05, 0x0E, 0x23,
                                      0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19]

    /// The view whose input method has the key: while text input is on, a
    /// key without Cmd or Ctrl, and no window manager chord, in the monitor or a surface.
    private func client(_ e: NSEvent) -> PixelView? {
        guard textInput?.on == true else { return nil }
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard !flags.contains(.command), !flags.contains(.control) else { return nil }
        if flags.contains(.option), Keyboard.wmKeys.contains(e.keyCode) { return nil }
        return (e.window ?? NSApp.keyWindow)?.firstResponder as? PixelView
    }

    private func keyUp(_ e: NSEvent) {
        let held = down.remove(e.keyCode) != nil
        // a key whose down was the metal's or the input method's has no up, unless the OS was told it is down
        if swallowed.remove(e.keyCode) != nil, !held { return }
        record(e.keyCode, down: false, text: "", flags: e.modifierFlags, repeating: false)
    }

    private func flagsChanged(_ e: NSEvent) {
        let code = e.keyCode
        let flags = e.modifierFlags
        if code == 0x39 {
            // Caps Lock gives one event a press, as the lock turns on or off: a press, then.
            record(code, down: true, text: "", flags: flags, repeating: false)
            record(code, down: false, text: "", flags: flags, repeating: false)
            return
        }
        guard let flag = modifierFlag[code] else { return }
        let isDown: Bool
        if code == 0x3F {
            isDown = flags.contains(.function)
            fn = isDown
        } else if let mask = modifierDeviceMask[code], flags.rawValue & 0x207F != 0 || !flags.contains(flag) {
            isDown = flags.rawValue & mask != 0
        } else {
            isDown = !down.contains(code)
        }
        guard isDown != down.contains(code) else { return }
        if isDown { down.insert(code) } else { down.remove(code) }
        record(code, down: isDown, text: "", flags: flags, repeating: false)
    }

    /// The window lost the keyboard: whatever was held is let go, so the OS
    /// is not left with keys stuck down.
    func releaseAll() {
        let flags = NSEvent.modifierFlags
        for code in down.sorted() {
            record(code, down: false, text: "", flags: flags, repeating: false)
        }
        down.removeAll()
        swallowed.removeAll()
        fn = false
    }
}

// MARK: - the screen: frame buffer, cursor plane, pointer (irq 35)

@MainActor
final class Screen: PixelView {
    private let bus: Bus
    private let keyboard: Keyboard
    private let picture = CALayer()
    private let cursorPlane = CALayer()

    /// The mode, in frame buffer pixels: pointer records and the cursor plane use it.
    var modeW = 1
    var modeH = 1

    private var cursorX = 0
    private var cursorY = 0
    private var hotX = 0
    private var hotY = 0
    private var cursorW = 0
    private var cursorH = 0

    private var lastMove: UInt64 = 0
    private var pendingMove: (Fields, Int)?
    private var moveFlushArmed = false
    private var lastMoveKey = ""
    private static let moveInterval: UInt64 = 1_000_000_000 / 120

    private static let blank: NSCursor = {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in true }
        return NSCursor(image: image, hotSpot: .zero)
    }()

    init(frame: NSRect, bus: Bus, keyboard: Keyboard) {
        self.bus = bus
        self.keyboard = keyboard
        super.init(frame: frame)
        let root = CALayer()
        root.backgroundColor = CGColor(gray: 0, alpha: 1)
        layer = root
        wantsLayer = true
        let still: [String: CAAction] = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(),
                                         "frame": NSNull(), "hidden": NSNull(), "onOrderIn": NSNull(), "onOrderOut": NSNull()]
        picture.actions = still
        picture.magnificationFilter = .nearest
        picture.minificationFilter = .nearest
        picture.contentsGravity = .resize
        picture.isOpaque = true
        picture.backgroundColor = CGColor(gray: 0, alpha: 1)
        picture.frame = bounds
        root.addSublayer(picture)
        cursorPlane.actions = still
        cursorPlane.magnificationFilter = .nearest
        cursorPlane.minificationFilter = .nearest
        cursorPlane.contentsGravity = .resize
        cursorPlane.isHidden = true
        root.addSublayer(cursorPlane)
        // One tracking area that follows the view's size (so it is never
        // remade, which would give spurious enters and exits). Moves come
        // from it only, and only while the window is key.
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .cursorUpdate,
                                                               .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var isOpaque: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    /// Keys are taken before key equivalents in MetalApp.sendEvent; should one
    /// still arrive here, it is the OS's and the menu does not get it.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        _ = keyboard.handle(event)
        return true
    }

    override func keyDown(with event: NSEvent) { _ = keyboard.handle(event) }
    override func keyUp(with event: NSEvent) { _ = keyboard.handle(event) }
    override func flagsChanged(with event: NSEvent) { _ = keyboard.handle(event) }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.frame = bounds
        placeCursor()
        CATransaction.commit()
    }

    // MARK: frame buffer

    /// Shows a flipped frame from the next refresh: an IOSurface (Front), or an image.
    func show(_ image: AnyObject) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.contents = image
        CATransaction.commit()
    }

    // MARK: cursor plane

    /// The cursor plane moved into a layer above the tiles (layers mode), so nothing on the monitor covers it.
    func lift(into top: CALayer) {
        cursorPlane.removeFromSuperlayer()
        top.addSublayer(cursorPlane)
    }

    /// The cursor plane follows the pointer here, as a hardware cursor does, whatever the OS is doing;
    /// it leaves the window with it. The OS gives the shape and whether it shows, and moves it only to warp.
    private func follow(_ x: Int, _ y: Int, _ event: String) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursorX = x
        cursorY = y
        inside = event != "exit"
        cursorPlane.isHidden = !inside || !shown || cursorW == 0
        placeCursor()
        CATransaction.commit()
    }

    private var inside = false
    private var shown = true

    func setCursor(x: Int?, y: Int?, visible: Bool, shape: (w: Int, h: Int, hotx: Int, hoty: Int, image: CGImage)?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let x, let y {
            cursorX = x
            cursorY = y
            // the corners round: the pointer is the metal's, and the Mac's goes with it
            if held != nil {
                let r = rims()
                let p = CGPoint(x: (CGFloat(x) + 0.5) * bounds.width / CGFloat(max(modeW, 1)),
                                y: (CGFloat(y) + 0.5) * bounds.height / CGFloat(max(modeH, 1)))
                let q = slide(p, CGVector(dx: 0, dy: 0), size: bounds.size, top: r.top, bottom: r.bottom)
                held = q
                warp(q, from: mac)
            }
        }
        if let shape {
            cursorW = shape.w
            cursorH = shape.h
            hotX = shape.hotx
            hotY = shape.hoty
            cursorPlane.contents = shape.image
        }
        shown = visible
        cursorPlane.isHidden = !inside || !shown || cursorW == 0
        placeCursor()
        CATransaction.commit()
    }

    func placeCursor() {
        cursorPlane.frame = local(NSRect(x: cursorX - hotX, y: cursorY - hotY, width: cursorW, height: cursorH))
    }

    /// A rectangle in frame buffer pixels, from the top left, in the view's points.
    override func local(_ r: NSRect) -> NSRect {
        let sx = bounds.width / CGFloat(max(modeW, 1))
        let sy = bounds.height / CGFloat(max(modeH, 1))
        return NSRect(x: r.minX * sx, y: bounds.height - r.maxY * sy, width: r.width * sx, height: r.height * sy)
    }

    // MARK: the Mac's cursor: hidden over the window while it is key

    override func cursorUpdate(with event: NSEvent) {
        Screen.blank.set()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: Screen.blank)
    }

    // MARK: pointer

    /// Where the event is, in frame buffer pixels from the top left. Inside
    /// the window it is clamped to the mode; a drag outside goes past it.
    private func place(_ e: NSEvent) -> (Int, Int) {
        let p = convert(e.locationInWindow, from: nil)
        let within = p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY
        var at = CGPoint(x: p.x, y: bounds.height - p.y)
        if within { at = steer(at, e) } else { held = nil }
        var x = Int((at.x * CGFloat(modeW) / max(bounds.width, 1)).rounded(.down))
        var y = Int((at.y * CGFloat(modeH) / max(bounds.height, 1)).rounded(.down))
        if within {
            x = min(max(x, 0), modeW - 1)
            y = min(max(y, 0), modeH - 1)
        }
        return (x, y)
    }

    /// The screen's rounded corners, in points, top and bottom (0: square): the pointer kept off
    /// what they cut away, sliding round them, as on the Mac's own rounded screen. Set only full
    /// screen on the Mac's own display (main.swift, roundCorners).
    var corners: (top: CGFloat, bottom: CGFloat) = (0, 0) {
        didSet { held = nil }
    }

    /// The pointer, in points from the top left, while the corners are round: the Mac's own, but
    /// in a corner it is the metal's (slide, Corners.swift) and the Mac's is warped to it, so a
    /// click lands where the cursor plane is. Not inside the window: nil.
    private var held: CGPoint?
    /// Where the Mac's pointer was last, in the same points: a move is measured from it.
    private var mac = CGPoint.zero
    /// The last warp of the Mac's pointer, on the events' clock, and where the pointer was before it:
    /// an event made before the warp is measured from there.
    private var warpedAt: TimeInterval = 0
    private var beforeWarp = CGPoint.zero

    /// The rims' radii in points (Corners.swift, rim): the arcs the hot spot keeps to.
    private func rims() -> (top: CGFloat, bottom: CGFloat) {
        let per = CGFloat(modeW) / max(bounds.width, 1)
        return (rim(corners.top, per: per), rim(corners.bottom, per: per))
    }

    /// In a corner's square, where the rim can move the pointer.
    private func cornered(_ q: CGPoint, _ r: (top: CGFloat, bottom: CGFloat)) -> Bool {
        let w = bounds.width, h = bounds.height
        return (r.top > 0 && q.y < r.top && (q.x < r.top || q.x > w - r.top))
            || (r.bottom > 0 && q.y > h - r.bottom && (q.x < r.bottom || q.x > w - r.bottom))
    }

    /// The Mac's pointer at `sys` (points from the top left, inside the window), moved round the
    /// corners: the hand's move since the last event, slid from where the pointer was. Out of the
    /// corners' squares the Mac's pointer is the pointer, so the two never drift apart.
    private func steer(_ sys: CGPoint, _ e: NSEvent) -> CGPoint {
        let r = rims()
        guard r.top > 0 || r.bottom > 0 else { held = nil; return sys }
        let size = bounds.size
        guard let from = held else {
            // coming in: on the rim, if it came in past it
            let q = slide(sys, CGVector(dx: 0, dy: 0), size: size, top: r.top, bottom: r.bottom)
            held = q
            mac = sys
            if cornered(sys, r), q != sys { warp(q, from: sys) }
            return q
        }
        var d: CGVector
        if e.timestamp < warpedAt {
            // made before the warp: measured from where the Mac's pointer was then
            d = CGVector(dx: sys.x - beforeWarp.x, dy: sys.y - beforeWarp.y)
            beforeWarp = sys
        } else {
            d = CGVector(dx: sys.x - mac.x, dy: sys.y - mac.y)
            mac = sys
        }
        // at the screen's edge the Mac's pointer stops; the hand's move past it is the event's delta
        if [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(e.type), cornered(sys, r) {
            if sys.x <= 0, e.deltaX < 0 { d.dx = min(d.dx, e.deltaX) }
            if sys.x >= size.width - 1, e.deltaX > 0 { d.dx = max(d.dx, e.deltaX) }
            if sys.y <= 0, e.deltaY < 0 { d.dy = min(d.dy, e.deltaY) }
            if sys.y >= size.height - 1, e.deltaY > 0 { d.dy = max(d.dy, e.deltaY) }
        }
        let q = slide(from, d, size: size, top: r.top, bottom: r.bottom)
        guard cornered(q, r) || cornered(sys, r) else { held = sys; return sys }
        held = q
        if abs(q.x - sys.x) > 0.01 || abs(q.y - sys.y) > 0.01 { warp(q, from: sys) }
        return q
    }

    /// The Mac's pointer moved to `q` (points from the top left of the view), no event made. Moves
    /// after it count from `q`; the hardware's moves are not held back (the warp's quarter second
    /// of suppression ends at once, CGAssociateMouseAndMouseCursorPosition).
    private func warp(_ q: CGPoint, from sys: CGPoint) {
        guard let window else { return }
        let onScreen = window.convertPoint(toScreen: convert(NSPoint(x: q.x, y: bounds.height - q.y), to: nil))
        // global display coordinates: from the top left of the main display (the first screen)
        let height = NSScreen.screens.first?.frame.height ?? window.screen?.frame.height ?? 0
        CGWarpMouseCursorPosition(CGPoint(x: onScreen.x, y: height - onScreen.y))
        CGAssociateMouseAndMouseCursorPosition(1)
        warpedAt = ProcessInfo.processInfo.systemUptime
        beforeWarp = sys
        mac = q
    }

    private func buttons() -> [Any?] {
        let pressed = NSEvent.pressedMouseButtons
        var list: [Any?] = []
        if pressed & 1 != 0 { list.append(0) }
        if pressed & 2 != 0 { list.append(1) }
        if pressed & ~3 != 0 { list.append(2) }
        return list
    }

    private func pointer(_ event: String, _ e: NSEvent, _ extra: Fields = []) -> Fields {
        let (x, y) = place(e)
        follow(x, y, event)
        return [("event", event), ("x", x), ("y", y)] + extra
            + [("mods", modsList(e.modifierFlags, fn: keyboard.fn)), ("buttons", buttons())]
    }

    private func send(_ fields: Fields) {
        flushMove()
        bus.send(35, fields)
    }

    /// Moves, drags included, at most 120 a second: a move that comes too
    /// soon waits, and a later one replaces it.
    private func move(_ e: NSEvent) {
        let fields = pointer("move", e)
        // A move within the same frame buffer pixel, with nothing else changed, is no move.
        let key = json(fields)
        guard key != lastMoveKey else { return }
        lastMoveKey = key
        let t = DispatchTime.now().uptimeNanoseconds
        if pendingMove == nil, t &- lastMove >= Screen.moveInterval {
            lastMove = t
            bus.send(35, fields)
            return
        }
        pendingMove = (fields, now())
        guard !moveFlushArmed else { return }
        moveFlushArmed = true
        let wait = Screen.moveInterval &- min(Screen.moveInterval, t &- lastMove)
        DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(wait))) { [weak self] in
            self?.moveFlushArmed = false
            self?.flushMove()
        }
    }

    private func flushMove() {
        guard let (fields, at) = pendingMove else { return }
        pendingMove = nil
        lastMove = DispatchTime.now().uptimeNanoseconds
        bus.send(35, fields, at: at)
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
        send(pointer("down", e, [("button", button(e))]))
    }
    override func rightMouseDown(with e: NSEvent) { send(pointer("down", e, [("button", button(e))])) }
    override func otherMouseDown(with e: NSEvent) { send(pointer("down", e, [("button", button(e))])) }
    override func mouseUp(with e: NSEvent) { send(pointer("up", e, [("button", button(e))])) }
    override func rightMouseUp(with e: NSEvent) { send(pointer("up", e, [("button", button(e))])) }
    override func otherMouseUp(with e: NSEvent) { send(pointer("up", e, [("button", button(e))])) }

    override func mouseEntered(with e: NSEvent) { send(pointer("enter", e)) }
    override func mouseExited(with e: NSEvent) { send(pointer("exit", e)) }

    /// Scrolls in frame buffer pixels, positive dy scrolling down the content,
    /// as the web's wheel events do. A wheel without precise deltas scrolls
    /// 16 points a line.
    override func scrollWheel(with e: NSEvent) {
        let perPoint = CGFloat(modeW) / max(bounds.width, 1)
        let unit = e.hasPreciseScrollingDeltas ? perPoint : 16 * perPoint
        let dx = Double(-e.scrollingDeltaX * unit)
        let dy = Double(-e.scrollingDeltaY * unit)
        guard dx != 0 || dy != 0 else { return }
        send(pointer("scroll", e, [("dx", (dx * 100).rounded() / 100), ("dy", (dy * 100).rounded() / 100)]))
    }

    override func magnify(with e: NSEvent) {
        send(pointer("magnify", e, [("amount", Double(e.magnification))]))
    }

    override func rotate(with e: NSEvent) {
        send(pointer("rotate", e, [("amount", Double(e.rotation))]))
    }

    /// A press from VoiceOver: a click at a point in frame buffer pixels.
    override func accessClick(x: Int, y: Int) {
        send([("event", "down"), ("x", x), ("y", y), ("button", 0), ("mods", [Any?]()), ("buttons", [0] as [Any?]), ("access", true)])
        send([("event", "up"), ("x", x), ("y", y), ("button", 0), ("mods", [Any?]()), ("buttons", [Any?]()), ("access", true)])
    }
}
