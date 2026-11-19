import Foundation

/// Save state of one open text document, independent of any view
/// (files/lib/text-file-model.ts):
///
/// - The first unsaved edit schedules a save `saveDelay` later; further edits
///   do not push it back, so continuous typing still saves regularly.
/// - Only one write is in flight; an edit during a write queues exactly one
///   follow-up save with the latest text.
/// - A failed write leaves the text unsaved and reports the error.
/// - A disk read replaces clean text, merges into unsaved text, and is
///   ignored while our own write is in flight.
@MainActor
public final class TextFileSaveModel {
    public static let saveDelay: Duration = .milliseconds(2000)

    /// What the view should display after a disk read.
    public struct DiskApply: Equatable, Sendable {
        public var text: String
        public var merged: Bool

        public init(text: String, merged: Bool) {
            self.text = text
            self.merged = merged
        }
    }

    private var viewData: String?
    private var lastSaved: String?
    private var isSaving = false
    private var saveAgain = false
    private var timer: Task<Void, Never>?
    private var inFlight: Task<Void, Never>?
    private let write: @MainActor (String) async throws -> Void
    private let sleep: @MainActor (Duration) async throws -> Void
    private let onSaveError: @MainActor (Error) -> Void
    /// Called on every state change (text, saving, unsaved).
    public var onChange: @MainActor () -> Void = {}

    public init(write: @escaping @MainActor (String) async throws -> Void,
                sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
                onSaveError: @escaping @MainActor (Error) -> Void = { _ in }) {
        self.write = write
        self.sleep = sleep
        self.onSaveError = onSaveError
    }

    public var text: String { viewData ?? lastSaved ?? "" }
    public var loaded: Bool { lastSaved != nil }
    public var unsaved: Bool { lastSaved != nil && viewData != nil && viewData != lastSaved }
    public var saving: Bool { isSaving }
    /// Nothing scheduled or being written.
    public var idle: Bool { timer == nil && !isSaving }

    /// Records a user edit and schedules the automatic save.
    public func setViewData(_ text: String) {
        guard text != viewData else { return }
        viewData = text
        scheduleSave()
        onChange()
    }

    /// Reconciles the document with freshly read disk content; nil when the view keeps its text.
    @discardableResult
    public func applyDisk(_ disk: String) -> DiskApply? {
        guard let base = lastSaved else {
            lastSaved = disk
            if viewData == nil { viewData = disk }
            if unsaved { scheduleSave() }
            onChange()
            return DiskApply(text: text, merged: false)
        }
        if isSaving { return nil }
        lastSaved = disk
        if base == disk { return nil }
        let mine = viewData ?? base
        if mine == disk {
            onChange()
            return nil
        }
        if mine != base {
            let merged = TextMerge.merge(base: base, mine: mine, theirs: disk)
            viewData = merged
            onChange()
            return DiskApply(text: merged, merged: true)
        }
        viewData = disk
        onChange()
        return DiskApply(text: disk, merged: false)
    }

    /// Writes the current text now; returns when this attempt (and a queued follow-up) finished.
    public func save() async {
        cancelTimer()
        if isSaving {
            saveAgain = true
            await inFlight?.value
            return
        }
        guard let data = viewData, let previous = lastSaved, data != previous else { return }
        lastSaved = data
        isSaving = true
        onChange()
        let attempt = Task { @MainActor in
            do {
                try await write(data)
            } catch {
                if lastSaved == data { lastSaved = previous }
                onSaveError(error)
            }
            isSaving = false
            inFlight = nil
            onChange()
        }
        inFlight = attempt
        await attempt.value
        if saveAgain {
            saveAgain = false
            await save()
        }
    }

    /// Flushes a pending save and waits until no write is in flight
    /// (leaving the file, the app going to the background).
    public func settled() async {
        if timer != nil || unsaved { await save() }
        while let running = inFlight { await running.value }
        if saveAgain || (unsaved && !isSaving && timer != nil) { await save() }
    }

    private func scheduleSave() {
        guard timer == nil else { return }
        timer = Task { @MainActor [weak self] in
            guard let self else { return }
            do { try await self.sleep(Self.saveDelay) } catch { return }
            guard !Task.isCancelled else { return }
            self.timer = nil
            await self.save()
        }
    }

    private func cancelTimer() {
        timer?.cancel()
        timer = nil
    }
}

/// Three-way merge of whole lines: replays the local edit (base → mine) onto
/// the external version (base → theirs). Where both changed the same lines,
/// the local edit wins; insertions at the same point keep both, external first.
public enum TextMerge {
    private struct Edit {
        var start: Int
        var end: Int
        var lines: [String]
    }

    public static func merge(base: String, mine: String, theirs: String) -> String {
        if mine == base { return theirs }
        if theirs == base || theirs == mine { return mine }
        let baseLines = base.components(separatedBy: "\n")
        let ours = edits(baseLines, mine.components(separatedBy: "\n"))
        let others = edits(baseLines, theirs.components(separatedBy: "\n")).filter { edit in
            !ours.contains { conflicts(edit, $0) }
        }
        // Insertions before replacements at the same line; external before local.
        let ordered = (others.map { ($0, 0) } + ours.map { ($0, 1) }).sorted { a, b in
            if a.0.start != b.0.start { return a.0.start < b.0.start }
            let aReplaces = a.0.end > a.0.start, bReplaces = b.0.end > b.0.start
            if aReplaces != bReplaces { return !aReplaces }
            return a.1 < b.1
        }
        var output: [String] = []
        var position = 0
        for (edit, _) in ordered {
            if edit.start > position { output += baseLines[position..<edit.start] }
            output += edit.lines
            position = max(position, edit.end)
        }
        if position < baseLines.count { output += baseLines[position...] }
        return output.joined(separator: "\n")
    }

    /// Both sides changed the same base lines (an insertion conflicts only strictly inside a replacement).
    private static func conflicts(_ a: Edit, _ b: Edit) -> Bool {
        let aReplaces = a.end > a.start, bReplaces = b.end > b.start
        switch (aReplaces, bReplaces) {
        case (true, true): return a.start < b.end && b.start < a.end
        case (true, false): return a.start < b.start && b.start < a.end
        case (false, true): return b.start < a.start && a.start < b.end
        case (false, false): return false
        }
    }

    /// Changed regions of `base` with their replacement lines.
    private static func edits(_ base: [String], _ changed: [String]) -> [Edit] {
        var result: [Edit] = []
        var current: Edit?
        var basePosition = 0
        for operation in LineDiff.compute(old: base, new: changed) {
            switch operation {
            case .context:
                if let edit = current { result.append(edit); current = nil }
                basePosition += 1
            case .added(let line):
                if current == nil { current = Edit(start: basePosition, end: basePosition, lines: []) }
                current?.lines.append(changed[line - 1])
            case .removed:
                if current == nil { current = Edit(start: basePosition, end: basePosition, lines: []) }
                basePosition += 1
                current?.end = basePosition
            }
        }
        if let edit = current { result.append(edit) }
        return result
    }
}
