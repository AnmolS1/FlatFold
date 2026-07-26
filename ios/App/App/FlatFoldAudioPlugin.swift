import Foundation
import Capacitor
import AVFoundation

// Native voice-note recording, for the Mac only.
//
// WHY this exists at all: on "Designed for iPad" running on a Mac, the WebView
// does not expose `navigator.mediaDevices` — measured, not assumed. The web
// layer reported `secure: yes` with `mediaDevices: false`, so it is neither a
// permission problem nor a secure-context problem, and nothing in JS can reach
// the microphone. The Mac's microphone hardware is fine; only the WebView's
// route to it is missing. So we record natively and hand the bytes to the web
// layer, which then follows exactly the same send path as every other platform.
//
// The output format is deliberately pinned to AAC-in-MP4 (`mp4a.40.2`). That is
// the same format `src/lib/audioFormat.ts` makes the recorder pick in the
// browser, and it is load-bearing: a voice note recorded as Opus is silently
// unplayable on every Apple device, on the RECEIVING end. Nothing downstream has
// to special-case a Mac-recorded note, because the bytes are the same shape.
@objc(FlatFoldAudioPlugin)
public class FlatFoldAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FlatFoldAudioPlugin"
    public let jsName = "FlatFoldAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
    ]

    /// The MIME type the recorded bytes actually are. Kept in one place so it
    /// cannot drift from `APPLE_PLAYABLE[0]` in src/lib/audioFormat.ts.
    private static let mimeType = "audio/mp4;codecs=mp4a.40.2"

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?

    /// Only offered where the WebView route is missing. Everywhere else
    /// `getUserMedia` works and is the better path — it needs no native surface
    /// and no extra permission plumbing.
    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve([
            "supported": ProcessInfo.processInfo.isiOSAppOnMac,
            "mimeType": Self.mimeType,
        ])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        requestRecordPermission { granted in
            call.resolve(["granted": granted])
        }
    }

    /// `AVAudioApplication` is the iOS 17+ home for this; the AVAudioSession
    /// spelling is deprecated there but is the only one available below it.
    private func requestRecordPermission(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        }
    }

    @objc func startRecording(_ call: CAPPluginCall) {
        // Permission first, every time. The prompt only appears once, but the
        // answer can change in System Settings between launches, so this must not
        // be cached.
        requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("microphone permission denied", "PERMISSION_DENIED")
                return
            }
            do {
                try self.beginRecording()
                call.resolve(["mimeType": Self.mimeType])
            } catch {
                self.cleanUp()
                call.reject("could not start recording: \(error.localizedDescription)", "START_FAILED")
            }
        }
    }

    private func beginRecording() throws {
        // Stop anything already running rather than leaking a recorder — the UI
        // should not allow it, but a double-tap must not strand a file handle.
        cleanUp()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("flatfold-voice-\(UUID().uuidString).m4a")

        // AAC in an MP4 container. 44.1kHz mono is plenty for speech and keeps
        // the ciphertext small — these are end-to-end encrypted and uploaded.
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]

        let rec = try AVAudioRecorder(url: url, settings: settings)
        guard rec.record() else { throw NSError(domain: "FlatFoldAudio", code: 1,
                                                userInfo: [NSLocalizedDescriptionKey: "recorder refused to start"]) }
        recorder = rec
        fileURL = url
    }

    @objc func stopRecording(_ call: CAPPluginCall) {
        guard let rec = recorder, let url = fileURL else {
            call.reject("not recording", "NOT_RECORDING")
            return
        }
        let durationMs = Int(rec.currentTime * 1000)
        rec.stop()
        recorder = nil

        defer { cleanUp() }
        do {
            let data = try Data(contentsOf: url)
            guard !data.isEmpty else {
                call.reject("recording was empty", "EMPTY")
                return
            }
            // Base64 across the bridge: Capacitor's JSON channel cannot carry raw
            // bytes, and the web layer decodes straight into the same Uint8Array
            // the browser path produces.
            call.resolve([
                "base64": data.base64EncodedString(),
                "mimeType": Self.mimeType,
                "durationMs": durationMs,
            ])
        } catch {
            call.reject("could not read the recording: \(error.localizedDescription)", "READ_FAILED")
        }
    }

    /// Always remove the temp file. It holds decrypted audio of a message the
    /// user is about to send end-to-end encrypted; leaving it in tmp/ would be a
    /// plaintext copy on disk outside the keystore's protection.
    private func cleanUp() {
        recorder?.stop()
        recorder = nil
        if let url = fileURL {
            try? FileManager.default.removeItem(at: url)
            fileURL = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
