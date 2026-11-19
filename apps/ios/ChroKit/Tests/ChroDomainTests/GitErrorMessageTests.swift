import ChroDomain
import Testing

@Suite struct GitErrorMessageTests {
    @Test func pushRejectionWinsOverEverything() {
        let raw = "bad request: git push failed: ! [rejected] main -> main (fetch first)"
        #expect(GitErrorMessage.resolve(raw, fallback: .push) == "Remote has new changes. Pull before pushing.")
    }

    @Test func rejectionWithoutGitPushIsNotAPushRejection() {
        #expect(GitErrorMessage.resolve("hook rejected the update", fallback: .push) == "Git error: hook rejected the update")
    }

    @Test(arguments: [
        ("Authentication failed for 'https://x'", "Authentication failed. Check your credentials."),
        ("fatal: could not read Username", "Authentication failed. Check your credentials."),
        ("git@host: Permission denied (publickey).", "Permission denied. Check your SSH key or access."),
        ("remote: Repository not found.", "Repository not found. Check the remote URL."),
        ("fatal: Could not read from remote repository.", "Unable to access the remote repository."),
        ("There is no upstream branch", "No upstream branch set. Publish or set upstream."),
        ("nothing to merge: branch already in main, conflict free", "Already up to date. This branch has no changes left to merge."),
        ("this session has no commits of its own yet", "This session continues an earlier one and has no commits of its own yet. Rebasing now would only drop the point it continues from. Commit its work first, or start a new session on the base branch."),
        ("rebase conflict in README.md", "Merge conflict detected. Resolve conflicts and retry."),
        ("a rebase in progress", "Rebase in progress. Resolve or abort before retrying."),
        ("fatal: not a git repository (or any parent)", "This folder is not a Git repository."),
        ("Could not resolve host: github.com", "Network error. Check your connection."),
        ("Your local changes would be overwritten by merge", "Local changes would be overwritten. Commit or stash first."),
    ])
    func matchesTheFirstRule(raw: String, expected: String) {
        #expect(GitErrorMessage.resolve(raw, fallback: .merge) == expected)
    }

    @Test func unknownMessagesAreQuotedWithoutTheBadRequestPrefix() {
        #expect(GitErrorMessage.resolve("Bad Request:  something odd ", fallback: .commit) == "Git error: something odd")
    }

    @Test func emptyMessagesFallBackToTheVerb() {
        #expect(GitErrorMessage.resolve("", fallback: .rebase) == "Rebase failed.")
        #expect(GitErrorMessage.resolve("bad request:", fallback: .merge) == "Failed to merge changes.")
        #expect(GitErrorMessage.resolve(nil, fallback: .pull) == "Failed to pull.")
    }
}
