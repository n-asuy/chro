import ChroAPI
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// Operator API routes travel as the `request` RPC instead of owner-token HTTP.
struct RouteCallTests {
    private func params<Req, Res>(_ route: Route<Req, Res>, query: [String: String] = [:], body: Req? = nil, requestId: String = "rid") throws -> [String: Any] {
        let raw = try RouteRequest.raw(route, query: query, body: body, requestId: requestId)
        return (try JSONSerialization.jsonObject(with: raw.params())) as? [String: Any] ?? [:]
    }

    @Test func getCarriesPathAndQueryButNoBodyOrRequestId() throws {
        let object = try params(Routes.sessions, query: ["project": "inventory-service"])
        #expect(object["method"] as? String == "GET")
        #expect(object["path"] as? String == "/v1/sessions")
        #expect(object["query"] as? [String: String] == ["project": "inventory-service"])
        #expect(object["body"] == nil)
        #expect(object["requestId"] == nil)
    }

    @Test func getWithoutQueryOmitsIt() throws {
        #expect(Set(try params(Routes.status).keys) == ["method", "path"])
    }

    @Test func mutatingCallsCarryTheRequestIdAndASnakeCaseBody() throws {
        let object = try params(Routes.sessionSend(session: "7hdSeWrD"), body: SendMessage(prompt: "next"), requestId: "rid-1")
        #expect(object["method"] as? String == "POST")
        #expect(object["path"] as? String == "/v1/sessions/7hdSeWrD/messages")
        #expect(object["requestId"] as? String == "rid-1")
        #expect(object["idempotencyKey"] == nil)
        let body = object["body"] as? [String: Any]
        #expect(body?["prompt"] as? String == "next")
        #expect(body?["when_busy"] as? String == "queue")
    }

    @Test func mutatingCallsWithoutABodySendAnEmptyObject() throws {
        let object = try params(Routes.sessionCancel(session: "7hdSeWrD"), requestId: "rid-2")
        #expect((object["body"] as? [String: Any])?.isEmpty == true)
        #expect(object["method"] as? String == "POST")
    }

    @Test func pathSegmentsArePercentEncoded() {
        #expect(RouteRequest.path(Routes.session(session: "path:/a b")) == "/v1/sessions/path:%2Fa%20b")
        #expect(RouteRequest.path(Routes.sessionUnqueue(session: "s", message: "m?#")) == "/v1/sessions/s/queue/m%3F%23")
    }

    // MARK: Through the link

    static let sessionsEnvelope = """
    {"ok":true,"result":{"sessions":[]},"meta":{"runtime_id":"rt-1","contract_rev":"0.1.0+8133f219"}}
    """

    static let notFoundEnvelope = """
    {"ok":false,"error":{"code":"not_found","message":"no session x","next":["chro session list"]},"meta":{"runtime_id":"rt-1","contract_rev":"0.1.0+8133f219"}}
    """

    @Test func callDecodesTheEnvelopeInTheResult() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .json(status: 200, RouteCallTests.sessionsEnvelope) })
        }
        try await harness.connect()
        let list = try await harness.link.call(Routes.sessions, query: ["project": "p"])
        #expect(list.sessions.isEmpty)
        let sent = harness.responder.requests("request")[0].paramsObject
        #expect(sent["path"] as? String == "/v1/sessions")
        #expect(harness.responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func mutatingCallsPassTheServersStrictParams() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { http in
                http.requestId == "rid-9" ? .json(status: 200, "{}") : .forbidden
            })
        }
        try await harness.connect()
        _ = try? await harness.link.call(Routes.sessionCancel(session: "s"), requestId: "rid-9")
        #expect(harness.responder.httpRequests.first?.requestId == "rid-9")
        #expect(harness.responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func aTextAnswerIsAnInternalErrorWithTheStatus() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .text(status: 503, contentType: "text/plain", "Service Unavailable") })
        }
        try await harness.connect()
        do {
            _ = try await harness.link.call(Routes.status)
            Issue.record("expected an error")
        } catch let error as APIError {
            #expect(error.code == .internal)
            #expect(error.message.contains("503"))
            #expect(error.message.contains("Service Unavailable"))
        }
        await harness.link.stop()
    }

    @Test func callThrowsTheServersAPIError() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .json(status: 404, RouteCallTests.notFoundEnvelope) })
        }
        try await harness.connect()
        await #expect(throws: APIError(code: .notFound, message: "no session x", next: ["chro session list"])) {
            try await harness.link.call(Routes.session(session: "x"))
        }
        await harness.link.stop()
    }

    @Test func nonEnvelopeBodyIsAnInternalError() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .json(status: 502, "\"Bad Gateway\"") })
        }
        try await harness.connect()
        do {
            _ = try await harness.link.call(Routes.status)
            Issue.record("expected an error")
        } catch let error as APIError {
            #expect(error.code == .internal)
            #expect(error.message.contains("502"))
        }
        await harness.link.stop()
    }

    @Test func linkFailuresMapToAPIErrors() {
        #expect(RouteRequest.apiError(LinkError.timeout).code == .timeout)
        #expect(RouteRequest.apiError(LinkError.disconnected).code == .unreachable)
        #expect(RouteRequest.apiError(LinkError.stopped).code == .unreachable)
        #expect(RouteRequest.apiError(LinkError.authFailed).code == .unauthorized)
        #expect(RouteRequest.apiError(LinkError.incompatibleAPI).code == .contractMismatch)
        #expect(RouteRequest.apiError(LinkError.rpc(RPCError(code: "forbidden", message: "not on the allow list"))) == APIError(code: .unknown("forbidden"), message: "not on the allow list"))
        #expect(RouteRequest.apiError(LinkError.malformedResponse("x")).code == .internal)
        #expect(RouteRequest.apiError(LinkError.requestTooLarge).code == .invalidRequest)
    }

    @Test func forbiddenRouteSurfacesAsAPIError() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .forbidden })
        }
        try await harness.connect()
        await #expect(throws: APIError(code: .unknown("forbidden"), message: "this endpoint is not available to paired devices")) {
            try await harness.link.call(Routes.approvals)
        }
        await harness.link.stop()
    }
}
