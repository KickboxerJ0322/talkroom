const DEFAULT_CHUNK_DURATION_MS = 2400;
const DEFAULT_LANGUAGE_CODE = "ja-JP";
const TARGET_SAMPLE_RATE = 16000;

function mergeFloat32Chunks(chunks, length) {
  const merged = new Float32Array(length);
  let offset = 0;

  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });

  return merged;
}

function encodeLinear16(samples) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(dataSize);
  const view = new DataView(buffer);
  let offset = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

function downsampleBuffer(samples, sourceSampleRate, targetSampleRate) {
  if (targetSampleRate >= sourceSampleRate) {
    return samples;
  }

  const sampleRateRatio = sourceSampleRate / targetSampleRate;
  const newLength = Math.round(samples.length / sampleRateRatio);
  const downsampled = new Float32Array(newLength);
  let sourceOffset = 0;

  for (let index = 0; index < newLength; index += 1) {
    const nextSourceOffset = Math.round((index + 1) * sampleRateRatio);
    let total = 0;
    let count = 0;

    for (; sourceOffset < nextSourceOffset && sourceOffset < samples.length; sourceOffset += 1) {
      total += samples[sourceOffset];
      count += 1;
    }

    downsampled[index] = count > 0 ? total / count : 0;
  }

  return downsampled;
}

export class TranscriptionStreamer {
  constructor({
    stream,
    onTranscript,
    onStateChange,
    onError,
    languageCode = DEFAULT_LANGUAGE_CODE,
    chunkDurationMs = DEFAULT_CHUNK_DURATION_MS
  }) {
    this.stream = stream;
    this.onTranscript = onTranscript;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.languageCode = languageCode;
    this.chunkDurationMs = chunkDurationMs;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.silentGainNode = null;
    this.sampleRate = 0;
    this.samplesPerChunk = 0;
    this.pendingChunks = [];
    this.pendingSampleCount = 0;
    this.uploadQueue = Promise.resolve();
    this.running = false;
  }

  static isSupported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async start() {
    if (this.running) {
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("このブラウザは音声文字起こしに対応していません。");
    }

    this.audioContext = new AudioContextCtor();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.sampleRate = this.audioContext.sampleRate;
    this.samplesPerChunk = Math.max(
      2048,
      Math.round((this.sampleRate * this.chunkDurationMs) / 1000)
    );
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.silentGainNode = this.audioContext.createGain();
    this.silentGainNode.gain.value = 0;

    this.processorNode.onaudioprocess = (event) => {
      if (!this.running) {
        return;
      }

      const inputSamples = event.inputBuffer.getChannelData(0);
      this.pendingChunks.push(new Float32Array(inputSamples));
      this.pendingSampleCount += inputSamples.length;

      if (this.pendingSampleCount >= this.samplesPerChunk) {
        this.flushChunk();
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.audioContext.destination);
    this.running = true;
    this.onStateChange?.({ supported: true, listening: true });
  }

  async stop() {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.flushChunk();

    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.silentGainNode?.disconnect();
    this.processorNode = null;
    this.sourceNode = null;
    this.silentGainNode = null;

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.onStateChange?.({ supported: true, listening: false });
  }

  flushChunk() {
    if (this.pendingSampleCount === 0) {
      return;
    }

    const samples = mergeFloat32Chunks(this.pendingChunks, this.pendingSampleCount);
    this.pendingChunks = [];
    this.pendingSampleCount = 0;

    this.uploadQueue = this.uploadQueue
      .then(() => this.sendChunk(samples))
      .catch((error) => {
        this.onError?.(error);
      });
  }

  async sendChunk(samples) {
    const outputSampleRate = Math.min(this.sampleRate, TARGET_SAMPLE_RATE);
    const outputSamples = downsampleBuffer(samples, this.sampleRate, outputSampleRate);
    const pcmBuffer = encodeLinear16(outputSamples);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Audio-Encoding": "LINEAR16",
        "X-Language-Code": this.languageCode,
        "X-Sample-Rate-Hz": String(Math.round(outputSampleRate))
      },
      body: pcmBuffer
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || "音声文字起こしに失敗しました。");
    }

    const payload = await response.json();
    if (payload.text) {
      this.onTranscript?.(payload.text);
    }
  }
}
