import ChroDomain
import Testing

@Suite struct SettingsRulesTests {
    @Test func phoneListsEveryPaneButDeveloper() {
        #expect(SettingsPane.phone.map(\.title) == ["General", "Appearance", "Workspace", "Editor", "Notifications", "MCP", "Agents"])
        #expect(SettingsPane.appearance.description == "Customize how the application looks across the app.")
        #expect(SettingsPane.general.description == nil)
    }

    @Test func editorChoicesMatchTheDesktopSelects() {
        #expect(EditorChoices.fontSizes == [12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32])
        #expect(EditorChoices.lineHeights == [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5])
        #expect(EditorChoices.fontSizeLabel(15) == "15px")
        #expect(EditorChoices.lineHeightLabel(1.6) == "1.6")
        #expect(EditorChoices.lineHeightLabel(2) == "2.0")
    }

    @Test func mergeTemplateSavesNullForEmptyOrDefault() {
        #expect(MergeTemplate.storedValue("  ") == nil)
        #expect(MergeTemplate.storedValue(MergeTemplate.defaultTemplate) == nil)
        #expect(MergeTemplate.storedValue(" {{title}} ") == "{{title}}")
    }

    @Test func cliVersionText() {
        #expect(AgentCliText.version(found: true, version: "1.2") == "1.2")
        #expect(AgentCliText.version(found: true, version: nil) == "version n/a")
        #expect(AgentCliText.version(found: false, version: nil) == "not found")
        #expect(AgentCliText.paneVersion(found: true, version: nil) == "Version unavailable")
        #expect(AgentCliText.paneVersion(found: false, version: nil) == "Not found")
        #expect(AgentCliText.label(forManifestName: "claude") == "Claude Code")
        #expect(AgentCliText.label(forManifestName: "other") == "other")
    }
}
