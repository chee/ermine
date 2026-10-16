// Devices.swift: the Mac's own devices, each from the real Mac API, as records.
//
// Each device has a `now` that gives its state as a record's fields (for
// the records at start) and a `watch` that writes a record whenever it
// changes. Records go through the bus, which takes them from any thread.

import AppKit
import IOKit
import IOKit.ps
import Network

// MARK: - power (irq 40)

final class Power {
    private let bus: Bus
    private var last = ""
    private var source: CFRunLoopSource?

    init(bus: Bus) { self.bus = bus }

    static func now() -> Fields {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else {
            return [("ac", true), ("battery", false), ("percent", nil), ("charging", false), ("minutes", nil)]
        }
        let providing = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
        let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] ?? []
        var battery: [String: Any]?
        for ps in list {
            guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any] else { continue }
            if d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType { battery = d }
        }
        var ac = providing == kIOPMACPowerKey || providing == kIOPMUPSPowerKey
        guard let b = battery else {
            return [("ac", true), ("battery", false), ("percent", nil), ("charging", false), ("minutes", nil)]
        }
        if providing == nil, let state = b[kIOPSPowerSourceStateKey] as? String { ac = state == kIOPSACPowerValue }
        var percent: Double?
        if let cur = b[kIOPSCurrentCapacityKey] as? Int, let max = b[kIOPSMaxCapacityKey] as? Int, max > 0 {
            percent = (Double(cur) * 100 / Double(max)).rounded()
        }
        let charging = b[kIOPSIsChargingKey] as? Bool ?? false
        var minutes: Int?
        if charging {
            minutes = b[kIOPSTimeToFullChargeKey] as? Int
        } else if !ac {
            minutes = b[kIOPSTimeToEmptyKey] as? Int
        }
        if let m = minutes, m < 0 { minutes = nil }
        return [("ac", ac), ("battery", true), ("percent", percent), ("charging", charging), ("minutes", minutes)]
    }

    func send(_ fields: Fields) {
        let key = json(fields)
        guard key != last else { return }
        last = key
        bus.send(40, fields)
    }

    func watch() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let src = IOPSNotificationCreateRunLoopSource({ ctx in
            guard let ctx else { return }
            let me = Unmanaged<Power>.fromOpaque(ctx).takeUnretainedValue()
            me.send(Power.now())
        }, context)?.takeRetainedValue() else {
            log("power: no notifications")
            return
        }
        source = src
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    }
}

// MARK: - thermal (irq 41)

final class Thermal {
    private let bus: Bus
    private var last = ""
    private var observers: [NSObjectProtocol] = []

    init(bus: Bus) { self.bus = bus }

    static func now() -> Fields {
        let state: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: state = "nominal"
        case .fair: state = "fair"
        case .serious: state = "serious"
        case .critical: state = "critical"
        @unknown default: state = "nominal"
        }
        return [("state", state), ("lowPower", ProcessInfo.processInfo.isLowPowerModeEnabled)]
    }

    func send(_ fields: Fields) {
        let key = json(fields)
        guard key != last else { return }
        last = key
        bus.send(41, fields)
    }

    func watch() {
        let nc = NotificationCenter.default
        for name in [ProcessInfo.thermalStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.send(Thermal.now())
            })
        }
    }
}

// MARK: - sleep (irq 42)

final class Sleep {
    private let bus: Bus
    private var observers: [NSObjectProtocol] = []

    init(bus: Bus) { self.bus = bus }

    @MainActor
    func watch() {
        let ws = NSWorkspace.shared.notificationCenter
        let events: [(Notification.Name, String)] = [
            (NSWorkspace.willSleepNotification, "sleep"),
            (NSWorkspace.didWakeNotification, "wake"),
            (NSWorkspace.screensDidSleepNotification, "screensleep"),
            (NSWorkspace.screensDidWakeNotification, "screenwake"),
        ]
        for (name, event) in events {
            observers.append(ws.addObserver(forName: name, object: nil, queue: nil) { [bus] _ in
                bus.send(42, [("event", event)])
            })
        }
        let dnc = DistributedNotificationCenter.default()
        for (name, event) in [("com.apple.screenIsLocked", "lock"), ("com.apple.screenIsUnlocked", "unlock")] {
            observers.append(dnc.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { [bus] _ in
                bus.send(42, [("event", event)])
            })
        }
    }
}

// MARK: - cpu (irq 43)

final class CPU {
    private let bus: Bus
    private let queue = DispatchQueue(label: "ermine.cpu", qos: .utility)
    private let host = mach_host_self()
    private var previous: [(busy: UInt64, total: UInt64)] = []
    private var timer: DispatchSourceTimer?
    private var pressureSource: DispatchSourceMemoryPressure?
    private var pressure = "normal"
    private let total = UInt64(sysctlInt("hw.memsize") ?? Int(ProcessInfo.processInfo.physicalMemory))

