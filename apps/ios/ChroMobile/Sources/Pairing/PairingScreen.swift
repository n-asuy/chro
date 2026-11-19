import ChroServices
import SwiftUI

/// Pairing a desktop: scan the QR from Settings → Mobile, or paste its code.
/// Shows the pairing log while connecting and the failure with a retry.
@MainActor @Observable
final class PairingModel {
    enum Phase: Equatable {
        case scanning
        case pasting
        case connecting(source: PairingSource)
        case failed(PairingError, source: PairingSource)
    }

    let service: any PairingService
    var phase: Phase = .scanning
    var pastedCode = ""
    private(set) var log: [String] = []
    @ObservationIgnored private var attempt: Task<Void, Never>?
    @ObservationIgnored private var lastCode: (String, PairingSource)?

    init(service: any PairingService, startPasting: Bool = false) {
        self.service = service
        phase = startPasting ? .pasting : .scanning
    }

    func pair(_ code: String, source: PairingSource, onPaired: @escaping (PairedHost) -> Void) {
        attempt?.cancel()
        lastCode = (code, source)
        log = []
        phase = .connecting(source: source)
        attempt = Task {
            do {
                for try await progress in service.pair(code: code, source: source) {
                    switch progress {
                    case .step(let line): log.append(line)
                    case .paired(let host):
                        try? await Task.sleep(for: .milliseconds(450))
                        onPaired(host)
                    }
                }
            } catch is CancellationError {
                return
            } catch let error as PairingError {
                phase = .failed(error, source: source)
            } catch {
                phase = .failed(.failed(error.localizedDescription), source: source)
            }
        }
    }

    func retry(onPaired: @escaping (PairedHost) -> Void) {
        guard let (code, source) = lastCode else { phase = .scanning; return }
        if source == .camera { phase = .scanning } else { pair(code, source: source, onPaired: onPaired) }
    }

    func cancel() {
        attempt?.cancel()
        attempt = nil
    }
}

