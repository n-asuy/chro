import ChroDomain
import ChroServices
import SwiftUI

/// The desktop's first-run steps (onboarding/*): welcome, then agent,
/// capabilities, theme and workspace. Runs against the paired desktop.
@MainActor @Observable
final class OnboardingModel {
    enum Step: Hashable, CaseIterable { case agent, capabilities, theme, workspace }

    let services: ChroServiceContainer
    let onFinish: (Route?) -> Void
    var path: [Step] = []
    var selectedAgent: AgentKind?
    var install: InstallStatus?
    var isChecking = false
    var skillCapability = true
    var commandCapability = true

    init(services: ChroServiceContainer, onFinish: @escaping (Route?) -> Void) {
        self.services = services
        self.onFinish = onFinish
    }

    func checkInstall() async {
        isChecking = true
        install = try? await services.onboarding.installStatus()
        isChecking = false
    }

    func next(after step: Step) {
        let order = Step.allCases
        guard let index = order.firstIndex(of: step), index + 1 < order.count else { return }
        path.append(order[index + 1])
    }

    /// Agent step: save the default agent (PUT /rpc/executor/profile) and continue.
    func confirmAgent() async {
        guard let selectedAgent else { return }
        try? await services.onboarding.setDefaultAgent(selectedAgent)
        next(after: .agent)
    }

    /// Skip, "I've done this before", or a workspace opened (then land on its Home).
    func finish(landing: Route? = nil) async {
        try? await services.onboarding.completeOnboarding()
        onFinish(landing)
    }
}

struct OnboardingFlow: View {
    @State private var model: OnboardingModel

    init(services: ChroServiceContainer, startAt: OnboardingModel.Step? = nil, onFinish: @escaping (Route?) -> Void) {
        let model = OnboardingModel(services: services, onFinish: onFinish)
        if let startAt { model.path = Array(OnboardingModel.Step.allCases.prefix { $0 != startAt }) + [startAt] }
        _model = State(initialValue: model)
    }

    var body: some View {
        NavigationStack(path: $model.path) {
            WelcomeStep(model: model)
                .navigationDestination(for: OnboardingModel.Step.self) { step in
                    Group {
                        switch step {
                        case .agent: AgentStep(model: model)
                        case .capabilities: CapabilitiesStep(model: model)
                        case .theme: ThemeStep(model: model)
                        case .workspace: WorkspaceStep(model: model)
                        }
                    }
                    .toolbar(.hidden, for: .navigationBar)
                }
                .toolbar(.hidden, for: .navigationBar)
        }
    }
}

/// The frame every numbered step shares: navigation, progress, title and the call to action.
private struct StepScaffold<Content: View, Footer: View>: View {
    let step: OnboardingModel.Step
    let title: String
    let message: String
    @Bindable var model: OnboardingModel
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        let steps = OnboardingModel.Step.allCases
        let index = steps.firstIndex(of: step)!
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                BackButton { model.path.removeLast() }
                Spacer(minLength: 0)
                if step != .workspace {
                    DoneButton(title: "Skip", weight: 400) { Task { await model.finish() } }
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
            }
            .padding(.horizontal, 4)
            .frame(height: 48)
            HStack(spacing: 6) {
                ForEach(steps.indices, id: \.self) { i in
                    Capsule()
                        .fill(i == index ? Palette.fg : Palette.t300.opacity(i < index ? 0.7 : 0.25))
                        .frame(width: i == index ? 32 : 20, height: 4)
                }
                Text("\(index + 1) of \(steps.count)").textStyle(.stepProgress).foregroundStyle(Palette.t300).padding(.leading, 8)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(index + 1) of \(steps.count)")
            VStack(alignment: .leading, spacing: 6) {
                Text(title).textStyle(.stepTitle).foregroundStyle(Palette.fg).accessibilityAddTraits(.isHeader)
                Text(message).textStyle(.stepBody).foregroundStyle(Palette.t300).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 14)
            ScrollView {
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.top, 18)
                    .padding(.bottom, 12)
            }
            .scrollIndicators(.hidden)
            footer()
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 8)
        }
        .background(Palette.bg.ignoresSafeArea())
    }
}

