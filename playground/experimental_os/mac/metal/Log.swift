// Log.swift: the metal's own log, its clock, and the JSON it speaks.
//
// The terminal belongs to the serial line, so the metal never prints: it
// appends to ~/.ermine/metal.log.

import Foundation

/// ~/.ermine, made if missing.
let ermineDir: String = {
    let dir = NSHomeDirectory() + "/.ermine"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}()

private let logQueue = DispatchQueue(label: "ermine.log")
private let logFD: Int32 = open(ermineDir + "/metal.log", O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
private let logStamp: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    return f
}()

/// Appends a line to metal.log. Safe from any thread.
func log(_ message: String) {
    let line = "\(logStamp.string(from: Date())) [\(getpid())] \(message)\n"
    logQueue.async {
        guard logFD >= 0 else { return }
        line.utf8CString.withUnsafeBufferPointer { p in
            _ = write(logFD, p.baseAddress, p.count - 1)
        }
    }
}

/// Waits for queued log lines to reach the file; for exit paths.
func flushLog() {
    logQueue.sync {}
}

// MARK: - the clock

/// When the metal started; main touches it first thing.
let clockStart = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)

/// Microseconds since the metal started, monotonic (it keeps counting through sleep).
func now() -> Int {
    let start = clockStart  // first, so a lazy start is never after the reading
    let t = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
    return t > start ? Int((t - start) / 1000) : 0
}

// MARK: - JSON

/// An ordered JSON object: records keep `irq` and `at` first, which keeps the
/// logs readable. Values are String, Bool, Int, Double, nil (null), [Any?],
/// Fields or [String: Any?].
typealias Fields = [(String, Any?)]

func json(_ value: Any?) -> String {
    var out = ""
    out.reserveCapacity(64)
    encode(value, into: &out)
    return out
}

private func encode(_ value: Any?, into out: inout String) {
    switch value {
    case nil, is NSNull:
        out += "null"
    // a number from Foundation (JSONSerialization, WebKit's messages) that is not a boolean: as a
    // number, never as Bool, which an NSNumber of 0 or 1 would otherwise be taken for
    case let n as NSNumber where CFGetTypeID(n) != CFBooleanGetTypeID():
        encodeNumber(n.doubleValue, into: &out)
    case let b as Bool:
        out += b ? "true" : "false"
    case let i as Int:
        out += String(i)
    case let i as Int32:
        out += String(i)
    case let i as UInt32:
        out += String(i)
    case let i as UInt64:
        out += String(i)
    case let i as Int64:
        out += String(i)
    case let d as Double:
        encodeNumber(d, into: &out)
    case let f as Float:
        encodeNumber(Double(f), into: &out)
    case let f as CGFloat:
        encodeNumber(Double(f), into: &out)
    case let s as String:
        encodeString(s, into: &out)
    case let fields as Fields where !fields.isEmpty:  // an empty array casts to any array type
        out += "{"
        var first = true
        for (k, v) in fields {
            if !first { out += "," }
            first = false
            encodeString(k, into: &out)
            out += ":"
            encode(v, into: &out)
        }
        out += "}"
    case let dict as [String: Any?]:
        encode(dict.sorted { $0.key < $1.key }.map { ($0.key, $0.value) } as Fields, into: &out)
    case let dict as [String: Any]:
        encode(dict.sorted { $0.key < $1.key }.map { ($0.key, Optional($0.value)) } as Fields, into: &out)
    case let list as [Any?]:
        out += "["
        for (i, v) in list.enumerated() {
            if i > 0 { out += "," }
            encode(v, into: &out)
        }
        out += "]"
    case let list as [Any]:
        encode(list.map { Optional($0) }, into: &out)
    case let n as NSNumber:
        encodeNumber(n.doubleValue, into: &out)
    default:
        encodeString(String(describing: value!), into: &out)
    }
}

private func encodeNumber(_ d: Double, into out: inout String) {
    guard d.isFinite else { out += "null"; return }
    if d == d.rounded(), abs(d) < 1e15 {
        out += String(Int64(d))
    } else {
        out += String(d)
    }
}

private func encodeString(_ s: String, into out: inout String) {
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
