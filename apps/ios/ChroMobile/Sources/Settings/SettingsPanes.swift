import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// A pane screen of the Settings sheet.
struct SettingsPaneScreen: View {
    let pane: SettingsPane
    let model: SettingsModel

    var body: some View {
        SettingsPaneColumn {
            SettingsPaneHeader(title: pane.title, description: pane.description)
            switch pane {
            case .general: GeneralPane(model: model)
            case .appearance: AppearancePane(model: model)
            case .workspace: WorkspacePane(model: model)
            case .editor: EditorPane(model: model)
            case .notifications: NotificationsPane()
            case .mcp: McpPane(model: model)
            case .agents: AgentsPane(model: model)
            case .developer: EmptyView()
            }
        }
        .task { await model.load(pane) }
    }
}

/// A load or save failure under a pane's sections.
struct SettingsErrorLine: View {
    let text: String

    var body: some View {
        Text(text).textStyle(TextStyle(size: 12, lineHeight: 1.5)).foregroundStyle(Palette.destructive)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - General

private struct GeneralPane: View {
    let model: SettingsModel
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        let language = model.preferences?.language
        SettingsSection {
            SettingsRow(title: "Display Language", description: "Switch the display language of the application.", isFirst: true) {
                SettingsSelectButton(title: "Display Language", value: (language ?? .en).label) {
                    // The phone's own text is English only, so Japanese is listed only while the desktop uses it.
                    let languages = SharedPreferences.Language.allCases.filter { $0 == .en || $0 == language }
                    SettingsOptions.present(sheets, model: model, pane: .general, title: "Language",
                                            groups: [SettingsOptionGroup(options: languages.map { .init(id: $0.rawValue, label: $0.label) })],
                                            selected: language?.rawValue) { id in
                        guard let picked = SharedPreferences.Language(rawValue: id) else { return }
                        Task { await model.setLanguage(picked) }
                    }
                }
                .disabled(model.preferences == nil)
            }
        }
        if let error = model.preferencesError { SettingsErrorLine(text: error) }
    }
}

// MARK: - Appearance

private struct AppearancePane: View {
    let model: SettingsModel
    @AppStorage(DeviceSettingKey.theme) private var theme = ThemeChoice.system.rawValue
    @Environment(SheetPresenter.self) private var sheets
    @State private var pending: Task<Void, Never>?

    var body: some View {
        let choice = ThemeChoice(rawValue: theme) ?? .system
        SettingsSection {
            SettingsRow(title: "Theme", description: "Color theme for the whole application. System follows your OS setting.", isFirst: true) {
                SettingsSelectButton(title: "Theme", value: choice.label) {
                    let order: [ThemeChoice] = [.system, .light, .dark]
                    SettingsOptions.present(sheets, model: model, pane: .appearance, title: "Theme",
                                            groups: [SettingsOptionGroup(options: order.map { .init(id: $0.rawValue, label: $0.label) })],
                                            selected: choice.rawValue) { UserDefaults.standard.set($0, forKey: DeviceSettingKey.theme) }
                }
            }
            SettingsRow(title: "Accent color", description: "Pick an accent color. The whole UI derives from it and stays legible in light and dark.") {
                HStack(spacing: 4) {
                    if model.accent != nil {
                        GhostButton(title: "Reset") { Task { await model.setAccent(nil) } }
                    }
                    AccentWell(hex: model.accent ?? AccentColor.defaultHex) { hex in
                        pending?.cancel()
                        pending = Task {
                            try? await Task.sleep(for: .milliseconds(250))
                            guard !Task.isCancelled else { return }
                            await model.setAccent(hex)
                        }
                    }
                }
            }
        }
    }
}

/// The 36pt accent swatch; tapping opens the system colour picker.
private struct AccentWell: View {
    let hex: String
    let onPick: (String) -> Void

    var body: some View {
        let color = Color(hexString: hex) ?? Palette.primary
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(color)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border.opacity(0.4)))
                .frame(width: 36, height: 36)
                .allowsHitTesting(false)
            ColorPicker("Accent color", selection: Binding(get: { color }, set: { onPick(Self.hex($0)) }), supportsOpacity: false)
                .labelsHidden()
                .scaleEffect(1.6)
                .opacity(0.02)
        }
        .frame(width: 44, height: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Accent color")
        .accessibilityValue(hex)
    }

    private static func hex(_ color: Color) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return RGBColor(red: Double(red), green: Double(green), blue: Double(blue)).hex
    }
}

// MARK: - Workspace

private struct WorkspacePane: View {
    @Bindable var model: SettingsModel
    @FocusState private var templateFocused: Bool

