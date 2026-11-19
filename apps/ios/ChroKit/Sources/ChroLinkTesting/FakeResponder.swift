import Foundation
@testable import ChroLink

/// Device tokens a fake desktop accepts, with the registry's two-stage ticket
/// exchange (crates/mobile-link storage.rs): an exchange records the proposed
/// token beside the ticket, the same proposal may be exchanged again, another
/// one is refused while it is pending, and the first authentication with the
/// proposal commits it and retires the ticket. Shared by the responders of one
/// fake desktop so an exchange on one connection holds on the next.
final class FakeTokenBook: @unchecked Sendable {
    enum ExchangeOutcome: Equatable {
        case exchanged
        case pending
        case notATicket
    }

    private let lock = NSLock()
    private var accepted: Set<String>
    private var exchanges: [String] = []
    /// Ticket → the proposal waiting for its first authentication.
    private var proposals: [String: String] = [:]

    init(_ accepted: Set<String> = [FakeResponder.ticket]) {
        self.accepted = accepted
    }

    func accepts(_ token: String) -> Bool {
        lock.withLock { accepted.contains(token) || proposals.values.contains(token) }
    }

    func accept(_ token: String) { _ = lock.withLock { accepted.insert(token) } }
    func revoke(_ token: String) { _ = lock.withLock { accepted.remove(token) } }
    /// Tokens the phone exchanged its ticket for, in order (a repeated proposal once).
    var exchanged: [String] { lock.withLock { exchanges } }
    /// Whether `ticket` still authenticates.
    func isLive(_ ticket: String) -> Bool { lock.withLock { accepted.contains(ticket) } }

    fileprivate func exchange(_ ticket: String, for token: String) -> ExchangeOutcome {
        lock.withLock {
            guard accepted.contains(ticket) else { return .notATicket }
            if let pending = proposals[ticket] { return pending == token ? .exchanged : .pending }
            proposals[ticket] = token
            exchanges.append(token)
            return .exchanged
        }
    }

    /// An authentication with `token`: a pending proposal becomes the device's token.
    fileprivate func authenticated(_ token: String) {
        lock.withLock {
            guard let ticket = proposals.first(where: { $0.value == token })?.key else { return }
            proposals[ticket] = nil
            accepted.remove(ticket)
            accepted.insert(token)
        }
    }
}

/// The desktop's side of E2EE v2 and of the device RPC, in process. It checks
/// the phone's hello and auth as strictly as the host must, answers the device
/// dispatcher's methods exactly as architecture doc §4.1 specifies (strict
/// params, the capabilities gate, the three `request` result shapes, binary
/// frames both ways, subscriptions), and can misbehave on purpose for the
/// rejection tests. Every departure of the phone from §4.1 is recorded in
/// `violations`.
final class FakeResponder: @unchecked Sendable {
    enum HandshakeBehavior: @unchecked Sendable {
        case honest
        /// Edits the ready object before it is sent.
        case mutateReady((inout [String: Any]) -> Void)
        case binaryInsteadOfReady
        case closeAfterHello(code: Int, reason: String)
        case silentAfterHello
        /// Answers auth with a sealed `e2ee_error` and closes 4001.
        case rejectAuth(code: String)
        case wrongAuthenticatedHash
        case silentAfterAuth
    }

    struct Request: Sendable, Equatable {
        let id: String
        let deviceToken: String
        let method: String
        /// `params` as JSON text.
        let params: Data
        /// The envelope's keys in wire order.
        let keyOrder: [String]

        var paramsObject: [String: Any] { (try? JSONSerialization.jsonObject(with: params)) as? [String: Any] ?? [:] }
    }

    enum Reply {
        case result(String)
        case error(code: String, message: String)
        /// No answer at all (for timeouts).
        case silence
        /// The dispatcher's own answer (§4.1).
        case standard
        /// The dispatcher acts but its answer is lost (an uncertain outcome).
        /// Only `pairing.exchangeTicket` supports it.
        case standardAnswerLost
    }

    /// One `request` as the router receives it.
    struct HTTPRequest: Sendable, Equatable {
        struct Upload: Sendable, Equatable {
            let field: String
            let fileName: String
            let contentType: String
            let data: Data
        }

        let method: String
        let path: String
        let query: [String: String]
        /// The JSON body as text, when there is one.
        let body: Data?
        let requestId: String?
        let upload: Upload?

