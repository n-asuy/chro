import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// `.gprompt`: what sits under the conversation (renderGlobalPrompt): the
/// conflict banner, the pending approval, then the composer.
struct SessionPromptArea: View {
    @Bindable var model: SessionModel
    let session: SessionSummary
    let conversation: SessionConversation
    let isScratch: Bool
    let composer: ComposerModel
    let openSession: (String) -> Void
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.pathLinkScope) private var pathLinkScope
    @State private var confirmingAbort: ConflictBannerText?

    var body: some View {
        VStack(spacing: 0) {
            let banner = conflictBanner
            if banner != nil || conversation.pendingApproval != nil {
                let cards = VStack(spacing: 8) {
                    if let banner { banner }
                    switch conversation.pendingApproval {
                    case .question?: QuestionCard(model: model)
                    case .mcp(_, let prompt)?: McpApprovalCard(model: model, prompt: prompt)
                    case nil: EmptyView()
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                // At large text on a small screen the cards take half the screen
                // and scroll, rather than push the navigation bar off the top or
                // squeeze the composer.
                ViewThatFits(in: .vertical) {
                    cards
                    ScrollView { cards }
                        .scrollBounceBehavior(.basedOnSize)
                        .containerRelativeFrame(.vertical) { height, _ in height / 2 }
                }
                .background(Palette.bg.opacity(0.8))
                .background(.ultraThinMaterial)
            }
            ComposerView(model: composer, showsTray: false, isModelPickerDisabled: locks.pickerDisabled,
                         header: composerHeader, accessory: AnyView(refsButton), trailing: AnyView(sendControls)) { submit() }
        }
        .confirmationDialog(confirmingAbort?.abortTitle ?? "", isPresented: Binding(get: { confirmingAbort != nil }, set: { if !$0 { confirmingAbort = nil } }),
                            presenting: confirmingAbort) { text in
            Button(text.abortTitle, role: .destructive) { abort(text) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var locks: ExecutorLocks { ExecutorLocks(hasRun: conversation.hasRun, isRunning: session.isRunning) }

    // MARK: Conflict

    private var conflictBanner: ConflictBannerView? {
        guard !isScratch, let conflict = conversation.branchStatus.conflict else { return nil }
        let text = ConflictBannerText(operation: conflict.operation, branch: session.branch,
                                      target: conversation.branchStatus.targetBranch ?? session.targetBranch ?? "main", files: conflict.files)
        return ConflictBannerView(text: text, isAborting: model.isAborting) { confirmAbort(text) }
    }

    private func confirmAbort(_ text: ConflictBannerText) { confirmingAbort = text }

    private func abort(_ text: ConflictBannerText) {
        Task {
            if let failure = await model.abortConflict(fallback: "Failed to abort the \(text.operation.title.lowercased()).") {
                toasts.show(failure)
            }
        }
    }

    // MARK: Composer parts

    private var composerHeader: AnyView? {
        let cleaned = session.worktreeDeleted
        let queue = conversation.queue
        guard cleaned || !queue.isEmpty || !model.uploads.isEmpty else { return nil }
        return AnyView(VStack(alignment: .leading, spacing: 12) {
            if cleaned { CleanedWorkspaceNotice() }
            if !queue.isEmpty { QueueList(model: model, queue: queue) }
            if !model.uploads.isEmpty { UploadTiles(model: model) }
        })
    }

    private var refsButton: some View {
        Button { sheets.present { ReferencesSheet(references: conversation.references, pathScope: pathLinkScope, openSession: openSession) } } label: {
            // At large text the word goes before the count does: an icon and a number read, "…" does not.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    Icon(.link2, size: 18)
                    Text("Refs")
                    refsCount
                }
                HStack(spacing: 6) {
                    Icon(.link2, size: 18)
                    refsCount
                }
            }
            .textStyle(.modelPill)
            .foregroundStyle(Palette.t300)
            .padding(.horizontal, 8)
            .frame(height: 40)
            .minimumHitArea()
        }
        .buttonStyle(PressableStyle(cornerRadius: 4))
        .accessibilityLabel("Open references")
        .accessibilityValue("\(conversation.references.count)")
    }

    private var refsCount: some View {
        Text("\(conversation.references.count)")
            .textStyle(TextStyle(size: 11, weight: 500))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.muted))
    }

    @ViewBuilder private var sendControls: some View {
        switch model.sendControls(session) {
        case .send(let enabled):
            RoundButton(icon: .arrowUpBold, kind: .solid, isEnabled: enabled && !model.isSubmitting, label: "Cmd or Ctrl + Enter to send") { submit() }
        case .running(let canQueue):
            HStack(spacing: 6) {
                if canQueue { RoundButton(icon: .listPlus, kind: .solid, isEnabled: !model.isSubmitting, label: "Add to queue") { submit() } }
                RoundButton(icon: .square, kind: .soft, isEnabled: true, label: "Stop") { stop() }
            }
        case .stopping:
            RoundButton(icon: nil, kind: .soft, isEnabled: false, label: "Stop") {}
        }
    }

    private func submit() {
        Task {
            do { try await model.submit(session) } catch { toasts.show("Failed to send message", description: SessionModel.message(error)) }
        }
    }

    private func stop() {
        Task {
            do { try await model.stop() } catch { toasts.show("Failed to stop", description: SessionModel.message(error)) }
        }
    }
}

