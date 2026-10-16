// Serial.swift: uart0, the terminal the metal was started from.
//
// When the metal's stdin is a terminal, that terminal is the far end of a
// serial cable: raw mode, each byte typed goes up as a `uart` record, each
// `tx` command's bytes go to stdout. Ctrl-\ powers off. Raw mode is undone
// on every way out: exit, the signals that end the program, and crashes.

import Foundation

// The saved terminal settings are reached through globals, so the C signal
// handlers and the atexit hook can get them without captures. The termios
// itself lives on the heap: Swift 6.4 lays a global `termios` (72 bytes) out
// over the next global's storage, which corrupted the saved c_ospeed.
let savedTermios: UnsafeMutablePointer<termios> = {
    let p = UnsafeMutablePointer<termios>.allocate(capacity: 1)
    p.initialize(to: termios())
    return p
}()
nonisolated(unsafe) var termiosRaw: Int32 = 0

/// Puts the terminal back as it was. Async-signal-safe.
func restoreTerminal() {
    if termiosRaw != 0 {
        _ = tcsetattr(0, TCSANOW, savedTermios)
        termiosRaw = 0
    }
}

enum Serial {
    /// A terminal on stdin, with the metal in its foreground (a metal started
    /// in the background would be stopped by touching it).
    static let present: Bool = isatty(0) == 1 && tcgetpgrp(0) == getpgrp()
    private static let txQueue = DispatchQueue(label: "ermine.tx")

    /// Raw mode on stdin's terminal.
    static func makeRaw() {
        guard present, tcgetattr(0, savedTermios) == 0 else { return }
        var raw = savedTermios.pointee
        cfmakeraw(&raw)
        if tcsetattr(0, TCSAFLUSH, &raw) == 0 {
            termiosRaw = 1
            log("uart0: \(ttyname(0).map { String(cString: $0) } ?? "a terminal") in raw mode")
        } else {
            log("uart0: cannot set raw mode: \(String(cString: strerror(errno)))")
        }
    }

    /// Reads the bytes typed. `bytes` gets each run of them, `quit` is called
    /// for Ctrl-\ (which is not passed on).
    static func read(bytes: @escaping (Data) -> Void, quit: @escaping () -> Void) {
        guard present else { return }
        let thread = Thread {
            var buf = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = buf.withUnsafeMutableBytes { Darwin.read(0, $0.baseAddress, $0.count) }
                if n < 0 && errno == EINTR { continue }
                if n <= 0 {
                    log("uart0: end of input")
                    break
                }
                var run = [UInt8]()
                for b in buf[0..<n] {
                    if b == 0x1C {  // Ctrl-\
                        if !run.isEmpty { bytes(Data(run)) }
                        run.removeAll()
                        quit()
                    } else {
                        run.append(b)
                    }
                }
                if !run.isEmpty { bytes(Data(run)) }
            }
        }
        thread.name = "ermine.uart0"
        thread.start()
    }

    /// Writes bytes to the far end of the cable.
    static func transmit(_ data: Data) {
        txQueue.async {
            data.withUnsafeBytes { p in
                var off = 0
                while off < p.count {
                    let n = write(1, p.baseAddress! + off, p.count - off)
                    if n < 0 {
                        if errno == EINTR { continue }
                        log("uart0: write failed: \(String(cString: strerror(errno)))")
                        return
                    }
                    off += n
                }
            }
        }
    }
}

/// Undoes raw mode and removes the frame buffer file on every exit, and on
/// the signals that would otherwise end the metal without running atexit.
func installExitHooks() {
    _ = savedTermios  // made now, not first in a signal handler
    atexit {
        restoreTerminal()
        if let path = fbPathForExit { unlink(path) }
        if let path = planesPathForExit { unlink(path) }
    }
    let fatal: [Int32] = [SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP, SIGQUIT, SIGXCPU]
    for s in fatal {
        var action = sigaction()
        action.__sigaction_u.__sa_handler = { sig in
            restoreTerminal()
            if let path = fbPathForExitC { unlink(path) }
            if let path = planesPathForExitC { unlink(path) }
            signal(sig, SIG_DFL)
            raise(sig)
        }
        sigemptyset(&action.sa_mask)
        action.sa_flags = 0
        sigaction(s, &action, nil)
    }
    signal(SIGPIPE, SIG_IGN)
}

nonisolated(unsafe) var fbPathForExit: String?
nonisolated(unsafe) var fbPathForExitC: UnsafeMutablePointer<CChar>?
nonisolated(unsafe) var planesPathForExit: String?
nonisolated(unsafe) var planesPathForExitC: UnsafeMutablePointer<CChar>?
