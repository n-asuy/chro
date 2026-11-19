import ChroAPI
import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// What the timeline asks its screen to do.
struct TimelineActions {
    var openSession: (String) -> Void
    /// "Continue in a new session from here"; nil where the session cannot continue.
    var continueFromRun: ((String) -> Void)?
    var viewImage: (_ name: String, _ path: String) -> Void
}

/// The conversation (conversation-view.tsx): one section per user turn, its
/// prompt pinned while the turn's response scrolls under it.
struct ConversationTimeline: View {
    @Bindable var model: SessionModel
    let session: SessionSummary
    let conversation: SessionConversation
    let actions: TimelineActions
    /// Lines a collapsed prompt keeps: one when the visible conversation is too short for two.
    var promptLines = 2
    @Environment(WorkspaceStore.self) private var store

    /// The gutter sits inside every row, so a pinned prompt's background spans the full width.
    static let gutter: CGFloat = 12

    var body: some View {
        let turns = ConversationLayout.turns(conversation.entries, approvalOnCard: approvalOnCard)
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            if conversation.hasEarlierHistory {
                // conversation-view.tsx history loader.
                Button { model.loadEarlierHistory() } label: {
                    Text(model.isLoadingEarlier ? "Loading earlier history..." : "Load earlier history")
                        .textStyle(TextStyle(size: 13, weight: 500))
                        .foregroundStyle(Palette.t300)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle())
                .disabled(model.isLoadingEarlier)
                .opacity(model.isLoadingEarlier ? 0.5 : 1)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 16)
            }
            if let origin = conversation.continuation {
                if let inherited = origin.nativeEntries {
                    ForEach(ConversationLayout.turns(inherited)) { turn in
                        turnSection(turn, showsActions: false, isInherited: true)
                    }
                } else if case .digest(let user, let assistant) = origin.history {
                    DigestSummary(user: user, assistant: assistant).padding(.horizontal, Self.gutter)
                }
                ForkBoundary(origin: origin) { actions.openSession(origin.sourceSessionID) }.padding(.horizontal, Self.gutter)
            }
            ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                turnSection(turn, showsActions: ConversationLayout.showsMessageActions(turnIndex: index, turnCount: turns.count, isRunning: session.isRunning))
            }
        }
        .padding(.bottom, 16)
    }

    /// The MCP approval the card under the conversation is answering.
    private var approvalOnCard: String? {
        if case .mcp(let id, _)? = conversation.pendingApproval { return id }
        return nil
    }

    /// An inherited turn is dimmed in its body only: a translucent pinned prompt would show the rows scrolling under it.
    @ViewBuilder private func turnSection(_ turn: ConversationTurn, showsActions: Bool, isInherited: Bool = false) -> some View {
        Section {
            ForEach(turn.segments) { segment in
                segmentView(segment, in: turn, showsActions: showsActions)
                    .padding(.horizontal, Self.gutter)
                    .opacity(isInherited ? 0.8 : 1)
            }
        } header: {
            if let prompt = turn.prompt {
                PromptCard(model: model, entry: prompt, highlight: highlight(for: prompt.id), collapsedLines: promptLines, isDimmed: isInherited,
                           viewImage: actions.viewImage)
                    .id(prompt.id)
            }
        }
    }

    private func highlight(for entryID: String) -> FindHighlight? {
        guard model.isFinding, !model.findQuery.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let active = model.activeMatch
        return FindHighlight(query: model.findQuery, activeLocalIndex: active?.entryID == entryID ? active?.localIndex : nil)
    }

    @ViewBuilder private func segmentView(_ segment: ConversationSegment, in turn: ConversationTurn, showsActions: Bool) -> some View {
        switch segment {
        case .steps(let steps):
            StepsView(model: model, steps: steps, pendingApprovalID: conversation.pendingApproval?.approvalID)
                .padding(.bottom, 8)
                .id(steps.id)
        case .entry(let entry):
            VStack(alignment: .leading, spacing: 0) {
                EntryView(entry: entry, highlight: highlight(for: entry.id))
                if showsActions, entry.id == turn.lastAssistantEntryID, let content = entry.kind.assistantContent {
                    MessageActions(model: model, entryID: entry.id, copyText: content,
                                   onContinue: turn.anchorRunID.flatMap { run in actions.continueFromRun.map { action in { action(run) } } })
                }
            }
            .padding(.bottom, 8)
            .id(entry.id)
        }
    }
}