private struct WelcomeStep: View {
    @Bindable var model: OnboardingModel
    @Environment(WorkspaceStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                ChroSymbol(size: 36)
                    .frame(width: 64, height: 64)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Palette.bg90))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.border))
                    .accessibilityLabel("Chro")
                Text("Welcome to Chro").textStyle(.welcomeTitle).foregroundStyle(Palette.fg).padding(.top, 18)
                Text("Run your coding agents as real teammates — assign a task, watch it work in an isolated worktree, review the diff. Four quick steps.")
                    .textStyle(.welcomeBody).foregroundStyle(Palette.t300).multilineTextAlignment(.center).padding(.top, 12)
            }
            .padding(.horizontal, 28)
            Spacer(minLength: 0)
            VStack(spacing: 4) {
                BigButton(title: "Get started") {
                    model.path.append(.agent)
                }
                if !store.projects.recents.isEmpty {
                    Button("I've done this before →") { Task { await model.finish() } }
                        .textStyle(.link).foregroundStyle(Palette.t300).padding(.horizontal, 8).frame(minHeight: 44).buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
        .background(Palette.bg.ignoresSafeArea())
    }
}

private struct AgentStep: View {
    @Bindable var model: OnboardingModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        StepScaffold(step: .agent, title: "Pick your coding agent",
                     message: "Chro detects the CLI agents already on your machine. Choose a default — you can install any that are missing and switch any time.",
                     model: model) {
            VStack(alignment: .leading, spacing: 0) {
                OnboardingCaption(text: "Tools")
                OnboardingCard(isSelected: false) {
                    Icon(.gitBranch, size: 20).foregroundStyle(Palette.t300).frame(width: 32, height: 32)
                    CardText(title: "Git", detail: gitDetail)
                    detection(model.install?.git, guide: nil)
                }
                OnboardingCaption(text: "Agent").padding(.top, 14)
                agentCard(.claudeCode, fallback: "Anthropic CLI agent", logoSize: 22)
                agentCard(.codex, fallback: "OpenAI CLI agent", logoSize: 20)
                agentCard(.pi, fallback: "pi CLI agent", logoSize: 20)
                Text("Not installed? Follow the agent's own install guide, then come back: Chro picks it up automatically. You'll sign in the first time you run the agent's CLI.")
                    .textStyle(.footnote).foregroundStyle(Palette.t300).padding(.top, 6)
            }
        } footer: {
            BigButton(title: "Continue", isEnabled: model.selectedAgent != nil) { Task { await model.confirmAgent() } }
        }
        .task { await model.checkInstall() }
    }

    private var gitDetail: String {
        if case .installed(let version?)? = model.install?.git { return "Detected · v\(version)" }
        if model.install?.git.isInstalled == true { return "Version control system" }
        return model.install == nil ? "Version control system" : "Not installed"
    }

    private func agentCard(_ agent: AgentKind, fallback: String, logoSize: CGFloat) -> some View {
        let detection = model.install?.agent(agent)
        let detail: String = switch detection {
        case .installed(let version?)?: "Detected · v\(version)"
        case .installed(nil)?: fallback
        case .notInstalled?: "Not installed"
        case nil: fallback
        }
        return OnboardingCard(isSelected: model.selectedAgent == agent) {
            Button { model.selectedAgent = agent } label: {
                HStack(spacing: 12) {
                    RadioMark(isOn: model.selectedAgent == agent)
                    AgentLogo(agent: agent, size: logoSize).foregroundStyle(Palette.t300).frame(width: 32, height: 32)
                    CardText(title: agent.displayName, detail: detail)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(model.selectedAgent == agent ? .isSelected : [])
            self.detection(detection, guide: AgentInstallGuide.url(for: agent))
        }
    }

    @ViewBuilder private func detection(_ detection: InstallStatus.Detection?, guide: URL?) -> some View {
        if model.isChecking || detection == nil {
            Spinner(size: 16).foregroundStyle(Palette.t300)
        } else if detection?.isInstalled == true {
            HStack(spacing: 4) {
                Icon(.check, size: 14)
                Text("Installed")
            }
            .textStyle(TextStyle(size: 12.5, weight: 500))
            .foregroundStyle(Palette.emerald500)
        } else if let guide {
            Button("Install guide") { openURL(guide) }
                .textStyle(.smallButton).foregroundStyle(Palette.fg)
                .padding(.horizontal, 12).frame(height: 36)
                .background(RoundedRectangle(cornerRadius: 4).fill(Palette.bg))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
                .buttonStyle(.plain)
                .minimumHitArea()
        } else {
            Text("Not installed").textStyle(.cardDetail).foregroundStyle(Palette.t300)
        }
    }
}

private struct CapabilitiesStep: View {
    @Bindable var model: OnboardingModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        StepScaffold(step: .capabilities, title: "Set up your agents",
                     message: "Choose what to set up so agents can hand work to each other through Chro, and so you can drive Chro from your own terminal.",
                     model: model) {
            VStack(alignment: .leading, spacing: 0) {
                CapabilityCard(icon: .bookOpen, title: "Teach agents to use chro", isOn: $model.skillCapability,
                               description: Text("Adds a short skill to Claude Code and Codex. It tells them when to hand work to another session, wait for it, or answer its approvals, and to load the commands with ") + Text("chro skill show").font(TextStyle.code(11.5).font(dynamicTypeSize)).foregroundColor(Palette.fg) + Text(". Agents outside Chro can see it too."),
                               caption: "Run this in a terminal to install it:", command: "chro skill install")
                CapabilityCard(icon: .terminal, title: "Use chro from your terminal", isOn: $model.commandCapability,
                               description: Text("Registers the ") + Text("chro").font(TextStyle.code(11.5).font(dynamicTypeSize)).foregroundColor(Palette.fg) + Text(" command in your shell. It links to this app and updates with it. Agents started by Chro have it already."),
                               caption: nil, command: "npm install -g @chro-ai/cli")
                Text("Only what is switched on is set up when you continue. You can change either later from Agent status in the title bar.")
                    .textStyle(.footnote).foregroundStyle(Palette.t300).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity).padding(.top, 6)
            }
        } footer: {
            BigButton(title: "Continue") { model.next(after: .capabilities) }
        }
    }
}

