import ChroServices
import SwiftUI

/// The right dock's panels (right-dock.tsx), in the desktop's order.
enum DockPanel: String, CaseIterable, Identifiable {
    case files = "filetree"
    case search
    case sourceControl = "source-control"
    case agent

    var id: String { rawValue }

    var label: String {
        switch self {
        case .files: return "Files"
        case .search: return "Search files"
        case .sourceControl: return "Source Control"
        case .agent: return "Agent"
        }
    }

    /// The selected glyph is drawn at stroke 2, the others at 1.5.
    func icon(selected: Bool) -> LucideName {
        switch self {
        case .files: return selected ? .folderTree : .folderTreeThin
        case .search: return selected ? .search : .searchThin
        case .sourceControl: return selected ? .gitBranch : .gitBranchThin
        case .agent: return selected ? .waypoints : .waypointsThin
        }
    }

    init(_ panel: DockContext.Panel) {
        switch panel {
        case .files: self = .files
        case .searchFiles: self = .search
        case .sourceControl: self = .sourceControl
        }
    }

    /// The last panel shown, like the desktop's right-dock store.
    static let storageKey = "chro.dock.panel"
}

/// The right dock as a sheet: the panel switcher, Done, and the panel.
/// Opening on a panel (branch chip, Search files…) selects it; otherwise the
/// last panel shown comes back.
struct DockSheet: View {
    let context: DockContext
    @AppStorage(DockPanel.storageKey) private var stored = DockPanel.sourceControl.rawValue
    @State private var selection: DockPanel?
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        let panel = selection ?? context.panel.map(DockPanel.init) ?? DockPanel(rawValue: stored) ?? .sourceControl
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                DockPanelSwitcher(selection: panel) { picked in
                    selection = picked
                    stored = picked.rawValue
                }
                Spacer(minLength: 0)
                DoneButton { sheets.dismiss() }
            }
            .padding(.leading, 10)
            .padding(.trailing, 8)
            .padding(.top, 2)
            .padding(.bottom, 6)
            .frame(minHeight: 48)
            Group {
                switch panel {
                case .files: FilesPanel(context: context)
                case .search: SearchPanel(context: context)
                case .sourceControl: SourceControlPanel(context: context)
                case .agent: AgentPanel(context: context)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .onAppear { if let opened = context.panel { stored = DockPanel(opened).rawValue } }
    }
}

/// `.segc`: the pill-shaped icon switcher of the dock's panels.
private struct DockPanelSwitcher: View {
    let selection: DockPanel
    let onSelect: (DockPanel) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(DockPanel.allCases) { panel in
                let selected = panel == selection
                Button { onSelect(panel) } label: {
                    Icon(panel.icon(selected: selected), size: 18)
                        .foregroundStyle(selected ? Palette.fg : Palette.t300)
                        .frame(width: 48, height: 36)
                        .background {
                            if selected {
                                Capsule().surface(Palette.bg, elevation: .hairline)
                                    .overlay(Capsule().strokeBorder(Palette.border.opacity(0.5)))
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(panel.label)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(.horizontal, 4)
        .background(Capsule().fill(Palette.muted).padding(.vertical, 0).frame(height: 44))
        .accessibilityElement(children: .contain)
    }
}