// MARK: - Prompt card

/// `.ucard`: the turn's prompt on the gray card, pills above the text. A long
/// prompt collapses to its pills and two lines (one on a short screen), fading
/// into the card; the chevron that opens or closes it has its own strip at the card's foot.
struct PromptCard: View {
    @Bindable var model: SessionModel
    let entry: ConversationEntry
    let highlight: FindHighlight?
    var collapsedLines = 2
    /// An inherited prompt: the card and its text are muted, the pinned background stays opaque.
    var isDimmed = false
    let viewImage: (_ name: String, _ path: String) -> Void
    @Environment(WorkspaceStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private static let size: CGFloat = 15
    /// The gap below the last kept line, before the next one would start (conversation-view.tsx COLLAPSED_HEIGHT slack).
    private static let slack: CGFloat = 6

    private var style: TextStyle { TextStyle(size: Self.size, weight: 500) }
    private var lineSpacing: CGFloat { style.scaledSize(dynamicTypeSize) * 0.625 - 3 }

    /// The kept lines' height, from the prompt font's metrics rather than a
    /// measurement: a pinned header of a lazy stack must not change size as it is laid out.
    private var collapsedTextHeight: CGFloat {
        let lines = CGFloat(max(1, collapsedLines))
        return lines * style.uiFont(dynamicTypeSize).lineHeight + (lines - 1) * lineSpacing
    }

    var body: some View {
        let content = PromptContent.parse(entry.kind.userContent ?? "")
        let keptHeight = collapsedTextHeight + Self.slack
        let overflows = (model.promptTextHeights[entry.id] ?? 0) > keptHeight + 1
        let isOpen = model.promptsOpen.contains(entry.id)
        // A find match inside a collapsed prompt opens it.
        let expanded = isOpen || highlight?.activeLocalIndex != nil
        let collapsed = overflows && !expanded
        VStack(alignment: .leading, spacing: 4) {
            if !content.attachments.isEmpty { pills(content.attachments) }
            promptText(content.text)
                .background(GeometryReader { proxy in Color.clear.preference(key: HeightKey.self, value: proxy.size.height) })
                .frame(height: collapsed ? keptHeight : nil, alignment: .top)
                .clipped()
                // Clipping hides the overflow but does not stop it taking touches meant for the rows below.
                .allowsHitTesting(!collapsed)
                .overlay(alignment: .bottom) {
                    if collapsed {
                        LinearGradient(colors: [Palette.bg80.opacity(0), Palette.bg80], startPoint: .top, endPoint: .bottom)
                            .frame(height: Self.slack * 2)
                            .allowsHitTesting(false)
                    }
                }
            // The chevron has its own strip at the card's foot: it never covers a line of the prompt.
            if overflows {
                Button { if isOpen { model.promptsOpen.remove(entry.id) } else { model.promptsOpen.insert(entry.id) } } label: {
                    Icon(.chevronDown, size: 16)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .foregroundStyle(Palette.t300)
                        .frame(maxWidth: .infinity, minHeight: 18)
                        .contentShape(Rectangle().inset(by: -13))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse message" : "Expand message")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, overflows ? 2 : 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.bg80))
        .opacity(isDimmed ? 0.8 : 1)
        .onPreferenceChange(HeightKey.self) { height in
            if abs(height - (model.promptTextHeights[entry.id] ?? 0)) > 0.5 { model.promptTextHeights[entry.id] = height }
        }
        .padding(.horizontal, ConversationTimeline.gutter)
        .padding(.top, 4)
        .background(Palette.bg)
    }

    private func promptText(_ text: String) -> some View {
        var builder = InlineTextBuilder(size: Self.size, dynamicTypeSize: dynamicTypeSize, weight: 500, highlight: highlight)
        let attributed = builder.leaf(text, font: style.font(dynamicTypeSize), color: Palette.fg)
        return Text(attributed)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    private func pills(_ attachments: [PromptAttachment]) -> some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                switch attachment {
                case .image(let name, let path):
                    Button { viewImage(name, path) } label: { PillLabel(icon: .image, text: name, skill: false).minimumHitArea() }
                        .buttonStyle(.plain)
                        .accessibilityLabel(name)
                case .skill(let name):
                    PillLabel(icon: .hammer, text: name, skill: true)
                case .session(let taskID):
                    PillLabel(icon: .messageSquare, text: store.session(taskID)?.title ?? attachment.label, skill: false)
                case .file(_, let isDirectory):
                    PillLabel(icon: isDirectory ? .folder : .fileText, text: attachment.label, skill: false)
                case .annotations:
                    PillLabel(icon: .fileText, text: attachment.label, skill: false)
                }
            }
        }
        .padding(.top, 2)
    }

    private struct HeightKey: PreferenceKey {
        static let defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
    }
}

/// `.upill`: a prompt's attachment.
struct PillLabel: View {
    let icon: LucideName
    let text: String
    let skill: Bool

    var body: some View {
        HStack(spacing: 4) {
            Icon(icon, size: 12)
            Text(text).lineLimit(1)
        }
        .textStyle(TextStyle(size: 12.5))
        .foregroundStyle(skill ? Color(hex: 0x047857) : Palette.blue600)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 4).fill(skill ? Color(hex: 0xECFDF5) : Color(hex: 0xEFF6FF)))
    }
}

