// main.swift: ermineOS, the ermine OS's Mac port: the metal, and the OS
// linked in (../../ERMINEOS.md).
//
// The metal turns the Mac's devices into the hardware the OS drives, as
// Inferno's emu does for Inferno, and boots the OS on a thread of its own,
// or, with --os, as its child. The contract between the two is ../METAL.md;
// this program follows it and never looks past it.

import AppKit

// MARK: - the command line

struct Config {
    /// an OS to run as a child process, over pipes, in place of the one linked in
    var os: String?
    /// points per frame buffer pixel; by default one frame buffer pixel a device pixel
    var scale: Double = 0
    var fullscreen = false
    /// full screen, the Mac's own keys to leave are off too: no switching spaces or apps (--take-over)
    var takeover = false
    var windows = false
    var font: String?
    var args: [String] = []
}

func usage(_ message: String? = nil) -> Never {
    if let message { FileHandle.standardError.write(("ermineOS: " + message + "\n").data(using: .utf8)!) }
    FileHandle.standardError.write("usage: ermineOS [--os \"<command>\"] [--scale N] [--fullscreen] [--take-over] [--windows] [--font NAME] [--] [args for the OS...]\n".data(using: .utf8)!)
    exit(2)
}

func parseArguments() -> Config {
    var config = Config()
    var args = Array(CommandLine.arguments.dropFirst())
    while let arg = args.first {
        args.removeFirst()
        var name = arg
        var inline: String?
        if arg.hasPrefix("--"), let eq = arg.firstIndex(of: "=") {
            name = String(arg[..<eq])
            inline = String(arg[arg.index(after: eq)...])
        }
        func value() -> String {
            if let inline { return inline }
            guard !args.isEmpty else { usage("\(name) needs a value") }
            return args.removeFirst()
        }
        switch name {
        case "--os": config.os = value()
        case "--scale":
            guard let s = Double(value()), s > 0, s.isFinite else { usage("--scale needs a positive number") }
            config.scale = s
        case "--fullscreen": config.fullscreen = true
        case "--take-over": config.takeover = true
        case "--windows": config.windows = true
        case "--font": config.font = value()
        case "--":
            config.args = args
            args.removeAll()
        case "-h", "--help": usage()
        default: usage("unknown argument \(arg)")
        }
    }
    if config.scale == 0 {
        // the Mac's own resolution: on a Retina screen a frame buffer pixel is half a point
        let backing = Double(NSScreen.main?.backingScaleFactor ?? NSScreen.screens.first?.backingScaleFactor ?? 1)
        config.scale = 1 / max(1, backing)
    }
    return config
}

/// A path in the OS's own files (newos: image/, js/runner.js, programs/, fonts/): in an app
/// (../app.sh), its Resources, where app.sh copies them; else ../newos from the folder ermineOS
/// is in (mac/ermineOS).
func osPath(_ path: String) -> String {
    if let resources = Bundle.main.resourceURL,
       FileManager.default.fileExists(atPath: resources.appendingPathComponent("image/image.json").path) {
        return resources.appendingPathComponent(path).standardizedFileURL.path
    }
    let exe = Bundle.main.executableURL?.resolvingSymlinksInPath()
        ?? URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    return exe.deletingLastPathComponent().appendingPathComponent("../newos/" + path).standardizedFileURL.path
}

/// What the OS linked in is given from its own arguments (those after --),
/// --sd DIR, the SD card's folder (~/.ermine/disk by default: the old OS's
/// ~/.ermine/card and the 10-12 newos's ~/.ermine/newcard are other formats);
/// --fresh, --bare, --service.
struct OSOptions {
    var sd = NSHomeDirectory() + "/.ermine/disk"
    var fresh = false, bare = false, service = false

    init(_ args: [String]) {
        var args = args[...]
        while let arg = args.popFirst() {
            switch arg {
            case "--sd": if let dir = args.popFirst() { sd = dir }
            case _ where arg.hasPrefix("--sd="): sd = String(arg.dropFirst(5))
            case "--fresh": fresh = true
            case "--bare": bare = true
            case "--service": service = true
            default: break
            }
        }
    }
}

// MARK: - the machine

