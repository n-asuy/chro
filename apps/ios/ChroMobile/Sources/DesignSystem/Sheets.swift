import SwiftUI
import UIKit

/// The app's bottom sheet: the platform form of a desktop menu, popover or
/// dialog. One sheet shows at a time; presenting another replaces it, as a
/// desktop menu replaces the previous one. Drawn here rather than with
/// `.sheet` so the grabber, radius and scrim match the desktop tokens.
///
/// The rise and fall are sampled per frame (`SheetMotion`) and applied as the
/// panel's offset, not run as a SwiftUI transition. A transition animates the
/// views that exist when it starts; rows a sheet loads a moment later, its
/// footer or a spinner would be drawn at their resting place while the header
/// is still on its way up. A per-frame offset moves everything in the panel,
/// whenever it appeared.
@MainActor @Observable
final class SheetPresenter {
    struct Presented: Identifiable {
        let id = UUID()
        var tall: Bool
        var content: AnyView
    }

    /// A sheet on screen: the one shown, or one on its way down.
    struct Layer: Identifiable {
        let sheet: Presented
        var motion: SheetMotion
        /// A fitted sheet's height glides when its content grows or shrinks.
        var height: SheetHeightGlide?
        var id: UUID { sheet.id }
        var isLeaving: Bool { motion.direction == .falling }
    }

    private(set) var layers: [Layer] = []
    /// Slows the motion down for UI tests (`-ChroMotionScale`).
    var motionScale: Double = 1

    /// The sheet being shown (not one on its way down).
    var current: Presented? { layers.last.flatMap { $0.isLeaving ? nil : $0.sheet } }

    func present<Content: View>(tall: Bool = false, @ViewBuilder _ content: () -> Content) {
        let now = Date()
        lowerAll(at: now)
        layers.append(Layer(sheet: Presented(tall: tall, content: AnyView(content())),
                            motion: SheetMotion(direction: .rising, start: now, from: 0, scale: motionScale)))
        scheduleCleanup()
    }

    func dismiss() {
        endEditing()
        lowerAll(at: Date())
        scheduleCleanup()
    }

    /// The end of a drag: lower the sheet from where the finger left it, or
    /// let it rise back. `shown` is the visible fraction (1 = resting).
    func release(_ id: UUID, shown: Double, dismissing: Bool) {
        guard let index = layers.firstIndex(where: { $0.id == id }), !layers[index].isLeaving else { return }
        if dismissing { endEditing() }
        layers[index].motion = SheetMotion(direction: dismissing ? .falling : .rising, start: Date(), from: shown, scale: motionScale)
        scheduleCleanup()
    }

    /// A fitted sheet's content measured `height`: the first measure sizes the
    /// sheet, later ones glide to the new height from the one on screen.
    func measured(_ id: UUID, height: CGFloat) {
        guard let index = layers.firstIndex(where: { $0.id == id }) else { return }
        let now = Date()
        guard let glide = layers[index].height else {
            layers[index].height = SheetHeightGlide(from: height, to: height, start: now, scale: motionScale)
            return
        }
        guard glide.to != height else { return }
        layers[index].height = SheetHeightGlide(from: glide.value(at: now), to: height, start: now, scale: motionScale)
        scheduleCleanup()
    }

    /// A falling sheet stays in the hierarchy until it is off screen, so a
    /// field focused in it would hold the keyboard up over the empty screen.
    /// Closing a sheet lowers the keyboard with it. (Replacing a sheet does
    /// not: the next sheet may take the focus, as the `@` picker does.)
    private func endEditing() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func lowerAll(at now: Date) {
        for index in layers.indices where !layers[index].isLeaving {
            let shown = layers[index].motion.progress(at: now)
            layers[index].motion = SheetMotion(direction: .falling, start: now, from: shown, scale: motionScale)
        }
    }

    @ObservationIgnored private var cleanup: Task<Void, Never>?

    /// Drops the sheets that finished falling and marks finished motion
    /// settled, so the per-frame timeline pauses.
    private func scheduleCleanup() {
        cleanup?.cancel()
        let end = layers.map { max($0.motion.end, $0.height?.end ?? .distantPast) }.max() ?? .now
        cleanup = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, end.timeIntervalSinceNow) + 0.02))
            guard !Task.isCancelled, let self else { return }
            let now = Date()
            layers.removeAll { $0.isLeaving && $0.motion.isFinished(at: now) }
            for index in layers.indices {
                if layers[index].motion.isFinished(at: now) { layers[index].motion.settled = true }
                if let glide = layers[index].height, glide.isFinished(at: now) { layers[index].height?.settled = true }
            }
        }
    }
}

