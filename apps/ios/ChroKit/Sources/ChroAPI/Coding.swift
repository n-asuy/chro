import Foundation

/// JSON settings shared by every call: snake_case keys and RFC 3339 dates with
/// or without fractional seconds, as serde/chrono writes them.
public enum APIDecoder {
    public static func make() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = RFC3339.parse(text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not an RFC 3339 date: \(text)")
        }
        return decoder
    }
}

public enum APIEncoder {
    public static func make() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

/// RFC 3339 timestamps as the server (serde/chrono) and the desktop
/// (`Date.toISOString()`) write them. The styles are built once: parsing runs
/// for every row of every stream document.
public enum RFC3339 {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    /// With or without fractional seconds.
    public static func parse(_ text: String) -> Date? {
        (try? fractional.parse(text)) ?? (try? whole.parse(text))
    }

    /// `new Date().toISOString()`: UTC with milliseconds.
    public static func string(_ date: Date) -> String { fractional.format(date) }
}

/// A string-backed enum that keeps values it does not know instead of failing,
/// so a newer server cannot break decoding of a whole response.
public protocol OpenEnum: Codable, Hashable, Sendable {
    init(rawValue: String)
    var rawValue: String { get }
}

extension OpenEnum {
    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
