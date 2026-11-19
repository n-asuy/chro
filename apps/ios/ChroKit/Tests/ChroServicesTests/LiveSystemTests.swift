import ChroDomain
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting
@testable import ChroServices

/// SystemService: `/rpc/cli-status` over the link, feedback to the cloud API.
@Suite(.timeLimit(.minutes(1)), .serialized)
struct LiveSystemTests {
    let desktop = FakeDesktop()

    @Test func cliStatusDecodesTheServersReport() async throws {
        desktop.reply("GET /rpc/cli-status", [
            "agents": [["name": "claude", "found": true, "path": "/usr/local/bin/claude", "source": "PATH", "version": "2.1.323", "install_hint": "npm i -g x"],
                       ["name": "codex", "found": false, "path": NSNull(), "source": NSNull(), "version": NSNull(), "install_hint": "brew install codex"]],
            "server_version": "0.1.57", "latest_release": "v0.1.58", "update_available": true,
        ])
        let system = SystemLiveService(calls: try await desktop.panelPhone().calls, feedback: CloudFeedbackSender(appVersion: "0.1.0"))
        #expect(try await system.cliStatus() == CliStatus(agents: [
            .init(name: "claude", found: true, path: "/usr/local/bin/claude", source: "PATH", version: "2.1.323", installHint: "npm i -g x"),
            .init(name: "codex", found: false, path: nil, source: nil, version: nil, installHint: "brew install codex"),
        ], serverVersion: "0.1.57", latestRelease: "v0.1.58", updateAvailable: true))
    }

    static func usage(_ provider: String, status: String = "ok", window: Int = 300, input: Int = 0, output: Int = 0, cacheRead: Int = 0,
                      cacheCreation: Int = 0, cost: Any = NSNull(), sessions: Int = 0) -> [String: Any] {
        ["provider": provider, "status": status, "window_minutes": window, "cost_usd": cost, "session_count": sessions, "updated_at_ms": 1_763_110_800_000,
         "tokens": ["input": input, "output": output, "cache_read": cacheRead, "cache_creation": cacheCreation,
                    "total": input + output + cacheRead + cacheCreation]]
    }

    @Test func agentUsageDecodesTheServersReport() async throws {
        desktop.reply("GET /rpc/agent-usage", ["providers": [
            Self.usage("claude", input: 120_000, output: 45_000, cacheRead: 1_000_000, cacheCreation: 35_000, cost: 1.234, sessions: 3),
            Self.usage("codex", status: "unavailable"),
        ]])
        let system = SystemLiveService(calls: try await desktop.panelPhone().calls, feedback: CloudFeedbackSender(appVersion: nil))
        #expect(try await system.agentUsage() == [
            AgentUsage(provider: "claude", isAvailable: true, windowMinutes: 300,
                       tokens: .init(input: 120_000, output: 45_000, cacheRead: 1_000_000, cacheCreation: 35_000, total: 1_200_000),
                       costUSD: 1.234, sessionCount: 3),
            AgentUsage(provider: "codex", isAvailable: false, windowMinutes: 300, tokens: .init(input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0),
                       costUSD: nil, sessionCount: 0),
        ])
        #expect(desktop.requests("GET", "/rpc/agent-usage").count == 1)
    }

    @Test func feedbackPostsToTheCloudAPIAsTheDesktopDoes() async throws {
        FeedbackStub.respond(status: 201, body: "")
        let system = SystemLiveService(calls: try await desktop.panelPhone().calls,
                                       feedback: CloudFeedbackSender(appVersion: "0.1.0", session: FeedbackStub.session))
        try await system.submitFeedback(category: .bug, message: "The diff does not scroll")
        let request = try #require(FeedbackStub.lastRequest)
        #expect(request.url == URL(string: "https://api.chro-ai.com/feedback"))
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(FeedbackStub.lastBody == ["category": "bug", "message": "The diff does not scroll", "platform": "ios", "appVersion": "0.1.0"])
        #expect(desktop.requests.allSatisfy { !$0.path.contains("feedback") })
    }

    @Test func aRefusedFeedbackThrowsTheResponseText() async throws {
        FeedbackStub.respond(status: 400, body: "message is required")
        let system = SystemLiveService(calls: try await desktop.panelPhone().calls,
                                       feedback: CloudFeedbackSender(appVersion: nil, session: FeedbackStub.session))
        await #expect(throws: CloudFeedbackSender.Failure(message: "message is required")) { try await system.submitFeedback(category: .feedback, message: "") }
    }
}

/// Answers the feedback POST in-process and records it.
final class FeedbackStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = ""
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: [String: String]?

    static func respond(status: Int, body: String) {
        self.status = status
        self.body = body
        lastRequest = nil
        lastBody = nil
    }

    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FeedbackStub.self]
        return URLSession(configuration: configuration)
    }()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            Self.lastBody = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        } else if let data = request.httpBody {
            Self.lastBody = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