/// How far a sheet has risen at a moment: 0 is below the screen, 1 resting.
/// A critically damped spring, so the sheet never overshoots its resting
/// place and shows a gap under it.
struct SheetMotion: Equatable {
    enum Direction { case rising, falling }

    static let spring = Spring(response: 0.3, dampingRatio: 1)
    /// Far enough up that its top rows are clear of a keyboard rising with it.
    static let risenThreshold = 0.75

    var direction: Direction
    var start: Date
    /// The progress the motion starts from (a dragged or half-risen sheet).
    var from: Double
    var scale: Double = 1
    /// The motion has ended and been observed as ended (pauses the timeline).
    var settled = false

    var target: Double { direction == .rising ? 1 : 0 }
    var end: Date { start.addingTimeInterval(Self.spring.settlingDuration * scale) }

    func progress(at date: Date) -> Double {
        let time = max(0, date.timeIntervalSince(start)) / scale
        guard time < Self.spring.settlingDuration else { return target }
        let travelled = min(1, Self.spring.value(target: 1.0, time: time))
        return from + (target - from) * travelled
    }

    func isFinished(at date: Date) -> Bool { date >= end }
}

/// A fitted sheet's height moving from one content height to the next.
struct SheetHeightGlide: Equatable {
    var from: CGFloat
    var to: CGFloat
    var start: Date
    var scale: Double = 1
    var settled = false

    var end: Date { from == to ? start : start.addingTimeInterval(SheetMotion.spring.settlingDuration * scale) }

    func value(at date: Date) -> CGFloat {
        let time = max(0, date.timeIntervalSince(start)) / scale
        guard from != to, time < SheetMotion.spring.settlingDuration else { return to }
        return from + (to - from) * CGFloat(min(1, SheetMotion.spring.value(target: 1.0, time: time)))
    }

    func isFinished(at date: Date) -> Bool { date >= end }
}

/// Hosts the presenter's sheets above `content`.
struct SheetHost<Content: View>: View {
    @Bindable var presenter: SheetPresenter
    @ViewBuilder var content: () -> Content
    @State private var keyboard: CGFloat = 0

    var body: some View {
        let moving = presenter.layers.contains { !$0.motion.settled || $0.height.map { !$0.settled } == true }
        ZStack(alignment: .bottom) {
            content()
            if !presenter.layers.isEmpty {
                TimelineView(.animation(paused: !moving)) { timeline in
                    SheetStack(presenter: presenter, now: timeline.date, keyboard: keyboard)
                }
            }
        }
        .environment(presenter)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
                  let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen else { return }
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            withAnimation(.easeOut(duration: duration)) { keyboard = max(0, screen.bounds.maxY - frame.minY) }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { note in
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            withAnimation(.easeOut(duration: duration)) { keyboard = 0 }
        }
    }
}

/// The scrim and every sheet on screen, placed for one frame. Panels stand on
/// the screen's bottom edge: a tall sheet keeps its height under the keyboard
/// (its scroll views take the keyboard as content margin), a fitted one rises
/// to sit on the keyboard.
private struct SheetStack: View {
    let presenter: SheetPresenter
    let now: Date
    let keyboard: CGFloat

    var body: some View {
        let scrim = presenter.layers.map { $0.motion.progress(at: now) }.max() ?? 0
        ZStack(alignment: .bottom) {
            Palette.scrim
                .opacity(scrim)
                .ignoresSafeArea()
                .onTapGesture { presenter.dismiss() }
                .allowsHitTesting(presenter.current != nil)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel("Close")
                .accessibilityHidden(presenter.current == nil)
            GeometryReader { proxy in
                let screen = proxy.size.height + proxy.safeAreaInsets.top
                ZStack(alignment: .bottom) {
                    ForEach(presenter.layers) { layer in
                        SheetPanel(presenter: presenter, layer: layer, now: now, screenHeight: screen,
                                   keyboard: layer.sheet.tall ? 0 : keyboard)
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .bottom)
            }
            .ignoresSafeArea(edges: .bottom)
        }
    }
}

/// One sheet: grabber, content, rounded top, offset by its motion and drag.
private struct SheetPanel: View {
    let presenter: SheetPresenter
    let layer: SheetPresenter.Layer
    let now: Date
    let screenHeight: CGFloat
    /// The keyboard height a fitted sheet rises above.
    let keyboard: CGFloat
    @State private var drag: CGFloat = 0
    @State private var panelHeight: CGFloat?

