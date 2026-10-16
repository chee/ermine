// Ax.swift: the Accessibility API as the mac device (irq 51, ../METAL.md)
// reads it: one element's batched read into a node's value, the names
// (role-k), one app's tree walked breadth first within its bounds, and the
// acts. Pure: no bus, no log, nothing on the main thread. Mac.swift runs it
// on each app's own thread; ../../macapps/axprobe.swift is built with this
// same file, so the probe's records are the metal's.

import AppKit
import ApplicationServices

enum Ax {
    /// Fields in order, as Log.swift's: an item, or a value.
    typealias Pairs = [(String, Any?)]

    /// /etc/mac's bounds an app's walk keeps to (the app's total is the metal's).
    struct Bounds: Equatable {
        /// levels below an app
        var depth = 24
        /// elements an app
        var app = 4000
        /// a list of more children than this: none
        var rows = 200
        /// UTF-16 units of a value
        var text = 4096
        /// points a frame buffer pixel, the metal's scale
        var scale = 1.0
    }

    /// A key's value in a node.
    enum Val: Equatable {
        case text(String), int(Int), num(Double), bool(Bool), list([Val])

        var any: Any? {
            switch self {
            case .text(let s): s
            case .int(let i): i
            case .num(let d): d
            case .bool(let b): b
            case .list(let l): l.map { $0.any }
            }
        }
    }

    /// An element as a dictionary key: equal by CFEqual, hashed by CFHash.
    struct Key: Hashable {
        let e: AXUIElement
        init(_ e: AXUIElement) { self.e = e }
        static func == (a: Key, b: Key) -> Bool { CFEqual(a.e, b.e) }
        func hash(into h: inout Hasher) { h.combine(CFHash(e)) }
    }

    // MARK: - one element

    /// What one batched read asks, AX's names.
    static let attributes = [
        "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXHelp", "AXValue", "AXSelectedTextRange",
        "AXPosition", "AXSize", "AXEnabled", "AXFocused", "AXSelected", "AXExpanded",
        "AXMain", "AXMinimized", "AXFullScreen",
    ]

    /// A node's keys, in the order a value lists them.
    static let keys = [
        "role", "subrole", "title", "label", "help", "value", "length", "secure", "x", "y", "w", "h",
        "enabled", "focused", "selected", "expanded", "selection", "actions", "settable",
        "main", "minimized", "fullscreen", "order", "cut", "more",
    ]

    /// AX's name for a key; a name not here is AX's own, verbatim.
    static func attribute(_ key: String) -> String {
        switch key {
        case "role": "AXRole"
        case "subrole": "AXSubrole"
        case "title": "AXTitle"
        case "label": "AXDescription"
        case "help": "AXHelp"
        case "value": "AXValue"
        case "selection": "AXSelectedTextRange"
        case "x", "y": "AXPosition"
        case "w", "h": "AXSize"
        case "enabled": "AXEnabled"
        case "focused": "AXFocused"
        case "selected": "AXSelected"
        case "expanded": "AXExpanded"
        case "main": "AXMain"
        case "minimized": "AXMinimized"
        case "fullscreen": "AXFullScreen"
        default: key
        }
    }

    /// One read of an element.
    struct Read {
        var role = "", subrole = ""
        var value: [String: Val] = [:]
        /// a secure text field: its value never asked
        var secure = false
        var error: AXError = .success
        /// the messages it took (the pace counts these, not elements)
        var calls = 0
    }

