import AVFoundation
import Speech
import Foundation

// ── Config ────────────────────────────────────────────────────────────────────

let INITIAL_SPEECH_TIMEOUT: TimeInterval = 6.0
let SILENCE_TIMEOUT: TimeInterval        = 1.5
let MAX_DURATION: TimeInterval           = 30.0

// ── Speech auth ───────────────────────────────────────────────────────────────

func awaitSpeechAuth() -> Bool {
    var authorized = false
    var done = false
    SFSpeechRecognizer.requestAuthorization { status in
        authorized = status == .authorized
        done = true
    }
    while !done { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05)) }
    return authorized
}

// ── Main ──────────────────────────────────────────────────────────────────────

guard awaitSpeechAuth() else {
    fputs("imdone-listen: speech recognition not authorized. Grant access in System Settings → Privacy & Security → Speech Recognition.\n", stderr)
    exit(1)
}

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
    if error != nil { finish() }
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
    exit(1)
}

// Fire immediately if no speech in first SILENCE_TIMEOUT seconds
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
