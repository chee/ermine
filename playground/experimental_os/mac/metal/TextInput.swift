// TextInput.swift: the Mac's input methods, in the OS's text (../METAL.md,
// Meaning). With textinput the OS says that something of its takes text,
// where its caret is and the text around it. While it does, the view with
// the keyboard is a Mac text input client: a key goes through the input
// method first, and what it makes of the key comes back as key, compose
// and commit records (irq 34). Every character's rectangle is the caret's,
// so the candidates, the accent menu and the emoji picker open there.

import AppKit

// MARK: - the text, as the input method sees it

/// The last textinput's text and selection, and the composition in it:
/// marked text, not yet typed. Offsets are UTF-16, as NSRange's are.
struct Doc {
    var text: NSString = ""
    var selection = NSRange(location: 0, length: 0)
    var marked: NSString = ""
    /// the selection inside the marked text
    var markedSelection = NSRange(location: 0, length: 0)
    /// the range of text the composition stands in for, when the input
    /// method named one; else it stands in for the selection
    var replace: NSRange?

    var composing: Bool { marked.length > 0 }
    var anchor: NSRange { replace ?? selection }

    /// The text with the composition in it.
    var whole: NSString {
        composing ? text.replacingCharacters(in: anchor, with: marked as String) as NSString : text
    }

    func selectedRange() -> NSRange {
        composing ? NSRange(location: anchor.location + markedSelection.location, length: markedSelection.length) : selection
    }

    func markedRange() -> NSRange {
        composing ? NSRange(location: anchor.location, length: marked.length) : NSRange(location: NSNotFound, length: 0)
    }

    /// A range of whole as a range of text: an end inside the composition
    /// goes to the edge of what it stands in for.
    func inText(_ r: NSRange) -> NSRange {
        guard composing else { return clamp(r, to: text.length) }
        let a = anchor, m = marked.length
        let w = clamp(r, to: whole.length)
        func map(_ p: Int, inside: Int) -> Int {
            p <= a.location ? p : p >= a.location + m ? p - m + a.length : inside
        }
        let start = map(w.location, inside: a.location)
        let end = map(w.location + w.length, inside: a.location + a.length)
        return clamp(NSRange(location: start, length: max(0, end - start)), to: text.length)
    }
}

/// A range cut to fit a text of that length.
func clamp(_ r: NSRange, to length: Int) -> NSRange {
    let start = min(max(r.location, 0), length)
    let (sum, over) = r.location.addingReportingOverflow(max(r.length, 0))
    let end = over ? length : min(max(sum, start), length)
    return NSRange(location: start, length: end - start)
}

// MARK: - what a key comes to

/// What an input method did with a key, in order.
enum Step: Equatable {
    /// marked text set, changed or ended (""), and its selection
    case compose(String, NSRange)
    /// text typed, in place of a range of the last textinput's text, or at the caret
    case insert(String, NSRange?)
    /// an editing command (an arrow, delete, return): the key's own record says it
    case command
}

/// What a key comes to: the compose and commit records, in order, then a
/// key record with this text; or no key record, when the input method took
/// the key, and then its key up goes too.
struct KeyOutcome {
    var records: [Fields] = []
    var key: String?
}

/// Decides what a key comes to from what the input method did with it,
/// and whether it said it took the key.
func keyOutcome(_ steps: [Step], markedBefore: Bool, markedAfter: Bool, repeating: Bool, handled: Bool, typed: String) -> KeyOutcome {
    let composed = steps.contains { if case .compose = $0 { true } else { false } }
    if markedBefore || markedAfter || composed {
        // the input method took the key; a command after it ended the composition is the key's own too
        let passed = !markedAfter && steps.last == .command
        return KeyOutcome(records: stepRecords(steps), key: passed ? typed : nil)
    }
    var inserted: [String] = []
    var replacing = false
    for case .insert(let text, let replace) in steps {
        inserted.append(text)
        if replace != nil { replacing = true }
    }
    // an accent chosen from the press-and-hold menu, in place of the letter held
    if replacing { return KeyOutcome(records: stepRecords(steps)) }
    if !inserted.isEmpty { return KeyOutcome(key: inserted.joined()) }
    // a letter held for the accent menu: its repeats are the input method's
    if steps.isEmpty && repeating && handled { return KeyOutcome() }
    return KeyOutcome(key: typed)
}

