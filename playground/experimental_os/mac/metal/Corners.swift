// The pointer on a screen with rounded corners: pure geometry, no AppKit, so a
// test can drive it alone (see METAL.md, `display` `corner`).
import CoreGraphics

/// Where a pointer at `p` goes when the hand moves it by `d`, on a `size` box whose
/// top and bottom corners are cut by circles of radius `top` and `bottom` (0: square),
/// each touching both edges. One unit throughout (the Screen uses points).
/// The box's edges stop the motion across them; an arc takes the motion along it
/// and drops the motion into it, as a wall does, so pushed into a corner the pointer
/// slides round and on along the other edge. In small steps: each one past the arc
/// is put back on it, nearest point, which for a small step is the step's part
/// along the arc. `p` is taken as inside.
func slide(_ p: CGPoint, _ d: CGVector, size: CGSize, top: CGFloat, bottom: CGFloat) -> CGPoint {
    let w = size.width, h = size.height
    // the right and bottom edges stop just short, so a pixel taken by rounding down is on the screen
    let maxX = max(0, w - 1e-3), maxY = max(0, h - 1e-3)
    func box(_ q: CGPoint) -> CGPoint { CGPoint(x: min(max(q.x, 0), maxX), y: min(max(q.y, 0), maxY)) }
    let t = min(top, w / 2, h / 2), b = min(bottom, w / 2, h / 2)
    func arc(_ q: CGPoint) -> CGPoint {
        var q = q
        for (r, upper) in [(t, true), (b, false)] where r > 0 {
            let cy = upper ? r : h - r
            guard upper ? q.y < cy : q.y > cy else { continue }
            let cx: CGFloat = q.x < r ? r : q.x > w - r ? w - r : -1
            guard cx >= 0 else { continue }
            let dx = q.x - cx, dy = q.y - cy, n = (dx * dx + dy * dy).squareRoot()
            if n > r { q = CGPoint(x: cx + dx * r / n, y: cy + dy * r / n) }
        }
        return q
    }
    let end = box(CGPoint(x: p.x + d.dx, y: p.y + d.dy))
    let r = max(t, b)
    guard r > 0 else { return end }
    // a move whose bounds miss every corner's square is only boxed
    let near = { (q: CGPoint) in
        (q.x < r || q.x > w - r) && ((t > 0 && q.y < t) || (b > 0 && q.y > h - b))
    }
    let lo = CGPoint(x: min(p.x, end.x), y: min(p.y, end.y)), hi = CGPoint(x: max(p.x, end.x), y: max(p.y, end.y))
    let corners = [CGPoint(x: lo.x, y: lo.y), CGPoint(x: hi.x, y: lo.y), CGPoint(x: lo.x, y: hi.y), CGPoint(x: hi.x, y: hi.y)]
    if !corners.contains(where: near) { return arc(end) }
    // steps of at most a twentieth of the smaller radius (and a quarter unit): the slide's error is step² / 2r
    let small = min(t > 0 ? t : r, b > 0 ? b : r)
    let step = max(min(small / 20, 0.25), 1e-3)
    let length = (d.dx * d.dx + d.dy * d.dy).squareRoot()
    let n = max(1, Int((length / step).rounded(.up)))
    let sx = d.dx / CGFloat(n), sy = d.dy / CGFloat(n)
    var q = arc(box(p))
    for _ in 0..<n { q = arc(box(CGPoint(x: q.x + sx, y: q.y + sy))) }
    return q
}

/// The arc the pointer keeps to, in points, for a screen corner of radius `r` points with `per`
/// pixels a point: larger than the corner's, so the pixel under the hot spot (rounded down) is
/// always one the screen shows, its centre inside the corner's circle. Two pixels more at the
/// middle of the arc, and half the square root of the radius where it meets the edges, where the
/// pixels of a stepped curve reach furthest in.
func rim(_ r: CGFloat, per: CGFloat) -> CGFloat {
    guard r > 0, per > 0 else { return 0 }
    let px = r * per
    return (px + 1.75 + px.squareRoot() / 2) / per
}
