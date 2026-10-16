// Sound.swift: the beeper, the tone generator, the speech chip and the
// trackpad's haptics.

import AppKit
import AVFoundation

/// One sine voice, shared with the audio render thread under a lock the
/// render thread only tries to take.
private final class Voice {
    let lock: UnsafeMutablePointer<os_unfair_lock> = {
        let p = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        p.initialize(to: os_unfair_lock())
        return p
    }()
    var step = 0.0  // phase advance per sample, in turns
    var phase = 0.0
    var remaining = 0
    var total = 0
    var volume: Float = 0
}

@MainActor
final class Sound {
    private let engine = AVAudioEngine()
    private var source: AVAudioSourceNode?
    private var sampleRate = 48_000.0
    private let voice = Voice()
    private var idle: DispatchWorkItem?
    private lazy var synth = AVSpeechSynthesizer()

    func beep() {
        NSSound.beep()
    }

    /// A sine tone through the default output, with 5 ms ramps at each end.
    func tone(hz: Double, ms: Double, volume: Double) {
        guard hz > 0, hz < 24_000, ms > 0 else {
            log("tone: ignored hz \(hz) ms \(ms)")
            return
        }
        if source == nil { setUp() }
        guard source != nil else { return }
        let total = Int(sampleRate * min(ms, 60_000) / 1000)
        os_unfair_lock_lock(voice.lock)
        voice.step = hz / sampleRate
        voice.remaining = total
        voice.total = total
        voice.volume = Float(max(0, min(1, volume)))
        os_unfair_lock_unlock(voice.lock)
        if !engine.isRunning {
            do {
                try engine.start()
            } catch {
                log("tone: cannot start the audio engine: \(error)")
                return
            }
        }
        // Let the output go quiet a while after the last tone ends.
        idle?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.engine.pause() }
        idle = work
        DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000 + 2, execute: work)
    }

    private func setUp() {
        let out = engine.outputNode.outputFormat(forBus: 0)
        if out.sampleRate > 0 { sampleRate = out.sampleRate }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { return }
        let voice = self.voice
        let ramp = Int(sampleRate * 0.005)
        let node = AVAudioSourceNode(format: format) { _, _, frameCount, bufferList -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            let frames = Int(frameCount)
            guard let first = buffers.first, let data = first.mData else { return noErr }
            let out = data.assumingMemoryBound(to: Float.self)
            guard os_unfair_lock_trylock(voice.lock) else {
                for i in 0..<frames { out[i] = 0 }
                return noErr
            }
            for i in 0..<frames {
                if voice.remaining > 0 {
                    let done = voice.total - voice.remaining
                    let envelope = Float(min(1.0, Double(min(done, voice.remaining)) / Double(max(ramp, 1))))
                    out[i] = Float(sin(2 * Double.pi * voice.phase)) * voice.volume * envelope
                    voice.phase += voice.step
                    if voice.phase >= 1 { voice.phase -= 1 }
                    voice.remaining -= 1
                } else {
                    out[i] = 0
                }
            }
            os_unfair_lock_unlock(voice.lock)
            for b in buffers.dropFirst() {
                if let d = b.mData { memcpy(d, data, Int(b.mDataByteSize)) }
            }
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        source = node
    }

    /// Speaks text; a new say stops the last.
    func say(_ text: String, voice name: String?) {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        let utterance = AVSpeechUtterance(string: text)
        if let name, !name.isEmpty {
            if let v = AVSpeechSynthesisVoice(identifier: name) {
                utterance.voice = v
            } else if let v = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
                utterance.voice = v
            } else if let v = AVSpeechSynthesisVoice(language: name) {
                utterance.voice = v
            } else {
                log("say: no voice \(name); using the default")
            }
        }
        synth.speak(utterance)
    }

    func haptic(_ pattern: String) {
        let p: NSHapticFeedbackManager.FeedbackPattern
        switch pattern {
        case "alignment": p = .alignment
        case "level": p = .levelChange
        case "generic": p = .generic
        default:
            log("haptic: unknown pattern \(pattern), using generic")
            p = .generic
        }
        NSHapticFeedbackManager.defaultPerformer.perform(p, performanceTime: .now)
    }
}
