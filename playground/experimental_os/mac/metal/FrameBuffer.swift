// FrameBuffer.swift: the shared memory the OS draws into.
//
// $TMPDIR/ermine-<pid>.fb: a 4096-byte header page, then two buffers of
// maxw × maxh u32 pixels, 0x00RRGGBB little-endian, rows of maxw.

import CoreGraphics
import Foundation
import IOSurface

final class FrameBuffer {
    static let magic: UInt32 = 0x4552_4d4e  // "ERMN"
    static let version: UInt32 = 1
    static let offset = 4096
    static let buffers = 2

    let path: String
    let maxw: Int
    let maxh: Int
    let size: Int
    private let base: UnsafeMutableRawPointer

    init(maxw: Int, maxh: Int) throws {
        self.maxw = maxw
        self.maxh = maxh
        var tmp = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
        if !tmp.hasSuffix("/") { tmp += "/" }
        path = tmp + "ermine-\(getpid()).fb"
        size = FrameBuffer.offset + FrameBuffer.buffers * maxw * maxh * 4

        let fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw MetalError("cannot make the frame buffer at \(path): \(String(cString: strerror(errno)))") }
        defer { close(fd) }
        guard ftruncate(fd, off_t(size)) == 0 else {
            throw MetalError("cannot size the frame buffer: \(String(cString: strerror(errno)))")
        }
        guard let p = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), p != MAP_FAILED else {
            throw MetalError("cannot map the frame buffer: \(String(cString: strerror(errno)))")
        }
        base = p
        let header = base.assumingMemoryBound(to: UInt32.self)
        header[0] = FrameBuffer.magic
        header[1] = FrameBuffer.version
        header[2] = UInt32(maxw)
        header[3] = UInt32(maxh)
        header[4] = UInt32(FrameBuffer.buffers)
        msync(base, FrameBuffer.offset, MS_SYNC)
    }

    func unlink() {
        Foundation.unlink(path)
    }

    /// A buffer's pixels, rows of maxw, for the OS linked in.
    func pixels(_ buffer: Int) -> UnsafeMutablePointer<UInt32> {
        (base + FrameBuffer.offset + buffer * maxw * maxh * 4).assumingMemoryBound(to: UInt32.self)
    }

    private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    /// Copies w × h pixels of a buffer, their top left at x, y, into a new
    /// image. Runs on whichever thread reads the command, so the copy is made
    /// before the OS can send its next flip or present.
    func snapshot(buffer: Int, x: Int = 0, y: Int = 0, w: Int, h: Int) -> CGImage? {
        guard (0..<FrameBuffer.buffers).contains(buffer), w >= 1, h >= 1, x >= 0, y >= 0, x + w <= maxw, y + h <= maxh else { return nil }
        let src = base + FrameBuffer.offset + buffer * maxw * maxh * 4 + (y * maxw + x) * 4
        let rowBytes = w * 4
        let bytes = rowBytes * h
        let dst = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 16)
        if w == maxw && x == 0 {
            memcpy(dst, src, bytes)
        } else {
            for y in 0..<h {
                memcpy(dst + y * rowBytes, src + y * maxw * 4, rowBytes)
            }
        }
        guard let provider = CGDataProvider(dataInfo: nil, data: dst, size: bytes, releaseData: { _, data, _ in
            data.deallocate()
        }) else {
            dst.deallocate()
            return nil
        }
        // 0x00RRGGBB little-endian: bytes B, G, R, unused.
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: rowBytes,
                       space: FrameBuffer.colorSpace, bitmapInfo: CGBitmapInfo(rawValue: info),
                       provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }
}

/// What the screen shows: two IOSurfaces, the picture layer's contents in
/// turn. A flip copies into the one not shown only what it lacks, what
/// changed since it was last written (two flips' worth), so a caret's blink
/// copies a caret; Core Animation reads the surface where it is, with no
/// upload of a whole frame. Used on the command thread only.
final class Front {
    private let fb: FrameBuffer
    private var surfaces: [IOSurface] = []
    private var lacks: [(x: Int, y: Int, w: Int, h: Int)?] = [nil, nil]
    private var w = 0
    private var h = 0
    private var next = 0
    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!.copyPropertyList()

    init(fb: FrameBuffer) { self.fb = fb }

    private static func unite(_ a: (x: Int, y: Int, w: Int, h: Int)?, _ b: (x: Int, y: Int, w: Int, h: Int)) -> (x: Int, y: Int, w: Int, h: Int) {
        guard let a else { return b }
        let x = min(a.x, b.x), y = min(a.y, b.y)
        return (x, y, max(a.x + a.w, b.x + b.w) - x, max(a.y + a.h, b.y + b.h) - y)
    }

