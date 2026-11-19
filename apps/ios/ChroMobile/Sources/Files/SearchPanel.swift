import ChroDomain
import ChroServices
import SwiftUI

/// The dock's Search files panel (search-panel.tsx): full-text search over
/// the project's main checkout with the content grammar, the operator list
/// and history while the field is empty, and `path:` / `file:` completion.
struct SearchPanel: View {
    let context: DockContext
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var state = FilesDockState.shared
    @State private var outcome: Outcome = .idle
    @State private var suggestions: [String] = []
    @State private var sortOpen = false
    @FocusState private var focused: Bool

    enum Outcome: Equatable {
        case idle
        case loading
        case failed(String)
        case loaded(FileSearchResults, needles: [String])
    }

    private var search: FilesDockState.SearchState { state.search(context.projectID) }
    private var query: Binding<String> {
        Binding(get: { search.query }, set: { value in state.updateSearch(context.projectID) { $0.query = value } })
    }
    private var trailing: FileSearchInput.TrailingOperator? { focused ? FileSearchInput.trailingOperator(search.query) : nil }
    private var navigator: FilesNavigator {
        FilesNavigator(context: context, sheets: sheets, router: router, external: external, services: services)
    }

    var body: some View {
        VStack(spacing: 0) {
            field
            if trailing != nil && !suggestions.isEmpty {
                suggestionPanel
                Spacer(minLength: 0)
            } else if focused && search.query.trimmingCharacters(in: .whitespaces).isEmpty {
                ScrollView { optionsPanel }.scrollIndicators(.hidden).keyboardOverlapMargin()
                    .accessibilityIdentifier("search-options")
            } else {
                results
            }
        }
        .task(id: SearchKey(query: search.query, matchCase: search.matchCase, sort: search.sort)) { await run() }
        .task(id: trailing) { await suggest() }
    }

    private struct SearchKey: Hashable {
        var query: String
        var matchCase: Bool
        var sort: FileSearchSort
    }

    // MARK: - Field (`.srch`)

