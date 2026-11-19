import ChroDomain
import Foundation
import Testing
@testable import ChroServices

private let added = CheckoutScope.run(sessionID: DockFixtureCheckouts.Run.added)
private let reworded = DockFixtureCheckouts.Run.reworded
private let inventory = CheckoutScope.project(id: DockFixtureCheckouts.inventoryProjectID)

private func service(_ options: PanelFixtureOptions = PanelFixtureOptions()) -> (SourceControlFixtureService, DockFixtureCheckouts) {
    let checkouts = DockFixtureCheckouts()
    return (SourceControlFixtureService(checkouts: checkouts, options: options), checkouts)
}

private func gitMessage(_ body: () async throws -> Void) async -> String? {
    do {
        try await body()
        return nil
    } catch SourceControlError.git(let message) {
        return message
    } catch {
        return "unexpected: \(error)"
    }
}

/// Mock slot 8: the first capture's run, three files ahead of main.
struct SourceControlCapturedRunTests {
    @Test func allChangesListTheRunsThreeFiles() async throws {
        let (sc, _) = service()
        let changes = try await sc.changes(added, base: "main")
        #expect(changes.map(\.path) == ["README.md", "src/stock.test.ts", "src/stock.ts"])
        #expect(changes.map(\.kind) == [.modified, .added, .modified])
        #expect(changes.map(\.additions) == [1, 27, 7])
        #expect(changes.map(\.deletions) == [0, 0, 0])
    }

    @Test func statusHasTheBranchAndNothingUncommitted() async throws {
        let (sc, _) = service()
        let status = try await sc.status(added)
        #expect(status.currentBranch == "ch/e7a6-add-removestock-to-stock")
        #expect(status.staged.isEmpty && status.modified.isEmpty && status.untracked.isEmpty)
        #expect(status.commitsAhead == 0 && status.commitsBehind == 0)
        #expect(try await sc.changes(added, base: nil).isEmpty)
    }

    @Test func branchStatusIsTwoAheadOfMain() async throws {
        let (sc, _) = service()
        let branch = try await sc.branchStatus(sessionID: DockFixtureCheckouts.Run.added)
        #expect(branch == BranchStatus(commitsAhead: 2, commitsBehind: 0, targetBranch: "main", isRebaseInProgress: false, conflictedFiles: [], mergeCount: 0))
    }

    @Test func runDiffMatchesAllChanges() async throws {
        let (sc, _) = service()
        let diff = try await sc.runDiff(sessionID: DockFixtureCheckouts.Run.added)
        #expect(diff == (try await sc.changes(added, base: "main")))
    }

    @Test func mergeLandsTheBranch() async throws {
        let (sc, _) = service()
        try await sc.merge(sessionID: DockFixtureCheckouts.Run.added)
        let branch = try await sc.branchStatus(sessionID: DockFixtureCheckouts.Run.added)
        #expect(branch.commitsAhead == 0 && branch.mergeCount == 1)
        let again = await gitMessage { try await sc.merge(sessionID: DockFixtureCheckouts.Run.added) }
        #expect(again == "nothing to merge")
    }

    @Test func failingDiffLoadIsNotAGitError() async {
        let (sc, _) = service(PanelFixtureOptions(failingDiffLoad: true))
        let message = await gitMessage { _ = try await sc.runDiff(sessionID: DockFixtureCheckouts.Run.added) }
        #expect(message?.hasPrefix("unexpected:") == true)
    }

    @Test func imageBytesComeFromTheCheckout() async throws {
        let (sc, _) = service()
        let data = try await sc.fileData(.run(sessionID: DockFixtureCheckouts.Run.images), path: "docs/images/sku-heatmap.png")
        #expect(data == DockFixtureMedia.skuHeatmap)
    }
}

/// Mock slot 21: rebasing "Reword README summary" onto main stops on README.md.
struct SourceControlConflictTests {
    @Test func rebaseConflictsOnTheReadme() async throws {
        let (sc, _) = service()
        let message = await gitMessage { try await sc.rebase(sessionID: reworded, onto: "main") }
        #expect(message == "rebase conflict in README.md")
        let branch = try await sc.branchStatus(sessionID: reworded)
        #expect(branch.conflictedFiles == ["README.md"] && branch.isRebaseInProgress)
        #expect(try await sc.status(.run(sessionID: reworded)).currentBranch == nil)
        let diff = try await sc.runDiff(sessionID: reworded)
        #expect(diff.map(\.path) == [".claude/skills/restock-check/SKILL.md", "README.md"])
        #expect(diff[1].newContent?.contains("<<<<<<< HEAD") == true)
    }

    @Test func mergingABehindBranchReplaysItAndConflicts() async throws {
        let (sc, _) = service()
        let message = await gitMessage { try await sc.merge(sessionID: reworded) }
        #expect(message == "rebase conflict in README.md")
        #expect(try await sc.branchStatus(sessionID: reworded).conflictedFiles == ["README.md"])
    }

