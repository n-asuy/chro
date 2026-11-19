import ChroAPI
import Foundation
import Testing
@testable import ChroLink
@testable import ChroLinkTesting

/// `/rpc/*` calls through `ChroLink.send` and `ChroLink.upload`: the `request`
/// params of §4.1 and the three result shapes (JSON, text, binary frames).
struct RawRequestTests {
    private func object(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    // MARK: Params

    @Test func paramsCarryMethodPathQueryBodyAndRequestId() throws {
        let request = RawRequest(method: .put, path: "/rpc/projects/p1/file", query: ["path": "a b.md"], body: Data("{\"content\":\"x\"}".utf8), requestId: "rid-1")
        let sent = object(try request.params())
        #expect(Set(sent.keys) == ["method", "path", "query", "body", "requestId"])
        #expect(sent["method"] as? String == "PUT")
        #expect(sent["path"] as? String == "/rpc/projects/p1/file")
        #expect(sent["query"] as? [String: String] == ["path": "a b.md"])
        #expect((sent["body"] as? [String: String]) == ["content": "x"])
        #expect(sent["requestId"] as? String == "rid-1")
    }

    @Test func absentPartsAreOmitted() throws {
        let sent = object(try RawRequest(path: "/rpc/projects").params())
        #expect(Set(sent.keys) == ["method", "path"])
        #expect(sent["method"] as? String == "GET")
    }

    @Test func aBodyMustBeJSON() {
        #expect(throws: APIError.self) { try RawRequest(method: .post, path: "/rpc/x", body: Data("not json".utf8)).params() }
    }

    @Test func pathSegmentsArePercentEncodedOneByOne() {
        #expect(RawRequest.path("rpc", "projects", "a/b c", "file") == "/rpc/projects/a%2Fb%20c/file")
        #expect(RawRequest.path("rpc", "tasks", "path:x@y?#") == "/rpc/tasks/path:x@y%3F%23")
    }

    @Test func everyMethodIsAllowed() {
        #expect(RawRequest.Method.allCases.map(\.rawValue) == ["GET", "POST", "PUT", "PATCH", "DELETE"])
    }

    // MARK: Results

    @Test func theThreeResultShapesDecode() throws {
        #expect(try RawResponse(text: Data("{\"status\":200,\"body\":{\"a\":1}}".utf8)) == .json(status: 200, body: Data("{\"a\":1}".utf8)))
        #expect(try RawResponse(text: Data("{\"status\":204,\"body\":null}".utf8)) == .json(status: 204, body: Data("null".utf8)))
        #expect(try RawResponse(text: Data("{\"status\":404,\"contentType\":\"text/plain; charset=utf-8\",\"text\":\"Task not found\"}".utf8))
            == .text(status: 404, contentType: "text/plain; charset=utf-8", text: "Task not found"))
        #expect(throws: LinkError.self) { try RawResponse(text: Data("{\"status\":200}".utf8)) }
        #expect(throws: LinkError.self) { try RawResponse(text: Data("[1]".utf8)) }
    }

    @Test func statusHelpers() {
        #expect(RawResponse.json(status: 201, body: Data("{}".utf8)).isSuccess)
        #expect(!RawResponse.text(status: 500, contentType: "text/plain", text: "boom").isSuccess)
        #expect(RawResponse.binary(status: 200, contentType: "image/png", data: Data()).status == 200)
    }

    // MARK: Through the link

