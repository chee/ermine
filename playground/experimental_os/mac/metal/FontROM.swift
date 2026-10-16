// FontROM.swift: the firmware's font.
//
// CoreText renders a monospaced font (Monaco, the classic Mac's, unless
// --font names another; else SF Mono, else Menlo) into cells of w × h frame buffer pixels, 8-bit coverage, rows top
// first, every glyph on one baseline. At scale 1 the cell is 8 × 16; at
// scale N it is 8/N × 16/N, so a cell stays about 8 × 16 points on screen.

import AppKit
import CoreText

struct FontROM {
    let name: String
    let w: Int
    let h: Int
    let chars: [Character]
    let alpha: Data

    static let extra = "·•●○◆◇▲▼◀▶←↑→↓…°±×÷─│┌┐└┘├┤┬┴┼═║╔╗╚╝╭╮╯╰█▀▄▌▐░▒▓■□▪▫✓✗⏻⚡"

    static var characters: [Character] {
        (32...126).map { Character(UnicodeScalar(UInt8($0))) } + Array(extra)
    }

    var fields: Fields {
        [("name", name), ("w", w), ("h", h), ("chars", String(chars)), ("alpha", alpha.base64EncodedString())]
    }

    /// The font: the one asked for (--font, a PostScript or family name), else
    /// Monaco, the classic Mac's monospace, else SF Mono, else Menlo; and its
    /// name for the tree.
    private static func baseFont(_ asked: String?) -> (CTFont, String) {
        for want in [asked, "Monaco"].compactMap({ $0 }) {
            let f = CTFontCreateWithName(want as CFString, 12, nil)
            let ps = CTFontCopyPostScriptName(f) as String, family = CTFontCopyFamilyName(f) as String
            if ps.caseInsensitiveCompare(want) == .orderedSame || family.caseInsensitiveCompare(want) == .orderedSame {
                return (f, family)
            }
        }
        let sf = CTFontCreateWithName("SFMono-Regular" as CFString, 12, nil)
        if (CTFontCopyPostScriptName(sf) as String) == "SFMono-Regular" {
            return (sf, "SF Mono")
        }
        // The system's monospaced font is SF Mono, under a private name.
        let system = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) as CTFont
        let family = CTFontCopyFamilyName(system) as String
        if family.contains("SF Mono") || family.contains("SFMono") || family.contains("Monospaced") {
            return (system, "SF Mono")
        }
        return (CTFontCreateWithName("Menlo-Regular" as CFString, 12, nil), "Menlo")
    }

    static func make(scale: Double, font asked: String? = nil) -> FontROM {
        let w = max(3, Int((8 / scale).rounded()))
        let h = max(5, Int((16 / scale).rounded()))
        let (base, name) = baseFont(asked)

        // The size whose advance is the cell's width.
        var glyph = CGGlyph(0)
        var m: UniChar = 0x4D  // "M"
        CTFontGetGlyphsForCharacters(base, &m, &glyph, 1)
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(base, .horizontal, &glyph, &advance, 1)
        let em = advance.width / CTFontGetSize(base)  // advance per point of size
        var size = CGFloat(w) / em
        // Shrink if the font's ascent and descent would not fit the cell's height.
        let lineAt1 = (CTFontGetAscent(base) + CTFontGetDescent(base)) / CTFontGetSize(base)
        if lineAt1 * size > CGFloat(h) { size = CGFloat(h) / lineAt1 }
        let font = CTFontCreateCopyWithAttributes(base, size, nil, nil)

        let ascent = CTFontGetAscent(font)
        let descent = CTFontGetDescent(font)
        // One baseline for every cell: the font's ascent and descent centred.
        let baselineFromTop = ((CGFloat(h) - (ascent + descent)) / 2 + ascent).rounded()
        let baselineY = CGFloat(h) - baselineFromTop  // from the bottom, as CoreGraphics counts

        let chars = characters
        var alpha = Data(count: chars.count * w * h)
        let gray = CGColorSpaceCreateDeviceGray()
        let white = CGColor(gray: 1, alpha: 1)
        alpha.withUnsafeMutableBytes { (all: UnsafeMutableRawBufferPointer) in
            for (i, ch) in chars.enumerated() {
                let cell = all.baseAddress! + i * w * h
                guard let ctx = CGContext(data: cell, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                          space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { continue }
                ctx.setFillColor(gray: 0, alpha: 1)
                ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
                ctx.setShouldAntialias(true)
                ctx.setShouldSmoothFonts(false)
                ctx.setAllowsFontSubpixelPositioning(false)
                ctx.setShouldSubpixelPositionFonts(false)
                ctx.textMatrix = .identity
                if drawCellGraphic(ch, ctx: ctx, cell: cell.assumingMemoryBound(to: UInt8.self), w: w, h: h) { continue }

                // Text presentation (U+FE0E) keeps symbols like ⚡ out of the emoji font.
                let text = ch.isASCII ? String(ch) : String(ch) + "\u{FE0E}"
                let attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: white]
                let line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary))
                let width = CTLineGetTypographicBounds(line, nil, nil, nil)
                // A glyph from a fallback font that is wider than the cell is
                // squeezed to fit; a narrower one is centred.
                var x: CGFloat = 0
                if width > CGFloat(w) * 1.05 {
                    ctx.translateBy(x: 0, y: baselineY)
                    ctx.scaleBy(x: CGFloat(w) / width, y: 1)
                    ctx.textPosition = .zero
                } else {
                    if abs(width - CGFloat(w)) > 0.5 { x = ((CGFloat(w) - width) / 2).rounded() }
                    ctx.textPosition = CGPoint(x: x, y: baselineY)
                }
                CTLineDraw(line, ctx)
                ctx.flush()
            }
        }
        log("font ROM: \(name) \(String(format: "%.2f", size))pt in \(w)x\(h) cells, baseline \(Int(baselineFromTop)) from the top, \(chars.count) glyphs")
        return FontROM(name: name, w: w, h: h, chars: chars, alpha: alpha)
    }

    /// Box drawing and block elements are drawn as lines and fills on the
    /// cell's pixel grid, as terminals do, so neighbouring cells join with
    /// sharp one-pixel lines whatever the font. Returns false for any other
    /// character.
    private static func drawCellGraphic(_ ch: Character, ctx: CGContext, cell: UnsafeMutablePointer<UInt8>, w: Int, h: Int) -> Bool {
        let cx = w / 2, cy = h / 2  // the light lines' column and row
        let a = cx - 1, b = cx + 1  // the double lines' columns
        let p = cy - 1, q = cy + 1  // the double lines' rows
        func row(_ y: Int, _ x0: Int, _ x1: Int) {
            guard y >= 0, y < h else { return }
            for x in max(0, x0)...min(w - 1, x1) { cell[y * w + x] = 255 }
        }
        func col(_ x: Int, _ y0: Int, _ y1: Int) {
            guard x >= 0, x < w else { return }
            for y in max(0, y0)...min(h - 1, y1) { cell[y * w + x] = 255 }
        }
        func light(left: Bool = false, right: Bool = false, up: Bool = false, down: Bool = false) {
            if left { row(cy, 0, cx) }
            if right { row(cy, cx, w - 1) }
            if up { col(cx, 0, cy) }
            if down { col(cx, cy, h - 1) }
        }
        func shade(_ on: (Int, Int) -> Bool) {
            for y in 0..<h { for x in 0..<w where on(x, y) { cell[y * w + x] = 255 } }
        }
        /// A rounded corner: from the edge `from` through the cell's centre to
        /// the edge `to`, stroked at pixel centres in CoreGraphics' upward y.
        func round(from: CGPoint, to: CGPoint) {
            let centre = CGPoint(x: CGFloat(cx) + 0.5, y: CGFloat(h - cy) - 0.5)
            let path = CGMutablePath()
            path.move(to: from)
            path.addArc(tangent1End: centre, tangent2End: to, radius: CGFloat(min(cx, cy)) * 0.75)
            path.addLine(to: to)
            ctx.setStrokeColor(gray: 1, alpha: 1)
            ctx.setLineWidth(1)
            ctx.addPath(path)
            ctx.strokePath()
            ctx.flush()
        }
        let midX = CGFloat(cx) + 0.5, midY = CGFloat(h - cy) - 0.5
        let top = CGPoint(x: midX, y: CGFloat(h)), bottom = CGPoint(x: midX, y: 0)
        let left = CGPoint(x: 0, y: midY), right = CGPoint(x: CGFloat(w), y: midY)

        switch ch {
        case "─": light(left: true, right: true)
        case "│": light(up: true, down: true)
        case "┌": light(right: true, down: true)
        case "┐": light(left: true, down: true)
        case "└": light(right: true, up: true)
        case "┘": light(left: true, up: true)
        case "├": light(right: true, up: true, down: true)
        case "┤": light(left: true, up: true, down: true)
        case "┬": light(left: true, right: true, down: true)
        case "┴": light(left: true, right: true, up: true)
        case "┼": light(left: true, right: true, up: true, down: true)
        case "═": row(p, 0, w - 1); row(q, 0, w - 1)
        case "║": col(a, 0, h - 1); col(b, 0, h - 1)
        case "╔": row(p, a, w - 1); col(a, p, h - 1); row(q, b, w - 1); col(b, q, h - 1)
        case "╗": row(p, 0, b); col(b, p, h - 1); row(q, 0, a); col(a, q, h - 1)
        case "╚": row(q, a, w - 1); col(a, 0, q); row(p, b, w - 1); col(b, 0, p)
        case "╝": row(q, 0, b); col(b, 0, q); row(p, 0, a); col(a, 0, p)
        case "╭": round(from: right, to: bottom)
        case "╮": round(from: left, to: bottom)
        case "╯": round(from: left, to: top)
        case "╰": round(from: right, to: top)
        case "█": shade { _, _ in true }
        case "▀": shade { _, y in y < h / 2 }
        case "▄": shade { _, y in y >= h / 2 }
        case "▌": shade { x, _ in x < w / 2 }
        case "▐": shade { x, _ in x >= w / 2 }
        case "░": shade { x, y in x % 2 == 0 && y % 2 == 0 }
        case "▒": shade { x, y in (x + y) % 2 == 0 }
        case "▓": shade { x, y in !(x % 2 == 1 && y % 2 == 1) }
        default: return false
        }
        return true
    }
}
