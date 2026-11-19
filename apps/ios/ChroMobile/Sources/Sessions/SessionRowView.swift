import ChroDomain
import SwiftUI
import UIKit

/// The anchor of each related row's marker, for the relation connector.
struct MarkerAnchorKey: PreferenceKey {
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// `.srow`: marker, title (with the delegation count), subline, and the
/// trailing time or activity glyph.
struct SessionRowView: View {
    let row: SessionListRow
    /// Left padding before nesting: 20 in a project group, 10 in Pinned and Chats.
    let basePadding: CGFloat
    let marker: StatusMarker?
    let subline: Subline?
    let isFocused: Bool
    let isRelated: Bool
    let now: Date
    var onToggleDelegation: (() -> Void)?
    let onOpen: () -> Void

    private var session: SessionSummary { row.session }

    var body: some View {
        RowButton(action: onOpen) { pressed in
            HStack(spacing: 8) {
                StatusMarkerGlyph(marker: marker)
                    .frame(width: 18)
                    .anchorPreference(key: MarkerAnchorKey.self, value: .bounds) { isRelated ? [session.id: $0] : [:] }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(session.displayTitle)
                            .textStyle(.rowTitle)
                            .foregroundStyle(session.hasTitle ? Palette.fg : Palette.t400)
                            .lineLimit(1, accessibility: 2)
                        if row.descendantCount > 0, let onToggleDelegation {
                            DelegationCountButton(count: row.descendantCount, expanded: row.expanded, action: onToggleDelegation)
                        }
                    }
                    if let subline {
                        Text(subline.text).textStyle(.rowSubline).foregroundStyle(Palette.t400).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing
            }
            .padding(.vertical, 8)
            .padding(.leading, basePadding + 16 * CGFloat(row.depth))
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(isFocused || pressed ? Palette.pressed : .clear))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onOpen() }
        .accessibilityLabel(session.displayTitle)
        .accessibilityValue(accessibilityValue)
    }

    /// Status, subline and time, as a screen reader reads the row after its title.
    private var accessibilityValue: String {
        let status: String? = session.isRunning
            ? (session.awaitingInput ? "Waiting for your answer" : "In progress...")
            : row.hiddenNeedsInput ? "A delegated session needs your input" : marker?.label
        let time = session.isRunning ? nil : RelativeTime.format(session.updatedAt, now: now)
        return [status, subline?.text, time].compactMap { $0 }.joined(separator: ", ")
    }

    @ViewBuilder private var trailing: some View {
        HStack(spacing: 8) {
            if session.isRunning {
                ActivityGlyph(awaitingInput: session.awaitingInput)
            } else if row.hiddenNeedsInput {
                Icon(.pause, size: 16).foregroundStyle(Palette.primary).accessibilityLabel("A delegated session needs your input")
            } else {
                Text(RelativeTime.format(session.updatedAt, now: now)).textStyle(.rowTrailing).foregroundStyle(Palette.t400)
            }
        }
    }
}

/// `.kids`: "N ›" after a delegating session's title; folds its nested sessions.
struct DelegationCountButton: View {
    let count: Int
    let expanded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 1) {
                Text("\(count)").textStyle(.delegationCount)
                Icon(.chevronRight, size: 14).rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .foregroundStyle(Palette.t400)
            .padding(.leading, 7)
            .padding(.trailing, 4)
            .frame(height: 22)
            .contentShape(Rectangle().inset(by: -11))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "Hide delegated sessions" : "Show \(count) delegated sessions")
    }
}

/// The connector between the focused session and its delegation neighbours
/// (projects-panel relation lines): from each marker left to a shared rail.
struct RelationConnector: View {
    let anchors: [String: Anchor<CGRect>]
    let order: [String]

    var body: some View {
        GeometryReader { proxy in
            let points = order.compactMap { id in anchors[id].map { proxy[$0] } }
                .map { CGPoint(x: $0.minX - 3, y: $0.midY) }
            if points.count >= 2 {
                Path { path in
                    let rail: CGFloat = 4
                    let top = points[0], bottom = points[points.count - 1]
                    let radius = min(6, (bottom.y - top.y) / 2)
                    path.move(to: top)
                    path.addLine(to: CGPoint(x: rail + radius, y: top.y))
                    path.addQuadCurve(to: CGPoint(x: rail, y: top.y + radius), control: CGPoint(x: rail, y: top.y))
                    path.addLine(to: CGPoint(x: rail, y: bottom.y - radius))
                    path.addQuadCurve(to: CGPoint(x: rail + radius, y: bottom.y), control: CGPoint(x: rail, y: bottom.y))
                    path.addLine(to: bottom)
                    for point in points.dropFirst().dropLast() {
                        path.move(to: CGPoint(x: rail, y: point.y))
                        path.addLine(to: point)
                    }
                }
                .stroke(Palette.connector, style: StrokeStyle(lineWidth: 1.25, lineCap: .round))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
