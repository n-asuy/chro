import AVKit
import ChroDomain
import ChroServices
import PDFKit
import SwiftUI

/// `.mv-h`: the media header (dimensions or page count, zoom, rotate).
private struct MediaHeader: View {
    let meta: String
    let zoom: Double
    let limits: ViewerZoom
    let onZoomOut: () -> Void
    let onZoomIn: () -> Void
    let onRotate: () -> Void

    var body: some View {
        HStack(spacing: 2) {
            Text(meta).textStyle(TextStyle(size: 13, tabular: true)).foregroundStyle(Palette.t300).frame(maxWidth: .infinity, alignment: .leading)
            IconButton(icon: .zoomOut, size: 17, label: "Zoom out", action: onZoomOut).disabled(!limits.canZoomOut(zoom)).opacity(limits.canZoomOut(zoom) ? 1 : 0.4)
            Text(ViewerZoom.percent(zoom)).textStyle(TextStyle(size: 13, tabular: true)).foregroundStyle(Palette.t300).frame(minWidth: 52)
            IconButton(icon: .zoomIn, size: 17, label: "Zoom in", action: onZoomIn).disabled(!limits.canZoomIn(zoom)).opacity(limits.canZoomIn(zoom) ? 1 : 0.4)
            Rectangle().fill(Palette.border).frame(width: 1, height: 16).padding(.horizontal, 4)
            IconButton(icon: .rotateCw, size: 17, label: "Rotate", action: onRotate)
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(height: 52)
        .background(Palette.bg.opacity(0.95))
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

/// `.mv-foot`: the path and a size.
private struct MediaFooter: View {
    let path: String
    let detail: String?

    var body: some View {
        HStack(spacing: 16) {
            Text(path).lineLimit(1).truncationMode(.middle)
            if let detail { Text(detail).lineLimit(1) }
            Spacer(minLength: 0)
        }
        .textStyle(TextStyle(size: 12.5, tabular: true))
        .foregroundStyle(Palette.t300)
        .padding(.horizontal, 16)
        .frame(height: 40)
        .frame(maxWidth: .infinity)
        .background(Palette.bg90.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

/// Loads a media file's bytes once per location.
@MainActor @Observable
final class MediaLoad {
    enum State { case loading, loaded(BinaryFile), failed(String) }
    var state: State = .loading

    func load(_ path: String, scope: CheckoutScope, editor: any EditorService, failure: String) async {
        do {
            state = .loaded(try await editor.readBinary(path, in: scope))
        } catch let error as EditorError {
            state = .failed(error.message.isEmpty ? failure : error.message)
        } catch {
            state = .failed(failure)
        }
    }
}

// MARK: Image

/// image-viewer.tsx: fit to the screen, zoom 25%–800% by buttons or pinch, rotate by 90°.
struct ImageFileScreen: View {
    let location: FileLocation
    let scope: CheckoutScope
    @Environment(\.panelServices) private var services
    @State private var load = MediaLoad()
    @State private var zoom = 1.0
    @State private var pinch = 1.0
    @State private var rotation = 0

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path)
            switch load.state {
            case .loading:
                Palette.bg90.overlay { Text("Loading image...").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300) }
            case .failed:
                Palette.bg90.overlay { Text("Failed to load image").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.destructive) }
            case .loaded(let file):
                loaded(file)
            }
        }
        .task(id: location) { await load.load(location.path, scope: scope, editor: services.editor, failure: "Failed to load image") }
    }

    @ViewBuilder private func loaded(_ file: BinaryFile) -> some View {
        if let image = UIImage(data: file.data) {
            let size = image.size
            let dimensions = "\(Int(size.width)) × \(Int(size.height))"
            MediaHeader(meta: dimensions, zoom: zoom, limits: .image,
                        onZoomOut: { zoom = ViewerZoom.image.zoomOut(zoom) },
                        onZoomIn: { zoom = ViewerZoom.image.zoomIn(zoom) },
                        onRotate: { rotation = ViewerZoom.rotated(rotation) })
            GeometryReader { proxy in
                let fit = ViewerZoom.fitScale(width: size.width, height: size.height,
                                              into: CGSizeValue(width: proxy.size.width - 64, height: proxy.size.height - 64))
                let scale = ViewerZoom.image.clamp(zoom * pinch)
                let width = size.width * fit * scale, height = size.height * fit * scale
                let turned = rotation % 180 != 0
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .interpolation(size.width * scale * fit > size.width ? .none : .high)
                        .frame(width: width, height: height)
                        .rotationEffect(.degrees(Double(rotation)))
                        .frame(width: turned ? height : width, height: turned ? width : height)
                        .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
                        .accessibilityLabel(FilePath.name(location.path))
                }
                .gesture(MagnifyGesture()
                    .onChanged { pinch = $0.magnification }
                    .onEnded { value in
                        zoom = ViewerZoom.image.clamp(zoom * value.magnification)
                        pinch = 1
                    })
            }
            .background(Palette.bg90)
            MediaFooter(path: location.path, detail: "\(dimensions) px")
        } else if file.contentType.contains("svg") || file.data.first == UInt8(ascii: "<") {
            VectorImageView(svg: String(decoding: file.data, as: UTF8.self))
                .background(Palette.bg90)
            MediaFooter(path: location.path, detail: nil)
        } else {
            Palette.bg90.overlay { Text("Failed to load image").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.destructive) }
        }
    }
}

// MARK: PDF

