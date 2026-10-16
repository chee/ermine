// Access.swift: the screen's meaning, for VoiceOver (../METAL.md, Meaning).
// The OS draws pixels; access says what they are, as a tree of elements,
// and the metal mirrors it as the views' accessibility children: on the
// monitor, every top-level element without a surface; in a surface's
// window, those with its id. An element whose id stays from one tree to the
// next is the same object, so VoiceOver stays where it was. Pressing one is
// a click at its centre.

import AppKit

// MARK: - the tree, as the OS sends it

/// One element of the tree. Its rectangle is in frame buffer pixels where
/// it shows: the monitor's, or its surface's content's.
struct Node: Equatable, Sendable {
    var id: String
    var role: String
    var x = 0, y = 0, w = 0, h = 0
    var label: String?
    var value: String?
    /// UTF-16 offsets into value
    var selection: Range<Int>?
    /// the surface it is in (top level only); nil: the monitor
    var surface: String?
    var children: [Node] = []
}

/// The tree from an access command. An element without an id is left out,
/// with what is under it.
func parseTree(_ v: Any?) -> [Node] {
    guard let list = v as? [Any] else { return [] }
    return list.compactMap(parseNode)
}

private func parseNode(_ v: Any) -> Node? {
    guard let d = v as? [String: Any], let id = d["id"] as? String else { return nil }
    var node = Node(id: id, role: d["role"] as? String ?? "group")
    node.x = int(d["x"]) ?? 0
    node.y = int(d["y"]) ?? 0
    node.w = max(0, int(d["w"]) ?? 0)
    node.h = max(0, int(d["h"]) ?? 0)
    node.label = d["label"] as? String
    node.value = d["value"] as? String ?? (d["value"] as? NSNumber)?.stringValue
    if let s = d["selection"] as? [Any], s.count == 2, let a = int(s[0]), let b = int(s[1]) {
        node.selection = max(0, min(a, b))..<max(0, a, b)
    }
    node.surface = d["surface"] as? String
    node.children = parseTree(d["children"])
    return node
}

/// The Mac's role for one of the contract's.
func accessRole(_ name: String) -> NSAccessibility.Role {
    switch name {
    case "text": .staticText
    case "button": .button
    case "textfield": .textField
    case "textarea": .textArea
    case "menu": .menu
    case "menuitem": .menuItem
    case "toolbar": .toolbar
    case "image": .image
    case "list": .list
    default: .group
    }
}

/// An element in its place: its parent's id, and the surface of its top level.
struct Placed {
    var node: Node
    var parent: String?
    var surface: String?
}

/// The tree in order, each element after its parent. An id seen already
/// is left out the second time, with what is under it.
func flatten(_ tree: [Node]) -> [Placed] {
    var out: [Placed] = []
    var seen = Set<String>()
    func walk(_ nodes: [Node], parent: String?, surface: String?) {
        for n in nodes where seen.insert(n.id).inserted {
            let s = parent == nil ? n.surface : surface
            out.append(Placed(node: n, parent: parent, surface: s))
            walk(n.children, parent: n.id, surface: s)
        }
    }
    walk(tree, parent: nil, surface: nil)
    return out
}

/// What changed from one tree to the next, to announce.
struct Changes: Equatable {
    /// the hosts (nil: the monitor; else a surface's id) whose elements, or their places or frames, changed
    var layout: Set<String?> = []
    var focus = false
    /// the focused element's value, or its selection, changed
    var value = false
    var selection = false
}

private struct Shape: Equatable {
    var id: String
    var parent: String?
    var role: String
    var x, y, w, h: Int
}

func changes(from old: [Node], focus oldFocus: String?, to new: [Node], focus newFocus: String?) -> Changes {
    let before = flatten(old), after = flatten(new)
    func shapes(_ flat: [Placed]) -> [String?: [Shape]] {
        Dictionary(grouping: flat, by: \.surface).mapValues {
            $0.map { Shape(id: $0.node.id, parent: $0.parent, role: $0.node.role, x: $0.node.x, y: $0.node.y, w: $0.node.w, h: $0.node.h) }
        }
    }
    let a = shapes(before), b = shapes(after)
    var c = Changes()
    for key in Set(a.keys).union(b.keys) where a[key] != b[key] { c.layout.insert(key) }
    if oldFocus != newFocus {
        c.focus = true
    } else if let f = newFocus, let was = before.first(where: { $0.node.id == f })?.node, let now = after.first(where: { $0.node.id == f })?.node {
        c.value = was.value != now.value
        c.selection = was.selection != now.selection
    }
    return c
}

// MARK: - lines, for text fields and areas

