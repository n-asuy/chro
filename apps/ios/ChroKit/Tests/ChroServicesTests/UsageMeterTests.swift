import Testing
@testable import ChroServices

/// The Agent status usage meter (agent-status-menu.tsx `UsageMeter`): shown
/// only for an `ok` report with tokens, with the desktop's strings.
struct UsageMeterTests {
    private static func usage(output: Int = 45_000, cacheRead: Int = 1_000_000, total: Int = 1_200_000, window: Int = 300,
                              cost: Double? = 1.234, sessions: Int = 3, available: Bool = true) -> AgentUsage {
        AgentUsage(provider: "claude", isAvailable: available, windowMinutes: window,
                   tokens: .init(input: total - output - cacheRead, output: output, cacheRead: cacheRead, cacheCreation: 0, total: total),
                   costUSD: cost, sessionCount: sessions)
    }

    @Test func aReportWithTokensShowsTheDesktopsLines() throws {
        let meter = try #require(UsageMeter(Self.usage()))
        #expect(meter.windowLabel == "5h")
        #expect(meter.total == "1.2M")
        #expect(meter.cachedPercent == 83)
        #expect(meter.summary == "45.0k out · 83% cached · 3 sessions · $1.23")
    }

    @Test func noReportAnUnavailableOneOrAnUnusedWindowIsHidden() {
        #expect(UsageMeter(nil) == nil)
        #expect(UsageMeter(Self.usage(available: false)) == nil)
        #expect(UsageMeter(Self.usage(output: 0, cacheRead: 0, total: 0)) == nil)
    }

    @Test func oneSessionNoCostAndSmallSpend() throws {
        #expect(try #require(UsageMeter(Self.usage(output: 900, cacheRead: 0, total: 999, cost: nil, sessions: 1))).summary == "900 out · 0% cached · 1 session")
        #expect(try #require(UsageMeter(Self.usage(cost: 0.004))).summary.hasSuffix(" · <$0.01"))
    }

    @Test func windowAndTokenFormats() {
        #expect(UsageMeter.windowLabel(minutes: 300) == "5h")
        #expect(UsageMeter.windowLabel(minutes: 90) == "90m")
        #expect(UsageMeter.tokens(999) == "999")
        #expect(UsageMeter.tokens(1_000) == "1.0k")
        #expect(UsageMeter.tokens(45_250) == "45.3k")
        #expect(UsageMeter.tokens(2_500_000_000) == "2.5B")
        #expect(UsageMeter.cost(12.5) == "$12.50")
    }
}