/// `.capcard`: a capability with its switch and, while on, the command to run.
private struct CapabilityCard: View {
    let icon: LucideName
    let title: String
    @Binding var isOn: Bool
    let description: Text
    let caption: String?
    let command: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Icon(icon, size: 20).foregroundStyle(Palette.t300)
                .frame(width: 40, height: 40).background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg80))
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    Text(title).textStyle(.cardTitle).foregroundStyle(Palette.fg).padding(.top, 4)
                    Spacer(minLength: 0)
                    Toggle(title, isOn: $isOn).labelsHidden().tint(Palette.primary)
                }
                description.textStyle(TextStyle(size: 12.5, lineHeight: 1.6)).foregroundStyle(Palette.t300).padding(.top, 4)
                if isOn {
                    VStack(alignment: .leading, spacing: 4) {
                        if let caption { Text(caption).textStyle(.cardDetail).foregroundStyle(Palette.t300) }
                        CommandLine(command: command)
                    }
                    .padding(.top, 8)
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg90))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
        .padding(.bottom, 10)
    }
}

/// `.capcmd code`: a command the user copies with a tap.
private struct CommandLine: View {
    let command: String
    @Environment(ToastCenter.self) private var toasts

    var body: some View {
        Button {
            UIPasteboard.general.string = command
            toasts.show("Copied to clipboard")
        } label: {
            Text(command).textStyle(.code(12)).foregroundStyle(Palette.fg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .frame(minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 4).fill(Palette.border.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border.opacity(0.8)))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Copies the command")
    }
}

private struct ThemeStep: View {
    @Bindable var model: OnboardingModel
    @AppStorage(ThemeChoice.storageKey) private var theme = ThemeChoice.system.rawValue

    var body: some View {
        StepScaffold(step: .theme, title: "Make it feel like home",
                     message: "Pick the look you'll stare at for hours. Changes preview instantly.", model: model) {
            VStack(spacing: 14) {
                HStack(spacing: 10) {
                    tile(.dark, labelLight: false) { ThemePreview(look: .dark) }
                    tile(.light, labelLight: true) { ThemePreview(look: .light) }
                    // System follows the device: half of each look.
                    tile(.system, labelLight: false) {
                        HStack(spacing: 0) {
                            ThemePreview(look: .light)
                            ThemePreview(look: .dark)
                        }
                    }
                }
                Text("You can fine-tune every color later in Settings → Appearance.")
                    .textStyle(.footnote).foregroundStyle(Palette.t300).multilineTextAlignment(.center)
            }
        } footer: {
            BigButton(title: "Continue") { model.next(after: .theme) }
        }
    }

