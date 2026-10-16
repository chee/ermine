// axprobe.swift: a read-only look at what the mac device (irq 51) mirrors,
// by the metal's own code (../mac/metal/Ax.swift), so what it prints is what
// the metal sends. Never asks for a permission, never acts, never posts an
// event, never opens a window. Without Accessibility it says "no
// permission" and lists the apps only.
//
//   axprobe                  access, then each app: pid bundle "name" policy [electron] [self]
//   axprobe PID [DEPTH]      that app's tree, one element a line: its address, id and value;
//                            then its counts, cuts and the ms it took
//   axprobe records PID      the irq 51 records the metal sends for that app (its app record,
//                            then its trees), each a line "!post {...}" for c/test/headless.c,
//                            under 4000 characters; values cut at 1000 UTF-16 units so an
//                            item fits, as /etc/mac {text: 1000} would
//
// Build, from this folder:
//
//   swiftc -parse-as-library -O -o ../mac/build/axprobe axprobe.swift ../mac/metal/Ax.swift

import AppKit
import ApplicationServices

@main
struct Probe {
    static func main() {
        let ax = AXIsProcessTrusted()  // never the prompting form
        let capture = CGPreflightScreenCaptureAccess()
        var args = Array(CommandLine.arguments.dropFirst())
        let records = args.first == "records"
        if records { args.removeFirst() }
        // records keep stdout to records: the rest goes to stderr
        say("access ax \(ax) capture \(capture)", records)
        guard let first = args.first, let pid = pid_t(first) else {
            if !ax { say("no permission: Accessibility is not granted to this process (or the terminal it runs under)", records) }
            for a in NSWorkspace.shared.runningApplications where Ax.listed(a) {
                let policy = a.activationPolicy == .regular ? "regular" : "accessory"
                print("\(a.processIdentifier) \(a.bundleIdentifier ?? "-") \"\(a.localizedName ?? "")\" \(policy)"
                    + (Ax.electron(a) ? " electron" : "") + (a.processIdentifier == getpid() ? " self" : ""))
            }
            exit(0)
        }
        guard ax else {
            say("no permission: Accessibility is not granted to this process (or the terminal it runs under)", true)
            exit(1)
        }
        guard let app = NSRunningApplication(processIdentifier: pid), Ax.listed(app) else {
            say("no app with pid \(pid)", true)
            exit(1)
        }
        guard pid != getpid() else {
            say("\(pid) is this process: never walked", true)
            exit(1)
        }
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)

        // as the metal: one frame buffer pixel a device pixel
        var bounds = Ax.Bounds()
        bounds.scale = 1 / max(1, Double(NSScreen.screens.first?.backingScaleFactor ?? 1))
        if records { bounds.text = 1000 }
        if !records, args.count > 1, let d = Int(args[1]), d > 0 { bounds.depth = d }

        var next = 1
        var items: [Ax.Pairs] = []
        let tree = Ax.Tree(pid: pid, n: next, bounds: bounds, number: { next += 1; return next }, take: { true }, give: { _ in },
                           sink: { items.append($0) })
        tree.walk(tree.root.n)
        let t0 = Date()
        while tree.busy { _ = tree.step(1 << 30) }
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        if let f = tree.fault {
            say("AX stopped answering (\(Ax.failure(f) ?? "?")): the tree is what came before", true)
        }

        if records {
            let start = Date()
            func at() -> Int { Int(Date().timeIntervalSince(start) * 1_000_000) }
            print("!post " + text([("irq", 51), ("at", at())] + Ax.record(app, n: tree.root.n, state: "running")))
            // as many items a record as fit: at most 500, the line under 4000 characters
            let room = 3990 - 80
            var chunk: [String] = []
            var size = 0
            func flush() {
                guard !chunk.isEmpty else { return }
                let head = text([("irq", 51), ("at", at()), ("event", "tree"), ("pid", Int(pid))] as Ax.Pairs)
                print("!post " + head.dropLast() + ",\"items\":[" + chunk.joined(separator: ",") + "]}")
                chunk = []
                size = 0
            }
            for item in items {
                let t = text(item)
                if size + t.utf8.count + 1 > room || chunk.count == 500 { flush() }
                if t.utf8.count + 1 > room {
                    say("an item too long for a line, left out: \(t.prefix(80))...", true)
                    continue
                }
                chunk.append(t)
                size += t.utf8.count + 1
            }
            flush()
            exit(0)
        }

        // the tree, one element a line, each after its parent
        func show(_ n: Int) {
            guard let x = tree.nodes[n] else { return }
            if x !== tree.root {
                var v = x.attrs
                if !x.kids.isEmpty { v["order"] = .list(x.kids.compactMap { tree.nodes[$0].map { .text($0.name) } }) }
                if let cut = x.cut {
                    v["cut"] = .text(cut)
                    v["more"] = .int(x.more)
                }
                print("/dev/mac/apps/\(pid)/" + tree.path(n).joined(separator: "/") + " mac/\(n) " + text(Ax.Tree.pairs(v)))
            }
            for k in x.kids { show(k) }
        }
        show(tree.root.n)
        var why: [String: (Int, Int)] = [:]
        for x in tree.nodes.values {
            if let c = x.cut {
                why[c, default: (0, 0)].0 += 1
                why[c, default: (0, 0)].1 += x.more
            }
        }
        let cuts = why.keys.sorted().map { "\($0) \(why[$0]!.0) (\(why[$0]!.1) more)" }.joined(separator: ", ")
        print("elements \(tree.count), items \(items.count), cuts \(tree.cuts)\(cuts.isEmpty ? "" : ": " + cuts), in \(ms) ms")
    }

    static func say(_ line: String, _ err: Bool) {
        if err {
            FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
        } else {
            print(line)
            fflush(stdout)
        }
    }

    // MARK: - JSON, as Log.swift writes it

    static func text(_ value: Any?) -> String {
        var out = ""
        encode(value, into: &out)
        return out
    }

    static func encode(_ value: Any?, into out: inout String) {
        switch value {
        case nil, is NSNull:
            out += "null"
        case let b as Bool:
            out += b ? "true" : "false"
        case let i as Int:
            out += String(i)
        case let d as Double:
            if !d.isFinite {
                out += "null"
            } else if d == d.rounded(), abs(d) < 1e15 {
                out += String(Int64(d))
            } else {
                out += String(d)
            }
        case let s as String:
            string(s, into: &out)
        case let fields as Ax.Pairs where !fields.isEmpty:
            out += "{"
            for (i, (k, v)) in fields.enumerated() {
                if i > 0 { out += "," }
                string(k, into: &out)
                out += ":"
                encode(v, into: &out)
            }
            out += "}"
        case let list as [Any?]:
            out += "["
            for (i, v) in list.enumerated() {
                if i > 0 { out += "," }
                encode(v, into: &out)
            }
            out += "]"
        default:
            string(String(describing: value!), into: &out)
        }
    }

    static func string(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where u.value < 0x20 || u.value == 0x7f || u.value == 0x2028 || u.value == 0x2029:
                out += String(format: "\\u%04x", u.value)
            default:
                out.unicodeScalars.append(u)
            }
        }
        out += "\""
    }
}