struct PairingScreen: View {
    @State var model: PairingModel
    var onBack: (() -> Void)?
    let onPaired: (PairedHost) -> Void
    @State private var camera = CameraPermission()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @FocusState private var pasteFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            NavBar(title: "", onBack: onBack.map { back in { model.cancel(); back() } })
            content
        }
        .background(Palette.bg.ignoresSafeArea())
        .onChange(of: scenePhase) { _, phase in if phase == .active { camera.refresh() } }
        .onDisappear { model.cancel() }
    }

    @ViewBuilder private var content: some View {
        // One call site for the code field, so editing after a failure keeps the same field and its focus.
        if showsCodeField {
            pasting(error: pasteFailure)
        } else {
            switch model.phase {
            case .scanning: scanning
            case .connecting: connecting
            case .failed(let error, _): failed(error)
            case .pasting: EmptyView()
            }
        }
    }

    /// Without a camera there is nothing to scan, so the code field is the screen;
    /// a pasted code that failed stays in its field with the error under it.
    private var showsCodeField: Bool {
        switch model.phase {
        case .pasting, .failed(_, .paste): return true
        case .scanning: return camera.state == .unavailable
        default: return false
        }
    }

    private var pasteFailure: PairingError? {
        if case .failed(let error, .paste) = model.phase { return error }
        return nil
    }

    // MARK: Scan

    @ViewBuilder private var scanning: some View {
        switch camera.state {
        case .granted:
            VStack(alignment: .leading, spacing: 0) {
                header("Pair with desktop", "Scan the QR code from Chro on your desktop.")
                VStack(alignment: .leading, spacing: 10) {
                    instruction(1, "Open Chro on your computer")
                    instruction(2, "Go to Settings → Mobile")
                    instruction(3, "Scan the QR code")
                }
                .padding(.horizontal, 20).padding(.top, 18)
                QRScannerView(isActive: model.phase == .scanning) { code in model.pair(code, source: .camera, onPaired: onPaired) }
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(Reticle())
                    .aspectRatio(1, contentMode: .fit)
                    .padding(.horizontal, 20).padding(.top, 20)
                    .accessibilityLabel("Camera viewfinder")
                Spacer(minLength: 0)
                footer {
                    BigButton(title: "Or paste pairing code", kind: .outline) { model.phase = .pasting }
                }
            }
        case .undetermined, .denied, .unavailable:
            let denied = camera.state == .denied
            VStack(alignment: .leading, spacing: 0) {
                header(denied ? "Camera Access Disabled" : "Pair with desktop",
                       denied ? "Enable camera access in Settings, or paste the pairing code instead."
                           : "Scan the QR code from Chro on your desktop, or paste the pairing code instead.")
                Spacer(minLength: 0)
                footer {
                    if denied {
                        BigButton(title: "Open Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                    } else {
                        BigButton(title: "Continue") { Task { await camera.request() } }
                    }
                    BigButton(title: "Paste code instead", kind: .outline) { model.phase = .pasting }
                }
            }
        }
    }

    // MARK: Paste

    private func pasting(error: PairingError?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header("Paste pairing code", camera.state == .unavailable
                   ? "This device has no camera. Paste the pairing code shown under the QR on your computer."
                   : "Copy the code shown under the QR on your computer.")
            HStack(spacing: 6) {
                TextField("", text: $model.pastedCode, prompt: Text("chro://pair?code=... or paste the code").foregroundStyle(Palette.t300), axis: .vertical)
                    .textStyle(TextStyle(size: 15))
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($pasteFocused)
                    .accessibilityLabel("Pairing code")
                PasteButton(payloadType: String.self) { strings in
                    if let first = strings.first { model.pastedCode = first }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.roundedRectangle(radius: 6))
                .tint(Palette.primary)
            }
            .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 6)
            .frame(minHeight: 48)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(error != nil ? Palette.destructive.opacity(0.6) : pasteFocused ? Palette.primary.opacity(0.6) : Palette.border))
            .padding(.horizontal, 20).padding(.top, 18)
            if let error {
                Text(error.message)
                    .textStyle(TextStyle(size: 13, lineHeight: 1.45))
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20).padding(.top, 8)
                if !model.log.isEmpty { pairingLog }
            }
            Spacer(minLength: 0)
            footer {
                BigButton(title: "Pair", isEnabled: !model.pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    pasteFocused = false
                    model.pair(model.pastedCode, source: .paste, onPaired: onPaired)
                }
                if camera.state != .unavailable {
                    BigButton(title: "Scan QR code instead", icon: .scanQrCode, kind: .outline) { model.phase = .scanning }
                }
            }
        }
        .onAppear { pasteFocused = true }
        .onChange(of: model.pastedCode) { _, _ in
            if case .failed(_, .paste) = model.phase { model.phase = .pasting }
        }
    }

    // MARK: Connecting and failure

    private var connecting: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Spinner(size: 18).foregroundStyle(Palette.primary)
                Text("Connecting…").textStyle(.stepTitle).foregroundStyle(Palette.fg)
            }
            .padding(.horizontal, 20).padding(.top, 14)
            pairingLog
            Spacer(minLength: 0)
        }
    }

    private func failed(_ error: PairingError) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header("Couldn't pair", nil)
            Text(error.message)
                .textStyle(TextStyle(size: 15, lineHeight: 1.625))
                .foregroundStyle(Palette.destructive)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 4).fill(Palette.destructive.opacity(0.1)))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.destructive.opacity(0.4)))
                .padding(.horizontal, 20).padding(.top, 18)
            if !model.log.isEmpty { pairingLog }
            Spacer(minLength: 0)
            footer {
                BigButton(title: "Try Again") { model.retry(onPaired: onPaired) }
                BigButton(title: "Paste code instead", kind: .outline) { model.phase = .pasting }
            }
        }
    }

    private var pairingLog: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Pairing log").textStyle(.stepCaption).foregroundStyle(Palette.t300)
            ForEach(Array(model.log.enumerated()), id: \.offset) { _, line in
                Text(line).textStyle(.code(12.5)).foregroundStyle(Palette.t200)
            }
        }
        .padding(.horizontal, 20).padding(.top, 20)
    }

    // MARK: Pieces

    private func header(_ title: String, _ message: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).textStyle(.stepTitle).foregroundStyle(Palette.fg).accessibilityAddTraits(.isHeader)
            if let message { Text(message).textStyle(.stepBody).foregroundStyle(Palette.t300).fixedSize(horizontal: false, vertical: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }

    private func instruction(_ number: Int, _ text: String) -> some View {
        HStack(spacing: 12) {
            Text("\(number)").textStyle(TextStyle(size: 12, weight: 600, tabular: true)).foregroundStyle(Palette.t300)
                .frame(width: 22, height: 22).background(Circle().fill(Palette.bg80))
            Text(text).textStyle(TextStyle(size: 15)).foregroundStyle(Palette.fg)
        }
    }

    private func footer<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 8) { content() }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 8)
    }
}

/// The square guide over the viewfinder.
private struct Reticle: View {
    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height) * 0.62
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.white.opacity(0.9), lineWidth: 3)
                .frame(width: side, height: side)
                .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
        }
        .allowsHitTesting(false)
    }
}

/// A `chro://pair` link opened from elsewhere asks before pairing.
struct PairingConfirmSheet: View {
    let code: String
    let onConfirm: () -> Void
    @Environment(SheetPresenter.self) private var sheets

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Pair with this desktop?").textStyle(TextStyle(size: 18, weight: 600)).foregroundStyle(Palette.fg)
            Text("You opened a pairing link from your desktop. Confirm to add it to your hosts.")
                .textStyle(.stepBody).foregroundStyle(Palette.t300).padding(.top, 6)
            VStack(spacing: 8) {
                BigButton(title: "Pair") {
                    sheets.dismiss()
                    onConfirm()
                }
                BigButton(title: "Cancel", kind: .outline) { sheets.dismiss() }
            }
            .padding(.top, 20)
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }
}
