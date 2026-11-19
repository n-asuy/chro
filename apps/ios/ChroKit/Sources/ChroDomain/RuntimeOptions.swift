import Foundation

/// Reasoning effort (lib/agent-runtime-options.ts). The wire name of Extra High is `xhigh`.
public enum Effort: String, Sendable, CaseIterable, Codable, Hashable {
    case low, medium, high, xhigh, max, ultra

    public var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .xhigh: return "Extra High"
        case .max: return "Max"
        case .ultra: return "Ultra"
        }
    }

    public static let lowToMax: [Effort] = [.low, .medium, .high, .xhigh, .max]
    public static let lowToUltra: [Effort] = lowToMax + [.ultra]
}

public enum Speed: String, Sendable, Codable, Hashable {
    case fast
}

/// One entry of the model picker.
public struct ModelOption: Equatable, Sendable, Hashable, Identifiable {
    public var label: String
    public var value: String
    public var agent: AgentKind
    public var description: String
    public var efforts: [Effort]
    public var supportsFastSpeed: Bool
    public var id: String { value }

    public init(label: String, value: String, agent: AgentKind, description: String, efforts: [Effort], supportsFastSpeed: Bool) {
        self.label = label
        self.value = value
        self.agent = agent
        self.description = description
        self.efforts = efforts
        self.supportsFastSpeed = supportsFastSpeed
    }

    /// The picker's search: label, value or description, case-insensitive.
    public static func search(_ models: [ModelOption], query: String) -> [ModelOption] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return models }
        return models.filter { [$0.label, $0.value, $0.description].contains { $0.lowercased().contains(needle) } }
    }
}

/// What a new session (or a session's next turn) runs with.
public struct RuntimeChoice: Equatable, Sendable, Hashable {
    public var agent: AgentKind
    /// The model's label; nil is the agent's default.
    public var model: String?
    public var effort: Effort?
    public var speed: Speed?

    public init(agent: AgentKind, model: String? = nil, effort: Effort? = nil, speed: Speed? = nil) {
        self.agent = agent
        self.model = model
        self.effort = effort
        self.speed = speed
    }

    func option(in models: [ModelOption]) -> ModelOption? { models.first { $0.label == model } }

    /// With no known model, Claude and Codex offer low…max and pi none.
    public func efforts(in models: [ModelOption]) -> [Effort] {
        if let option = option(in: models) { return option.efforts }
        return agent == .pi ? [] : Effort.lowToMax
    }

    public func supportsFastSpeed(in models: [ModelOption]) -> Bool { option(in: models)?.supportsFastSpeed ?? false }

    /// Picking a model also picks its agent and drops settings it does not take.
    public mutating func pick(_ option: ModelOption) {
        model = option.label
        agent = option.agent
        if let current = effort, !option.efforts.contains(current) { effort = nil }
        if !option.supportsFastSpeed { speed = nil }
    }

    public mutating func switchRuntime(to agent: AgentKind) {
        guard agent != self.agent else { return }
        self = RuntimeChoice(agent: agent)
    }

    /// The composer pill: the model label, or the runtime's name for its default.
    public var pillLabel: String { model ?? agent.displayName }

    public var pillSecondary: String? {
        let parts = [effort?.label, speed == .fast ? "Fast" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