// MARK: - Entries

/// A segment that is not a timeline: assistant text, the Run with line,
/// system and error messages, raw output.
struct EntryView: View {
    let entry: ConversationEntry
    let highlight: FindHighlight?

    var body: some View {
        switch entry.kind {
        case .assistantMessage(let markdown):
            MarkdownView(markdown: markdown, highlight: highlight)
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
                .textSelection(.enabled)
        case .systemMessage(let text):
            if let line = RunWithLine.parse(text) {
                RunWithRow(line: line)
            } else {
                CollapsibleMessage(text: text, tone: .system)
            }
        case .errorMessage(let text, _):
            ErrorCard(text: text, highlight: highlight)
        case .stdout(let text):
            Text(text).textStyle(.code(13)).foregroundStyle(Palette.fg).padding(.horizontal, 14).padding(.vertical, 4)
        case .stderr(let text):
            Text(text).textStyle(.code(13)).foregroundStyle(Palette.destructive).padding(.horizontal, 14).padding(.vertical, 4)
        case .userMessage(let text):
            Text(PromptContent.parse(text).text).textStyle(TextStyle(size: 15, weight: 500)).padding(.horizontal, 14)
        case .thinking, .loading, .toolUse:
            EmptyView()
        }
    }
}

/// `.runwith`: "Run with  Haiku 5.5  reasoning effort:  High".
struct RunWithRow: View {
    let line: RunWithLine

    var body: some View {
        HStack(spacing: 6) {
            Text("Run with")
            Text(line.model).fontWeight(.medium)
            if let effort = line.effort {
                Text("reasoning effort:")
                Text(effort).fontWeight(.medium)
            }
        }
        .textStyle(TextStyle(size: 13))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// A multi-line system message collapses to its first line (CollapsibleEntry).
struct CollapsibleMessage: View {
    enum Tone { case system }
    let text: String
    let tone: Tone
    @State private var open = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let multiline = lines.count > 1
        Button { if multiline { open.toggle() } } label: {
            HStack(alignment: .top, spacing: 6) {
                MarkdownView(markdown: open || !multiline ? text : String(lines[0]), size: 14, color: Palette.t300)
                if multiline { Icon(.chevronDown, size: 16).rotationEffect(.degrees(open ? 0 : -90)).foregroundStyle(Palette.t300) }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!multiline)
    }
}

/// `.errcard`: an error message is the one red row of a conversation.
struct ErrorCard: View {
    let text: String
    let highlight: FindHighlight?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        var builder = InlineTextBuilder(size: 15, dynamicTypeSize: dynamicTypeSize, color: Palette.destructive, highlight: highlight)
        let attributed = builder.leaf(text, font: builder.font(15), color: Palette.destructive)
        Text(attributed)
            .lineSpacing(builder.scaled(15) * 0.625 - 3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.destructive.opacity(0.1)))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.destructive.opacity(0.4)))
            .textSelection(.enabled)
    }
}

