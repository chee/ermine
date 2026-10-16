// probe.swift: what the Accessibility API would give ermineOS of an app
// already running, read only (design-macos.md). Never asks for permission,
// never acts, never posts input: it says whether this process is trusted
// (Accessibility) and may capture (Screen Recording), lists the apps, and,
// trusted, prints one app's tree to a depth, with how long it took.
//
//   probe                  permissions and the running apps, with their windows on screen
//   probe <pid|name> [depth] [--values]   that app's tree, depth 4 by default
//   probe --all [budget]   every app's tree as the mirror would walk it: elements,
//                          depth, cut stubs, timeouts and ms per app, budget a cap
//                          on each app's elements (4000)
//
// Build: swiftc -O probe.swift -o ../mac/build/probe

import AppKit
import ApplicationServices
import CoreGraphics

func say(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }

// no prompt: the option false, and preflight, which never asks
let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): false] as CFDictionary)
let capture = CGPreflightScreenCaptureAccess()
say("accessibility: \(trusted ? "trusted" : "no permission")")
say("screen recording: \(capture ? "allowed" : "no permission")")

var args = Array(CommandLine.arguments.dropFirst())
let values = args.contains("--values")
args.removeAll { $0 == "--values" }

let all = args.first == "--all"
if all { args.removeFirst() }

let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
if args.isEmpty && !all {
    // windows on screen, per app: the window server says owner and bounds with no permission
    var windows: [pid_t: Int] = [:]
    for w in (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? [] {
        guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
        windows[pid_t(pid), default: 0] += 1
    }
    for a in apps {
        let electron = a.bundleURL.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path) } ?? false
        say("\(a.processIdentifier)\t\(a.bundleIdentifier ?? "-")\t\(a.localizedName ?? "-")\twindows \(windows[a.processIdentifier] ?? 0)\(electron ? "\telectron" : "")\(a.isHidden ? "\thidden" : "")\(a.isActive ? "\tactive" : "")\(a.isFinishedLaunching ? "" : "\tlaunching")")
    }
    exit(0)
}

if all {
    guard trusted else {
        say("no permission: --all needs Accessibility for this process")
        exit(2)
    }
    let budget = args.first.flatMap { Int($0) } ?? 4000
    // as the mirror walks: breadth first, one batched read an element, menus, web areas and long lists cut to stubs
    let batch = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                 kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXChildrenAttribute] as [CFString]
    var total = 0
    for a in apps where a.processIdentifier != getpid() && a.processIdentifier > 0 {
        let root = AXUIElementCreateApplication(a.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.25)
        var queue: [(AXUIElement, Int)] = [(root, 0)], n = 0, deepest = 0, stubs = 0, timeouts = 0
        let t0 = DispatchTime.now().uptimeNanoseconds
        while !queue.isEmpty && n < budget && timeouts < 3 {
            let (e, d) = queue.removeFirst()
            var out: CFArray?
            let err = AXUIElementCopyMultipleAttributeValues(e, batch as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
            if err == .cannotComplete { timeouts += 1; continue }
            guard err == .success, let vals = out as? [AnyObject] else { continue }
            n += 1
            deepest = max(deepest, d)
            let role = vals[0] as? String ?? ""
            let kids = vals[9] as? [AXUIElement] ?? []
            if role == "AXMenuBar" && d > 0 || role == "AXMenu" || role == "AXWebArea" || kids.count > 200 { stubs += 1; continue }
            for k in kids { queue.append((k, d + 1)) }
        }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
        total += n
        say("\(a.processIdentifier)\t\(a.localizedName ?? "-")\telements \(n)\(n >= budget ? " (budget)" : "")\tdepth \(deepest)\tstubs \(stubs)\ttimeouts \(timeouts)\t\(String(format: "%.1f", ms)) ms")
    }
    say("— \(total) elements in all")
    exit(0)
}

let want = args[0]
let depth = args.count > 1 ? Int(args[1]) ?? 4 : 4
guard let app = apps.first(where: { String($0.processIdentifier) == want || $0.localizedName == want || $0.bundleIdentifier == want }) else {
    say("no app \(want)")
    exit(1)
}
guard trusted else {
    say("no permission: the tree of \(app.localizedName ?? want) needs Accessibility for this process (System Settings > Privacy & Security > Accessibility)")
    exit(2)
}

let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root, 0.5)

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func text(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }
func frame(_ e: AXUIElement) -> String {
    var p = CGPoint.zero, s = CGSize.zero
    if let pv = attr(e, kAXPositionAttribute), CFGetTypeID(pv) == AXValueGetTypeID() { AXValueGetValue(pv as! AXValue, .cgPoint, &p) }
    if let sv = attr(e, kAXSizeAttribute), CFGetTypeID(sv) == AXValueGetTypeID() { AXValueGetValue(sv as! AXValue, .cgSize, &s) }
    return "\(Int(p.x)),\(Int(p.y)) \(Int(s.width))x\(Int(s.height))"
}
func actions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(e, &names) == .success ? (names as? [String] ?? []) : []
}

var count = 0, errors = 0
func walk(_ e: AXUIElement, _ level: Int) {
    count += 1
    let role = text(e, kAXRoleAttribute) ?? "?"
    let sub = text(e, kAXSubroleAttribute).map { "/\($0)" } ?? ""
    let label = text(e, kAXTitleAttribute) ?? text(e, kAXDescriptionAttribute) ?? ""
    var line = String(repeating: "  ", count: level) + role + sub
    if !label.isEmpty { line += " \"\(label.prefix(60))\"" }
    line += " [\(frame(e))]"
    if values, let v = attr(e, kAXValueAttribute) { line += " = \(String(describing: v).prefix(60))" }
    let a = actions(e).filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
    if !a.isEmpty { line += " {\(a.joined(separator: " "))}" }
    say(line)
    guard level < depth else { return }
    var kids: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids)
    if err != .success && err != .noValue { errors += 1 }
    for k in (kids as? [AXUIElement]) ?? [] { walk(k, level + 1) }
}

let t0 = DispatchTime.now().uptimeNanoseconds
walk(root, 0)
let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
say("— \(count) elements, \(errors) errors, \(String(format: "%.1f", ms)) ms, depth \(depth)")
