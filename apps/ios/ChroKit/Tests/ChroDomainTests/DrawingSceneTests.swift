import ChroDomain
import Foundation
import Testing

@Suite struct DrawingSceneTests {
    static let scene = """
    {"type":"excalidraw","version":2,"elements":[
      {"id":"a","type":"rectangle","x":20,"y":30,"width":110,"height":70,"strokeColor":"#1e1e1e","backgroundColor":"transparent","strokeWidth":2,"roundness":{"type":3}},
      {"id":"t","type":"text","x":40,"y":58,"width":60,"height":18,"text":"Shelf A","fontSize":14,"strokeColor":"#1e1e1e"},
      {"id":"l","type":"line","x":75,"y":100,"width":150,"height":50,"strokeColor":"#1971c2","strokeWidth":2,"points":[[0,0],[0,50],[150,50],[150,0]]},
      {"id":"gone","type":"ellipse","x":900,"y":900,"width":10,"height":10,"isDeleted":true},
      {"id":"img","type":"image","x":0,"y":0,"width":5,"height":5}
    ],"appState":{"viewBackgroundColor":"#ffffff"}}
    """

    @Test func parsesTheDrawableElementsAndSkipsDeletedOnes() throws {
        let scene = try DrawingScene.parse(Data(Self.scene.utf8))
        #expect(scene.elements.map(\.id) == ["a", "t", "l"])
        #expect(scene.background == "#ffffff")
        guard case .rectangle(let rounded) = scene.elements[0].shape else { Issue.record("not a rectangle"); return }
        #expect(rounded)
        guard case .text(let text, let size, let family) = scene.elements[1].shape else { Issue.record("not text"); return }
        #expect(text == "Shelf A" && size == 14 && family == 1)
        guard case .polyline(let points, let arrow) = scene.elements[2].shape else { Issue.record("not a line"); return }
        #expect(points.count == 4 && !arrow)
        #expect(scene.skippedCount == 1)
    }

    @Test func boundsCoverEveryElementWithPadding() throws {
        let scene = try DrawingScene.parse(Data(Self.scene.utf8))
        let bounds = scene.bounds(padding: 10)
        #expect(bounds.minX == 10 && bounds.minY == 20)
        #expect(bounds.maxX == 235 && bounds.maxY == 160)
    }

    @Test func rejectsTextThatIsNotAScene() {
        #expect(throws: DrawingScene.ParseError.self) { try DrawingScene.parse(Data("{}".utf8)) }
        #expect(throws: DrawingScene.ParseError.self) { try DrawingScene.parse(Data("not json".utf8)) }
    }

    @Test func emptyDocumentsAreEmptyScenes() throws {
        let scene = try DrawingScene.parse(Data(#"{"type":"excalidraw","elements":[]}"#.utf8))
        #expect(scene.elements.isEmpty)
    }
}
