import SwiftUI

/// An unexpected failure a pushed screen reports instead of drawing itself
/// (system/error-boundary.tsx). Expected failures (a file that is gone, a git
/// refusal) stay on the screen as its own empty state or toast.
struct RouteFailure: Equatable {
    var message: String
    /// What "Details" shows and Copy copies.
    var details: String

    init(_ error: any Error) {
        let described = String(describing: error)
        message = (error as? LocalizedError)?.errorDescription ?? described
        details = described == message ? message : "\(message)\n\n\(described)"
    }
}

extension EnvironmentValues {
    /// Hands an unexpected failure to the nearest `RouteErrorBoundary`.
    @Entry var reportRouteFailure: @MainActor (RouteFailure) -> Void = { _ in }
}

/// The route-level error boundary: shows the error page in place of a
/// screen that reported a failure, and counts failures so a recurring one
/// shows the warning line.
struct RouteErrorBoundary<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @State private var failure: RouteFailure?
    @State private var failureCount = 0
    @State private var generation = 0
    @Environment(Router.self) private var router
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        if let failure {
            ErrorPage(failure: failure, failureCount: failureCount,
                      onRetry: remount,
                      onGoHome: { router.reset(to: []) },
                      onReload: reload)
        } else {
            content()
                .id(generation)
                .environment(\.reportRouteFailure) { reported in
                    failureCount += 1
                    failure = reported
                }
        }
    }

    /// Re-mounts the screen that failed; it may fail again.
    private func remount() {
        failure = nil
        generation += 1
    }

    /// Re-reads the workspace from the desktop, then re-mounts the screen.
    private func reload() {
        store.stop()
        store.start()
        failureCount = 0
        remount()
    }
}

/// `.errpage`: the fallback every route error boundary shows.
struct ErrorPage: View {
    let failure: RouteFailure
    let failureCount: Int
    let onRetry: () -> Void
    let onGoHome: () -> Void
    let onReload: () -> Void
    @State private var showsDetails = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Something went wrong").textStyle(TextStyle(size: 17, weight: 600)).foregroundStyle(Palette.fg)
            Text("An unexpected error occurred. You can retry, or reload the view.")
                .textStyle(TextStyle(size: 15, lineHeight: 1.5)).foregroundStyle(Palette.t300).padding(.top, 8)
            if failureCount > 1 {
                Text("If this keeps happening, reload the view or go back to the start.")
                    .textStyle(TextStyle(size: 15, lineHeight: 1.5)).foregroundStyle(Palette.destructive).padding(.top, 8)
            }
            Button { showsDetails.toggle() } label: {
                Text("Details").textStyle(TextStyle(size: 13))
                .foregroundStyle(Palette.t300)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, 16)
            .accessibilityValue(showsDetails ? "Expanded" : "Collapsed")
            if showsDetails {
                ScrollView {
                    Text(failure.details)
                        .textStyle(TextStyle(size: 11, lineHeight: 1.6))
                        .foregroundStyle(Palette.t300)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(10)
                }
                .frame(maxHeight: 192)
                .fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 4).fill(Palette.muted))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
            }
            VStack(spacing: 10) {
                BigButton(title: "Retry", action: onRetry)
                BigButton(title: "Go to start", kind: .outline, action: onGoHome)
                BigButton(title: "Reload", kind: .outline, action: onReload)
                Button {
                    UIPasteboard.general.string = failure.details
                    copied = true
                } label: {
                    Text(copied ? "Copied" : "Copy").textStyle(TextStyle(size: 13.5)).foregroundStyle(Palette.t300)
                        .padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 20)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.bg.ignoresSafeArea())
        .accessibilityElement(children: .contain)
    }
}
