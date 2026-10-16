// Menus.swift: the OS's menus in the Mac's menu bar (menus, ../METAL.md).
// After the metal's own (the app's, Edit, View): the OS's menus, the world
// menu (the rabbit's, titled ermine) first, then the focused window's, as
// the OS's own menu bar shows them, made again each time the OS sends them.
// Choosing an item is a record, irq 33 {event: "menu", n, menu, item, sub?}
// (sub its place in each submenu, down from item): the OS does what choosing
// it in its own menu bar does. An item with items is a submenu; on, a tick;
// icon, a picture ({colors, rows}), drawn a point a pixel.
//
// A chord beside an item is shown, not taken: the menus answer no key
// equivalents (menuHasKeyEquivalent), so the key goes to the OS as a key,
// whose window manager or window does what it does.

import AppKit

@MainActor
final class Menus: NSObject, NSMenuDelegate {
    private let bus: Bus
    /// how many of the menu bar's menus are the metal's own, left as they are
    private var fixed = -1
    /// the menus' n, said back with a choice, so the OS lets a choice from older menus be
    private var n = 0

    init(bus: Bus) { self.bus = bus }

    /// menus {n, menus: [{title, items: [{label, key?, off?, on?, icon?, items?} | "-"]}]}
    func show(_ c: [String: Any]) {
        guard let bar = NSApp.mainMenu else { return }
        if fixed < 0 { fixed = bar.numberOfItems }
        while bar.numberOfItems > fixed { bar.removeItem(at: fixed) }
        n = int(c["n"]) ?? 0
        for (i, m) in ((c["menus"] as? [Any]) ?? []).enumerated() {
            guard let m = m as? [String: Any], let title = m["title"] as? String, let items = m["items"] as? [Any] else { continue }
            add(bar, title, items, menu: i)
        }
    }

    private func add(_ bar: NSMenu, _ title: String, _ items: [Any], menu: Int) {
        let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        top.submenu = submenu(title, items, at: [menu])
        bar.addItem(top)
    }

    /// a menu's items, at its place: the menu's, then each item's down to it, said back when one is chosen
    private func submenu(_ title: String, _ items: [Any], at: [Int]) -> NSMenu {
        let sub = NSMenu(title: title)
        sub.autoenablesItems = false
        sub.delegate = self
        for (k, it) in items.enumerated() {
            guard let it = it as? [String: Any], let label = it["label"] as? String else {
                sub.addItem(.separator())
                continue
            }
            let item = NSMenuItem(title: label, action: nil, keyEquivalent: "")
            item.isEnabled = !((it["off"] as? Bool) ?? false)
            item.state = (it["on"] as? Bool) ?? false ? .on : .off
            if let icon = it["icon"] as? [String: Any] { item.image = Menus.picture(icon) }
            if let items = it["items"] as? [Any] {
                item.submenu = submenu(label, items, at: at + [k])
            } else {
                item.action = #selector(chose(_:))
                item.target = self
                item.representedObject = at + [k]
            }
            if let key = it["key"] as? String, let (equivalent, mask) = Menus.chord(key) {
                item.keyEquivalent = equivalent
                item.keyEquivalentModifierMask = mask
            }
            sub.addItem(item)
        }
        return sub
    }

    /// a picture, {colors: {letter: 0xRRGGBB}, rows}, a point a pixel; a letter not in colors clear
    static func picture(_ v: [String: Any]) -> NSImage? {
        guard let rows = v["rows"] as? [String], !rows.isEmpty else { return nil }
        let colors = (v["colors"] as? [String: Any]) ?? [:]
        let w = rows.map(\.count).max() ?? 0, h = rows.count
        guard w > 0 else { return nil }
        return NSImage(size: NSSize(width: w, height: h), flipped: true) { _ in
            for (j, row) in rows.enumerated() {
                for (i, ch) in row.enumerated() {
                    guard let c = (colors[String(ch)] as? NSNumber)?.intValue else { continue }
                    NSColor(srgbRed: CGFloat((c >> 16) & 0xff) / 255, green: CGFloat((c >> 8) & 0xff) / 255, blue: CGFloat(c & 0xff) / 255, alpha: 1).setFill()
                    NSRect(x: i, y: j, width: 1, height: 1).fill()
                }
            }
            return true
        }
    }

    /// shown, never taken: the key is the OS's
    func menuHasKeyEquivalent(_ menu: NSMenu, for event: NSEvent, target: AutoreleasingUnsafeMutablePointer<AnyObject?>,
                              action: UnsafeMutablePointer<Selector?>) -> Bool {
        false
    }

    @objc private func chose(_ sender: NSMenuItem) {
        let at = sender.representedObject as? [Int] ?? []
        guard at.count >= 2 else { return }
        var fields: Fields = [("event", "menu"), ("n", n), ("menu", at[0]), ("item", at[1])]
        if at.count > 2 { fields.append(("sub", Array(at.dropFirst(2)) as [Any?])) }
        bus.send(33, fields)
    }

    /// a chord as the OS writes one, its modifiers then its key: "cmd-shift-n", "alt-Enter" (a window's
    /// menus) or "s-S-n", "A-return" (/etc/keys: s, super, is cmd; M, as chords were once written, too;
    /// H, hyper, is fn); as AppKit shows it
    static func chord(_ text: String) -> (String, NSEvent.ModifierFlags)? {
        var parts = text.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard var key = parts.popLast() else { return nil }
        if key.isEmpty, parts.last == "" { parts.removeLast(); key = "-" }
        var mask: NSEvent.ModifierFlags = []
        for m in parts {
            switch m {
            case "cmd", "M", "s": mask.insert(.command)
            case "ctrl", "C": mask.insert(.control)
            case "alt", "A": mask.insert(.option)
            case "shift", "S": mask.insert(.shift)
            case "fn", "H": mask.insert(.function)
            default: return nil
            }
        }
        let named: [String: Int] = [
            "Enter": 0x0D, "return": 0x0D, "Tab": 0x09, "tab": 0x09, "Backspace": 0x08, "backspace": 0x08,
            "Delete": NSDeleteFunctionKey, "delete": NSDeleteFunctionKey, "Escape": 0x1B, "escape": 0x1B,
            "Space": 0x20, "space": 0x20,
            "ArrowUp": NSUpArrowFunctionKey, "up": NSUpArrowFunctionKey, "ArrowDown": NSDownArrowFunctionKey, "down": NSDownArrowFunctionKey,
            "ArrowLeft": NSLeftArrowFunctionKey, "left": NSLeftArrowFunctionKey, "ArrowRight": NSRightArrowFunctionKey, "right": NSRightArrowFunctionKey,
            "Home": NSHomeFunctionKey, "home": NSHomeFunctionKey, "End": NSEndFunctionKey, "end": NSEndFunctionKey,
            "period": 0x2E, "comma": 0x2C, "minus": 0x2D, "equal": 0x3D, "slash": 0x2F, "backslash": 0x5C, "grave": 0x60,
        ]
        if let code = named[key], let scalar = UnicodeScalar(code) { return (String(Character(scalar)), mask) }
        guard key.count == 1 else { return nil }
        return (key.lowercased(), mask)
    }
}
