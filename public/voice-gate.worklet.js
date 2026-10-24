// Voice activation gate. Runs on the audio thread, so it keeps working while the
// window is minimised (timers on the page itself get throttled by WebView2).
// While closed it outputs pure silence, which lets Opus DTX send almost nothing.

const HOLD_SECONDS = 0.4; // keep the gate open this long after the voice drops
const FADE_SECONDS = 0.005; // short fade to avoid clicks when opening and closing

class VoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.thresholdDb = -50;
    this.open = false;
    this.holdLeft = 0;
    this.gain = 0;
    this.fadeStep = 1 / (FADE_SECONDS * sampleRate);
    this.port.onmessage = (e) => {
      if (typeof e.data.thresholdDb === "number") this.thresholdDb = e.data.thresholdDb;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input) {
      output.fill(0);
      return true;
    }

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const db = 10 * Math.log10(sum / input.length + 1e-12);

    if (db > this.thresholdDb) {
      this.holdLeft = HOLD_SECONDS * sampleRate;
    } else {
      this.holdLeft -= input.length;
    }
    const shouldOpen = this.holdLeft > 0;
    if (shouldOpen !== this.open) {
      this.open = shouldOpen;
      this.port.postMessage({ open: shouldOpen });
    }

    const target = this.open ? 1 : 0;
    if (target === this.gain && target === 0) {
      output.fill(0);
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      if (this.gain < target) this.gain = Math.min(target, this.gain + this.fadeStep);
      else if (this.gain > target) this.gain = Math.max(target, this.gain - this.fadeStep);
      output[i] = input[i] * this.gain;
    }
    return true;
  }
}

registerProcessor("voice-gate", VoiceGate);
