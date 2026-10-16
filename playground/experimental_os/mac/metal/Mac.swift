// Mac.swift: the Mac's other apps, as a device (irq 51, ../METAL.md). Every
// running app's accessibility tree, the whole system's, mirrored for the
// OS's mac driver: each app's elements sent as items (add, set, drop),
// kept live by an AXObserver an app and NSWorkspace's list of apps, within
// the bounds /etc/mac gives (the `mac` command), with every cut said; and
// the acts the OS asks for (macdo), done on the app's thread.
//
// Each mirrored app has a run: a thread of its own, with its own run loop,
// observer and tree. An AX read is a message answered on the app's main
// thread, so a slow app holds only its own. A run is made by start and
// ended by stop, and nothing of one run is ever another's, so a stop and a
// start in quick succession never meet. The main thread only hears
// NSWorkspace and hands on what it hears; the rest is this device's queue.
// Ax.swift is the reading and the walk.
//
// Nothing is sent before the first `mac` command: the driver is listening
// then. A `mac` command with sync (the driver's first, also after it
// started again) has everything sent again: access, every app, every tree.
// The walk goes at the pace the driver applies it: no more than `credit`
// items sent and not yet taken (mactook).

import AppKit
import ApplicationServices

/// A captured window's place, title and state, from its node (Capture.swift).
struct MacWindow: Equatable {
    var x = 0, y = 0, w = 0, h = 0
    var title = ""
    var minimized = false
}

final class Mac: @unchecked Sendable {
    /// /etc/mac, as the `mac` command gives it.
    struct Settings: Equatable {
        var on = true
        var bounds = Ax.Bounds()
        var total = 40000
        var hz = 10.0
        var skip: Set<String> = []
    }

    private let bus: Bus
    private let scale: Double
    /// apps, settings and access: everything but a run's own work
    private let queue = DispatchQueue(label: "ermine.mac", qos: .utility)
    // the queue's
    private var apps: [pid_t: App] = [:]
    private var settings = Settings()
    /// the mac command came: the driver listens, AX may be read
    private var started = false
    private var ax = false
    private var capture = false
    private var asleep = false
    private var sweeps = 0
    private var timer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []
    private var listing: NSKeyValueObservation?
    // every run's, under the lock
    private let lock = NSLock()
    private var last = 0
    private var total = 0
    private var limit = 40000
    /// the total was spent: budget cuts are walked again when it comes back
    private var full = false
    private var tokens = 500.0
    private var filled = CFAbsoluteTimeGetCurrent()
    /// items sent and not yet taken by the driver
    private var owed = 0
    /// when each tier last walked: a lower tier waits while a higher one walks
    private var walked = [0.0, 0.0, 0.0]
    /// pids with a window on screen
    private var shown = Set<pid_t>()

    /// AX messages a second, every app together, and an app alone.
    static let pace = 5000.0
    static let apace = 2000.0
    /// How often each run wakes while it has work, how long it waits for
    /// more changes under one parent before reading its children, and the
    /// longest a tick may ask, whatever its count.
    static let tick = 0.05
    /// Items a tree record.
    static let most = 250
    /// Items sent and not yet taken, at most, before the walk waits.
    static let credit = 500
    /// A sweep's child counts a second, an app.
    static let checks = 100.0
    /// Notices an app keeps to resolve; more are left to the sweep.
    static let notices = 256

    init(bus: Bus, scale: Double) {
        self.bus = bus
        var s = Settings()
        s.bounds.scale = scale
        settings = s
        self.scale = scale
    }

    // MARK: - the shared count and pace

    /// A new n: one counter for every app, never reused in a run.
    func number() -> Int {
        lock.lock()
        defer { lock.unlock() }
        last += 1
        return last
    }