/// `.mact`: Copy and "Continue in a new session from here", always visible on touch.
struct MessageActions: View {
    @Bindable var model: SessionModel
    let entryID: String
    let copyText: String
    let onContinue: (() -> Void)?

    var body: some View {
        let copied = model.copiedEntryID == entryID
        HStack(spacing: 0) {
            Button {
                UIPasteboard.general.string = copyText
                model.copiedEntryID = entryID
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    if model.copiedEntryID == entryID { model.copiedEntryID = nil }
                }
            } label: {
                Icon(copied ? .check : .copy, size: 15).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(cornerRadius: 4))
            .accessibilityLabel(copied ? "Copied" : "Copy")
            if let onContinue {
                Button(action: onContinue) {
                    Icon(.gitBranch, size: 15).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(cornerRadius: 4))
                .accessibilityLabel("Continue in a new session from here")
            }
        }
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 6)
    }
}

/// The boundary above a continued session's own turns.
struct ForkBoundary: View {
    let origin: ContinuationOrigin
    let open: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Palette.border).frame(height: 1)
            Button(action: open) {
                HStack(spacing: 6) {
                    Icon(.gitBranch, size: 15)
                    Text(origin.linkTitle).textStyle(TextStyle(size: 14)).lineLimit(1).fixedSize()
                }
                .foregroundStyle(Palette.primary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(origin.sourceTitle ?? "")
            Rectangle().fill(Palette.border).frame(height: 1)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 16)
    }
}

/// A digest continuation: the source's last prompt and reply, muted.
struct DigestSummary: View {
    let user: String?
    let assistant: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let user { Text(user).fontWeight(.medium) }
            if let assistant { Text(assistant) }
        }
        .textStyle(TextStyle(size: 14, lineHeight: 1.625))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
    }
}

// MARK: - Steps

/// `.steps`: a run of working entries behind one header (thinking-steps.tsx).
struct StepsView: View {
    @Bindable var model: SessionModel
    let steps: StepsSegment
    let pendingApprovalID: String?

    var body: some View {
        let open = model.stepsOpen[steps.id] ?? steps.awaitingApproval
        let label = steps.headerText
        VStack(alignment: .leading, spacing: 0) {
            Button { model.stepsOpen[steps.id] = !open } label: {
                HStack(spacing: 6) {
                    if steps.isLive {
                        TextShimmer(text: label)
                    } else {
                        Text(label).textStyle(TextStyle(size: 14, weight: open ? 500 : 400)).lineLimit(1)
                            .foregroundStyle(open ? Palette.fg : Palette.t300)
                    }
                    Icon(.chevronRight, size: 15).foregroundStyle(Palette.t300).rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(8)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel(label)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            // The shimmer has no text of its own to read; UI tests find the working header by it.
            .accessibilityIdentifier(steps.isLive ? "steps-live" : "steps")
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.entries.enumerated()), id: \.element.id) { index, entry in
                        StepRow(model: model, entry: entry, isLast: index == steps.entries.count - 1, pendingApprovalID: pendingApprovalID)
                    }
                }
            }
        }
        .padding(.horizontal, 6)
    }
}

/// `.step`: the icon column with its connector, then the step's body.
struct StepRow: View {
    @Bindable var model: SessionModel
    let entry: ConversationEntry
    let isLast: Bool
    let pendingApprovalID: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 4) {
                if case .loading = entry.kind {
                    BrailleSpinner().frame(height: 22)
                } else {
                    Circle().fill(Palette.t300.opacity(0.6)).frame(width: 6, height: 6).padding(.top, 7)
                }
                if !isLast { Rectangle().fill(Palette.border.opacity(0.6)).frame(width: 1).frame(maxHeight: .infinity) }
            }
            .frame(width: 14)
            VStack(alignment: .leading, spacing: 6) { content }
                .padding(.top, 1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    @ViewBuilder private var content: some View {
        switch entry.kind {
        case .loading(let text):
            TextShimmer(text: ConversationLayout.loadingStepText(text))
        case .thinking(let text):
            MarkdownView(markdown: text, size: 14, color: Palette.t300)
        case .toolUse(let tool):
            let row = ToolRow(tool)
            if row.isQuestion {
                QuestionTranscriptRow(tool: tool, isDialogShown: { if case .pendingApproval(let id, _) = tool.status { return id == pendingApprovalID } else { return false } }())
            } else {
                ToolRowView(model: model, entryID: entry.id, row: row)
            }
        default:
            EmptyView()
        }
    }
}

