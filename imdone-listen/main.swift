import AVFoundation
import Speech
import Foundation

// ── Config ────────────────────────────────────────────────────────────────────

let INITIAL_SPEECH_TIMEOUT: TimeInterval = 6.0
let SILENCE_TIMEOUT: TimeInterval        = 2.0
let MAX_DURATION: TimeInterval           = 60.0

// ── Mic auth ─────────────────────────────────────────────────────────────────

func checkMicAuth() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .denied, .restricted:
        fputs("imdone-listen: microphone access denied. Go to System Settings → Privacy & Security → Microphone and enable your terminal app.\n", stderr)
        return false
    case .notDetermined:
        fputs("imdone-listen: microphone permission not yet granted. Open System Settings → Privacy & Security → Microphone and enable your terminal app, then try again.\n", stderr)
        return false
    @unknown default:
        return false
    }
}

// ── Speech auth ───────────────────────────────────────────────────────────────

func checkSpeechAuth() -> Bool {
    // Fast path: already decided — no dialog, no blocking.
    let current = SFSpeechRecognizer.authorizationStatus()
    if current == .authorized { return true }
    if current == .denied || current == .restricted {
        fputs("imdone-listen: speech recognition not authorized. Grant access in System Settings → Privacy & Security → Speech Recognition.\n", stderr)
        return false
    }

    // Status is .notDetermined — need to request. The callback lands on the
    // main queue, so spin the RunLoop to process it. Cap at 10 s in case
    // the dialog never appears (subprocess context, display unavailable, etc.).
    var authorized = false
    var done = false
    SFSpeechRecognizer.requestAuthorization { status in
        authorized = status == .authorized
        done = true
    }
    let deadline = Date().addingTimeInterval(10.0)
    while !done && Date() < deadline {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    if !done {
        fputs("imdone-listen: speech recognition dialog timed out. Open System Settings → Privacy & Security → Speech Recognition and grant access to your terminal.\n", stderr)
        return false
    }
    if !authorized {
        fputs("imdone-listen: speech recognition denied. Grant access in System Settings → Privacy & Security → Speech Recognition.\n", stderr)
    }
    return authorized
}

// ── Main ──────────────────────────────────────────────────────────────────────

guard checkMicAuth() else { exit(1) }
guard checkSpeechAuth() else { exit(1) }

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
      recognizer.isAvailable else {
    fputs("imdone-listen: speech recognizer unavailable\n", stderr)
    exit(1)
}

let engine  = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
request.shouldReportPartialResults = true

var transcript   = ""
var isDone       = false
var silenceTimer: Timer?
var heardSpeech  = false

func finish() {
    guard !isDone else { return }
    isDone = true
    silenceTimer?.invalidate()
    request.endAudio()
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
}

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        heardSpeech = true
        transcript = result.bestTranscription.formattedString
        silenceTimer?.invalidate()
        if result.isFinal {
            finish()
        } else {
            silenceTimer = Timer.scheduledTimer(withTimeInterval: SILENCE_TIMEOUT, repeats: false) { _ in
                finish()
            }
        }
    }
    if let error = error {
        let nsErr = error as NSError
        switch nsErr.code {
        case 301:
            // "No speech detected" — normal end-of-session signal.
            finish()
        case 1110:
            // Transient "Retry" from the recognizer — fires during initialisation
            // when READY is emitted before the recognizer is fully warm (normal on
            // round 2+). If we already have speech, commit it. If not, keep the
            // window open: the recognizer retries internally and will process the
            // buffered audio once it recovers. Calling finish() here would silently
            // drop the user's speech on every subsequent round.
            if heardSpeech { finish() }
        default:
            fputs("imdone-listen: recognition error \(nsErr.code): \(nsErr.localizedDescription)\n", stderr)
            finish()
        }
    }
}

let inputNode = engine.inputNode
let format    = inputNode.outputFormat(forBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
}

do {
    try engine.start()
} catch {
    fputs("imdone-listen: audio engine failed: \(error.localizedDescription)\n", stderr)
    fputs("imdone-listen: tip — check System Settings → Privacy & Security → Microphone and ensure your terminal has access.\n", stderr)
    exit(1)
}

// AVAudioEngine and SFSpeechRecognizer initialise in the background (~0.5-1s),
// but the audio tap is already running and every buffer is fed into the request.
// Any speech spoken before the recognizer is fully warm is buffered and will be
// transcribed once it catches up — nothing is lost by emitting READY early.
// say/afplay uses audio OUTPUT; AVAudioEngine uses audio INPUT — separate hardware
// paths on macOS, so there is no audio-session conflict to wait for.
FileHandle.standardOutput.write("READY\n".data(using: .utf8)!)
fputs("imdone-listen: listening...\n", stderr)

// Exit if no speech starts within the initial window.
let firstSpeechTimer = Timer.scheduledTimer(withTimeInterval: INITIAL_SPEECH_TIMEOUT, repeats: false) { _ in
    if !heardSpeech {
        fputs("imdone-listen: no speech detected within \(INITIAL_SPEECH_TIMEOUT)s window\n", stderr)
    }
    finish()
}

// Hard cap
let maxTimer = Timer.scheduledTimer(withTimeInterval: MAX_DURATION, repeats: false) { _ in
    finish()
}

while !isDone {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
}

maxTimer.invalidate()
firstSpeechTimer.invalidate()
task.cancel()

if !transcript.isEmpty {
    print(transcript)
    exit(0)
} else {
    if !heardSpeech {
        fputs("imdone-listen: no speech detected\n", stderr)
    }
    exit(1)
}
