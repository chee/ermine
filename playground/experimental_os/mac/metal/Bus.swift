// Bus.swift: the way between the metal and the OS, records down and commands
// up, in METAL.md's JSON either way.
//
// In process, the default: the OS is ../../newos, linked in, on a thread of
// its own (os.h). Records go to it with ermosPost; commands come back through a
// C function, on its thread.
//
// With --os, the OS is a child process: records go down its stdin, one JSON
// object a line; commands come up its stdout and are read line by line on a
// thread of their own.
//
// Either way records go through one serial queue whichever thread makes
// them, and the OS's stderr is appended to ~/.ermine/os.log.

import Foundation

final class Bus: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ermine.records")
    /// the OS is linked in, not a child
    let inProcess: Bool
    /// in process: where the OS's commands go, on its thread
    private var handle: (([String: Any]) -> Void)?
    private var recordFD: Int32 = -1
    private var commandFD: Int32 = -1
    private var broken = false
    private(set) var pid: pid_t = 0
    private(set) var recordsSent = 0

    init(inProcess: Bool) { self.inProcess = inProcess }

    /// Boots the OS linked in (os.h), on a thread of its own; its commands go
    /// to `handle`, on that thread. The config is copied; its command and
    /// data are filled in here.
    func start(_ config: inout ErmosConfig, commands handle: @escaping ([String: Any]) -> Void) {
        self.handle = handle
        // as a child's would: the terminal is the serial line's
        let errFD = open(ermineDir + "/os.log", O_WRONLY | O_APPEND | O_CREAT, 0o644)
        if errFD >= 0 {
            dup2(errFD, 2)
            close(errFD)
        }
        config.command = { data, text in
            guard let data, let text else { return }
            let bus = Unmanaged<Bus>.fromOpaque(data).takeUnretainedValue()
            guard let cmd = Bus.parse(Data(bytes: text, count: strlen(text))) else { return }
            bus.handle?(cmd)
        }
        config.data = Unmanaged.passRetained(self).toOpaque()  // the OS holds the bus while it runs
        ermosStart(&config)
        log("started the OS in process")
    }

    /// Powers the OS off, in process: after the records queued so far,
    /// ermosStop, which returns once it has written its card and ended; then
    /// `done`, on the records queue.
    func stop(_ done: @escaping @Sendable () -> Void) {
        queue.async {
            ermosStop()
            done()
        }
    }

    /// Starts `/bin/sh -c "<command> \"$@\"" ermine args...` with ERMINE_FB set.
    func spawn(command: String, args: [String], fbPath: String) throws {
        var rec: [Int32] = [-1, -1]
        var cmd: [Int32] = [-1, -1]
        guard pipe(&rec) == 0, pipe(&cmd) == 0 else {
            throw MetalError("pipe: \(String(cString: strerror(errno)))")
        }
        let errFD = open(ermineDir + "/os.log", O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
        guard errFD >= 0 else { throw MetalError("cannot open os.log: \(String(cString: strerror(errno)))") }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, rec[0], 0)
        posix_spawn_file_actions_adddup2(&actions, cmd[1], 1)
        posix_spawn_file_actions_adddup2(&actions, errFD, 2)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Only 0, 1 and 2 cross over; the OS gets its own process group so the
        // metal can stop all of it; signals the metal ignores are reset.
        let flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        posix_spawnattr_setflags(&attr, Int16(flags))
        posix_spawnattr_setpgroup(&attr, 0)
        var defaults = sigset_t()
        sigemptyset(&defaults)
        for s in [SIGPIPE, SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGCHLD, SIGTSTP, SIGTTIN, SIGTTOU] { sigaddset(&defaults, s) }
        posix_spawnattr_setsigdefault(&attr, &defaults)
        var mask = sigset_t()
        sigemptyset(&mask)
        posix_spawnattr_setsigmask(&attr, &mask)

        let argv = ["/bin/sh", "-c", command + " \"$@\"", "ermine"] + args
        var env = ProcessInfo.processInfo.environment
        env["ERMINE_FB"] = fbPath
        let envp = env.map { "\($0.key)=\($0.value)" }

        let cArgv = argv.map { strdup($0) } + [nil]
        let cEnv = envp.map { strdup($0) } + [nil]
        defer {
            cArgv.forEach { free($0) }
            cEnv.forEach { free($0) }
        }
        var child: pid_t = 0
        let rc = posix_spawn(&child, "/bin/sh", &actions, &attr, cArgv, cEnv)
        close(rec[0])
        close(cmd[1])
        close(errFD)
        guard rc == 0 else {
            close(rec[1])
            close(cmd[0])
            throw MetalError("cannot start the OS: \(String(cString: strerror(rc)))")
        }
        _ = fcntl(rec[1], F_SETFD, FD_CLOEXEC)
        _ = fcntl(cmd[0], F_SETFD, FD_CLOEXEC)
        // A write to a gone child gives EPIPE rather than a signal.
        _ = fcntl(rec[1], F_SETNOSIGPIPE, 1)
        pid = child
        recordFD = rec[1]
        commandFD = cmd[0]
        log("started the OS, pid \(child): \(argv.dropFirst(2).joined(separator: " "))")
    }

    /// Writes a record. Safe from any thread; `at` is now unless given.
    func send(_ irq: Int, _ fields: Fields, at: Int? = nil) {
        var line = json([("irq", irq), ("at", at ?? now())] + fields)
        if inProcess {
            queue.async { [self] in
                ermosPost(line)
                recordsSent += 1
            }
            return
        }
        line += "\n"
        queue.async { [self] in
            guard !broken, recordFD >= 0 else { return }
            var ok = true
            line.utf8CString.withUnsafeBufferPointer { p in
                var off = 0
                let total = p.count - 1
                while off < total {
                    let n = write(recordFD, p.baseAddress! + off, total - off)
                    if n < 0 {
                        if errno == EINTR { continue }
                        ok = false
                        break
                    }
                    off += n
                }
            }
            if ok {
                recordsSent += 1
            } else {
                broken = true
                log("the OS's stdin is closed (\(String(cString: strerror(errno)))); no more records")
            }
        }
    }

    /// Waits until the records queued so far are written.
    func drain() {
        queue.sync {}
    }

    /// Reads commands on a thread of its own, one JSON object a line. Each
    /// command is handed over on that thread; `closed` runs at end of file.
    func readCommands(_ handle: @escaping ([String: Any]) -> Void, closed: @escaping () -> Void) {
        let fd = commandFD
        let thread = Thread {
            var pending = [UInt8]()
            var chunk = [UInt8](repeating: 0, count: 1 << 16)
            while true {
                let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { break }
                pending.append(contentsOf: chunk[0..<n])
                var start = 0
                while let nl = pending[start...].firstIndex(of: 0x0A) {
                    let line = pending[start..<nl]
                    start = nl + 1
                    if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { continue }
                    if let cmd = Bus.parse(Data(line)) { handle(cmd) }
                }
                if start > 0 { pending.removeFirst(start) }
            }
            closed()
        }
        thread.name = "ermine.commands"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    /// A command's JSON text as an object; a malformed one is logged, and nil.
    static func parse(_ data: Data) -> [String: Any]? {
        guard let obj = try? JSONSerialization.jsonObject(with: data), let cmd = obj as? [String: Any] else {
            log("malformed command, ignored: \(String(decoding: data.prefix(200), as: UTF8.self))")
            return nil
        }
        return cmd
    }

    /// Calls `exited` on the main queue with the wait status once the OS exits.
    func watchExit(_ exited: @escaping (Int32) -> Void) {
        let child = pid
        let thread = Thread {
            var status: Int32 = 0
            while waitpid(child, &status, 0) < 0 && errno == EINTR {}
            DispatchQueue.main.async { exited(status) }
        }
        thread.name = "ermine.wait"
        thread.start()
    }

    /// Stops the OS: its whole process group.
    func kill(_ signal: Int32) {
        guard pid > 0 else { return }
        if Darwin.kill(-pid, signal) != 0 { _ = Darwin.kill(pid, signal) }
    }
}
