import ChroDomain
import ChroServices
import Foundation
import Observation

/// One open text file (use-text-file-document.ts): loads it, saves edits
/// through `TextFileSaveModel` (2 s after the first unsaved edit, flushed on
/// leaving), re-reads it when the checkout changes and merges into unsaved
/// text, and keeps the change base the gutter and Changes view compare with.
@MainActor @Observable
final class TextDocument {
    enum Phase: Equatable {
        case loading
        case ready
        /// The server's text, shown in place of the editor (`workspaceError`).
        case failed(String)
    }

    let path: String
    let scope: CheckoutScope
    private(set) var phase: Phase = .loading
    /// The editor's text (unsaved edits included).
    private(set) var text = ""
    /// The text as last read from disk.
    private(set) var diskText: String?
    /// The server sent a preview of a file over 2 MiB: shown read-only, never saved.
    private(set) var truncated = false
    private(set) var size = 0
    private(set) var changeBase: ChangeBase = .unknown
    /// Bumped when disk text replaced the view's text, so editors re-seed their native views.
    private(set) var externalRevision = 0

    @ObservationIgnored private let editor: any EditorService
    @ObservationIgnored private let sourceControl: any SourceControlService
    @ObservationIgnored private var model: TextFileSaveModel!
    @ObservationIgnored private var follower: Task<Void, Never>?
    @ObservationIgnored var onSaveError: (String) -> Void = { _ in }
    @ObservationIgnored var onMerged: () -> Void = {}
    @ObservationIgnored var onUnexpected: (any Error) -> Void = { _ in }

    init(path: String, scope: CheckoutScope, editor: any EditorService, sourceControl: any SourceControlService) {
        self.path = path
        self.scope = scope
        self.editor = editor
        self.sourceControl = sourceControl
        model = TextFileSaveModel(write: { [weak self] text in
            guard let self else { return }
            _ = try await self.editor.write(self.path, content: text, in: self.scope)
        }, onSaveError: { [weak self] error in
            self?.onSaveError((error as? EditorError)?.message ?? error.localizedDescription)
        })
        model.onChange = { [weak self] in self?.syncFromModel() }
    }

    /// Text the editor can compare with for its change markers; nil while unknown.
    var baseText: String? { changeBase.text(disk: diskText) }
    var changedLines: Set<Int> { ChangeBase.changedLines(base: baseText, text: text) }
    /// The Changes toggle shows while the file differs from its base.
    var hasChanges: Bool { baseText.map { $0 != text } ?? false }
    var isEditable: Bool { phase == .ready && !truncated }

    /// Loads, then follows the checkout until cancelled.
    func run() async {
        await load()
        guard phase == .ready else { return }
        for await _ in sourceControl.updates(scope) {
            await refresh()
        }
    }

    func edit(_ newText: String) {
        guard isEditable, newText != text else { return }
        text = newText
        model.setViewData(newText)
    }

    /// Writes now and waits for the write (leaving the file, the app going to the background).
    func flush() async {
        await model.settled()
    }

    private func load() async {
        do {
            let file = try await editor.read(path, in: scope)
            truncated = file.truncated
            size = file.size
            diskText = file.content
            if file.truncated {
                text = file.content
            } else {
                model.applyDisk(file.content)
            }
            phase = .ready
        } catch let error as EditorError {
            phase = .failed(error.message)
        } catch {
            onUnexpected(error)
        }
    }

    private func refresh() async {
        await loadBase()
        guard !truncated, let file = try? await editor.read(path, in: scope), !file.truncated else { return }
        diskText = file.content
        if let applied = model.applyDisk(file.content) {
            text = applied.text
            externalRevision += 1
            if applied.merged { onMerged() }
        }
    }

    private func loadBase() async {
        let changes: [FileChange]?
        switch scope {
        case .run(let sessionID): changes = try? await sourceControl.runDiff(sessionID: sessionID)
        case .project: changes = try? await sourceControl.changes(scope, base: nil)
        }
        let entries = changes?.map { ChangeBase.Entry(path: $0.path, oldContent: $0.oldContent, isComparable: !$0.isBinary && !$0.contentOmitted) }
        changeBase = ChangeBase.resolve(path: path, entries: entries)
    }

    private func syncFromModel() {
        if model.text != text, model.loaded { text = model.text }
    }
}