    private func tile(_ choice: ThemeChoice, labelLight: Bool, @ViewBuilder preview: () -> some View) -> some View {
        let selected = theme == choice.rawValue
        return Button { theme = choice.rawValue } label: {
            VStack(spacing: 0) {
                preview().frame(height: 92)
                HStack {
                    Text(choice.label).textStyle(TextStyle(size: 13, weight: 500))
                    Spacer(minLength: 0)
                    if selected { Icon(.check, size: 14).foregroundStyle(Palette.primary) }
                }
                .foregroundStyle(labelLight ? Color(hex: 0x17181B) : Palette.fg)
                .padding(.horizontal, 12)
                .frame(minHeight: 40)
                .background(labelLight ? Color(hex: 0xF6F7F9) : Palette.bg)
                .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Palette.primary : Palette.border))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(choice.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A theme tile's sketch of a screen: two text lines and a primary button,
/// in the desktop's light or dark background, border and primary.
private struct ThemePreview: View {
    enum Look {
        case light, dark
        var surface: UInt32 { self == .light ? 0xFFFFFF : 0x1C1D21 }
        var line: UInt32 { self == .light ? 0xE6E8EC : 0x2B2D31 }
        var accent: UInt32 { self == .light ? 0x1B75C2 : 0x4BA3EC }
    }

    let look: Look

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Capsule().fill(Color(hex: look.line)).frame(height: 8).frame(maxWidth: .infinity, alignment: .leading).scaleEffect(x: 0.6, anchor: .leading)
            Capsule().fill(Color(hex: look.line)).frame(height: 8).scaleEffect(x: 0.4, anchor: .leading)
            Spacer(minLength: 0)
            RoundedRectangle(cornerRadius: 4).fill(Color(hex: look.accent)).frame(height: 20).scaleEffect(x: 0.8, anchor: .leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(hex: look.surface))
    }
}

private struct WorkspaceStep: View {
    @Bindable var model: OnboardingModel
    @State private var picking = false

    var body: some View {
        StepScaffold(step: .workspace, title: "Open your first project",
                     message: "Point Chro at a local repo. This is where your agents will work.", model: model) {
            VStack(spacing: 14) {
                Button { picking = true } label: {
                    HStack(spacing: 14) {
                        Icon(.folderOpen, size: 20).foregroundStyle(Palette.t300)
                            .frame(width: 40, height: 40).background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg80))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Open a folder").textStyle(.cardTitle).foregroundStyle(Palette.fg)
                            Text("Choose an existing folder on this machine — git repos are detected")
                                .textStyle(TextStyle(size: 12.5, lineHeight: 1.45)).foregroundStyle(Palette.t300)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                        Icon(.chevronRight, size: 18).foregroundStyle(Palette.t300)
                    }
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg90))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
                }
                .buttonStyle(.plain)
                Text("Chro creates an isolated worktree per task, so your main branch stays untouched.")
                    .textStyle(.footnote).foregroundStyle(Palette.t300).multilineTextAlignment(.center)
            }
        } footer: {
            // The desktop's last step ends on this note instead of Continue; the
            // phone keeps the step's action where every other step has its button.
            VStack(spacing: 8) {
                Text("Open a project to finish").textStyle(.footnote).foregroundStyle(Palette.t300)
                BigButton(title: "Open a folder") { picking = true }
            }
        }
        .navigationDestination(isPresented: $picking) {
            FolderPickerScreen(onCancel: { picking = false }) { project in
                Task { await model.finish(landing: .home(projectID: project.id)) }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

private struct OnboardingCaption: View {
    let text: String
    var body: some View {
        Text(text).textStyle(.stepCaption).foregroundStyle(Palette.t300).padding(.top, 4).padding(.bottom, 8)
    }
}

/// `.onb-card`
private struct OnboardingCard<Content: View>: View {
    let isSelected: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(spacing: 12) { content() }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(isSelected ? Palette.bg80 : Palette.bg90))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isSelected ? Palette.primary : Palette.border))
            .padding(.bottom, 8)
    }
}

private struct CardText: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).textStyle(.cardTitle).foregroundStyle(Palette.fg)
            Text(detail).textStyle(.cardDetail).foregroundStyle(Palette.t300).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
