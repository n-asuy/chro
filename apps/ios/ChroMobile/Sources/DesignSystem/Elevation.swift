import SwiftUI

/// How far a surface stands above the one under it. Light draws small crisp
/// drop shadows; dark draws the desktop's darker drop shadow plus a 1px top
/// edge (`inset 0 1px 0 rgba(255,255,255,.06)`), because a shadow alone sinks
/// into a dark background. No glow, no white highlight on the other edges.
enum Elevation {
    /// A selected segment on its track, a chip on a bar.
    case hairline
    /// A card, a banner, a toast.
    case raised
    /// A toolbar floating over scrolling content.
    case floating

    fileprivate struct Shadow {
        var opacity: Double
        var radius: CGFloat
        var y: CGFloat
        static let none = Shadow(opacity: 0, radius: 0, y: 0)
    }

    /// The near (crisp) and far shadow.
    fileprivate var light: (Shadow, Shadow) {
        switch self {
        case .hairline: return (Shadow(opacity: 0.05, radius: 1, y: 1), .none)
        case .raised: return (Shadow(opacity: 0.10, radius: 1, y: 1), Shadow(opacity: 0.07, radius: 4, y: 3))
        case .floating: return (Shadow(opacity: 0.10, radius: 1, y: 1), Shadow(opacity: 0.08, radius: 8, y: 4))
        }
    }

    /// globals.css dark `--color-shadow-2xs` / `-sm` / `-rg`.
    fileprivate var dark: (Shadow, Shadow) {
        switch self {
        case .hairline: return (Shadow(opacity: 0.35, radius: 1, y: 1), .none)
        case .raised: return (Shadow(opacity: 0.35, radius: 1, y: 1), Shadow(opacity: 0.45, radius: 3, y: 2))
        case .floating: return (Shadow(opacity: 0.40, radius: 2, y: 2), Shadow(opacity: 0.50, radius: 6, y: 5))
        }
    }
}

extension Shape {
    /// The shape filled with `fill` at an elevation, for a `.background`:
    ///
    ///     .background(RoundedRectangle(cornerRadius: 8).surface(Palette.bg, elevation: .raised))
    func surface(_ fill: some ShapeStyle, elevation: Elevation) -> some View {
        ElevatedSurface(shape: self, fill: AnyShapeStyle(fill), elevation: elevation)
    }
}

private struct ElevatedSurface<S: Shape>: View {
    let shape: S
    let fill: AnyShapeStyle
    let elevation: Elevation
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let dark = colorScheme == .dark
        let (near, far) = dark ? elevation.dark : elevation.light
        shape.fill(fill)
            .shadow(color: .black.opacity(near.opacity), radius: near.radius, y: near.y)
            .shadow(color: .black.opacity(far.opacity), radius: far.radius, y: far.y)
            .overlay {
                if dark {
                    TopEdge(shape: shape, width: 1 / displayScale).fill(Color.white.opacity(0.06))
                }
            }
            .allowsHitTesting(false)
    }
}

/// The band between a shape and itself moved down by `width`: the top edge,
/// following the corners.
private struct TopEdge<S: Shape>: Shape {
    let shape: S
    let width: CGFloat

    func path(in rect: CGRect) -> Path {
        let outer = shape.path(in: rect).cgPath
        let inner = shape.path(in: rect.offsetBy(dx: 0, dy: width)).cgPath
        return Path(outer.subtracting(inner))
    }
}
