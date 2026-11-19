import ChroDomain
import Testing

@Suite struct SyntaxTokensTests {
    @Test func classifiesKeywordsCallsTypesAndStrings() {
        let tokens = SyntaxTokens.tokenize("export function removeStock(items: Item[]): string { return \"x\" }", path: "a.ts")
        func kind(of text: String) -> SyntaxTokens.Kind? { tokens.first { $0.text == text }?.kind }
        #expect(kind(of: "export") == .keyword)
        #expect(kind(of: "function") == .keyword)
        #expect(kind(of: "removeStock") == .function)
        #expect(kind(of: "Item") == .type)
        #expect(kind(of: "string") == .type)
        #expect(kind(of: "\"x\"") == .string)
        #expect(tokens.map(\.text).joined() == "export function removeStock(items: Item[]): string { return \"x\" }")
    }

    @Test func templateStringsAndComments() {
        let tokens = SyntaxTokens.tokenize("throw new RangeError(`bad ${a}`) // note", path: "a.ts")
        #expect(tokens.contains { $0.kind == .string && $0.text == "`bad ${a}`" })
        #expect(tokens.contains { $0.kind == .comment && $0.text == "// note" })
        #expect(tokens.first { $0.text == "RangeError" }?.kind == .type)
    }

    @Test func plainTextIsOneToken() {
        #expect(SyntaxTokens.tokenize("export function", path: "notes.txt") == [.init(kind: .plain, text: "export function")])
    }
}
