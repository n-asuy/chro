import ChroServices
import SwiftUI

/// Over the workspace when the active desktop refuses this phone (revoked in
/// Settings > Mobile, or its pairing reset) or speaks another API generation.
/// The workspace below stays visible but read-only (pairing protocol §4.3).
struct HostRefusedBanner: View {
    let host: PairedHost
    let connection: HostConnection
    let onRetry: () -> Void
    let onPairAgain: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).textStyle(TextStyle(size: 15, weight: 600)).foregroundStyle(Palette.destructive)
            Text(message)
                .textStyle(TextStyle(size: 14, lineHeight: 1.5))
                .foregroundStyle(Palette.t200)
                .padding(.top, 4)
            HStack(spacing: 8) {
                BigButton(title: "Retry", kind: .outline, action: onRetry)
                if connection == .authFailed {
                    BigButton(title: "Pair again", action: onPairAgain)
                }
            }
            .padding(.top, 12)
            Button("Remove \(host.name) from this phone", role: .destructive, action: onRemove)
                .textStyle(TextStyle(size: 13))
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
        .background(RoundedRectangle(cornerRadius: 8).surface(Palette.bg, elevation: .raised))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.destructive.opacity(0.4)))
        .padding(.horizontal, 12)
        .accessibilityElement(children: .contain)
    }

    private var title: String {
        connection == .authFailed ? "\(host.name) refused this phone" : "\(host.name) needs a different version"
    }

    private var message: String {
        connection == .authFailed
            ? "The desktop no longer accepts this phone. It may have been revoked in Settings > Mobile. Retry, or pair again with a new QR code."
            : "The chro on this desktop speaks another version of the phone API. Update chro on the desktop or this app, then retry."
    }
}
