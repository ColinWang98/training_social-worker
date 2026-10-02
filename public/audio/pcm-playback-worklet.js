class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.playing = false;
    this.streaming = false;
    this.inputEnded = false;
    this.startedReported = false;
    this.playedSamples = 0;
    this.underruns = 0;
    this.reportCountdown = 0;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'enqueue' && message.samples) {
        this.queue.push(new Float32Array(message.samples));
        this.playing = true;
        return;
      }
      if (message.type === 'start_stream') {
        this.streaming = true;
        this.inputEnded = false;
        this.startedReported = false;
        this.playing = true;
        return;
      }
      if (message.type === 'end_stream') {
        this.inputEnded = true;
        return;
      }
      if (message.type === 'clear') {
        this.queue = [];
        this.offset = 0;
        this.playing = false;
        this.streaming = false;
        this.inputEnded = false;
        this.playedSamples = 0;
        this.port.postMessage({ type: 'cleared' });
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    let writeIndex = 0;
    let energy = 0;
    while (writeIndex < output.length && this.queue.length) {
      const chunk = this.queue[0];
      const available = chunk.length - this.offset;
      const count = Math.min(output.length - writeIndex, available);
      for (let index = 0; index < count; index += 1) {
        const localIndex = this.offset + index;
        const fadeIn = Math.min(1, (this.playedSamples + index + 1) / 32);
        const samplesAfter = chunk.length - localIndex;
        const fadeOut = this.inputEnded && this.queue.length === 1 ? Math.min(1, samplesAfter / 32) : 1;
        const sample = chunk[localIndex] * fadeIn * fadeOut;
        output[writeIndex + index] = sample;
        energy += sample * sample;
      }
      writeIndex += count;
      this.offset += count;
      this.playedSamples += count;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    if (writeIndex > 0 && !this.startedReported) {
      this.startedReported = true;
      this.port.postMessage({ type: 'started' });
    }

    if (this.playing && writeIndex === 0 && (!this.streaming || this.inputEnded)) {
      this.playing = false;
      this.streaming = false;
      this.inputEnded = false;
      this.startedReported = false;
      this.port.postMessage({
        type: 'drained',
        playedSamples: this.playedSamples,
        underruns: this.underruns,
      });
    } else if (this.playing && this.startedReported && writeIndex < output.length && this.streaming) {
      this.underruns += 1;
    }

    this.reportCountdown -= 1;
    if (this.reportCountdown <= 0) {
      this.reportCountdown = 4;
      this.port.postMessage({
        type: 'clock',
        playedSamples: this.playedSamples,
        sampleRate,
        level: Math.min(1, Math.sqrt(energy / Math.max(writeIndex, 1)) * 3.4),
        underruns: this.underruns,
      });
    }
    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