    /// Reads an element with one batched call, and its action names. A
    /// field known to be secure is never asked its value; one seen to be
    /// secure at its first read has the value that read brought dropped
    /// unseen (AX answers bullets for it). A value known to be long (cut at
    /// its last read) is never copied whole again: its length and its head
    /// only, by range, so a keystroke in a long document copies `text`
    /// units, not the document. Its children are never in the batch: they
    /// are counted or paged first (Tree.children).
    static func read(_ e: AXUIElement, bounds: Bounds, secure known: Bool = false, long: Bool = false) -> Read {
        var names = attributes
        if known { names.removeAll { $0 == "AXValue" || $0 == "AXSelectedTextRange" } }
        if long { names.removeAll { $0 == "AXValue" } }
        names.append("AXNumberOfCharacters")
        var r = Read()
        r.calls = 1
        var out: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
        guard err == .success, let list = out as? [AnyObject], list.count == names.count else {
            r.error = err == .success ? .failure : err
            return r
        }
        var got: [String: AnyObject] = [:]
        for (name, v) in zip(names, list) {
            if let f = failed(v) {
                // the role is every element's: its error is the element's
                if name == "AXRole", f == .invalidUIElement || f == .cannotComplete || f == .apiDisabled {
                    r.error = f
                    return r
                }
                continue
            }
            if CFGetTypeID(v) == CFNullGetTypeID() { continue }
            got[name] = v
        }
        r.role = got["AXRole"] as? String ?? ""
        r.subrole = got["AXSubrole"] as? String ?? ""
        r.secure = known || r.role == "AXSecureTextField" || r.subrole == "AXSecureTextField"
        if r.secure {
            got["AXValue"] = nil
            got["AXSelectedTextRange"] = nil
        } else if long, let count = (got["AXNumberOfCharacters"] as? NSNumber)?.intValue {
            if count > bounds.text {
                // the head, by range: never the whole across IPC
                var range = CFRange(location: 0, length: bounds.text)
                var head: CFTypeRef?
                r.calls += 1
                if let p = AXValueCreate(.cfRange, &range),
                   AXUIElementCopyParameterizedAttributeValue(e, "AXStringForRange" as CFString, p, &head) == .success, let s = head as? String {
                    got["AXValue"] = Ax.cut(s, bounds.text).0 as CFString
                    got["AXNumberOfCharacters"] = count as NSNumber
                }
            } else {
                r.calls += 1
                got["AXValue"] = copy(e, "AXValue")
                got["AXNumberOfCharacters"] = nil
            }
        }
        var v: [String: Val] = [:]
        if !r.role.isEmpty { v["role"] = .text(r.role) }
        if !r.subrole.isEmpty { v["subrole"] = .text(r.subrole) }
        for (a, k) in [("AXTitle", "title"), ("AXDescription", "label"), ("AXHelp", "help")] {
            if let s = got[a] as? String, !s.isEmpty { v[k] = .text(s) }
        }
        if let raw = got["AXValue"], let (value, length) = val(raw, text: bounds.text) {
            v["value"] = value
            if let length { v["length"] = .int(length) }
            // the head read by range: its length the element's
            if long, case .text = value, let count = (got["AXNumberOfCharacters"] as? NSNumber)?.intValue, count > bounds.text {
                v["length"] = .int(count)
            }
        }
        if r.secure { v["secure"] = .bool(true) }
        if let p = point(got["AXPosition"]) {
            v["x"] = .int(px(p.x, bounds))
            v["y"] = .int(px(p.y, bounds))
        }
        if let s = size(got["AXSize"]) {
            v["w"] = .int(px(s.width, bounds))
            v["h"] = .int(px(s.height, bounds))
        }
        for (a, k) in [("AXEnabled", "enabled"), ("AXFocused", "focused"), ("AXSelected", "selected"), ("AXExpanded", "expanded"),
                       ("AXMain", "main"), ("AXMinimized", "minimized"), ("AXFullScreen", "fullscreen")] {
            if let b = got[a] as? NSNumber, CFGetTypeID(b) == CFBooleanGetTypeID() { v[k] = .bool(b.boolValue) }
        }
        if let raw = got["AXSelectedTextRange"], let (s, _) = val(raw, text: 0), case .list = s { v["selection"] = s }
        var acts: CFArray?
        r.calls += 1
        if AXUIElementCopyActionNames(e, &acts) == .success, let a = acts as? [String], !a.isEmpty {
            v["actions"] = .list(a.map { .text($0) })
        }
        // settable: asked only of what a read found, and a window's frame
        var settable: [Val] = []
        var asks: [(String, String)] = []
        if v["value"] != nil { asks.append(("value", "AXValue")) }
        if v["selection"] != nil { asks.append(("selection", "AXSelectedTextRange")) }
        if v["selected"] != nil { asks.append(("selected", "AXSelected")) }
        if r.role == "AXWindow" { asks += [("x", "AXPosition"), ("w", "AXSize")] }
        for (k, a) in asks {
            var ok = DarwinBoolean(false)
            r.calls += 1
            guard AXUIElementIsAttributeSettable(e, a as CFString, &ok) == .success, ok.boolValue else { continue }
            settable += k == "x" ? [.text("x"), .text("y")] : k == "w" ? [.text("w"), .text("h")] : [.text(k)]
        }
        if !settable.isEmpty { v["settable"] = .list(settable) }
        r.value = v
        return r
    }

