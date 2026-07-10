class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.sampleCount = 0;
    this.targetSize = 2048;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    this.chunks.push(new Float32Array(input));
    this.sampleCount += input.length;
    if (this.sampleCount < this.targetSize) return true;

    const output = new Float32Array(this.sampleCount);
    let offset = 0;
    this.chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    this.chunks = [];
    this.sampleCount = 0;
    this.port.postMessage(output, [output.buffer]);
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
