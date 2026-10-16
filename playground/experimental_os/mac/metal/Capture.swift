// Capture.swift: one Mac window's pixels, for the mac device (irq 51,
// ../METAL.md). The OS's mac driver asks for a window by its node (capture
// {view, pid, window, path, maxw, maxh, fps}); this finds it among
// ScreenCaptureKit's windows, streams it, even covered, and copies each
// whole frame into the driver's plane file, two halves: a frame goes only
// into the half not shown, and nothing more is written until the driver
// says it took it (took), so a frame is never torn. Keys and clicks the OS
// sends back (macinput) are posted to the window's app, not to the screen.

import AppKit
import CoreMedia
import CoreVideo
import ScreenCaptureKit

final class Capture: @unchecked Sendable {
    private let bus: Bus
    private let mac: Mac
    private let scale: Double
    private let queue = DispatchQueue(label: "ermine.capture")
    /// the queue's
    private var feeds: [String: Feed] = [:]

    init(bus: Bus, mac: Mac, scale: Double) {
        self.bus = bus
        self.mac = mac
        self.scale = scale
    }

    /// capture {view, pid, window, path, maxw, maxh, fps}
    func start(_ c: [String: Any]) {
        guard let view = c["view"] as? String, let pid = int(c["pid"]), let n = int(c["window"]), let path = c["path"] as? String,
              let maxw = int(c["maxw"]), let maxh = int(c["maxh"]), maxw > 0, maxh > 0 else {
            log("capture: needs view, pid, window, path, maxw and maxh: \(c)")
            return
        }
        let fps = max(1, min(120, int(c["fps"]) ?? 30))
        queue.async { [self] in
            feeds.removeValue(forKey: view)?.stop()
            let feed = Feed(bus: bus, mac: mac, scale: scale, view: view, pid: pid_t(pid), n: n, path: path, maxw: maxw, maxh: maxh, fps: fps)
            feeds[view] = feed
            feed.begin()
        }
    }

    /// uncapture {view}
    func stop(_ c: [String: Any]) {
        guard let view = c["view"] as? String else { return }
        queue.async { [self] in feeds.removeValue(forKey: view)?.stop() }
    }

    /// took {view, n}
    func took(_ c: [String: Any]) {
        guard let view = c["view"] as? String, let n = int(c["n"]) else { return }
        queue.async { [self] in feeds[view]?.took(n) }
    }

    /// macinput {view, events}
    func input(_ c: [String: Any]) {
        guard let view = c["view"] as? String, let events = c["events"] as? [[String: Any]] else { return }
        queue.async { [self] in feeds[view]?.post(events) }
    }

    // MARK: - one view

    final class Feed: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
        private let bus: Bus
        private let mac: Mac
        private let scale: Double
        let view: String
        let pid: pid_t
        let n: Int
        private let path: String
        private let maxw: Int, maxh: Int
        private let fps: Int
        /// frames come here, and the plane is written here only
        private let frames: DispatchQueue
        // frames' own
        private var plane: UnsafeMutableRawPointer?
        private var size = 0
        private var shown = -1
        /// the frame sent and not yet taken
        private var waiting = 0
        /// the newest frame while one waits, and what changed since the last sent
        private var pending: CVPixelBuffer?
        private var dirty: CGRect?
        private var whole = true
        private var count = 0
        private var last = (w: 0, h: 0)
        // under the lock: the window's place, and the stream
        private let lock = NSLock()
        private var place = MacWindow()
        private var stream: SCStream?
        private var config: SCStreamConfiguration?
        private var wid: CGWindowID = 0
        private var stopped = false
        /// the last state said, and whether input was said to be denied
        private var said = "starting"
        private var deaf = false
        // the capture queue's: buttons held, for drags; the last down, for
        // double clicks; scroll not yet posted, under a whole pixel
        private var buttons = Set<Int>()
        private var click = (at: 0.0, x: 0.0, y: 0.0, button: -1, count: 0)
        private var rest = (dx: 0.0, dy: 0.0)

        init(bus: Bus, mac: Mac, scale: Double, view: String, pid: pid_t, n: Int, path: String, maxw: Int, maxh: Int, fps: Int) {
            self.bus = bus
            self.mac = mac
            self.scale = scale
            self.view = view
            self.pid = pid
            self.n = n
            self.path = path
            self.maxw = maxw
            self.maxh = maxh
            self.fps = fps
            frames = DispatchQueue(label: "ermine.capture.\(view)", qos: .userInteractive)
        }

