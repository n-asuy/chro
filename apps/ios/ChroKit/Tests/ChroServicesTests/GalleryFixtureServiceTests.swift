import ChroDomain
import Foundation
import Testing
@testable import ChroServices

/// Mock slot 15: the images run's media, newest modified first.
struct GalleryFixtureServiceTests {
    private let service = GalleryFixtureService(checkouts: DockFixtureCheckouts())

    @Test func listsTheRunsImagesInCapturedOrder() async throws {
        let listing = try await service.media(in: .run(sessionID: "bd50a1e2-img"), limit: GalleryMedia.limit)
        #expect(listing.items.map(\.relativePath) == [
            "docs/images/sku-heatmap.png", "docs/images/warehouse-badge.svg", "docs/images/stock-trend.svg",
        ])
        #expect(listing.items.allSatisfy { $0.kind == .image && $0.size != nil && $0.modifiedAt != nil })
        #expect(!listing.truncated)
    }

    /// The main checkout's only image is the one the hand-made HTML report loads.
    @Test func theMainCheckoutListsTheReportsImage() async throws {
        let listing = try await service.media(in: .project(id: "inv"), limit: GalleryMedia.limit)
        #expect(listing.items.map(\.relativePath) == ["docs/report/heatmap.png"])
    }

    @Test func capsAtTheLimitAndSaysSo() async throws {
        let listing = try await service.media(in: .run(sessionID: "bd50a1e2-img"), limit: 2)
        #expect(listing.items.count == 2)
        #expect(listing.truncated)
    }

    @Test func checkoutsWithoutMediaAreEmpty() async throws {
        #expect(try await service.media(in: .project(id: "pricing"), limit: GalleryMedia.limit).items.isEmpty)
        #expect(try await service.media(in: .run(sessionID: "7a3f5d10-add"), limit: GalleryMedia.limit).items.isEmpty)
    }

    @Test func unknownScopeIsNotFound() async {
        await #expect(throws: ServiceError.self) { try await service.media(in: .run(sessionID: "missing"), limit: 10) }
    }

    @Test func servesTheBytesOfAMediaFile() async throws {
        let data = try await service.mediaData(in: .run(sessionID: "bd50a1e2-img"), path: "docs/images/sku-heatmap.png")
        #expect(data.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        await #expect(throws: ServiceError.self) {
            try await service.mediaData(in: .run(sessionID: "bd50a1e2-img"), path: "README.md")
        }
    }
}

/// Mock slot 16: the captured skill cards.
struct SkillsFixtureServiceTests {
    @Test func listsTheCapturedCardsWithTheWorkspaceSkillFirst() async throws {
        let skills = try await SkillsFixtureService(scenario: .standard).skills(workspacePath: "/private/tmp/mm/iso/inventory-service")
        #expect(skills.map(\.name) == ["restock-check", "agent-browser", "agents-sdk", "amend-cli"])
        #expect(skills[0].scope == .workspace)
        #expect(skills[0].absDir == "/private/tmp/mm/iso/inventory-service/.claude/skills/restock-check")
        #expect(skills.dropFirst().allSatisfy { $0.scope == .user && $0.provider == .claude })
    }

    @Test func withoutAWorkspaceOnlyUserSkillsAreListed() async throws {
        let skills = try await SkillsFixtureService(scenario: .standard).skills(workspacePath: nil)
        #expect(skills.allSatisfy { $0.scope == .user })
    }

    @Test func hiddenEntriesAreOffAsCaptured() async throws {
        #expect(try await SkillsFixtureService(scenario: .standard).showsHiddenEntries() == false)
    }
}