/// `.toolrow`: label, summary and, when it has detail, the disclosure.
struct ToolRowView: View {
    @Bindable var model: SessionModel
    let entryID: String
    let row: ToolRow
    @Environment(\.externalScreens) private var external
    @Environment(\.pathLinkScope) private var pathLinkScope
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets

    private var pathLinks: PathLinkContext { PathLinkContext(links: external.pathLinks, scope: pathLinkScope) }

    /// conversation-view.tsx ToolSummaryText: when the summary is exactly the
    /// file the tool touched and that file resolves, it is a link to open it.
    private var summaryTarget: PathLinks.Target? {
        guard let path = row.linkedPath, row.summary == path else { return nil }
        return pathLinks.target(path)
    }

    var body: some View {
        let open = model.toolsOpen.contains(entryID) != row.startsExpanded
        VStack(alignment: .leading, spacing: 6) {
            if let target = summaryTarget, let summary = row.summary {
                linkedHeader(summary: summary, target: target, open: open)
            } else {
                header(open: open)
            }
            if let note = row.statusNote {
                switch note {
                case .pending(let text): Text(text).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300)
                case .denied(let text): Text(text).textStyle(TextStyle(size: 12)).foregroundStyle(Palette.destructive)
                }
            }
            if open, row.canExpand, let detail = row.detail { ToolDetailView(detail: detail) }
        }
        .task(id: row.linkedPath) {
            guard let path = row.linkedPath, row.summary == path else { return }
            await pathLinks.resolve([path])
        }
    }

    private func toggle() {
        if model.toolsOpen.contains(entryID) { model.toolsOpen.remove(entryID) } else { model.toolsOpen.insert(entryID) }
    }

    /// The label toggles the detail; the blue path opens the file.
    private func linkedHeader(summary: String, target: PathLinks.Target, open: Bool) -> some View {
        HStack(spacing: 8) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Icon(icon, size: 13)
                    Text(row.label).textStyle(TextStyle(size: 13, weight: 500)).lineLimit(1).fixedSize()
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!row.canExpand)
            .accessibilityLabel(row.label)
            .accessibilityValue(row.canExpand ? (open ? "Expanded" : "Collapsed") : "")
            Button { PathLinks.open(target, router: router, sheets: sheets, external: external) } label: {
                Text(summary).textStyle(.code(12)).lineLimit(1).truncationMode(.tail)
                    .foregroundStyle(Palette.blue600)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary)
            .accessibilityAddTraits(.isLink)
            .accessibilityIdentifier("path-link:\(summary)")
            if row.canExpand {
                Button(action: toggle) {
                    Icon(.chevronDown, size: 13).rotationEffect(.degrees(open ? 0 : -90)).frame(minWidth: 24, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHidden(true)
            }
        }
        .foregroundStyle(Palette.t300)
    }

    private func header(open: Bool) -> some View {
        Button(action: toggle) {
                HStack(spacing: 8) {
                    Icon(icon, size: 13)
                    Text(row.label).textStyle(TextStyle(size: 13, weight: 500)).lineLimit(1).fixedSize()
                    if let summary = row.summary {
                        Text(summary).textStyle(.code(12)).lineLimit(1).truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Spacer(minLength: 0)
                    }
                    if row.canExpand { Icon(.chevronDown, size: 13).rotationEffect(.degrees(open ? 0 : -90)) }
                }
                .foregroundStyle(Palette.t300)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!row.canExpand)
            .accessibilityLabel([row.label, row.summary].compactMap { $0 }.joined(separator: " "))
            .accessibilityValue(row.canExpand ? (open ? "Expanded" : "Collapsed") : "")
    }

    private var icon: LucideName {
        switch row.icon {
        case .terminal: return .terminal
        case .eye: return .eye
        case .squarePen: return .squarePen
        case .squareCheck: return .squareCheckBig
        case .globe: return .globe
        case .search: return .search
        case .hammer: return .hammer
        }
    }
}

