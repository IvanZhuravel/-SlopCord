import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

export type GateMode = "voice" | "ptt";

const WORKLET_URL = "/voice-gate.worklet.js";
const loadedContexts = new WeakSet<AudioContext>();

/**
 * Voice activation as a LiveKit track processor: the mic goes through an
 * AudioWorklet that passes sound only while you speak. LiveKit rebuilds it
 * on device switches and reconnects through `restart`.
 */
export class VoiceGateProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "voice-gate";
  processedTrack?: MediaStreamTrack;

  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private dest?: MediaStreamAudioDestinationNode;

  private mode: GateMode = "voice";
  private pttDown = false;

  constructor(
    private thresholdDb: number,
    private onOpenChange: (open: boolean) => void,
  ) {}

  async init({ track, audioContext }: AudioProcessorOptions) {
    if (!loadedContexts.has(audioContext)) {
      await audioContext.audioWorklet.addModule(WORKLET_URL);
      loadedContexts.add(audioContext);
    }
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.node = new AudioWorkletNode(audioContext, "voice-gate", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.node.port.onmessage = (e) => this.onOpenChange(Boolean(e.data.open));
    this.node.port.postMessage({ thresholdDb: this.thresholdDb, mode: this.mode, pttDown: this.pttDown });
    this.dest = audioContext.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.source.connect(this.node).connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.processedTrack?.stop();
    this.source = this.node = this.dest = this.processedTrack = undefined;
    this.onOpenChange(false);
  }

  setThreshold(thresholdDb: number) {
    this.thresholdDb = thresholdDb;
    this.node?.port.postMessage({ thresholdDb });
  }

  setMode(mode: GateMode) {
    this.mode = mode;
    this.pttDown = false;
    this.node?.port.postMessage({ mode, pttDown: false });
  }

  setPttDown(down: boolean) {
    this.pttDown = down;
    this.node?.port.postMessage({ pttDown: down });
  }
}
