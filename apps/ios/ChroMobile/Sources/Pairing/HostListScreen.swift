import ChroDomain
import ChroServices
import SwiftUI

/// The desktops this phone has paired with. Tap one to connect; long press to
/// forget it on this phone; + pairs another.
struct HostListScreen: View {
    let state: PairingState
    let service: any PairingService
    let onPairNew: () -> Void
    /// The desktop whose removal waits for confirmation.
    @State private var removing: PairedHost?

    var body: some View {
        VStack(spacing: 0) {
            NavBar(title: "Desktops", onBack: nil) {
                IconButton(icon: .plus, size: 20, label: "Pair a desktop", action: onPairNew)
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(state.hosts) { host in
                            RowButton(action: { Task { await service.activate(hostID: host.id) } }) { pressed in
                                HStack(spacing: 12) {
                                    Icon(.monitor, size: 20).foregroundStyle(Palette.t300).frame(width: 32)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(host.name).textStyle(.rowTitle).foregroundStyle(Palette.fg).lineLimit(1, accessibility: 2)
                                        Text(host.endpoint).textStyle(.rowSubline).foregroundStyle(Palette.t400).lineLimit(1)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    if let last = host.lastConnected {
                                        Text(RelativeTime.format(last, now: context.date)).textStyle(.rowTrailing).foregroundStyle(Palette.t400)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .frame(minHeight: 56)
                                .background(RoundedRectangle(cornerRadius: 6).fill(pressed ? Palette.pressed : .clear))
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityAddTraits(.isButton)
                            .accessibilityHint("Connects to this desktop")
                            .accessibilityAction { Task { await service.activate(hostID: host.id) } }
                            .rowContextMenuShape()
                            .contextMenu {
                                Button { Task { await service.activate(hostID: host.id) } } label: { Label("Connect", lucide: .link) }
                                Divider()
                                Button(role: .destructive) { removing = host } label: { Label("Remove from this phone", lucide: .trash) }
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 8)
                }
            }
        }
        .background(Palette.muted.ignoresSafeArea())
        .confirmationDialog(removing.map { "Forget \($0.name) on this phone?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { host in
            Button("Remove", role: .destructive) { Task { await service.remove(hostID: host.id) } }
        } message: { _ in
            Text("The desktop keeps the device until you revoke it in Settings → Mobile.")
        }
    }
}