/// `.round`: the 36pt send, queue and stop buttons.
struct RoundButton: View {
    enum Kind { case solid, soft }
    /// Nil draws the stopping spinner.
    let icon: LucideName?
    let kind: Kind
    let isEnabled: Bool
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let icon { Icon(icon, size: icon == .square ? 17 : 18) } else { Spinner(size: 17) }
            }
            .foregroundStyle(!isEnabled ? Palette.disabledForeground : kind == .solid ? Palette.primaryForeground : Palette.primary)
            .frame(width: 36, height: 36)
            .background(Circle().fill(!isEnabled ? Palette.disabledFill : kind == .solid ? Palette.primary : Palette.primary.opacity(0.1)))
            .minimumHitArea()
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(label)
    }
}

/// The worktree-cleaned notice at the top of the composer card.
private struct CleanedWorkspaceNotice: View {
    var body: some View {
        HStack(spacing: 8) {
            Icon(.circleSlash, size: 14)
            Text("This session's workspace was cleaned up. Sending a message restores it from the branch.")
                .fixedSize(horizontal: false, vertical: true)
        }
        .textStyle(TextStyle(size: 12))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg90))
    }
}

/// `.cbanner` (conflict-banner.tsx). "Open in Editor" hands the worktree to an
/// editor on the desktop, which the phone cannot reach, so it is not offered.
struct ConflictBannerView: View {
    let text: ConflictBannerText
    let isAborting: Bool
    let abort: () -> Void

    var body: some View {
        ScrollView {
            HStack(alignment: .top, spacing: 10) {
                Icon(.circleAlert, size: 16).padding(.top, 3)
                VStack(alignment: .leading, spacing: 4) {
                    Text(text.message).fixedSize(horizontal: false, vertical: true)
                    if !text.visibleFiles.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(text.filesHeading).fontWeight(.medium)
                            ForEach(text.visibleFiles, id: \.self) { file in Text(file).lineLimit(1).truncationMode(.middle) }
                        }
                        .textStyle(TextStyle(size: 13))
                    }
                    Button(action: abort) {
                        Text(text.abortTitle)
                            .textStyle(TextStyle(size: 13.5, weight: 500))
                            .foregroundStyle(Palette.destructive)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.bg))
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.destructive.opacity(0.4)))
                    }
                    .buttonStyle(.plain)
                    .disabled(isAborting)
                    .opacity(isAborting ? 0.5 : 1)
                    .padding(.top, 4)
                }
            }
            .textStyle(TextStyle(size: 14, lineHeight: 1.55))
            .foregroundStyle(Palette.amber700)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 230)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.amber.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.amber.opacity(0.4)))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Queue

/// `.queue` (session-queue-list.tsx): the waiting messages, reorderable by their grip.
struct QueueList: View {
    @Bindable var model: SessionModel
    let queue: [QueuedPrompt]
    @Environment(ToastCenter.self) private var toasts
    @State private var dragging: String?
    @State private var dragOffset: CGFloat = 0
    /// The person just asked to edit this row: the field takes the keyboard.
    @FocusState private var editFocused: Bool

