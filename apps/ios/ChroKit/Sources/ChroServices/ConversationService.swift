import ChroDomain
import Foundation

/// The approval a session's latest run is blocked on: the agent's question or an MCP tool call.
public enum PendingApproval: Equatable, Sendable {
    case question(approvalID: String, questions: [QuestionPrompt.Question])
    case mcp(approvalID: String, prompt: McpApprovalPrompt)

    public var approvalID: String {
        switch self {
        case .question(let id, _), .mcp(let id, _): return id
        }
    }
}

/// How the user answered a pending approval.
public enum ApprovalResponse: Equatable, Sendable {
    case question(QuestionOutcome)
    case mcp(McpDecision)
}

/// A message waiting in the session's queue (`session_queue`); it becomes the next turn.
public struct QueuedPrompt: Identifiable, Equatable, Sendable, Hashable {
    public var id: String
    /// The prompt as it will be sent, with its context markup.
    public var prompt: String

    public init(id: String, prompt: String) {
        self.id = id
        self.prompt = prompt
    }
}

/// A row of the Refs sheet: a related session or a referenced path.
public struct SessionReference: Identifiable, Equatable, Sendable, Hashable {
    public enum Target: Equatable, Sendable, Hashable {
        case session(id: String)
        case path(String, isDirectory: Bool)
    }

    public var target: Target
    public var relation: SessionRelation

    public init(target: Target, relation: SessionRelation) {
        self.target = target
        self.relation = relation
    }

    public var id: String {
        switch target {
        case .session(let id): return "session:\(id):\(relation.rawValue)"
        case .path(let path, _): return "path:\(path):\(relation.rawValue)"
        }
    }
}

/// The branch chip's numbers and the conflict a rebase or merge stopped on.
public struct SessionBranchStatus: Equatable, Sendable {
    public struct Conflict: Equatable, Sendable {
        public var operation: ConflictOperation
        public var files: [String]

        public init(operation: ConflictOperation, files: [String]) {
            self.operation = operation
            self.files = files
        }
    }

    public var additions: Int
    public var deletions: Int
    public var commitsBehind: Int
    /// The branch the run integrates into (`branchStatus.target_branch`).
    public var targetBranch: String?
    public var conflict: Conflict?

    public init(additions: Int = 0, deletions: Int = 0, commitsBehind: Int = 0, targetBranch: String? = nil, conflict: Conflict? = nil) {
        self.additions = additions
        self.deletions = deletions
        self.commitsBehind = commitsBehind
        self.targetBranch = targetBranch
        self.conflict = conflict
    }
}

/// Everything the session screen shows besides the session's own summary.
public struct SessionConversation: Equatable, Sendable {
    public var sessionID: String
    /// The session's own entries, oldest first.
    public var entries: [ConversationEntry]
    /// Set when the session continues another one: drawn above `entries`.
    public var continuation: ContinuationOrigin?
    /// History has been replayed; an empty, unloaded conversation shows the spinner.
    public var isLoaded: Bool
    /// Older turns exist that are not loaded yet ("Load earlier history").
    public var hasEarlierHistory: Bool
    public var pendingApproval: PendingApproval?
    public var queue: [QueuedPrompt]
    public var references: [SessionReference]
    public var branchStatus: SessionBranchStatus
    /// Worktree or Local checkout (the branch chip's facts).
    public var usesWorktree: Bool
    /// What the next turn runs with: the model pill.
    public var runtime: RuntimeChoice
    /// A run exists, so the runtime is fixed.
    public var hasRun: Bool

    /// The runtime a new composer starts from: nil until the conversation has loaded, so
    /// the placeholder published before the runs arrive is never taken for the session's.
    public var composerSeed: RuntimeChoice? { isLoaded ? runtime : nil }