/// The expanded body of a tool row: command sections, file changes, arguments, todos.
struct ToolDetailView: View {
    let detail: ToolRow.Detail

    var body: some View {
        switch detail {
        case .command(let sections):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
                    SectionTitle(text: section.title)
                    switch section.body {
                    case .code(let code):
                        ScrollView { Text(code).textStyle(.code(12.5)).foregroundStyle(Palette.fg).frame(maxWidth: .infinity, alignment: .leading) }
                            .frame(maxHeight: 190)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .textSelection(.enabled)
                    case .note(let text):
                        Text(text).textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300).padding(.horizontal, 12).padding(.vertical, 8)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border.opacity(0.5)))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .fileChanges(let path, let changes):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(changes.enumerated()), id: \.offset) { _, change in FileChangeView(path: path, change: change) }
            }
        case .structured(let arguments, let result):
            VStack(alignment: .leading, spacing: 0) {
                if let arguments { SectionTitle(text: "Arguments", strong: true); StructuredValue(value: arguments).padding(.horizontal, 12).padding(.vertical, 8) }
                if let result { SectionTitle(text: "Result", strong: true); StructuredValue(value: result).padding(.horizontal, 12).padding(.vertical, 8) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
        case .todos(let todos):
            VStack(alignment: .leading, spacing: 0) {
                SectionTitle(text: "Todos", strong: true)
                ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                    Divider()
                    HStack(spacing: 8) {
                        Text(todo.status == "done" ? "✓" : "").textStyle(TextStyle(size: 10)).frame(width: 16, height: 16)
                            .overlay(Circle().strokeBorder(Palette.border))
                        Text(todo.content).frame(maxWidth: .infinity, alignment: .leading)
                        Text(todo.status).foregroundStyle(Palette.t300.opacity(0.8))
                    }
                    .textStyle(TextStyle(size: 12))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
        }
    }
}

private struct SectionTitle: View {
    let text: String
    var strong = false

    var body: some View {
        Text(text)
            .textStyle(TextStyle(size: 10, weight: strong ? 600 : 500, tracking: 0.05, uppercase: true))
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 12)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.muted.opacity(strong ? 0.6 : 0.4))
    }
}

/// FileChangesList: a unified diff, a written file, a deletion or a rename.
private struct FileChangeView: View {
    let path: String
    let change: ToolFileChange

    var body: some View {
        switch change {
        case .edit(let diff):
            VStack(alignment: .leading, spacing: 4) {
                Text(path).textStyle(TextStyle(size: 12, weight: 500)).foregroundStyle(Palette.t300)
                ScrollView([.vertical]) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                            DiffLine(line: String(line))
                        }
                    }
                    .padding(.vertical, 8)
                }
                .frame(maxHeight: 256)
                .fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 4).fill(Palette.muted.opacity(0.3)))
            }
        case .write(let content):
            VStack(alignment: .leading, spacing: 4) {
                Text("+ \(path)").textStyle(TextStyle(size: 12, weight: 500)).foregroundStyle(Palette.emerald600)
                Text(content).textStyle(.code(12)).foregroundStyle(Palette.fg.opacity(0.8))
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.05))
                    .overlay(alignment: .leading) { Rectangle().fill(Color.green.opacity(0.5)).frame(width: 2) }
            }
        case .delete:
            Text("\u{2212} Deleted \(path)").textStyle(TextStyle(size: 12)).foregroundStyle(Color(hex: 0xDC2626))
        case .rename(let newPath):
            Text("→ Renamed \(path) → \(newPath)").textStyle(TextStyle(size: 12)).foregroundStyle(Palette.blue600)
        }
    }
}

private struct DiffLine: View {
    let line: String

