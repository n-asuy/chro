import ChroDomain
@testable import ChroServices
import Foundation
import Testing

@Suite struct SettingsServicesTests {
    @Test func capturedClaudeConfigPrintsAsTheMockShowsIt() async throws {
        let file = try await SettingsFixtureService(scenario: .standard).mcpConfig(for: .claudeCode)
        #expect(file.configPath == "/Users/me/.claude.json")
        #expect(file.editorText == """
        {
          "mcpServers": {
            "actors-mcp-server": {
              "args": [
                "-y",
                "@apify/actors-mcp-server"
              ],
              "command": "npx",
              "env": {
                "APIFY_TOKEN": "__chro_hidden__"
              }
            },
            "freee": {
              "type": "http",
              "url": "https://mcp.freee.co.jp/mcp"
            },
            "open-pencil": {
              "command": "openpencil-mcp"
            }
          }
        }
        """)
    }

    @Test func savingServersRoundTrips() async throws {
        let service = SettingsFixtureService(scenario: .standard)
        let file = try await service.mcpConfig(for: .claudeCode)
        let servers = try file.shape.servers(fromText: #"{"mcpServers":{"a":{"command":"x"}}}"#)
        let saved = try await service.saveMcpServers(servers, for: .claudeCode)
        #expect(saved.editorText.contains("\"a\""))
        #expect(try await service.mcpConfig(for: .claudeCode) == saved)
    }

    @Test func piStatusIsNotChecked() async {
        await #expect(throws: ServiceError.self) { try await SettingsFixtureService(scenario: .standard).mcpStatus(for: .pi) }
    }

    @Test func mergeTemplateFallsBackToTheDefault() async throws {
        let service = SettingsFixtureService(scenario: .standard)
        #expect(try await service.saveMergeTemplate("x") == "x")
        #expect(try await service.saveMergeTemplate(nil) == MergeTemplate.defaultTemplate)
    }
}

/// Answers every request with a canned response and records the last one.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = Data()
    nonisolated(unsafe) static var lastRequestBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
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
            StubProtocol.lastRequestBody = data
        } else {
            StubProtocol.lastRequestBody = request.httpBody
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: StubProtocol.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: StubProtocol.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

struct SettingsLostAnswerTests {
    @Test func aLostAnswerKeepsTheSavedValueAndReportsAnUnknownOutcome() async throws {
        let settings = PanelServices.fixture(options: PanelFixtureOptions(losingAnswers: true)).settings
        var next = try await settings.preferences()
        next.showHiddenEntries.toggle()
        await #expect(throws: ServiceError.outcomeUnknown("The desktop did not answer in time.")) { _ = try await settings.savePreferences(next) }
        #expect(try await settings.preferences() == next)
        await #expect(throws: ServiceError.outcomeUnknown("The desktop did not answer in time.")) { _ = try await settings.saveEditorLineHeight(1.8) }
        #expect(try await settings.editorLineHeight() == 1.8)
    }
}

@Suite(.serialized) struct CloudFeedbackSenderTests {
    private func sender() -> CloudFeedbackSender {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return CloudFeedbackSender(appVersion: "0.1.57", session: URLSession(configuration: configuration))
    }

    @Test func postsTheDesktopsBody() async throws {
        StubProtocol.status = 200
        StubProtocol.body = Data("{}".utf8)
        try await sender().send(category: .bug, message: "It broke")
        let body = try JSONSerialization.jsonObject(with: try #require(StubProtocol.lastRequestBody)) as? [String: String]
        #expect(body == ["category": "bug", "message": "It broke", "appVersion": "0.1.57", "platform": "ios"])
    }

    @Test func refusalCarriesTheResponseText() async {
        StubProtocol.status = 400
        StubProtocol.body = Data("message is required".utf8)
        await #expect(throws: CloudFeedbackSender.Failure(message: "message is required")) {
            try await sender().send(category: .feedback, message: " ")
        }
    }
}
