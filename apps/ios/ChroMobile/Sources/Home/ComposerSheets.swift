import ChroDomain
import ChroServices
import PhotosUI
import SwiftUI

/// The model pill's sheet: Model, Effort and Speed, each a second level.
struct ModelSheet: View {
    @Bindable var model: ComposerModel
    @State private var level: Level = .root
    @State private var query = ""
    @Environment(SheetPresenter.self) private var sheets

    enum Level { case root, model, effort, speed }

    var body: some View {
        switch level {
        case .root:
            VStack(spacing: 0) {
                // Titled by the pill that opened it.
                SheetHeader(title: model.runtime.pillLabel)
                SheetMenu {
                    MenuItem(title: "Model", value: model.runtime.model ?? "Default", disclosure: true) { level = .model }
                    if !model.efforts.isEmpty {
                        MenuItem(title: "Effort", value: model.runtime.effort?.label ?? "Default", disclosure: true) { level = .effort }
                    }
                    if model.supportsFastSpeed {
                        MenuItem(title: "Speed", value: model.runtime.speed == .fast ? "Fast" : "Default", disclosure: true) { level = .speed }
                    }
                }
            }
        case .model:
            VStack(spacing: 0) {
                SheetBackHeader(label: "Model") { level = .root; query = "" }
                SheetSearchField(placeholder: "Search models...", text: $query).padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 6)
                let list = ModelOption.search(model.models, query: query)
                ScrollView {
                    SheetMenu {
                        if list.isEmpty { SheetHint(text: "No models found") }
                        ForEach(list) { option in
                            let otherRuntime = model.runtimeLocked && option.agent != model.runtime.agent
                            SheetMenuRow(isHighlighted: model.runtime.model == option.label, isEnabled: !otherRuntime, action: {
                                model.pick(model: option)
                                sheets.dismiss()
                            }) {
                                AgentLogo(agent: option.agent, size: 16).foregroundStyle(Palette.fg)
                                Text(option.label).textStyle(.menuValue).frame(maxWidth: .infinity, alignment: .leading)
                                if model.runtime.model == option.label { Icon(.check, size: 16).foregroundStyle(Palette.t300) }
                            }
                            .accessibilityHint(otherRuntime ? ExecutorLocks.otherRuntimeHint : "")
                        }
                    }
                }
                .frame(maxHeight: 440)
                .fixedSize(horizontal: false, vertical: true)
            }
        case .effort:
            VStack(spacing: 0) {
                SheetBackHeader(label: "Effort") { level = .root }
                SheetMenu {
                    ForEach(model.efforts, id: \.self) { effort in
                        MenuItem(title: effort.label, checked: model.runtime.effort == effort) {
                            model.runtime.effort = effort
                            sheets.dismiss()
                        }
                    }
                }
            }
        case .speed:
            VStack(spacing: 0) {
                SheetBackHeader(label: "Speed") { level = .root }
                SheetMenu {
                    speedRow(nil, "Standard", "Default speed")
                    speedRow(.fast, "Fast", "Faster output, more usage")
                }
            }
        }
    }

    private func speedRow(_ speed: Speed?, _ title: String, _ detail: String) -> some View {
        SheetMenuRow(isHighlighted: model.runtime.speed == speed, action: {
            model.runtime.speed = speed
            sheets.dismiss()
        }) {
            TwoLineLabel(title: title, detail: detail)
            if model.runtime.speed == speed { Icon(.check, size: 16).foregroundStyle(Palette.t300) }
        }
    }
}

/// "From": the branch a worktree starts from.
struct BranchSheet: View {
    @Bindable var model: ComposerModel
    @State private var query = ""
    @State private var branches: [BranchOption] = []
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = branches.filter { needle.isEmpty || $0.name.lowercased().contains(needle) }
        VStack(spacing: 0) {
            SheetHeader(title: "From", search: .init(placeholder: "Search branches...", text: $query))
            ScrollView {
                SheetMenu {
                    if shown.isEmpty { SheetHint(text: "No branches found") }
                    ForEach(shown) { branch in
                        SheetMenuRow(isHighlighted: model.baseBranch == branch.name, action: {
                            model.baseBranch = branch.name
                            sheets.dismiss()
                        }) {
                            Text(branch.name).textStyle(.menuValue).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                            if branch.isCurrent { Badge(text: "current") }
                            if model.baseBranch == branch.name { Icon(.check, size: 16).foregroundStyle(Palette.t300) }
                        }
                    }
                }
            }
            .frame(maxHeight: 420)
            .fixedSize(horizontal: false, vertical: true)
        }
        .task { branches = (try? await model.services.composer.branches(projectID: model.projectID)) ?? [] }
    }
}