    private var field: some View {
        HStack(spacing: 6) {
            Icon(.search, size: 15).foregroundStyle(Palette.t300)
            TextField("", text: query, prompt: Text("Search…").foregroundStyle(Palette.t300))
                .textStyle(TextStyle(size: 14))
                .foregroundStyle(Palette.fg)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.search)
                .onSubmit { state.remember(search.query) }
                .frame(height: 40)
                .accessibilityLabel("Search…")
            Button { state.updateSearch(context.projectID) { $0.matchCase.toggle() } } label: {
                Icon(.caseSensitive, size: 16)
                    .foregroundStyle(search.matchCase ? Palette.fg : Palette.t300)
                    .frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: 4).fill(search.matchCase ? Color(hex: 0x0C6CBE, opacity: 0.2) : .clear))
                    .contentShape(Rectangle().inset(by: -4))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Match case")
            .accessibilityAddTraits(search.matchCase ? [.isSelected, .isButton] : .isButton)
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(focused ? Palette.primary.opacity(0.4) : Palette.border))
        .padding(.horizontal, 10)
        .padding(.top, 8)
    }

    // MARK: - Focus panel (`.sopts`): options and history

    private var optionsPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Search options").textStyle(TextStyle(size: 12.5, weight: 500)).foregroundStyle(Palette.fg)
                .padding(.horizontal, 8).padding(.bottom, 6)
            ForEach(FileSearchInput.options, id: \.token) { option in
                let row = HStack(spacing: 8) {
                    CodeChip(text: option.token)
                    Text(option.description).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .textStyle(TextStyle(size: 12.5))
                .foregroundStyle(Palette.t300)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                if let insert = option.insert {
                    Button { query.wrappedValue = FileSearchInput.insert(insert, into: search.query) } label: { row }
                        .buttonStyle(PressableStyle(cornerRadius: 4))
                        .accessibilityLabel("\(option.token) \(option.description)")
                } else {
                    row.accessibilityElement(children: .combine)
                }
            }
            if !state.history.isEmpty {
                Rectangle().fill(Palette.border).frame(height: 1).padding(.top, 6)
                HStack {
                    Text("History").textStyle(TextStyle(size: 12.5, weight: 500)).foregroundStyle(Palette.fg)
                    Spacer(minLength: 0)
                    Button { state.history = [] } label: {
                        Icon(.x, size: 13).foregroundStyle(Palette.t300).frame(width: 44, height: 32).contentShape(Rectangle().inset(by: -6))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear history")
                }
                .padding(.leading, 8)
                .padding(.top, 6)
                ForEach(state.history, id: \.self) { entry in
                    Button { query.wrappedValue = entry } label: {
                        Text(entry).textStyle(.code(11.5)).foregroundStyle(Palette.t300).lineLimit(1)
                            .padding(.horizontal, 8)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableStyle(cornerRadius: 4))
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 6).surface(Palette.bg, elevation: .raised))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 12)
    }

    // MARK: - Completion

    private var suggestionPanel: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(suggestions, id: \.self) { value in
                    Button {
                        if let active = FileSearchInput.trailingOperator(search.query) {
                            query.wrappedValue = FileSearchInput.complete(search.query, operator: active, with: value)
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Icon(.fileText, size: 14).opacity(0.5)
                            Text(value).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 0)
                        }
                        .textStyle(TextStyle(size: 12.5))
                        .foregroundStyle(Palette.t300)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableStyle(cornerRadius: 4))
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 6).surface(Palette.bg, elevation: .raised))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
            .padding(.horizontal, 10)
            .padding(.top, 4)
        }
        .scrollIndicators(.hidden)
        .keyboardOverlapMargin()
    }

    private func suggest() async {
        guard let active = trailing else { suggestions = []; return }
        let field: FileSearchInput.Field = active.field
        if active.partial.isEmpty {
            // Top-level entries of the loaded tree (instant).
            let top = ((try? await services.files.entries(.project(id: context.projectID))) ?? [])
                .filter { !$0.path.contains("/") && (field == .path || !$0.isDirectory) }
                .sorted { FileTreeEntrySort.order($0, $1) }
                .prefix(FileSearchInput.suggestionLimit)
            suggestions = top.map { field == .file ? $0.name : $0.path }
            return
        }
        try? await Task.sleep(for: .milliseconds(120))
        guard !Task.isCancelled else { return }
        let hits = (try? await services.files.searchNames(projectID: context.projectID, query: active.partial, limit: 60)) ?? []
        guard !Task.isCancelled else { return }
        suggestions = FileSearchInput.suggestions(field, partial: active.partial, from: hits.map { ($0.path, $0.isFile) })
    }

    // MARK: - Results

    @ViewBuilder private var results: some View {
        switch outcome {
        case .idle:
            SheetHint(text: "Type to search.")
            Spacer(minLength: 0)
        case .loading:
            HStack(spacing: 6) {
                Spinner(size: 12)
                Text("Searching…")
            }
            .textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
            .padding(.vertical, 14)
            Spacer(minLength: 0)
        case .failed(let message):
            Text(message).textStyle(TextStyle(size: 13)).foregroundStyle(Palette.red500)
                .multilineTextAlignment(.center).padding(.horizontal, 16).padding(.vertical, 14)
            Spacer(minLength: 0)
        case .loaded(let found, let needles):
            if found.hits.isEmpty {
                SheetHint(text: "No matches found.")
                Spacer(minLength: 0)
            } else {
                summary(found)
                if sortOpen { sortList }
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(found.hits) { hit in
                            if hit.lines.isEmpty {
                                NameResultRow(path: hit.path, needles: needles) { open(hit.path, line: nil) }
                            } else {
                                group(hit)
                            }
                        }
                    }
                    .padding(.bottom, 12)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.immediately)
                .keyboardOverlapMargin()
            }
        }
    }

    /// `.ssum`: totals, Expand/Collapse all, and the sort order.
    private func summary(_ found: FileSearchResults) -> some View {
        let groups = found.hits.filter { !$0.lines.isEmpty }.map(\.path)
        return HStack(spacing: 8) {
            Text(FileSearchInput.summary(files: found.totalFiles, matches: found.totalLineMatches, shown: found.hits.count, truncated: found.truncated))
                .lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                if !groups.isEmpty {
                    Button(search.collapsed.isEmpty ? "Collapse all" : "Expand all") {
                        state.updateSearch(context.projectID) { $0.collapsed = $0.collapsed.isEmpty ? Set(groups) : [] }
                    }
                    .padding(.horizontal, 6).frame(height: 44)
                }
                Button { sortOpen.toggle() } label: {
                    HStack(spacing: 4) {
                        Icon(.arrowDownUp, size: 12)
                        Text(search.sort.label).lineLimit(1)
                    }
                    .padding(.horizontal, 6).frame(height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Sort order")
                .accessibilityValue(search.sort.label)
            }
            .buttonStyle(.plain)
        }
        .textStyle(TextStyle(size: 12.5))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private var sortList: some View {
        VStack(spacing: 0) {
            ForEach(FileSearchSort.allCases, id: \.self) { sort in
                Button {
                    state.updateSearch(context.projectID) { $0.sort = sort }
                    sortOpen = false
                } label: {
                    HStack {
                        Text(sort.label)
                        Spacer(minLength: 0)
                        if search.sort == sort { Icon(.check, size: 14) }
                    }
                    .textStyle(TextStyle(size: 12.5))
                    .foregroundStyle(Palette.fg)
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(cornerRadius: 4))
                .accessibilityAddTraits(search.sort == sort ? .isSelected : [])
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 6).surface(Palette.bg, elevation: .raised))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.border))
        .padding(.horizontal, 10)
    }

    /// `.sgrp` and its `.sline` rows, as one lazy-stack child (line numbers repeat across files).
    private func group(_ hit: FileSearchHit) -> some View {
        let collapsed = search.collapsed.contains(hit.path)
        return VStack(spacing: 0) {
            Button {
                state.updateSearch(context.projectID) { if collapsed { $0.collapsed.remove(hit.path) } else { $0.collapsed.insert(hit.path) } }
            } label: {
                HStack(spacing: 6) {
                    Icon(collapsed ? .chevronRight : .chevronDown, size: 14).opacity(0.6)
                    Icon(.fileText, size: 14).opacity(0.6)
                    Text(FileTreeEntry(path: hit.path, isDirectory: false).name)
                        .textStyle(TextStyle(size: 13.5, weight: 500)).foregroundStyle(Palette.fg).lineLimit(1).layoutPriority(1)
                    Text(hit.path).textStyle(TextStyle(size: 11.5)).foregroundStyle(Palette.t300).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    Text("\(hit.lines.count)").textStyle(TextStyle(size: 11.5, tabular: true)).foregroundStyle(Palette.t300)
                        .padding(.horizontal, 6)
                        .background(Capsule().fill(Color(hex: 0x17181B, opacity: 0.1)))
                }
                .foregroundStyle(Palette.t300)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(cornerRadius: 0))
            .accessibilityLabel(hit.path)
            .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
            if !collapsed {
                ForEach(hit.lines) { line in
                    Button { open(hit.path, line: line.lineNumber) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(line.lineNumber)").textStyle(TextStyle(size: 11.5, tabular: true)).foregroundStyle(Palette.t300)
                                .frame(width: 30, alignment: .trailing)
                            Text(highlighted(line.text, line.ranges, mono: true, dynamicTypeSize: dynamicTypeSize))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.leading, 40).padding(.trailing, 14).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableStyle(cornerRadius: 0))
                    .accessibilityLabel("\(hit.path) line \(line.lineNumber): \(line.text)")
                }
            }
        }
    }

    private func open(_ path: String, line: Int?) {
        state.remember(search.query)
        navigator.openFile(path, line: line)
    }

    private func run() async {
        let raw = search.query
        guard !raw.trimmingCharacters(in: .whitespaces).isEmpty else { outcome = .idle; return }
        try? await Task.sleep(for: .milliseconds(200))
        guard !Task.isCancelled else { return }
        outcome = .loading
        do {
            let found = try await services.files.searchContent(projectID: context.projectID, query: raw, matchCase: search.matchCase,
                                                               sort: search.sort, limit: FileSearchInput.resultLimit)
            guard !Task.isCancelled else { return }
            state.updateSearch(context.projectID) { $0.collapsed = [] }
            outcome = .loaded(found, needles: FileSearchInput.plainNeedles(raw))
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            outcome = .failed((error as? ServiceError)?.message ?? "Search failed")
        }
    }
}

