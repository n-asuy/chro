import ChroDomain
import SwiftUI

/// system/release-notes-modal.tsx as a pushed screen: every bundled release,
/// newest first, with the running build's marked Current.
struct ReleaseNotesScreen: View {
    var releases = AppVersion.releases
    var current = AppVersion.current
    @Environment(Router.self) private var router

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                HStack(spacing: 8) {
                    Text("Release notes").textStyle(.navTitle).foregroundStyle(Palette.fg)
                        .accessibilityAddTraits(.isHeader)
                    Text(ChangelogParser.versionLabel(current))
                        .textStyle(TextStyle(size: 11.5, weight: 500, tabular: true))
                        .foregroundStyle(Palette.t300)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Palette.muted))
                }
                .padding(.horizontal, 52)
                HStack {
                    BackButton { router.pop() }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
            }
            .frame(height: 48)
            Rectangle().fill(Palette.border.opacity(0.6)).frame(height: 1)
            ScrollView {
                if releases.isEmpty {
                    Text("No release notes yet.").textStyle(TextStyle(size: 13)).foregroundStyle(Palette.t300)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)
                        .padding(.top, 6)
                } else {
                    LazyVStack(alignment: .leading, spacing: 25) {
                        ForEach(releases) { release in ReleaseEntry(release: release, isCurrent: ChangelogParser.isCurrent(release.version, current: current)) }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 6)
                    .padding(.bottom, 40)
                }
            }
            .scrollIndicators(.hidden)
        }
        .background(Palette.bg.ignoresSafeArea())
    }
}

private struct ReleaseEntry: View {
    let release: ChangelogRelease
    let isCurrent: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 8) {
                Text(ChangelogParser.versionLabel(release.version)).textStyle(TextStyle(size: 15, weight: 600, tabular: true))
                    .foregroundStyle(Palette.fg)
                if isCurrent {
                    Text("Current").textStyle(TextStyle(size: 10.5, weight: 500, tracking: 0.04, uppercase: true))
                        .foregroundStyle(Palette.primary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Palette.primary.opacity(0.1)))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            if !release.notes.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(release.notes.enumerated()), id: \.offset) { _, note in
                        HStack(alignment: .firstTextBaseline, spacing: 9) {
                            Circle().fill(Palette.t300.opacity(0.5)).frame(width: 4, height: 4)
                                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            Self.note(note, dynamicTypeSize)
                                .textStyle(TextStyle(size: 14.5, lineHeight: 1.625))
                                .foregroundStyle(Palette.fg.opacity(0.85))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    /// Plain text with `code` spans on a muted chip.
    private static func note(_ text: String, _ dynamicTypeSize: DynamicTypeSize) -> Text {
        ChangelogParser.splitInlineCode(text).reduce(Text("")) { result, segment in
            guard segment.code else { return result + Text(segment.text) }
            var code = AttributedString(segment.text)
            code.font = TextStyle.code(12).font(dynamicTypeSize)
            code.backgroundColor = Palette.muted
            code.foregroundColor = Palette.fg.opacity(0.9)
            return result + Text(code)
        }
    }
}
