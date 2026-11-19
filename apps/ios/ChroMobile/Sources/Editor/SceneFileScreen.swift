import ChroDomain
import ChroServices
import SwiftUI

/// A drawing file as a still picture: the desktop edits it in a drawing
/// canvas; the phone draws its shapes read-only, fitted to the width, and
/// lets a pinch zoom in (`.exc`).
struct SceneFileScreen: View {
    let location: FileLocation
    let scope: CheckoutScope
    @Environment(\.panelServices) private var services
    @Environment(\.reportRouteFailure) private var reportFailure
    @State private var state: LoadState = .loading
    @State private var zoom = 1.0
    @State private var pinch = 1.0

    enum LoadState {
        case loading
        case loaded(DrawingScene)
        case failed(String)
    }

    var body: some View {
        VStack(spacing: 0) {
            FileNavBar(path: location.path)
            switch state {
            case .loading: EditorStatus(text: "Loading file…")
            case .failed(let message): EditorStatus(text: message)
            case .loaded(let scene): canvas(scene)
            }
        }
        .task(id: location) { await load() }
    }

    private func load() async {
        do {
            let file = try await services.editor.read(location.path, in: scope)
            state = .loaded(try DrawingScene.parse(Data(file.content.utf8)))
        } catch let error as EditorError {
            state = .failed(error.message)
        } catch is DrawingScene.ParseError {
            state = .failed("Failed to load file")
        } catch {
            reportFailure(RouteFailure(error))
        }
    }

    private func canvas(_ scene: DrawingScene) -> some View {
        GeometryReader { proxy in
            let bounds = scene.bounds(padding: 16)
            let fit = min(1, proxy.size.width / max(bounds.width, 1))
            let scale = fit * min(8, max(1, zoom * pinch))
            ScrollView([.horizontal, .vertical]) {
                Canvas { context, _ in
                    context.translateBy(x: -bounds.minX * scale, y: -bounds.minY * scale)
                    context.scaleBy(x: scale, y: scale)
                    for element in scene.elements { draw(element, in: &context) }
                }
                .frame(width: bounds.width * scale, height: bounds.height * scale)
                .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
                .accessibilityLabel(FilePath.name(location.path))
            }
            .gesture(MagnifyGesture()
                .onChanged { pinch = $0.magnification }
                .onEnded { value in
                    zoom = min(8, max(1, zoom * value.magnification))
                    pinch = 1
                })
        }
        .background(Color(hexString: scene.background) ?? .white)
    }

    /// The scene's three faces: hand-drawn, normal, code.
    private static func font(_ family: Int, size: CGFloat) -> Font {
        switch family {
        case 1: return .custom("Noteworthy-Light", size: size)
        case 3: return Font(EditorFont.mono(size))
        default: return .system(size: size)
        }
    }

    private func draw(_ element: DrawingScene.Element, in context: inout GraphicsContext) {
        let stroke = Color(hexString: element.strokeColor) ?? Palette.fg
        let fill = element.fillColor.flatMap { Color(hexString: $0) }
        let frame = CGRect(x: element.x, y: element.y, width: element.width, height: element.height)
        var layer = context
        layer.opacity = element.opacity
        if element.angle != 0 {
            layer.translateBy(x: frame.midX, y: frame.midY)
            layer.rotate(by: .radians(element.angle))
            layer.translateBy(x: -frame.midX, y: -frame.midY)
        }
        let style = StrokeStyle(lineWidth: element.strokeWidth, lineCap: .round, lineJoin: .round)
        switch element.shape {
        case .rectangle(let rounded):
            let path = Path(roundedRect: frame, cornerRadius: rounded ? min(32, min(frame.width, frame.height) * 0.25) : 0)
            if let fill { layer.fill(path, with: .color(fill)) }
            layer.stroke(path, with: .color(stroke), style: style)
        case .ellipse:
            let path = Path(ellipseIn: frame)
            if let fill { layer.fill(path, with: .color(fill)) }
            layer.stroke(path, with: .color(stroke), style: style)
        case .diamond:
            var path = Path()
            path.move(to: CGPoint(x: frame.midX, y: frame.minY))
            path.addLine(to: CGPoint(x: frame.maxX, y: frame.midY))
            path.addLine(to: CGPoint(x: frame.midX, y: frame.maxY))
            path.addLine(to: CGPoint(x: frame.minX, y: frame.midY))
            path.closeSubpath()
            if let fill { layer.fill(path, with: .color(fill)) }
            layer.stroke(path, with: .color(stroke), style: style)
        case .polyline(let points, let arrow):
            let absolute = points.map { CGPoint(x: element.x + $0.x, y: element.y + $0.y) }
            guard let first = absolute.first else { return }
            var path = Path()
            path.move(to: first)
            for point in absolute.dropFirst() { path.addLine(to: point) }
            layer.stroke(path, with: .color(stroke), style: style)
            if arrow, absolute.count >= 2 {
                let tip = absolute[absolute.count - 1], from = absolute[absolute.count - 2]
                let angle = atan2(tip.y - from.y, tip.x - from.x), length = max(10, element.strokeWidth * 6)
                var head = Path()
                head.move(to: CGPoint(x: tip.x - length * cos(angle - .pi / 7), y: tip.y - length * sin(angle - .pi / 7)))
                head.addLine(to: tip)
                head.addLine(to: CGPoint(x: tip.x - length * cos(angle + .pi / 7), y: tip.y - length * sin(angle + .pi / 7)))
                layer.stroke(head, with: .color(stroke), style: style)
            }
        case .freehand(let points):
            var path = Path()
            for (index, point) in points.enumerated() {
                let absolute = CGPoint(x: element.x + point.x, y: element.y + point.y)
                if index == 0 { path.move(to: absolute) } else { path.addLine(to: absolute) }
            }
            layer.stroke(path, with: .color(stroke), style: style)
        case .text(let text, let fontSize, let family):
            for (index, line) in text.components(separatedBy: "\n").enumerated() {
                layer.draw(Text(line).font(Self.font(family, size: fontSize)).foregroundStyle(stroke),
                           at: CGPoint(x: frame.minX, y: frame.minY + CGFloat(index) * fontSize * 1.25), anchor: .topLeading)
            }
        }
    }
}