/// The line an index is on, from 0; lines end at "\n".
func lineNumber(at index: Int, in text: NSString) -> Int {
    var n = 0
    for i in 0..<min(max(index, 0), text.length) where text.character(at: i) == 0x0A { n += 1 }
    return n
}

/// A line's range, its "\n" with it; past the last line, an empty range at the end.
func lineRange(_ line: Int, in text: NSString) -> NSRange {
    var start = 0, n = 0
    while n < line {
        let r = text.range(of: "\n", options: .literal, range: NSRange(location: start, length: text.length - start))
        guard r.location != NSNotFound else { return NSRange(location: text.length, length: 0) }
        start = r.location + 1
        n += 1
    }
    let r = text.range(of: "\n", options: .literal, range: NSRange(location: start, length: text.length - start))
    let end = r.location == NSNotFound ? text.length : r.location + 1
    return NSRange(location: start, length: end - start)
}

// MARK: - the elements

/// One of the OS's elements, as the Mac's accessibility sees it. Asked on
/// the main thread.
final class Element: NSAccessibilityElement {
    let id: String
    private weak var access: Access?
    private(set) var role = NSAccessibility.Role.group
    private(set) var rect = NSRect.zero
    private(set) var label: String?
    private(set) var value: String?
    private(set) var selection: NSRange?
    /// the surface of its top level; nil: the monitor
    private(set) var surface: String?
    weak var up: Element?
    var kids: [Element] = []
    var focused = false
    /// left out of the last tree
    var gone = false

    init(id: String, access: Access) {
        self.id = id
        self.access = access
        super.init()
    }

    func update(_ n: Node, surface: String?) {
        role = accessRole(n.role)
        rect = NSRect(x: n.x, y: n.y, width: n.w, height: n.h)
        label = n.label
        value = n.value
        selection = n.selection.map { NSRange($0) }
        self.surface = surface
        gone = false
    }

    private var isText: Bool { role == .textField || role == .textArea }
    private var text: NSString { (value ?? "") as NSString }

    /// The view it shows in.
    private var host: PixelView? {
        MainActor.assumeIsolated { access?.host(surface) }
    }

    override func accessibilityRole() -> NSAccessibility.Role? { role }
    override func accessibilityRoleDescription() -> String? { role.description(with: nil) }
    override func accessibilityLabel() -> String? { label }
    override func accessibilityValue() -> Any? { role == .staticText ? value ?? label : value }
    override func accessibilityIdentifier() -> String { id }
    override func isAccessibilityElement() -> Bool { !gone }
    override func isAccessibilityFocused() -> Bool { focused }
    override func accessibilityParent() -> Any? { gone ? nil : up ?? host }
    override func accessibilityChildren() -> [Any]? { kids }
    override func accessibilityWindow() -> Any? { gone ? nil : MainActor.assumeIsolated { host?.window } }
    override func accessibilityTopLevelUIElement() -> Any? { accessibilityWindow() }

    /// Its frame buffer rectangle through its view, asked each time, so it follows the window.
    override func accessibilityFrame() -> NSRect {
        guard !gone, let host else { return .zero }
        return MainActor.assumeIsolated { host.screenRect(rect) }
    }

    /// The deepest element at a point in screen coordinates: of those
    /// side by side, the last, drawn on top. Children are looked at even
    /// outside their parent's frame, which may be empty.
    override func accessibilityHitTest(_ point: NSPoint) -> Any? { deepest(at: point) ?? self }

    func deepest(at point: NSPoint) -> Element? {
        for kid in kids.reversed() { if let hit = kid.deepest(at: point) { return hit } }
        return accessibilityFrame().contains(point) ? self : nil
    }

    /// A click at its centre (irq 35, access: true).
    override func accessibilityPerformPress() -> Bool {
        guard !gone, let host else { return false }
        let x = Int(rect.minX) + Int(rect.width) / 2, y = Int(rect.minY) + Int(rect.height) / 2
        MainActor.assumeIsolated { host.accessClick(x: x, y: y) }
        return true
    }

    // text fields and areas: the value is the text

    override func accessibilityNumberOfCharacters() -> Int { isText ? text.length : super.accessibilityNumberOfCharacters() }

    override func accessibilitySelectedTextRange() -> NSRange {
        guard isText else { return super.accessibilitySelectedTextRange() }
        return clamp(selection ?? NSRange(location: text.length, length: 0), to: text.length)
    }

    override func accessibilitySelectedText() -> String? {
        guard isText else { return super.accessibilitySelectedText() }
        return text.substring(with: accessibilitySelectedTextRange())
    }

    override func accessibilityVisibleCharacterRange() -> NSRange {
        isText ? NSRange(location: 0, length: text.length) : super.accessibilityVisibleCharacterRange()
    }