    var body: some View {
        // Until the panel is measured, a full screen's travel keeps it out of sight.
        let travel = panelHeight ?? screenHeight
        let shown = layer.motion.progress(at: now)
        VStack(spacing: 0) {
            Capsule().fill(Palette.grabber).frame(width: 36, height: 5).padding(.top, 6).padding(.bottom, 2)
                .accessibilityHidden(true)
            if layer.sheet.tall {
                layer.sheet.content.frame(maxHeight: .infinity, alignment: .top)
            } else {
                fitted
            }
        }
        .padding(.bottom, 30 + keyboard)
        .frame(maxWidth: .infinity)
        .frame(height: layer.sheet.tall ? screenHeight * 0.92 : nil, alignment: .top)
        .background(UnevenRoundedRectangle(topLeadingRadius: 12, topTrailingRadius: 12).fill(Palette.bg))
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { panelHeight = $0 }
        .offset(y: travel * (1 - shown) + max(0, drag))
        .gesture(
            DragGesture(minimumDistance: 8)
                .onChanged { drag = $0.translation.height }
                .onEnded { value in
                    let dismissing = value.translation.height > 120 || value.predictedEndTranslation.height > 260
                    presenter.release(layer.id, shown: max(0, 1 - Double(max(0, drag) / max(travel, 1))), dismissing: dismissing)
                    drag = 0
                }
        )
        .allowsHitTesting(!layer.isLeaving)
        .accessibilityHidden(layer.isLeaving)
        .environment(\.sheetHasRisen, layer.motion.direction == .rising && shown >= SheetMotion.risenThreshold)
    }

    /// A fitted sheet takes its content's height, gliding when that changes.
    private var fitted: some View {
        layer.sheet.content
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { presenter.measured(layer.id, height: $0) }
            .frame(height: layer.height?.value(at: now), alignment: .top)
            .clipped()
    }
}

extension EnvironmentValues {
    /// Inside a sheet, whether it has risen far enough for its first field to
    /// take focus: focusing earlier raises the keyboard over the sheet's top
    /// rows before they arrive. True outside sheets.
    @Entry var sheetHasRisen = true
}

/// `.sheet-h`: the one header every sheet opens with: an optional back
/// chevron, the title on the left (a count badge after it when the sheet
/// lists things), the sheet's own actions, the blue Done on the right, and
/// the sheet's search field under them when it has one. A second level that
/// names its parent uses `SheetBackHeader`, the same row with a labelled back.
struct SheetHeader<Actions: View>: View {
    /// A search field under the title row.
    struct Search {
        var placeholder: String
        var text: Binding<String>
        var autofocus = false
    }

    var title: String
    var count: Int? = nil
    var onBack: (() -> Void)? = nil
    var showsDone = true
    var doneTitle = "Done"
    /// What Done does; nil closes the sheet.
    var onDone: (() -> Void)? = nil
    var search: Search? = nil
    @ViewBuilder var actions: () -> Actions
    @Environment(SheetPresenter.self) private var presenter

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let onBack {
                    Button(action: onBack) {
                        Icon(.chevronLeft, size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.primary)
                    .accessibilityLabel("Back")
                }
                HStack(spacing: 8) {
                    Text(title)
                        .textStyle(.sheetTitle)
                        .foregroundStyle(Palette.fg)
                        .lineLimit(1, accessibility: 2)
                        .accessibilityAddTraits(.isHeader)
                    if let count { Badge(text: "\(count)") }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                actions()
                if showsDone { DoneButton(title: doneTitle) { (onDone ?? { presenter.dismiss() })() } }
            }
            .padding(.leading, onBack == nil ? 14 : 4)
            .padding(.trailing, 8)
            .padding(.top, 2)
            .padding(.bottom, search == nil ? 6 : 0)
            .frame(minHeight: 48)
            if let search {
                SheetSearchField(placeholder: search.placeholder, text: search.text, autofocus: search.autofocus)
                    .padding(.horizontal, 10)
                    .padding(.top, 2)
                    .padding(.bottom, 6)
            }
        }
    }
}

