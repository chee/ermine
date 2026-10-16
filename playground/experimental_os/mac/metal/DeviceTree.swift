// DeviceTree.swift: what the machine is, read from the real Mac at start.

import AppKit
import CoreAudio
import IOKit
import SystemConfiguration

func sysctlString(_ name: String) -> String? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
    return String(cString: buf)
}

func sysctlInt(_ name: String) -> Int? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0 else { return nil }
    switch size {
    case 4:
        var v: Int32 = 0
        return sysctlbyname(name, &v, &size, nil, 0) == 0 ? Int(v) : nil
    case 8:
        var v: Int64 = 0
        return sysctlbyname(name, &v, &size, nil, 0) == 0 ? Int(v) : nil
    default:
        return nil
    }
}

/// The screens, in points; the first is the one with the menu bar.
@MainActor
func screensList() -> [Any?] {
    let screens = NSScreen.screens
    return screens.enumerated().map { i, s -> Any? in
        [("name", s.localizedName), ("w", Int(s.frame.width)), ("h", Int(s.frame.height)),
         ("scale", Double(s.backingScaleFactor)), ("main", i == 0)] as Fields
    }
}

/// Whether a trackpad is attached: a multitouch device that says it is one.
func hasTrackpad() -> Bool {
    var iter: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleMultitouchDevice"), &iter) == KERN_SUCCESS else {
        return false
    }
    defer { IOObjectRelease(iter) }
    var found = false
    var service = IOIteratorNext(iter)
    while service != 0 {
        if let product = IORegistryEntryCreateCFProperty(service, "Product" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String, product.localizedCaseInsensitiveContains("trackpad") {
            found = true
        }
        IOObjectRelease(service)
        service = IOIteratorNext(iter)
    }
    return found
}

/// The names of the audio output devices, the default one first.
func audioOutputs() -> [Any?] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var defaultOut = AudioObjectID(0)
    var defaultAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                    mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var defaultSize = UInt32(MemoryLayout<AudioObjectID>.size)
    _ = AudioObjectGetPropertyData(system, &defaultAddress, 0, nil, &defaultSize, &defaultOut)

    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
    var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else { return [] }

    var names: [(String, Bool)] = []
    for device in devices {
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { continue }
        var name: Unmanaged<CFString>?
        var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal,
                                                     mElement: kAudioObjectPropertyElementMain)
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, &name) == noErr, let n = name else { continue }
        names.append((n.takeRetainedValue() as String, device == defaultOut))
    }
    names.sort { $0.1 && !$1.1 }
    return names.map { $0.0 }
}

@MainActor
func deviceTree(fb: FrameBuffer, planes: Planes, scale: Double, font: FontROM, uart: Bool) -> Fields {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    var os = "macOS \(v.majorVersion).\(v.minorVersion)"
    if v.patchVersion != 0 { os += ".\(v.patchVersion)" }

    var devices: [Any?] = [
        [("name", "display"), ("irq", 33)] as Fields,
        [("name", "keyboard"), ("irq", 34)] as Fields,
        [("name", "pointer"), ("irq", 35), ("trackpad", hasTrackpad())] as Fields,
    ]
    if uart { devices.append([("name", "uart0"), ("irq", 36)] as Fields) }
    devices += [
        [("name", "power"), ("irq", 40)] as Fields,
        [("name", "thermal"), ("irq", 41)] as Fields,
        [("name", "sleep"), ("irq", 42)] as Fields,
        [("name", "cpu"), ("irq", 43)] as Fields,
        [("name", "usb"), ("irq", 44)] as Fields,
        [("name", "net"), ("irq", 45)] as Fields,
        [("name", "clipboard"), ("irq", 46)] as Fields,
        [("name", "volumes"), ("irq", 48)] as Fields,
        [("name", "web"), ("irq", 49), ("engine", "WebKit")] as Fields,
        [("name", "font"), ("irq", 50), ("families", FontServer.families)] as Fields,
        // the Mac's other apps: what TCC allows now, never asked for here (no prompt)
        [("name", "mac"), ("irq", 51), ("ax", AXIsProcessTrusted()), ("capture", CGPreflightScreenCaptureAccess())] as Fields,
        [("name", "speech")] as Fields,
        [("name", "haptics")] as Fields,
        [("name", "audio"), ("outputs", audioOutputs())] as Fields,
    ]

    return [
        ("model", sysctlString("hw.model") ?? "Mac"),
        ("cpu", sysctlString("machdep.cpu.brand_string") ?? ""),
        ("cores", sysctlInt("hw.ncpu") ?? ProcessInfo.processInfo.processorCount),
        ("memory", sysctlInt("hw.memsize") ?? Int(ProcessInfo.processInfo.physicalMemory)),
        ("os", os),
        ("host", (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName),
        ("user", NSUserName()),
        ("home", NSHomeDirectory()),
        ("screens", screensList()),
        ("fb", [("path", fb.path), ("maxw", fb.maxw), ("maxh", fb.maxh), ("buffers", FrameBuffer.buffers),
                ("offset", FrameBuffer.offset), ("format", "xrgb8888"), ("scale", scale), ("unit", max(1, Int((1 / scale).rounded()))),
                ("planes", [("path", planes.path), ("slots", planes.slots), ("offset", Planes.offset)] as Fields)] as Fields),
        ("font", font.fields),
        ("devices", devices),
    ]
}