/// The + button: photos, then the three context pickers.
struct ComposerContextSheet: View {
    @Bindable var model: ComposerModel
    @Environment(SheetPresenter.self) private var sheets
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        SheetMenu(topPadding: 8) {
            PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .images) { AddPhotosLabel() }
            .buttonStyle(PressableStyle(pressedFill: Palette.muted))
            .onChange(of: photos) { _, items in attach(items) }
            MenuSeparator()
            MenuItem(icon: .bookOpen, title: "Skills", disclosure: true) { open(.skills) }
            MenuItem(icon: .folderOpen, title: "Files & Folders", disclosure: true) { open(.files) }
            MenuItem(icon: .messageSquare, title: "Sessions", disclosure: true) { open(.sessions) }
        }
    }

    private func open(_ view: ContextPickerSheet.Level) {
        sheets.present(tall: true) { ContextPickerSheet(model: model, view: view) }
    }

    /// Photos become image references; HEIC is re-encoded to JPEG for the server.
    private func attach(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        sheets.dismiss()
        Task { @MainActor in
            for (index, item) in items.enumerated() {
                guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                let isPNG = data.starts(with: [0x89, 0x50, 0x4E, 0x47])
                let payload = isPNG ? data : (UIImage(data: data)?.jpegData(compressionQuality: 0.9) ?? data)
                let name = "photo-\(index + 1).\(isPNG ? "png" : "jpg")"
                model.attach(ComposerReference(kind: .image, label: name, target: item.itemIdentifier ?? UUID().uuidString, imageData: payload))
            }
        }
    }
}

private struct AddPhotosLabel: View {
    var body: some View {
        HStack(spacing: 12) {
            Icon(.image, size: 18).foregroundStyle(Palette.t300)
            Text("Add photos")
            Spacer(minLength: 0)
        }
        .textStyle(.menuItem)
        .foregroundStyle(Palette.t200)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 48)
        .contentShape(Rectangle())
    }
}

/// `@` / `/` and the + sheet's pickers: runtime settings, Skills, Files & Folders, Sessions.
struct ContextPickerSheet: View {
    @Bindable var model: ComposerModel
    @State var view: Level
    @State private var query = ""
    @State private var skills: [SkillSummary] = []
    @State private var files: [String] = []
    /// The host's sessions whose titles match the search (it holds more than the phone).
    @State private var foundSessions: [SessionSummary] = []
    @Environment(SheetPresenter.self) private var sheets
    @Environment(WorkspaceStore.self) private var store

    enum Level { case root, skills, files, sessions, runtime }