    init(bus: Bus) {
        self.bus = bus
        switch sysctlInt("kern.memorystatus_vm_pressure_level") {
        case 2: pressure = "warn"
        case 4: pressure = "critical"
        default: pressure = "normal"
        }
    }

    /// Each core's busy and total ticks since boot.
    private func ticks() -> [(busy: UInt64, total: UInt64)] {
        var count: natural_t = 0
        var info: processor_info_array_t?
        var infoCount: mach_msg_type_number_t = 0
        guard host_processor_info(host, PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS, let info else {
            return []
        }
        defer {
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: info)),
                          vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride))
        }
        var out: [(busy: UInt64, total: UInt64)] = []
        for i in 0..<Int(count) {
            let base = Int(CPU_STATE_MAX) * i
            let user = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_USER)]))
            let system = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_SYSTEM)]))
            let nice = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_NICE)]))
            let idle = UInt64(UInt32(bitPattern: info[base + Int(CPU_STATE_IDLE)]))
            out.append((user + system + nice, user + system + nice + idle))
        }
        return out
    }

    private func freeBytes() -> Int? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let rc = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(host, HOST_VM_INFO64, $0, &count)
            }
        }
        guard rc == KERN_SUCCESS else { return nil }
        return (Int(stats.free_count) + Int(stats.inactive_count)) * Int(vm_kernel_page_size)
    }

    private func tick() {
        let now = ticks()
        var load: [Any?] = []
        for (i, t) in now.enumerated() {
            guard i < previous.count else { load.append(0.0); continue }
            let busy = t.busy &- previous[i].busy
            let total = t.total &- previous[i].total
            let share = total > 0 ? Double(busy) / Double(total) : 0
            load.append((share * 1000).rounded() / 1000)
        }
        previous = now
        let memory: Fields = [("total", Int(total)), ("free", freeBytes()), ("pressure", pressure)]
        bus.send(43, [("load", load), ("memory", memory)])
    }

    func watch() {
        queue.async { [self] in previous = ticks() }
        let p = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: queue)
        p.setEventHandler { [weak self, weak p] in
            guard let self, let p else { return }
            let e = p.data
            if e.contains(.critical) { self.pressure = "critical" }
            else if e.contains(.warning) { self.pressure = "warn" }
            else if e.contains(.normal) { self.pressure = "normal" }
        }
        p.resume()
        pressureSource = p
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(20))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }
}

// MARK: - usb (irq 44)

final class USB {
    private let bus: Bus
    private var port: IONotificationPortRef?
    private var added: io_iterator_t = 0
    private var removed: io_iterator_t = 0
    private var live = false
    private(set) var present: [Fields] = []

    init(bus: Bus) { self.bus = bus }

    private static func property(_ service: io_service_t, _ key: String) -> Any? {
        IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    }

    private static func entryID(_ service: io_service_t) -> String {
        var id: UInt64 = 0
        IORegistryEntryGetRegistryEntryID(service, &id)
        return String(id)
    }

    private func attached(_ iter: io_iterator_t) {
        var service = IOIteratorNext(iter)
        while service != 0 {
            let fields: Fields = [
                ("event", "attach"),
                ("id", USB.entryID(service)),
                ("vendor", USB.property(service, "idVendor") as? Int),
                ("product", USB.property(service, "idProduct") as? Int),
                ("name", USB.property(service, "USB Product Name") as? String ?? USB.property(service, "kUSBProductString") as? String),
                ("maker", USB.property(service, "USB Vendor Name") as? String ?? USB.property(service, "kUSBVendorString") as? String),
                ("serial", USB.property(service, "USB Serial Number") as? String ?? USB.property(service, "kUSBSerialNumberString") as? String),
                ("class", USB.property(service, "bDeviceClass") as? Int),
                ("location", USB.property(service, "locationID") as? Int),
                ("boot", !live),
            ]
            if live { bus.send(44, fields) } else { present.append(fields) }
            IOObjectRelease(service)
            service = IOIteratorNext(iter)
        }
    }

    private func detached(_ iter: io_iterator_t) {
        var service = IOIteratorNext(iter)
        while service != 0 {
            if live { bus.send(44, [("event", "detach"), ("id", USB.entryID(service))]) }
            IOObjectRelease(service)
            service = IOIteratorNext(iter)
        }
    }

