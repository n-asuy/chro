import Foundation
import Testing
@testable import ChroDomain

/// Same buckets as apps/desktop/src/session/lib/relative-time.ts (floor-based).
struct RelativeTimeTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let minute: Double = 60
    static let hour: Double = 3_600
    static let day: Double = 86_400
    static let cases: [(Double, String)] = [
        (0, "now"), (59, "now"), (minute, "1m"), (59 * minute, "59m"), (hour, "1h"), (23 * hour, "23h"),
        (day, "1d"), (6 * day, "6d"), (7 * day, "1w"), (29 * day, "4w"),
        (30 * day, "1mo"), (364 * day, "12mo"), (365 * day, "1y"), (800 * day, "2y"),
    ]

    @Test(arguments: cases)
    func buckets(seconds: Double, expected: String) {
        #expect(RelativeTime.format(Self.now.addingTimeInterval(-seconds), now: Self.now) == expected)
    }
}
