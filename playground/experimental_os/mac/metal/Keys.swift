// Keys.swift: the Mac's virtual key codes, named.
//
// The names are the keys' places on a US (ANSI) keyboard, whatever the
// layout: `key` says which key, `text` says what it typed.

import AppKit

let keyNames: [UInt16: String] = [
    // letters
    0x00: "a", 0x0B: "b", 0x08: "c", 0x02: "d", 0x0E: "e", 0x03: "f", 0x05: "g", 0x04: "h",
    0x22: "i", 0x26: "j", 0x28: "k", 0x25: "l", 0x2E: "m", 0x2D: "n", 0x1F: "o", 0x23: "p",
    0x0C: "q", 0x0F: "r", 0x01: "s", 0x11: "t", 0x20: "u", 0x09: "v", 0x0D: "w", 0x07: "x",
    0x10: "y", 0x06: "z",
    // digits
    0x1D: "0", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x17: "5", 0x16: "6", 0x1A: "7",
    0x1C: "8", 0x19: "9",
    // punctuation
    0x1B: "-", 0x18: "=", 0x21: "[", 0x1E: "]", 0x2A: "\\", 0x29: ";", 0x27: "'", 0x2B: ",",
    0x2F: ".", 0x2C: "/", 0x32: "`", 0x0A: "§",
    // whitespace and editing
    0x24: "Enter", 0x30: "Tab", 0x31: "Space", 0x33: "Backspace", 0x35: "Escape", 0x75: "Delete",
    0x72: "Help",
    // navigation
    0x7E: "ArrowUp", 0x7D: "ArrowDown", 0x7B: "ArrowLeft", 0x7C: "ArrowRight",
    0x73: "Home", 0x77: "End", 0x74: "PageUp", 0x79: "PageDown",
    // function keys
    0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6", 0x62: "F7", 0x64: "F8",
    0x65: "F9", 0x6D: "F10", 0x67: "F11", 0x6F: "F12", 0x69: "F13", 0x6B: "F14", 0x71: "F15",
    0x6A: "F16", 0x40: "F17", 0x4F: "F18", 0x50: "F19", 0x5A: "F20",
    // modifiers
    0x38: "Shift", 0x3C: "Shift", 0x3B: "Control", 0x3E: "Control", 0x3A: "Alt", 0x3D: "Alt",
    0x37: "Meta", 0x36: "Meta", 0x39: "CapsLock", 0x3F: "Fn",
    // keypad: the same names as the keys they type
    0x52: "0", 0x53: "1", 0x54: "2", 0x55: "3", 0x56: "4", 0x57: "5", 0x58: "6", 0x59: "7",
    0x5B: "8", 0x5C: "9", 0x41: ".", 0x43: "*", 0x45: "+", 0x4B: "/", 0x4E: "-", 0x51: "=",
    0x4C: "Enter", 0x47: "Clear",
    // media and others
    0x48: "AudioVolumeUp", 0x49: "AudioVolumeDown", 0x4A: "AudioVolumeMute", 0x6E: "ContextMenu",
    // JIS
    0x5D: "¥", 0x5E: "_", 0x5F: ",", 0x66: "Eisu", 0x68: "KanaMode",
]

func keyName(_ code: UInt16) -> String {
    keyNames[code] ?? "Unidentified"
}

/// The device-dependent flag bit that says whether this modifier key (left
/// or right) is held, from IOLLEvent.h's NX_DEVICE*KEYMASK.
let modifierDeviceMask: [UInt16: UInt] = [
    0x3B: 0x0000_0001,  // left control
    0x38: 0x0000_0002,  // left shift
    0x3C: 0x0000_0004,  // right shift
    0x37: 0x0000_0008,  // left command
    0x36: 0x0000_0010,  // right command
    0x3A: 0x0000_0020,  // left option
    0x3D: 0x0000_0040,  // right option
    0x3E: 0x0000_2000,  // right control
]

/// The device-independent flag for each modifier key.
let modifierFlag: [UInt16: NSEvent.ModifierFlags] = [
    0x38: .shift, 0x3C: .shift, 0x3B: .control, 0x3E: .control, 0x3A: .option, 0x3D: .option,
    0x37: .command, 0x36: .command, 0x39: .capsLock, 0x3F: .function,
]

/// The `mods` list. `fn` comes from the Fn key's own state, because macOS
/// also sets the function flag for arrows and function keys.
func modsList(_ flags: NSEvent.ModifierFlags, fn: Bool) -> [Any?] {
    var mods: [Any?] = []
    if flags.contains(.shift) { mods.append("shift") }
    if flags.contains(.control) { mods.append("ctrl") }
    if flags.contains(.option) { mods.append("alt") }
    if flags.contains(.command) { mods.append("cmd") }
    if flags.contains(.capsLock) { mods.append("caps") }
    if fn { mods.append("fn") }
    return mods
}

/// What a key typed: the event's characters, without the private-use
/// characters AppKit gives arrows and function keys.
func typedText(_ event: NSEvent) -> String {
    guard let chars = event.characters else { return "" }
    var out = String.UnicodeScalarView()
    for u in chars.unicodeScalars where !(0xF700...0xF8FF).contains(u.value) {
        out.append(u)
    }
    return String(out)
}
