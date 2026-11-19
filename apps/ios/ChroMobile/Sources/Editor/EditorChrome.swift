import ChroDomain
import SwiftUI
import UIKit

/// The editor's monospaced face (the mock's `--mono`, SF Mono first).
enum EditorFont {
    static func mono(_ size: CGFloat) -> UIFont { .monospacedSystemFont(ofSize: size, weight: .regular) }
}

/// The editor's per-device and shared text settings: the font size is kept
/// on the phone (`DeviceSettingKey.editorFontSize`), the line height is the
/// desktop's (`/rpc/preferences/editor`).
struct EditorMetrics: Equatable {
    var fontSize: CGFloat
    var lineHeight: CGFloat

    /// The code layout draws two points under the prose size (`--ed-fs: fontSize - 2`).
    var codeSize: CGFloat { fontSize - 2 }
    var codeLine: CGFloat { codeSize * lineHeight }

    static let standard = EditorMetrics(fontSize: CGFloat(EditorChoices.defaultFontSize), lineHeight: CGFloat(EditorChoices.defaultLineHeight))
}

/// `.fe-head`: the file name, its root-relative path, the viewer's own tools
/// (the HTML toolbar) and the Changes toggle, in the desktop's order.
struct FileHeader<Tools: View>: View {
    let path: String
    var showsChanges = false
    var changesOn = false
    var onChanges: () -> Void = {}
    @ViewBuilder var tools: () -> Tools

    var body: some View {
        HStack(spacing: 8) {
            Text(FilePath.name(path)).textStyle(TextStyle(size: 13.5, weight: 500)).foregroundStyle(Palette.fg).lineLimit(1).layoutPriority(1)
            Text("/" + path).textStyle(TextStyle(size: 13.5)).foregroundStyle(Palette.t300).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            tools()
            if showsChanges {
                HeaderToggle(icon: .gitCompareArrows, title: "Changes", isOn: changesOn, action: onChanges)
                    .accessibilityLabel(changesOn ? "Back to the editor" : "Show changes against the base version")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .frame(minHeight: 44)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

extension FileHeader where Tools == EmptyView {
    init(path: String, showsChanges: Bool = false, changesOn: Bool = false, onChanges: @escaping () -> Void = {}) {
        self.init(path: path, showsChanges: showsChanges, changesOn: changesOn, onChanges: onChanges) { EmptyView() }
    }
}

/// A small labelled button of the file header (the desktop's `size="sm"` header
/// buttons: ghost, or secondary while on).
struct HeaderToggle: View {
    let icon: LucideName
    let title: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Icon(icon, size: 14)
                Text(title).textStyle(TextStyle(size: 12.5, weight: 500)).lineLimit(1)
            }
            .foregroundStyle(Palette.t200)
            .padding(.horizontal, 8)
            .frame(height: 32)
            .background(RoundedRectangle(cornerRadius: 6).fill(isOn ? Palette.muted : .clear))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// `.ffind`: the find-in-file bar (components/find-bar.tsx).
struct FileFindBar: View {
    @Binding var query: String
    let counter: String
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onClose: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 2) {
            Icon(.search, size: 15).foregroundStyle(Palette.t300)
            TextField("", text: $query, prompt: Text("Find...").foregroundStyle(Palette.t300))
                .textStyle(TextStyle(size: 15))
                .foregroundStyle(Palette.fg)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.search)
                .onSubmit(onNext)
                .accessibilityLabel("Find in file")
                .frame(height: 40)
                .padding(.leading, 6)
            Text(counter).textStyle(TextStyle(size: 12.5, tabular: true)).foregroundStyle(Palette.t300).padding(.horizontal, 4)
            stepButton(.arrowUp, "Previous match", onPrevious)
            stepButton(.arrowDown, "Next match", onNext)
            stepButton(.x, "Close find bar", onClose)
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 8).surface(Palette.bg, elevation: .floating))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .onAppear { focused = true }
    }

    private func stepButton(_ icon: LucideName, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(icon, size: 16).frame(width: 40, height: 44).contentShape(Rectangle()) }
            .buttonStyle(PressableStyle(pressedForeground: Palette.fg))
            .foregroundStyle(Palette.t300)
            .accessibilityLabel(label)
    }
}

/// The keyboard's accessory bar (`.kbar`): Undo, Redo and Find stand in for
/// Cmd+Z/Y/F; prose adds the desktop's bubble formatting menu.
struct KeyboardBar: View {
    struct Format {
        let icon: LucideName
        let label: String
        let action: () -> Void
    }

    let onUndo: () -> Void
    let onRedo: () -> Void
    var onFind: (() -> Void)?
    var formats: [[Format]] = []
    let onDone: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            key(.undo2, "Undo", 18, onUndo)
            key(.redo2, "Redo", 18, onRedo)
            if let onFind { key(.search, "Find in file", 18, onFind) }
            ForEach(Array(formats.enumerated()), id: \.offset) { _, group in
                Rectangle().fill(Color(hex: 0x17181B).opacity(0.18)).frame(width: 1, height: 20).padding(.horizontal, 2)
                ForEach(group, id: \.label) { format in key(format.icon, format.label, 17, format.action) }
            }
            Spacer(minLength: 0)
            Button(action: onDone) {
                Text("Done").textStyle(.done).foregroundStyle(Color(hex: 0x007AFF))
                    .padding(.horizontal, 12).frame(height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 6)
        .frame(height: 44)
        .frame(maxWidth: .infinity)
        .background(Color(hex: 0xD1D4DA))
        .overlay(alignment: .top) { Rectangle().fill(Color(hex: 0xBFC3CA)).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Text formatting")
    }

    private func key(_ icon: LucideName, _ label: String, _ size: CGFloat, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(icon, size: size).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .buttonStyle(PressableStyle(pressedFill: Color.black.opacity(0.08)))
            .foregroundStyle(Color(hex: 0x17181B))
            .accessibilityLabel(label)
    }
}

/// The Large file notice (files-editor.tsx): an amber band above a read-only preview.
struct LargeFileNotice: View {
    let size: Int

    var body: some View {
        Text("Large file (\(FileSize.label(size))). Showing a read-only preview of the beginning of the file; full editing is disabled to keep the app responsive.")
            .textStyle(TextStyle(size: 12, lineHeight: 1.5))
            .foregroundStyle(Palette.t200)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.amber.opacity(0.1))
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.amber.opacity(0.3)).frame(height: 1) }
            .accessibilityAddTraits(.updatesFrequently)
    }
}

/// A centred line in place of a viewer (Loading file…, the server's error).
struct EditorStatus: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .textStyle(TextStyle(size: 14))
            .foregroundStyle(isError ? Palette.destructive : Palette.t300)
            .multilineTextAlignment(.center)
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
