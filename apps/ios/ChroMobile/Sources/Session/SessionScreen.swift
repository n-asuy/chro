import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// The session screen (SingleAgentSessionView): header, branch chip,
/// conversation, and the prompt area.
struct SessionScreen: View {
    let sessionID: String
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @State private var viewedImage: ViewedImage?

    /// The shell's entry point (`ExternalScreens.session`).
    @MainActor static func screen(_ sessionID: String) -> AnyView { AnyView(SessionScreen(sessionID: sessionID)) }

    var body: some View {
        let model = SessionModels.shared.model(sessionID, services: store.services)
        Group {
            if let session = store.session(sessionID) {
                SessionContent(model: model, session: session, isScratch: store.isScratch(session.projectID), viewedImage: $viewedImage)
                    // Path links in this conversation resolve against the session's task.
                    .environment(\.pathLinkScope, PathLinks.Scope(projectID: session.projectID, sessionID: session.id))
            } else {
                VStack(spacing: 0) {
                    NavBar(title: "", onBack: { router.pop() })
                    Spacer()
                }
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .task(id: store.session(sessionID)?.projectID) {
            guard let session = store.session(sessionID) else { return }
            model.onUploadFailure = { [toasts] message in toasts.show(message) }
            model.onActionFailure = { [toasts] title, description in toasts.show(title, description: description) }
            model.start(projectID: session.projectID, isScratch: store.isScratch(session.projectID))
        }
        .onDisappear { model.stopFeed() }
        .fullScreenCover(item: $viewedImage) { image in
            PromptImageViewer(name: image.name, path: image.path, sessionID: sessionID, services: store.services) { viewedImage = nil }
        }
    }
}

private struct SessionContent: View {
    static let endID = "conversation-end"
    @Bindable var model: SessionModel
    let session: SessionSummary
    let isScratch: Bool
    @Binding var viewedImage: ViewedImage?
    @Environment(WorkspaceStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(SheetPresenter.self) private var sheets
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.externalScreens) private var external
    @FocusState private var titleFocused: Bool
    /// The visible height of the conversation, which decides how much a pinned prompt may take.
    @State private var viewportHeight: CGFloat = 0
    @State private var screenHeight: CGFloat = 0
    @State private var scroller = ConversationScroller()
    /// Under this, a pinned prompt collapses to one line so the response stays readable (iPhone SE with a question card).
    private static let shortViewport: CGFloat = 220

    var body: some View {
        VStack(spacing: 0) {
            header
            if let branch = session.branch, !isScratch { branchRow(branch) }
            ZStack(alignment: .top) {
                conversationArea
                if model.isFinding { FindBar(model: model).padding(.horizontal, 12).padding(.top, 4) }
            }
            if let conversation = model.conversation, let composer = model.composer {
                SessionPromptArea(model: model, session: session, conversation: conversation, isScratch: isScratch, composer: composer, openSession: open)
                    .task(id: session.id) { await composer.load() }
                    .environment(\.approvalCardMaxHeight, screenHeight > 0 ? min(400, screenHeight / 2) : 400)
            }
        }
        .background(GeometryReader { geometry in
            Color.clear
                .onAppear { screenHeight = geometry.size.height }
                .onChange(of: geometry.size.height) { _, height in screenHeight = height }
        })
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 2) {
            BackButton { model.commitTitle(session.title); router.pop() }
            if model.isEditingTitle {
                TextField("", text: $model.titleDraft)
                    .textStyle(.navTitle)
                    .multilineTextAlignment(.center)
                    .focused($titleFocused)
                    .submitLabel(.done)
                    .onSubmit { model.commitTitle(session.title) }
                    .onChange(of: titleFocused) { _, focused in if !focused { model.commitTitle(session.title) } }
                    .padding(.vertical, 4)
                    .overlay(alignment: .bottom) { Rectangle().fill(Palette.primary).frame(height: 1) }
                    .onAppear { titleFocused = true }
                    .accessibilityLabel("Edit title")
            } else {
                Button { model.beginTitleEdit(session.title) } label: {
                    Text(session.title ?? "")
                        .textStyle(.navTitle)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(session.title ?? "")
                .accessibilityHint("Edit title")
            }
            IconButton(icon: .search, size: 19, label: "Find in conversation") { model.toggleFind() }
            if !isScratch, let dock = external.dock {
                IconButton(icon: .panelRight, size: 20, label: "Open right panel") {
                    sheets.present(tall: true) { dock(DockContext(projectID: session.projectID, sessionID: session.id, panel: nil)) }
                }
            }
        }
        .padding(.horizontal, 4)
        .frame(height: 48)
    }

    private func branchRow(_ branch: String) -> some View {
        let status = model.conversation?.branchStatus ?? SessionBranchStatus()
        let target = status.targetBranch ?? session.targetBranch
        return HStack {
            RunStatusChip(branch: branch, target: target, additions: status.additions, deletions: status.deletions, behind: status.commitsBehind,
                          open: external.dock.map { dock in
                              { sheets.present(tall: true) { dock(DockContext(projectID: session.projectID, sessionID: session.id, panel: .sourceControl)) } }
                          }) {
                sheets.present {
                    BranchFactsSheet(branch: branch, usesWorktree: model.conversation?.usesWorktree ?? true, from: target, shortID: session.shortID)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 2)
    }

    // MARK: Conversation

    @ViewBuilder private var conversationArea: some View {
        if let conversation = model.conversation, conversation.isLoaded || !conversation.entries.isEmpty || conversation.continuation != nil {
            let navItems = ConversationLayout.navItems(conversation.entries)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        ConversationTimeline(model: model, session: session, conversation: conversation, actions: TimelineActions(
                            openSession: open,
                            continueFromRun: canContinue ? { run in continueFrom(run) } : nil,
                            viewImage: { name, path in viewedImage = ViewedImage(name: name, path: path) }
                        ), promptLines: viewportHeight > 0 && viewportHeight < Self.shortViewport ? 1 : 2)
                        Color.clear.frame(height: 1).id(Self.endID)
                    }
                    .background(ConversationScroller.Anchor(scroller: scroller))
                }
                .scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("conversation")
                .background(GeometryReader { geometry in
                    Color.clear
                        .onAppear { viewportHeight = geometry.size.height }
                        .onChange(of: geometry.size.height) { _, height in viewportHeight = height }
                })
                // Open at the end of the conversation, as the desktop does, before the push shows it.
                .modifier(OpensAtEnd(sessionID: session.id) { proxy.scrollTo(Self.endID, anchor: .bottom) })
                // New content keeps the end in view while the reader is there.
                .onChange(of: conversation.entries) { _, _ in
                    if scroller.isFollowing { proxy.scrollTo(Self.endID, anchor: .bottom) }
                }
                // A send follows the end again (scrollToBottomSignal): its prompt is the next content.
                // Scrolling at the submit itself, while the queue card and keyboard resize the
                // viewport, sends the lazy stack's layout into a loop that never settles.
                .onChange(of: model.submitCount) { _, _ in scroller.resume() }
                .onChange(of: model.isLoadingEarlier) { _, loading in if loading { scroller.release() } }
                .onChange(of: model.activeMatch) { _, match in
                    guard let match else { return }
                    scroller.release()
                    withAnimation { proxy.scrollTo(match.entryID, anchor: .center) }
                }
                .overlay(alignment: .trailing) {
                    if navItems.count >= ConversationLayout.navigatorMinimumPrompts {
                        MessageNavTicks(count: navItems.count) {
                            sheets.present {
                                MessageNavSheet(items: navItems, activeID: navItems.last?.id) { id in
                                    scroller.release()
                                    withAnimation { proxy.scrollTo(id, anchor: .top) }
                                }
                            }
                        }
                    }
                }
            }
        } else {
            Spinner(size: 26).foregroundStyle(Palette.t300).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// A session continues from a turn when it has a checkout to branch: scratch chats, and git sessions whose worktree is still there.
    private var canContinue: Bool { !session.worktreeDeleted && (isScratch || session.branch != nil) }

    private func open(_ sessionID: String) {
        store.noteOpened(sessionID)
        router.push(.session(id: sessionID))
    }

    private func continueFrom(_ runID: String) {
        Task {
            do {
                let forked = try await store.services.conversation.continueFromRun(sessionID: session.id, runID: runID)
                open(forked.id)
            } catch {
                toasts.show("Could not continue in a new session")
            }
        }
    }
}

/// Starts the conversation at its end: placed before the first frame, so the
/// push slides in the final layout, then settled once the lazy rows have measured.
private struct OpensAtEnd: ViewModifier {
    let sessionID: String
    let scrollToEnd: () -> Void

    func body(content: Content) -> some View {
        content
            .onAppear { scrollToEnd() }
            .task(id: sessionID) {
                try? await Task.sleep(for: .milliseconds(350))
                scrollToEnd()
            }
    }
}

/// Whether the conversation follows its end (task-conversation.tsx, rules in
/// `ConversationFollow`), read from the UIScrollView under the SwiftUI ScrollView:
/// it watches the offset and whether the reader's finger moves it. It never
/// moves the view itself; the screen scrolls to the end while `isFollowing`.
@MainActor
final class ConversationScroller {
    private var follow = ConversationFollow()
    private weak var scrollView: UIScrollView?
    private var observation: NSKeyValueObservation?

    var isFollowing: Bool { follow.isFollowing }

    /// Lives inside the scrolled content to find the UIScrollView that hosts it.
    struct Anchor: UIViewRepresentable {
        let scroller: ConversationScroller

        func makeUIView(context: Context) -> AnchorView {
            let view = AnchorView()
            view.isUserInteractionEnabled = false
            view.scroller = scroller
            return view
        }

        func updateUIView(_ view: AnchorView, context: Context) { view.scroller = scroller }
    }

    final class AnchorView: UIView {
        weak var scroller: ConversationScroller?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            var ancestor = superview
            while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
            if let scrollView = ancestor as? UIScrollView { scroller?.attach(scrollView) }
        }
    }

    private func attach(_ scrollView: UIScrollView) {
        guard scrollView !== self.scrollView else { return }
        self.scrollView = scrollView
        observation = scrollView.observe(\.contentOffset, options: [.old, .new]) { [weak self] _, change in
            guard change.oldValue != change.newValue else { return }
            MainActor.assumeIsolated { self?.moved() }
        }
    }

    /// The offsets measured from the top of the scrollable range.
    private func geometry(_ scrollView: UIScrollView) -> ConversationFollow.Geometry {
        let inset = scrollView.adjustedContentInset
        return ConversationFollow.Geometry(offset: scrollView.contentOffset.y + inset.top,
                                           bottomOffset: scrollView.contentSize.height + inset.top + inset.bottom - scrollView.bounds.height)
    }

    private func moved() {
        guard let scrollView else { return }
        let byReader = scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating
        follow.scrolled(to: geometry(scrollView), byReader: byReader)
    }

    /// A send: follow again from the end the screen is scrolling to.
    func resume() {
        follow.jumped(to: scrollView.map(geometry) ?? ConversationFollow.Geometry(offset: 0, bottomOffset: 0))
    }

    /// The screen is about to take the reader elsewhere on purpose.
    func release() { follow.release() }
}

/// The branch chip (RunStatusPill): branch → target, diff stats, commits behind.
/// Tap opens Source Control; a long press shows the chip's facts.
private struct RunStatusChip: View {
    let branch: String
    let target: String?
    let additions: Int
    let deletions: Int
    let behind: Int
    let open: (() -> Void)?
    let facts: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Icon(.gitBranch, size: 15)
            Text(branch).lineLimit(1).truncationMode(.tail)
            if let target, target != branch {
                Text("→").foregroundStyle(Palette.t300)
                Text(target).foregroundStyle(Palette.t200).lineLimit(1).fixedSize()
            }
            if additions > 0 || deletions > 0 {
                (Text("+\(additions)").foregroundColor(Palette.emerald600) + Text(" ") + Text("-\(deletions)").foregroundColor(Palette.red500))
                    .textStyle(.code(12))
                    .fixedSize()
            }
            if behind > 0 {
                Text("↓\(behind)").textStyle(TextStyle(size: 11, weight: 500)).foregroundStyle(Palette.t300)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Palette.bg80))
                    .fixedSize()
            }
        }
        .textStyle(.chip)
        .foregroundStyle(Palette.fg)
        .padding(.horizontal, 10)
        .frame(height: 32)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture { open?() }
        .onLongPressGesture(minimumDuration: 0.48) { facts() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Open Source Control")
        .accessibilityValue(branch)
        .accessibilityAction(named: "Show details") { facts() }
    }
}

