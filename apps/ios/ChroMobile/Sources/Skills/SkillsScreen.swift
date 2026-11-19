import ChroDomain
import ChroServices
import SwiftUI

/// skills/skills-panel.tsx as a pushed screen: the project's workspace
/// skills and the user's global ones, searchable and filtered by scope and
/// provider. A workspace skill the file tree can show opens the right dock's
/// Files; the desktop's "open the folder on disk" has no phone counterpart,
/// so other cards are not tappable.
struct SkillsScreen: View {
    let projectID: String
    @Environment(Router.self) private var router
    @Environment(WorkspaceStore.self) private var store
    @Environment(SheetPresenter.self) private var sheets
    @Environment(\.externalScreens) private var external
    @Environment(\.panelServices) private var services
    @State private var skills: [SkillPackage] = []
    @State private var isLoading = true
    @State private var showsHiddenEntries = false
    @State private var filter = SkillFilter()

    private var workspacePath: String? { store.project(projectID)?.path }

    var body: some View {
        VStack(spacing: 0) {
            NavBar(title: "Skills", onBack: { router.pop() })
            if isLoading {
                HStack(spacing: 8) {
                    Spinner(size: 16)
                    Text("Scanning skills…").textStyle(TextStyle(size: 14))
                }
                .foregroundStyle(Palette.t300)
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                filters
                list
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .task(id: workspacePath) { await load() }
    }

    private func load() async {
        isLoading = true
        async let hidden = (try? await services.skills.showsHiddenEntries()) ?? false
        // As on the desktop, a failed scan reads as no skills.
        skills = (try? await services.skills.skills(workspacePath: workspacePath)) ?? []
        showsHiddenEntries = await hidden
        isLoading = false
    }

    /// `.sk-head`: search and the two segmented filters.
    private var filters: some View {
        let counts = SkillCatalog.Counts(skills)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Icon(.search, size: 17).foregroundStyle(Palette.t300)
                TextField("", text: $filter.query, prompt: Text("Search skills").foregroundStyle(Palette.t300.opacity(0.5)))
                    .textStyle(TextStyle(size: 15))
                    .foregroundStyle(Palette.fg)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityLabel("Search skills")
            }
            .padding(.horizontal, 10)
            .frame(height: 44)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
            SegmentedFilter(selection: $filter.scope, options: [
                .init(value: nil, label: "All"),
                .init(value: .workspace, label: SkillScope.workspace.label, count: counts.workspace),
                .init(value: .user, label: SkillScope.user.label, count: counts.user),
            ])
            SegmentedFilter(selection: $filter.provider, options: [.init(value: nil, label: "All")] + counts.presentProviders.map {
                .init(value: $0, label: $0.label, count: counts.providers[$0])
            })
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
    }

    @ViewBuilder private var list: some View {
        let visible = filter.apply(skills)
        if visible.isEmpty {
            VStack(spacing: 8) {
                Icon(.bookOpen, size: 28).opacity(0.5)
                Text(skills.isEmpty ? "No skills found" : "No matching skills").textStyle(TextStyle(size: 15)).foregroundStyle(Palette.fg)
                Text("Looked in the workspace .claude / .agents / skills folders and your global ~/.claude, ~/.agents, ~/.codex skills.")
                    .textStyle(TextStyle(size: 12.5, lineHeight: 1.6))
                    .opacity(0.7)
            }
            .foregroundStyle(Palette.t300)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 30)
            .padding(.vertical, 90)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(visible) { skill in
                        SkillCard(skill: skill, onReveal: revealAction(for: skill))
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    /// Opens the right dock on Files at the skill's folder, for a skill the tree can show.
    private func revealAction(for skill: SkillPackage) -> (() -> Void)? {
        guard let dock = external.dock,
              let treePath = SkillCatalog.revealPath(skill, workspacePath: workspacePath, showsHiddenEntries: showsHiddenEntries) else { return nil }
        // The tree's paths are relative to the checkout root, without the leading "/".
        let reveal = String(treePath.drop { $0 == "/" })
        return { sheets.present(tall: true) { dock(DockContext(projectID: projectID, sessionID: nil, panel: .files, revealPath: reveal)) } }
    }
}

/// `.skcard`
private struct SkillCard: View {
    let skill: SkillPackage
    let onReveal: (() -> Void)?

    var body: some View {
        if let onReveal {
            Button(action: onReveal) { card }
                .buttonStyle(PressableStyle(cornerRadius: 8))
                .accessibilityHint("Reveal in file tree")
        } else {
            card.accessibilityElement(children: .combine)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Icon(.bookOpen, size: 16).foregroundStyle(Palette.t300)
                Text(skill.name).textStyle(TextStyle(size: 15, weight: 500)).foregroundStyle(Palette.fg).lineLimit(1)
            }
            Group {
                if skill.description.isEmpty {
                    Text("No description").italic().opacity(0.6)
                } else {
                    Text(skill.description).lineLimit(3)
                }
            }
            .textStyle(TextStyle(size: 13, lineHeight: 1.6))
            .foregroundStyle(Palette.t300)
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                CardBadge(text: skill.scope.label)
                CardBadge(text: skill.provider.label)
            }
        }
        .multilineTextAlignment(.leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
        .contentShape(Rectangle())
    }
}

private struct CardBadge: View {
    let text: String

    var body: some View {
        Text(text).textStyle(TextStyle(size: 11)).foregroundStyle(Palette.fg)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
    }
}

/// `.segf`: a segmented filter whose options may carry a count.
struct SegmentedFilter<Value: Hashable>: View {
    struct Option: Identifiable {
        var value: Value
        var label: String
        var count: Int?
        var id: String { label }
    }

    @Binding var selection: Value
    let options: [Option]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 2) {
                ForEach(options) { option in
                    let isOn = option.value == selection
                    Button { selection = option.value } label: {
                        HStack(spacing: 4) {
                            Text(option.label)
                            if let count = option.count { Text("\(count)").opacity(0.5).textStyle(TextStyle(size: 13, tabular: true)) }
                        }
                        .textStyle(TextStyle(size: 13))
                        .foregroundStyle(isOn ? Palette.fg : Palette.t300)
                        .padding(.horizontal, 10)
                        .frame(minWidth: 44, minHeight: 44)
                        .background(RoundedRectangle(cornerRadius: 4).fill(isOn ? Palette.muted : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.count.map { "\(option.label) \($0)" } ?? option.label)
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
            .padding(2)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
            .padding(1)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .fixedSize(horizontal: false, vertical: true)
    }
}