    var body: some View {
        let preferences = model.preferences
        SettingsSection {
            SettingsRow(title: "Hidden directories", description: "Show dot-prefixed folders in the Files file tree.", isFirst: true) {
                SettingsSwitch(title: "Hidden directories", isOn: preferences?.showHiddenEntries ?? false, isEnabled: preferences != nil) { on in
                    Task { await model.setShowHiddenEntries(on) }
                }
            }
            SettingsRow(title: "Nest delegated sessions",
                        description: "List sessions started with chro task delegate under the session that delegated them in the left panel.") {
                SettingsSwitch(title: "Nest delegated sessions", isOn: model.nestDelegations ?? true, isEnabled: model.nestDelegations != nil) { on in
                    Task { await model.setNestDelegations(on) }
                }
            }
            SettingsRow(title: "Usage Analytics", description: "Send anonymous usage data to help improve Chro. No personal content is collected.") {
                SettingsSwitch(title: "Usage Analytics", isOn: preferences?.analyticsEnabled ?? true, isEnabled: preferences != nil) { on in
                    Task { await model.setAnalyticsEnabled(on) }
                }
            }
        }
        SettingsSection(heading: "Merge commit message template") {
            SettingsRow(title: "Merge commit message template",
                        description: "Template for the commit message when merging task changes. Available tokens: {{title}}, {{task_short_id}}, {{task_id}}, {{description}}, {{description_block}}",
                        isFirst: true) {
                GhostButton(title: "Reset to default", fontSize: 12) {
                    templateFocused = false
                    Task { await model.resetTemplate() }
                }
            } extra: {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("", text: $model.templateDraft, prompt: Text(MergeTemplate.defaultTemplate).foregroundStyle(Palette.t400), axis: .vertical)
                        .textStyle(TextStyle(size: 13))
                        .foregroundStyle(Palette.fg)
                        .lineLimit(3...8)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($templateFocused)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(minHeight: 72, alignment: .topLeading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg90))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(templateFocused ? Palette.primary : SettingsStyle.selectBorder))
                        .accessibilityLabel("Merge commit message template")
                        .onChange(of: templateFocused) { _, focused in
                            if !focused { Task { await model.commitTemplate() } }
                        }
                    switch model.templateSave {
                    case .saved:
                        HStack(spacing: 4) {
                            Icon(.check, size: 12)
                            Text("Saved").textStyle(TextStyle(size: 12))
                        }
                        .foregroundStyle(Palette.emerald600)
                    case .failed(let message): SettingsErrorLine(text: message)
                    case .idle, .saving: EmptyView()
                    }
                }
            }
        }
        if let error = model.preferencesError { SettingsErrorLine(text: error) }
    }
}

// MARK: - Editor

private struct EditorPane: View {
    let model: SettingsModel
    @AppStorage(DeviceSettingKey.editorFontSize) private var fontSize = EditorChoices.defaultFontSize
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        let lineHeight = model.lineHeight ?? EditorChoices.defaultLineHeight
        SettingsSection {
            SettingsRow(title: "Font Size", description: "Font size in pixels for the editor content.", isFirst: true) {
                SettingsSelectButton(title: "Font Size", value: EditorChoices.fontSizeLabel(fontSize)) {
                    SettingsOptions.present(sheets, model: model, pane: .editor, title: "",
                                            groups: [SettingsOptionGroup(options: EditorChoices.fontSizes.map { .init(id: String($0), label: EditorChoices.fontSizeLabel($0)) })],
                                            selected: String(fontSize)) { id in
                        if let size = Int(id) { UserDefaults.standard.set(size, forKey: DeviceSettingKey.editorFontSize) }
                    }
                }
            }
            SettingsRow(title: "Line Height", description: "Line height multiplier for the editor content.") {
                SettingsSelectButton(title: "Line Height", value: EditorChoices.lineHeightLabel(lineHeight)) {
                    SettingsOptions.present(sheets, model: model, pane: .editor, title: "",
                                            groups: [SettingsOptionGroup(options: EditorChoices.lineHeights.map { .init(id: EditorChoices.lineHeightLabel($0), label: EditorChoices.lineHeightLabel($0)) })],
                                            selected: EditorChoices.lineHeightLabel(lineHeight)) { id in
                        if let value = Double(id) { Task { await model.setLineHeight(value) } }
                    }
                }
                .disabled(model.lineHeight == nil)
            }
        }
    }
}

// MARK: - Notifications

/// Kept on this phone; the push gateway reads them (mobile architecture §1, §9).
private struct NotificationsPane: View {
    @AppStorage(DeviceSettingKey.notificationsEnabled) private var enabled = true
    @AppStorage(DeviceSettingKey.notifyOnTaskComplete) private var onComplete = true
    @AppStorage(DeviceSettingKey.notifyOnInputNeeded) private var onInput = true

    var body: some View {
        SettingsSection {
            SettingsRow(title: "Enable Notifications", description: "Allow chro to show desktop notifications.", isFirst: true) {
                SettingsSwitch(title: "Enable Notifications", isOn: enabled) { enabled = $0 }
            }
            SettingsRow(title: "Agent Task Complete", description: "Notify when an agent finishes while the app is in the background.", isDisabled: !enabled) {
                SettingsSwitch(title: "Agent Task Complete", isOn: enabled && onComplete, isEnabled: enabled) { onComplete = $0 }
            }
            SettingsRow(title: "Agent Waiting for Answer",
                        description: "Notify when an agent asks a question and starts waiting for your answer while the app is in the background.",
                        isDisabled: !enabled) {
                SettingsSwitch(title: "Agent Waiting for Answer", isOn: enabled && onInput, isEnabled: enabled) { onInput = $0 }
            }
        }
    }
}
