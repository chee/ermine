// Layers.swift: layers mode (../METAL.md, Layers). On the monitor, each of
// the OS's layers is a GPU layer of the metal's: a tile, its pixels two
// IOSurfaces in turn (a keyed Pane, Surfaces.swift), placed, stacked by z
// and shadowed as the OS says. Core Animation composites them, so a window
// moved or raised is a command and no pixels, and its shadow is soft: an
// image drawn once and moved with it, and its rounded corners its layers'
// own, so nothing is drawn offscreen as it moves.

import AppKit
import IOSurface
import QuartzCore

/// A tile's soft shadow: cast by box (in the tile's pixels, from its top
/// left), its corners rounded (top left, top right, bottom right, bottom
/// left), offset x, y and blurred radius, frame buffer pixels.
struct Shadow {
    var color: UInt32
    var opacity: Double
    var radius: Double
    var x: Double
    var y: Double
    var box: (x: Int, y: Int, w: Int, h: Int)
    var corners: [Double]
}

/// A tile's shape, when its window's corners are rounded: only box, its corners rounded, and box again drop
/// down and right (its hard shadow) are shown; frame buffer pixels in the tile, from its top left.
struct Outline {
    var box: (x: Int, y: Int, w: Int, h: Int)
    var corners: [Double]
    var drop: Int
}

/// One tile of a layers command, as main applies it: where (nil: as it was), its pixels' surface to show (nil: as they were).
struct Placing {
    var id: String
    var frame: (x: Int, y: Int, w: Int, h: Int, z: Double, shadow: Shadow?, shape: Outline?)?
    var image: IOSurface?
}

/// A rectangle with each corner rounded (top left, top right, bottom right, bottom left, as on the screen), in a layer whose y goes up.
func roundedPath(_ r: CGRect, _ c: [CGFloat], into p: CGMutablePath) {
    let tl = c[0], tr = c[1], br = c[2], bl = c[3]
    p.move(to: CGPoint(x: r.minX + tl, y: r.maxY))
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX, y: r.minY), radius: tr)
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.minX, y: r.minY), radius: br)
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX, y: r.maxY), radius: bl)
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.maxX, y: r.maxY), radius: tl)
    p.closeSubpath()
}

/// The tiles, over the monitor's picture: they take no clicks, so the pointer is the screen's.
@MainActor
final class Stack: NSView {
    private var tiles: [String: Tile] = [:]
    /// how many tiles have been placed: of two at one depth, the later is in front
    private var placed = 0
    /// frame buffer pixels from the top left to this view's points: the monitor's (Screen.local)
    var local: (NSRect) -> NSRect = { $0 }

    override var isOpaque: Bool { false }

    /// The tile with that id, made empty and hidden if there is none.
    func tile(_ id: String) -> Tile {
        if let t = tiles[id] { return t }
        let t = Tile(frame: .zero)
        t.isHidden = true
        tiles[id] = t
        addSubview(t)
        return t
    }

    /// A layers command: each tile placed, stacked and shown as it says, then those dropped, in one transaction.
    func apply(_ placings: [Placing], drop: [String]) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var restack = false
        for p in placings {
            let t = tile(p.id)
            if let f = p.frame {
                // new (made last, so in front), or its depth changed: in its place among the others
                if t.z != f.z || !t.placed { restack = true }
                if !t.placed { placed += 1; t.seq = placed }
                t.placed = true
                t.z = f.z
                t.at = (f.x, f.y, f.w, f.h)
                t.shade = f.shadow
                t.shape = f.shape
                place(t)
            }
            if let image = p.image {
                t.show(image)
                t.isHidden = false
            }
        }
        for id in drop {
            tiles.removeValue(forKey: id)?.removeFromSuperview()
        }
        if restack { sortSubviews({ a, b, _ in Stack.order(a, b) }, context: nil) }
        CATransaction.commit()
    }

    /// Lower z first, so the last subview is in front, as the OS stacks them.
    nonisolated private static func order(_ a: NSView, _ b: NSView) -> ComparisonResult {
        MainActor.assumeIsolated {
            let za = (a as? Tile)?.z ?? 0, zb = (b as? Tile)?.z ?? 0, sa = (a as? Tile)?.seq ?? 0, sb = (b as? Tile)?.seq ?? 0
            return za < zb || (za == zb && sa < sb) ? .orderedAscending : za > zb || (za == zb && sa > sb) ? .orderedDescending : .orderedSame
        }
    }

    private func place(_ t: Tile) {
        let r = local(NSRect(x: t.at.x, y: t.at.y, width: t.at.w, height: t.at.h))
        if t.frame != r { t.frame = r }
        t.cast(scale: t.at.w > 0 ? r.width / CGFloat(t.at.w) : 1)
    }

    /// Every tile where it is again: the monitor changed size.
    func relayout() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for t in tiles.values { place(t) }
        CATransaction.commit()
    }

    /// The stack emptied: leaving the monitor for windows mode, or coming back.
    func removeAll() {
        for t in tiles.values { t.removeFromSuperview() }
        tiles.removeAll()
    }

    /// No tile takes the pointer: the screen beneath has it.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// A soft shadow drawn once, as a 9-slice: the shadow of a rounded box whose middle is one point, its