    override func accessibilityString(for range: NSRange) -> String? {
        guard isText else { return super.accessibilityString(for: range) }
        return text.substring(with: clamp(range, to: text.length))
    }

    override func accessibilityLine(for index: Int) -> Int {
        isText ? lineNumber(at: index, in: text) : super.accessibilityLine(for: index)
    }

    override func accessibilityRange(forLine line: Int) -> NSRange {
        isText ? lineRange(line, in: text) : super.accessibilityRange(forLine: line)
    }

    override func accessibilityInsertionPointLineNumber() -> Int {
        isText ? lineNumber(at: accessibilitySelectedTextRange().location, in: text) : super.accessibilityInsertionPointLineNumber()
    }

    override func accessibilityFrame(for range: NSRange) -> NSRect {
        isText ? accessibilityFrame() : super.accessibilityFrame(for: range)
    }
}

// MARK: - the tree, kept

/// The last tree, as elements kept by id.
@MainActor
final class Access {
    private var tree: [Node] = []
    private(set) var focus: String?
    private var elements: [String: Element] = [:]
    /// the top-level elements of each host: nil, the monitor; else a surface's id
    private var tops: [String?: [Element]] = [:]
    /// the view that shows a surface, or the monitor for nil
    var host: (String?) -> PixelView? = { _ in nil }

    /// access {tree, focus}: replaces the last tree, keeping each element
    /// whose id stays, and announces what changed.
    func apply(_ new: [Node], focus: String?) {
        let change = changes(from: tree, focus: self.focus, to: new, focus: focus)
        let flat = flatten(new)
        var kept: [String: Element] = [:]
        for p in flat {
            let e = elements[p.node.id] ?? Element(id: p.node.id, access: self)
            e.update(p.node, surface: p.surface)
            e.up = nil
            e.kids = []
            e.focused = p.node.id == focus
            kept[p.node.id] = e
        }
        var tops: [String?: [Element]] = [:]
        for p in flat {
            let e = kept[p.node.id]!
            if let parent = p.parent.flatMap({ kept[$0] }) {
                e.up = parent
                parent.kids.append(e)
            } else {
                tops[p.surface, default: []].append(e)
            }
        }
        var gone: [Element] = []
        for (id, e) in elements where kept[id] == nil {
            e.gone = true
            e.up = nil
            e.kids = []
            e.focused = false
            gone.append(e)
        }
        elements = kept
        self.tops = tops
        tree = new
        self.focus = focus
        announce(change, gone: gone)
    }

    private func announce(_ c: Changes, gone: [Element]) {
        for e in gone { NSAccessibility.post(element: e, notification: .uiElementDestroyed) }
        for key in c.layout {
            if let v = host(key) { NSAccessibility.post(element: v, notification: .layoutChanged) }
        }
        guard let f = focus, let e = elements[f] else { return }
        if c.focus { NSAccessibility.post(element: e, notification: .focusedUIElementChanged) }
        if c.value { NSAccessibility.post(element: e, notification: .valueChanged) }
        if c.selection { NSAccessibility.post(element: e, notification: .selectedTextChanged) }
    }

    func element(_ id: String) -> Element? { elements[id] }

    /// The top-level elements in a host: nil, the monitor; else a surface's id.
    func top(_ surface: String?) -> [Element] { tops[surface] ?? [] }

    /// The deepest element at a point in screen coordinates, in a host.
    func hit(_ point: NSPoint, in surface: String?) -> Element? {
        for e in top(surface).reversed() { if let hit = e.deepest(at: point) { return hit } }
        return nil
    }

    /// The element with the keyboard, if it is in that host.
    func focused(in surface: String?) -> Element? {
        guard let f = focus, let e = elements[f], e.surface == surface else { return nil }
        return e
    }
}

// MARK: - the views, as hosts

extension PixelView {
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    /// The monitor is "ermine"; a surface is its window's title.
    override func accessibilityLabel() -> String? { surface == nil ? "ermine" : window?.title }

    /// Its subviews (web views), then the OS's elements in it.
    override func accessibilityChildren() -> [Any]? {
        (super.accessibilityChildren() ?? []) + (access?.top(surface) ?? [])
    }

    /// A web view in it first, then the OS's deepest element there, else itself.
    override func accessibilityHitTest(_ point: NSPoint) -> Any? {
        if let hit = super.accessibilityHitTest(point), (hit as AnyObject) !== self { return hit }
        return access?.hit(point, in: surface) ?? self
    }

    override var accessibilityFocusedUIElement: Any? { access?.focused(in: surface) ?? self }
}
