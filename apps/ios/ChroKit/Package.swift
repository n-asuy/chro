// swift-tools-version: 6.0
// Platform-independent core of the chro phone app: the operator API types, the
// session-list rules shared with the desktop, the per-area service protocols the
// screens talk to, and the encrypted link to a desktop's chro-server. Kept free of
// UIKit/SwiftUI so `swift test` runs on macOS.
import PackageDescription

let package = Package(
    name: "ChroKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ChroAPI", targets: ["ChroAPI"]),
        .library(name: "ChroDomain", targets: ["ChroDomain"]),
        .library(name: "ChroServices", targets: ["ChroServices"]),
        .library(name: "ChroLink", targets: ["ChroLink"]),
    ],
    dependencies: [
        // libsodium: crypto_box_beforenm (HSalsa20 over X25519) and crypto_secretbox_easy
        // (XSalsa20-Poly1305) have no CryptoKit equivalent.
        .package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.9.1"),
    ],
    targets: [
        .target(name: "ChroAPI"),
        .target(name: "ChroDomain", dependencies: ["ChroAPI"]),
        .target(name: "ChroServices", dependencies: ["ChroDomain", "ChroAPI", "ChroLink"]),
        .target(name: "ChroLink", dependencies: ["ChroAPI", .product(name: "Clibsodium", package: "swift-sodium")]),
        // The desktop's side of the link in process (handshake, device RPC and binary
        // frames as the server answers them), shared by the ChroLink and ChroServices
        // tests. Not a product: the app never links it.
        .target(name: "ChroLinkTesting", dependencies: ["ChroLink"]),
        .testTarget(name: "ChroAPITests", dependencies: ["ChroAPI"]),
        .testTarget(name: "ChroDomainTests", dependencies: ["ChroDomain", "ChroAPI"]),
        .testTarget(name: "ChroLinkTests", dependencies: ["ChroLink", "ChroLinkTesting", "ChroAPI"]),
        .testTarget(name: "ChroServicesTests", dependencies: ["ChroServices", "ChroDomain", "ChroLink", "ChroLinkTesting"]),
    ]
)
