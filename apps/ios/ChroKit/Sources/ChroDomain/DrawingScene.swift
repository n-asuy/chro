import Foundation

/// A drawing file (`.excalidraw`, the scene JSON) read for the phone's still
/// picture. The desktop edits it in a drawing canvas; the phone shows its
/// shapes read-only. Elements the phone does not draw (embedded images,
/// frames) are counted in `skippedCount`.
public struct DrawingScene: Equatable, Sendable {
    public enum ParseError: Error, Equatable { case notAScene }

    public enum Shape: Equatable, Sendable {
        case rectangle(rounded: Bool)
        case ellipse
        case diamond
        /// Points relative to the element's origin; arrows draw a head at the end.
        case polyline([Point], arrow: Bool)
        case freehand([Point])
        /// `fontFamily`: 1 hand-drawn, 2 normal, 3 code (the scene format's numbering).
        case text(String, fontSize: Double, fontFamily: Int)
    }

    public struct Point: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public struct Element: Equatable, Sendable, Identifiable {
        public var id: String
        public var shape: Shape
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double
        public var angle: Double
        public var strokeColor: String
        /// nil when transparent.
        public var fillColor: String?
        public var strokeWidth: Double
        public var opacity: Double
    }

    public struct Bounds: Equatable, Sendable {
        public var minX: Double
        public var minY: Double
        public var maxX: Double
        public var maxY: Double
        public var width: Double { maxX - minX }
        public var height: Double { maxY - minY }
    }

    public var elements: [Element]
    public var background: String
    public var skippedCount: Int

    public static func parse(_ data: Data) throws -> DrawingScene {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = root["elements"] as? [[String: Any]] else { throw ParseError.notAScene }
        var elements: [Element] = []
        var skipped = 0
        for item in raw where (item["isDeleted"] as? Bool) != true {
            guard let element = element(item) else { skipped += 1; continue }
            elements.append(element)
        }
        let background = ((root["appState"] as? [String: Any])?["viewBackgroundColor"] as? String) ?? "#ffffff"
        return DrawingScene(elements: elements, background: background, skippedCount: skipped)
    }

    /// The box around every element (lines by their points), grown by `padding`.
    public func bounds(padding: Double) -> Bounds {
        guard !elements.isEmpty else { return Bounds(minX: 0, minY: 0, maxX: 2 * padding, maxY: 2 * padding) }
        var box = Bounds(minX: .infinity, minY: .infinity, maxX: -.infinity, maxY: -.infinity)
        for element in elements {
            let points: [Point]
            switch element.shape {
            case .polyline(let line, _), .freehand(let line):
                points = line.map { Point(x: element.x + $0.x, y: element.y + $0.y) }
            default:
                points = [Point(x: element.x, y: element.y), Point(x: element.x + element.width, y: element.y + element.height)]
            }
            for point in points {
                box.minX = min(box.minX, point.x)
                box.minY = min(box.minY, point.y)
                box.maxX = max(box.maxX, point.x)
                box.maxY = max(box.maxY, point.y)
            }
        }
        return Bounds(minX: box.minX - padding, minY: box.minY - padding, maxX: box.maxX + padding, maxY: box.maxY + padding)
    }

    private static func element(_ item: [String: Any]) -> Element? {
        func number(_ key: String, _ fallback: Double = 0) -> Double { (item[key] as? NSNumber)?.doubleValue ?? fallback }
        let points = ((item["points"] as? [[Any]]) ?? []).compactMap { pair -> Point? in
            guard pair.count >= 2, let x = (pair[0] as? NSNumber)?.doubleValue, let y = (pair[1] as? NSNumber)?.doubleValue else { return nil }
            return Point(x: x, y: y)
        }
        let shape: Shape
        switch item["type"] as? String {
        case "rectangle": shape = .rectangle(rounded: item["roundness"] is [String: Any])
        case "ellipse": shape = .ellipse
        case "diamond": shape = .diamond
        case "line": shape = .polyline(points, arrow: false)
        case "arrow": shape = .polyline(points, arrow: true)
        case "freedraw": shape = .freehand(points)
        case "text": shape = .text(item["text"] as? String ?? "", fontSize: number("fontSize", 20), fontFamily: Int(number("fontFamily", 1)))
        default: return nil
        }
        let fill = item["backgroundColor"] as? String
        return Element(
            id: item["id"] as? String ?? UUID().uuidString,
            shape: shape, x: number("x"), y: number("y"), width: number("width"), height: number("height"), angle: number("angle"),
            strokeColor: item["strokeColor"] as? String ?? "#1e1e1e",
            fillColor: fill == nil || fill == "transparent" ? nil : fill,
            strokeWidth: number("strokeWidth", 1), opacity: number("opacity", 100) / 100
        )
    }
}
