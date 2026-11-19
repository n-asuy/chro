@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// The back camera reading QR codes (AVCaptureMetadataOutput, `.qr` only).
/// Reports each distinct payload once; `isActive` pauses the session.
struct QRScannerView: UIViewRepresentable {
    var isActive: Bool
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.configure(view)
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        context.coordinator.onCode = onCode
        context.coordinator.setRunning(isActive)
    }

    static func dismantleUIView(_ view: PreviewView, coordinator: Coordinator) {
        coordinator.setRunning(false)
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    /// Owns the capture session; touched only on its serial queue.
    final class CaptureSession: @unchecked Sendable {
        let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "chro.qr-scanner")

        func configure(delegate: AVCaptureMetadataOutputObjectsDelegate) {
            queue.async { [session] in
                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                      let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
                session.beginConfiguration()
                session.addInput(input)
                let output = AVCaptureMetadataOutput()
                if session.canAddOutput(output) {
                    session.addOutput(output)
                    output.setMetadataObjectsDelegate(delegate, queue: .main)
                    output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
                }
                session.commitConfiguration()
                session.startRunning()
            }
        }

        func setRunning(_ running: Bool) {
            queue.async { [session] in
                if running, !session.isRunning, !session.inputs.isEmpty { session.startRunning() }
                if !running, session.isRunning { session.stopRunning() }
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void
        private let capture = CaptureSession()
        private var lastCode: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func configure(_ view: PreviewView) {
            view.previewLayer.session = capture.session
            capture.configure(delegate: self)
        }

        func setRunning(_ running: Bool) {
            capture.setRunning(running)
            if running { lastCode = nil }
        }

        /// Delivered on the main queue (see `setMetadataObjectsDelegate`).
        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
            MainActor.assumeIsolated {
                guard let code, code != lastCode else { return }
                lastCode = code
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onCode(code)
            }
        }
    }
}

/// Camera permission as the pairing screen needs it, re-read when the app returns.
@MainActor @Observable
final class CameraPermission {
    enum State { case undetermined, granted, denied, unavailable }

    private(set) var state: State = .undetermined

    init() { refresh() }

    func refresh() {
        guard AVCaptureDevice.default(for: .video) != nil else { state = .unavailable; return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: state = .granted
        case .notDetermined: state = .undetermined
        default: state = .denied
        }
    }

    func request() async {
        _ = await AVCaptureDevice.requestAccess(for: .video)
        refresh()
    }
}
