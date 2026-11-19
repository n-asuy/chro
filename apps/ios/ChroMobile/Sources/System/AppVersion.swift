import ChroDomain
import Foundation

/// The chro release this build carries, as the desktop's version chip and
/// release notes use it (`scripts/bundle-changelog.sh` writes both files).
enum AppVersion {
    /// The bundled chro release version, without a leading `v`.
    static let current: String = {
        if let url = Bundle.main.url(forResource: "chro-release", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let version = object["version"] as? String, !version.isEmpty {
            return version
        }
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }()

    /// release-button.tsx: `v` + version.
    static var chipLabel: String { ChangelogParser.versionLabel(current) }

    /// The bundled CHANGELOG.md, newest release first.
    static let releases: [ChangelogRelease] = {
        guard let url = Bundle.main.url(forResource: "CHANGELOG", withExtension: "md"),
              let source = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return ChangelogParser.parse(source)
    }()
}
