import Foundation
import Capacitor
import AVFoundation
import os
#if targetEnvironment(macCatalyst)
import CoreAudio
#endif

// Native voice-note recording, for the Mac only.
//
// WHY this exists at all: on a Mac, the WebView does not expose
// `navigator.mediaDevices` — measured, not assumed, and on BOTH Mac shells:
//
//   Designed for iPad  `secure: yes`, `mediaDevices: false`
//   Mac Catalyst       `{"mediaDevices":"undefined","secure":true,
//                        "origin":"capacitor://localhost"}`  (2026-07-26)
//
// So it is neither a permission problem nor a secure-context problem, and
// nothing in JS can reach the microphone. The Mac's microphone hardware is fine;
// only the WebView's route to it is missing. So we record natively and hand the
// bytes to the web layer, which then follows exactly the same send path as every
// other platform.
//
// Migrating to Mac Catalyst was expected to make this file deletable. It does
// not: Catalyst is a real Mac app, with the microphone entitlement present in
// the signed binary, and `mediaDevices` is still absent. One untested lead
// remains — the origin above is the custom scheme `capacitor://localhost`, and
// WebKit may gate capture on http/https. That is NOT a free experiment: the
// keystore is origin-bound, so changing the scheme orphans every existing
// install's encrypted local data.
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
        CAPPluginMethod(name: "debugLog", returnType: CAPPluginReturnPromise),
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

    /// `os.Logger`, not NSLog.
    ///
    /// Every measurement below was written with NSLog and NONE of it was
    /// readable on Mac Catalyst — NSLog from this target reaches neither the
    /// unified log nor a console when the app is launched outside Xcode. So the
    /// recorder's own account of what it produced, which is exactly the evidence
    /// this bug needs, was silently discarded on the platform being debugged.
    ///
    /// Interpolations are `privacy: .public` on purpose: Logger redacts by
    /// default, and `<private>` in every field looks identical to a failed probe.
    /// Everything logged here is DEBUG-only and content-free by design — see the
    /// note at the finalize site about why size and duration are still sensitive.
    private static let log = os.Logger(subsystem: "dev.flatfold", category: "mic")

    /// True on BOTH Mac shells, because both lack `navigator.mediaDevices`.
    ///
    /// This used to read `isiOSAppOnMac` alone, and that was a real bug: those
    /// two flags are not synonyms. `isiOSAppOnMac` exists precisely to separate
    /// the two Mac shells and is **false** under Mac Catalyst — measured
    /// 2026-07-26, `isiOSAppOnMac=false isMacCatalystApp=true`. So on Catalyst
    /// this plugin declared itself unsupported, the web layer skipped it
    /// (MessageInput.tsx), fell through to `getUserMedia`, and reported "this
    /// build has no navigator.mediaDevices". The recorder was never defeated
    /// there — it was never asked.
    ///
    /// The `||` is deliberate rather than redundant. `isMacCatalystApp` is
    /// documented to cover the passthrough case too, which would make the second
    /// term unnecessary — but only the Catalyst leg has actually been measured
    /// here, and the passthrough build is the one that ships today. The OR is
    /// correct under either reading; collapsing it rests on documentation alone.
    private static var webViewLacksMediaDevices: Bool {
        let info = ProcessInfo.processInfo
        return info.isMacCatalystApp || info.isiOSAppOnMac
    }

    /// Only offered where the WebView route is missing. Everywhere else
    /// `getUserMedia` works and is the better path — it needs no native surface
    /// and no extra permission plumbing.
    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve([
            "supported": Self.webViewLacksMediaDevices,
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
            Self.log.notice("""
            finalized via=\(note, privacy: .public) \
            bytes=\(data.count, privacy: .public) \
            ms=\(self.pendingDurationMs, privacy: .public) \
            peakDb=\(self.pendingPeakDb, privacy: .public)
            """)
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
                Self.log.notice("""
                probe ok frames=\(probe.length, privacy: .public) \
                rate=\(probe.fileFormat.sampleRate, privacy: .public) \
                ch=\(probe.fileFormat.channelCount, privacy: .public)
                """)
                Self.log.notice("container \(Self.describeContainer(data), privacy: .public)")
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
            // Hand the session back BEFORE answering, not only when a recording
            // fails. Restoration used to live solely in cleanUp(), which the
            // success path deliberately does not call (it would delete the file
            // the web layer is about to read) — so a recording that WORKED left
            // the process in `.playAndRecord` indefinitely, while one that failed
            // tidied up after itself. Exactly backwards, and this file's own
            // comments describe the consequence: "playback is dead afterwards".
            restorePlaybackSession()
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

    /// A route for the web layer to reach os_log.
    ///
    /// `console.log` from WKWebView does NOT appear in the Xcode console, which
    /// is why every measurement in this round has been native and the JavaScript
    /// side went unmeasured for several rebuilds — while the evidence
    /// (`WebProcessProxy::didBecomeUnresponsive`, a WEB main-thread watchdog) was
    /// pointing squarely at JavaScript the whole time.
    ///
    /// DEBUG only: it exists to time things during development, and message text
    /// from the web layer must never reach a shipped build's system log.
    @objc func debugLog(_ call: CAPPluginCall) {
        #if DEBUG
        Self.log.notice("[web] \(call.getString("message") ?? "", privacy: .public)")
        #endif
        call.resolve()
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
        restorePlaybackSession()
        call.resolve()
    }

    /// The MP4 top-level atom layout, plus the `ftyp` brand.
    ///
    /// Deliberately STRUCTURE ONLY — atom names, sizes and the brand string.
    /// No audio bytes are logged and none are written anywhere, because this
    /// file is plaintext audio of a message that is about to be sent end-to-end
    /// encrypted; copying it somewhere readable to inspect it would defeat the
    /// thing it is being inspected for.
    ///
    /// The question it answers: WebKit rejects these files outright (media
    /// element code 4, `decodeAudioData` failing in 0 ms) while `AVAudioFile`
    /// parses them as perfectly good audio, and browser-recorded notes of the
    /// nominally identical type play fine. That is a container difference, and
    /// `moov` position and brand are where such differences live.
    private static func describeContainer(_ data: Data) -> String {
        var parts: [String] = []
        var offset = 0
        // Top level only. A malformed size would otherwise spin forever, so
        // every step is bounds-checked and a zero/absurd size ends the walk.
        while offset + 8 <= data.count && parts.count < 12 {
            let size = data[offset..<offset + 4].reduce(0) { $0 << 8 | Int($1) }
            let name = String(bytes: data[offset + 4..<offset + 8], encoding: .ascii) ?? "????"
            parts.append("\(name):\(size)")
            if name == "ftyp", offset + 16 <= data.count {
                let brand = String(bytes: data[offset + 8..<offset + 12], encoding: .ascii) ?? "????"
                parts.append("brand=\(brand)")
            }
            if name == "mdat" { parts.append("mdatPayload@\(offset + 8)") }
            guard size >= 8 else { break }
            offset += size
        }
        if let stco = firstChunkOffset(data) { parts.append("stco[0]=\(stco)") }
        return parts.joined(separator: " ") + " total=\(data.count)"
    }

    /// The first sample-chunk offset recorded in `moov`, or nil if absent.
    ///
    /// This is the number that decides whether the file is actually valid.
    /// `AVAudioRecorder` pre-allocates space, then rewrites `moov` at finalize
    /// for however much audio was really captured — which is why a big `free`
    /// atom is left behind. If that rewrite does not also correct the chunk
    /// offsets, `moov` describes a layout the file no longer has: AVFoundation
    /// is tolerant and reseeks around it, a strict parser like WebKit's rejects
    /// the file outright. Compare against `mdatPayload@` above; a first chunk
    /// offset below where `mdat`'s payload begins means the index is stale.
    private static func firstChunkOffset(_ data: Data) -> UInt32? {
        // `stco` is buried at moov > trak > mdia > minf > stbl > stco. The
        // nesting is fixed, but scanning for the signature is far less code than
        // six levels of container walking and cannot be thrown off by an
        // unexpected sibling atom.
        let tag: [UInt8] = Array("stco".utf8)
        let bytes = [UInt8](data.prefix(64 * 1024))
        guard bytes.count > 24 else { return nil }
        for i in 0..<(bytes.count - 24) where Array(bytes[i..<i + 4]) == tag {
            // stco: 4 name, 1 version, 3 flags, 4 entry count, then entries.
            let entryStart = i + 12
            guard entryStart + 4 <= bytes.count else { return nil }
            return bytes[entryStart..<entryStart + 4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        }
        return nil
    }

    /// Is the default input device capturing for ANY process right now?
    ///
    /// This is the hardware answer, from the CoreAudio HAL — the same state the
    /// orange menu-bar dot reflects. Deliberately not "did we call stop()":
    /// releasing an input is asynchronous and the API returning cleanly is not
    /// evidence the device went idle.
    ///
    /// Two honest limits. It is system-wide, so another app recording reads as
    /// `true` here; and a sandboxed app may be refused the HAL query, in which
    /// case this returns nil rather than a reassuring `false`. Never report "the
    /// mic is off" from a nil — that is an unanswered question, not a no.
    ///
    /// Catalyst only: the HAL is not reachable from iOS, where the audio session
    /// and the OS indicator are the equivalent signal.
    private static func defaultInputIsRunning() -> Bool? {
        #if targetEnvironment(macCatalyst)
        var deviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var deviceAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &deviceAddr, 0, nil, &size, &deviceID
        ) == noErr, deviceID != kAudioObjectUnknown else { return nil }

        var running = UInt32(0)
        var runningSize = UInt32(MemoryLayout<UInt32>.size)
        var runningAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(
            deviceID, &runningAddr, 0, nil, &runningSize, &running
        ) == noErr else { return nil }
        return running != 0
        #else
        return nil
        #endif
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
        restorePlaybackSession()
    }

    /// Put the process-wide audio session back to PLAYBACK, and verify the
    /// microphone actually went cold.
    ///
    /// MUST run after every recording, successful or not. It used to live only
    /// in `cleanUp()` — which the success path skips on purpose, because it
    /// deletes the file the web layer still has to read — so the tidy-up
    /// happened on failure and never on success.
    ///
    /// Restoring the CATEGORY is not the same as deactivating the session. An
    /// earlier version called `setActive(false, .notifyOthersOnDeactivation)`
    /// here, which broadcasts a system-wide "I am done, everyone else resume".
    /// This app is one of the others: the WebView owns playback of every voice
    /// note on screen, so that call killed playback of notes recorded seconds
    /// earlier. Do not reintroduce it. Changing the category just puts the
    /// session into a shape suited to playing audio, which is what the app does
    /// the rest of the time.
    private func restorePlaybackSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])

        #if DEBUG
        // Confirm the microphone went cold, rather than trusting that stopping
        // the recorder and changing the category was enough. CoreAudio is asked a
        // moment later on purpose: releasing an input device is asynchronous, so
        // an immediate read reports the state we are trying to leave and would
        // look like a stuck microphone every single time.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            Self.log.notice("""
            mic released? recorder=\(self?.recorder == nil ? "nil" : "LIVE", privacy: .public) \
            category=\(AVAudioSession.sharedInstance().category.rawValue, privacy: .public) \
            inputRunning=\(String(describing: Self.defaultInputIsRunning()), privacy: .public)
            """)
        }
        #endif
    }
}
