// FontServer.swift: the font chip, irq 50. The OS asks for a page of a font,
// 256 code points at a size in frame buffer pixels, and gets back a strip:
// each glyph's coverage side by side, on one baseline, with where each one
// sits and how far it moves the pen. CoreText renders it, as fontsrv does
// for Plan 9; a character the font lacks comes from CoreText's fallback.

import AppKit
import CoreText

final class FontServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ermine.fonts")
    private let bus: Bus

    init(bus: Bus) { self.bus = bus }

    /// Every font family on the Mac, for the device tree.
    static var families: [String] {
        (CTFontManagerCopyAvailableFontFamilyNames() as? [String]) ?? []
    }

    /// Renders a page on a queue of its own, so flips go on meanwhile, and
    /// posts it as a record.
    func glyphs(font: String, size: Double, bold: Bool, page: Int) {
        queue.async { [self] in
            bus.send(50, FontServer.render(font: font, size: size, bold: bold, page: page))
        }
    }

    /// The face: the bold one if asked for and there is one; else the font
    /// itself, made bold by stroking its outlines (synthetic).
    private static func face(_ name: String, _ size: Double, bold: Bool) -> (CTFont, Bool) {
        let f = CTFontCreateWithName(name as CFString, CGFloat(size), nil)
        guard bold else { return (f, false) }
        if let b = CTFontCreateCopyWithSymbolicTraits(f, CGFloat(size), nil, .traitBold, .traitBold) { return (b, false) }
        return (f, true)
    }

    static func render(font name: String, size: Double, bold: Bool, page: Int) -> Fields {
        let (font, synthetic) = face(name, max(1, size), bold: bold)
        let ascent = Int(CTFontGetAscent(font).rounded(.up))
        let descent = Int(CTFontGetDescent(font).rounded(.up))
        let h = max(1, ascent + descent)
        let white = CGColor(gray: 1, alpha: 1)
        var attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: white]
        // a stroke 4% of the size wide, half of it outside the outline
        let stroke = synthetic ? size * 0.04 : 0
        if synthetic {
            attrs[kCTStrokeWidthAttributeName] = -4.0
            attrs[kCTStrokeColorAttributeName] = white
        }

        // Each glyph: its line, its ink's left edge from the pen and its width, and its advance.
        struct Glyph { var line: CTLine?; var left = 0; var w = 0; var advance = 0.0 }
        var glyphs: [Glyph] = []
        for i in 0..<256 {
            let cp = page * 256 + i
            var g = Glyph()
            // no glyphs for controls, or for surrogates, which are not characters
            guard cp >= 0x20, !(0x7f..<0xa0).contains(cp), let scalar = UnicodeScalar(cp) else {
                glyphs.append(g)
                continue
            }
            // Text presentation (U+FE0E) keeps symbols like ⚡ out of the emoji font.
            let text = cp < 0x80 ? String(Character(scalar)) : String(Character(scalar)) + "\u{FE0E}"
            let line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary))
            g.advance = CTLineGetTypographicBounds(line, nil, nil, nil) + stroke * 0.75
            let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
            if !ink.isEmpty, ink.width > 0 {
                // a pixel either side for antialiasing, and the stroke's width
                let pad = 1 + Int(stroke.rounded(.up))
                g.left = Int(ink.minX.rounded(.down)) - pad
                g.w = Int(ink.maxX.rounded(.up)) + pad - g.left
                g.line = line
            }
            glyphs.append(g)
        }

        // The strip: the glyphs' boxes side by side, rows top first.
        let w = max(1, glyphs.reduce(0) { $0 + $1.w })
        var alpha = Data(count: w * h)
        var info: [Any?] = []
        alpha.withUnsafeMutableBytes { (buf: UnsafeMutableRawBufferPointer) in
            let gray = CGColorSpaceCreateDeviceGray()
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            ctx.setFillColor(gray: 0, alpha: 1)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.setShouldAntialias(true)
            ctx.setShouldSmoothFonts(false)
            ctx.setAllowsFontSubpixelPositioning(false)
            ctx.setShouldSubpixelPositionFonts(false)
            ctx.textMatrix = .identity
            var x = 0
            for g in glyphs {
                info += [x, g.left, g.w, (g.advance * 64).rounded() / 64]
                guard let line = g.line else { continue }
                ctx.saveGState()
                ctx.clip(to: CGRect(x: x, y: 0, width: g.w, height: h))
                // CoreGraphics counts from the bottom: the baseline is descent up
                ctx.textPosition = CGPoint(x: CGFloat(x - g.left), y: CGFloat(descent))
                CTLineDraw(line, ctx)
                ctx.restoreGState()
                x += g.w
            }
            ctx.flush()
        }
        return [
            ("event", "glyphs"), ("font", name), ("family", CTFontCopyFamilyName(font) as String),
            ("size", size), ("bold", bold), ("synthetic", synthetic), ("page", page),
            ("ascent", ascent), ("descent", descent), ("leading", Double(CTFontGetLeading(font))),
            ("w", w), ("h", h), ("alpha", alpha.base64EncodedString()), ("info", info),
        ]
    }
}
