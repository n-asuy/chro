import ChroDomain
import Testing

/// task-conversation.tsx: the conversation follows new content while the reader
/// is at the bottom (within 50pt); scrolling up stops following; a submit jumps back.
struct ConversationFollowTests {
    /// A viewport whose end is shown at offset 1000.
    private func at(_ offset: Double, bottom: Double = 1000) -> ConversationFollow.Geometry {
        ConversationFollow.Geometry(offset: offset, bottomOffset: bottom)
    }

    @Test func aNewConversationFollows() {
        #expect(ConversationFollow().isFollowing)
    }

    @Test func scrollingUpStopsFollowingEvenWithinTheThreshold() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.scrolled(to: at(990), byReader: true)
        #expect(!follow.isFollowing, "currentScrollTop < prevScrollTop stops following")
    }

    @Test func scrollingDownFollowsOnlyNearTheBottom() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.scrolled(to: at(400), byReader: true)
        follow.scrolled(to: at(900), byReader: true)
        #expect(!follow.isFollowing, "100pt from the end")
        follow.scrolled(to: at(951), byReader: true)
        #expect(follow.isFollowing, "within 50pt of the end")
    }

    @Test func theBounceBelowTheEndIsNotAScrollUp() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.scrolled(to: at(1080), byReader: true)
        follow.scrolled(to: at(1020), byReader: true)
        follow.scrolled(to: at(1000), byReader: true)
        #expect(follow.isFollowing)
    }

    @Test func contentGrowingBelowTheReaderDoesNotChangeTheirChoice() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.scrolled(to: at(600), byReader: true)
        follow.scrolled(to: at(600, bottom: 1400), byReader: false)
        #expect(!follow.isFollowing)
    }

    /// The view clamps the offset when content shrinks at the end (a finished
    /// turn drops its working row): that is not the reader scrolling up.
    @Test func aClampWhileFollowingKeepsFollowing() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.scrolled(to: at(970, bottom: 970), byReader: false)
        #expect(follow.isFollowing)
    }

    @Test func reachingTheEndWithoutTheReaderResumesFollowing() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.scrolled(to: at(500), byReader: true)
        follow.scrolled(to: at(500, bottom: 520), byReader: false)
        #expect(follow.isFollowing, "isAtBottom() after the content shrank under the reader")
    }

    @Test func aJumpAwayFromTheEndStopsFollowing() {
        var follow = ConversationFollow()
        follow.jumped(to: at(1000))
        follow.release()
        #expect(!follow.isFollowing, "find and the message navigator move the reader on purpose")
    }

    @Test func aSubmitJumpFollowsAgain() {
        var follow = ConversationFollow()
        follow.scrolled(to: at(200), byReader: true)
        follow.jumped(to: at(1000))
        #expect(follow.isFollowing)
        follow.scrolled(to: at(1000), byReader: true)
        #expect(follow.isFollowing, "the jump is the baseline for the next direction")
    }
}
