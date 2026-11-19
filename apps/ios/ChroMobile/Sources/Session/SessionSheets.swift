import ChroDomain
import ChroServices
import SwiftUI

/// The Refs popover as a sheet (session-references-popover.tsx).
struct ReferencesSheet: View {
    let references: [SessionReference]
    /// Where file references resolve (sheets do not inherit the session's environment).
    let pathScope: PathLinks.Scope?
    let openSession: (String) -> Void
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @Environment(Router.self) private var router
    @Environment(\.externalScreens) private var external

    private var pathLinks: PathLinkContext { PathLinkContext(links: external.pathLinks, scope: pathScope) }

    var body: some View {
        let rows = references.filter { reference in
            if case .session(let id) = reference.target { return store.session(id) != nil }
            return true
        }
        VStack(spacing: 0) {
            SheetHeader(title: "References", count: rows.count)
            ScrollView {
                SheetMenu {
                    if rows.isEmpty { SheetHint(text: "No references yet") }
                    ForEach(rows) { reference in row(reference) }
                }
            }
            .frame(maxHeight: 460)
            .fixedSize(horizontal: false, vertical: true)
        }
        .task {
            await pathLinks.resolve(references.compactMap { if case .path(let path, _) = $0.target { path } else { nil } })
        }
    }

    @ViewBuilder private func row(_ reference: SessionReference) -> some View {
        switch reference.target {
        case .session(let id):
            if let session = store.session(id) {
                SheetMenuRow(action: {
                    sheets.dismiss()
                    openSession(id)
                }) {
                    StatusMarkerGlyph(marker: store.marker(for: session)).frame(width: 18)
                    Text(session.shortID).textStyle(.code(12)).foregroundStyle(Palette.t300).frame(width: 36, alignment: .leading)
                    Text(session.displayTitle).foregroundStyle(Palette.fg).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    trailing(reference.relation, session)
                }
                .accessibilityElement(children: .combine)
            }
        case .path(let path, let isDirectory):
            // A path opens once the desktop confirms it exists (path links); until then the row is shown but not tappable.
            let target = pathLinks.target(path)
            SheetMenuRow(isEnabled: target != nil, action: {
                if let target { PathLinks.open(target, router: router, sheets: sheets, external: external) }
            }) {
                Icon(isDirectory ? .folder : .fileText, size: 14).foregroundStyle(Palette.t300).frame(width: 18)
                Text(path).foregroundStyle(Palette.fg).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                Text(reference.relation.label).textStyle(TextStyle(size: 12.5)).foregroundStyle(Palette.t300)
            }
        }
    }

    private func trailing(_ relation: SessionRelation, _ session: SessionSummary) -> some View {
        let state = ReferenceRunState.derive(isRunning: session.isRunning, awaitingInput: session.awaitingInput, status: session.status)
        return HStack(spacing: 4) {
            Text(relation.label + (state.suffix ?? ""))
            if case .running(let awaiting) = state { ActivityGlyph(awaitingInput: awaiting, size: 13) }
        }
        .textStyle(TextStyle(size: 12.5))
        .foregroundStyle(Palette.t300)
    }
}

/// Long-press on the branch chip: its tooltip rows (run-status-pill.tsx).
struct BranchFactsSheet: View {
    let branch: String
    let usesWorktree: Bool
    let from: String?
    let shortID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader(title: branch)
            VStack(alignment: .leading, spacing: 10) {
                fact("Execution", usesWorktree ? "Worktree" : "Local checkout")
                if let from { fact("From", from) }
                fact("ID", shortID, mono: true)
            }
            .textStyle(TextStyle(size: 14))
            .padding(.horizontal, 18)
            .padding(.top, 4)
            .padding(.bottom, 10)
        }
    }

    private func fact(_ key: String, _ value: String, mono: Bool = false) -> some View {
        HStack(spacing: 12) {
            Text(key).foregroundStyle(Palette.t300).frame(width: 84, alignment: .leading)
            if mono { Text(value).textStyle(.code(14)) } else { Text(value) }
        }
        .foregroundStyle(Palette.fg)
        .accessibilityElement(children: .combine)
    }
}

/// The message navigator's list (conversation-message-nav.tsx).
struct MessageNavSheet: View {
    let items: [MessageNavItem]
    let activeID: String?
    let jump: (String) -> Void
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Jump to a past message")
            ScrollView {
                SheetMenu {
                    ForEach(items) { item in
                        SheetMenuRow(isHighlighted: item.id == activeID, action: {
                            sheets.dismiss()
                            jump(item.id)
                        }) {
                            Text(item.label).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .frame(maxHeight: 460)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A prompt's image, full screen.
struct PromptImageViewer: View {
    let name: String
    let path: String
    let sessionID: String
    let services: ChroServiceContainer
    let close: () -> Void
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(name).textStyle(TextStyle(size: 15)).lineLimit(1).padding(.leading, 10)
                Spacer()
                Button(action: close) {
                    Text("Done").textStyle(TextStyle(size: 17, weight: 600)).padding(.horizontal, 10).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            ZStack {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().padding(16)
                } else if !failed {
                    Spinner(size: 20).foregroundStyle(.white)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.black.ignoresSafeArea())
        .task {
            do { image = UIImage(data: try await services.conversation.image(sessionID: sessionID, path: path)) } catch { failed = true }
            if image == nil { failed = true }
        }
    }
}

/// Identifies the image the viewer shows.
struct ViewedImage: Identifiable, Equatable {
    var name: String
    var path: String
    var id: String { path }
}
