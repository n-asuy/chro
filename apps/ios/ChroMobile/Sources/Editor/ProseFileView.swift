import ChroDomain
import ChroServices
import SwiftUI

/// The prose layout of Markdown and text (the mock's `proseEditor`, the
/// desktop's live-preview editor): the title that renames the file, the
/// frontmatter properties, and the body where each line renders until it is
/// tapped, then edits as its Markdown source.
struct ProseFileView: View {
    let location: FileLocation
    let document: TextDocument
    let metrics: EditorMetrics
    @Environment(\.panelServices) private var services
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @State private var find = FindState()
    @State private var source = false
    @State private var focus: ProseFocus?
    @State private var title = ""
    @State private var titleError: String?
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path) {
                IconButton(icon: .search, size: 19, label: "Find in file") { find.toggle() }
            }
            TextDocumentGate(document: document) {
                VStack(spacing: 0) {
                    if find.isOpen {
                        FileFindBar(query: $find.query, counter: find.counter, onPrevious: { find.step(-1) }, onNext: { find.step(1) }, onClose: { find.toggle() })
                    }
                    if source {
                        sourceLayout
                    } else {
                        ScrollViewReader { proxy in
                            ScrollView { prose }
                                .scrollDismissesKeyboard(.interactively)
                                .onAppear { if let line = location.line { proxy.scrollTo(line - 1, anchor: .center) } }
                                .onChange(of: find.index) { _, _ in if let line = currentFindLine { proxy.scrollTo(line, anchor: .center) } }
                                .onChange(of: find.query) { _, _ in if let line = currentFindLine { proxy.scrollTo(line, anchor: .center) } }
                        }
                    }
                }
            }
        }
        .onAppear { title = FilePath.stem(location.path) }
        .onChange(of: findCount) { _, count in find.count = count }
    }

    private var lines: [String] { document.text.components(separatedBy: "\n") }
    private var frontmatter: Frontmatter.Document { Frontmatter.parse(lines) }
    private var canRename: Bool { location.sessionID == nil }

    // MARK: Prose

    private var prose: some View {
        let lines = self.lines
        let fm = Frontmatter.parse(lines)
        let changed = document.changedLines
        return VStack(alignment: .leading, spacing: 0) {
            titleField
            PropertiesBlock(document: document, source: $source)
                .padding(.top, 12)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(fm.bodyStart..<max(fm.bodyStart, lines.count), id: \.self) { index in
                    line(index, text: lines[index], changed: changed.contains(index + 1))
                        .id(index)
                }
            }
            .padding(.top, 16)
        }
        .padding(.horizontal, 16)
        .padding(.top, 24)
        .padding(.bottom, 60)
        .environment(\.openURL, OpenURLAction { url in handle(url) })
    }

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("", text: $title)
                .textStyle(TextStyle(size: 20, weight: 600))
                .foregroundStyle(titleError == nil ? Palette.fg : Palette.destructive)
                .disabled(!canRename || !document.isEditable)
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit { Task { await rename() } }
                .onChange(of: titleFocused) { _, focused in if !focused { Task { await rename() } } }
                .onChange(of: title) { _, _ in if titleError != nil, titleFocused { titleError = nil } }
                .padding(.vertical, 2)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(titleError != nil ? Palette.destructive : (titleFocused ? Color(hex: 0x299AD6) : .clear)).frame(height: 1)
                }
                .accessibilityLabel("Document title")
            if let titleError {
                Text(titleError).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.destructive)
            }
        }
    }

    @ViewBuilder private func line(_ index: Int, text: String, changed: Bool) -> some View {
        Group {
            if focus?.line == index {
                ProseLineField(text: text, caret: focus?.caret ?? text.count, fontSize: metrics.fontSize, lineHeight: metrics.lineHeight,
                               onChange: { setLine(index, $0) },
                               onReturn: { current, caret in split(index, current, caret) },
                               onBackspaceAtStart: { current in join(index, current) },
                               onEnd: { current in
                                   setLine(index, current)
                                   if focus?.line == index { focus = nil }
                               })
            } else {
                ProseLineView(line: text, metrics: metrics, find: find.isOpen ? find.query : "",
                              currentMatch: currentMatch(in: index), onToggleTask: { toggleTask(index) })
                    .contentShape(Rectangle())
                    .onTapGesture { if document.isEditable { focus = ProseFocus(line: index, caret: text.count) } }
            }
        }
        .frame(maxWidth: .infinity, minHeight: metrics.fontSize * metrics.lineHeight, alignment: .leading)
        .background(alignment: .leading) {
            if changed {
                Rectangle().fill(Color(red: 46 / 255, green: 160 / 255, blue: 67 / 255).opacity(0.5))
                    .frame(width: 3).padding(.vertical, 7).offset(x: -3)
            }
        }
        .background(location.line == index + 1 ? Color(hex: 0x0C6CBE).opacity(0.08) : .clear)
    }

    // MARK: Source

    private var sourceLayout: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Properties (Source)").textStyle(TextStyle(size: 12.5, weight: 500)).foregroundStyle(Palette.t300).padding(.horizontal, 6)
                Spacer(minLength: 0)
                IconButton(icon: .layoutList, size: 16, label: "Switch to UI view") { source = false }
            }
            .padding(.horizontal, 16)
            CodeEditor(path: location.path, text: document.text, revision: document.externalRevision, metrics: metrics,
                       decorations: CodeDecorations(changedLines: document.changedLines, findQuery: find.isOpen ? find.query : "", currentMatch: find.index),
                       isEditable: document.isEditable, onEdit: { document.edit($0) }, onFind: { find.open() }, onMatchCount: { find.count = $0 })
        }
    }

    // MARK: Find

    /// Matches in the rendered body lines (the mock highlights the rendered text).
    private var findMatches: [(line: Int, count: Int)] {
        guard find.isOpen, !find.query.isEmpty else { return [] }
        let lines = self.lines
        let fm = Frontmatter.parse(lines)
        return (fm.bodyStart..<max(fm.bodyStart, lines.count)).compactMap { index in
            let count = ProseLineView.matchCount(of: find.query, in: lines[index])
            return count > 0 ? (index, count) : nil
        }
    }

    private var findCount: Int { source ? find.count : findMatches.reduce(0) { $0 + $1.count } }

    private var currentFindLine: Int? {
        guard find.count > 0 else { return nil }
        var remaining = find.index % find.count
        for entry in findMatches {
            if remaining < entry.count { return entry.line }
            remaining -= entry.count
        }
        return nil
    }

    private func currentMatch(in line: Int) -> Int? {
        guard find.count > 0 else { return nil }
        var remaining = find.index % find.count
        for entry in findMatches {
            if remaining < entry.count { return entry.line == line ? remaining : nil }
            remaining -= entry.count
        }
        return nil
    }

    // MARK: Editing

    private func setLine(_ index: Int, _ text: String) {
        var lines = self.lines
        guard lines.indices.contains(index), lines[index] != text else { return }
        lines[index] = text
        document.edit(lines.joined(separator: "\n"))
    }

    private func split(_ index: Int, _ current: String, _ caret: Int) {
        var lines = self.lines
        guard lines.indices.contains(index) else { return }
        lines[index] = current
        let result = ProseEditing.split(lines: lines, line: index, offset: caret)
        document.edit(result.lines.joined(separator: "\n"))
        focus = ProseFocus(line: result.line, caret: result.offset)
    }

    private func join(_ index: Int, _ current: String) {
        var lines = self.lines
        guard lines.indices.contains(index), index > frontmatter.bodyStart else { return }
        lines[index] = current
        let result = ProseEditing.join(lines: lines, line: index)
        document.edit(result.lines.joined(separator: "\n"))
        focus = ProseFocus(line: result.line, caret: result.offset)
    }

    private func toggleTask(_ index: Int) {
        guard document.isEditable else { return }
        let lines = self.lines
        guard lines.indices.contains(index) else { return }
        setLine(index, ProseEditing.toggleTask(lines[index]))
    }

    private func handle(_ url: URL) -> OpenURLAction.Result {
        guard url.scheme == ProseLineView.wikilinkScheme else { return .systemAction }
        let target = url.host(percentEncoded: false) ?? ""
        Task {
            let scope = document.scope
            if let path = try? await services.editor.resolve(target, in: scope) {
                router.push(.panel(.file(FileLocation(projectID: location.projectID, sessionID: location.sessionID, path: path))))
            }
        }
        return .handled
    }

    /// files-editor.tsx `commitTitleChange`: required, unchanged is a no-op, else rename the file.
    private func rename() async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = FilePath.stem(location.path)
        guard canRename else { return }
        guard !trimmed.isEmpty else {
            titleError = "Title is required"
            title = current
            return
        }
        guard trimmed != current else { titleError = nil; return }
        let target = FilePath.renamed(location.path, stem: trimmed)
        await document.flush()
        do {
            try await services.files.rename(projectID: location.projectID, from: location.path, to: target)
            titleError = nil
            router.replaceTop(with: .panel(.file(FileLocation(projectID: location.projectID, sessionID: nil, path: target))))
        } catch {
            titleError = (error as? ServiceError)?.message ?? "Failed to rename file"
            title = current
        }
    }
}

