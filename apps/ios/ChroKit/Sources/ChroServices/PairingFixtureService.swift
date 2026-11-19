import Foundation

extension FixtureWorkspace: PairingService {
    public func hosts() -> AsyncStream<PairingState> { pairingState.stream() }

    /// Accepts a real `chro://pair?code=` offer (v2 JSON with `endpoint` and
    /// `publicKeyB64`) without connecting: the fixture stands in for the
    /// desktop. A code is single-use, like the desktop's ticket.
    public func pair(code: String, source: PairingSource) -> AsyncThrowingStream<PairingProgress, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let offer = try FixtureWorkspace.decodeOffer(code, source: source)
                    let reused = locked { usedPairingCodes.contains(offer.code) }
                    continuation.yield(.step("Opening connection to \(offer.endpoint)"))
                    try await Task.sleep(for: .milliseconds(250))
                    if reused { throw PairingError.rejected }
                    continuation.yield(.step("Encrypted channel ready"))
                    try await Task.sleep(for: .milliseconds(250))
                    continuation.yield(.step("Device authenticated"))
                    locked { _ = usedPairingCodes.insert(offer.code) }
                    var paired: PairedHost?
                    pairingState.update { state in
                        let id = "host-\(offer.publicKey.prefix(8))"
                        let at = now()
                        if let index = state.hosts.firstIndex(where: { $0.id == id }) {
                            state.hosts[index].endpoint = offer.endpoint
                            state.hosts[index].lastConnected = at
                            paired = state.hosts[index]
                        } else {
                            let host = PairedHost(id: id, name: "Host \(state.hosts.count + 1)", endpoint: offer.endpoint, lastConnected: at)
                            state.hosts.append(host)
                            paired = host
                        }
                        state.activeHostID = id
                    }
                    continuation.yield(.paired(paired!))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func activate(hostID: String?) async {
        pairingState.update { state in
            state.activeHostID = hostID.flatMap { id in state.hosts.contains { $0.id == id } ? id : nil }
        }
    }

    /// The fixture's host never refuses: Retry finds it connected.
    public func reconnect() async {
        pairingState.update { $0.connection = .connected }
    }

    public func remove(hostID: String) async {
        pairingState.update { state in
            state.hosts.removeAll { $0.id == hostID }
            if state.activeHostID == hostID { state.activeHostID = nil }
        }
    }

    struct Offer {
        var code: String
        var endpoint: String
        var publicKey: String
    }

    static func decodeOffer(_ raw: String, source: PairingSource) throws -> Offer {
        let invalid: PairingError = source == .paste ? .invalidPastedCode : .invalidQRCode
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let code: String
        if text.lowercased().hasPrefix("chro://") {
            guard let components = URLComponents(string: text), components.host?.lowercased() == "pair",
                  let value = components.queryItems?.first(where: { $0.name == "code" })?.value ?? components.fragment
            else { throw invalid }
            code = value
        } else if source == .camera && (text.lowercased().hasPrefix("https://") || text.lowercased().hasPrefix("http://")) {
            throw PairingError.downloadCode
        } else if source == .paste {
            code = text
        } else {
            throw invalid
        }
        var base64 = code.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.hasSuffix("=") { base64.removeLast() }
        guard !base64.isEmpty, base64.count % 4 != 1,
              base64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/") })
        else { throw invalid }
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["v"] as? Int == 2,
              let endpoint = json["endpoint"] as? String, !endpoint.isEmpty,
              let publicKey = json["publicKeyB64"] as? String, !publicKey.isEmpty
        else { throw invalid }
        return Offer(code: code, endpoint: endpoint, publicKey: publicKey)
    }
}
