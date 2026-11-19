import ChroDomain
import ChroServices
import SwiftUI

/// The code layout (the mock's `codeEditor`): file header with the Changes
/// toggle, find bar, and the editable highlighted text; Changes swaps the
/// editor for the split diff against the base version.
struct CodeFileView: View {
    let location: FileLocation
    let document: TextDocument
    let metrics: EditorMetrics
    @State private var showsChanges = false
    @State private var find = FindState()

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path) {
                IconButton(icon: .search, size: 19, label: "Find in file") { find.toggle() }
            }
            TextDocumentGate(document: document) {
                VStack(spacing: 0) {
                    let toggles = document.hasChanges || showsChanges
                    FileHeader(path: location.path, showsChanges: toggles, changesOn: showsChanges, onChanges: { showsChanges.toggle() })
                    if find.isOpen {
                        FileFindBar(query: $find.query, counter: find.counter, onPrevious: { find.step(-1) }, onNext: { find.step(1) }, onClose: { find.toggle() })
                    }
                    if showsChanges, let base = document.baseText {
                        ScrollView { CodeDiffView(path: location.path, old: base, new: document.text, layout: .split) }
                    } else {
                        CodeEditor(path: location.path, text: document.text, revision: document.externalRevision, metrics: metrics,
                                   decorations: CodeDecorations(changedLines: document.changedLines, focusLine: location.line,
                                                                findQuery: find.isOpen ? find.query : "", currentMatch: find.index),
                                   isEditable: document.isEditable,
                                   onEdit: { document.edit($0) },
                                   onFind: { find.open() },
                                   onMatchCount: { find.count = $0 })
                    }
                }
            }
        }
    }
}

/// Find-in-file state shared by the code and prose layouts.
struct FindState: Equatable {
    var isOpen = false
    var query = "" { didSet { if query != oldValue { index = 0 } } }
    var index = 0
    var count = 0

    var counter: String { FindInText.counter(index: count == 0 ? 0 : index % count, count: count, query: query) }

    mutating func toggle() {
        isOpen.toggle()
        if !isOpen { query = "" }
    }

    mutating func open() { isOpen = true }

    mutating func step(_ delta: Int) {
        guard count > 0 else { return }
        index = FindInText.step(index % count, by: delta, count: count)
    }
}
