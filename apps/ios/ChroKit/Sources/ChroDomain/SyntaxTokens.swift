import Foundation

/// A small lexer for diff and code highlighting: strings, comments, keywords,
/// called functions and type names, in the four colours the mock uses.
/// Languages outside the C-like family render as plain text.
public enum SyntaxTokens {
    public enum Kind: Equatable, Sendable { case plain, keyword, function, type, string, comment }

    public struct Token: Equatable, Sendable {
        public var kind: Kind
        public var text: String
        public init(kind: Kind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    private static let codeExtensions: Set<String> = [
        "ts", "tsx", "js", "jsx", "mjs", "cjs", "swift", "rs", "go", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "py", "rb", "php", "scala", "dart",
    ]

    private static let keywords: Set<String> = [
        "export", "import", "from", "as", "default", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
        "throw", "try", "catch", "finally", "new", "const", "let", "var", "class", "interface", "type", "enum", "extends", "implements", "public",
        "private", "protected", "static", "async", "await", "yield", "in", "of", "typeof", "instanceof", "void", "delete", "this", "super", "true",
        "false", "null", "undefined", "fn", "pub", "use", "mod", "impl", "struct", "trait", "match", "mut", "self", "Self", "func", "guard", "def",
        "elif", "lambda", "pass", "None", "True", "False", "package", "go", "defer", "where", "protocol", "extension",
    ]

    private static let primitiveTypes: Set<String> = ["string", "number", "boolean", "bigint", "symbol", "any", "unknown", "never", "object"]

    public static func tokenize(_ line: String, path: String) -> [Token] {
        guard codeExtensions.contains(DiffText.pathExtension(path)) else { return [Token(kind: .plain, text: line)] }
        let characters = Array(line)
        var tokens: [Token] = []
        var plain = ""
        func flush() {
            if !plain.isEmpty { tokens.append(Token(kind: .plain, text: plain)); plain = "" }
        }
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if character == "/" && index + 1 < characters.count && characters[index + 1] == "/" {
                flush()
                tokens.append(Token(kind: .comment, text: String(characters[index...])))
                return tokens
            }
            if character == "#" && DiffText.pathExtension(path) == "py" {
                flush()
                tokens.append(Token(kind: .comment, text: String(characters[index...])))
                return tokens
            }
            if character == "\"" || character == "'" || character == "`" {
                flush()
                var end = index + 1
                while end < characters.count && characters[end] != character {
                    end += characters[end] == "\\" ? 2 : 1
                }
                end = min(end, characters.count - 1)
                tokens.append(Token(kind: .string, text: String(characters[index...end])))
                index = end + 1
                continue
            }
            if character.isLetter || character == "_" || character == "$" {
                var end = index
                while end < characters.count && (characters[end].isLetter || characters[end].isNumber || characters[end] == "_" || characters[end] == "$") {
                    end += 1
                }
                let word = String(characters[index..<end])
                let kind: Kind
                if keywords.contains(word) {
                    kind = .keyword
                } else if end < characters.count && characters[end] == "(" {
                    kind = word.first!.isUppercase ? .type : .function
                } else if word.first!.isUppercase || primitiveTypes.contains(word) {
                    kind = .type
                } else {
                    kind = .plain
                }
                if kind == .plain {
                    plain += word
                } else {
                    flush()
                    tokens.append(Token(kind: kind, text: word))
                }
                index = end
                continue
            }
            plain.append(character)
            index += 1
        }
        flush()
        return tokens
    }
}
