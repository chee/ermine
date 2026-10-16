// TapRule.swift: which keys the tap (Tap.swift) takes from the system, as
// a rule with no Mac in it, so it can be tested alone.
//
// A chord is taken only if the Mac keeps it for itself (reserved, below) and
// /etc/keys wants it: binds it, or says "system": true, every reserved one.
// Force quit (cmd-alt-Escape) and lock screen (ctrl-cmd-q), the ways out,
// only when bound by name. While cmd is held after a taken cmd-Tab or
// cmd-`, Tab and ` with cmd (shift or not) are taken too, as switchers do.

/// The modifiers a chord names: cmd, alt, ctrl, shift.
struct TapMods: OptionSet, Hashable {
    let rawValue: Int
    static let cmd = TapMods(rawValue: 1)
    static let alt = TapMods(rawValue: 2)
    static let ctrl = TapMods(rawValue: 4)
    static let shift = TapMods(rawValue: 8)
}

/// A key, by its virtual code, with modifiers.
struct TapChord: Hashable {
    let code: UInt16
    let mods: TapMods

    /// As /etc/keys writes it, the one way readline's normal makes it: A C S s, then the key ("s-S-3").
    var written: String {
        var parts: [String] = []
        if mods.contains(.alt) { parts.append("A") }
        if mods.contains(.ctrl) { parts.append("C") }
        if mods.contains(.shift) { parts.append("S") }
        if mods.contains(.cmd) { parts.append("s") }
        return (parts + [tapKeyName(code)]).joined(separator: "-")
    }
}

/// readline's names for keys in a chord, by the key record's name (or the character written).
private let tapNames: [String: String] = [
    "Enter": "return", "Tab": "tab", "Space": "space", "Backspace": "backspace", "Escape": "escape", "Delete": "delete",
    "ArrowLeft": "left", "ArrowRight": "right", "ArrowUp": "up", "ArrowDown": "down", "Home": "home", "End": "end",
    "PageUp": "pageup", "PageDown": "pagedown", ".": "period", ",": "comma", "-": "minus", "=": "equal", "/": "slash",
    "\\": "backslash", ";": "semicolon", "'": "quote", "`": "grave", "[": "bracketleft", "]": "bracketright", " ": "space",
]

/// A key's name in a chord, as readline's keyName gives it from the key record's name.
func tapKeyName(_ code: UInt16) -> String {
    let key = keyName(code)
    return tapNames[key] ?? key.lowercased()
}

/// A chord as a person writes it in /etc/keys, made the one way: modifiers in any order, m and M as s
/// (the tap runs only while taking over, when m, meta, is cmd); nil for one with H (fn), never reserved.
func tapNormal(_ text: String) -> String? {
    var parts = text.trimmingCharacters(in: .whitespaces).components(separatedBy: "-")
    var key = parts.popLast() ?? ""
    if key.isEmpty, parts.last == "" {
        parts.removeLast()
        key = "-"
    }
    var mods = Set<String>()
    for p in parts {
        switch p {
        case "m", "M", "s": mods.insert("s")
        case "S": mods.insert("S")
        case "a", "A": mods.insert("A")
        case "c", "C": mods.insert("C")
        default: return nil  // H, or something not a modifier
        }
    }
    key = tapNames[key] ?? key.lowercased()
    return (["A", "C", "S", "s"].filter { mods.contains($0) } + [key]).joined(separator: "-")
}

enum TapRule {
    /// What the Mac keeps for itself, before any app sees it.
    static let reserved: [TapChord] = {
        let tab: UInt16 = 0x30, grave: UInt16 = 0x32, space: UInt16 = 0x31, esc: UInt16 = 0x35
        var all: [TapChord] = [
            // the app switcher, and the next window of the app
            TapChord(code: tab, mods: .cmd), TapChord(code: tab, mods: [.cmd, .shift]),
            TapChord(code: grave, mods: .cmd), TapChord(code: grave, mods: [.cmd, .shift]),
            // Spotlight, Finder's search, input sources, the character viewer
            TapChord(code: space, mods: .cmd), TapChord(code: space, mods: [.cmd, .alt]),
            TapChord(code: space, mods: .ctrl), TapChord(code: space, mods: [.ctrl, .alt]),
            TapChord(code: space, mods: [.ctrl, .cmd]),
            // the Dock hidden or shown
            TapChord(code: 0x02, mods: [.cmd, .alt]),
            // the ways out: force quit, lock screen (bound by name only)
            TapChord(code: esc, mods: [.cmd, .alt]), TapChord(code: 0x0C, mods: [.ctrl, .cmd]),
        ]
        // screenshots: cmd-shift-3 4 5, and to the clipboard with ctrl
        for code: UInt16 in [0x14, 0x15, 0x17] {
            all.append(TapChord(code: code, mods: [.cmd, .shift]))
            all.append(TapChord(code: code, mods: [.cmd, .shift, .ctrl]))
        }
        // Mission Control, application windows, and spaces left and right
        for code: UInt16 in [0x7E, 0x7D, 0x7B, 0x7C] { all.append(TapChord(code: code, mods: .ctrl)) }
        // keyboard navigation: ctrl-F1 to F8
        for code: UInt16 in [0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64] { all.append(TapChord(code: code, mods: .ctrl)) }
        return all
    }()

    /// The ways out: never taken by "system": true, only when bound by name.
    static let waysOut: Set<TapChord> = [TapChord(code: 0x35, mods: [.cmd, .alt]), TapChord(code: 0x0C, mods: [.ctrl, .cmd])]

    /// The reserved chords /etc/keys wants: bound (its keys whose commands are strings), or all but the ways out for system.
    static func wanted(bound: [String], system: Bool) -> Set<TapChord> {
        let written = Set(bound.compactMap(tapNormal))
        return Set(reserved.filter { written.contains($0.written) || (system && !waysOut.contains($0)) })
    }
}

/// The tap's state: what it took and has not let go, and whether a switcher is held.
struct TapState {
    var wanted: Set<TapChord> = []
    /// keys whose down the tap took: their ups are taken too
    private(set) var downs = Set<UInt16>()
    /// cmd held since a taken cmd-Tab or cmd-`: Tab and ` with cmd are taken until it goes up
    private(set) var switching = false

    init(wanted: Set<TapChord> = []) { self.wanted = wanted }

    /// Whether a key down is taken.
    mutating func down(_ code: UInt16, _ mods: TapMods) -> Bool {
        let chord = TapChord(code: code, mods: mods)
        let switcher = (code == 0x30 || code == 0x32) && mods.contains(.cmd)
        guard wanted.contains(chord) || (switching && switcher) else { return false }
        downs.insert(code)
        if switcher { switching = true }
        return true
    }

    /// Whether a key up is taken: the up of every down taken.
    mutating func up(_ code: UInt16) -> Bool { downs.remove(code) != nil }

    /// The modifiers changed (never taken: the app hears them itself): cmd up ends a switcher.
    mutating func flags(_ mods: TapMods) {
        if !mods.contains(.cmd) { switching = false }
    }

    /// The tap went away: nothing is held.
    mutating func reset() {
        downs.removeAll()
        switching = false
    }
}