/// pdf-viewer.tsx: the pages on a grey ground, zoom 50%–300% in 25% steps, rotate.
struct PDFFileScreen: View {
    let location: FileLocation
    let scope: CheckoutScope
    @Environment(\.panelServices) private var services
    @State private var load = MediaLoad()
    @State private var zoom = 1.0
    @State private var rotation = 0

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path)
            switch load.state {
            case .loading:
                Palette.bg90.overlay { Text("Loading PDF...").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300) }
            case .failed(let message):
                Palette.bg90.overlay { Text(message).textStyle(TextStyle(size: 14)).foregroundStyle(Palette.destructive) }
            case .loaded(let file):
                if let pdf = PDFDocument(data: file.data) {
                    let pages = "\(pdf.pageCount) pages"
                    MediaHeader(meta: pages, zoom: zoom, limits: .pdf,
                                onZoomOut: { zoom = ViewerZoom.pdf.zoomOut(zoom) },
                                onZoomIn: { zoom = ViewerZoom.pdf.zoomIn(zoom) },
                                onRotate: { rotation = ViewerZoom.rotated(rotation) })
                    PDFPagesView(document: pdf, zoom: zoom, rotation: rotation)
                        .background(Palette.bg90)
                        .accessibilityLabel(FilePath.name(location.path))
                    MediaFooter(path: location.path, detail: pages)
                } else {
                    Palette.bg90.overlay { Text("Failed to load PDF").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.destructive) }
                }
            }
        }
        .task(id: location) { await load.load(location.path, scope: scope, editor: services.editor, failure: "Failed to load PDF") }
    }
}

/// PDFKit's view: continuous pages inset on the grey ground; 100% fits the
/// page to the screen less the margins, and zoom scales from there.
private struct PDFPagesView: UIViewRepresentable {
    let document: PDFDocument
    let zoom: Double
    let rotation: Int

    func makeUIView(context: Context) -> FittedPDFView {
        let view = FittedPDFView()
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = UIColor(Palette.bg90)
        view.pageShadowsEnabled = false
        // `.pdf-page`: white pages inset on the grey ground.
        view.displaysPageBreaks = true
        view.pageBreakMargins = UIEdgeInsets(top: 20, left: FittedPDFView.sideMargin, bottom: 24, right: FittedPDFView.sideMargin)
        view.document = document
        return view
    }

    func updateUIView(_ view: FittedPDFView, context: Context) {
        if view.document !== document { view.document = document }
        for index in 0..<document.pageCount {
            if let page = document.page(at: index), page.rotation != rotation { page.rotation = rotation }
        }
        view.zoom = zoom
        view.refit()
    }
}

final class FittedPDFView: PDFView {
    static let sideMargin: CGFloat = 44
    var zoom = 1.0
    private var fittedWidth: CGFloat = 0
    /// The first fit opens at the very top, the first page's top margin showing
    /// like its sides (pdf-viewer.tsx `p-8`): PDFKit keeps the offset it had at
    /// the old scale, which leaves the page flush under the toolbar.
    private var openedAtTop = false

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != fittedWidth { refit() }
    }

    /// Applies the zoom against the width-fitted scale of the (rotated) first page.
    func refit() {
        guard bounds.width > 0, let page = document?.page(at: 0) else { return }
        fittedWidth = bounds.width
        let pageWidth = page.bounds(for: displayBox).size.applying(CGAffineTransform(rotationAngle: CGFloat(page.rotation) * .pi / 180)).width
        guard abs(pageWidth) > 0 else { return }
        let fit = (bounds.width - 2 * Self.sideMargin) / abs(pageWidth)
        autoScales = false
        minScaleFactor = fit * ViewerZoom.pdf.minimum
        maxScaleFactor = fit * ViewerZoom.pdf.maximum
        scaleFactor = fit * zoom
        if !openedAtTop, let scroll = Self.scrollView(in: self) {
            openedAtTop = true
            scroll.layoutIfNeeded()
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: -scroll.adjustedContentInset.top), animated: false)
        }
    }

    private static func scrollView(in view: UIView) -> UIScrollView? {
        for subview in view.subviews {
            if let scroll = subview as? UIScrollView { return scroll }
            if let nested = scrollView(in: subview) { return nested }
        }
        return nil
    }
}

// MARK: Video and audio

/// video-viewer.tsx and audio-viewer.tsx: the system player over the file's bytes.
struct MediaFileScreen: View {
    let location: FileLocation
    let scope: CheckoutScope
    @Environment(\.panelServices) private var services
    @State private var load = MediaLoad()
    @State private var player: AVPlayer?

    private var isVideo: Bool { FileViewerKind(path: location.path) == .video }

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path)
            switch load.state {
            case .loading:
                // The desktop's audio viewer shows no loading line.
                Palette.bg90.overlay { if isVideo { Text("Loading video...").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.t300) } }
            case .failed:
                Palette.bg90.overlay { Text(isVideo ? "Failed to load video" : "Failed to load audio").textStyle(TextStyle(size: 14)).foregroundStyle(Palette.destructive) }
            case .loaded:
                VideoPlayer(player: player).background(Palette.bg90).accessibilityLabel(FilePath.name(location.path))
                MediaFooter(path: location.path, detail: nil)
            }
        }
        .task(id: location) {
            await load.load(location.path, scope: scope, editor: services.editor, failure: isVideo ? "Failed to load video" : "Failed to load audio")
            guard case .loaded(let file) = load.state else { return }
            // AVPlayer reads from a URL: the bytes go to a temporary file named like the original.
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent(FilePath.name(location.path))
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try file.data.write(to: url)
                player = AVPlayer(url: url)
            } catch {
                load.state = .failed(isVideo ? "Failed to load video" : "Failed to load audio")
            }
        }
        .onDisappear {
            player?.pause()
            if let url = (player?.currentItem?.asset as? AVURLAsset)?.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        }
    }
}