/// insets (points) the corners' parts that do not stretch. Kept by what made it, so every tile with
/// the same radius, corners, colour and scale shares one image, made once.
@MainActor
final class Shadows {
    struct Slice {
        let image: CGImage
        let left: CGFloat, right: CGFloat, top: CGFloat, bottom: CGFloat  // points
        let margin: CGFloat  // points the shadow reaches past the box
        let scale: CGFloat   // the image's pixels a point
    }
    static var made: [String: Slice] = [:]

    /// the shadow of a box with corners (top left, top right, bottom right, bottom left; points) blurred
    /// radius points, in colour, at scale pixels a point
    static func slice(radius: CGFloat, corners c: [CGFloat], color: UInt32, scale: CGFloat) -> Slice? {
        let key = "\(radius) \(c) \(color) \(scale)"
        if let s = made[key] { return s }
        let margin = ceil(radius * 2) + 1
        let left = margin + max(c[0], c[3]), right = margin + max(c[1], c[2])
        let top = margin + max(c[0], c[1]), bottom = margin + max(c[3], c[2])
        let w = left + 1 + right, h = bottom + 1 + top
        let pw = Int(ceil(w * scale)), ph = Int(ceil(h * scale))
        guard pw > 0, ph > 0,
              let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.scaleBy(x: scale, y: scale)
        let colour = CGColor(srgbRed: CGFloat((color >> 16) & 255) / 255, green: CGFloat((color >> 8) & 255) / 255, blue: CGFloat(color & 255) / 255, alpha: 1)
        // the box drawn off the image, its shadow cast back onto it: only the shadow is in the image
        let away = w + 4 * margin
        let box = CGRect(x: margin - away, y: margin, width: w - 2 * margin, height: h - 2 * margin)
        let path = CGMutablePath()
        roundedPath(box, c, into: path)
        ctx.setShadow(offset: CGSize(width: away * scale, height: 0), blur: radius * scale, color: colour)
        ctx.addPath(path)
        ctx.setFillColor(colour)
        ctx.fillPath()
        guard let image = ctx.makeImage() else { return nil }
        let s = Slice(image: image, left: left, right: right, top: top, bottom: bottom, margin: margin, scale: scale)
        made[key] = s
        return s
    }
}

/// A layer as the metal composites it: its pixels, its place and depth, its soft shadow. The shadow is
/// an image drawn once (Shadows), in a layer behind; a rounded tile is clipped by its layers' own
/// corners (cornerRadius, masksToBounds), not a mask: neither needs an offscreen pass each frame, so a
/// window moved is only its layers moved.
@MainActor
final class Tile: NSView {
    /// the soft shadow behind; the tile's box, clipping the picture; its hard drop, clipping a second picture
    private let soft = CALayer(), clip = CALayer(), drop = CALayer()
    private let picture = CALayer(), dropped = CALayer()
    private var shadowKey = ""
    var z: Double = 0
    /// told where it is at least once: till then it is hidden and out of order
    var placed = false
    var seq = 0
    var at: (x: Int, y: Int, w: Int, h: Int) = (0, 0, 0, 0)
    var shade: Shadow?
    var shape: Outline?