    /// Arms the notifications; the devices there now are kept in `present`
    /// for the records at start.
    func arm() {
        guard let port = IONotificationPortCreate(kIOMainPortDefault) else {
            log("usb: no notification port")
            return
        }
        self.port = port
        CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .commonModes)
        let context = Unmanaged.passUnretained(self).toOpaque()
        var rc = IOServiceAddMatchingNotification(port, kIOFirstMatchNotification, IOServiceMatching("IOUSBHostDevice"), { ctx, iter in
            guard let ctx else { return }
            Unmanaged<USB>.fromOpaque(ctx).takeUnretainedValue().attached(iter)
        }, context, &added)
        if rc == KERN_SUCCESS { attached(added) } else { log("usb: cannot watch attaches: \(rc)") }
        rc = IOServiceAddMatchingNotification(port, kIOTerminatedNotification, IOServiceMatching("IOUSBHostDevice"), { ctx, iter in
            guard let ctx else { return }
            Unmanaged<USB>.fromOpaque(ctx).takeUnretainedValue().detached(iter)
        }, context, &removed)
        if rc == KERN_SUCCESS { detached(removed) } else { log("usb: cannot watch detaches: \(rc)") }
    }

    /// From now on, changes are written as records.
    func goLive() { live = true }
}

// MARK: - net (irq 45)

final class Net {
    private let bus: Bus
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ermine.net")
    private let first = DispatchSemaphore(value: 0)
    private var current: Fields?
    private var last = ""
    private var live = false

    init(bus: Bus) { self.bus = bus }

    private static func fields(_ path: NWPath) -> Fields {
        let status: String
        switch path.status {
        case .satisfied: status = "satisfied"
        case .unsatisfied: status = "unsatisfied"
        case .requiresConnection: status = "requiresConnection"
        @unknown default: status = "unsatisfied"
        }
        var seen = Set<String>()
        let unique = path.availableInterfaces.filter { seen.insert($0.name).inserted }
        let interfaces: [Any?] = unique.map { i -> Any? in
            let type: String
            switch i.type {
            case .wifi: type = "wifi"
            case .wiredEthernet: type = "wired"
            case .cellular: type = "cellular"
            case .loopback: type = "loopback"
            default: type = "other"
            }
            return [("name", i.name), ("type", type)] as Fields
        }
        return [("status", status), ("interfaces", interfaces), ("expensive", path.isExpensive), ("constrained", path.isConstrained)]
    }

    /// Starts the monitor; its first path arrives on its own queue shortly.
    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let f = Net.fields(path)
            let key = json(f)
            if self.current == nil { self.first.signal() }
            self.current = f
            guard self.live, key != self.last else { return }
            self.last = key
            self.bus.send(45, f)
        }
        monitor.start(queue: queue)
    }

    /// The state now, waiting up to `timeout` seconds for the first path.
    func now(timeout: Double) -> Fields {
        _ = first.wait(timeout: .now() + timeout)
        return queue.sync {
            live = true
            let f = current ?? [("status", "unsatisfied"), ("interfaces", [Any?]()), ("expensive", false), ("constrained", false)]
            last = json(f)
            return f
        }
    }
}

// MARK: - clipboard (irq 46)

/// Polled twice a second, off the main thread, since reading the general
/// pasteboard can wait on the system's paste permission.
final class Clipboard {
    private let bus: Bus
    private let queue = DispatchQueue(label: "ermine.clipboard", qos: .utility)
    private var count = -1
    private var timer: DispatchSourceTimer?

    init(bus: Bus) { self.bus = bus }

    static func now() -> Fields {
        let pb = NSPasteboard.general
        return [("count", pb.changeCount), ("text", pb.string(forType: .string))]
    }

    /// The state now, which also sets the change count the poll starts from.
    func first() -> Fields {
        queue.sync {
            let f = Clipboard.now()
            count = f[0].1 as? Int ?? -1
            return f
        }
    }

    func watch() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.5, repeating: 0.5, leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let c = NSPasteboard.general.changeCount
            guard c != self.count else { return }
            self.count = c
            self.bus.send(46, [("count", c), ("text", NSPasteboard.general.string(forType: .string))])
        }
        t.resume()
        timer = t
    }

    /// Puts text on the pasteboard.
    func set(_ text: String) {
        queue.async {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(text, forType: .string)
        }
    }
}

// MARK: - volumes (irq 48)

final class Volumes {
    private let bus: Bus
    private var observers: [NSObjectProtocol] = []

    init(bus: Bus) { self.bus = bus }

    @MainActor
    func watch() {
        let ws = NSWorkspace.shared.notificationCenter
        for (name, event) in [(NSWorkspace.didMountNotification, "mount"), (NSWorkspace.didUnmountNotification, "unmount")] {
            observers.append(ws.addObserver(forName: name, object: nil, queue: nil) { [bus] note in
                let url = note.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL
                let name = note.userInfo?[NSWorkspace.localizedVolumeNameUserInfoKey] as? String
                bus.send(48, [("event", event), ("path", url?.path ?? note.userInfo?["NSDevicePath"] as? String),
                              ("name", name ?? url?.lastPathComponent)])
            })
        }
    }
}
