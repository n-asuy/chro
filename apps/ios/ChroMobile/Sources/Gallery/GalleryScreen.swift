import ChroDomain
import ChroServices
import SwiftUI

/// gallery/gallery-panel.tsx as a pushed screen: the renderable images and
/// videos of a run's worktree (with a session) or the project's main
/// checkout. A tile opens the file in the editor's viewer.
struct GalleryScreen: View {
    let projectID: String
    let sessionID: String?
    @Environment(Router.self) private var router
    @Environment(\.panelServices) private var services
    @State private var model = GalleryModel()

    private var scope: CheckoutScope { sessionID.map { .run(sessionID: $0) } ?? .project(id: projectID) }

    var body: some View {
        VStack(spacing: 0) {
            NavBar(title: "Gallery", onBack: { router.pop() })
            header
            if model.status == .ready && model.listing.truncated {
                Text(GalleryMedia.truncationNotice)
                    .textStyle(TextStyle(size: 12.5))
                    .foregroundStyle(Palette.t300)
                    .opacity(0.6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
            content
        }
        .background(Palette.bg.ignoresSafeArea())
        .task(id: scope) { await model.load(scope, from: services.gallery) }
    }

    /// `.gal-h`: the count (context) and refresh (action).
    private var header: some View {
        HStack(spacing: 0) {
            if model.status == .ready && !model.listing.items.isEmpty {
                HStack(spacing: 6) {
                    Icon(.images, size: 16)
                    Text(GalleryMedia.countLabel(model.listing)).textStyle(TextStyle(size: 12.5, tabular: true))
                }
                .foregroundStyle(Palette.t300)
                .opacity(0.6)
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 0)
            Button { Task { await model.load(scope, from: services.gallery) } } label: {
                RefreshGlyph(spinning: model.status == .loading)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
            .foregroundStyle(Palette.t300)
            .accessibilityLabel("Refresh gallery")
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(height: 44)
    }

    @ViewBuilder private var content: some View {
        switch model.status {
        case .error:
            CenterMessage(icon: .imageOff, text: "Could not load media.") {
                Button { Task { await model.load(scope, from: services.gallery) } } label: {
                    Text("Retry").textStyle(TextStyle(size: 13)).foregroundStyle(Palette.fg)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(cornerRadius: 4))
            }
        case .ready where model.listing.items.isEmpty:
            CenterMessage(icon: .images, text: "No images or videos yet.") { EmptyView() }
        case .ready, .loading:
            GeometryReader { proxy in
                let width = proxy.size.width - 32
                let columns = GalleryMedia.columns(forWidth: Double(width))
                ScrollView {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: GalleryMedia.gap), count: columns),
                              spacing: GalleryMedia.gap) {
                        ForEach(model.listing.items) { item in
                            MediaTile(item: item, scope: scope) {
                                router.push(.panel(.file(FileLocation(projectID: projectID, sessionID: sessionID, path: item.relativePath))))
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            }
        }
    }
}

/// Loads one scope's listing; a newer load wins over a slower older one.
@MainActor @Observable
final class GalleryModel {
    enum Status: Equatable { case loading, ready, error }

    private(set) var status = Status.loading
    private(set) var listing = MediaListing(items: [], truncated: false)
    @ObservationIgnored private var epoch = 0

    func load(_ scope: CheckoutScope, from service: any GalleryService) async {
        epoch += 1
        let current = epoch
        status = .loading
        // Drop the previous tiles so the grid never shows another scope's media while loading.
        listing = MediaListing(items: [], truncated: false)
        do {
            let next = try await service.media(in: scope, limit: GalleryMedia.limit)
            guard current == epoch else { return }
            listing = next
            status = .ready
        } catch {
            guard current == epoch else { return }
            status = .error
        }
    }
}

/// `.center-msg`
private struct CenterMessage<Action: View>: View {
    let icon: LucideName
    let text: String
    @ViewBuilder var action: () -> Action

    var body: some View {
        VStack(spacing: 12) {
            Icon(icon, size: 24).opacity(0.5)
            Text(text).textStyle(TextStyle(size: 15))
            action()
        }
        .foregroundStyle(Palette.t300)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// refresh-cw, turning while a load is in flight.
private struct RefreshGlyph: View {
    let spinning: Bool
    @State private var angle: Double = 0

    var body: some View {
        Icon(.refreshCw, size: 17)
            .rotationEffect(.degrees(angle))
            .onChange(of: spinning, initial: true) { _, on in
                if on {
                    withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { angle = 360 }
                } else {
                    withAnimation(.default) { angle = 0 }
                }
            }
    }
}
