import {
  AudioPresets,
  DisconnectReason,
  LocalAudioTrack,
  Participant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { VoiceGateProcessor } from "./voiceGate";

export type Peer = {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
};

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";
export type VoiceError = "mic" | "connect";

export type VoiceState = {
  status: VoiceStatus;
  peers: Peer[];
  micMuted: boolean;
  deafened: boolean;
  transmitting: boolean;
  error?: VoiceError;
  errorDetail?: string;
};

export type VoiceToken = { serverUrl: string; participantToken: string };

export type JoinOptions = {
  /** Asks our server (or, without Supabase, LiveKit's dev token server) for permission to enter. */
  fetchToken: () => Promise<VoiceToken>;
  thresholdDb: number;
  inputDeviceId?: string;
  outputDeviceId?: string;
};

export const initialVoiceState: VoiceState = {
  status: "idle",
  peers: [],
  micMuted: false,
  deafened: false,
  transmitting: false,
};

/** One voice call. The UI only reads snapshots pushed through `onChange`. */
export class VoiceSession {
  private room?: Room;
  private gate?: VoiceGateProcessor;
  private audioSink = document.createElement("div");
  // LiveKit may already have detached a track by the time we hear it was unsubscribed,
  // so keep our own handle on each element to remove it.
  private audioEls = new Map<RemoteTrack, HTMLMediaElement>();
  private state: VoiceState = initialVoiceState;

  constructor(private onChange: (s: VoiceState) => void) {
    this.audioSink.hidden = true;
    document.body.appendChild(this.audioSink);
  }

  async join(opts: JoinOptions) {
    if (this.room) return;
    this.set({ ...initialVoiceState, status: "connecting" });

    const room = new Room({
      adaptiveStream: false,
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: opts.inputDeviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      audioOutput: opts.outputDeviceId ? { deviceId: opts.outputDeviceId } : undefined,
      // Opus mono with DTX: next to no bandwidth or CPU while nobody talks.
      publishDefaults: { dtx: true, red: false, audioPreset: AudioPresets.speech },
    });
    this.room = room;
    this.bindEvents(room);

    try {
      const { serverUrl, participantToken } = await opts.fetchToken();
      await room.connect(serverUrl, participantToken, { autoSubscribe: true });
    } catch (e) {
      await this.fail("connect", e);
      return;
    }

    try {
      const pub = await room.localParticipant.setMicrophoneEnabled(true);
      const track = pub?.track;
      if (track instanceof LocalAudioTrack) {
        this.gate = new VoiceGateProcessor(opts.thresholdDb, (open) => this.set({ transmitting: open }));
        await track.setProcessor(this.gate);
      }
    } catch (e) {
      await this.fail("mic", e);
      return;
    }

    this.set({ status: "connected" });
    this.refreshPeers();
  }

  async leave() {
    const room = this.room;
    this.room = undefined;
    this.gate = undefined;
    await room?.disconnect();
    this.clearAudio();
    this.set({ ...initialVoiceState });
  }

  async setMicMuted(muted: boolean) {
    if (!this.room) return;
    // Deafened implies muted; unmuting also undeafens, like in Discord.
    if (!muted && this.state.deafened) await this.applyDeafen(false);
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
    this.set({ micMuted: muted, deafened: muted ? this.state.deafened : false });
    this.refreshPeers();
  }

  async setDeafened(deafened: boolean) {
    if (!this.room) return;
    await this.applyDeafen(deafened);
    await this.room.localParticipant.setMicrophoneEnabled(!deafened);
    this.set({ deafened, micMuted: deafened });
    this.refreshPeers();
  }

  setThreshold(db: number) {
    this.gate?.setThreshold(db);
  }

  async switchDevice(kind: "audioinput" | "audiooutput", deviceId: string) {
    await this.room?.switchActiveDevice(kind, deviceId);
  }

  private async applyDeafen(deafened: boolean) {
    // Unsubscribing tells the server to stop sending audio at all: saves bandwidth and decoding.
    this.room?.remoteParticipants.forEach((p) =>
      p.audioTrackPublications.forEach((pub) => pub.setSubscribed(!deafened)),
    );
  }

  private bindEvents(room: Room) {
    const refresh = () => this.refreshPeers();
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        if (track.kind !== Track.Kind.Audio) return;
        if (this.state.deafened) {
          pub.setSubscribed(false);
          return;
        }
        const el = track.attach();
        this.audioEls.set(track, el);
        this.audioSink.appendChild(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach();
        this.audioEls.get(track)?.remove();
        this.audioEls.delete(track);
      })
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantNameChanged, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.Reconnecting, () => this.set({ status: "reconnecting" }))
      .on(RoomEvent.Reconnected, () => this.set({ status: "connected" }))
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (this.room !== room) return; // we left on purpose
        this.room = undefined;
        this.gate = undefined;
        this.clearAudio();
        this.set({
          ...initialVoiceState,
          error: reason === DisconnectReason.CLIENT_INITIATED ? undefined : "connect",
          errorDetail: reason === undefined ? undefined : DisconnectReason[reason],
        });
      });
  }

  private clearAudio() {
    this.audioEls.clear();
    this.audioSink.replaceChildren();
  }

  private refreshPeers() {
    const room = this.room;
    if (!room) return;
    const toPeer = (p: Participant, isLocal: boolean): Peer => ({
      identity: p.identity,
      name: p.name || p.identity,
      isLocal,
      speaking: p.isSpeaking,
      micMuted: !p.isMicrophoneEnabled,
    });
    const peers = [
      toPeer(room.localParticipant, true),
      ...Array.from(room.remoteParticipants.values(), (p) => toPeer(p, false)),
    ];
    this.set({ peers });
  }

  private async fail(error: VoiceError, e: unknown) {
    console.error(e);
    const room = this.room;
    this.room = undefined;
    this.gate = undefined;
    await room?.disconnect();
    this.set({ ...initialVoiceState, error, errorDetail: e instanceof Error ? e.message : String(e) });
  }

  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
