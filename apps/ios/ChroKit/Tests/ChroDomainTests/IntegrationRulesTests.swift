import ChroDomain
import Testing

@Suite struct IntegrationRulesTests {
    private func state(ahead: Int = 0, behind: Int = 0, target: String? = "main", conflicts: Int = 0, rebaseInProgress: Bool = false,
                       rebasing: Bool = false, merging: Bool = false, merged: Bool = false) -> IntegrationState {
        IntegrationState(targetBranch: target, commitsAhead: ahead, commitsBehind: behind, conflictedFileCount: conflicts,
                         isRebaseInProgress: rebaseInProgress, isRebasing: rebasing, isMerging: merging, didMerge: merged)
    }

    @Test func aheadBranchCanMergeButNotRebase() {
        let s = state(ahead: 2)
        #expect(s.canMerge && !s.canRebase)
        #expect(s.rebaseLabel == "Rebase onto main" && s.rebaseBadge == nil)
        #expect(s.mergeLabel == "Merge into main" && s.mergeBadge == "2 ahead")
        #expect(s.rebaseHint == "Already up to date with main")
        #expect(s.mergeHint == "Merge this branch into main")
        #expect(s.blockedNotice == nil)
    }

    @Test func behindAndAheadOffersBoth() {
        let s = state(ahead: 1, behind: 2)
        #expect(s.canMerge && s.canRebase)
        #expect(s.rebaseBadge == "2 behind")
        #expect(s.mergeHint == "Replay this branch on top of main, then merge it")
        #expect(s.rebaseHint == "Replay this branch on top of main")
    }

    @Test func nothingAheadCannotMerge() {
        #expect(state(behind: 1).mergeHint == "No commits to merge yet")
        #expect(!state(behind: 1).canMerge)
    }

    @Test func conflictsBlockBoth() {
        let s = state(ahead: 1, behind: 2, conflicts: 1)
        #expect(!s.canMerge && !s.canRebase)
        #expect(s.blockedNotice == "Resolve 1 conflicted file to continue")
        #expect(state(conflicts: 3).blockedNotice == "Resolve 3 conflicted files to continue")
        #expect(state(rebaseInProgress: true).blockedNotice == "Finish the in-progress rebase to continue")
        #expect(s.mergeHint == "Resolve the in-progress rebase first")
    }

    @Test func unknownTargetWaits() {
        let s = state(ahead: 1, behind: 1, target: nil)
        #expect(!s.canMerge && !s.canRebase)
        #expect(s.rebaseLabel == "Rebase onto base")
        #expect(s.mergeHint == "Waiting for the run's target branch")
    }

    @Test func inFlightLabels() {
        #expect(state(behind: 1, rebasing: true).rebaseLabel == "Rebasing…")
        #expect(!state(behind: 1, rebasing: true).canRebase)
        #expect(state(ahead: 1, merging: true).mergeLabel == "Merging…")
        #expect(state(merged: true).mergeLabel == "Merged")
    }
}
