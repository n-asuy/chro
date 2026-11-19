import AVFoundation
import ChroDomain
import ChroServices
import SwiftUI
import UIKit

/// `.tile`: a square thumbnail of one media file. Videos show their first
/// frame under a play badge.
struct MediaTile: View {
    let item: MediaItem
    let scope: CheckoutScope
    let onOpen: () -> Void
    @Environment(\.panelServices) private var services
    @State private var thumbnail: MediaThumbnail?

    var body: some View {
        Button(action: onOpen) {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay { artwork }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .background(RoundedRectangle(cornerRadius: 8).fill(Palette.bg.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.name)
        .task(id: item) { thumbnail = await MediaThumbnail.load(item, in: scope, from: services.gallery) }
    }

    @ViewBuilder private var artwork: some View {
        switch thumbnail {
        case .image(let image)?:
            Image(uiImage: image).resizable().interpolation(.high).scaledToFill()
        case .vector(let svg)?:
            VectorImageView(svg: svg)
        case .unavailable?, nil:
            Palette.bg80
        }
        if item.kind == .video {
            Circle().fill(Color.black.opacity(0.45)).frame(width: 36, height: 36)
                .overlay { Icon(.play, size: 16).foregroundStyle(.white).offset(x: 1) }
        }
    }
}

/// What a tile draws.
enum MediaThumbnail {
    case image(UIImage)
    /// SVG markup; drawn by a web view because UIImage does not decode SVG.
    case vector(String)
    case unavailable

    static func load(_ item: MediaItem, in scope: CheckoutScope, from service: any GalleryService) async -> MediaThumbnail {
        guard let data = try? await service.mediaData(in: scope, path: item.relativePath) else { return .unavailable }
        switch item.kind {
        case .image:
            if let image = UIImage(data: data) { return .image(image) }
            if let text = String(data: data, encoding: .utf8), text.contains("<svg") { return .vector(text) }
            return .unavailable
        case .video:
            return await firstFrame(of: data, name: item.name).map(MediaThumbnail.image) ?? .unavailable
        }
    }

    /// The video's first frame, read from a temporary copy of its bytes.
    private static func firstFrame(of data: Data, name: String) async -> UIImage? {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + name)
        defer { try? FileManager.default.removeItem(at: file) }
        do {
            try data.write(to: file)
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 480, height: 480)
            let (frame, _) = try await generator.image(at: .zero)
            return UIImage(cgImage: frame)
        } catch {
            return nil
        }
    }
}