        var bodyObject: Any? { body.flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) } }
    }

    /// The router's answer to a `request`.
    enum HTTPReply: Sendable {
        /// `application/json`: answered as text `{status, body}`.
        case json(status: Int, String)
        /// `text/*`: answered as text `{status, contentType, text}`.
        case text(status: Int, contentType: String, String)
        /// Anything else: answered in binary frames.
        case binary(status: Int, contentType: String, Data)
        /// No body: `{status, body:null}`.
        case empty(status: Int)
        /// Not on the allowlist: RPC error `forbidden`.
        case forbidden
        case silence
    }

    /// One `subscribe` the phone holds.
    struct Subscription: Sendable, Equatable {
        let requestId: String
        let subscriptionId: String
        let stream: String
        /// `params`, values as the phone sent them (as text).
        let params: [String: String]
    }

    static let ticketExchangeCapability = "pairing.ticket-exchange.v1"
    static let ticket = String(repeating: "ab", count: 24)
    static let apiGeneration = 1
    /// Server limits (crates/server/src/mobile): chunk size, binary reply total, upload total,
    /// listener message size.
    static let chunkBytes = 768 * 1024
    static let maxUploadBytes = 20 * 1024 * 1024
    static let maxInboundMessageBytes = 1024 * 1024
    static let maxSubscriptions = 64
    /// The stream templates of §4.1.
    static let streamTemplates: Set<String> = [
        "/streams/tasks", "/streams/tasks/:task_id/runs", "/streams/tasks/:task_id/sessions", "/streams/tasks/:task_id/queue",
        "/streams/task-drafts", "/streams/task-runs/:id/logs", "/streams/task-runs/:id/repo-events",
        "/streams/projects/:project_id/repo-events", "/rpc/task-runs/:id/diff", "/streams/session-list",
    ]

    let secretKey: Data
    let publicKey: Data
    let behavior: HandshakeBehavior
    let tokens: FakeTokenBook
    /// Answers RPC methods; `.standard` falls back to the dispatcher's answers.
    let handler: @Sendable (Request) -> Reply
    /// The router behind `request`.
    let routes: @Sendable (HTTPRequest) -> HTTPReply
    /// The messages a new subscription starts with (its snapshot).
    let snapshot: @Sendable (Subscription) -> [String]
    /// What the host advertises in `status.get` and the capabilities update.
    let hostCapabilities: [String]

    private let lock = NSLock()
    /// Orders sealing with delivery (see `sendSealed`).
    private let sendLock = NSLock()
    private var held: [LinkMessage] = []
    private var socket: (any LinkSocket)?
    private var sealer: FrameSealer?
    private var opener: FrameOpener?
    private var keys: SessionKeys?
    private var requestLog: [Request] = []
    private var httpLog: [HTTPRequest] = []
    private var phoneFrames: [LinkMessage] = []
    private var problems: [String] = []
    private var authenticatedFlag = false
    private var authToken: String?
    private var apiDeclared = false
    /// Capabilities updates the test answers by hand.
    private var heldCapabilities: Set<String> = []
    private var subscriptionTable: [Subscription] = []
    private var subscriptionCount = 0
    private var uploadAssemblies: [String: (header: [String: Any], body: Data, next: Int)] = [:]

    init(
        secretKey: Data = Data((1...32).map { UInt8($0) &* 7 }),
        behavior: HandshakeBehavior = .honest,
        acceptedTokens: Set<String> = [FakeResponder.ticket],
        tokens: FakeTokenBook? = nil,
        handler: @escaping @Sendable (Request) -> Reply = { _ in .standard },
        routes: @escaping @Sendable (HTTPRequest) -> HTTPReply = { _ in .forbidden },
        snapshot: @escaping @Sendable (Subscription) -> [String] = { _ in [] },
        capabilities: [String] = [FakeResponder.ticketExchangeCapability]
    ) {
        self.secretKey = secretKey
        self.publicKey = try! NaCl.publicKey(secretKey: secretKey)
        self.behavior = behavior
        self.tokens = tokens ?? FakeTokenBook(acceptedTokens)
        self.handler = handler
        self.routes = routes
        self.snapshot = snapshot
        hostCapabilities = capabilities
    }

    private var capabilitiesJSON: String {
        String(decoding: try! JSONSerialization.data(withJSONObject: hostCapabilities), as: UTF8.self)
    }

    var requests: [Request] { lock.withLock { requestLog } }
    /// Every `request` that reached the router, uploads included.
    var httpRequests: [HTTPRequest] { lock.withLock { httpLog } }
    /// Raw frames the phone sent after authenticating.
    var framesFromPhone: [LinkMessage] { lock.withLock { phoneFrames } }
    /// Contract violations seen in the phone's messages; must stay empty.
    var violations: [String] { lock.withLock { problems } }
    var isAuthenticated: Bool { lock.withLock { authenticatedFlag } }
    var authenticatedToken: String? { lock.withLock { authToken } }
    var closedByPhone: SocketClosed? { (lock.withLock { socket } as? ClosingObservable)?.closed }
    var subscriptions: [Subscription] { lock.withLock { subscriptionTable } }

    func requests(_ method: String) -> [Request] { requests.filter { $0.method == method } }

    // MARK: Serving

    func serve(_ socket: any LinkSocket) {
        lock.withLock { self.socket = socket }
        Task { await self.run(socket) }
    }

    private func violation(_ text: String) {
        lock.withLock { problems.append(text) }
    }

    private func run(_ socket: any LinkSocket) async {
        do {
            guard case .text(let helloText) = try await socket.receive() else {
                violation("first message is not text")
                socket.close(code: 4001, reason: "Invalid handshake message")
                return
            }
            guard let hello = checkHello(helloText) else {
                socket.close(code: 4001, reason: "Invalid handshake message")
                return
            }
            switch behavior {
            case .binaryInsteadOfReady:
                try await socket.send(.binary(Data([1, 2, 3])))
                return
            case .closeAfterHello(let code, let reason):
                socket.close(code: code, reason: reason)
                return
            case .silentAfterHello:
                return
            default: break
            }
            let desktopNonce = Data(repeating: 0x5A, count: 32)
            var ready: [String: Any] = [
                "type": "e2ee_ready", "v": 2,
                "desktopPublicKeyB64": publicKey.base64EncodedString(),
                "clientNonceB64": hello.nonce.base64EncodedString(),
                "desktopNonceB64": desktopNonce.base64EncodedString(),
                "selection": ["framing": 2, "payloadKinds": ["text", "binary"]],
                "context": ["protocol": "chro-mobile-e2ee", "initiator": "mobile", "responder": "desktop", "transport": "direct"],
            ]
            if case .mutateReady(let edit) = behavior { edit(&ready) }
            let readyText = String(decoding: try JSONSerialization.data(withJSONObject: ready, options: [.sortedKeys]), as: UTF8.self)
            try await socket.send(.text(readyText))

            let shared = try NaCl.boxBeforeNM(publicKey: hello.publicKey, secretKey: secretKey)
            let transcript = Transcript.encode(context: .direct, clientPublicKey: hello.publicKey, clientNonce: hello.nonce, desktopPublicKey: publicKey, desktopNonce: desktopNonce)
            let keys = KeySchedule.derive(shared: shared, clientNonce: hello.nonce, desktopNonce: desktopNonce, transcript: transcript)
            lock.withLock {
                self.keys = keys
                self.sealer = FrameSealer(keys: keys, direction: .desktopToMobile)
                self.opener = FrameOpener(keys: keys, direction: .mobileToDesktop)
            }

            guard case .text(let authText) = try await socket.receive(),
                  let authFrame = try? CanonicalBase64.decode(authText),
                  let authPayload = try? openFromPhone(kind: .text, frame: authFrame),
                  let auth = (try? JSONSerialization.jsonObject(with: authPayload)) as? [String: Any]
            else {
                violation("auth frame does not open")
                socket.close(code: 4001, reason: "Invalid e2ee_auth")
                return
            }
            if Set(auth.keys) != ["type", "v", "transcriptHashB64", "deviceToken"] { violation("auth keys \(auth.keys.sorted())") }
            if auth["type"] as? String != "e2ee_auth" || (auth["v"] as? Int) != 2 { violation("auth type/v") }
            if auth["transcriptHashB64"] as? String != keys.transcriptHash.base64EncodedString() { violation("auth transcript hash") }
            let token = auth["deviceToken"] as? String ?? ""

            switch behavior {
            case .rejectAuth(let code):
                try await sendSealed(Data("{\"type\":\"e2ee_error\",\"error\":{\"code\":\"\(code)\"}}".utf8))
                socket.close(code: 4001, reason: "Unauthorized")
                return
            case .wrongAuthenticatedHash:
                try await sendSealed(Data("{\"type\":\"e2ee_authenticated\",\"v\":2,\"transcriptHashB64\":\"\(Data(repeating: 9, count: 32).base64EncodedString())\"}".utf8))
            case .silentAfterAuth:
                return
            default:
                guard tokens.accepts(token) else {
                    try await sendSealed(Data("{\"type\":\"e2ee_error\",\"error\":{\"code\":\"unauthorized\"}}".utf8))
                    socket.close(code: 4001, reason: "Unauthorized")
                    return
                }
                tokens.authenticated(token)
                lock.withLock {
                    authenticatedFlag = true
                    authToken = token
                }
                try await sendSealed(Data("{\"type\":\"e2ee_authenticated\",\"v\":2,\"transcriptHashB64\":\"\(keys.transcriptHash.base64EncodedString())\"}".utf8))
            }

            while true {
                let message = try await socket.receive()
                lock.withLock { phoneFrames.append(message) }
                switch message {
                case .binary(let frame):
                    if frame.count > Self.maxInboundMessageBytes { violation("binary message of \(frame.count) bytes exceeds the listener's 1 MiB") }
                    guard let payload = try? openFromPhone(kind: .binary, frame: frame) else {
                        violation("binary frame does not open")
                        continue
                    }
                    await handleBinary(payload)
                case .text(let text):
                    if text.utf8.count > Self.maxInboundMessageBytes { violation("text message of \(text.utf8.count) bytes exceeds the listener's 1 MiB") }
                    guard let frame = try? CanonicalBase64.decode(text), let payload = try? openFromPhone(kind: .text, frame: frame) else {
                        violation("text frame does not open")
                        continue
                    }
                    await handleRequest(payload)
                }
            }
        } catch {
            // The socket ended.
        }
    }

    private struct Hello {
        let publicKey: Data
        let nonce: Data
    }

    /// The hello checks of spec §3.2 that a strict host performs.
    private func checkHello(_ text: String) -> Hello? {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
            violation("hello is not JSON")
            return nil
        }
        var ok = true
        func require(_ condition: Bool, _ what: String) {
            if !condition {
                ok = false
                violation("hello \(what)")
            }
        }
        require(Set(object.keys) == ["type", "v", "clientPublicKeyB64", "clientNonceB64", "capabilities", "context"], "keys")
        require(object["type"] as? String == "e2ee_hello", "type")
        require(JSONShape.isInteger(object["v"], equalTo: 2), "v")
        let capabilities = object["capabilities"] as? [String: Any] ?? [:]
        require(Set(capabilities.keys) == ["framing", "payloadKinds"], "capabilities keys")
        require((capabilities["framing"] as? [Int]) == [2], "framing")
        require((capabilities["payloadKinds"] as? [String]) == ["text", "binary"], "payloadKinds")
        let context = object["context"] as? [String: String] ?? [:]
        require(context == ["protocol": "chro-mobile-e2ee", "initiator": "mobile", "responder": "desktop", "transport": "direct"], "context")
        let publicKey = (object["clientPublicKeyB64"] as? String).flatMap { try? CanonicalBase64.decode($0, count: 32) }
        let nonce = (object["clientNonceB64"] as? String).flatMap { try? CanonicalBase64.decode($0, count: 32) }
        require(publicKey != nil, "clientPublicKeyB64")
        require(nonce != nil, "clientNonceB64")
        guard ok, let publicKey, let nonce else { return nil }
        return Hello(publicKey: publicKey, nonce: nonce)
    }

    private func openFromPhone(kind: FrameKind, frame: Data) throws -> Data {
        try lock.withLock {
            guard var opener else { throw FrameError.authenticationFailed }
            defer { self.opener = opener }
            return try opener.open(kind: kind, frame: frame)
        }
    }

    // MARK: Text requests

    private func handleRequest(_ payload: Data) async {
        guard let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
              let id = object["id"] as? String, let method = object["method"] as? String,
              let token = object["deviceToken"] as? String, let params = object["params"]
        else {
            violation("request envelope \(String(decoding: payload, as: UTF8.self))")
            try? await respondError(id: "unknown", code: "bad_request", message: "not a request")
            return
        }
        let request = Request(
            id: id,
            deviceToken: token,
            method: method,
            params: (try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys, .fragmentsAllowed])) ?? Data(),
            keyOrder: Self.keyOrder(payload)
        )
        lock.withLock { requestLog.append(request) }
        if token != authenticatedToken {
            violation("request \(method) carries another device token")
            try? await respondError(id: id, code: "unauthorized", message: "Device token mismatch")
            return
        }
        let reply = handler(request)
        switch reply {
        case .standard:
            await dispatch(request)
            return
        case .standardAnswerLost:
            if method != "pairing.exchangeTicket" { violation("an answerless \(method) is not modelled") }
            await dispatch(request, answerless: true)
            return
        default: break
        }
        if method == "runtime.clientCapabilities.update" {
            switch reply {
            case .result: lock.withLock { apiDeclared = true }
            case .silence: _ = lock.withLock { heldCapabilities.insert(id) }
            default: break
            }
        }
        switch reply {
        case .result(let json): try? await respond(id: id, result: json)
        case .error(let code, let message): try? await respondError(id: id, code: code, message: message)
        case .silence, .standard, .standardAnswerLost: break
        }
    }

    /// The device dispatcher (crates/server/src/mobile/dispatch.rs).
    private func dispatch(_ request: Request, answerless: Bool = false) async {
        let id = request.id
        let params = request.paramsObject
        switch request.method {
        case "runtime.clientCapabilities.update":
            guard Set(params.keys) == ["clientCapabilities", "apiGeneration"], params["clientCapabilities"] is [String],
                  let generation = params["apiGeneration"] as? Int
            else {
                violation("capabilities params \(params.keys.sorted())")
                try? await respondError(id: id, code: "invalid_argument", message: "capabilities params")
                return
            }
            guard generation == Self.apiGeneration else {
                try? await respondError(id: id, code: "incompatible_api", message: "this chro speaks device API generation \(Self.apiGeneration)")
                return
            }
            lock.withLock { apiDeclared = true }
            try? await respond(id: id, result: "{\"apiGeneration\":\(Self.apiGeneration),\"capabilities\":\(capabilitiesJSON)}")
        case "status.get":
            try? await respond(id: id, result: "{\"apiGeneration\":\(Self.apiGeneration),\"capabilities\":\(capabilitiesJSON),\"machineName\":\"studio\",\"version\":\"0.1.0\",\"runtimeId\":\"rt-1\",\"deviceId\":\"device-1\"}")
        case "pairing.exchangeTicket":
            guard Set(params.keys) == ["deviceToken"], let fresh = params["deviceToken"] as? String,
                  (48...128).contains(fresh.count), fresh.allSatisfy({ $0.isHexDigit && !$0.isUppercase })
            else {
                violation("exchangeTicket params")
                try? await respondError(id: id, code: "invalid_argument", message: "deviceToken must be 48 to 128 lowercase hex characters")
                return
            }
            let outcome = authenticatedToken == Self.ticket ? tokens.exchange(Self.ticket, for: fresh) : .notATicket
            if answerless { return }
            switch outcome {
            case .exchanged:
                try? await respond(id: id, result: "{\"deviceId\":\"device-1\"}")
            case .pending:
                try? await respondError(id: id, code: "ticket_exchange_pending", message: "another token is already pending for this ticket")
            case .notATicket:
                try? await respondError(id: id, code: "not_a_ticket", message: "only a connection opened with the QR ticket can exchange it")
            }
        case "request":
            guard gate(request) else { return await refuseBeforeCapabilities(id) }
            switch Self.httpRequest(params, upload: nil) {
            case .success(let http):
                if http.upload != nil {
                    try? await respondError(id: id, code: "invalid_argument", message: "uploads travel in binary frames")
                    return
                }
                await route(id: id, http)
            case .failure(let problem):
                violation("request params: \(problem)")
                try? await respondError(id: id, code: "invalid_argument", message: problem.description)
            }
        case "subscribe":
            guard gate(request) else { return await refuseBeforeCapabilities(id) }
            await subscribe(id: id, params)
        case "subscribe.unsubscribe":
            guard Set(params.keys) == ["subscriptionId"], let subscriptionId = params["subscriptionId"] as? String else {
                violation("unsubscribe params")
                try? await respondError(id: id, code: "invalid_argument", message: "unsubscribe params")
                return
            }
            let removed = lock.withLock { () -> Bool in
                guard let index = subscriptionTable.firstIndex(where: { $0.subscriptionId == subscriptionId }) else { return false }
                subscriptionTable.remove(at: index)
                return true
            }
            if removed {
                try? await respond(id: id, result: "{}")
            } else {
                try? await respondError(id: id, code: "not_found", message: "no subscription \(subscriptionId)")
            }
        default:
            try? await respondError(id: id, code: "method_not_found", message: "no method \(request.method)")
        }
    }

    private func gate(_ request: Request) -> Bool {
        let declared = lock.withLock { apiDeclared }
        if !declared { violation("\(request.method) sent before runtime.clientCapabilities.update succeeded") }
        return declared
    }

    private func refuseBeforeCapabilities(_ id: String) async {
        try? await respondError(id: id, code: "incompatible_api", message: "declare the device API generation with runtime.clientCapabilities.update first")
    }

    /// `request` params as dispatch.rs's `RequestParams` reads them (`deny_unknown_fields`).
    struct ParamsProblem: Error, CustomStringConvertible { let description: String }

    static func httpRequest(_ params: [String: Any], upload: Data?) -> Result<HTTPRequest, ParamsProblem> {
        let known: Set<String> = ["method", "path", "query", "body", "requestId", "upload"]
        let unknown = Set(params.keys).subtracting(known)
        guard unknown.isEmpty else { return .failure(ParamsProblem(description: "unknown field \(unknown.sorted())")) }
        guard let method = params["method"] as? String, ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else {
            return .failure(ParamsProblem(description: "unsupported method \(String(describing: params["method"]))"))
        }
        guard let path = params["path"] as? String, path.hasPrefix("/"), !path.contains("?"), !path.contains("#"), !path.contains(" ") else {
            return .failure(ParamsProblem(description: "path must be an absolute path without query or fragment"))
        }
        var query: [String: String] = [:]
        if let raw = params["query"] {
            guard let object = raw as? [String: Any] else { return .failure(ParamsProblem(description: "query must be an object")) }
            for (name, value) in object {
                guard let text = value as? String else { return .failure(ParamsProblem(description: "query value of \(name) is not a string")) }
                query[name] = text
            }
        }
        let requestId: String?
        switch params["requestId"] {
        case nil: requestId = nil
        case let value as String: requestId = value
        default: return .failure(ParamsProblem(description: "requestId must be a string"))
        }
        var body: Data?
        if let raw = params["body"], !(raw is NSNull) {
            body = try? JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys, .fragmentsAllowed])
        }
        var part: HTTPRequest.Upload?
        if let raw = params["upload"] {
            guard let object = raw as? [String: Any], Set(object.keys) == ["field", "fileName", "contentType"],
                  let field = object["field"] as? String, let fileName = object["fileName"] as? String,
                  let contentType = object["contentType"] as? String
            else { return .failure(ParamsProblem(description: "upload must be {field, fileName, contentType}")) }
            part = HTTPRequest.Upload(field: field, fileName: fileName, contentType: contentType, data: upload ?? Data())
            if body != nil { return .failure(ParamsProblem(description: "an upload's body is the binary payload")) }
        }
        return .success(HTTPRequest(method: method, path: path, query: query, body: body, requestId: requestId, upload: part))
    }

    private func route(id: String, _ http: HTTPRequest) async {
        lock.withLock { httpLog.append(http) }
        switch routes(http) {
        case .json(let status, let body):
            try? await respond(id: id, result: "{\"status\":\(status),\"body\":\(body)}")
        case .text(let status, let contentType, let text):
            let result = try! JSONSerialization.data(withJSONObject: ["status": status, "contentType": contentType, "text": text], options: [.sortedKeys])
            try? await respond(id: id, result: String(decoding: result, as: UTF8.self))
        case .empty(let status):
            try? await respond(id: id, result: "{\"status\":\(status),\"body\":null}")
        case .binary(let status, let contentType, let data):
            try? await sendBinaryReply(id: id, status: status, contentType: contentType, data: data)
        case .forbidden:
            try? await respondError(id: id, code: "forbidden", message: "this endpoint is not available to paired devices")
        case .silence:
            break
        }
    }

    // MARK: Subscriptions

    private func subscribe(id: String, _ params: [String: Any]) async {
        guard Set(params.keys).isSubset(of: ["stream", "params"]), let stream = params["stream"] as? String else {
            violation("subscribe params \(params.keys.sorted())")
            try? await respondError(id: id, code: "invalid_argument", message: "subscribe params")
            return
        }
        var values: [String: String] = [:]
        for (name, value) in params["params"] as? [String: Any] ?? [:] {
            switch value {
            case let text as String: values[name] = text
            case let number as NSNumber: values[name] = number.stringValue
            default:
                try? await respondError(id: id, code: "invalid_argument", message: "parameters must be strings, numbers or booleans")
                return
            }
        }
        guard Self.streamTemplates.contains(stream) else {
            try? await respondError(id: id, code: "not_found", message: "no stream \(stream)")
            return
        }
        let subscription = lock.withLock { () -> Subscription? in
            guard subscriptionTable.count < Self.maxSubscriptions else { return nil }
            subscriptionCount += 1
            let subscription = Subscription(requestId: id, subscriptionId: "sub-\(subscriptionCount)", stream: stream, params: values)
            subscriptionTable.append(subscription)
            return subscription
        }
        guard let subscription else {
            try? await respondError(id: id, code: "runtime_busy", message: "at most 64 subscriptions per connection")
            return
        }
        try? await respond(id: id, result: "{\"type\":\"ready\",\"subscriptionId\":\"\(subscription.subscriptionId)\"}", streaming: true)
        for message in snapshot(subscription) { try? await push(message, to: subscription.subscriptionId) }
    }

    /// Sends one stream message (`data` is the JSON the desktop's WebSocket would send).
    func push(_ data: String, to subscriptionId: String) async throws {
        guard let subscription = subscriptions.first(where: { $0.subscriptionId == subscriptionId }) else { return }
        try await respond(id: subscription.requestId, result: "{\"type\":\"message\",\"subscriptionId\":\"\(subscriptionId)\",\"data\":\(data)}", streaming: true)
    }

    /// Ends a subscription from the server side, optionally with an error.
    func endSubscription(_ subscriptionId: String, error: (code: String, message: String)? = nil) async throws {
        let subscription = lock.withLock { () -> Subscription? in
            guard let index = subscriptionTable.firstIndex(where: { $0.subscriptionId == subscriptionId }) else { return nil }
            return subscriptionTable.remove(at: index)
        }
        guard let subscription else { return }
        let errorPart = error.map { ",\"error\":{\"code\":\"\($0.code)\",\"message\":\"\($0.message)\",\"data\":null}" } ?? ""
        try await respond(id: subscription.requestId, result: "{\"type\":\"end\",\"subscriptionId\":\"\(subscriptionId)\"\(errorPart)}", streaming: true)
    }

    // MARK: Binary frames

    /// `0x01 ‖ u32be(header_len) ‖ header JSON ‖ chunk` (binary.rs).
    static func binaryFrame(header: [String: Any], chunk: Data) -> Data {
        let json = try! JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
        var out = Data([1])
        var length = UInt32(json.count).bigEndian
        out.append(Data(bytes: &length, count: 4))
        out.append(json)
        out.append(chunk)
        return out
    }

    static func decodeBinaryFrame(_ payload: Data) -> (header: [String: Any], chunk: Data)? {
        let bytes = [UInt8](payload)
        guard bytes.count >= 5, bytes[0] == 1 else { return nil }
        let length = Int(bytes[1]) << 24 | Int(bytes[2]) << 16 | Int(bytes[3]) << 8 | Int(bytes[4])
        guard 5 + length <= bytes.count,
              let header = (try? JSONSerialization.jsonObject(with: Data(bytes[5..<(5 + length)]))) as? [String: Any]
        else { return nil }
        return (header, Data(bytes[(5 + length)...]))
    }

    /// A binary reply: `{id, seq:0, final, ok:true, result:{status, contentType, contentLength}}` first, 768 KiB chunks.
    func sendBinaryReply(id: String, status: Int, contentType: String, data: Data) async throws {
        var chunks: [Data] = stride(from: 0, to: data.count, by: Self.chunkBytes).map { data.subdata(in: $0..<min($0 + Self.chunkBytes, data.count)) }
        if chunks.isEmpty { chunks = [Data()] }
        for (seq, chunk) in chunks.enumerated() {
            var header: [String: Any] = ["id": id, "seq": seq, "final": seq == chunks.count - 1]
            if seq == 0 {
                header["ok"] = true
                header["result"] = ["status": status, "contentType": contentType, "contentLength": data.count]
            }
            try await sendSealed(Self.binaryFrame(header: header, chunk: chunk), kind: .binary)
        }
    }

    /// Upload chunks from the phone, reassembled as dispatch.rs does.
    private func handleBinary(_ payload: Data) async {
        guard let (header, chunk) = Self.decodeBinaryFrame(payload) else {
            violation("binary frame layout")
            try? await respondError(id: "unknown", code: "bad_request", message: "binary frame")
            return
        }
        guard let id = header["id"] as? String, !id.isEmpty, let seq = header["seq"] as? Int, let isFinal = header["final"] as? Bool else {
            violation("binary frame header \(header.keys.sorted())")
            try? await respondError(id: "unknown", code: "bad_request", message: "binary frame header")
            return
        }
        if chunk.count > Self.chunkBytes { violation("chunk of \(chunk.count) bytes exceeds 768 KiB") }
        if seq == 0 {
            guard header["deviceToken"] as? String == authenticatedToken, header["method"] as? String == "request" else {
                violation("upload envelope \(header.keys.sorted())")
                try? await respondError(id: id, code: "unauthorized", message: "Device token mismatch")
                return
            }
            guard lock.withLock({ apiDeclared }) else {
                violation("upload sent before runtime.clientCapabilities.update succeeded")
                return await refuseBeforeCapabilities(id)
            }
            if !isFinal {
                if Set(header.keys) != ["id", "seq", "final", "deviceToken", "method", "params"] { violation("first upload header keys \(header.keys.sorted())") }
                lock.withLock { uploadAssemblies[id] = (header, chunk, 1) }
                return
            }
            await finishUpload(id: id, header: header, body: chunk)
            return
        }
        if Set(header.keys) != ["id", "seq", "final"] { violation("later upload header keys \(header.keys.sorted())") }
        let assembled = lock.withLock { () -> (header: [String: Any], body: Data)?? in
            guard var assembly = uploadAssemblies[id] else { return .some(nil) }
            guard seq == assembly.next else {
                uploadAssemblies[id] = nil
                return .some(nil)
            }
            assembly.body.append(chunk)
            assembly.next += 1
            if isFinal {
                uploadAssemblies[id] = nil
                return .some((assembly.header, assembly.body))
            }
            uploadAssemblies[id] = assembly
            return .none
        }
        switch assembled {
        case .none: return
        case .some(nil):
            violation("upload \(id) chunk \(seq) out of order")
            try? await respondError(id: id, code: "bad_request", message: "expected another chunk")
        case .some(let finished?):
            await finishUpload(id: id, header: finished.header, body: finished.body)
        }
    }

    private func finishUpload(id: String, header: [String: Any], body: Data) async {
        guard body.count <= Self.maxUploadBytes else {
            violation("upload of \(body.count) bytes exceeds 20 MiB")
            try? await respondError(id: id, code: "bad_request", message: "upload exceeds 20971520 bytes")
            return
        }
        switch Self.httpRequest(header["params"] as? [String: Any] ?? [:], upload: body) {
        case .success(let http) where http.upload != nil:
            await route(id: id, http)
        case .success:
            violation("binary request without params.upload")
            try? await respondError(id: id, code: "invalid_argument", message: "a binary request needs params.upload")
        case .failure(let problem):
            violation("upload params: \(problem)")
            try? await respondError(id: id, code: "invalid_argument", message: problem.description)
        }
    }

    // MARK: Helpers

    /// Top-level keys of a JSON object in the order they appear.
    private static func keyOrder(_ payload: Data) -> [String] {
        let text = String(decoding: payload, as: UTF8.self)
        var keys: [String] = []
        var depth = 0
        var index = text.startIndex
        var expectKey = false
        while index < text.endIndex {
            let character = text[index]
            if character == "\"" {
                var end = text.index(after: index)
                while text[end] != "\"" {
                    if text[end] == "\\" { end = text.index(after: end) }
                    end = text.index(after: end)
                }
                if depth == 1 && expectKey { keys.append(String(text[text.index(after: index)..<end])) }
                expectKey = false
                index = text.index(after: end)
                continue
            }
            switch character {
            case "{", "[":
                depth += 1
                expectKey = depth == 1 && character == "{"
            case "}", "]": depth -= 1
            case ",": expectKey = depth == 1
            default: break
            }
            index = text.index(after: index)
        }
        return keys
    }

    // MARK: Sending (also used by tests to misbehave after the handshake)

    /// Seals with the next desktop-to-phone counter without sending.
    func seal(kind: FrameKind, payload: Data) -> Data {
        lock.withLock {
            var sealer = self.sealer!
            defer { self.sealer = sealer }
            return try! sealer.seal(kind: kind, payload: payload)
        }
    }

    /// Seals with the next counter and sends. On an in-process socket both happen
    /// under one lock, so concurrent senders reach the phone in counter order, as
    /// the host's single writer guarantees (the phone's counters are strict).
    func sendSealed(_ payload: Data, kind: FrameKind = .text) async throws {
        func message(_ frame: Data) -> LinkMessage { kind == .text ? .text(frame.base64EncodedString()) : .binary(frame) }
        if let memory = lock.withLock({ socket }) as? MemorySocket {
            let sent = try sendLock.withLock { () -> Bool in
                let frame = seal(kind: kind, payload: payload)
                if try memory.sendNow(message(frame)) { return true }
                held.append(message(frame))
                return false
            }
            if !sent { try await flushHeld(memory) }
            return
        }
        let frame = seal(kind: kind, payload: payload)
        try await sendRaw(message(frame))
    }

    /// Frames sealed while the phone's socket held sends, in counter order.
    private func flushHeld(_ socket: MemorySocket) async throws {
        while let next = sendLock.withLock({ held.isEmpty ? nil : held.removeFirst() }) {
            try await socket.send(next)
        }
    }

    func sendRaw(_ message: LinkMessage) async throws {
        guard let socket = lock.withLock({ socket }) else { return }
        try await socket.send(message)
    }

    func respond(id: String, result: String, streaming: Bool = false) async throws {
        lock.withLock { if heldCapabilities.remove(id) != nil { apiDeclared = true } }
        try await sendSealed(Data("{\"id\":\"\(id)\",\"ok\":true,\"result\":\(result),\"_meta\":{\"runtimeId\":\"rt-1\"}\(streaming ? ",\"streaming\":true" : "")}".utf8))
    }

    func respondError(id: String, code: String, message: String) async throws {
        let body = try! JSONSerialization.data(withJSONObject: ["code": code, "message": message, "data": NSNull()], options: [.sortedKeys])
        try await sendSealed(Data("{\"id\":\"\(id)\",\"ok\":false,\"error\":\(String(decoding: body, as: UTF8.self)),\"_meta\":{\"runtimeId\":\"rt-1\"}}".utf8))
    }

    func close(code: Int, reason: String) {
        lock.withLock { socket }?.close(code: code, reason: reason)
    }
}
