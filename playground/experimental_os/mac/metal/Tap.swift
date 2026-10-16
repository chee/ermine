// Tap.swift: the keys the Mac keeps for itself (cmd-Tab, cmd-Space,
// screenshots, ctrl-arrows…), taken for the OS while it takes the Mac over.
//
// They never reach an app as an NSEvent, so a session event tap takes them
// first: while taking over, ermineOS active and its window key, and only
// the chords TapRule.swift says (reserved and wanted by /etc/keys). A taken
// key goes to the keyboard as any key does, and the system never sees it;
// its up is taken too. The modifiers are never taken: the app hears them
// itself. No key is taken while secure input is on (a password field
// anywhere). Without Accessibility there is no tap: the mode's `keys` says
// "no access". ERMINE_TAP=hid taps where events enter the window server
// instead, before anything of the session's.

import AppKit
import Carbon.HIToolbox

@MainActor
final class Tap {
    /// a key taken, given to the keyboard
    var deliver: (NSEvent) -> Void = { _ in }
    /// "tapped", "no access" (Accessibility not allowed), or "off" (no tap: not taking over, not key, or nothing to take)
    private(set) var status = "off"
    private var state = TapState()
    private var system = false
    private var port: CFMachPort?
    private var source: CFRunLoopSource?
    private var on = false
    private var warned = false

    /// /etc/keys' chords (those that run a command) and its "system".
    func bindings(_ chords: [String], system: Bool) {
        self.system = system
        state.wanted = TapRule.wanted(bound: chords, system: system)
        log("tap: \(state.wanted.count) of the Mac's keys wanted\(system ? " (system)" : ""): \(state.wanted.map(\.written).sorted().joined(separator: " "))")
    }

    /// The tap there, or not: on while taking over, active and key. Returns whether the status changed.
    @discardableResult
    func update(on want: Bool) -> Bool {
        let was = status
        let wanted = want && !state.wanted.isEmpty
        if wanted, !on {
            on = true
            install()
        } else if !wanted, on {
            on = false
            remove()
        }
        if !wanted { status = "off" }
        return status != was
    }

    private func install() {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        let at: CGEventTapLocation = ProcessInfo.processInfo.environment["ERMINE_TAP"] == "hid" ? .cghidEventTap : .cgSessionEventTap
        guard let port = CGEvent.tapCreate(tap: at, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: CGEventMask(mask),
                                           callback: tapped, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            status = "no access"
            if !warned {
                warned = true
                log("tap: no event tap (Accessibility not allowed?): the Mac keeps cmd-Tab and the rest")
            }
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        self.port = port
        self.source = source
        status = "tapped"
        log("tap: on (\(at == .cghidEventTap ? "hid" : "session"))")
    }

    private func remove() {
        if let port {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        let had = port != nil
        port = nil
        source = nil
        state.reset()
        if had { log("tap: off") }
    }

    /// An event at the tap: nil when taken.
    fileprivate func event(_ type: CGEventType, _ e: CGEvent) -> Unmanaged<CGEvent>? {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // the system turned it off (too slow, or secure input): on again
            if let port, on { CGEvent.tapEnable(tap: port, enable: true) }
            return Unmanaged.passUnretained(e)
        case .keyDown, .keyUp, .flagsChanged:
            break
        default:
            return Unmanaged.passUnretained(e)
        }
        let code = UInt16(e.getIntegerValueField(.keyboardEventKeycode))
        var mods: TapMods = []
        if e.flags.contains(.maskCommand) { mods.insert(.cmd) }
        if e.flags.contains(.maskAlternate) { mods.insert(.alt) }
        if e.flags.contains(.maskControl) { mods.insert(.ctrl) }
        if e.flags.contains(.maskShift) { mods.insert(.shift) }
        let taken: Bool
        switch type {
        case .keyDown: taken = NSApp.isActive && !IsSecureEventInputEnabled() && state.down(code, mods)
        case .keyUp: taken = state.up(code)
        default:
            state.flags(mods)
            taken = false
        }
        guard taken else { return Unmanaged.passUnretained(e) }
        if let ns = NSEvent(cgEvent: e) { deliver(ns) }
        return nil
    }
}

/// The tap's callback, on the main run loop.
private func tapped(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ info: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let info else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<Tap>.fromOpaque(info).takeUnretainedValue()
    return MainActor.assumeIsolated { tap.event(type, event) }
}
