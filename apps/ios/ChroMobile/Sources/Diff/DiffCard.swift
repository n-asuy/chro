import ChroDomain
import ChroServices
import SwiftUI
import WebKit

/// `.dcard`: one file's header and, when open, its body (DiffCard of
/// diff-viewer-panel.tsx and diff-render-policy.ts).
struct DiffCard: View {
    let change: FileChange
    let scope: CheckoutScope
    let layout: DiffLayout
    let isExpanded: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void

    /// MAX_RENDERED_DIFF_BYTES.
    private static let maxRenderedBytes = 512 * 1024

    private var isImage: Bool { DiffText.isImage(change.path) }
    private var oldContent: String { change.oldContent ?? "" }
    private var newContent: String { change.newContent ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            header
            if isExpanded { bodyView.overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) } }
        }
        .background(Palette.bg)
        .overlay(Rectangle().strokeBorder(Palette.border))
    }

    private var header: some View {
        let stats = shouldBuild ? DiffHunks.stats(old: oldContent, new: newContent) : nil
        return HStack(spacing: 0) {
            IconButton(icon: isExpanded ? .chevronUp : .chevronRight, size: 14, label: isExpanded ? "Collapse" : "Expand", action: onToggle)
                .accessibilityValue(change.path)
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    Icon(isImage ? .image : .fileText, size: 13)
                    Text(change.path)
                    if isImage {
                        Text("Binary")
                    } else {
                        Text("+\(stats?.additions ?? change.additions ?? 0)").foregroundStyle(Palette.diffAdditionText)
                        Text("-\(stats?.deletions ?? change.deletions ?? 0)").foregroundStyle(Palette.diffDeletionText)
                    }
                }
                .textStyle(.code(12.5))
                .foregroundStyle(Palette.t300)
                .fixedSize()
            }
            .scrollIndicators(.hidden)
            if change.kind != .deleted {
                IconButton(icon: .externalLink, size: 14, label: "Open \(change.path)", action: onOpen)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .frame(minHeight: 48)
    }

    /// shouldBuildInlineDiff without the expansion check.
    private var shouldBuild: Bool {
        !isImage && oldContent != newContent && !change.contentOmitted
            && oldContent.utf8.count + newContent.utf8.count <= Self.maxRenderedBytes && !(oldContent.isEmpty && newContent.isEmpty)
    }

    @ViewBuilder private var bodyView: some View {
        if isImage {
            if change.kind == .deleted {
                note("Binary file deleted.", centered: true)
            } else if case .run = scope {
                ImageDiffPreview(scope: scope, path: change.path)
            } else {
                note("Binary image file. Unable to preview.")
            }
        } else if shouldBuild && DiffText.isProse(change.path) && !change.isBinary {
            ProseDiffView(old: oldContent, new: newContent, layout: layout)
        } else if shouldBuild {
            CodeDiffView(path: change.path, old: oldContent, new: newContent, layout: layout)
        } else {
            note(fallbackText)
        }
    }

    private var fallbackText: String {
        if change.isBinary { return "Binary file changed." }
        if change.contentOmitted || oldContent.utf8.count + newContent.utf8.count > Self.maxRenderedBytes {
            return "Content omitted due to file size. Open in editor to view."
        }
        if oldContent == newContent {
            return change.kind == .renamed ? "File renamed with no content changes." : "No content changes to display."
        }
        return "Failed to render diff for this file."
    }

    private func note(_ text: String, centered: Bool = false) -> some View {
        Text(text)
            .textStyle(centered ? TextStyle(size: 12) : .code(12))
            .foregroundStyle(Palette.t300)
            .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
            .padding(.horizontal, 16)
            .padding(.top, centered ? 32 : 8)
            .padding(.bottom, centered ? 32 : 16)
    }
}

/// ImageDiffPreview: the new image, letterboxed on the tonal background.
private struct ImageDiffPreview: View {
    let scope: CheckoutScope
    let path: String
    @Environment(\.panelServices) private var services
    @State private var loaded: Loaded?

    private enum Loaded {
        case bitmap(UIImage)
        case vector(String)
        case failed
    }

    var body: some View {
        Group {
            switch loaded {
            case .bitmap(let image)?:
                Image(uiImage: image).resizable().interpolation(.none).scaledToFit()
                    .frame(maxWidth: image.size.width, maxHeight: min(400, image.size.height))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.border))
                    .accessibilityLabel(path)
            case .vector(let markup)?:
                ContainedVectorImage(markup: markup).frame(height: 240).accessibilityLabel(path)
            case .failed?:
                Text("Failed to load image preview.").textStyle(TextStyle(size: 12)).foregroundStyle(Palette.t300)
            case nil:
                Spinner(size: 16).foregroundStyle(Palette.t300)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background(Palette.bg90)
        .task {
            guard let data = try? await services.sourceControl.fileData(scope, path: path) else { loaded = .failed; return }
            if let image = UIImage(data: data) {
                loaded = .bitmap(image)
            } else if let markup = String(data: data, encoding: .utf8), markup.contains("<svg") {
                loaded = .vector(markup)
            } else {
                loaded = .failed
            }
        }
    }
}

/// SVG markup scaled to fit (`object-fit: contain`), without interaction.
private struct ContainedVectorImage: UIViewRepresentable {
    let markup: String

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let page = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;height:100%;background:transparent}body{display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style>
        \(markup)
        """
        view.loadHTMLString(page, baseURL: nil)
    }
}