    /// A buffer flipped, w × h of it shown, dirty what changed since the last
    /// flip (nil: all of it): the surface to show, or nil when out of range.
    func flip(buffer: Int, w: Int, h: Int, dirty: (x: Int, y: Int, w: Int, h: Int)?) -> IOSurface? {
        guard (0..<FrameBuffer.buffers).contains(buffer), w >= 1, h >= 1, w <= fb.maxw, h <= fb.maxh else { return nil }
        let all = (x: 0, y: 0, w: w, h: h)
        var changed = all
        if w != self.w || h != self.h || surfaces.isEmpty {
            surfaces = (0..<2).compactMap { _ in
                let s = IOSurface(properties: [.width: w, .height: h, .bytesPerElement: 4, .pixelFormat: 0x4247_5241])  // 'BGRA'
                if let s, let cs = Front.sRGB { IOSurfaceSetValue(s, "IOSurfaceColorSpace" as CFString, cs) }
                return s
            }
            guard surfaces.count == 2 else { return nil }
            self.w = w
            self.h = h
            lacks = [all, all]
        } else if let d = dirty {
            let x0 = max(0, d.x), y0 = max(0, d.y), x1 = min(w, d.x + d.w), y1 = min(h, d.y + d.h)
            changed = (x0, y0, max(0, x1 - x0), max(0, y1 - y0))
        }
        if changed.w > 0 && changed.h > 0 {
            for i in 0..<2 { lacks[i] = Front.unite(lacks[i], changed) }
        }
        let s = surfaces[next]
        if let r = lacks[next], r.w > 0, r.h > 0 {
            copy(buffer, r, into: s)
        }
        lacks[next] = nil
        next = 1 - next
        return s
    }

    /// The frame buffer's 0x00RRGGBB, opaque, as BGRA.
    private func copy(_ buffer: Int, _ r: (x: Int, y: Int, w: Int, h: Int), into s: IOSurface) {
        s.lock(options: [], seed: nil)
        defer { s.unlock(options: [], seed: nil) }
        let src = fb.pixels(buffer)
        let row = s.bytesPerRow
        let base = s.baseAddress
        for y in r.y..<(r.y + r.h) {
            let from = src + y * fb.maxw + r.x
            let to = (base + y * row).assumingMemoryBound(to: UInt32.self) + r.x
            for x in 0..<r.w { to[x] = from[x] | 0xFF00_0000 }
        }
    }
}

/// The page planes: web pages' pixels, beside the frame buffer
/// ($TMPDIR/ermine-<pid>.planes): a header page, then slots planes of
/// maxw × maxh u32, rows of maxw, as the frame buffer's pixels are.
final class Planes {
    static let magic: UInt32 = 0x4552_4d50  // "ERMP"
    static let offset = 4096
    let path: String
    let maxw: Int
    let maxh: Int
    let slots: Int
    let size: Int
    private let base: UnsafeMutableRawPointer

    init(maxw: Int, maxh: Int, slots: Int) throws {
        self.maxw = maxw
        self.maxh = maxh
        self.slots = slots
        var tmp = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
        if !tmp.hasSuffix("/") { tmp += "/" }
        path = tmp + "ermine-\(getpid()).planes"
        size = Planes.offset + slots * maxw * maxh * 4
        let fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw MetalError("cannot make the page planes at \(path)") }
        defer { close(fd) }
        guard ftruncate(fd, off_t(size)) == 0 else { throw MetalError("cannot size the page planes") }
        guard let p = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), p != MAP_FAILED else {
            throw MetalError("cannot map the page planes")
        }
        base = p
        let header = base.assumingMemoryBound(to: UInt32.self)
        header[0] = Planes.magic
        header[1] = 1
        header[2] = UInt32(maxw)
        header[3] = UInt32(maxh)
        header[4] = UInt32(slots)
    }

    /// Draws an image into a plane, w × h at its top left, as 0x00RRGGBB.
    func draw(_ image: CGImage, slot: Int, w: Int, h: Int) -> Bool {
        guard (0..<slots).contains(slot), w >= 1, h >= 1, w <= maxw, h <= maxh else { return false }
        let at = base + Planes.offset + slot * maxw * maxh * 4
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue
        guard let ctx = CGContext(data: at, width: w, height: h, bitsPerComponent: 8, bytesPerRow: maxw * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info) else { return false }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }

    func unlink() { Foundation.unlink(path) }

    /// A plane's pixels, rows of maxw, for the OS linked in.
    func pixels(_ slot: Int) -> UnsafeMutablePointer<UInt32> {
        (base + Planes.offset + slot * maxw * maxh * 4).assumingMemoryBound(to: UInt32.self)
    }
}

struct MetalError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}