    var body: some View {
        let (fill, bar, color): (Color, Color?, Color) = {
            if line.hasPrefix("@@") { return (Color.blue.opacity(0.05), nil, Palette.t300) }
            if line.hasPrefix("+") { return (Color.green.opacity(0.1), Color.green.opacity(0.5), Color(hex: 0x15803D)) }
            if line.hasPrefix("-") { return (Color.red.opacity(0.1), Color.red.opacity(0.5), Color(hex: 0xB91C1C)) }
            return (.clear, nil, Palette.fg.opacity(0.8))
        }()
        Text(line.isEmpty ? " " : line)
            .textStyle(.code(12))
            .foregroundStyle(color)
            .padding(.leading, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill)
            .overlay(alignment: .leading) { if let bar { Rectangle().fill(bar).frame(width: 2) } }
    }
}

/// renderStructuredValue: keys in small caps, scalars in mono.
private struct StructuredValue: View {
    let value: JSONValue

    var body: some View {
        switch value {
        case .object(let object) where !object.isEmpty:
            VStack(alignment: .leading, spacing: 4) {
                ForEach(object.keys.sorted(), id: \.self) { key in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(key).textStyle(TextStyle(size: 10, tracking: 0.05, uppercase: true)).foregroundStyle(Palette.t300).frame(minWidth: 88, alignment: .leading)
                        StructuredValue(value: object[key] ?? .null)
                    }
                }
            }
        case .array(let items) where !items.isEmpty:
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    StructuredValue(value: item).padding(.horizontal, 8).padding(.vertical, 4)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border.opacity(0.4)))
                }
            }
        default:
            Text(scalar).textStyle(.code(11)).foregroundStyle(isEmpty ? Palette.t300 : Palette.fg)
        }
    }

    private var isEmpty: Bool {
        switch value {
        case .null: return true
        case .array(let items): return items.isEmpty
        case .object(let object): return object.isEmpty
        default: return false
        }
    }

    private var scalar: String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return number.rounded() == number ? String(Int(number)) : String(number)
        case .string(let text): return text
        case .array: return "[]"
        case .object: return "{}"
        }
    }
}

/// The AskUserQuestion row inside a timeline: a status line or the answer card.
struct QuestionTranscriptRow: View {
    let tool: ToolUse
    let isDialogShown: Bool

    var body: some View {
        let (arguments, result): (JSONValue?, JSONValue?) = {
            if case .tool(_, let arguments, let result) = tool.action { return (arguments, result) }
            return (nil, nil)
        }()
        let isError: Bool = { switch tool.status { case .failed, .denied: return true; default: return false } }()
        let state = QuestionTranscript.derive(questions: QuestionPrompt.questions(from: arguments), isPending: tool.status.isPendingApproval,
                                              isDialogShown: isDialogShown, result: result, isError: isError)
        switch state {
        case .asking:
            TextShimmer(text: "Asking question...", style: TextStyle(size: 13)).padding(.horizontal, 8)
        case .status(let label, let status):
            HStack(spacing: 8) {
                Text(label)
                Text("•").foregroundStyle(Palette.t300.opacity(0.5))
                Text(status).lineLimit(1)
            }
            .textStyle(TextStyle(size: 13))
            .foregroundStyle(Palette.t300)
            .frame(minHeight: 28)
            .padding(.horizontal, 8)
            .accessibilityElement(children: .combine)
        case .answeredWithoutEntries:
            Text("Question answered").textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300).frame(minHeight: 28).padding(.horizontal, 8)
        case .answered(let pairs):
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Icon(.circleHelp, size: 15)
                    Text(state.cardTitle)
                }
                .textStyle(TextStyle(size: 13))
                .foregroundStyle(Palette.t300)
                .padding(.horizontal, 10)
                .frame(height: 32)
                Rectangle().fill(Palette.border).frame(height: 1)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pair.question).fontWeight(.medium).foregroundStyle(Palette.fg)
                            Text(pair.answer).foregroundStyle(Palette.t300)
                        }
                    }
                }
                .textStyle(TextStyle(size: 13))
                .padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Palette.muted.opacity(0.3)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
            .padding(.horizontal, 8)
        }
    }
}
