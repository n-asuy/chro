import Foundation

/// The Settings panes (settings/settings-panel.tsx). Developer works on the
/// desktop's own folders and stays on the desktop.
public enum SettingsPane: String, CaseIterable, Sendable, Identifiable {
    case general, appearance, workspace, editor, notifications, mcp, agents, developer

    public static let phone: [SettingsPane] = allCases.filter { $0 != .developer }

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .general: return "General"
        case .appearance: return "Appearance"
        case .workspace: return "Workspace"
        case .editor: return "Editor"
        case .notifications: return "Notifications"
        case .mcp: return "MCP"
        case .agents: return "Agents"
        case .developer: return "Developer"
        }
    }

    /// The line under the pane heading, when the pane has one.
    public var description: String? {
        switch self {
        case .general, .workspace: return nil
        case .appearance: return "Customize how the application looks across the app."
        case .editor: return "Customize the markdown editor appearance and behavior."
        case .notifications: return "Desktop notifications for background activity."
        case .mcp: return "Configure Model Context Protocol servers to extend coding agent capabilities with custom tools and resources."
        case .agents: return "Choose the agents that run and extend your tasks."
        case .developer: return "Tools for working on chro itself. Changes here stay on this machine."
        }
    }
}

/// UserDefaults keys of the settings each phone keeps for itself (mobile
/// architecture §1: theme, the editor's font size, notifications). The theme
/// key is the shell's `ThemeChoice.storageKey`.
public enum DeviceSettingKey {
    public static let theme = "chro.appearance.theme"
    /// Int, points; `EditorChoices.defaultFontSize` when unset.
    public static let editorFontSize = "chro.editor.fontSize"
    /// Bool, default true.
    public static let notificationsEnabled = "chro.notifications.enabled"
    public static let notifyOnTaskComplete = "chro.notifications.onTaskComplete"
    public static let notifyOnInputNeeded = "chro.notifications.onInputNeeded"
}

/// The Editor pane's select options.
public enum EditorChoices {
    public static let fontSizes = [12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32]
    public static let lineHeights = [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5]
    public static let defaultFontSize = 15
    public static let defaultLineHeight = 1.6

    public static func fontSizeLabel(_ size: Int) -> String { "\(size)px" }
    public static func lineHeightLabel(_ value: Double) -> String { String(format: "%.1f", value) }
}

/// The merge commit message template (use-merge-settings.ts).
public enum MergeTemplate {
    public static let defaultTemplate = "{{title}} (chro {{task_short_id}}){{description_block}}"

    /// What PUT /rpc/preferences/merge stores: nil restores the default.
    public static func storedValue(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == defaultTemplate ? nil : trimmed
    }
}

/// Agent CLI rows (agent-status-menu.tsx, the Agents pane).
public enum AgentCliText {
    /// The Agent status menu's version text.
    public static func version(found: Bool, version: String?) -> String {
        version ?? (found ? "version n/a" : "not found")
    }

    /// The Agents pane's version text.
    public static func paneVersion(found: Bool, version: String?) -> String {
        version ?? (found ? "Version unavailable" : "Not found")
    }

    /// The display label of a `/rpc/cli-status` manifest name.
    public static func label(forManifestName name: String) -> String {
        switch name {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        case "pi": return "pi"
        default: return name
        }
    }

    /// The agent a manifest name stands for, for its install guide.
    public static func agent(forManifestName name: String) -> AgentKind? {
        switch name {
        case "claude": return .claudeCode
        case "codex": return .codex
        case "pi": return .pi
        default: return nil
        }
    }
}