    /// The error a batched read put in place of a value, if it is one.
    static func failed(_ v: AnyObject) -> AXError? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        let a = v as! AXValue
        guard AXValueGetType(a) == .axError else { return nil }
        var e = AXError.success
        AXValueGetValue(a, .axError, &e)
        return e
    }

    /// One attribute, or nil.
    static func copy(_ e: AXUIElement, _ attribute: String) -> AnyObject? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &v) == .success else { return nil }
        return v
    }

    /// An array attribute's count, and AX's answer: nothing copied.
    static func count(_ e: AXUIElement, _ attribute: String) -> (Int, AXError) {
        var k: CFIndex = 0
        let err = AXUIElementGetAttributeValueCount(e, attribute as CFString, &k)
        return (err == .success ? k : 0, err)
    }

    /// At most `most` of an array attribute's elements, from the first, and AX's answer.
    static func page(_ e: AXUIElement, _ attribute: String, _ most: Int) -> ([AXUIElement], AXError) {
        var v: CFArray?
        let err = AXUIElementCopyAttributeValues(e, attribute as CFString, 0, most, &v)
        return (err == .success ? v as? [AXUIElement] ?? [] : [], err)
    }

    /// An element, if v is one.
    static func element(_ v: AnyObject?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func point(_ v: AnyObject?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cgPoint else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ v: AnyObject?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cgSize else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    /// Points to frame buffer pixels.
    static func px(_ points: CGFloat, _ bounds: Bounds) -> Int {
        let d = Double(points) / bounds.scale
        return d.isFinite ? Int(d.rounded()) : 0
    }

    /// A value as a node holds it, text cut at `text` UTF-16 units with the
    /// whole length beside it; nil for what a node does not show (a point,
    /// an element, a list).
    static func val(_ v: AnyObject, text: Int) -> (Val, Int?)? {
        let id = CFGetTypeID(v)
        if id == CFStringGetTypeID(), let s = v as? String {
            let (t, length) = cut(s, text)
            return (.text(t), length)
        }
        if id == CFAttributedStringGetTypeID(), let s = v as? NSAttributedString {
            let (t, length) = cut(s.string, text)
            return (.text(t), length)
        }
        if id == CFBooleanGetTypeID(), let b = v as? NSNumber { return (.bool(b.boolValue), nil) }
        if id == CFNumberGetTypeID(), let n = v as? NSNumber {
            guard CFNumberIsFloatType(n) else { return (.int(n.intValue), nil) }
            let d = n.doubleValue
            guard d.isFinite else { return nil }
            return (d == d.rounded() && abs(d) < 1e15 ? .int(Int(d)) : .num(d), nil)
        }
        if id == CFURLGetTypeID(), let u = v as? NSURL, let s = u.absoluteString { return (.text(s), nil) }
        if id == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cfRange {
            var r = CFRange()
            guard AXValueGetValue(v as! AXValue, .cfRange, &r) else { return nil }
            return (.list([.int(r.location), .int(r.location + r.length)]), nil)
        }
        return nil
    }

    /// Text cut at limit UTF-16 units (never inside a pair), and its whole length if cut.
    static func cut(_ s: String, _ limit: Int) -> (String, Int?) {
        let u = s.utf16
        guard u.count > limit else { return (s, nil) }
        var units = Array(u.prefix(max(0, limit)))
        if let last = units.last, UTF16.isLeadSurrogate(last) { units.removeLast() }
        return (String(decoding: units, as: UTF16.self), u.count)
    }

    // MARK: - names

    /// A role as a name's word: AX dropped, lowercased, letters and digits; `element` for none.
    static func word(_ role: String) -> String {
        var r = Substring(role)
        if r.hasPrefix("AX") { r = r.dropFirst(2) }
        let w = String(r.lowercased().unicodeScalars.filter { ("a"..."z").contains($0) || ("0"..."9").contains($0) }.map(Character.init))
        return w.isEmpty ? "element" : w
    }

    /// role-k: the first k free among the siblings' names.
    static func name(_ role: String, among taken: Set<String>) -> String {
        let w = word(role)
        var k = 1
        while taken.contains("\(w)-\(k)") { k += 1 }
        return "\(w)-\(k)"
    }

    // MARK: - acts

    /// AX's error as the word a done record says.
    static func failure(_ e: AXError) -> String? {
        switch e {
        case .success: nil
        case .invalidUIElement, .invalidUIElementObserver: "gone"
        case .cannotComplete: "timeout"
        case .apiDisabled: "denied"
        case .actionUnsupported, .attributeUnsupported, .parameterizedAttributeUnsupported, .notificationUnsupported,
             .notImplemented, .noValue: "unsupported"
        case .illegalArgument: "bad"
        default: "refused"
        }
    }

    /// A JSON value as the CF value AX takes for that key.
    static func cf(_ v: Any, key: String) -> CFTypeRef? {
        if key == "selection" {
            guard let l = v as? [Any], l.count == 2, let from = (l[0] as? NSNumber)?.intValue, let to = (l[1] as? NSNumber)?.intValue,
                  to >= from else { return nil }
            var r = CFRange(location: from, length: to - from)
            return AXValueCreate(.cfRange, &r)
        }
        if let s = v as? String { return s as CFString }
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? kCFBooleanTrue : kCFBooleanFalse }
            return n
        }
        return nil
    }

    /// Does an act on an element: an AX action by name, `set`, `read` or
    /// `focus`. The answer: an error word or nil, and for read the value.
    /// With `at` (a click's, frame buffer pixels), an act other than set
    /// or read is done only if the element is still under it: what was
    /// there may have scrolled away since the driver's table last saw it.
    static func act(_ e: AXUIElement, act: String, to: [String: Any]?, key: String?, at click: CGPoint? = nil, bounds: Bounds) -> (error: String?, value: Any?) {
        if let click, act != "set", act != "read", let p = point(copy(e, "AXPosition")), let s = size(copy(e, "AXSize")) {
            let frame = CGRect(x: Double(px(p.x, bounds)), y: Double(px(p.y, bounds)), width: Double(px(s.width, bounds)), height: Double(px(s.height, bounds)))
            if !frame.contains(click) { return ("moved", nil) }
        }
        switch act {
        case "set":
            guard let to, !to.isEmpty else { return ("bad", nil) }
            // x and y move it together, w and h size it together
            var place: CGPoint?, extent: CGSize?
            for (k, v) in to.sorted(by: { $0.key < $1.key }) {
                switch k {
                case "x", "y":
                    guard let d = (v as? NSNumber)?.doubleValue, d.isFinite else { return ("bad", nil) }
                    if place == nil { place = point(copy(e, "AXPosition")) ?? .zero }
                    if k == "x" { place!.x = d * bounds.scale } else { place!.y = d * bounds.scale }
                case "w", "h":
                    guard let d = (v as? NSNumber)?.doubleValue, d.isFinite, d >= 0 else { return ("bad", nil) }
                    if extent == nil { extent = size(copy(e, "AXSize")) ?? .zero }
                    if k == "w" { extent!.width = d * bounds.scale } else { extent!.height = d * bounds.scale }
                default:
                    guard let value = cf(v, key: k) else { return ("bad", nil) }
                    if let f = failure(AXUIElementSetAttributeValue(e, attribute(k) as CFString, value)) { return (f, nil) }
                }
            }
            if var p = place, let value = AXValueCreate(.cgPoint, &p),
               let f = failure(AXUIElementSetAttributeValue(e, "AXPosition" as CFString, value)) { return (f, nil) }
            if var s = extent, let value = AXValueCreate(.cgSize, &s),
               let f = failure(AXUIElementSetAttributeValue(e, "AXSize" as CFString, value)) { return (f, nil) }
            return (nil, nil)
        case "read":
            guard let key, !key.isEmpty else { return ("bad", nil) }
            if key == "value" || key == "AXValue" || key == "selection" || key == "AXSelectedTextRange",
               [copy(e, "AXRole"), copy(e, "AXSubrole")].contains(where: { $0 as? String == "AXSecureTextField" }) {
                return ("refused", nil)  // a secure field's value is never read
            }
            var v: CFTypeRef?
            if let f = failure(AXUIElementCopyAttributeValue(e, attribute(key) as CFString, &v)) { return (f, nil) }
            guard let v else { return (nil, nil) }
            switch key {
            case "x", "y":
                guard let p = point(v) else { return (nil, nil) }
                return (nil, px(key == "x" ? p.x : p.y, bounds))
            case "w", "h":
                guard let s = size(v) else { return (nil, nil) }
                return (nil, px(key == "w" ? s.width : s.height, bounds))
            default:
                return (nil, val(v, text: Int.max)?.0.any)
            }
        case "focus":
            return (failure(AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue)), nil)
        default:
            guard act.hasPrefix("AX") else { return ("bad", nil) }
            return (failure(AXUIElementPerformAction(e, act as CFString)), nil)
        }
    }

    // MARK: - an app

    /// An app record, whole: n its app element's number, state the metal's word for it.
    static func record(_ a: NSRunningApplication, n: Int, state: String) -> Pairs {
        [("event", "app"), ("pid", Int(a.processIdentifier)), ("n", n), ("name", a.localizedName ?? ""),
         ("bundle", a.bundleIdentifier), ("path", a.bundleURL?.path),
         ("policy", a.activationPolicy == .regular ? "regular" : "accessory"), ("active", a.isActive), ("hidden", a.isHidden),
         ("state", state), ("electron", electron(a))]
    }

    /// Whether the app is Electron's: its tree a bare shell until AXManualAccessibility is set.
    static func electron(_ a: NSRunningApplication) -> Bool {
        guard let url = a.bundleURL else { return false }
        return FileManager.default.fileExists(atPath: url.path + "/Contents/Frameworks/Electron Framework.framework")
    }

    /// The apps listed: regular and accessory, pid above 0.
    static func listed(_ a: NSRunningApplication) -> Bool {
        a.processIdentifier > 0 && a.activationPolicy != .prohibited
    }

    /// Whether it is a helper: inside another app's bundle, an XPC service,
    /// or no bundle. Listed, asked once, never retried: most serve no AX
    /// (WebKit's content processes), and one that does still answers.
    static func helper(_ a: NSRunningApplication) -> Bool {
        guard let path = a.bundleURL?.path else { return true }
        return path.contains("/Contents/") || path.hasSuffix(".xpc")
    }

    // MARK: - the tree

    /// A mirrored element, or the app's own (n the app's, depth 0).
    final class Node {
        let n: Int
        let element: AXUIElement
        /// its parent's n; the app's own node has none
        let parent: Int
        let depth: Int
        let name: String
        var role: String
        var secure = false
        /// what the last read gave
        var attrs: [String: Val] = [:]
        /// its mirrored children, in AX's order
        var kids: [Int] = []
        var cut: String?
        var more = 0
        /// the deepest level read under it, and whether web and rows cuts are lifted
        var reach: Int
        var lift = false
        /// macopen's depth here, while it is open
        var opened: Int?
        /// its value as last sent
        var sent: [String: Val] = [:]

        init(n: Int, element: AXUIElement, parent: Int, depth: Int, name: String, role: String, reach: Int, lift: Bool) {
            self.n = n
            self.element = element
            self.parent = parent
            self.depth = depth
            self.name = name
            self.role = role
            self.reach = reach
            self.lift = lift
        }

        /// A table or outline: its header and visible rows only, unless lifted.
        var table: Bool { !lift && (role == "AXTable" || role == "AXOutline") }
    }

    /// One app's mirror: its nodes, the walk's queue, and what it sends.
    /// Every change goes out as an item to `sink`, in order: a parent's add
    /// before its children's.
    final class Tree {
        let pid: pid_t
        let app: AXUIElement
        let root: Node
        private(set) var bounds: Bounds
        private(set) var nodes: [Int: Node] = [:]
        private var index: [Key: Int] = [:]
        /// nodes whose children are to be read; deep: their kept children's too
        private var queue: [(n: Int, deep: Bool)] = []
        private var head = 0
        /// set when AX stops answering (cannotComplete: hung, or one slow
        /// element; apiDisabled: denied); the walk stops until it is cleared
        var fault: AXError?
        /// where the fault came: the node whose children (walk) or own keys were being read
        var slow: (n: Int, walk: Bool)?
        /// nodes cut `budget`: walked again when budget comes back
        private(set) var starved = Set<Int>()
        /// AX messages sent: the pace counts these
        private(set) var spent = 0
        /// a new n, the metal's, never reused
        private let number: () -> Int
        /// one element from the total budget; false when it is spent
        private let take: () -> Bool
        /// elements back to it
        private let give: (Int) -> Void
        private let sink: (Pairs) -> Void

        init(pid: pid_t, n: Int, bounds: Bounds, number: @escaping () -> Int, take: @escaping () -> Bool,
             give: @escaping (Int) -> Void, sink: @escaping (Pairs) -> Void) {
            self.pid = pid
            app = AXUIElementCreateApplication(pid)
            root = Node(n: n, element: app, parent: 0, depth: 0, name: "", role: "AXApplication", reach: bounds.depth, lift: false)
            self.bounds = bounds
            self.number = number
            self.take = take
            self.give = give
            self.sink = sink
            nodes[n] = root
            index[Key(app)] = n
        }

        /// Elements mirrored, the app's own not counted.
        var count: Int { nodes.count - 1 }
        /// Elements with a cut.
        var cuts: Int { nodes.values.reduce(0) { $0 + ($1.cut == nil ? 0 : 1) } }
        /// Whether the walk has more to do.
        var busy: Bool { head < queue.count }

        /// Queues n's children to be read again: new ones added and walked,
        /// gone ones dropped; with deep, every kept one's too, down to the cuts.
        func walk(_ n: Int, deep: Bool = false) {
            guard nodes[n] != nil else { return }
            queue.append((n, deep))
        }

        /// Walks until `limit` AX messages have been sent, or `until` has
        /// passed, or the queue is empty, or AX stops answering. Returns the
        /// messages sent: one node's children are read together, so it may
        /// be a few more.
        func step(_ limit: Int, until: Double = .greatestFiniteMagnitude) -> Int {
            let from = spent
            while spent - from < limit, fault == nil, head < queue.count, CFAbsoluteTimeGetCurrent() < until {
                let (n, deep) = queue[head]
                head += 1
                if let x = nodes[n] { expand(x, deep: deep) }
            }
            if head >= queue.count {
                queue.removeAll(keepingCapacity: true)
                head = 0
            } else if head > 4096 {
                queue.removeFirst(head)
                head = 0
            }
            return spent - from
        }

        /// Reads x's children again and sends what differs.
        private func expand(_ x: Node, deep: Bool) {
            guard let (list, cut, more) = children(x) else {
                if fault != nil { slow = (x.n, true) }
                return
            }
            var old: [Key: Int] = [:]
            for k in x.kids { if let c = nodes[k] { old[Key(c.element)] = k } }
            var kept = Set<Int>()
            var slots: [Int?] = []
            for e in list {
                if let k = old[Key(e)], !kept.contains(k) {
                    kept.insert(k)
                    slots.append(k)
                } else {
                    slots.append(nil)
                }
            }
            for k in x.kids where !kept.contains(k) { drop(k) }
            var taken = Set(kept.compactMap { nodes[$0]?.name })
            var order: [Int] = [], fresh: [Node] = []
            var over = 0, missed = 0
            for (i, e) in list.enumerated() {
                if let k = slots[i] {
                    order.append(k)
                    continue
                }
                if fault != nil {
                    missed += 1
                    continue
                }
                guard over == 0, count < bounds.app, take() else {
                    over += 1
                    continue
                }
                let r = Ax.read(e, bounds: bounds)
                spent += r.calls
                if r.error != .success {
                    give(1)
                    if r.error == .cannotComplete || r.error == .apiDisabled {
                        fault = r.error
                        slow = (x.n, true)
                        missed += 1
                    }
                    continue
                }
                let name = Ax.name(r.role, among: taken)
                taken.insert(name)
                let c = Node(n: number(), element: e, parent: x.n, depth: x.depth + 1, name: name, role: r.role, reach: x.reach, lift: x.lift)
                c.secure = r.secure
                c.attrs = r.value
                nodes[c.n] = c
                index[Key(e)] = c.n
                order.append(c.n)
                fresh.append(c)
            }
            x.kids = order
            if let cut {
                x.cut = cut
                x.more = more
            } else if over > 0 {
                x.cut = "budget"
                x.more = over
            } else if missed > 0 {
                // an element too slow to answer: tried again later (Mac.swift)
                x.cut = "timeout"
                x.more = missed
            } else {
                x.cut = nil
                x.more = 0
            }
            if x.cut == "budget" { starved.insert(x.n) } else { starved.remove(x.n) }
            for c in fresh { add(c) }
            publish(x)
            var next: [(Int, Bool)] = []
            for k in order {
                guard let c = nodes[k] else { continue }
                if kept.contains(k) {
                    guard deep else { continue }
                    c.reach = max(x.reach, c.opened.map { c.depth + $0 } ?? 0)
                    c.lift = x.lift || c.opened != nil
                    next.append((k, true))
                } else {
                    next.append((k, false))
                }
            }
            if x === root { next = first(next) }
            queue += next.map { (n: $0.0, deep: $0.1) }
        }

        /// An app's children, walked: its focused window, its other windows, its menu bars, the rest.
        private func first(_ list: [(Int, Bool)]) -> [(Int, Bool)] {
            spent += 1
            let focused = Ax.element(Ax.copy(app, "AXFocusedWindow")).flatMap { index[Key($0)] }
            func rank(_ n: Int) -> Int {
                if n == focused { return 0 }
                switch nodes[n]?.role {
                case "AXWindow": return 1
                case "AXMenuBar": return 2
                default: return 3
                }
            }
            return list.enumerated().sorted { (rank($0.element.0), $0.offset) < (rank($1.element.0), $1.offset) }.map(\.element)
        }

        /// Whether AX's answer about x ends its read: gone (x removed) or
        /// not answering (the fault set).
        private func ended(_ x: Node, _ err: AXError) -> Bool {
            switch err {
            case .invalidUIElement:
                if x !== root { remove(x.n) }
                return true
            case .cannotComplete, .apiDisabled:
                fault = err
                return true
            default:
                return false
            }
        }

        /// x's children as mirrored, or none with the cut and how many; nil
        /// when x is gone or AX stopped answering. Never a whole list it
        /// would cut: past the depth and in a web area, counted only; a
        /// table or outline, its header and visible rows, the rest counted;
        /// any other list, paged to one more than `rows`.
        private func children(_ x: Node) -> (list: [AXUIElement], cut: String?, more: Int)? {
            if x === root {
                spent += 2
                var v: CFTypeRef?
                let err = AXUIElementCopyAttributeValue(app, "AXChildren" as CFString, &v)
                if err == .cannotComplete || err == .apiDisabled {
                    fault = err
                    return nil
                }
                var list = v as? [AXUIElement] ?? []
                // the menu extras, the app's second menu bar, which AXChildren leaves out
                if let extras = Ax.element(Ax.copy(app, "AXExtrasMenuBar")), !list.contains(where: { CFEqual($0, extras) }) {
                    list.append(extras)
                }
                return (list, nil, 0)
            }
            let shut = x.depth >= x.reach ? "deep" : !x.lift && x.role == "AXWebArea" ? "web" : nil
            if let shut {
                spent += 1
                let (k, err) = Ax.count(x.element, "AXChildren")
                if ended(x, err) { return nil }
                return (k > 0 ? ([], shut, k) : ([], nil, 0))
            }
            if x.table {
                spent += 1
                let (rows, err) = Ax.count(x.element, "AXRows")
                if ended(x, err) { return nil }
                if rows > 0 {
                    spent += 2
                    var list: [AXUIElement] = []
                    if let header = Ax.element(Ax.copy(x.element, "AXHeader")) { list.append(header) }
                    let shown = Ax.copy(x.element, "AXVisibleRows") as? [AXUIElement] ?? []
                    list += shown.prefix(max(bounds.rows, 1))
                    let more = rows - min(shown.count, max(bounds.rows, 1))
                    return (list, more > 0 ? "rows" : nil, max(0, more))
                }
            }
            let most = x.lift ? Int.max : bounds.rows
            spent += 1
            let (list, err) = most == Int.max ? (Ax.copy(x.element, "AXChildren") as? [AXUIElement] ?? [], AXError.success) : Ax.page(x.element, "AXChildren", most + 1)
            if ended(x, err) { return nil }
            if list.count > most {
                spent += 1
                return ([], "rows", max(Ax.count(x.element, "AXChildren").0, list.count))
            }
            return (list, nil, 0)
        }

        /// Reads n's own keys again and sends those that changed.
        func update(_ n: Int) {
            guard let x = nodes[n], x !== root else { return }
            let r = Ax.read(x.element, bounds: bounds, secure: x.secure, long: x.attrs["length"] != nil)
            spent += r.calls
            switch r.error {
            case .success: break
            case .invalidUIElement:
                remove(n)
                return
            case .cannotComplete, .apiDisabled:
                fault = r.error
                slow = (n, false)
                return
            default: return
            }
            x.secure = r.secure
            x.role = r.role
            x.attrs = r.value
            publish(x)
        }

        /// An element too slow to answer while its children were read: cut
        /// `timeout`, until a later walk of it gets through.
        func timedOut(_ n: Int) {
            guard let x = nodes[n], x.cut == nil else { return }
            x.cut = "timeout"
            x.more = 0
            publish(x)
        }

        /// Whether n's children still match what is mirrored; if not, they
        /// are queued. The app: its count and its extras; a table: its
        /// visible rows; anything else: its count.
        func check(_ n: Int) -> Bool {
            guard let x = nodes[n], x.cut == nil else { return false }
            var mismatch = false
            if x.table {
                spent += 1
                let shown = Ax.copy(x.element, "AXVisibleRows") as? [AXUIElement] ?? []
                let mine = Set(x.kids.compactMap { nodes[$0].map { Key($0.element) } })
                mismatch = shown.prefix(max(bounds.rows, 1)).contains { !mine.contains(Key($0)) }
            } else {
                spent += 1
                let (k, err) = Ax.count(x.element, "AXChildren")
                if ended(x, err) { return err == .invalidUIElement }
                guard err == .success else { return false }
                var want = k
                if x === root {
                    spent += 1
                    if Ax.element(Ax.copy(app, "AXExtrasMenuBar")) != nil { want += 1 }
                }
                mismatch = want != x.kids.count
            }
            if mismatch { walk(n) }
            return mismatch
        }

        /// A sweep's list, the parents first: the app itself, then its
        /// windows and every node under them that has children (a leaf's
        /// new children come by notification; checking every leaf would
        /// cost the app a message each).
        func sweep() -> [Int] {
            var out = [root.n]
            var list = root.kids.filter { nodes[$0]?.role == "AXWindow" }
            var i = 0
            while i < list.count {
                if let x = nodes[list[i]] {
                    if x.role == "AXWindow" || !x.kids.isEmpty { out.append(x.n) }
                    list += x.kids
                }
                i += 1
            }
            return out
        }

        /// Every n under the app's windows: their keys, read again after a hang.
        func windows() -> [Int] {
            var out: [Int] = []
            var list = root.kids.filter { nodes[$0]?.role == "AXWindow" }
            var i = 0
            while i < list.count {
                out.append(list[i])
                list += nodes[list[i]]?.kids ?? []
                i += 1
            }
            return out
        }

        /// n and every n under it, at most `most`.
        func under(_ n: Int, most: Int) -> [Int] {
            var list = [n]
            var i = 0
            while i < list.count, list.count < most {
                list += nodes[list[i]]?.kids ?? []
                i += 1
            }
            return Array(list.prefix(most))
        }

        /// The n of an element, if it is mirrored.
        func find(_ e: AXUIElement) -> Int? { index[Key(e)] }

        /// The nearest mirrored element at or above e, AXParent at most 8 steps up.
        func nearest(_ e: AXUIElement) -> Int? {
            var e = e
            for _ in 0...8 {
                if let n = index[Key(e)] { return n }
                spent += 1
                guard let p = Ax.element(Ax.copy(e, "AXParent")) else { return nil }
                e = p
            }
            return nil
        }

        /// Lifts the cuts under n to depth levels below it, or with nil puts them back.
        func open(_ n: Int, depth: Int?) {
            guard let x = nodes[n] else { return }
            x.opened = depth
            let p = nodes[x.parent]
            x.reach = max(x === root ? bounds.depth : p?.reach ?? bounds.depth, depth.map { x.depth + $0 } ?? 0)
            x.lift = (x === root ? false : p?.lift ?? false) || depth != nil
            walk(n, deep: true)
        }

        /// New bounds, every kept element kept (its n, its name): a lower
        /// app budget trims the newest; the rest is walked again, deep, and
        /// cut or uncut where the bounds now say. Returns whether every
        /// kept element's own keys must be read again (a new text cut or scale).
        func rebound(_ b: Bounds) -> Bool {
            let refresh = b.text != bounds.text || b.scale != bounds.scale
            bounds = b
            root.reach = max(b.depth, root.opened ?? 0)
            trim(b.app)
            walk(root.n, deep: true)
            return refresh
        }

        /// Down to `limit` elements: the newest dropped first, each parent cut `budget`.
        func trim(_ limit: Int) {
            guard count > limit else { return }
            for k in nodes.keys.sorted(by: >) {
                guard count > limit else { break }
                guard let x = nodes[k], x !== root else { continue }
                remove(k, budget: true)
            }
        }

        /// Every element sent again as an add, the parents first, the
        /// app's own order last: for a driver that started again.
        func resend() {
            var list = root.kids
            var i = 0
            while i < list.count {
                if let c = nodes[list[i]] {
                    add(c)
                    list += c.kids
                }
                i += 1
            }
            root.sent = [:]
            publish(root)
        }

        /// Drops the whole tree.
        func clear() {
            for k in root.kids { drop(k) }
            root.kids = []
            root.cut = nil
            root.more = 0
            starved.removeAll()
            queue.removeAll()
            head = 0
        }

        /// The names from the app down to n.
        func path(_ n: Int) -> [String] {
            var out: [String] = []
            var x = nodes[n]
            while let c = x, c !== root {
                out.append(c.name)
                x = nodes[c.parent]
            }
            return out.reversed()
        }

        // MARK: items

        private func full(_ x: Node) -> [String: Val] {
            var v = x.attrs
            if !x.kids.isEmpty { v["order"] = .list(x.kids.compactMap { nodes[$0].map { .text($0.name) } }) }
            if let cut = x.cut {
                v["cut"] = .text(cut)
                v["more"] = .int(x.more)
            }
            return v
        }

        /// A value's fields in the keys' order; nil: the key removed.
        static func pairs(_ v: [String: Val?]) -> Pairs {
            var out: Pairs = []
            for k in Ax.keys { if let x = v[k] { out.append((k, x?.any)) } }
            for k in v.keys.sorted() where !Ax.keys.contains(k) { out.append((k, v[k]!?.any)) }
            return out
        }

        private func add(_ c: Node) {
            let v = full(c)
            c.sent = v
            // never an empty value: it would read as a list
            let value = v.isEmpty ? [("role", nil)] : Tree.pairs(v)
            sink([("add", c.n), ("parent", c.parent == root.n ? 0 : c.parent), ("name", c.name), ("value", value)])
        }

        /// Sends the keys of x that changed; the app's own: its order, cut and more.
        private func publish(_ x: Node) {
            let v = full(x)
            var diff: [String: Val?] = [:]
            for (k, a) in v where x.sent[k] != a { diff[k] = .some(a) }
            for k in x.sent.keys where v[k] == nil { diff[k] = .some(nil) }
            x.sent = v
            guard !diff.isEmpty else { return }
            sink([("set", x.n), ("value", Tree.pairs(diff))])
        }

        /// n and all under it gone: one drop item.
        private func drop(_ n: Int) {
            guard nodes[n] != nil else { return }
            sink([("drop", n)])
            var gone = 0
            var list = [n]
            while let k = list.popLast() {
                guard let c = nodes.removeValue(forKey: k) else { continue }
                if index[Key(c.element)] == k { index[Key(c.element)] = nil }
                starved.remove(k)
                list += c.kids
                gone += 1
            }
            give(gone)
        }

        /// n found gone outside a walk, or trimmed (budget): dropped, its
        /// parent's order sent, and for budget the parent cut so.
        private func remove(_ n: Int, budget: Bool = false) {
            guard let x = nodes[n], x !== root else { return }
            drop(n)
            if let p = nodes[x.parent] {
                p.kids.removeAll { $0 == n }
                if budget, p.cut == nil || p.cut == "budget" {
                    p.cut = "budget"
                    p.more += 1
                    starved.insert(p.n)
                }
                publish(p)
            }
        }
    }
}