    @Test func sendReturnsJSON() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { http in
                http.path == "/rpc/projects" ? .json(status: 200, "{\"projects\":[]}") : .forbidden
            })
        }
        try await harness.connect()
        let response = try await harness.link.send(RawRequest(path: "/rpc/projects"))
        #expect(response == .json(status: 200, body: Data("{\"projects\":[]}".utf8)))
        #expect(harness.responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func sendReturnsTextErrorsAsResponsesNotThrows() async throws {
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .text(status: 404, contentType: "text/plain; charset=utf-8", "Task not found") })
        }
        try await harness.connect()
        let response = try await harness.link.send(RawRequest(method: .patch, path: "/rpc/tasks/t/status", body: Data("{\"status\":\"cancelled\"}".utf8)))
        #expect(response == .text(status: 404, contentType: "text/plain; charset=utf-8", text: "Task not found"))
        let http = try #require(harness.responder.httpRequests.first)
        #expect(http.method == "PATCH")
        #expect(http.bodyObject as? [String: String] == ["status": "cancelled"])
        await harness.link.stop()
    }

    @Test func sendReassemblesABinaryReplyAcrossChunks() async throws {
        let image = Data((0..<(2 * 1024 * 1024 + 123)).map { UInt8(truncatingIfNeeded: $0 &* 13) })
        let harness = LinkHarness { _ in
            FakeResponder(routes: { _ in .binary(status: 200, contentType: "image/png", image) })
        }
        try await harness.connect()
        let response = try await harness.link.send(RawRequest(path: "/rpc/images/i1/file"))
        #expect(response == .binary(status: 200, contentType: "image/png", data: image))
        #expect(harness.responder.violations.isEmpty)
        // The link keeps working after a multi-frame reply.
        _ = try await harness.link.request("status.get")
        await harness.link.stop()
    }

    @Test func anEmptyBinaryReply() async throws {
        let harness = LinkHarness { _ in FakeResponder(routes: { _ in .binary(status: 200, contentType: "application/octet-stream", Data()) }) }
        try await harness.connect()
        #expect(try await harness.link.send(RawRequest(path: "/rpc/x")) == .binary(status: 200, contentType: "application/octet-stream", data: Data()))
        await harness.link.stop()
    }

    @Test func aTruncatedBinaryReplyFailsTheCall() async throws {
        let harness = LinkHarness { _ in FakeResponder(routes: { _ in .silence }) }
        try await harness.connect()
        let link = harness.link
        let call = Task { try await link.send(RawRequest(path: "/rpc/images/i1/file")) }
        let responder = harness.responder
        try await eventually("request sent") { !responder.requests("request").isEmpty }
        let id = responder.requests("request")[0].id
        let header: [String: Any] = ["id": id, "seq": 0, "final": false, "ok": true, "result": ["status": 200, "contentType": "image/png", "contentLength": 4]]
        try await responder.sendSealed(FakeResponder.binaryFrame(header: header, chunk: Data([1, 2])), kind: .binary)
        try await responder.sendSealed(FakeResponder.binaryFrame(header: ["id": id, "seq": 1, "final": true], chunk: Data([3])), kind: .binary)
        await #expect(throws: APIError.self) { try await call.value }
        #expect(await link.state == .connected)
        await link.stop()
    }

    @Test func forbiddenSurfacesAsAPIError() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        await #expect(throws: APIError(code: .unknown("forbidden"), message: "this endpoint is not available to paired devices")) {
            try await harness.link.send(RawRequest(path: "/rpc/developer/x"))
        }
        await harness.link.stop()
    }

    @Test func aTextRequestOverTheListenersLimitIsRefusedLocally() async throws {
        let harness = LinkHarness { _ in FakeResponder(routes: { _ in .json(status: 200, "{}") }) }
        try await harness.connect()
        let huge = try JSONSerialization.data(withJSONObject: ["content": String(repeating: "x", count: 900 * 1024)])
        await #expect(throws: APIError.self) {
            try await harness.link.send(RawRequest(method: .put, path: "/rpc/projects/p/file", body: huge))
        }
        #expect(harness.responder.httpRequests.isEmpty)
        #expect(await harness.link.state == .connected)
        await harness.link.stop()
    }

    // MARK: Uploads

    @Test func uploadSendsBinaryFramesAndReadsTheJSONReply() async throws {
        let photo = Data((0..<(1_700_000)).map { UInt8(truncatingIfNeeded: $0 &* 7) })
        let harness = LinkHarness { _ in
            FakeResponder(routes: { http in
                guard http.path == "/rpc/images/upload", let upload = http.upload, upload.field == "image" else { return .forbidden }
                return .json(status: 200, "{\"image\":{\"id\":\"img-1\",\"file_path\":\".chro-images/\(upload.fileName)\",\"size_bytes\":\(upload.data.count)}}")
            })
        }
        try await harness.connect()
        let response = try await harness.link.upload(path: "/rpc/images/upload", fileName: "IMG_0412.png", contentType: "image/png", data: photo)
        guard case .json(200, let body) = response else {
            Issue.record("unexpected \(response)")
            return
        }
        let image = try #require(object(body)["image"] as? [String: Any])
        #expect(image["size_bytes"] as? Int == photo.count)
        let http = try #require(harness.responder.httpRequests.first)
        #expect(http.method == "POST")
        #expect(http.upload == .init(field: "image", fileName: "IMG_0412.png", contentType: "image/png", data: photo))
        #expect(harness.responder.framesFromPhone.filter { if case .binary = $0 { true } else { false } }.count == 3)
        #expect(harness.responder.violations.isEmpty)
        await harness.link.stop()
    }

    @Test func uploadOverTwentyMiBIsRefusedLocally() async throws {
        let harness = LinkHarness()
        try await harness.connect()
        await #expect(throws: APIError.self) {
            try await harness.link.upload(path: "/rpc/images/upload", fileName: "big.png", contentType: "image/png", data: Data(count: 20 * 1024 * 1024 + 1))
        }
        #expect(harness.responder.framesFromPhone.allSatisfy { if case .binary = $0 { false } else { true } })
        await harness.link.stop()
    }

    @Test func uploadErrorsArriveAsTextRepliesUnderTheUploadId() async throws {
        let harness = LinkHarness { _ in FakeResponder(routes: { _ in .forbidden }) }
        try await harness.connect()
        await #expect(throws: APIError(code: .unknown("forbidden"), message: "this endpoint is not available to paired devices")) {
            try await harness.link.upload(path: "/rpc/tasks/t/images/upload", fileName: "a.png", contentType: "image/png", data: Data([1]))
        }
        await harness.link.stop()
    }
}