        private func say(_ state: String, wid: CGWindowID? = nil, error: String? = nil) {
            lock.lock()
            said = state
            lock.unlock()
            var fields: Fields = [("event", "view"), ("view", view), ("state", state)]
            if let wid { fields.append(("wid", Int(wid))) }
            if let error { fields.append(("error", error)) }
            bus.send(51, fields)
        }

        /// Maps the plane (and unlinks its file: both sides have it mapped,
        /// so nothing is left on disk after a crash), finds the window,
        /// starts the stream.
        func begin() {
            frames.sync {
                let fd = open(path, O_RDWR | O_CLOEXEC)
                guard fd >= 0 else { return }
                defer { close(fd) }
                var st = stat()
                let want = 2 * maxw * maxh * 4
                guard fstat(fd, &st) == 0, Int(st.st_size) >= want,
                      let p = mmap(nil, want, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), p != MAP_FAILED else { return }
                plane = p
                size = want
                unlink(path)
            }
            guard frames.sync(execute: { plane != nil }) else {
                log("capture \(view): cannot map \(path)")
                return say("gone", error: "plane")
            }
            guard CGPreflightScreenCaptureAccess() else { return say("denied") }
            mac.window(pid: pid, n: n) { [self] w, why in
                // not mirrored: the window cannot be found, but it is not gone
                guard let w else { return why == "unmirrored" ? say("nowindow", error: why) : say("gone") }
                lock.lock()
                place = w
                lock.unlock()
                SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [self] content, error in
                    guard let content else { return say("denied", error: error?.localizedDescription) }
                    find(content, w)
                }
            }
        }

        /// The SCWindow of this pid at the window element's frame; its title when two are there.
        private func find(_ content: SCShareableContent, _ w: MacWindow) {
            let frame = CGRect(x: Double(w.x) * scale, y: Double(w.y) * scale, width: Double(w.w) * scale, height: Double(w.h) * scale)
            let slack = max(2, scale * 2)
            func near(_ a: CGRect) -> Bool {
                abs(a.minX - frame.minX) <= slack && abs(a.minY - frame.minY) <= slack
                    && abs(a.width - frame.width) <= slack && abs(a.height - frame.height) <= slack
            }
            var hits = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && near($0.frame) }
            if hits.count > 1 {
                let titled = hits.filter { $0.title == w.title }
                if !titled.isEmpty { hits = titled }
            }
            guard hits.count == 1, let win = hits.first else { return say(hits.isEmpty ? "nowindow" : "ambiguous") }
            let cfg = SCStreamConfiguration()
            cfg.pixelFormat = kCVPixelFormatType_32BGRA  // 0x00RRGGBB little-endian, as the frame buffer's, the alpha unused
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            cfg.queueDepth = 4
            cfg.showsCursor = false
            fit(cfg, w)
            let s = SCStream(filter: SCContentFilter(desktopIndependentWindow: win), configuration: cfg, delegate: self)
            do {
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: frames)
            } catch {
                return say("gone", error: error.localizedDescription)
            }
            lock.lock()
            guard !stopped else {
                lock.unlock()
                return
            }
            stream = s
            config = cfg
            wid = win.windowID
            lock.unlock()
            // watched before it starts; a stop meanwhile unwatches after this, on the same queue
            mac.watch(pid: pid, n: n, view: view) { [weak self] w, why in self?.moved(w, why) }
            s.startCapture { [self] error in
                lock.lock()
                let done = stopped
                lock.unlock()
                // stopped while it was starting: stopped now, so no frame comes without an owner
                if done { return s.stopCapture { _ in } }
                if let error { return say("gone", error: error.localizedDescription) }
                say(w.minimized ? "minimized" : "live", wid: win.windowID)
            }
        }

        /// The stream's size: the window's, in frame buffer pixels, at most the plane's.
        private func fit(_ cfg: SCStreamConfiguration, _ w: MacWindow) {
            cfg.width = max(1, min(w.w, maxw))
            cfg.height = max(1, min(w.h, maxh))
        }

        /// The window moved, was resized, minimized, retitled, or went
        /// (nil). Its app no longer mirrored (why `unmirrored`): the stream
        /// goes on, its place is no longer followed, and the owner says why.
        private func moved(_ w: MacWindow?, _ why: String?) {
            lock.lock()
            let was = place
            if let w { place = w }
            let s = stream, cfg = config, id = wid, done = stopped, now = said
            lock.unlock()
            guard !done else { return }
            guard let w else {
                if why == "unmirrored" { return say(now, wid: id, error: why) }
                say("gone")
                stop()
                return
            }
            if w.minimized != was.minimized { say(w.minimized ? "minimized" : "live", wid: id) }
            if (w.w != was.w || w.h != was.h), let s, let cfg {
                fit(cfg, w)
                s.updateConfiguration(cfg) { error in
                    if let error { log("capture: resize: \(error.localizedDescription)") }
                }
            }
        }

        func stop() {
            lock.lock()
            stopped = true
            let s = stream
            stream = nil
            lock.unlock()
            s?.stopCapture { _ in }
            mac.watch(pid: pid, n: n, view: view, nil)
            frames.async { [self] in
                if let plane { munmap(plane, size) }
                plane = nil
                pending = nil
            }
        }

        func stream(_ stream: SCStream, didStopWithError error: Error) {
            lock.lock()
            let done = stopped
            lock.unlock()
            if !done { say("gone", error: error.localizedDescription) }
        }

        // MARK: frames, on frames

        func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
            guard type == .screen, plane != nil,
                  let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let info = atts.first, let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
                  let px = CMSampleBufferGetImageBuffer(sb) else { return }
            let w = min(CVPixelBufferGetWidth(px), maxw), h = min(CVPixelBufferGetHeight(px), maxh)
            // what changed: ScreenCaptureKit's dirty rects, read both as the
            // frame's pixels and as the window's points, as its documents
            // leave either open; so never less than what changed
            if let list = info[.dirtyRects] as? [Any], !whole {
                var points = 1.0
                if let d = info[.contentRect], let r = CGRect(dictionaryRepresentation: d as! CFDictionary), r.width > 0 {
                    points = Double(w) / r.width
                }
                for item in list {
                    guard let r = CGRect(dictionaryRepresentation: item as! CFDictionary) else { continue }
                    let both = r.union(CGRect(x: r.minX * points, y: r.minY * points, width: r.width * points, height: r.height * points))
                    dirty = dirty.map { $0.union(both) } ?? both
                }
            } else {
                whole = true
            }
            pending = px
            if waiting == 0 { write(w: w, h: h) }
        }

        /// The newest frame into the half not shown, then `frame`; nothing more until took.
        private func write(w: Int, h: Int) {
            guard let px = pending, let plane else { return }
            pending = nil
            let half = shown == 0 ? 1 : 0
            CVPixelBufferLockBaseAddress(px, .readOnly)
            if let src = CVPixelBufferGetBaseAddress(px) {
                let stride = CVPixelBufferGetBytesPerRow(px)
                let dst = plane + half * maxw * maxh * 4
                for y in 0..<h { memcpy(dst + y * maxw * 4, src + y * stride, w * 4) }
            }
            CVPixelBufferUnlockBaseAddress(px, .readOnly)
            count += 1
            shown = half
            waiting = count
            var fields: Fields = [("event", "frame"), ("view", view), ("n", count), ("half", half), ("w", w), ("h", h)]
            if !whole, last == (w, h), let d = dirty?.intersection(CGRect(x: 0, y: 0, width: w, height: h)), !d.isNull {
                let x = Int(d.minX.rounded(.down)), y = Int(d.minY.rounded(.down))
                fields.append(("dirty", [("x", x), ("y", y), ("w", Int(d.maxX.rounded(.up)) - x), ("h", Int(d.maxY.rounded(.up)) - y)] as Fields))
            }
            last = (w, h)
            dirty = nil
            whole = false
            bus.send(51, fields)
        }

        func took(_ k: Int) {
            frames.async { [self] in
                guard k == waiting else { return }
                waiting = 0
                if let px = pending {
                    write(w: min(CVPixelBufferGetWidth(px), maxw), h: min(CVPixelBufferGetHeight(px), maxh))
                }
            }
        }

        // MARK: input, on the capture queue

        /// Posts irq 34/35 records to the window's app: keys by code and
        /// flags, text by its characters, the pointer at the window's
        /// origin plus the point, aimed at the window by its id (fields 91
        /// and 92) though another covers it. The Mac's cursor never moves.
        func post(_ events: [[String: Any]]) {
            lock.lock()
            let w = place, id = wid, cfg = config, now = said
            lock.unlock()
            guard id != 0 else { return }
            // posting to a process needs the Accessibility grant: without it, said once
            guard CGPreflightPostEventAccess() else {
                if !deaf {
                    deaf = true
                    say(now, wid: id, error: "input denied")
                }
                return
            }
            deaf = false
            let src = CGEventSource(stateID: .privateState)
            for e in events {
                switch e["event"] as? String {
                case "key":
                    guard let code = int(e["code"]),
                          let ev = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: bool(e["down"]) ?? true) else { continue }
                    // a modifier alone (54-63: command, shift, caps, option,
                    // control, their right ones, fn) is a change of flags, not a key
                    if (54...63).contains(code) { ev.type = .flagsChanged }
                    ev.flags = flags(e["mods"])
                    ev.postToPid(pid)
                case "commit":
                    // press and hold: the letter it replaces taken back first
                    if let r = e["replace"] as? [Any], r.count == 2, let from = int(r[0]), let to = int(r[1]), to > from {
                        for _ in 0..<min(to - from, 64) {
                            for down in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: 51, keyDown: down)?.postToPid(pid) }
                        }
                    }
                    let units = Array((e["text"] as? String ?? "").utf16)
                    var i = 0
                    while i < units.count {
                        let part = Array(units[i..<min(units.count, i + 20)])
                        for down in [true, false] {
                            guard let ev = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
                            part.withUnsafeBufferPointer { ev.keyboardSetUnicodeString(stringLength: part.count, unicodeString: $0.baseAddress) }
                            ev.postToPid(pid)
                        }
                        i += 20
                    }
                case let kind?:
                    guard ["move", "down", "up", "scroll"].contains(kind) else { continue }
                    // the layer's pixels to the window's, then to points on the desktop
                    let kx = cfg.map { Double(w.w) / Double(max(1, $0.width)) } ?? 1
                    let ky = cfg.map { Double(w.h) / Double(max(1, $0.height)) } ?? 1
                    let x = Double(int(e["x"]) ?? 0), y = Double(int(e["y"]) ?? 0)
                    let at = CGPoint(x: (Double(w.x) + x * kx) * scale, y: (Double(w.y) + y * ky) * scale)
                    let button = int(e["button"]) ?? 0
                    var ev: CGEvent?
                    switch kind {
                    case "scroll":
                        // ermine's dy is frame buffer pixels, positive scrolling the
                        // content down; a wheel's is points, positive scrolling up.
                        // What is under a whole point is kept for the next.
                        let dy = -(double(e["dy"]) ?? 0) * scale + rest.dy, dx = -(double(e["dx"]) ?? 0) * scale + rest.dx
                        let wy = dy.rounded(.towardZero), wx = dx.rounded(.towardZero)
                        rest = (dx - wx, dy - wy)
                        guard wy != 0 || wx != 0 else { continue }
                        ev = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
                                     wheel1: Int32(clamping: Int(wy)), wheel2: Int32(clamping: Int(wx)), wheel3: 0)
                        ev?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                        ev?.location = at
                    case "down", "up":
                        let down = kind == "down"
                        if down { buttons.insert(button) } else { buttons.remove(button) }
                        let type: CGEventType =
                            switch button {
                            case 0: down ? .leftMouseDown : .leftMouseUp
                            case 1: down ? .rightMouseDown : .rightMouseUp
                            default: down ? .otherMouseDown : .otherMouseUp
                            }
                        // a second down soon after and near the last: a double click, a third a triple
                        if down {
                            let t = ProcessInfo.processInfo.systemUptime
                            let near = abs(at.x - click.x) <= 4 && abs(at.y - click.y) <= 4
                            let count = near && button == click.button && t - click.at <= NSEvent.doubleClickInterval ? click.count + 1 : 1
                            click = (t, at.x, at.y, button, count)
                        }
                        ev = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: at, mouseButton: CGMouseButton(rawValue: UInt32(max(0, button))) ?? .left)
                        ev?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, click.count)))
                    default:
                        let held = buttons.min()
                        let type: CGEventType =
                            switch held {
                            case nil: .mouseMoved
                            case 0: .leftMouseDragged
                            case 1: .rightMouseDragged
                            default: .otherMouseDragged
                            }
                        ev = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: at,
                                     mouseButton: CGMouseButton(rawValue: UInt32(held ?? 0)) ?? .left)
                        if held != nil { ev?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, click.count))) }
                    }
                    guard let ev else { continue }
                    ev.flags = flags(e["mods"])
                    // the window under the pointer, and the one that can take it: this one
                    if let under = CGEventField(rawValue: 91), let takes = CGEventField(rawValue: 92) {
                        ev.setIntegerValueField(under, value: Int64(id))
                        ev.setIntegerValueField(takes, value: Int64(id))
                    }
                    ev.postToPid(pid)
                default:
                    continue
                }
            }
        }

        private func flags(_ mods: Any?) -> CGEventFlags {
            var f: CGEventFlags = []
            for m in mods as? [String] ?? [] {
                switch m {
                case "shift": f.insert(.maskShift)
                case "ctrl": f.insert(.maskControl)
                case "alt": f.insert(.maskAlternate)
                case "cmd": f.insert(.maskCommand)
                case "caps": f.insert(.maskAlphaShift)
                case "fn": f.insert(.maskSecondaryFn)
                default: break
                }
            }
            return f
        }
    }
}