extension SheetHeader where Actions == EmptyView {
    init(title: String, count: Int? = nil, onBack: (() -> Void)? = nil, showsDone: Bool = true, doneTitle: String = "Done",
         onDone: (() -> Void)? = nil, search: Search? = nil) {
        self.init(title: title, count: count, onBack: onBack, showsDone: showsDone, doneTitle: doneTitle, onDone: onDone, search: search,
                  actions: { EmptyView() })
    }
}

/// `.sheet-h` with a back chevron for a sheet's second level.
struct SheetBackHeader: View {
    var label: String
    var title = ""
    let onBack: () -> Void
    @Environment(SheetPresenter.self) private var presenter

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onBack) {
                HStack(spacing: 0) {
                    Icon(.chevronLeft, size: 20)
                    Text(label).textStyle(TextStyle(size: 15))
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.primary)
            Text(title).textStyle(.sheetTitle).foregroundStyle(Palette.fg).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            DoneButton { presenter.dismiss() }
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
        .frame(minHeight: 48)
    }
}

/// `.menu`: the padded column of menu rows.
struct SheetMenu<Content: View>: View {
    var topPadding: CGFloat = 4
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 8)
            .padding(.top, topPadding)
            .padding(.bottom, 8)
    }
}

/// `.mi`: a 48pt menu row.
struct SheetMenuRow<Label: View>: View {
    var isHighlighted = false
    var isEnabled = true
    let action: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) { label() }
                .textStyle(.menuItem)
                .foregroundStyle(isHighlighted ? Palette.fg : Palette.t200)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(isHighlighted ? Palette.muted : .clear))
        }
        .buttonStyle(PressableStyle(pressedFill: Palette.muted, pressedForeground: Palette.fg))
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
    }
}

/// The common `.mi` shape: an optional icon, a title, an optional value and check.
struct MenuItem: View {
    var icon: LucideName? = nil
    let title: String
    var value: String? = nil
    var checked = false
    var disclosure = false
    var isHighlighted = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        SheetMenuRow(isHighlighted: isHighlighted || checked, isEnabled: isEnabled, action: action) {
            if let icon { Icon(icon, size: 18).foregroundStyle(Palette.t300) }
            Text(title).lineLimit(1, accessibility: 3)
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                if let value { Text(value).textStyle(.menuValue).lineLimit(1) }
                if checked { Icon(.check, size: 16) }
                if disclosure { Icon(.chevronRight, size: 16).opacity(value == nil ? 1 : 0.5) }
            }
            .foregroundStyle(Palette.t300)
        }
        .accessibilityLabel(title)
        .accessibilityValue(value ?? "")
        .accessibilityAddTraits(checked ? .isSelected : [])
    }
}

/// `.msep`
struct MenuSeparator: View {
    var body: some View { Rectangle().fill(Palette.muted).frame(height: 1).padding(.vertical, 4) }
}

/// `.mlabel`
struct MenuLabel: View {
    var icon: LucideName? = nil
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            if let icon { Icon(icon, size: 16) }
            Text(text)
        }
        .textStyle(.menuLabel)
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `.msearch`: the search field of a sheet (40pt drawn in the mock, 44pt
/// here so the whole field is a platform-size hit area, taller at large text).
struct SheetSearchField: View {
    let placeholder: String
    @Binding var text: String
    var iconSize: CGFloat = 15
    var autofocus = false
    @FocusState private var focused: Bool
    @State private var focusedOnce = false
    @Environment(\.sheetHasRisen) private var sheetHasRisen

    var body: some View {
        HStack(spacing: 8) {
            Icon(.search, size: iconSize).foregroundStyle(Palette.t300)
            TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Palette.t300))
                .textStyle(.search)
                .foregroundStyle(Palette.fg)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.search)
                .accessibilityLabel(placeholder)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .onAppear(perform: focusIfReady)
        .onChange(of: sheetHasRisen) { focusIfReady() }
    }

    /// Focuses once, after the sheet carrying the field has risen.
    private func focusIfReady() {
        guard autofocus, sheetHasRisen, !focusedOnce else { return }
        focusedOnce = true
        focused = true
    }
}

/// `.hint`: the centred empty-state line of a sheet.
struct SheetHint: View {
    let text: String

    var body: some View {
        Text(text)
            .textStyle(.hint)
            .foregroundStyle(Palette.t300)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity)
    }
}