    public init(sessionID: String, entries: [ConversationEntry] = [], continuation: ContinuationOrigin? = nil, isLoaded: Bool = true, hasEarlierHistory: Bool = false, pendingApproval: PendingApproval? = nil,
                queue: [QueuedPrompt] = [], references: [SessionReference] = [], branchStatus: SessionBranchStatus = SessionBranchStatus(),
                usesWorktree: Bool = true, runtime: RuntimeChoice, hasRun: Bool) {
        self.sessionID = sessionID
        self.entries = entries
        self.continuation = continuation
        self.isLoaded = isLoaded
        self.hasEarlierHistory = hasEarlierHistory
        self.pendingApproval = pendingApproval
        self.queue = queue
        self.references = references
        self.branchStatus = branchStatus
        self.usesWorktree = usesWorktree
        self.runtime = runtime
        self.hasRun = hasRun
    }
}

extension SessionConversation {
    /// The id of the prompt shown for a session the phone just started.
    static func startedPromptID(_ sessionID: String) -> String { "\(sessionID):started-prompt" }
    static func startedLoadingID(_ sessionID: String) -> String { "\(sessionID):started-loading" }

    /// A session the phone just started, before its streams answer: the prompt as
    /// sent and the working sentinel, so the screen opens on the turn at work rather
    /// than on an empty page with a spinner (the desktop's pending submission).
    public static func started(sessionID: String, prompt: String, runtime: RuntimeChoice) -> SessionConversation {
        SessionConversation(sessionID: sessionID, entries: [ConversationEntry(id: startedPromptID(sessionID), runID: "", kind: .userMessage(prompt)),
                                                            ConversationEntry(id: startedLoadingID(sessionID), runID: "", kind: .loading(""))],
                            isLoaded: false, runtime: runtime, hasRun: true)
    }

    /// What to show when `incoming` arrives: `incoming`, keeping the started prompt
    /// in front until the streams deliver a prompt of their own, and the started
    /// sentinel until they deliver anything (from then on they decide whether the run works).
    public func superseded(by incoming: SessionConversation) -> SessionConversation {
        guard let prompt = entries.first, prompt.id == Self.startedPromptID(sessionID),
              !incoming.entries.contains(where: { $0.kind.userContent != nil })
        else { return incoming }
        var shown = incoming
        let working = entries.filter { $0.id == Self.startedLoadingID(sessionID) }
        shown.entries = [prompt] + (incoming.entries.isEmpty ? working : incoming.entries)
        return shown
    }
}

/// An image uploaded for a prompt; the prompt links it by path.
public struct UploadedImage: Equatable, Sendable {
    public var id: String
    public var name: String
    public var path: String

    public init(id: String, name: String, path: String) {
        self.id = id
        self.name = name
        self.path = path
    }
}

/// One session's conversation and what the session screen can do with it.
/// Session facts (title, running, branch) come from `SessionsService`.
public protocol ConversationService: Sendable {
    /// The conversation, kept current: the first value is the replayed history.
    func conversation(sessionID: String) -> AsyncStream<SessionConversation>
    /// Loads the next page of older turns (the desktop loads three runs at a time).
    func loadEarlierHistory(sessionID: String) async
    /// Send the next turn. The prompt carries its context markup (`PromptContent.format`).
    func send(sessionID: String, prompt: String, runtime: RuntimeChoice, imageIDs: [String]) async throws
    /// Queue a prompt while a turn runs.
    func enqueue(sessionID: String, prompt: String) async throws
    func updateQueued(sessionID: String, itemID: String, prompt: String) async throws
    func removeQueued(sessionID: String, itemID: String) async throws
    /// Move a queued prompt to `index` (0 runs next).
    func moveQueued(sessionID: String, itemID: String, to index: Int) async throws
    /// Stop the running turn and send this queued prompt now.
    func sendQueuedNow(sessionID: String, itemID: String) async throws
    func stop(sessionID: String) async throws
    func respond(sessionID: String, approvalID: String, response: ApprovalResponse) async throws
    func rename(sessionID: String, title: String) async throws
    /// "Continue in a new session from here": fork at a turn's run into a new idle session.
    func continueFromRun(sessionID: String, runID: String) async throws -> SessionSummary
    /// Abort the rebase or merge that stopped on conflicts.
    func abortConflict(sessionID: String) async throws
    /// Upload an image for the session's next prompt.
    func uploadImage(sessionID: String, data: Data, fileName: String, contentType: String) async throws -> UploadedImage
    /// The bytes of an image a prompt links (its markdown path), for the full-screen viewer.
    func image(sessionID: String, path: String) async throws -> Data
}
