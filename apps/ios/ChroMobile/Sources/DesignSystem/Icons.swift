import ChroDomain
import SwiftUI

/// The lucide 0.441.0 glyphs the app ships (scripts/generate-icons.mjs).
enum LucideName: String {
    case arrowDownUp = "arrow-down-up", chevronsDownUp = "chevrons-down-up", plus, search, squarePen = "square-pen"
    case chevronRight = "chevron-right", chevronDown = "chevron-down", chevronUp = "chevron-up", chevronLeft = "chevron-left-sw2_2"
    case terminal, messageSquare = "message-square", settings, archive, pin, pinOff = "pin-off", rotateCcw = "rotate-ccw"
    case check, x, loaderCircle = "loader-circle", pause, triangleAlert = "triangle-alert", circle, circleSlash = "circle-slash", arrowDown = "arrow-down"
    case arrowUp = "arrow-up", arrowUpBold = "arrow-up-sw3", arrowLeft = "arrow-left", panelRight = "panel-right"
    case bookOpen = "book-open", images, image, folder, folderOpen = "folder-open", gitBranch = "git-branch", laptop
    case fileText = "file-text", file, cpu, box, brain, house
    case scanQrCode = "scan-qr-code", clipboardPaste = "clipboard-paste", monitor, trash = "trash-2", link
    // right dock, files, diff, editor, gallery, skills, settings and system screens
    case folderTree = "folder-tree", folderTreeThin = "folder-tree-sw1_5", searchThin = "search-sw1_5", gitBranchThin = "git-branch-sw1_5"
    case waypoints, waypointsThin = "waypoints-sw1_5"
    case fileDiff = "file-diff", upload, download, refreshCw = "refresh-cw", refreshCcw = "refresh-ccw", list, listTree = "list-tree"
    case minus, filePlus = "file-plus", fileX = "file-x", filePen = "file-pen", gitMerge = "git-merge", gitCompareArrows = "git-compare-arrows"
    case minimize2 = "minimize-2", maximize2 = "maximize-2", folderPlus = "folder-plus", folderInput = "folder-input", folderRoot = "folder-root", copyPlus = "copy-plus"
    case caseSensitive = "case-sensitive", externalLink = "external-link", arrowRight = "arrow-right", arrowUpDown = "arrow-up-down"
    case circleHelp = "circle-help", pencil, undo2 = "undo-2", redo2 = "redo-2", save, ellipsis
    case zoomIn = "zoom-in", zoomOut = "zoom-out", rotateCw = "rotate-cw", imageOff = "image-off", fileImage = "file-image", code
    case layoutList = "layout-list", penLine = "pen-line", database, table2 = "table-2", filter, slidersHorizontal = "sliders-horizontal"
    case type, hash, calendar, toggleLeft = "toggle-left", braces, gripVertical = "grip-vertical", listPlusBold = "list-plus-sw2_5"
    case bold, italic, strikethrough, highlighter, link2 = "link-2", copy, squareCheckBig = "square-check-big", square
    case circleCheck = "circle-check", circleX = "circle-x", circleAlert = "circle-alert", circleMinus = "circle-minus"
    case megaphone, bug, lightbulb, play, send, sendHorizontal = "send-horizontal", audioLines = "audio-lines", globe, eye, hourglass, hammer
    case checkBold = "check-sw3", listPlus = "list-plus"
}

/// A lucide glyph at the mock's pixel size, tinted by the foreground style.
/// Like an SF Symbol beside text, it grows with the reader's text size, but
/// by at most `maximumScale` so bar and row layouts keep their shape.
struct Icon: View {
    static let maximumScale: CGFloat = 1.4

    let name: LucideName
    var size: CGFloat = 16
    /// False for a glyph drawn inside a fixed-size mark (a checkbox's tick).
    var scales = true
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(_ name: LucideName, size: CGFloat = 16, scales: Bool = true) {
        self.name = name
        self.size = size
        self.scales = scales
    }

    var body: some View {
        let side = scales ? (size * min(Self.maximumScale, Typography.scale(dynamicTypeSize))).rounded() : size
        Image("Lucide/\(name.rawValue)")
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .frame(width: side, height: side)
            .accessibilityHidden(true)
    }
}

/// The spinning loader-circle of a running session.
struct Spinner: View {
    var size: CGFloat = 16
    @State private var spinning = false

    var body: some View {
        Icon(.loaderCircle, size: size)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: spinning)
            .onAppear { spinning = true }
            .accessibilityLabel("In progress...")
    }
}

/// components/agent-logo.tsx: the bundled Claude mark, the Codex mark, the pi glyph.
struct AgentLogo: View {
    let agent: AgentKind
    var size: CGFloat = 16

    /// Decoration beside the agent's name, so hidden from VoiceOver.
    var body: some View {
        logo.accessibilityHidden(true)
    }

    @ViewBuilder private var logo: some View {
        switch agent {
        case .claudeCode:
            Image("Brand/agent-claude").resizable().interpolation(.high).scaledToFit().frame(width: size, height: size)
        case .codex:
            Image("Brand/agent-codex").renderingMode(.template).resizable().scaledToFit().frame(width: size, height: size)
        case .pi:
            Text("π")
                .font(.custom("Georgia", size: size * 19 / 24).weight(.bold))
                .frame(width: size, height: size)
        }
    }
}

/// The glyph left of a session title (session-leading-marker.tsx); nil draws the hollow circle.
struct StatusMarkerGlyph: View {
    let marker: StatusMarker?
    var size: CGFloat = 11

    var body: some View {
        switch marker {
        case .failedUnread?:
            Icon(.triangleAlert, size: size + 3).foregroundStyle(Palette.amber).accessibilityLabel(StatusMarker.failedUnread.label)
        case .completedUnread?:
            Circle().fill(Palette.dot).frame(width: size * 22 / 24, height: size * 22 / 24)
                .frame(width: size, height: size).accessibilityLabel(StatusMarker.completedUnread.label)
        case .cleaned?:
            Icon(.circleSlash, size: size).foregroundStyle(Palette.t400).accessibilityLabel(StatusMarker.cleaned.label)
        case nil:
            Icon(.circle, size: size).foregroundStyle(Palette.t400)
        }
    }
}

/// A running session's trailing glyph: pause while it waits on the user, else the spinner.
struct ActivityGlyph: View {
    let awaitingInput: Bool
    var size: CGFloat = 16

    var body: some View {
        if awaitingInput {
            Icon(.pause, size: size).foregroundStyle(Palette.primary).accessibilityLabel("Waiting for your answer")
        } else {
            Spinner(size: size).foregroundStyle(Palette.primary)
        }
    }
}

/// The chro symbol (public/logo_chro_symbol.png): a one-colour mark drawn in
/// the text colour, so it reads on light and dark surfaces alike.
struct ChroSymbol: View {
    var size: CGFloat = 48

    var body: some View {
        Image("Brand/chro-symbol")
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(Palette.fg)
    }
}
