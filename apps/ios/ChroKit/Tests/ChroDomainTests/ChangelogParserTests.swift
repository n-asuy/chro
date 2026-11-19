import ChroDomain
import Testing

@Suite struct ChangelogParserTests {
    @Test func parsesReleasesNewestFirstWithBullets() {
        let source = """
        # Changelog

        Intro prose is ignored.

        ## 0.1.58
        - First note
        * Second note

        ## 0.1.57
        - Only note
        """
        #expect(ChangelogParser.parse(source) == [
            ChangelogRelease(version: "0.1.58", notes: ["First note", "Second note"]),
            ChangelogRelease(version: "0.1.57", notes: ["Only note"]),
        ])
    }

    @Test func joinsWrappedContinuationLines() {
        let source = "## 1.0\n- A long note\n  that wraps\n\n- Next\r\n"
        #expect(ChangelogParser.parse(source) == [ChangelogRelease(version: "1.0", notes: ["A long note that wraps", "Next"])])
    }

    @Test func proseBeforeAnyBulletIsDropped() {
        #expect(ChangelogParser.parse("## 2.0\nplain line\n- note") == [ChangelogRelease(version: "2.0", notes: ["note"])])
        #expect(ChangelogParser.parse("") == [])
    }

    @Test func splitsInlineCode() {
        #expect(ChangelogParser.splitInlineCode("run `claude update` now") == [
            InlineSegment(code: false, text: "run "), InlineSegment(code: true, text: "claude update"), InlineSegment(code: false, text: " now"),
        ])
        #expect(ChangelogParser.splitInlineCode("a `b") == [InlineSegment(code: false, text: "a `b")])
        #expect(ChangelogParser.splitInlineCode("``x") == [InlineSegment(code: false, text: "x")])
    }

    @Test func versionLabelAndCurrentMatch() {
        #expect(ChangelogParser.versionLabel("0.1.57") == "v0.1.57")
        #expect(ChangelogParser.versionLabel("V0.1.57") == "V0.1.57")
        #expect(ChangelogParser.isCurrent("v0.1.57 ", current: "0.1.57"))
        #expect(!ChangelogParser.isCurrent("0.1.56", current: "0.1.57"))
        #expect(!ChangelogParser.isCurrent("0.1.57", current: ""))
    }
}
