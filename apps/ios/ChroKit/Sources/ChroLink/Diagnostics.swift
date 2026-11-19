import os

/// Unified-logging categories under the app's subsystem, so a device report
/// (`log collect`, Console) shows why a stream ended or a message was dropped.
public enum Diagnostics {
    public static let subsystem = "com.chro-ai.ios"
    /// Subscriptions: ends with their reason, restarts after overflow, malformed results.
    public static let link = Logger(subsystem: subsystem, category: "link")
    /// Stream messages a live service could not read.
    public static let streams = Logger(subsystem: subsystem, category: "streams")
}