    private static let rowHeight: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(QueueRules.headline(count: queue.count))
                .textStyle(TextStyle(size: 13))
                .foregroundStyle(Palette.t300)
                .padding(.horizontal, 12)
                .frame(height: 34)
            Rectangle().fill(Palette.border.opacity(0.7)).frame(height: 1)
            VStack(spacing: 0) {
                ForEach(Array(queue.enumerated()), id: \.element.id) { index, item in
                    row(item, index: index)
                        .offset(y: dragging == item.id ? dragOffset : 0)
                        .zIndex(dragging == item.id ? 1 : 0)
                }
            }
            .padding(.vertical, 2)
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.border.opacity(0.8)))
        .padding(.top, -4)
    }

    @ViewBuilder private func row(_ item: QueuedPrompt, index: Int) -> some View {
        if let edit = model.queueEdit, edit.id == item.id {
            HStack(spacing: 2) {
                TextField("", text: Binding(get: { model.queueEdit?.text ?? "" }, set: { model.queueEdit?.text = $0 }), axis: .vertical)
                    .lineLimit(1...6)
                    .textStyle(TextStyle(size: 13.5))
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.primary.opacity(0.6)))
                    .accessibilityLabel("Edit")
                    .focused($editFocused)
                    .onAppear { editFocused = true }
                    .padding(.leading, 6)
                rowAction(.check, "Save") { run { try await model.saveQueueEdit() } }
                rowAction(.x, "Cancel") { model.queueEdit = nil }
            }
            .padding(.vertical, 2)
        } else {
            let preview = QueueRules.preview(item.prompt)
            HStack(spacing: 2) {
                Icon(.gripVertical, size: 15)
                    .foregroundStyle(Palette.t300.opacity(0.6))
                    .frame(width: 28, height: 40)
                    .contentShape(Rectangle())
                    .gesture(dragGesture(item, index: index))
                    .accessibilityLabel("Drag to reorder")
                    .accessibilityActions {
                        if index > 0 { Button("Move up") { run { try await model.moveQueued(item.id, to: index - 1) } } }
                        if index < queue.count - 1 { Button("Move down") { run { try await model.moveQueued(item.id, to: index + 1) } } }
                    }
                Text(preview.text).textStyle(TextStyle(size: 13.5)).foregroundStyle(Palette.fg).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(counts(preview), id: \.0) { icon, count in
                    HStack(spacing: 2) { Icon(icon, size: 12); Text("\(count)") }
                        .textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300)
                }
                rowAction(.pencil, "Edit") { model.queueEdit = (item.id, QueueRules.split(item.prompt).text) }
                rowAction(.sendHorizontal, "Send now") { run { try await model.sendQueuedNow(item.id) } }
                    .accessibilityHint("stops the running turn and sends this message")
                rowAction(.x, "Remove") { run { try await model.removeQueued(item.id) } }
            }
            .padding(.trailing, 4)
            .background {
                if dragging == item.id { RoundedRectangle(cornerRadius: 6).surface(Palette.bg, elevation: .raised) }
            }
        }
    }

    private func counts(_ preview: QueueRules.Preview) -> [(LucideName, Int)] {
        [(.image, preview.images), (.link2, preview.references), (.bookOpen, preview.skills)].filter { $0.1 > 0 }
    }

    private func dragGesture(_ item: QueuedPrompt, index: Int) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                dragging = item.id
                dragOffset = value.translation.height
            }
            .onEnded { value in
                let target = min(max(0, index + Int((value.translation.height / Self.rowHeight).rounded())), queue.count - 1)
                dragging = nil
                dragOffset = 0
                if target != index { run { try await model.moveQueued(item.id, to: target) } }
            }
    }

    private func rowAction(_ icon: LucideName, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(icon, size: 15).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .buttonStyle(PressableStyle(cornerRadius: 4))
            .foregroundStyle(Palette.t300)
            .accessibilityLabel(label)
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { toasts.show("Failed to update the queue", description: SessionModel.message(error)) }
        }
    }
}

// MARK: - Uploads

/// `.ups` (image-upload-preview-list.tsx): picked photos with their upload state.
struct UploadTiles: View {
    @Bindable var model: SessionModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.uploads) { upload in tile(upload) }
            }
        }
        .padding(.top, -2)
    }

    private func tile(_ upload: ImageUpload) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                if let image = UIImage(data: upload.data) {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Palette.bg80
                }
                if upload.state == .uploading {
                    Palette.bg.opacity(0.5)
                    Spinner(size: 16).foregroundStyle(Palette.primary)
                }
            }
            .frame(width: 112, height: 80)
            .clipped()
            .overlay(alignment: .topTrailing) {
                Button { model.removeUpload(upload.id) } label: {
                    Icon(.x, size: 12).foregroundStyle(Palette.t300)
                        .frame(width: 20, height: 20).background(Palette.bg.opacity(0.7))
                        .padding(4).frame(width: 44, height: 44, alignment: .topTrailing).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove")
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(upload.name).textStyle(TextStyle(size: 10.5, weight: 500)).lineLimit(1)
                switch upload.state {
                case .uploading:
                    Text("Uploading...").textStyle(TextStyle(size: 11)).foregroundStyle(Palette.t300)
                case .failed(let message):
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 3) { Icon(.circleAlert, size: 12); Text("Upload failed") }
                        Text(message).lineLimit(2)
                    }
                    .textStyle(TextStyle(size: 11))
                    .foregroundStyle(Palette.destructive)
                    Button { model.retryUpload(upload.id) } label: {
                        Text("Retry").textStyle(TextStyle(size: 11)).foregroundStyle(Palette.t200)
                            .padding(.horizontal, 8).frame(minHeight: 30).background(Palette.muted)
                    }
                    .buttonStyle(.plain)
                case .uploaded:
                    EmptyView()
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)
            .padding(.bottom, 6)
        }
        .frame(width: 112, alignment: .leading)
        .background(Palette.bg)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border.opacity(0.5)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(upload.name)
    }
}
