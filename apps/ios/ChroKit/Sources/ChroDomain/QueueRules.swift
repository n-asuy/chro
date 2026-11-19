import Foundation

/// session/lib/session-queue.ts: what a queued message shows, how an edit
/// keeps its attachments, reordering, and when the composer queues.
public enum QueueRules {
    public struct Preview: Equatable, Sendable {
        public var text: String
        public var images: Int
        public var references: Int
        public var skills: Int

        public init(text: String, images: Int, references: Int, skills: Int) {
            self.text = text
            self.images = images
            self.references = references
            self.skills = skills
        }
    }

    public enum Intent: Equatable, Sendable { case send, queue }

    /// `{count} in queue`
    public static func headline(count: Int) -> String { "\(count) in queue" }

    public static func preview(_ prompt: String) -> Preview {
        let parsed = PromptContent.parse(prompt)
        var images = 0, references = 0, skills = 0
        for attachment in parsed.attachments {
            switch attachment {
            case .image: images += 1
            case .skill: skills += 1
            case .file, .session, .annotations: references += 1
            }
        }
        return Preview(text: parsed.text.trimmingCharacters(in: .whitespacesAndNewlines), images: images, references: references, skills: skills)
    }

    /// The markup the composer put in front, and the text the person wrote.
    public static func split(_ prompt: String) -> (prefix: String, text: String) {
        let text = PromptContent.parse(prompt).text
        guard !text.isEmpty else { return (prompt, "") }
        if prompt.hasSuffix(text) { return (String(prompt.dropLast(text.count)), text) }
        return ("", prompt)
    }

    /// The queued message with its written text replaced; attachments stay.
    public static func rewrite(_ prompt: String, text: String) -> String {
        let prefix = split(prompt).prefix
        if prefix.isEmpty || prefix.hasSuffix("\n") { return prefix + text }
        return "\(prefix)\n\(text)"
    }

    /// The order after dropping `from` onto `to`'s place.
    public static func move(_ ids: [String], from: String, to: String) -> [String] {
        guard let source = ids.firstIndex(of: from), let target = ids.firstIndex(of: to), source != target else { return ids }
        var next = ids.filter { $0 != from }
        next.insert(from, at: target)
        return next
    }

    /// A session takes one turn at a time: a message written while a turn runs,
    /// or while earlier messages still wait, joins the queue.
    public static func submitIntent(turnInFlight: Bool, waiting: Int) -> Intent {
        !turnInFlight && waiting == 0 ? .send : .queue
    }
}