/// The right-edge rail of past prompts (conversation-message-nav.tsx): one tick
/// per prompt, the current one longer. Tapping opens the list.
private struct MessageNavTicks: View {
    let count: Int
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(0..<count, id: \.self) { index in
                    let active = index == count - 1
                    Capsule().fill(active ? Palette.fg : Palette.t300.opacity(0.4)).frame(width: active ? 16 : 10, height: 2)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 10)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.trailing, 2)
        .accessibilityLabel("Jump to a past message")
    }
}

/// `.findbar` (conversation-find-bar.tsx).
private struct FindBar: View {
    @Bindable var model: SessionModel
    @FocusState private var focused: Bool

    var body: some View {
        let total = model.findMatches.count
        HStack(spacing: 2) {
            Icon(.search, size: 15).foregroundStyle(Palette.t300)
            TextField("", text: $model.findQuery, prompt: Text("Find in conversation...").foregroundStyle(Palette.t300))
                .textStyle(TextStyle(size: 15))
                .foregroundStyle(Palette.fg)
                .focused($focused)
                .submitLabel(.search)
                .onSubmit { model.stepFind(1); focused = true }
                .onChange(of: model.findQuery) { _, _ in model.findIndex = 0 }
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(height: 36)
                .accessibilityLabel("Find in conversation")
            if !model.findQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(ConversationFind.counter(current: model.findIndex, total: total))
                    .textStyle(TextStyle(size: 12.5, tabular: true)).foregroundStyle(Palette.t300).padding(.horizontal, 4)
            }
            findButton(.arrowUp, "Previous match") { model.stepFind(-1) }
            findButton(.arrowDown, "Next match") { model.stepFind(1) }
            findButton(.x, "Close find bar") { model.toggleFind() }
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 8).surface(Palette.bg, elevation: .floating))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
        .onAppear { focused = true }
    }

    private func findButton(_ icon: LucideName, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(icon, size: 16).frame(width: 36, height: 44).contentShape(Rectangle()) }
            .buttonStyle(PressableStyle())
            .foregroundStyle(Palette.t200)
            .accessibilityLabel(label)
    }
}
