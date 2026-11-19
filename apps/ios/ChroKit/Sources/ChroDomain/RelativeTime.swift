import Foundation

/// Compact relative timestamp for session rows ("now", "5m", "3h", "2d", "1w",
/// "4mo", "1y"); floor-based like the desktop's relative-time.ts.
public enum RelativeTime {
    public static func format(_ date: Date, now: Date = Date()) -> String {
        let minutes = Int(floor(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        if days < 7 { return "\(days)d" }
        if days < 30 { return "\(days / 7)w" }
        if days < 365 { return "\(days / 30)mo" }
        return "\(days / 365)y"
    }
}