/// Folders first, then by path (the tree's order) for the instant suggestions.
private enum FileTreeEntrySort {
    static func order(_ a: FileTreeEntry, _ b: FileTreeEntry) -> Bool {
        a.isDirectory != b.isDirectory ? a.isDirectory : a.path.localizedCompare(b.path) == .orderedAscending
    }
}

/// A file matched by name only: icon, highlighted name and path.
private struct NameResultRow: View {
    let path: String
    let needles: [String]
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let name = FileTreeEntry(path: path, isDirectory: false).name
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Icon(.fileText, size: 14).opacity(0.6).padding(.top, 2)
                VStack(alignment: .leading, spacing: 0) {
                    Text(highlighted(name, FileSearchInput.needleRanges(in: name, needles: needles), base: Palette.fg, size: 13.5, dynamicTypeSize: dynamicTypeSize))
                        .lineLimit(1)
                    Text(highlighted(path, FileSearchInput.needleRanges(in: path, needles: needles), base: Palette.t300, size: 11.5, dynamicTypeSize: dynamicTypeSize))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(cornerRadius: 0))
        .accessibilityLabel(path)
    }
}

/// `code` in the options list.
private struct CodeChip: View {
    let text: String

    var body: some View {
        Text(text)
            .textStyle(.code(11.5))
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 4)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color(hex: 0x17181B, opacity: 0.1)))
    }
}

/// Text with `mark.hl` ranges (UTF-16 offsets): a primary tint behind the match, foreground text.
@MainActor
private func highlighted(_ text: String, _ ranges: [Range<Int>], mono: Bool = false, base: Color = Palette.t300, size: CGFloat = 12,
                         dynamicTypeSize: DynamicTypeSize) -> AttributedString {
    var attributed = AttributedString(text)
    attributed.font = (mono ? TextStyle.code(size) : TextStyle(size: size)).font(dynamicTypeSize)
    attributed.foregroundColor = base
    let utf16 = text.utf16
    for range in ranges {
        guard range.lowerBound >= 0, range.upperBound <= utf16.count,
              let lower = String.Index(utf16.index(utf16.startIndex, offsetBy: range.lowerBound), within: text),
              let upper = String.Index(utf16.index(utf16.startIndex, offsetBy: range.upperBound), within: text),
              let from = AttributedString.Index(lower, within: attributed),
              let to = AttributedString.Index(upper, within: attributed) else { continue }
        attributed[from..<to].backgroundColor = Color(hex: 0x0C6CBE, opacity: 0.25)
        attributed[from..<to].foregroundColor = Palette.fg
    }
    return attributed
}
