import ChroDomain
import ChroServices
import SwiftUI

/// settings/settings-panel.tsx as a tall sheet: the pane list, then a pane
/// screen in the same sheet. Developer stays on the desktop.
struct SettingsSheet: View {
    var model: SettingsModel?
    var initialPane: SettingsPane?
    @Environment(\.panelServices) private var services
    @State private var owned: SettingsModel?
    @State private var pane: SettingsPane?
    @State private var started = false

    var body: some View {
        let model = model ?? owned
        VStack(spacing: 0) {
            if let model {
                if let pane {
                    PaneHeader(title: pane.title) { self.pane = nil }
                    SettingsPaneScreen(pane: pane, model: model)
                        .id(pane)
                } else {
                    SheetHeader(title: "Settings")
                    PaneList { self.pane = $0 }
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .onAppear {
            guard !started else { return }
            started = true
            if self.model == nil { owned = SettingsModel(services: services) }
            pane = initialPane ?? Self.launchPane
        }
    }
}

extension SettingsSheet {
    /// `-ChroSettingsPane <pane>` opens a pane at launch (screenshot comparison).
    static var launchPane: SettingsPane? {
        UserDefaults.standard.string(forKey: "ChroSettingsPane").flatMap(SettingsPane.init(rawValue:)).flatMap { $0 == .developer ? nil : $0 }
    }
}

/// `.sheet-h` of a pane: back to the list, the pane's name centred, Done.
private struct PaneHeader: View {
    let title: String
    let onBack: () -> Void
    @Environment(SheetPresenter.self) private var presenter

    var body: some View {
        ZStack {
            Text(title).textStyle(.sheetTitle).foregroundStyle(Palette.fg).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                Button(action: onBack) {
                    HStack(spacing: 0) {
                        Icon(.chevronLeft, size: 24)
                        Text("Settings").textStyle(TextStyle(size: 15))
                    }
                    .padding(.leading, 2)
                    .padding(.trailing, 6)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.primary)
                .accessibilityLabel("Back")
                Spacer(minLength: 0)
                DoneButton { presenter.dismiss() }
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 8)
        .padding(.top, 2)
        .padding(.bottom, 6)
        .frame(minHeight: 48)
    }
}

/// `.set-root`: one group of pane rows.
private struct PaneList: View {
    let open: (SettingsPane) -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(Array(SettingsPane.phone.enumerated()), id: \.element) { index, pane in
                    Button { open(pane) } label: {
                        HStack {
                            Text(pane.title).textStyle(TextStyle(size: 15)).foregroundStyle(Palette.fg)
                            Spacer(minLength: 8)
                            Icon(.chevronRight, size: 17).foregroundStyle(Palette.t400)
                        }
                        .padding(.leading, 18)
                        .padding(.trailing, 12)
                        .frame(minHeight: 48)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableStyle(cornerRadius: 0))
                    .overlay(alignment: .top) {
                        if index > 0 { Rectangle().fill(Palette.border.opacity(0.6)).frame(height: 1) }
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 16).fill(Palette.bg))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.border.opacity(0.7)))
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }
}

/// One option list of a settings select (the mock's `setselect` sheet).
struct SettingsOptionGroup: Identifiable {
    struct Option: Identifiable {
        var id: String
        var label: String
    }

    var heading: String?
    var options: [Option]
    var id: String { heading ?? options.first?.id ?? "" }
}

/// Replaces the Settings sheet with an option list; picking or going back
/// returns to the same pane.
@MainActor
enum SettingsOptions {
    static func present(_ sheets: SheetPresenter, model: SettingsModel, pane: SettingsPane, title: String,
                        groups: [SettingsOptionGroup], selected: String?, onPick: @escaping @MainActor (String) -> Void) {
        let back = {
            sheets.present(tall: true) {
                SettingsSheet(model: model, initialPane: pane).environment(\.panelServices, model.services)
            }
        }
        sheets.present {
            SettingsOptionSheet(title: title, groups: groups, selected: selected, onBack: back) { id in
                onPick(id)
                back()
            }
        }
    }
}

private struct SettingsOptionSheet: View {
    let title: String
    let groups: [SettingsOptionGroup]
    let selected: String?
    let onBack: () -> Void
    let onPick: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button(action: onBack) {
                    Icon(.chevronLeft, size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.primary)
                .accessibilityLabel("Back")
                Text(title).textStyle(TextStyle(size: 12, weight: 600, tracking: 0.04, uppercase: true))
                    .foregroundStyle(Palette.t300).frame(maxWidth: .infinity, alignment: .leading)
                DoneButton(action: onBack)
            }
            .padding(.leading, 4)
            .padding(.trailing, 8)
            .padding(.top, 2)
            .padding(.bottom, 6)
            .frame(minHeight: 48)
            ScrollView {
                SheetMenu {
                    ForEach(groups) { group in
                        if let heading = group.heading { MenuLabel(text: heading) }
                        ForEach(group.options) { option in
                            MenuItem(title: option.label, checked: option.id == selected) { onPick(option.id) }
                        }
                    }
                }
            }
            .frame(maxHeight: 520)
            .fixedSize(horizontal: false, vertical: true)
            .scrollIndicators(.hidden)
        }
    }
}