    var body: some View {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        VStack(spacing: 0) {
            if view != .runtime {
                SheetSearchField(placeholder: "Search", text: $query, autofocus: true)
                    .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 6)
            }
            ScrollView {
                SheetMenu {
                    if view != .root { backRow }
                    content(needle)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .task(id: needle) {
            if skills.isEmpty { skills = (try? await model.services.composer.skills(projectID: model.projectID)) ?? [] }
            files = (try? await model.services.composer.files(projectID: model.projectID, query: needle)) ?? []
            foundSessions = needle.isEmpty ? [] : await store.searchSessions(needle)
        }
    }

    private var backRow: some View {
        SheetMenuRow(action: { view = .root; query = "" }) {
            Icon(.arrowLeft, size: 15)
            Text("Back")
            Spacer(minLength: 0)
        }
        .foregroundStyle(Palette.t300)
    }

    private var sessions: [SessionSummary] { store.sessions.filter { !store.isScratch($0.projectID) } }

    /// Browsing lists the held sessions; searching lists the host's title matches.
    private func sessions(matching needle: String) -> [SessionSummary] {
        guard !needle.isEmpty else { return sessions }
        return foundSessions.filter { !store.isScratch($0.projectID) && ($0.title ?? "").lowercased().contains(needle) }
    }

    @ViewBuilder private func content(_ needle: String) -> some View {
        switch view {
        case .skills:
            let list = skills.filter { needle.isEmpty || $0.name.lowercased().contains(needle) || $0.description.lowercased().contains(needle) }
            if list.isEmpty { SheetHint(text: needle.isEmpty ? "No skills found" : "No matching skills") }
            ForEach(list) { skillRow($0) }
        case .files:
            let list = Array(files.prefix(needle.isEmpty ? 5 : 50))
            if list.isEmpty { SheetHint(text: "No results found") }
            ForEach(list, id: \.self) { fileRow($0) }
        case .sessions:
            let list = sessions(matching: needle)
            if list.isEmpty { SheetHint(text: "No sessions found") }
            ForEach(list) { sessionRow($0) }
        case .runtime:
            ForEach(AgentKind.allCases, id: \.self) { agent in
                MenuItem(title: agent.displayName, checked: model.runtime.agent == agent) {
                    model.runtime.switchRuntime(to: agent)
                    sheets.dismiss()
                }
            }
        case .root:
            let settings = settingRows.filter { needle.isEmpty || $0.title.lowercased().contains(needle) }
            ForEach(settings, id: \.title) { setting in
                SheetMenuRow(action: setting.action) {
                    Icon(setting.icon, size: 15).foregroundStyle(Palette.t300)
                    (Text(setting.title).fontWeight(.medium).foregroundStyle(Palette.fg) + Text("  \(setting.value)").foregroundStyle(Palette.t300))
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if needle.isEmpty {
                category(.skills, .bookOpen, "Skills")
                category(.files, .folderOpen, "Files & Folders")
                category(.sessions, .messageSquare, "Sessions")
            } else {
                let matches = skills.filter { $0.name.lowercased().contains(needle) }
                ForEach(matches) { skillRow($0) }
                ForEach(sessions(matching: needle)) { sessionRow($0) }
                ForEach(files, id: \.self) { fileRow($0) }
                if settings.isEmpty && matches.isEmpty && files.isEmpty && sessions(matching: needle).isEmpty {
                    SheetHint(text: "No results found")
                }
            }
        }
    }

    private struct SettingRow {
        let icon: LucideName
        let title: String
        let value: String
        let action: () -> Void
    }

    private var settingRows: [SettingRow] {
        var rows = model.runtimeLocked ? [] : [SettingRow(icon: .cpu, title: "Runtime", value: model.runtime.agent.displayName) { view = .runtime }]
        rows.append(SettingRow(icon: .box, title: "Model", value: model.runtime.model ?? "Default") { sheets.present { ModelSheet(model: model) } })
        if !model.efforts.isEmpty {
            rows.append(SettingRow(icon: .brain, title: "Reasoning", value: model.runtime.effort?.label ?? "Default") { sheets.present { ModelSheet(model: model) } })
        }
        return rows
    }

    private func category(_ level: Level, _ icon: LucideName, _ title: String) -> some View {
        SheetMenuRow(action: { view = level; query = "" }) {
            Icon(icon, size: 15).foregroundStyle(Palette.t300)
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
            Icon(.chevronRight, size: 15).foregroundStyle(Palette.t300)
        }
    }

    private func skillRow(_ skill: SkillSummary) -> some View {
        SheetMenuRow(action: { pick(ComposerReference(kind: .skill, label: "#\(skill.name)", target: skill.name)) }) {
            Icon(.bookOpen, size: 15).foregroundStyle(Palette.t300)
            TwoLineLabel(title: skill.name, detail: skill.description)
            Text(skill.source).textStyle(TextStyle(size: 11)).foregroundStyle(Palette.t300)
        }
    }

    private func fileRow(_ path: String) -> some View {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        let dir = path.dropLast(name.count)
        return SheetMenuRow(action: { pick(ComposerReference(kind: .file, label: "@\(name)", target: path)) }) {
            Icon(.fileText, size: 15).foregroundStyle(Palette.t300)
            (Text(dir).foregroundStyle(Palette.t300) + Text(name)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sessionRow(_ session: SessionSummary) -> some View {
        let title = session.title ?? "Task"
        let label = "@" + (title.count > 24 ? String(title.prefix(24)) + "…" : title)
        return SheetMenuRow(action: { pick(ComposerReference(kind: .session, label: label, target: session.id)) }) {
            Icon(.messageSquare, size: 15).foregroundStyle(Palette.t300)
            Text(title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text(session.shortID).textStyle(.code(10.5)).foregroundStyle(Palette.t300)
        }
    }

    private func pick(_ reference: ComposerReference) {
        model.consumeTrigger()
        model.attach(reference)
        sheets.dismiss()
    }
}