    @Test func abortRestoresTheBranch() async throws {
        let (sc, _) = service()
        _ = await gitMessage { try await sc.rebase(sessionID: reworded, onto: "main") }
        try await sc.abortConflicts(sessionID: reworded)
        let branch = try await sc.branchStatus(sessionID: reworded)
        #expect(branch == BranchStatus(commitsAhead: 1, commitsBehind: 2, targetBranch: "main", isRebaseInProgress: false, conflictedFiles: [], mergeCount: 0))
        #expect(try await sc.status(.run(sessionID: reworded)).currentBranch == "ch/c453-reword-readme-summary")
        let diff = try await sc.runDiff(sessionID: reworded)
        #expect(diff.map(\.path) == ["README.md"])
        #expect(diff[0].additions == 1 && diff[0].deletions == 1)
    }

    @Test func rebaseWithoutConflictsCatchesUp() async throws {
        let (sc, _) = service()
        try await sc.rebase(sessionID: DockFixtureCheckouts.Run.images, onto: "main")
        #expect(try await sc.branchStatus(sessionID: DockFixtureCheckouts.Run.images).commitsBehind == 0)
    }
}

/// Uncommitted work in the main checkout: stage, commit, push, discard.
struct SourceControlWorkingTreeTests {
    private func edit(_ checkouts: DockFixtureCheckouts, _ path: String, _ text: String) {
        checkouts.update(inventory) { $0.nodes[path] = .text(text) }
    }

    @Test func projectStartsCleanOnMain() async throws {
        let (sc, _) = service()
        let status = try await sc.status(inventory)
        #expect(status.currentBranch == "main" && !status.hasChanges)
        #expect(try await sc.changes(inventory, base: "main").isEmpty)
    }

    @Test func editsShowAsModifiedAndNewFilesAsUntracked() async throws {
        let (sc, checkouts) = service()
        edit(checkouts, "README.md", "# changed\n")
        edit(checkouts, "notes.md", "new\n")
        let status = try await sc.status(inventory)
        #expect(status.modified == [GitFileEntry(path: "README.md", status: .modified)])
        #expect(status.untracked == ["notes.md"])
        let changes = try await sc.changes(inventory, base: nil)
        #expect(changes.map(\.path) == ["README.md", "notes.md"])
        #expect(changes.map(\.kind) == [.modified, .added])
    }

    @Test func stageCommitAndPush() async throws {
        let (sc, checkouts) = service()
        edit(checkouts, "README.md", "# changed\n")
        let staged = try await sc.stage(inventory, paths: ["README.md"])
        #expect(staged.staged == [GitFileEntry(path: "README.md", status: .modified)] && staged.modified.isEmpty)
        let unstaged = try await sc.unstage(inventory, paths: ["README.md"])
        #expect(unstaged.staged.isEmpty && unstaged.modified.count == 1)
        _ = try await sc.stage(inventory, paths: ["README.md"])
        try await sc.commit(inventory, message: "backup: now")
        let committed = try await sc.status(inventory)
        #expect(!committed.hasChanges && committed.commitsAhead == 1)
        let pushed = try await sc.push(inventory)
        #expect(pushed.commitsAhead == 0)
    }

    @Test func aLostAnswerAppliesTheChangeAndReportsAnUnknownOutcome() async throws {
        let checkouts = DockFixtureCheckouts()
        let sc = LostAnswerSourceControl(base: SourceControlFixtureService(checkouts: checkouts, options: PanelFixtureOptions()))
        edit(checkouts, "README.md", "# changed\n")
        await #expect(throws: ServiceError.outcomeUnknown("The desktop did not answer in time.")) {
            _ = try await sc.stage(inventory, paths: ["README.md"])
        }
        // Reading again shows what happened: the file is staged.
        #expect(try await sc.status(inventory).staged == [GitFileEntry(path: "README.md", status: .modified)])
        await #expect(throws: ServiceError.outcomeUnknown("The desktop did not answer in time.")) {
            try await sc.commit(inventory, message: "backup: now")
        }
        #expect(try await sc.status(inventory).commitsAhead == 1)
    }

    @Test func commitNeedsStagedFiles() async {
        let (sc, _) = service()
        let message = await gitMessage { try await sc.commit(inventory, message: "x") }
        #expect(message == "nothing to commit, working tree clean")
    }

    @Test func discardRestoresHeadAndRemovesUntracked() async throws {
        let (sc, checkouts) = service()
        edit(checkouts, "README.md", "# changed\n")
        edit(checkouts, "notes.md", "new\n")
        _ = try await sc.discard(inventory, paths: ["README.md"])
        #expect(checkouts.checkout(inventory)?.nodes["README.md"]?.text == DockFixtureCheckouts.Content.readmeMain.joined(separator: "\n"))
        let status = try await sc.discardAll(inventory)
        #expect(!status.hasChanges)
        #expect(checkouts.checkout(inventory)?.nodes["notes.md"] == nil)
    }

    @Test func folderThatIsNotARepositoryFails() async {
        let (sc, _) = service()
        let message = await gitMessage { _ = try await sc.status(.project(id: DockFixtureCheckouts.pricingProjectID)) }
        #expect(message == "fatal: not a git repository (or any of the parent directories): .git")
    }

    @Test func updatesFireOnEveryChange() async throws {
        let (sc, checkouts) = service()
        var iterator = sc.updates(inventory).makeAsyncIterator()
        _ = await iterator.next()
        edit(checkouts, "README.md", "x\n")
        #expect(await iterator.next() != nil)
    }
}