struct ProseFocus: Equatable {
    var line: Int
    var caret: Int
}

/// One rendered prose line (the mock's `proseLine`).
struct ProseLineView: View {
    static let wikilinkScheme = "chro-note"

    let line: String
    let metrics: EditorMetrics
    let find: String
    /// Index among this line's matches of the current find match.
    let currentMatch: Int?
    let onToggleTask: () -> Void

    var body: some View {
        let size = metrics.fontSize
        switch ProseBlock(line: line) {
        case .heading(let level, let text):
            let scale: CGFloat = level == 1 ? 1.85 : 1.45
            Text(rendered(text, size: size * scale, weight: level == 1 ? 700 : 600))
                .lineSpacing(0)
                .padding(.top, size * scale * (level == 1 ? 0.3 : 0.4))
                .padding(.bottom, size * scale * (level == 1 ? 0.2 : 0.1))
                .accessibilityAddTraits(.isHeader)
        case .task(let checked, let text):
            HStack(alignment: .top, spacing: 0) {
                Button(action: onToggleTask) {
                    CheckboxMark(isOn: checked, side: 16, tick: 11, cornerRadius: 3, offStroke: Palette.t300, lineWidth: 1.5)
                        .frame(width: 22, height: size * metrics.lineHeight)
                        .contentShape(Rectangle().inset(by: -11))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Toggle task")
                .accessibilityValue(checked ? "checked" : "unchecked")
                Text(rendered(text, size: size, color: checked ? Palette.t300 : Palette.fg, strike: checked))
                    .lineSpacing(lineSpacing(size))
            }
        case .bullet(let text):
            listItem(marker: "•", markerX: 6, text: text)
        case .ordered(let number, let text):
            listItem(marker: "\(number).", markerX: 0, text: text)
        case .paragraph(let text):
            Text(rendered(text, size: size)).lineSpacing(lineSpacing(size))
        }
    }

    private func listItem(marker: String, markerX: CGFloat, text: String) -> some View {
        Text(rendered(text, size: metrics.fontSize))
            .lineSpacing(lineSpacing(metrics.fontSize))
            .padding(.leading, 22)
            .overlay(alignment: .topLeading) {
                Text(marker).font(Font(Typography.uiFont(size: metrics.fontSize))).foregroundStyle(Palette.t300).offset(x: markerX)
            }
    }

    private func lineSpacing(_ size: CGFloat) -> CGFloat {
        max(0, size * metrics.lineHeight - Typography.uiFont(size: size).lineHeight)
    }

    /// Inline Markdown as attributed text: code, bold, italic, strike, highlight, links.
    private func rendered(_ text: String, size: CGFloat, weight: CGFloat = 400, color: Color = Palette.fg, strike: Bool = false) -> AttributedString {
        var output = AttributedString()
        for span in ProseInline.parse(text) {
            var part: AttributedString
            switch span {
            case .text(let value): part = AttributedString(value)
            case .code(let value):
                part = AttributedString(value)
                part.font = Font(EditorFont.mono(size * 0.86))
                part.backgroundColor = Palette.muted
            case .bold(let value):
                part = AttributedString(value)
                part.font = Font(Typography.uiFont(size: size, weight: max(weight, 700)))
            case .italic(let value):
                part = AttributedString(value)
                part.font = Font(Typography.uiFont(size: size, weight: weight)).italic()
            case .strike(let value):
                part = AttributedString(value)
                part.strikethroughStyle = .single
            case .highlight(let value):
                part = AttributedString(value)
                part.backgroundColor = Color(red: 250 / 255, green: 204 / 255, blue: 21 / 255).opacity(0.45)
            case .wikilink(let target, let label):
                part = AttributedString(label)
                part.foregroundColor = Palette.blue600
                var components = URLComponents()
                components.scheme = Self.wikilinkScheme
                components.host = target
                part.link = components.url
            case .link(let label, let url):
                part = AttributedString(label)
                part.foregroundColor = Palette.blue600
                part.link = URL(string: url)
            case .url(let value):
                part = AttributedString(value + " \u{2197}\u{FE0E}")
                part.foregroundColor = Palette.blue600
                part.link = URL(string: value)
            }
            if part.font == nil { part.font = Font(Typography.uiFont(size: size, weight: weight)) }
            if part.foregroundColor == nil { part.foregroundColor = color }
            if strike { part.strikethroughStyle = .single }
            output += part
        }
        if output.characters.isEmpty { output = AttributedString(" ") }
        highlightMatches(in: &output)
        return output
    }

    private func highlightMatches(in text: inout AttributedString) {
        guard !find.isEmpty else { return }
        let plain = String(text.characters)
        var search = plain.startIndex..<plain.endIndex
        var index = 0
        while let found = plain.range(of: find, options: .caseInsensitive, range: search), !found.isEmpty {
            let lower = plain.distance(from: plain.startIndex, to: found.lowerBound)
            let length = plain.distance(from: found.lowerBound, to: found.upperBound)
            let start = text.index(text.startIndex, offsetByCharacters: lower)
            let end = text.index(start, offsetByCharacters: length)
            text[start..<end].backgroundColor = index == currentMatch
                ? Color(red: 249 / 255, green: 115 / 255, blue: 22 / 255).opacity(0.55)
                : Color(red: 250 / 255, green: 204 / 255, blue: 21 / 255).opacity(0.45)
            index += 1
            search = found.upperBound..<plain.endIndex
        }
    }

    /// How many find matches a line's rendered text has.
    static func matchCount(of query: String, in line: String) -> Int {
        guard !query.isEmpty else { return 0 }
        let text: String
        switch ProseBlock(line: line) {
        case .heading(_, let value), .task(_, let value), .bullet(let value), .ordered(_, let value), .paragraph(let value): text = value
        }
        let plain = ProseInline.parse(text).map { span -> String in
            switch span {
            case .text(let value), .code(let value), .bold(let value), .italic(let value), .strike(let value), .highlight(let value): value
            case .wikilink(_, let label), .link(let label, _): label
            case .url(let value): value + " \u{2197}\u{FE0E}"
            }
        }.joined()
        var count = 0
        var search = plain.startIndex..<plain.endIndex
        while let found = plain.range(of: query, options: .caseInsensitive, range: search), !found.isEmpty {
            count += 1
            search = found.upperBound..<plain.endIndex
        }
        return count
    }
}