func composeRecord(_ text: String, _ selected: NSRange) -> Fields {
    [("event", "compose"), ("text", text), ("selected", [selected.location, selected.location + selected.length] as [Any?])]
}

func commitRecord(_ text: String, _ replace: NSRange?) -> Fields {
    var fields: Fields = [("event", "commit"), ("text", text)]
    if let r = replace { fields.append(("replace", [r.location, r.location + r.length] as [Any?])) }
    return fields
}

/// The compose and commit records for what an input method did; commands have none.
func stepRecords(_ steps: [Step]) -> [Fields] {
    steps.compactMap {
        switch $0 {
        case .compose(let text, let selected): composeRecord(text, selected)
        case .insert(let text, let replace): commitRecord(text, replace)
        case .command: nil
        }
    }
}

// MARK: - the state

/// What the OS last said with textinput, and the input method's composition.
@MainActor
final class TextInput {
    private let bus: Bus
    private(set) var on = false
    /// the surface the caret is in; nil: the monitor
    private(set) var surface: String?
    /// the caret, in frame buffer pixels where it shows
    private(set) var caret = NSRect.zero
    private(set) var doc = Doc()
    /// what the input method has done with the key it has, while it has one
    private var steps: [Step]?
    private var markedBefore = false
    /// the view that shows a surface, or the monitor for nil
    var host: (String?) -> PixelView? = { _ in nil }

    init(bus: Bus) { self.bus = bus }

    // MARK: textinput, from the OS

    func set(on: Bool, surface: String?, caret: NSRect, text: String, selection: (Int, Int)?) {
        let was = self.on
        guard on else {
            self.on = false
            if doc.composing {
                // nothing takes text: what the input method says as it lets go is not sent
                if let current = NSTextInputContext.current, current.client is PixelView { current.discardMarkedText() }
                endComposition()
                bus.send(34, composeRecord("", NSRange(location: 0, length: 0)))
            }
            if was { host(self.surface)?.inputContext?.invalidateCharacterCoordinates() }
            return
        }
        let t = text as NSString
        var sel = NSRange(location: t.length, length: 0)
        if let (a, b) = selection { sel = clamp(NSRange(location: min(a, b), length: abs(b - a)), to: t.length) }
        let changed = !was || caret != self.caret || surface != self.surface || !t.isEqual(to: doc.text as String) || sel != doc.selection
        self.on = true
        self.surface = surface
        self.caret = caret
        doc.text = t
        doc.selection = sel
        if let r = doc.replace { doc.replace = clamp(r, to: t.length) }
        if changed { host(surface)?.inputContext?.invalidateCharacterCoordinates() }
    }

    // MARK: a key, through the input method

    /// Hands a key to the input method, through the view with the keyboard,
    /// and says what it comes to.
    func key(_ e: NSEvent, in view: PixelView) -> KeyOutcome {
        begin()
        let handled = view.inputContext?.handleEvent(e) ?? false
        return end(repeating: e.isARepeat, handled: handled, typed: typedText(e))
    }

    /// The input method has a key: what it does is kept, not sent, until end.
    func begin() {
        steps = []
        markedBefore = doc.composing
    }

    func end(repeating: Bool, handled: Bool, typed: String) -> KeyOutcome {
        let done = steps ?? []
        steps = nil
        return keyOutcome(done, markedBefore: markedBefore, markedAfter: doc.composing, repeating: repeating, handled: handled, typed: typed)
    }

    // MARK: the input method's calls, through the views

    func insert(_ string: Any, replacing r: NSRange) {
        guard on else { return }
        let text = plain(string)
        let replace = r.location != NSNotFound ? doc.inText(r) : doc.composing ? doc.replace : nil
        if doc.composing {
            endComposition()
            step(.compose("", NSRange(location: 0, length: 0)))
        }
        guard !text.isEmpty || replace != nil else { return }
        step(.insert(text, replace))
    }

    func mark(_ string: Any, selected: NSRange, replacing r: NSRange) {
        guard on else { return }
        let text = plain(string) as NSString
        guard text.length > 0 else {
            guard doc.composing else { return }
            endComposition()
            step(.compose("", NSRange(location: 0, length: 0)))
            return
        }
        if r.location != NSNotFound { doc.replace = doc.inText(r) }
        doc.marked = text
        doc.markedSelection = clamp(selected, to: text.length)
        step(.compose(text as String, doc.markedSelection))
    }