    /// One element from the total budget.
    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard total < limit else {
            full = true
            return false
        }
        total += 1
        return true
    }

    func give(_ k: Int) {
        lock.lock()
        total = max(0, total - k)
        // room again after the total was spent: the budget cuts walked again
        let heal = full && total < limit - max(16, limit / 50)
        if heal { full = false }
        lock.unlock()
        if heal { queue.async { [self] in for app in apps.values { app.heal() } } }
    }

    /// Up to `want` messages now, from the pace every app shares; none
    /// while the driver owes credit, or while a run of a higher tier (0
    /// the active app, 1 an app with a window on screen, 2 the rest)
    /// walked in the last 200 ms. `spent` pays back what a tick took past
    /// what it was granted.
    func grant(_ want: Int, tier: Int = 0, spent: Int = 0) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let t = CFAbsoluteTimeGetCurrent()
        tokens = min(Mac.pace * Mac.tick * 4, tokens + (t - filled) * Mac.pace) - Double(spent)
        filled = t
        guard want > 0, owed < Mac.credit else { return 0 }
        for k in 0..<min(tier, 3) where t - walked[k] < 0.2 { return 0 }
        let k = max(0, min(want, Int(tokens)))
        tokens -= Double(k)
        return k
    }

    /// A run of that tier is walking.
    func walking(_ tier: Int) {
        lock.lock()
        walked[min(max(tier, 0), 2)] = CFAbsoluteTimeGetCurrent()
        lock.unlock()
    }

    /// An app's tier: 0 active, 1 a window on screen, 2 the rest.
    func tier(_ a: NSRunningApplication) -> Int {
        if a.isActive { return 0 }
        lock.lock()
        defer { lock.unlock() }
        return shown.contains(a.processIdentifier) ? 1 : 2
    }

    /// Items sent to the driver.
    func sent(_ k: Int) {
        lock.lock()
        owed += k
        lock.unlock()
    }

    /// mactook {items}: the driver applied them.
    func took(_ c: [String: Any]) {
        let k = int(c["items"]) ?? 0
        lock.lock()
        owed = max(0, owed - k)
        lock.unlock()
    }

    // MARK: - start

    /// Listens to NSWorkspace and keeps the list of apps; sends nothing
    /// until the mac command. On main.
    @MainActor
    func start() {
        let ws = NSWorkspace.shared.notificationCenter
        let names: [(Notification.Name, String)] = [
            (NSWorkspace.didLaunchApplicationNotification, "launch"),
            (NSWorkspace.didTerminateApplicationNotification, "quit"),
            (NSWorkspace.didActivateApplicationNotification, "activate"),
            (NSWorkspace.didDeactivateApplicationNotification, "change"),
            (NSWorkspace.didHideApplicationNotification, "change"),
            (NSWorkspace.didUnhideApplicationNotification, "change"),
        ]
        for (name, what) in names {
            observers.append(ws.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                guard let self, let a = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                self.queue.async { self.heard(what, a) }
            })
        }
        for (name, on) in [(NSWorkspace.willSleepNotification, true), (NSWorkspace.didWakeNotification, false),
                           (NSWorkspace.screensDidSleepNotification, true), (NSWorkspace.screensDidWakeNotification, false)] {
            observers.append(ws.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                self.queue.async { self.asleep = on }
            })
        }
        // another Space: windows join and leave AXWindows with no notice of their own
        observers.append(ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.queue.async { for app in self.apps.values { app.again() } }
        })
        observers.append(DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                // the change lands a moment after the notice
                self.queue.asyncAfter(deadline: .now() + 0.5) { self.poll() }
            })
        // the list itself, as Apple says to watch it: launch and terminate
        // notices are not posted for background and UIElement apps, the
        // accessory ones listed here
        listing = NSWorkspace.shared.observe(\.runningApplications, options: [.new, .old]) { [weak self] ws, _ in
            guard let self else { return }
            let now = ws.runningApplications
            self.queue.async { self.list(now) }
        }
        let running = NSWorkspace.shared.runningApplications
        queue.async { [self] in
            ax = AXIsProcessTrusted()
            capture = CGPreflightScreenCaptureAccess()
            list(running)
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(200))
            t.setEventHandler { [weak self] in
                guard let self else { return }
                // a backstop for a quit nothing said
                for app in self.apps.values where app.running.isTerminated { self.heard("quit", app.running) }
                // and for a launch: an app just launched can say it is prohibited until it has finished
                // launching (Electron's do), so it was passed over; listed again, it joins once it says what it is
                DispatchQueue.main.async {
                    let now = NSWorkspace.shared.runningApplications
                    self.queue.async { self.list(now) }
                }
                self.poll()
                self.sweep()
            }
            t.resume()
            timer = t
        }
    }

    /// The running apps now: the new ones launched, the missing ones quit. On the queue.
    private func list(_ now: [NSRunningApplication]) {
        let pids = Set(now.map(\.processIdentifier))
        for a in now { heard("launch", a) }
        for (pid, app) in apps where !pids.contains(pid) { heard("quit", app.running) }
    }

    /// What NSWorkspace said of an app. On the queue.
    private func heard(_ what: String, _ a: NSRunningApplication) {
        let pid = a.processIdentifier
        switch what {
        case "launch":
            guard Ax.listed(a), apps[pid] == nil, !a.isTerminated else { return }
            let app = App(mac: self, bus: bus, running: a, n: number())
            apps[pid] = app
            app.state = want(app)
            tell(app)
            mirror(app)
        case "quit":
            guard let app = apps.removeValue(forKey: pid) else { return }
            app.stop(drop: false)
            if started { bus.send(51, [("event", "quit"), ("pid", Int(pid))]) }
        case "activate":
            guard let app = apps[pid] else { return }
            tell(app)
            // a mute app is asked again when a person comes to it
            if app.state == "mute" {
                app.state = "launching"
                mirror(app)
            }
            focus(app)
        default:
            if let app = apps[pid] { tell(app) }
        }
    }

    /// The system's focus, now that app is active: its focused element, or
    /// for ermineOS itself (never walked) the app alone. On the queue.
    private func focus(_ app: App) {
        guard started else { return }
        if app.state == "self" || !app.live {
            bus.send(51, [("event", "focus"), ("pid", Int(app.pid)), ("n", 0)])
        } else {
            app.focus()
        }
    }

    /// An app's state as the settings and access have it; hung, launching
    /// and mute are its run's to say.
    private func want(_ app: App) -> String {
        if app.pid == getpid() { return "self" }
        if let b = app.running.bundleIdentifier, settings.skip.contains(b) { return "skipped" }
        if !ax { return "denied" }
        return ["hung", "launching", "mute"].contains(app.state) ? app.state : "running"
    }

    /// Sends an app's record if any of it changed, once the driver listens. On the queue.
    private func tell(_ app: App) {
        guard started, apps[app.pid] === app else { return }
        let fields = Ax.record(app.running, n: app.n, state: app.state)
        let text = json(fields)
        guard text != app.told else { return }
        app.told = text
        bus.send(51, fields)
    }

    /// Its run says an app's state.
    fileprivate func state(_ app: App, _ state: String) {
        queue.async { [self] in
            guard apps[app.pid] === app, app.state != state else { return }
            app.state = state
            tell(app)
        }
    }

    /// Its run never heard AX answer: its thread stopped, the app listed
    /// as mute, asked again when it is activated.
    fileprivate func mute(_ app: App) {
        queue.async { [self] in
            guard apps[app.pid] === app else { return }
            app.stop(drop: true)
            app.state = "mute"
            tell(app)
        }
    }

    /// Starts or stops an app's mirror as the settings and access say. On the queue.
    private func mirror(_ app: App) {
        let s = want(app)
        let should = started && settings.on && !["self", "skipped", "denied", "mute"].contains(s)
        if should {
            if app.live {
                app.rebound(settings.bounds, hz: settings.hz)
            } else {
                app.start(settings.bounds, hz: settings.hz)
            }
        } else if app.live {
            app.stop(drop: true)
        }
        if app.state != s {
            app.state = s
            tell(app)
        }
    }

    /// Access, as TCC has it now. On the queue.
    private func poll() {
        let a = AXIsProcessTrusted(), c = CGPreflightScreenCaptureAccess()
        guard a != ax || c != capture else { return }
        let lost = ax && !a
        ax = a
        capture = c
        if started { bus.send(51, [("event", "access"), ("ax", ax), ("capture", capture)]) }
        // revoked: every tree dropped, a stale mirror being a lie
        if lost { for app in apps.values where ["hung", "launching", "mute"].contains(app.state) { app.state = "running" } }
        for app in apps.values { mirror(app) }
    }

    /// The pids with a layer-0 window on screen, for the tiers.
    private func onscreen() {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return }
        var s = Set<pid_t>()
        for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
            if let pid = w[kCGWindowOwnerPID as String] as? Int { s.insert(pid_t(pid)) }
        }
        lock.lock()
        shown = s
        lock.unlock()
    }

    /// Every 2 s the active app, every 10 s every app with a window on screen. On the queue.
    private func sweep() {
        guard started, settings.on, ax, !asleep else { return }
        sweeps += 1
        if sweeps % 5 == 0 { onscreen() }
        for app in apps.values where app.live && tier(app.running) < (sweeps % 5 == 0 ? 2 : 1) { app.sweep() }
    }

    // MARK: - commands, from the command thread

    /// mac {on, depth, app, total, rows, text, hz, skip, sync?}
    func bound(_ c: [String: Any]) {
        queue.async { [self] in
            var s = settings
            s.on = bool(c["on"]) ?? s.on
            s.bounds.depth = max(1, int(c["depth"]) ?? s.bounds.depth)
            s.bounds.app = max(0, int(c["app"]) ?? s.bounds.app)
            s.bounds.rows = max(0, int(c["rows"]) ?? s.bounds.rows)
            s.bounds.text = max(0, int(c["text"]) ?? s.bounds.text)
            s.total = max(0, int(c["total"]) ?? s.total)
            s.hz = max(0.1, double(c["hz"]) ?? s.hz)
            if let skip = c["skip"] as? [Any] { s.skip = Set(skip.compactMap { $0 as? String }) }
            // the driver is new (its first command says sync): everything again, the trees as they are
            let sync = !started || (bool(c["sync"]) ?? false)
            if !started {
                started = true
                AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
                onscreen()
            }
            settings = s
            lock.lock()
            let used = total
            limit = s.total
            if sync { owed = 0 }
            lock.unlock()
            if sync {
                bus.send(51, [("event", "access"), ("ax", ax), ("capture", capture)])
                for app in apps.values.sorted(by: { $0.pid < $1.pid }) {
                    app.told = ""
                    tell(app)
                    app.resend()
                }
            }
            for app in apps.values {
                // a smaller total: each tree trimmed to its share, the rest kept
                if used > s.total { app.trim(Double(s.total) / Double(max(1, used))) }
                mirror(app)
                if used < s.total { app.heal() }
            }
            log("mac: \(s.on ? "on" : "off"), depth \(s.bounds.depth), app \(s.bounds.app), total \(s.total), rows \(s.bounds.rows), text \(s.bounds.text), hz \(s.hz), \(s.skip.count) skipped")
        }
    }

    /// macopen {pid, n, depth}
    func open(_ c: [String: Any]) {
        guard let pid = int(c["pid"]), let n = int(c["n"]) else {
            log("macopen: needs pid and n: \(c)")
            return
        }
        let depth = int(c["depth"]) ?? 12
        queue.async { [self] in apps[pid_t(pid)]?.open(n, depth: depth) }
    }

    /// macdo {req, pid, n, act, to?, key?, point?, app?}
    func act(_ c: [String: Any]) {
        guard let req = int(c["req"]), let act = c["act"] as? String else {
            log("macdo: needs req and act: \(c)")
            return
        }
        let pid = pid_t(int(c["pid"]) ?? 0), n = int(c["n"]) ?? 0
        let to = c["to"] as? [String: Any], key = c["key"] as? String, name = c["app"] as? String
        var point: CGPoint?
        if let p = c["point"] as? [String: Any], let x = double(p["x"]), let y = double(p["y"]) { point = CGPoint(x: x, y: y) }
        queue.async { [self] in
            if pid == 0 && n == 0 {
                if act == "launch" { return launch(req, name) }
                ask(req, act: act, key: key)
                return
            }
            guard let app = apps[pid] else { return done(req, "gone") }
            switch app.state {
            case "self", "skipped": return done(req, "refused")
            default: break
            }
            if n == app.n, ["activate", "hide", "unhide", "quit", "focus"].contains(act) {
                let a = app.running
                DispatchQueue.main.async { [self] in
                    let ok: Bool =
                        switch act {
                        case "hide": a.hide()
                        case "unhide": a.unhide()
                        case "quit": a.terminate()
                        default: a.activate()
                        }
                    done(req, ok ? nil : "refused")
                }
                return
            }
            switch app.state {
            case "denied": return done(req, "denied")
            case "hung": return done(req, "hung")
            default: break
            }
            guard app.live else { return done(req, settings.on ? "refused" : "unsupported") }
            app.act(req, n: n, act: act, to: to, key: key, point: point)
        }
    }

    /// An act on /dev/mac itself: ask, the system's prompt. Any program
    /// may place it; the prompt is the person's to answer (METAL.md).
    private func ask(_ req: Int, act: String, key: String?) {
        guard act == "ask", key == "ax" || key == "capture" else { return done(req, "bad") }
        DispatchQueue.main.async { [self] in
            if key == "ax" {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            } else {
                _ = CGRequestScreenCaptureAccess()
            }
            done(req, nil)
            queue.async { self.poll() }
        }
    }

    /// An act on /dev/mac itself: launch, an app started (or found running)
    /// by NSWorkspace, as the Finder starts one: activated as macOS
    /// activates a launch, nothing more. Its name (TextEdit), bundle id
    /// (com.apple.TextEdit) or path (/Applications/TextEdit.app); the answer
    /// its pid. Never quits nor touches another app.
    private func launch(_ req: Int, _ name: String?) {
        guard let name, !name.isEmpty, let url = Mac.bundle(name) else { return done(req, "bad") }
        DispatchQueue.main.async { [self] in
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { [self] app, error in
                if let app, error == nil { done(req, nil, value: Int(app.processIdentifier)) } else { done(req, "refused") }
            }
        }
    }

    /// An app's bundle: a path, a bundle id, or a name in the Applications folders.
    private static func bundle(_ name: String) -> URL? {
        let files = FileManager.default
        if name.hasPrefix("/") || name.hasPrefix("~") {
            let path = (name as NSString).expandingTildeInPath
            return files.fileExists(atPath: path) ? URL(fileURLWithPath: path) : nil
        }
        if name.contains("."), !name.hasSuffix(".app"), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return url }
        let file = name.hasSuffix(".app") ? name : name + ".app"
        let home = files.homeDirectoryForCurrentUser.path
        for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", home + "/Applications"] {
            let path = folder + "/" + file
            if files.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
        }
        return nil
    }

    fileprivate func done(_ req: Int, _ error: String?, value: Any? = nil) {
        var fields: Fields = [("event", "done"), ("req", req)]
        if let error { fields.append(("error", error)) }
        if let value { fields.append(("value", value)) }
        bus.send(51, fields)
    }

    // MARK: - for Capture.swift

    /// A window element's place now, read again, on its app's thread; nil
    /// if there is none, with why: `gone`, or `unmirrored` (the app not
    /// mirrored now: /etc/mac off, skipped, denied, launching, mute).
    func window(pid: pid_t, n: Int, _ reply: @escaping (MacWindow?, String?) -> Void) {
        queue.async { [self] in
            guard let app = apps[pid] else { return reply(nil, "gone") }
            app.window(n, reply)
        }
    }

    /// Calls change, on the app's thread, whenever that window's place,
    /// title or state changes, and with nil when it goes (why: `gone`, or
    /// `unmirrored` when the mirror stopped under it); nil stops it.
    func watch(pid: pid_t, n: Int, view: String, _ change: ((MacWindow?, String?) -> Void)?) {
        queue.async { [self] in
            guard let app = apps[pid] else {
                change?(nil, "gone")
                return
            }
            app.watch(n, view: view, change)
        }
    }

    // MARK: - an app

    /// One running app: its record's state, and, while it is mirrored, its run.
    final class App: @unchecked Sendable {
        let pid: pid_t
        let n: Int
        let running: NSRunningApplication
        private unowned let mac: Mac
        private let bus: Bus
        // the device's queue's
        var state = "running"
        var told = ""
        private var run: Run?
        var live: Bool { run != nil }

        init(mac: Mac, bus: Bus, running: NSRunningApplication, n: Int) {
            self.mac = mac
            self.bus = bus
            self.running = running
            pid = running.processIdentifier
            self.n = n
        }

        /// A new run: its thread, and the walk. On the device's queue.
        func start(_ bounds: Ax.Bounds, hz: Double) {
            let r = Run(app: self, mac: mac, bus: bus, bounds: bounds, hz: hz)
            run = r
            r.start()
        }

        /// The run ended; with drop, its tree dropped first (the app itself
        /// stays). A later start makes a new run, which this one never touches.
        func stop(drop: Bool) {
            guard let r = run else { return }
            run = nil
            r.stop(drop: drop)
        }

        func rebound(_ b: Ax.Bounds, hz: Double) { run?.rebound(b, hz: hz) }
        func trim(_ ratio: Double) { run?.trim(ratio) }
        func heal() { run?.heal() }
        func resend() { run?.resend() }
        func sweep() { run?.sweep() }
        func again() { run?.again() }
        func focus() { run?.focus() }
        func open(_ n: Int, depth: Int) { run?.open(n, depth: depth) }

        func act(_ req: Int, n: Int, act: String, to: [String: Any]?, key: String?, point: CGPoint?) {
            guard let run else { return mac.done(req, "gone") }
            run.act(req, n: n, act: act, to: to, key: key, point: point)
        }

        func window(_ n: Int, _ reply: @escaping (MacWindow?, String?) -> Void) {
            guard let run else { return reply(nil, "unmirrored") }
            run.window(n, reply)
        }

        func watch(_ n: Int, view: String, _ change: ((MacWindow?, String?) -> Void)?) {
            guard let run else {
                change?(nil, "unmirrored")
                return
            }
            run.watch(n, view: view, change)
        }
    }

    // MARK: - a run

    /// One mirror of one app, from start to stop: its thread and run loop,
    /// observer, tree and queues. Its fields are its thread's, but the inbox.
    final class Run: @unchecked Sendable {
        let app: App
        let pid: pid_t
        let n: Int
        private unowned let mac: Mac
        private let bus: Bus
        // the inbox: blocks for its thread, each with what to do instead once it stopped
        private let lock = NSLock()
        private var inbox: [(run: () -> Void, otherwise: (() -> Void)?)] = []
        private var closed = false
        private var loop: CFRunLoop?
        // its own thread's, from here down
        private var ended = false
        private var tree: Ax.Tree?
        private var observer: AXObserver?
        private var timer: CFRunLoopTimer?
        private var bounds: Ax.Bounds
        private var hz: Double
        /// elements whose own keys are read again, as the pace allows
        private var values = Set<Int>()
        /// parents whose children are read again, and when (50 ms after the first change)
        private var parents: [Int: Double] = [:]
        /// notices whose element is not mirrored: its nearest mirrored
        /// ancestor found as the pace allows, never in the callback
        private var unplaced: [(e: AXUIElement, name: String)] = []
        /// a sweep's parents, their child counts to check, and when the last sweep ended
        private var checks: [Int] = []
        private var swept = 0.0
        /// scroll areas scrolled: their elements' frames read again once it settles
        private var scrolled: [Int: Double] = [:]
        private var items: [Ax.Pairs] = []
        private var flushed = 0.0
        private var later: [(at: Double, run: () -> Void)] = []
        /// until when a hung app is left alone
        private var hung = 0.0
        private var tries = 0
        /// an element's timeouts so far, for its back-off
        private var slows: [Int: Int] = [:]
        private var opens: [Int: Int] = [:]
        private var watchers: [Int: [String: (MacWindow?, String?) -> Void]] = [:]
        private var seen: [Int: MacWindow] = [:]

        init(app: App, mac: Mac, bus: Bus, bounds: Ax.Bounds, hz: Double) {
            self.app = app
            pid = app.pid
            n = app.n
            self.mac = mac
            self.bus = bus
            self.bounds = bounds
            self.hz = hz
        }

        /// Runs a block on its thread; once it stopped, `otherwise` instead,
        /// so an act or a window asked of it is always answered.
        private func perform(_ block: @escaping () -> Void, otherwise: (() -> Void)? = nil) {
            lock.lock()
            guard !closed, let loop else {
                lock.unlock()
                otherwise?()
                return
            }
            inbox.append((block, otherwise))
            lock.unlock()
            CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) { [self] in drain() }
            CFRunLoopWakeUp(loop)
        }

        private func drain() {
            lock.lock()
            let list = inbox
            inbox.removeAll()
            lock.unlock()
            for b in list {
                if ended { b.otherwise?() } else { b.run() }
            }
        }

        func start() {
            let ready = DispatchSemaphore(value: 0)
            let thread = Thread { [self] in
                let l = CFRunLoopGetCurrent()!
                lock.lock()
                loop = l
                lock.unlock()
                let t = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 1e9, 1e9, 0, 0) { [unowned self] _ in tick() }
                timer = t
                CFRunLoopAddTimer(l, t, .defaultMode)
                ready.signal()
                begin()
                CFRunLoopRun()
            }
            thread.name = "ermine.mac.\(pid)"
            thread.qualityOfService = .utility
            thread.start()
            ready.wait()
        }

        func stop(drop: Bool) {
            perform { [self] in
                if let tree {
                    if drop {
                        tree.clear()
                        flush(force: true)
                    } else {
                        mac.give(tree.count)
                    }
                }
                for (_, list) in watchers { for (_, change) in list { change(nil, drop ? "unmirrored" : "gone") } }
                watchers = [:]
                if let observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }
                observer = nil
                if let timer { CFRunLoopTimerInvalidate(timer) }
                timer = nil
                tree = nil
                ended = true
                lock.lock()
                closed = true
                let rest = inbox
                inbox.removeAll()
                lock.unlock()
                for b in rest { b.otherwise?() }
                CFRunLoopStop(CFRunLoopGetCurrent())
            }
        }

        /// New bounds: every element kept; what they cut or uncut walked again.
        func rebound(_ b: Ax.Bounds, hz: Double) {
            perform { [self] in
                self.hz = hz
                guard b != bounds, let tree else { return }
                bounds = b
                if tree.rebound(b) { values.formUnion(tree.nodes.keys) }
                arm()
            }
        }

        /// A smaller total: down to its share, the newest dropped.
        func trim(_ ratio: Double) {
            perform { [self] in
                guard let tree else { return }
                tree.trim(Int(Double(tree.count) * min(1, ratio)))
                arm()
            }
        }

        /// Budget back: what was cut for it walked again.
        func heal() {
            perform { [self] in
                guard let tree else { return }
                for k in tree.starved { tree.walk(k) }
                arm()
            }
        }

        /// The driver is new: every element sent again, as it is.
        func resend() {
            perform { [self] in
                guard let tree else { return }
                flush(force: true)
                tree.resend()
                flush(force: true)
                arm()
            }
        }

        func sweep() {
            perform { [self] in
                guard let tree, checks.isEmpty, hung == 0, CFAbsoluteTimeGetCurrent() - swept >= 2 else { return }
                checks = tree.sweep()
                arm()
            }
        }

        /// Its windows read again: another Space.
        func again() {
            perform { [self] in
                guard let tree else { return }
                tree.walk(tree.root.n)
                arm()
            }
        }

        /// The system's focus, now that it is active: its focused element, or its nearest mirrored ancestor.
        func focus() {
            perform { [self] in
                guard let tree, hung == 0 else { return }
                let e = Ax.element(Ax.copy(tree.app, "AXFocusedUIElement"))
                say(e.flatMap { tree.nearest($0) } ?? 0)
            }
        }

        private func say(_ k: Int) {
            // the element is there before the record names it
            flush(force: true)
            bus.send(51, [("event", "focus"), ("pid", Int(pid)), ("n", k)])
        }

        func open(_ n: Int, depth: Int) {
            perform { [self] in
                guard let tree else { return }
                let g = (opens[n] ?? 0) + 1
                opens[n] = g
                if depth > 0 {
                    tree.open(n, depth: depth)
                } else {
                    // back to the cuts 5 s after the last open went
                    later.append((CFAbsoluteTimeGetCurrent() + 5, { [self] in
                        guard opens[n] == g else { return }
                        opens[n] = nil
                        self.tree?.open(n, depth: nil)
                    }))
                }
                arm()
            }
        }

        func act(_ req: Int, n: Int, act: String, to: [String: Any]?, key: String?, point: CGPoint?) {
            perform({ [self] in
                guard let tree else { return mac.done(req, "gone") }
                guard hung == 0 else { return mac.done(req, "hung") }
                guard let x = tree.nodes[n] else { return mac.done(req, n == self.n ? "bad" : "gone") }
                let r = Ax.act(x.element, act: act, to: to, key: key, at: point, bounds: bounds)
                // the element's node shows the outcome at the next flush
                if n != self.n { values.insert(n) }
                mac.done(req, r.error, value: r.value)
                arm()
            }, otherwise: { [mac] in mac.done(req, "gone") })
        }

        func window(_ n: Int, _ reply: @escaping (MacWindow?, String?) -> Void) {
            perform({ [self] in
                tree?.update(n)
                let w = place(n)
                reply(w, w == nil ? "gone" : nil)
            }, otherwise: { reply(nil, "unmirrored") })
        }

        func watch(_ n: Int, view: String, _ change: ((MacWindow?, String?) -> Void)?) {
            perform({ [self] in
                watchers[n, default: [:]][view] = change
                if watchers[n]?.isEmpty ?? false { watchers[n] = nil }
                seen[n] = place(n)
                if let change, seen[n] == nil { change(nil, "gone") }
            }, otherwise: { change?(nil, "unmirrored") })
        }

        // MARK: its thread

        /// Waits until AX answers (0.5, 1, 2, 4 s while it does not; a
        /// helper, once), then observes and walks. Never answered: mute.
        private func begin() {
            var v: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), "AXRole" as CFString, &v)
            if err != .success, err != .apiDisabled {
                guard tries < (Ax.helper(app.running) ? 0 : 4) else { return mac.mute(app) }
                let wait = 0.5 * Double(1 << tries)
                tries += 1
                mac.state(app, "launching")
                later.append((CFAbsoluteTimeGetCurrent() + wait, { [self] in begin() }))
                arm(wait)
                return
            }
            let tree = Ax.Tree(pid: pid, n: n, bounds: bounds, number: { [unowned mac] in mac.number() },
                               take: { [unowned mac] in mac.take() }, give: { [unowned mac] in mac.give($0) },
                               sink: { [unowned self] in items.append($0) })
            self.tree = tree
            observe(tree.app)
            mac.state(app, "running")
            tree.walk(tree.root.n)
            arm()
        }

        /// The notifications an app's element gives for all of it.
        static let notices = [
            kAXCreatedNotification, kAXUIElementDestroyedNotification, kAXValueChangedNotification, kAXTitleChangedNotification,
            kAXSelectedTextChangedNotification, kAXSelectedChildrenChangedNotification, kAXRowCountChangedNotification,
            kAXLayoutChangedNotification, kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification,
            kAXMainWindowChangedNotification, kAXWindowCreatedNotification, kAXWindowMovedNotification,
            kAXWindowResizedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification,
            kAXMenuOpenedNotification, kAXMenuClosedNotification, kAXMovedNotification, kAXResizedNotification,
            kAXApplicationActivatedNotification, kAXApplicationDeactivatedNotification,
            kAXApplicationHiddenNotification, kAXApplicationShownNotification,
        ]

        private func observe(_ app: AXUIElement) {
            var o: AXObserver?
            let callback: AXObserverCallback = { _, element, name, refcon in
                guard let refcon else { return }
                Unmanaged<Run>.fromOpaque(refcon).takeUnretainedValue().notice(element, name as String)
            }
            guard AXObserverCreate(pid, callback, &o) == .success, let o else { return }
            let me = Unmanaged.passUnretained(self).toOpaque()
            for name in Run.notices { _ = AXObserverAddNotification(o, app, name as CFString, me) }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode)
            observer = o
        }

        /// A parent whose children are to be read again, 50 ms after its first change.
        private func touch(_ n: Int?) {
            guard let n, parents[n] == nil else { return }
            parents[n] = CFAbsoluteTimeGetCurrent() + Mac.tick
        }

        /// An element not mirrored, for the tick to place. Past the cap, left to the sweep.
        private func hold(_ e: AXUIElement, _ name: String) {
            if unplaced.count < Mac.notices { unplaced.append((e, name)) }
        }

        /// A notification: only what the table knows, no AX message here;
        /// an element the table does not know is placed later, paced.
        private func notice(_ e: AXUIElement, _ name: String) {
            guard let tree, !ended else { return }
            switch name {
            case kAXFocusedUIElementChangedNotification:
                // the system's focus only from the active app
                guard app.running.isActive else { break }
                if let k = tree.find(e) {
                    values.insert(k)
                    say(k)
                } else {
                    hold(e, name)
                }
            case kAXValueChangedNotification, kAXTitleChangedNotification, kAXSelectedTextChangedNotification,
                 kAXMovedNotification, kAXResizedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification,
                 kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification:
                guard let k = tree.find(e), let x = tree.nodes[k] else { break }
                values.insert(k)
                // a scroll bar moved: its scroll area's tables show other rows,
                // and every frame under it moved; read again once it settles
                if name == kAXValueChangedNotification, x.role == "AXScrollBar", let area = tree.nodes[x.parent] {
                    for c in area.kids where tree.nodes[c]?.table ?? false { touch(c) }
                    scrolled[area.n] = CFAbsoluteTimeGetCurrent() + 0.3
                }
            case kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification:
                // main and focus move between windows: each top-level one read again
                for k in tree.root.kids { values.insert(k) }
            case kAXCreatedNotification, kAXWindowCreatedNotification, kAXMenuOpenedNotification, kAXMenuClosedNotification,
                 kAXLayoutChangedNotification, kAXRowCountChangedNotification, kAXSelectedChildrenChangedNotification:
                if name == kAXWindowCreatedNotification {
                    touch(tree.root.n)
                } else if name != kAXCreatedNotification, let k = tree.find(e) {
                    touch(k)
                    if name == kAXSelectedChildrenChangedNotification, let x = tree.nodes[k] {
                        for c in x.kids.prefix(bounds.rows) { values.insert(c) }
                    }
                } else {
                    hold(e, name)
                }
            case kAXUIElementDestroyedNotification:
                if let k = tree.find(e) { touch(tree.nodes[k]?.parent) }
            default:
                // activated, hidden and shown: NSWorkspace says them too
                mac.queue.async { [mac, app] in mac.tell(app) }
            }
            arm()
        }

        /// A held notice placed: its nearest mirrored ancestor, touched;
        /// under a web area or past the depth, ignored (nothing there is mirrored).
        private func resolve(_ e: AXUIElement, _ name: String, _ tree: Ax.Tree) {
            if name == kAXFocusedUIElementChangedNotification {
                if app.running.isActive { say(tree.nearest(e) ?? 0) }
                return
            }
            let from = name == kAXCreatedNotification ? Ax.element(Ax.copy(e, "AXParent")) : e
            guard let from, let k = tree.nearest(from), let x = tree.nodes[k], x.cut != "web", x.cut != "deep" else { return }
            touch(k)
        }

        /// Its thread's work, at most every 50 ms while there is any, and
        /// at most 50 ms of it a tick.
        private func tick() {
            let t = CFAbsoluteTimeGetCurrent()
            let until = t + Mac.tick
            if hung == 0 {
                let due = later.filter { $0.at <= t }
                later.removeAll { $0.at <= t }
                for d in due { d.run() }
            }
            guard let tree else { return arm() }
            if hung != 0 {
                guard t >= hung else { return arm(hung - t) }
                // one attribute; answered, running again where it stopped
                var v: CFTypeRef?
                if AXUIElementCopyAttributeValue(tree.app, "AXRole" as CFString, &v) == .cannotComplete {
                    hung = t + 5
                    return arm(5)
                }
                hung = 0
                tree.fault = nil
                tree.slow = nil
                mac.state(app, "running")
                // what changed meanwhile: every key under its windows read again, paced
                values.formUnion(tree.windows())
            }
            // the pace: an app's share of this tick, and every app's
            let tier = mac.tier(app.running)
            var allowed = mac.grant(Int(Mac.apace * Mac.tick), tier: tier)
            let from = tree.spent
            var used: Int { tree.spent - from }
            while used < allowed, tree.fault == nil, !unplaced.isEmpty, CFAbsoluteTimeGetCurrent() < until {
                let (e, name) = unplaced.removeFirst()
                resolve(e, name, tree)
            }
            while used < allowed, tree.fault == nil, CFAbsoluteTimeGetCurrent() < until, let k = values.popFirst() {
                tree.update(k)
            }
            for (k, at) in scrolled where at <= t {
                scrolled[k] = nil
                values.formUnion(tree.under(k, most: 500))
            }
            for (k, at) in parents where at <= t {
                parents[k] = nil
                tree.walk(k)
            }
            if used < allowed, tree.busy {
                mac.walking(tier)
                _ = tree.step(allowed - used, until: until)
            }
            // a sweep: its own small share
            var k = 0
            while k < Int(Mac.checks * Mac.tick) + 1, used < allowed, tree.fault == nil, !checks.isEmpty, CFAbsoluteTimeGetCurrent() < until {
                _ = tree.check(checks.removeFirst())
                k += 1
                if checks.isEmpty { swept = CFAbsoluteTimeGetCurrent() }
            }
            if used > allowed {
                _ = mac.grant(0, spent: used - allowed)
                allowed = used
            }
            if let f = tree.fault { fault(f, tree, t) }
            flush(force: false)
            arm()
        }

        /// AX stopped answering. The app's own element asked once: no answer,
        /// the app is hung; an answer, only one element was slow: it is cut
        /// `timeout` (or its keys left) and tried again after 5, 30, 120 s.
        private func fault(_ f: AXError, _ tree: Ax.Tree, _ t: Double) {
            guard f == .cannotComplete else {
                tree.fault = nil
                tree.slow = nil
                mac.queue.async { [mac] in mac.poll() }
                return
            }
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(tree.app, "AXRole" as CFString, &v) == .cannotComplete {
                hung = t + 5
                mac.state(app, "hung")
                return
            }
            tree.fault = nil
            guard let (k, walk) = tree.slow else { return }
            tree.slow = nil
            let times = slows[k] ?? 0
            slows[k] = times + 1
            let wait = [5.0, 30, 120][min(times, 2)]
            if walk { tree.timedOut(k) }
            later.append((t + wait, { [self] in
                guard let tree = self.tree, tree.nodes[k] != nil else { return }
                if walk { tree.walk(k) } else { values.insert(k) }
            }))
        }

        /// Wakes the thread after `wait` seconds, or a tick from now while there is work.
        private func arm(_ wait: Double? = nil) {
            guard let timer else { return }
            let busy = !values.isEmpty || !parents.isEmpty || !checks.isEmpty || !items.isEmpty || !unplaced.isEmpty
                || !scrolled.isEmpty || (tree?.busy ?? false)
            var at = Double.greatestFiniteMagnitude
            if let wait { at = CFAbsoluteTimeGetCurrent() + wait }
            if busy && hung == 0 { at = min(at, CFAbsoluteTimeGetCurrent() + Mac.tick) }
            if let soonest = later.map(\.at).min() { at = min(at, soonest) }
            if at == .greatestFiniteMagnitude { at = CFAbsoluteTimeGetCurrent() + 1e9 }
            CFRunLoopTimerSetNextFireDate(timer, at)
        }

        /// Sends what changed, at most hz times a second, `most` items a record.
        private func flush(force: Bool) {
            guard !items.isEmpty else { return }
            let t = CFAbsoluteTimeGetCurrent()
            guard force || t - flushed >= 1 / hz else { return }
            flushed = t
            var i = 0
            while i < items.count {
                let chunk = items[i..<min(items.count, i + Mac.most)].map { Optional($0 as Any) }
                bus.send(51, [("event", "tree"), ("pid", Int(pid)), ("items", Array(chunk))])
                mac.sent(chunk.count)
                i += Mac.most
            }
            items.removeAll(keepingCapacity: true)
            for (k, list) in watchers {
                let now = place(k)
                guard now != seen[k] else { continue }
                seen[k] = now
                for (_, change) in list { change(now, now == nil ? "gone" : nil) }
                if now == nil { watchers[k] = nil }
            }
        }

        /// A window node's place, title and state.
        private func place(_ k: Int) -> MacWindow? {
            guard let x = tree?.nodes[k] else { return nil }
            var w = MacWindow()
            if case .int(let v) = x.attrs["x"] { w.x = v }
            if case .int(let v) = x.attrs["y"] { w.y = v }
            if case .int(let v) = x.attrs["w"] { w.w = v }
            if case .int(let v) = x.attrs["h"] { w.h = v }
            if case .text(let v) = x.attrs["title"] { w.title = v }
            if case .bool(let v) = x.attrs["minimized"] { w.minimized = v }
            return w
        }
    }
}