@MainActor
final class Machine: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let config: Config
    /// whether full screen takes over, the Mac's ways out off too, when it begins (--take-over at start;
    /// then as /dev/display/want says): what is wished, not what is; takingOver says that
    private var takeover = false

    /// Taking over now: full screen, and the Mac's own presentation with its ways out off, as the Mac says.
    private var takingOver: Bool {
        window.styleMask.contains(.fullScreen) && NSApp.presentationOptions.contains(.disableProcessSwitching)
    }
    let bus: Bus
    /// Set once in boot, before the command thread starts; read from it after.
    nonisolated(unsafe) var fb: FrameBuffer!
    /// the screen's pixels, as the picture layer shows them (FrameBuffer.swift)
    nonisolated(unsafe) var front: Front!
    var planes: Planes!
    /// layers mode, on the monitor: each of the OS's layers a tile, composited by Core Animation (Layers.swift)
    var stack: Stack!
    /// over everything on the monitor: the cursor plane
    private var top: PassView!
    /// the tiles' pixels, two IOSurfaces each, keyed, for layers commands copied on the command thread
    nonisolated(unsafe) private var tilePanes: [String: Pane] = [:]
    var window: NSWindow!
    var screen: Screen!
    var keyboard: Keyboard!
    /// the keys the Mac keeps for itself, taken for the OS while taking over (Tap.swift)
    let tap = Tap()
    var surfaces: Surfaces!
    /// windows mode: each of the OS's windows a Mac window (../METAL.md)
    private(set) var windowsMode = false
    private var pendingWindows = false
    private var vsyncOn = false
    /// the surfaces' pixels, two IOSurfaces each (Pane, Surfaces.swift), for presents copied on the command thread
    nonisolated(unsafe) private var panes: [String: Pane] = [:]
    nonisolated private let panesLock = NSLock()
    /// frames copied on the command thread and not yet shown, by where they go ("" the screen, else a
    /// surface's id): a newer one replaces one main has not shown, so whole frames never queue on main
    nonisolated(unsafe) private var unshown: [String: AnyObject] = [:]
    nonisolated private let unshownLock = NSLock()
    let sound = Sound()

    lazy var power = Power(bus: bus)
    lazy var thermal = Thermal(bus: bus)
    lazy var sleep = Sleep(bus: bus)
    lazy var cpu = CPU(bus: bus)
    lazy var usb = USB(bus: bus)
    lazy var net = Net(bus: bus)
    lazy var clipboard = Clipboard(bus: bus)
    lazy var volumes = Volumes(bus: bus)
    lazy var web = Web(bus: bus)
    /// what the OS's pixels mean: where it takes text, and its accessibility tree
    lazy var textInput = TextInput(bus: bus)
    lazy var access = Access()
    /// the OS's menus in the menu bar, after these (Menus.swift)
    lazy var menus = Menus(bus: bus)
    /// the font chip: renders on a queue of its own, called from the command thread
    nonisolated let fonts: FontServer
    /// the Mac's other apps: their accessibility trees, each app on a thread of its own (Mac.swift)
    nonisolated let mac: Mac
    /// a Mac window's pixels, captured, and input posted back to its app (Capture.swift)
    nonisolated let capture: Capture

    private var link: CADisplayLink?
    /// the main screen's refresh, for vsync while the monitor is hidden
    private var screenLink: CADisplayLink?
    private var frame = 0
    private var lastMode = ""
    private var quitting = false
    private var poweringOff = false
    private var finished = false
    private var flips = 0
    private var commands = 0
    private var vsyncs = 0

    init(config: Config) {
        self.config = config
        takeover = config.takeover
        bus = Bus(inProcess: config.os == nil)
        fonts = FontServer(bus: bus)
        mac = Mac(bus: bus, scale: config.scale)
        capture = Capture(bus: bus, mac: mac, scale: config.scale)
        super.init()
    }

    /// Everything up to the run loop, in the contract's order.
    func boot() {
        let scale = config.scale
        log("ermineOS starting: scale \(scale)\(config.fullscreen ? ", full screen" : "")\(Serial.present ? ", uart0 on the terminal" : "")")
        installExitHooks()
        Serial.makeRaw()

        // 1. the shared memory: big enough for the largest screen
        let screens = NSScreen.screens
        var maxPoints = screens.reduce(CGSize.zero) {
            CGSize(width: max($0.width, $1.frame.width), height: max($0.height, $1.frame.height))
        }
        if maxPoints.width < 1 || maxPoints.height < 1 { maxPoints = CGSize(width: 1280, height: 800) }
        let maxw = Int((maxPoints.width / scale).rounded(.up))
        let maxh = Int((maxPoints.height / scale).rounded(.up))
        do {
            fb = try FrameBuffer(maxw: maxw, maxh: maxh)
            front = Front(fb: fb)
        } catch {
            log("\(error)")
            flushLog()
            exit(1)
        }
        fbPathForExit = fb.path
        fbPathForExitC = strdup(fb.path)
        do {
            planes = try Planes(maxw: maxw, maxh: maxh, slots: 4)
        } catch {
            log("\(error)")
            flushLog()
            exit(1)
        }
        planesPathForExit = planes.path
        planesPathForExitC = strdup(planes.path)
        web.scale = CGFloat(config.scale)
        log("frame buffer \(fb.path): \(maxw)x\(maxh), \(fb.size) bytes")

        net.start()  // its first path comes on its own queue, ready for the records at start
        let font = FontROM.make(scale: scale, font: config.font)

        // 2. the window
        makeWindow(maxw: maxw, maxh: maxh)
        makeMenu()

        // 3. the OS: linked in, on a thread of its own, or with --os a child
        let dt = deviceTree(fb: fb, planes: planes, scale: scale, font: font, uart: Serial.present)
        if let os = config.os {
            do {
                try bus.spawn(command: os, args: config.args, fbPath: fb.path)
            } catch {
                log("\(error)")
                flushLog()
                exit(1)
            }
            bus.watchExit { [weak self] status in self?.osExited(status) }
        } else {
            startOS(dt: dt)
        }

        // 4. the boot record, then each device's state as it is now
        bus.send(0, [("dt", dt)])
        usb.arm()
        sendMode()
        power.send(Power.now())
        thermal.send(Thermal.now())
        bus.send(45, net.now(timeout: 1))
        bus.send(46, clipboard.first())
        for device in usb.present { bus.send(44, device) }
        usb.goLive()
        mac.start()  // access and the apps; no AX read before the mac command

        // 5. from now on, a record whenever something happens
        power.watch()
        thermal.watch()
        sleep.watch()
        cpu.watch()
        clipboard.watch()
        volumes.watch()
        if !bus.inProcess {
            bus.readCommands({ [weak self] cmd in self?.command(cmd) }, closed: { log("the OS closed its stdout") })
        }
        Serial.read(bytes: { [bus] data in bus.send(36, [("rx", data.base64EncodedString())]) },
                    quit: { [weak self] in DispatchQueue.main.async { self?.requestQuit("serial") } })
        for sig in [SIGINT, SIGTERM, SIGHUP] { watchSignal(sig) }

        if config.fullscreen && !config.windows {
            DispatchQueue.main.async { [weak self] in self?.window.toggleFullScreen(nil) }
        }
    }

    /// Boots the OS linked in (../../newos/os.h): the device tree, the shared
    /// memory, the SD card, the image, the JavaScript runner, the flags.
    private func startOS(dt: Fields) {
        let options = OSOptions(config.args)
        let image = osPath("image"), runner = osPath("js/runner.js")
        setenv("ERMINE_FB", fb.path, 1)  // for what the OS starts, as a child OS has it
        let strings = [json(dt), options.sd, image, runner].map { strdup($0) }
        defer { strings.forEach { free($0) } }
        var list = (0..<planes.slots).map { Optional(planes.pixels($0)) }
        list.withUnsafeMutableBufferPointer { pointers in
            var c = ErmosConfig()
            c.dt = UnsafePointer(strings[0])
            c.buffers = (fb.pixels(0), fb.pixels(1))
            c.planes = pointers.baseAddress
            c.nplanes = Int32(pointers.count)
            c.sd = UnsafePointer(strings[1])
            c.image = UnsafePointer(strings[2])
            c.runner = UnsafePointer(strings[3])
            c.fresh = options.fresh
            c.bare = options.bare
            c.service = options.service
            bus.start(&c) { [weak self] cmd in self?.command(cmd) }
        }
        log("the OS: sd \(options.sd), image \(image), runner \(runner)\(options.fresh ? ", fresh" : "")\(options.bare ? ", bare" : "")\(options.service ? ", service" : "")")
    }

    private func makeWindow(maxw: Int, maxh: Int) {
        let scale = CGFloat(config.scale)
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        let titlebar = NSWindow.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: style).height - 100
        var w = min(1280, visible.width)
        var h = min(800, visible.height - titlebar)
        if scale >= 1 {  // whole frame buffer pixels
            w = (w / scale).rounded(.down) * scale
            h = (h / scale).rounded(.down) * scale
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: w, height: h), styleMask: style, backing: .buffered, defer: false)
        window.title = "ermine"
        window.isReleasedWhenClosed = false
        window.backgroundColor = .black
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentResizeIncrements = scale >= 1 ? NSSize(width: scale, height: scale) : NSSize(width: 1, height: 1)
        window.contentMinSize = NSSize(width: max(64, 8 * scale), height: max(48, 8 * scale))
        window.contentMaxSize = NSSize(width: CGFloat(maxw) * scale, height: CGFloat(maxh) * scale)

        keyboard = Keyboard(bus: bus)
        keyboard.window = window
        keyboard.quit = { [weak self] in self?.requestQuit("cmd-q") }
        keyboard.toggleFullScreen = { [weak self] in
            guard let self, !self.windowsMode else { return }
            self.window.toggleFullScreen(nil)
        }
        tap.deliver = { [weak self] e in self?.keyboard.take(e) }
        keyboard.toggleWindows = { [weak self] in
            guard let self else { return }
            self.setWindows(!self.windowsMode)
        }
        surfaces = Surfaces(bus: bus, keyboard: keyboard, scale: config.scale)
        surfaces.textInput = textInput
        surfaces.access = access
        keyboard.textInput = textInput
        keyboard.owns = { [weak self] w in self?.surfaces.owns(w) ?? false }
        (NSApp as? MetalApp)?.keys = { [weak self] e in self?.keyboard.handle(e) ?? false }

        screen = Screen(frame: NSRect(x: 0, y: 0, width: w, height: h), bus: bus, keyboard: keyboard)
        screen.textInput = textInput
        screen.access = access
        textInput.host = { [weak self] id in self?.host(id) }
        access.host = { [weak self] id in self?.host(id) }
        // the monitor: the frame buffer, the tiles (layers mode), the cursor plane
        let monitor = NSView(frame: screen.frame)
        monitor.wantsLayer = true
        stack = Stack(frame: screen.frame)
        stack.local = { [weak self] r in self?.screen.local(r) ?? r }
        top = PassView(frame: screen.frame)
        top.layer = CALayer()
        top.wantsLayer = true
        screen.lift(into: top.layer!)
        for v in [screen!, stack!, top!] as [NSView] {
            v.autoresizingMask = [.width, .height]
            monitor.addSubview(v)
        }
        window.contentView = monitor
        window.delegate = self
        window.center()
        window.makeFirstResponder(screen)
        keyboard.window = window
        self.window = window
        updateMode()

        let link = screen.displayLink(target: self, selector: #selector(refresh(_:)))
        link.isPaused = true
        link.add(to: .main, forMode: .common)
        self.link = link
        if let screenLink = (NSScreen.main ?? NSScreen.screens.first)?.displayLink(target: self, selector: #selector(refresh(_:))) {
            screenLink.isPaused = true
            screenLink.add(to: .main, forMode: .common)
            self.screenLink = screenLink
        }

        if config.windows { windowsMode = true } else { window.makeKeyAndOrderFront(nil) }
        log("window \(window.windowNumber): \(Int(w))x\(Int(h)) points")
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        let quit = NSMenuItem(title: "Quit ermine", action: #selector(menuQuit(_:)), keyEquivalent: "q")
        quit.target = self
        appMenu.addItem(quit)
        appItem.submenu = appMenu
        // for web pages: copy, paste and the rest go to whatever has the keyboard
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
                                     ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(title == "Redo" ? "redo:" : action), keyEquivalent: key))
        }
        editItem.submenu = edit
        // View: Seamless, each of the OS's windows a Mac window (windows mode), or the one monitor
        let viewItem = NSMenuItem()
        menu.addItem(viewItem)
        let view = NSMenu(title: "View")
        let seamless = NSMenuItem(title: "Seamless", action: #selector(menuSeamless(_:)), keyEquivalent: "w")
        seamless.keyEquivalentModifierMask = [.control, .command]
        seamless.target = self
        view.addItem(seamless)
        let take = NSMenuItem(title: "Take Over", action: #selector(menuTakeover(_:)), keyEquivalent: "")
        take.target = self
        view.addItem(take)
        viewItem.submenu = view
        NSApp.mainMenu = menu
    }

    /// Cmd-Q, or Quit in the menu; taking over, nothing (a Dock quit or a logout still quits)
    @objc func menuQuit(_ sender: Any?) {
        if takingOver {
            NSSound.beep()
            log("cmd-q: taking over, so ermineOS keeps running")
            return
        }
        requestQuit("cmd-q")
    }
    @objc func menuSeamless(_ sender: Any?) { setWindows(!windowsMode) }
    @objc func menuTakeover(_ sender: Any?) { setTakeover(!takingOver) }

    /// What full screen hides and turns off: the Mac's menu bar and Dock always; its ways out (spaces, cmd-tab) when taking over.
    private var presentation: NSApplication.PresentationOptions {
        takeover ? [.fullScreen, .hideDock, .hideMenuBar, .disableProcessSwitching] : [.fullScreen, .hideDock, .hideMenuBar]
    }

    /// Full screen, the Mac's ways out turned off or on as taking over wishes: only that bit of what the Mac
    /// has now (it refuses an app that sets .fullScreen itself, silently)
    private func retake() {
        var o = NSApp.presentationOptions
        if takeover { o.insert(.disableProcessSwitching) } else { o.remove(.disableProcessSwitching) }
        o.formUnion([.hideDock, .hideMenuBar])
        if o != NSApp.presentationOptions { NSApp.presentationOptions = o }
        log("takeover: \(takeover ? "on" : "off")")
    }

    /// Taking over, or not: full screen, at once (going full screen to take over); and the OS told, in the mode
    func setTakeover(_ on: Bool) {
        takeover = on
        if window.styleMask.contains(.fullScreen) {
            retake()
        } else if on {
            window.toggleFullScreen(nil)  // the delegate gives it the presentation, and the mode is sent once it is full screen
            return
        }
        sendMode()
    }

    /// Seamless is ticked while it is on.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(menuSeamless(_:)) { item.state = windowsMode ? .on : .off }
        if item.action == #selector(menuTakeover(_:)) { item.state = takingOver ? .on : .off }
        return true
    }

    /// the Mac's presentation, watched: it changes a moment after it is asked to, so the mode is sent when it has
    private var presenting: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        presenting = NSApp.observe(\.presentationOptions) { [weak self] _, _ in
            DispatchQueue.main.async { self?.sendMode() }
        }
        // Started from a terminal, the metal is not the active app; it asks to be.
        NSApp.activate(ignoringOtherApps: true)
        if !windowsMode { window.makeKeyAndOrderFront(nil) }
    }

    /// Clicking the Dock icon with nothing showing shows the monitor again.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { setWindows(false) }
        return true
    }

    // MARK: windows mode

    /// Switches between the monitor and the OS's windows as Mac windows.
    func setWindows(_ on: Bool) {
        guard on != windowsMode else { return }
        if on, window.styleMask.contains(.fullScreen) {
            // out of full screen first, then on
            pendingWindows = true
            window.toggleFullScreen(nil)
            return
        }
        windowsMode = on
        // the stack is emptied either way: the OS sends every tile again, back on the monitor
        stack.removeAll()
        panesLock.lock()
        tilePanes.removeAll()
        panesLock.unlock()
        if on {
            window.orderOut(nil)
            keyboard.releaseAll()
        } else {
            surfaces.removeAll()
            panesLock.lock()
            panes.removeAll()
            panesLock.unlock()
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        }
        setVsync(vsyncOn)
        log("windows mode \(on ? "on" : "off")")
        sendMode()
    }

    /// The view that shows a surface's pixels, or the monitor's for nil.
    private func host(_ surface: String?) -> PixelView? {
        if let surface { return surfaces.view(surface) }
        return screen
    }

    /// Layers mode: on the monitor, unless ERMINE_LAYERS=0 asks for the frame buffer, flipped, alone.
    private var layering: Bool { !windowsMode && ProcessInfo.processInfo.environment["ERMINE_LAYERS"] != "0" }

    private func setVsync(_ on: Bool) {
        vsyncOn = on
        link?.isPaused = !on || windowsMode
        screenLink?.isPaused = !on || !windowsMode
    }

    // MARK: display (irq 33)

    /// The mode the window gives: its size over the scale, in whole frame
    /// buffer pixels, no bigger than the frame buffer.
    @discardableResult
    private func updateMode() -> Fields {
        let scale = CGFloat(config.scale)
        if windowsMode {
            let main = (NSScreen.screens.first ?? NSScreen.main)?.frame.size ?? CGSize(width: 1280, height: 800)
            return [("event", "mode"), ("w", Int(main.width / scale)), ("h", Int(main.height / scale)), ("scale", config.scale),
                    ("unit", max(1, Int((1 / config.scale).rounded()))),
                    ("screen", NSScreen.screens.first?.localizedName ?? ""), ("fullscreen", false), ("windows", true), ("layers", false), ("takeover", takingOver),
                    ("keys", tap.status)]
        }
        let size = screen.bounds.size
        let w = min(fb.maxw, max(1, Int((size.width / scale + 0.001).rounded(.down))))
        let h = min(fb.maxh, max(1, Int((size.height / scale + 0.001).rounded(.down))))
        screen.modeW = w
        screen.modeH = h
        screen.placeCursor()
        return [("event", "mode"), ("w", w), ("h", h), ("scale", config.scale), ("unit", max(1, Int((1 / config.scale).rounded()))),
                ("screen", window.screen?.localizedName ?? NSScreen.main?.localizedName ?? ""),
                ("fullscreen", window.styleMask.contains(.fullScreen)), ("windows", false), ("layers", layering),
                ("takeover", takingOver), ("keys", tap.status)]
    }

    /// The tap on while taking over, ermineOS active and its window key.
    private var tapping: Bool { takingOver && NSApp.isActive && window.isKeyWindow }

    private func sendMode() {
        tap.update(on: tapping)
        let mode = updateMode()
        stack?.relayout()
        let key = json(mode)
        guard key != lastMode else { return }
        lastMode = key
        bus.send(33, mode)
    }

    @objc func refresh(_ link: CADisplayLink) {
        frame += 1
        vsyncs += 1
        bus.send(33, [("event", "vsync"), ("frame", frame)])
    }

    func windowDidResize(_ notification: Notification) { sendMode() }
    func windowDidChangeScreen(_ notification: Notification) {
        sendMode()
        roundCorners()
    }
    func windowDidEnterFullScreen(_ notification: Notification) {
        // full screen again: what taking over wishes, as it was when it left
        retake()
        sendMode()
        roundCorners()
    }

    /// the corners /etc/desktop says the screen has, in points (the OS's display command)
    private var corners: (top: CGFloat, bottom: CGFloat) = (0, 0)

    /// The pointer kept off the screen's rounded corners while full screen on the Mac's own display, where they are.
    private func roundCorners() {
        let id = window.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        // the Mac's own display: built in, or with a camera housing's areas beside it (a rounded screen either way)
        let own = (id.map { CGDisplayIsBuiltin($0) != 0 } ?? false) || window.screen?.auxiliaryTopLeftArea != nil
        let full = window.styleMask.contains(.fullScreen)
        screen.corners = own && full ? corners : (0, 0)
        log("corners: top \(corners.top), bottom \(corners.bottom): \(own && full ? "on" : "off")\(full ? "" : ", not full screen")\(own ? "" : ", not the Mac's own display")")
    }
    /// Full screen, the Mac's menu bar stays hidden, not dropping when the pointer reaches the top (the
    /// OS has a menu bar of its own there); switching spaces and apps still works, unless --take-over.
    func window(_ window: NSWindow, willUseFullScreenPresentationOptions proposed: NSApplication.PresentationOptions = []) -> NSApplication.PresentationOptions {
        presentation
    }
    func windowDidExitFullScreen(_ notification: Notification) {
        sendMode()
        roundCorners()
        if pendingWindows {
            pendingWindows = false
            setWindows(true)
        }
    }
    func windowDidBecomeKey(_ notification: Notification) {
        bus.send(33, [("event", "focus"), ("on", true)])
        sendMode()
    }
    func applicationDidBecomeActive(_ notification: Notification) { sendMode() }
    func applicationDidResignActive(_ notification: Notification) { sendMode() }
    func windowDidResignKey(_ notification: Notification) {
        sendMode()
        keyboard.releaseAll()
        bus.send(33, [("event", "focus"), ("on", false)])
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        requestQuit("window")
        return false
    }

    /// Quit from the Dock, or a logout: the same as Cmd-Q. The metal exits
    /// by itself once the OS does, which lets a logout go on.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        requestQuit("cmd-q")
        return .terminateLater
    }

    // MARK: commands

    /// Keeps a frame to show: true when none was waiting there, so main must be asked to show it.
    nonisolated private func showLater(_ to: String, _ image: AnyObject) -> Bool {
        unshownLock.lock()
        defer { unshownLock.unlock() }
        return unshown.updateValue(image, forKey: to) == nil
    }

    /// The newest frame for there, taken to be shown.
    nonisolated private func shown(_ to: String) -> AnyObject? {
        unshownLock.lock()
        defer { unshownLock.unlock() }
        return unshown.removeValue(forKey: to)
    }

    /// Runs a command. Called on the command thread: a flip copies the
    /// pixels here, before the OS can send another; AppKit work goes to main.
    nonisolated func command(_ c: [String: Any]) {
        guard let op = c["op"] as? String else {
            log("command without an op, ignored: \(c)")
            return
        }
        switch op {
        case "flip":
            guard let buffer = int(c["buffer"]), let w = int(c["w"]), let h = int(c["h"]) else {
                log("flip: needs buffer, w and h: \(c)")
                return
            }
            var dirty: (x: Int, y: Int, w: Int, h: Int)?
            if let d = c["dirty"] as? [String: Any], let x = int(d["x"]), let y = int(d["y"]), let dw = int(d["w"]), let dh = int(d["h"]) {
                dirty = (x, y, dw, dh)
            }
            guard let image = front.flip(buffer: buffer, w: w, h: h, dirty: dirty) else {
                log("flip: out of range: buffer \(buffer), \(w)x\(h)")
                return
            }
            guard showLater("", image) else { return }
            DispatchQueue.main.async { [self] in
                guard let image = shown("") else { return }
                flips += 1
                commands += 1
                screen.show(image)
            }
            return
        case "vsync":
            let on = bool(c["on"]) ?? false
            DispatchQueue.main.async { [self] in setVsync(on) }
        case "cursor":
            let x = int(c["x"]) ?? 0, y = int(c["y"]) ?? 0
            let visible = bool(c["visible"]) ?? true
            var shape: (w: Int, h: Int, hotx: Int, hoty: Int, image: CGImage)?
            if let s = c["shape"] as? [String: Any] {
                guard let w = int(s["w"]), let h = int(s["h"]), w > 0, h > 0, w <= 512, h <= 512,
                      let b64 = s["pixels"] as? String, let data = Data(base64Encoded: b64), data.count == w * h * 4,
                      let image = cursorImage(w: w, h: h, pixels: data) else {
                    log("cursor: bad shape, ignored")
                    return
                }
                shape = (w, h, int(s["hotx"]) ?? 0, int(s["hoty"]) ?? 0, image)
            }
            // where it is, only to warp it: the screen moves it with the pointer itself
            let warp = bool(c["warp"]) ?? false
            DispatchQueue.main.async { [self] in screen.setCursor(x: warp ? x : nil, y: warp ? y : nil, visible: visible, shape: shape) }
        case "title":
            let text = c["text"] as? String ?? ""
            DispatchQueue.main.async { [self] in window.title = text }
        case "fullscreen":
            let on = bool(c["on"]) ?? true
            DispatchQueue.main.async { [self] in
                if window.styleMask.contains(.fullScreen) != on { window.toggleFullScreen(nil) }
            }
        case "tx":
            guard let b64 = c["bytes"] as? String, let data = Data(base64Encoded: b64) else {
                log("tx: bytes are not base64")
                return
            }
            if Serial.present { Serial.transmit(data) } else { log("tx: there is no uart0; \(data.count) bytes dropped") }
        case "beep":
            DispatchQueue.main.async { [self] in sound.beep() }
        case "tone":
            let hz = double(c["hz"]) ?? 440, ms = double(c["ms"]) ?? 200, volume = double(c["volume"]) ?? 0.5
            DispatchQueue.main.async { [self] in sound.tone(hz: hz, ms: ms, volume: volume) }
        case "say":
            let text = c["text"] as? String ?? ""
            let voice = c["voice"] as? String
            DispatchQueue.main.async { [self] in sound.say(text, voice: voice) }
        case "haptic":
            let pattern = c["pattern"] as? String ?? "generic"
            DispatchQueue.main.async { [self] in sound.haptic(pattern) }
        case "clipboard":
            let text = c["text"] as? String ?? ""
            DispatchQueue.main.async { [self] in clipboard.set(text) }
        case "keychain":
            guard let act = c["act"] as? String, let account = c["account"] as? String else {
                log("keychain: needs act and account")
                return
            }
            Keychain.run(act: act, account: account, password: c["password"] as? String, bus: bus)
        case "display":
            let windows = bool(c["windows"]), take = bool(c["takeover"])
            if let keys = c["keys"] as? [String: Any] {
                // /etc/keys' chords and its "system": the Mac's own keys it wants, taken while taking over
                let chords = (keys["chords"] as? [Any])?.compactMap { $0 as? String } ?? []
                let system = bool(keys["system"]) ?? false
                DispatchQueue.main.async { [self] in
                    tap.bindings(chords, system: system)
                    sendMode()
                }
            }
            if let corner = c["corner"] as? [String: Any] {
                let top = double(corner["top"]) ?? 0, bottom = double(corner["bottom"]) ?? 0
                DispatchQueue.main.async { [self] in
                    corners = (CGFloat(top), CGFloat(bottom))
                    roundCorners()
                }
            }
            DispatchQueue.main.async { [self] in
                if let take { setTakeover(take) }
                if let windows { setWindows(windows) }
            }
        case "surface":
            guard let id = c["id"] as? String, let x = int(c["x"]), let y = int(c["y"]), let w = int(c["w"]), let h = int(c["h"]),
                  w >= 1, h >= 1, w <= fb.maxw, h <= fb.maxh else {
                log("surface: needs id, x, y, w and h: \(c)")
                return
            }
            let title = c["title"] as? String ?? ""
            let key = bool(c["key"]) ?? false
            panesLock.lock()
            if let pane = panes[id] { pane.resize(w: w, h: h) } else { panes[id] = Pane(fb: fb, w: w, h: h) }
            panesLock.unlock()
            DispatchQueue.main.async { [self] in
                guard windowsMode else { return }
                surfaces.update(id: id, x: x, y: y, w: w, h: h, title: title, key: key)
            }
        case "present":
            guard let id = c["id"] as? String, let buffer = int(c["buffer"]), let sx = int(c["sx"]), let sy = int(c["sy"]) else {
                log("present: needs id, buffer, sx and sy: \(c)")
                return
            }
            var dirty: (x: Int, y: Int, w: Int, h: Int)?
            if let d = c["dirty"] as? [String: Any], let x = int(d["x"]), let y = int(d["y"]), let dw = int(d["w"]), let dh = int(d["h"]) {
                dirty = (x, y, dw, dh)
            }
            panesLock.lock()
            let pane = panes[id]
            panesLock.unlock()
            guard let pane else {
                log("present: no surface \(id)")
                return
            }
            guard let surface = pane.present(buffer: buffer, sx: sx, sy: sy, dirty: dirty) else {
                log("present: out of range: \(c)")
                return
            }
            guard showLater(id, surface) else { return }
            DispatchQueue.main.async { [self] in
                guard let shown = shown(id) else { return }
                flips += 1
                surfaces.present(id: id, image: shown)
            }
        case "layers":
            // each tile's place and depth, and the pieces of it that changed, copied here into its IOSurfaces; shown together on main
            let buffer = int(c["buffer"]) ?? 0
            var placings: [Placing] = []
            panesLock.lock()
            for case let item as [String: Any] in (c["set"] as? [Any]) ?? [] {
                guard let id = item["id"] as? String else { continue }
                var p = Placing(id: id)
                if let x = int(item["x"]), let y = int(item["y"]), let w = int(item["w"]), let h = int(item["h"]), w >= 1, h >= 1, w <= fb.maxw, h <= fb.maxh {
                    p.frame = (x, y, w, h, double(item["z"]) ?? 0, parseShadow(item["shadow"]), parseOutline(item["shape"]))
                    if let pane = tilePanes[id] { pane.resize(w: w, h: h) } else { tilePanes[id] = Pane(fb: fb, w: w, h: h, keyed: true) }
                }
                if let d = item["paint"] as? [String: Any], let sx = int(d["sx"]), let sy = int(d["sy"]), let x = int(d["x"]), let y = int(d["y"]),
                   let dw = int(d["w"]), let dh = int(d["h"]) {
                    if let pane = tilePanes[id], let image = pane.present(buffer: buffer, sx: sx, sy: sy, dirty: (x, y, dw, dh)) {
                        p.image = image
                    } else {
                        log("layers: paint out of range: \(item)")
                    }
                }
                placings.append(p)
            }
            var drop: [String] = []
            for case let id as String in (c["drop"] as? [Any]) ?? [] {
                tilePanes.removeValue(forKey: id)
                drop.append(id)
            }
            panesLock.unlock()
            DispatchQueue.main.async { [self] in
                guard !windowsMode else { return }
                flips += 1
                stack.apply(placings, drop: drop)
            }
        case "unsurface":
            guard let id = c["id"] as? String else { return }
            panesLock.lock()
            panes.removeValue(forKey: id)
            panesLock.unlock()
            DispatchQueue.main.async { [self] in surfaces.remove(id: id) }
        case "web":
            DispatchQueue.main.async { [self] in web.open(c) }
        case "webpost":
            guard let id = c["id"] as? String else { return }
            let data = c["data"]
            DispatchQueue.main.async { [self] in web.post(id: id, data: data) }
        case "webclose":
            guard let id = c["id"] as? String else { return }
            DispatchQueue.main.async { [self] in web.close(id: id) }
        case "webshow":
            guard let id = c["id"] as? String else { return }
            let w = int(c["w"]) ?? 0, h = int(c["h"]) ?? 0
            DispatchQueue.main.async { [self] in web.show(id: id, w: w, h: h) }
        case "webtook":
            guard let id = c["id"] as? String, let n = int(c["n"]) else { return }
            DispatchQueue.main.async { [self] in web.took(id: id, n: n) }
        case "webinput":
            guard let id = c["id"] as? String, let events = c["events"] as? [[String: Any]] else { return }
            DispatchQueue.main.async { [self] in web.input(id: id, events: events) }
        case "webdo":
            guard let id = c["id"] as? String, let req = int(c["req"]), let n = int(c["n"]), let act = c["act"] as? String else { return }
            let value = c["value"]
            DispatchQueue.main.async { [self] in web.act(id: id, req: req, n: n, act: act, value: value) }
        case "glyphs":
            guard let font = c["font"] as? String, let size = double(c["size"]), let page = int(c["page"]) else {
                log("glyphs: needs font, size and page: \(c)")
                return
            }
            fonts.glyphs(font: font, size: size, bold: bool(c["bold"]) ?? false, page: page)
        case "textinput":
            let on = bool(c["on"]) ?? false
            let caret = NSRect(x: int(c["x"]) ?? 0, y: int(c["y"]) ?? 0, width: max(0, int(c["w"]) ?? 0), height: max(0, int(c["h"]) ?? 0))
            let surface = c["surface"] as? String
            let text = c["text"] as? String ?? ""
            let selection: (Int, Int)? =
                if let s = c["selection"] as? [Any], s.count == 2, let from = int(s[0]), let to = int(s[1]) { (from, to) } else { nil }
            DispatchQueue.main.async { [self] in textInput.set(on: on, surface: surface, caret: caret, text: text, selection: selection) }
        case "access":
            let tree = parseTree(c["tree"])
            let focus = c["focus"] as? String
            DispatchQueue.main.async { [self] in access.apply(tree, focus: focus) }
        // the Mac's other apps: each hands on at once, to its app's thread or the capture queue
        case "mac":
            mac.bound(c)
        case "macopen":
            mac.open(c)
        case "macdo":
            mac.act(c)
        case "mactook":
            mac.took(c)
        case "capture":
            capture.start(c)
        case "uncapture":
            capture.stop(c)
        case "took":
            capture.took(c)
        case "macinput":
            capture.input(c)
        case "menus":
            DispatchQueue.main.async { [self] in menus.show(c) }
        case "ready":
            log("the OS is ready")
        case "quit":
            DispatchQueue.main.async { [self] in osQuit() }
        default:
            log("unknown op \(op), ignored")
        }
        DispatchQueue.main.async { [self] in commands += 1 }
    }

    // MARK: quitting

    /// The person asked to power off: tell the OS, give it 3 seconds.
    func requestQuit(_ why: String) {
        guard !quitting else { return }
        quitting = true
        log("quit (\(why)): waiting up to 3 s for the OS")
        bus.send(1, [("why", why)])
        if bus.inProcess { powerOff() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.stopOS("did not exit within 3 s of the quit record") }
    }

    /// The OS powered off: the metal exits once it does.
    func osQuit() {
        log("the OS sent quit; waiting for it to exit")
        if bus.inProcess { powerOff() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.stopOS("sent quit but did not exit within 3 s") }
    }

    /// In process: ermosStop, off the main thread, which returns once the
    /// OS has written its card and its thread has ended; then the metal exits.
    private func powerOff() {
        guard !poweringOff else { return }
        poweringOff = true
        bus.stop { [self] in
            DispatchQueue.main.async { [self] in
                log("the OS powered off")
                finish(0)
            }
        }
    }

    private func stopOS(_ why: String) {
        guard !finished else { return }
        log("the OS \(why); stopping it")
        bus.kill(SIGTERM)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, !self.finished else { return }
            self.bus.kill(SIGKILL)
            self.finish(0)
        }
    }

    private func osExited(_ status: Int32) {
        let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        log("the OS exited (\((status & 0x7f) == 0 ? "status \(code)" : "signal \(status & 0x7f)"))")
        finish(quitting ? 0 : code)
    }

    private func finish(_ code: Int32) {
        guard !finished else { return }
        finished = true
        log("exiting: \(bus.recordsSent) records written, \(commands) commands run (\(flips) flips), \(vsyncs) vsyncs")
        bus.kill(SIGTERM)  // anything the OS left behind in its group
        flushLog()
        exit(code)
    }

    private var signalSources: [DispatchSourceSignal] = []

    /// SIGINT and SIGHUP come from the terminal (the serial line, when there
    /// is one), SIGTERM from outside: each asks the OS to power off as Cmd-Q
    /// does; a second one stops the OS without waiting.
    private func watchSignal(_ sig: Int32) {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            if self.quitting {
                self.stopOS("was still running at a second signal")
            } else {
                self.requestQuit(sig != SIGTERM && Serial.present ? "serial" : "cmd-q")
            }
        }
        source.resume()
        signalSources.append(source)
    }
}