    /// The composition is let go as it is: typed, as NSTextView keeps it.
    func unmark() {
        guard on, doc.composing else { return }
        let text = doc.marked as String, replace = doc.replace
        endComposition()
        step(.compose("", NSRange(location: 0, length: 0)))
        step(.insert(text, replace))
    }

    func command() {
        guard on else { return }
        steps?.append(.command)
    }

    func substring(_ range: NSRange, actual: NSRangePointer?) -> NSAttributedString? {
        let whole = doc.whole
        guard range.location != NSNotFound, range.location <= whole.length else { return nil }
        let r = clamp(range, to: whole.length)
        actual?.pointee = r
        return NSAttributedString(string: whole.substring(with: r))
    }

    /// Every character's rectangle is the caret's, in Cocoa's screen coordinates.
    func rect(_ range: NSRange, actual: NSRangePointer?, from view: PixelView) -> NSRect {
        actual?.pointee = range.location == NSNotFound ? range : clamp(range, to: doc.whole.length)
        return caretRect(from: view)
    }

    func caretRect(from view: PixelView) -> NSRect {
        (host(surface) ?? view).screenRect(caret)
    }

    private func endComposition() {
        doc.marked = ""
        doc.markedSelection = NSRange(location: 0, length: 0)
        doc.replace = nil
    }

    /// Kept while the input method has a key; else (the emoji picker,
    /// dictation, a click in the candidates) sent at once.
    private func step(_ s: Step) {
        if steps != nil {
            steps?.append(s)
            return
        }
        for fields in stepRecords([s]) { bus.send(34, fields) }
    }

    private func plain(_ string: Any) -> String {
        (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    }
}

// MARK: - the views

/// A view that shows the OS's pixels, the monitor or a surface's content,
/// and says what they mean: a text input client for the OS's text, and the
/// host of its accessibility elements (Access.swift).
class PixelView: NSView, NSTextInputClient {
    var textInput: TextInput?
    var access: Access?
    /// the surface it shows; nil for the monitor
    var surface: String? { nil }

    /// A rectangle in its frame buffer pixels, from its top left, in its own points.
    func local(_ r: NSRect) -> NSRect { r }

    /// A rectangle in its frame buffer pixels, from its top left, in Cocoa's screen coordinates.
    func screenRect(_ r: NSRect) -> NSRect {
        guard let window else { return local(r) }
        return window.convertToScreen(convert(local(r), to: nil))
    }

    /// A click at a point in its frame buffer pixels, from an accessibility client.
    func accessClick(x: Int, y: Int) {}

    // MARK: NSTextInputClient: all of it the shared TextInput's

    func insertText(_ string: Any, replacementRange: NSRange) {
        textInput?.insert(string, replacing: replacementRange)
    }

    override func insertText(_ insertString: Any) {
        textInput?.insert(insertString, replacing: NSRange(location: NSNotFound, length: 0))
    }

    /// Nothing: the key's own record carries arrows, delete and return.
    override func doCommand(by selector: Selector) {
        textInput?.command()
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        textInput?.mark(string, selected: selectedRange, replacing: replacementRange)
    }

    func unmarkText() { textInput?.unmark() }

    func selectedRange() -> NSRange { textInput?.doc.selectedRange() ?? NSRange(location: NSNotFound, length: 0) }

    func markedRange() -> NSRange { textInput?.doc.markedRange() ?? NSRange(location: NSNotFound, length: 0) }

    func hasMarkedText() -> Bool { textInput?.doc.composing ?? false }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        textInput?.substring(range, actual: actualRange)
    }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        textInput?.rect(range, actual: actualRange, from: self) ?? .zero
    }

    func characterIndex(for point: NSPoint) -> Int { NSNotFound }

    /// The caret, for the dictation indicator.
    var unionRectInVisibleSelectedRange: NSRect { textInput?.caretRect(from: self) ?? .zero }

    var documentVisibleRect: NSRect {
        guard let window else { return visibleRect }
        return window.convertToScreen(convert(visibleRect, to: nil))
    }

    /// The input source and caps lock indicator shows at the caret only while text input is on.
    func preferredTextAccessoryPlacement() -> NSTextCursorAccessoryPlacement {
        textInput?.on == true ? .unspecified : .invisible
    }
}
