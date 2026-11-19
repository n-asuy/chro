import ChroDomain
import XCTest

/// session-input-controls.tsx, executor-setting-locks.ts, session-references-popover.tsx,
/// lib/git-error.ts and conflict-banner.tsx.
final class SessionComposerRulesTests: XCTestCase {
    func testSendControls() {
        XCTAssertEqual(SendControls.resolve(isRunning: false, isStopping: false, isEmpty: true, isUploading: false), .send(enabled: false))
        XCTAssertEqual(SendControls.resolve(isRunning: false, isStopping: false, isEmpty: false, isUploading: false), .send(enabled: true))
        XCTAssertEqual(SendControls.resolve(isRunning: false, isStopping: false, isEmpty: false, isUploading: true), .send(enabled: false),
                       "send waits for uploads")
        XCTAssertEqual(SendControls.resolve(isRunning: true, isStopping: false, isEmpty: true, isUploading: false), .running(canQueue: false))
        XCTAssertEqual(SendControls.resolve(isRunning: true, isStopping: false, isEmpty: false, isUploading: false), .running(canQueue: true))
        XCTAssertEqual(SendControls.resolve(isRunning: true, isStopping: false, isEmpty: false, isUploading: true), .running(canQueue: false))
        XCTAssertEqual(SendControls.resolve(isRunning: true, isStopping: true, isEmpty: false, isUploading: false), .stopping)
    }

    func testExecutorLocks() {
        XCTAssertEqual(ExecutorLocks(hasRun: false, isRunning: false), ExecutorLocks(runtimeLocked: false, modelLocked: false))
        XCTAssertEqual(ExecutorLocks(hasRun: true, isRunning: false), ExecutorLocks(runtimeLocked: true, modelLocked: false))
        XCTAssertEqual(ExecutorLocks(hasRun: true, isRunning: true), ExecutorLocks(runtimeLocked: true, modelLocked: true))
        XCTAssertTrue(ExecutorLocks(hasRun: true, isRunning: true).pickerDisabled)
        XCTAssertFalse(ExecutorLocks(hasRun: true, isRunning: false).pickerDisabled)
    }

    func testReferenceRelationsAndTrailingState() {
        XCTAssertEqual(SessionRelation.delegatedTo.label, "Delegated to")
        XCTAssertEqual(SessionRelation.delegatedFrom.label, "Delegated from")
        XCTAssertEqual(SessionRelation.continuedFrom.label, "Continued from")
        XCTAssertEqual(SessionRelation.continuedIn.label, "Continued in")
        XCTAssertEqual(SessionRelation.uses.label, "Uses")
        XCTAssertEqual(SessionRelation.referencedBy.label, "Referenced by")
        XCTAssertEqual(SessionRelation(rawValue: "delegated_to"), .delegatedTo)
        XCTAssertEqual(ReferenceRunState.derive(isRunning: true, awaitingInput: false, status: "in_progress"), .running(awaitingInput: false))
        XCTAssertEqual(ReferenceRunState.derive(isRunning: false, awaitingInput: false, status: "completed").suffix, " · Done")
        XCTAssertEqual(ReferenceRunState.derive(isRunning: false, awaitingInput: false, status: "failed").suffix, " · Failed")
        XCTAssertNil(ReferenceRunState.derive(isRunning: false, awaitingInput: false, status: "cancelled").suffix)
    }

    func testGitErrorMessages() {
        XCTAssertEqual(GitErrorText.resolve("bad request: rebase conflict in README.md", fallback: "Rebase failed."),
                       "Merge conflict detected. Resolve conflicts and retry.")
        XCTAssertEqual(GitErrorText.resolve("git push failed: rejected (fetch first)", fallback: "x"), "Remote has new changes. Pull before pushing.")
        XCTAssertEqual(GitErrorText.resolve("Nothing to merge: conflict-free", fallback: "x"),
                       "Already up to date. This branch has no changes left to merge.", "read before the broad conflict matcher")
        XCTAssertEqual(GitErrorText.resolve("weird", fallback: "x"), "Git error: weird")
        XCTAssertEqual(GitErrorText.resolve("  ", fallback: "Failed to abort."), "Failed to abort.")
    }

    func testConflictBanner() {
        let banner = ConflictBannerText(operation: .rebase, branch: "ch/c453-reword-readme-summary", target: "main",
                                        files: (1...10).map { "f\($0).md" })
        XCTAssertEqual(banner.message, "Rebase in progress: 'ch/c453-reword-readme-summary' → 'main'. Follow-ups are allowed; some actions may be temporarily unavailable until you resolve the conflicts or abort the rebase.")
        XCTAssertEqual(banner.visibleFiles.count, 8)
        XCTAssertEqual(banner.filesHeading, "Conflicted files (8 of 10):")
        XCTAssertEqual(banner.abortTitle, "Abort Rebase")
        let merge = ConflictBannerText(operation: .merge, branch: nil, target: "main", files: ["README.md"])
        XCTAssertEqual(merge.message, "A Git operation with merge conflicts is in progress. Follow-ups are allowed; some actions may be temporarily unavailable until you resolve the conflicts or abort the merge.")
        XCTAssertEqual(merge.filesHeading, "Conflicted files (1):")
        XCTAssertEqual(ConflictOperation(rawValue: "cherry_pick")?.title, "Cherry-pick")
    }
}