// MARK: - helpers for commands

func int(_ v: Any?) -> Int? {
    guard let d = (v as? NSNumber)?.doubleValue, d.isFinite, abs(d) < 1e9 else { return nil }
    return Int(d.rounded())
}

func double(_ v: Any?) -> Double? {
    (v as? NSNumber)?.doubleValue
}

func bool(_ v: Any?) -> Bool? {
    if let b = v as? Bool { return b }
    return (v as? NSNumber).map { $0.doubleValue != 0 }
}

/// The cursor plane's image: w × h u32 0xAARRGGBB, little-endian, premultiplied here.
func cursorImage(w: Int, h: Int, pixels: Data) -> CGImage? {
    var bytes = [UInt8](pixels)
    for i in stride(from: 0, to: bytes.count, by: 4) {
        let a = UInt16(bytes[i + 3])
        if a == 255 { continue }
        bytes[i] = UInt8((UInt16(bytes[i]) * a + 127) / 255)
        bytes[i + 1] = UInt8((UInt16(bytes[i + 1]) * a + 127) / 255)
        bytes[i + 2] = UInt8((UInt16(bytes[i + 2]) * a + 127) / 255)
    }
    guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
    let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: info),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

// MARK: - start

_ = clockStart
MainActor.assumeIsolated {
    let app = MetalApp.shared
    app.setActivationPolicy(.regular)
    let machine = Machine(config: parseArguments())
    app.delegate = machine
    machine.boot()
    app.run()
}

/// A view that holds others and takes no events itself: a click that is on
/// none of its subviews goes to the view beneath it.
final class PassView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        let v = super.hitTest(point)
        return v === self ? nil : v
    }
}