    override init(frame: NSRect) {
        super.init(frame: frame)
        let root = CALayer()
        root.masksToBounds = false
        layer = root
        wantsLayer = true
        clipsToBounds = false
        let still: [String: CAAction] = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "frame": NSNull(), "hidden": NSNull(),
                                         "cornerRadius": NSNull(), "maskedCorners": NSNull(), "opacity": NSNull(), "contentsCenter": NSNull(),
                                         "contentsScale": NSNull()]
        for l in [root, soft, clip, drop, picture, dropped] { l.actions = still }
        for p in [picture, dropped] {
            p.magnificationFilter = .nearest
            p.minificationFilter = .nearest
            p.contentsGravity = .resize
            p.isOpaque = false
        }
        soft.isHidden = true
        drop.isHidden = true
        clip.masksToBounds = true
        drop.masksToBounds = true
        clip.addSublayer(picture)
        drop.addSublayer(dropped)
        root.addSublayer(soft)
        root.addSublayer(drop)
        root.addSublayer(clip)
        clip.frame = bounds
        picture.frame = bounds
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isOpaque: Bool { false }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if shape == nil {
            clip.frame = bounds
            picture.frame = bounds
        }
    }

    func show(_ image: IOSurface) {
        picture.contents = image
        dropped.contents = image
    }

    /// A box in the tile's frame buffer pixels from its top left, in points (scale a pixel's) from its bottom left.
    private func rect(_ b: (x: Int, y: Int, w: Int, h: Int), _ s: CGFloat) -> CGRect {
        CGRect(x: CGFloat(b.x) * s, y: CGFloat(at.h - b.y - b.h) * s, width: CGFloat(b.w) * s, height: CGFloat(b.h) * s)
    }

    /// The corners as one layer takes them: the largest radius, on the corners that have one (top left,
    /// top right, bottom right, bottom left; the layer's y goes up)
    private func rounding(_ l: CALayer, _ c: [CGFloat]) {
        let r = c.max() ?? 0
        l.cornerRadius = r
        var m: CACornerMask = []
        if c[0] > 0 { m.insert(.layerMinXMaxYCorner) }
        if c[1] > 0 { m.insert(.layerMaxXMaxYCorner) }
        if c[2] > 0 { m.insert(.layerMaxXMinYCorner) }
        if c[3] > 0 { m.insert(.layerMinXMinYCorner) }
        l.maskedCorners = m
    }

    /// Its shape and shadow, in points (scale a frame buffer pixel's); the layer's y goes up. Rounded, the
    /// picture shows through its box's rounded corners (and its hard drop's), which smooths the stepped
    /// corners the OS keyed out; the shadow is the rounded box's, an image made once, only moved after.
    func cast(scale s: CGFloat) {
        if let sp = shape {
            let c = sp.corners.map { CGFloat($0) * s }, box = rect(sp.box, s)
            clip.frame = box
            rounding(clip, c)
            // the picture where it is in the tile, seen through the box
            picture.frame = CGRect(x: -box.minX, y: -box.minY, width: bounds.width, height: bounds.height)
            if sp.drop > 0 {
                let d = rect((sp.box.x + sp.drop, sp.box.y + sp.drop, sp.box.w, sp.box.h), s)
                drop.frame = d
                rounding(drop, c)
                dropped.frame = CGRect(x: -d.minX, y: -d.minY, width: bounds.width, height: bounds.height)
                drop.isHidden = false
            } else {
                drop.isHidden = true
            }
        } else {
            clip.frame = bounds
            clip.cornerRadius = 0
            picture.frame = bounds
            drop.isHidden = true
        }
        guard let sh = shade, sh.opacity > 0 else {
            soft.isHidden = true
            return
        }
        let box = rect(sh.box, s)
        let corners = sh.corners.count == 4 ? sh.corners.map { CGFloat($0) * s } : [0, 0, 0, 0]
        let screen = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let key = "\(sh.radius * Double(s)) \(corners) \(sh.color) \(screen)"
        if key != shadowKey, let slice = Shadows.slice(radius: CGFloat(sh.radius) * s, corners: corners, color: sh.color, scale: screen) {
            shadowKey = key
            soft.contents = slice.image
            soft.contentsScale = screen
            let w = CGFloat(slice.image.width) / screen, h = CGFloat(slice.image.height) / screen
            soft.contentsCenter = CGRect(x: slice.left / w, y: slice.bottom / h, width: 1 / w, height: 1 / h)
            shadowMargin = slice.margin
        }
        let m = shadowMargin
        soft.frame = box.insetBy(dx: -m, dy: -m).offsetBy(dx: CGFloat(sh.x) * s, dy: -CGFloat(sh.y) * s)
        soft.opacity = Float(sh.opacity)
        soft.isHidden = shadowKey.isEmpty
    }

    private var shadowMargin: CGFloat = 0
}

/// A layers command's shadow, as the OS sends it; nil for none.
func parseShadow(_ v: Any?) -> Shadow? {
    guard let s = v as? [String: Any], let b = s["box"] as? [String: Any], let bx = int(b["x"]), let by = int(b["y"]), let bw = int(b["w"]), let bh = int(b["h"]) else { return nil }
    return Shadow(color: UInt32(truncatingIfNeeded: int(s["color"]) ?? 0), opacity: double(s["opacity"]) ?? 0, radius: double(s["radius"]) ?? 0,
                  x: double(s["x"]) ?? 0, y: double(s["y"]) ?? 0, box: (bx, by, bw, bh), corners: corners(s["corners"]))
}

/// A layers command's shape, as the OS sends it; nil for a square tile.
func parseOutline(_ v: Any?) -> Outline? {
    guard let s = v as? [String: Any], let b = s["box"] as? [String: Any], let bx = int(b["x"]), let by = int(b["y"]), let bw = int(b["w"]), let bh = int(b["h"]) else { return nil }
    let c = corners(s["corners"])
    guard c.contains(where: { $0 > 0 }) else { return nil }
    return Outline(box: (bx, by, bw, bh), corners: c, drop: int(s["drop"]) ?? 0)
}

/// Four corners' radii, top left first; none, all 0.
private func corners(_ v: Any?) -> [Double] {
    guard let a = v as? [Any], a.count == 4 else { return [0, 0, 0, 0] }
    return a.map { double($0) ?? 0 }
}
