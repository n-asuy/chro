import Foundation
@testable import ChroLinkTesting
@testable import ChroServices

/// The right dock's routes on the fake desktop: fixed answers through
/// `replies`, streams through `streamSnapshots` and `push`, and a phone whose
/// panel services share its `LiveWorkspace`.
extension FakeDesktop {
    static let panelProject = "11111111-0000-4000-8000-0000000000aa"
    static let panelSession = "aaaa0000-0000-4000-8000-0000000000aa"

    /// Answers `route` ("METHOD /path") with `value` as JSON.
    func reply(_ route: String, _ value: Any, status: Int = 200) {
        edit { $0.replies[route] = .json(status: status, Self.text(value)) }
    }

    /// `GET /rpc/tasks/:id/runs` with these runs.
    func runs(_ session: String, _ runs: [[String: Any]]) {
        reply("GET /rpc/tasks/\(session)/runs", ["runs": runs])
    }

    static func run(_ id: String, status: String = "completed", createdAt: String, container: String? = nil) -> [String: Any] {
        ["id": id, "status": status, "created_at": createdAt, "container_ref": container ?? NSNull(), "executor_label": NSNull()]
    }

    /// One stream message as the desktop's WebSocket sends it.
    static func patch(_ operations: [[String: Any]]) -> String { text(["type": "json_patch", "payload": operations]) }

    /// A phone with the project and the session listed, and calls for its panels.
    func panelPhone() async throws -> (phone: Phone, calls: PanelLiveCalls) {
        edit {
            $0.projects = [Self.project(Self.panelProject, name: "inventory-service", path: "/Users/me/inventory-service")]
            $0.tasks = [Self.panelSession: Self.task(Self.panelSession, project: Self.panelProject, title: "Add removeStock", branch: "ch/aaaa-add")]
        }
        let phone = try phone()
        try await eventually("session listed") { phone.workspace.sessionList.value.count == 1 }
        return (phone, PanelLiveCalls(workspace: phone.workspace))
    }
}
