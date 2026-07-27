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
public class FlatFoldAudioPlugin: CAPPlugin, CAPBridgedPlugin, AVAudioRecorderDelegate {
    public let identifier = "FlatFoldAudioPlugin"
    public let jsName = "FlatFoldAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardRecording", returnType: CAPPluginReturnPromise),
    ]

    /// The MIME type the recorded bytes actually are. Kept in one place so it
    /// cannot drift from `APPLE_PLAYABLE[0]` in src/lib/audioFormat.ts.
    private static let mimeType = "audio/mp4;codecs=mp4a.40.2"

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?

    // stopRecording cannot answer synchronously — see the delegate below.
    private var pendingStop: CAPPluginCall?
    private var pendingDurationMs = 0
    private var pendingPeakDb: Float = 0
    private var stopWatchdog: DispatchWorkItem?

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

        // Session configuration is the whole ballgame here, and the first version
        // got it wrong twice.
        //
        // `.mixWithOthers` because this app PLAYS audio too — the WebView owns
        // every voice note that is not being recorded. Without it, activating a
        // playAndRecord session takes exclusive control and the notes already on
        // screen stop being playable.
        //
        // `.defaultToSpeaker` is gone: it routes to the speaker instead of the
        // receiver, which is an iPhone concept. On a Mac it contributed to the
        // device reconfiguration that made the input queue fail to start
        // ("Abandoning I/O cycle because reconfig pending").
        let session = AVAudioSession.sharedInstance()
        // No `.allowBluetooth`: it is deprecated (renamed to allowBluetoothHFP,
        // which needs a newer availability floor than this target has) and it
        // buys nothing here. This path only ever runs on a Mac, where the input
        // device is chosen in System Settings and macOS does the routing —
        // Bluetooth HFP routing is an iOS concept.
        try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers])
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
        rec.delegate = self
        // Metering is how we find out whether the microphone actually delivered
        // anything. `record()` returning true is NOT that guarantee: the first
        // build on Mac returned true while CoreAudio logged "client stopping
        // after failed start", and produced a valid M4A header with no samples —
        // a note that sends fine and plays as nothing.
        rec.isMeteringEnabled = true
        // Let the hardware settle before starting. The failed start came with
        // "did not see 1 I/O cycles; suspension(s) blocking starting", which is
        // the input device still reconfiguring when record() arrived.
        guard rec.prepareToRecord() else {
            throw NSError(domain: "FlatFoldAudio", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "recorder could not be prepared"])
        }
        guard rec.record() else { throw NSError(domain: "FlatFoldAudio", code: 1,
                                                userInfo: [NSLocalizedDescriptionKey: "recorder refused to start"]) }
        recorder = rec
        fileURL = url
    }

    /// Stop, and answer only once the file is actually finalized.
    ///
    /// `AVAudioRecorder.stop()` is ASYNCHRONOUS, and reading the file on the next
    /// line is the bug that made every natively-recorded note unplayable while
    /// looking perfectly healthy from here.
    ///
    /// An MPEG-4 file keeps its index — the `moov` atom — written at finalize
    /// time. Reading immediately yielded all the audio samples (62,699 bytes at a
    /// -17.3 dB peak, which is why size and metering both looked right) but NO
    /// container index. A player then cannot determine the duration and cannot
    /// begin decoding, which presented as `--:--` and a spinner that never
    /// resolved. Notes recorded in the browser were unaffected, so it read as
    /// "new notes are broken" rather than as a container problem.
    ///
    /// So: hold the call, and answer from audioRecorderDidFinishRecording.
    @objc func stopRecording(_ call: CAPPluginCall) {
        guard let rec = recorder, fileURL != nil else {
            call.reject("not recording", "NOT_RECORDING")
            return
        }
        // Capture these BEFORE stopping — afterwards there is nothing to sample.
        pendingDurationMs = Int(rec.currentTime * 1000)
        rec.updateMeters()
        pendingPeakDb = rec.peakPower(forChannel: 0)
        pendingStop = call

        // If the delegate never fires we must not strand the JS promise, which
        // would leave the composer stuck in its recording state with no way out.
        let watchdog = DispatchWorkItem { [weak self] in
            self?.finishStop(successfully: true, note: "watchdog")
        }
        stopWatchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: watchdog)

        rec.stop()
    }

    public func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        finishStop(successfully: flag, note: "delegate")
    }

    private func finishStop(successfully flag: Bool, note: String) {
        // Whichever of delegate/watchdog arrives first wins; the other no-ops.
        guard let call = pendingStop else { return }
        pendingStop = nil
        stopWatchdog?.cancel()
        stopWatchdog = nil
        recorder = nil

        guard let url = fileURL else {
            cleanUp()
            call.reject("recording file is missing", "READ_FAILED")
            return
        }
        // NOTE: no `defer { cleanUp() }` here. cleanUp() deletes the temp file,
        // and the web layer has not read it yet. Every failure path below calls
        // cleanUp() explicitly; the success path leaves the file for
        // discardRecording().
        guard flag else {
            cleanUp()
            call.reject("the recording did not finish cleanly", "FINALIZE_FAILED")
            return
        }

        do {
            let data = try Data(contentsOf: url)
            // DEBUG only, deliberately. Size, duration and loudness are metadata
            // about a private message: anyone with Console access could see when
            // this user records voice notes and for how long. Content-free, but
            // this app already refuses that trade elsewhere — notifications say
            // "New activity", the app-switcher snapshot is covered — so it must
            // not leak here either.
            #if DEBUG
            NSLog("[mic] finalized (%@) %d bytes, %d ms, peak %.1f dB",
                  note, data.count, pendingDurationMs, pendingPeakDb)
            #endif

            // A header-only M4A is the failure this catches. When the input queue
            // fails to start, AVAudioRecorder still writes ftyp+moov and still
            // reports a duration, so `isEmpty` never fires — the note sends and
            // plays as silence, which looks like a codec bug on the far side.
            guard data.count >= 2048 else {
                cleanUp()
                call.reject("the microphone produced no audio — the input device did not start", "NO_INPUT")
                return
            }

            // Parse it before shipping it.
            //
            // Byte count proved to be a poor proxy for "playable": a file can be
            // full-size and still unusable if the container index is missing or
            // malformed, which is exactly what happened — 62,699 bytes at a
            // -17.3 dB peak, and every receiving device showed --:-- and a
            // spinner. Size checks the payload; this checks the artifact.
            //
            // AVAudioFile reads the container the same way a player must, so if
            // it cannot open the file or finds no frames, nothing downstream will
            // play it either. Far better to fail here, where we can say so, than
            // to encrypt and upload something unplayable.
            do {
                let probe = try AVAudioFile(forReading: url)
                guard probe.length > 0 else {
                    cleanUp()
                    call.reject("the recording contains no audio frames", "UNPLAYABLE")
                    return
                }
                #if DEBUG
                NSLog("[mic] probe ok: %lld frames @ %.0f Hz", probe.length, probe.fileFormat.sampleRate)
                #endif
            } catch {
                cleanUp()
                call.reject("the recording is not a playable audio file: \(error.localizedDescription)", "UNPLAYABLE")
                return
            }
            // Hand back a PATH, never the bytes.
            //
            // Capacitor delivers plugin results by evaluating JavaScript with the
            // payload embedded as source. ~104 KB of base64 for a 4-second note
            // wedged the WebContent process outright — the device log went
            // straight from a healthy `probe ok` to
            // `WebProcessProxy::didBecomeUnresponsive`. The recording was never
            // the problem; the transport was.
            //
            // The web layer fetches this through Capacitor's file scheme instead,
            // which streams through WKWebView's URL handler and never becomes JS
            // source. It must call discardRecording() when done — this file is
            // PLAINTEXT audio of a message about to be sent end-to-end encrypted,
            // so it must not outlive the send.
            call.resolve([
                "path": url.path,
                "byteLength": data.count,
                "mimeType": Self.mimeType,
                "durationMs": pendingDurationMs,
            ])
        } catch {
            cleanUp()
            call.reject("could not read the recording: \(error.localizedDescription)", "READ_FAILED")
        }
    }

    /// Delete a finished recording once the web layer has read it.
    ///
    /// Not optional housekeeping: the file is PLAINTEXT audio of a message being
    /// sent end-to-end encrypted, so leaving it in tmp/ would be a decrypted copy
    /// on disk outside the keystore's protection.
    @objc func discardRecording(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        // Only ever delete our own recordings: a path from the web layer is not
        // trusted to name an arbitrary file for deletion.
        let tmp = FileManager.default.temporaryDirectory.path
        let name = (path as NSString).lastPathComponent
        guard path.hasPrefix(tmp), name.hasPrefix("flatfold-voice-"), name.hasSuffix(".m4a") else {
            call.reject("refusing to delete a path outside our own recordings", "BAD_PATH")
            return
        }
        try? FileManager.default.removeItem(atPath: path)
        if fileURL?.path == path { fileURL = nil }
        call.resolve()
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
        // Deliberately NOT deactivating the audio session.
        //
        // The first version called
        // `setActive(false, options: .notifyOthersOnDeactivation)` here, on every
        // record cycle. That is a system-wide "I am finished, everyone else
        // resume" signal, and this app is one of the others — the WebView owns
        // playback of every voice note on screen. Tearing the session down after
        // each recording is why notes stopped playing, including ones recorded
        // seconds earlier.
        //
        // Leaving a mixWithOthers playAndRecord session active costs nothing and
        // keeps WebView playback working.
    }
}
