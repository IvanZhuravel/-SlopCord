import { useCallback, useEffect, useMemo, useState } from "react";
import { detectLang, strings, type Lang } from "./i18n";
import { initialVoiceState, VoiceSession, type VoiceState } from "./voice";

// Small per-device preferences. Losing them is harmless, so storage errors are ignored.
function usePref<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

// Windows hides the device list until the app has mic permission, so the
// pickers ask for it once (on first click) and then re-read the list.
function useDevices(refreshKey: unknown) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const load = useCallback(
    () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.deviceId && d.deviceId !== "default")))
        .catch(() => setDevices([])),
    [],
  );
  useEffect(() => {
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, [load, refreshKey]);
  const unlock = useCallback(async () => {
    if (unlocked || devices.some((d) => d.label)) return;
    setUnlocked(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* no permission: the list stays as Windows gives it */
    }
    await load();
  }, [unlocked, devices, load]);
  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
    unlock,
  };
}

// Baked in at build time from the LIVEKIT_TOKEN_SERVER_ID repository secret,
// so friends only install and talk. Without it the app asks for the ID.
const BUILT_IN_TOKEN_SERVER_ID = (import.meta.env.VITE_LIVEKIT_TOKEN_SERVER_ID ?? "").trim();

export default function App() {
  const [lang, setLang] = usePref<Lang>("lang", detectLang());
  const [name, setName] = usePref("name", "");
  const [roomName, setRoomName] = usePref("room", "general");
  const [savedTokenServerId, setTokenServerId] = usePref("tokenServerId", "");
  const tokenServerId = BUILT_IN_TOKEN_SERVER_ID || savedTokenServerId;
  const [thresholdDb, setThresholdDb] = usePref("thresholdDb", -50);
  const [inputId, setInputId] = usePref("inputId", "");
  const [outputId, setOutputId] = usePref("outputId", "");
  const [voice, setVoice] = useState<VoiceState>(initialVoiceState);
  const [formError, setFormError] = useState(false);

  const t = strings[lang];
  const session = useMemo(() => new VoiceSession(setVoice), []);
  const inCall = voice.status === "connected" || voice.status === "reconnecting";
  // Device labels only appear after mic permission, so re-list once we are in a call.
  const { inputs, outputs, unlock } = useDevices(inCall);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const join = () => {
    if (!name.trim() || !roomName.trim() || !tokenServerId.trim()) {
      setFormError(true);
      return;
    }
    setFormError(false);
    void session.join({
      name: name.trim(),
      roomName: roomName.trim(),
      tokenServerId: tokenServerId.trim(),
      thresholdDb,
      inputDeviceId: inputId || undefined,
      outputDeviceId: outputId || undefined,
    });
  };

  const onThreshold = (db: number) => {
    setThresholdDb(db);
    session.setThreshold(db);
  };

  const onDevice = (kind: "audioinput" | "audiooutput", id: string) => {
    (kind === "audioinput" ? setInputId : setOutputId)(id);
    if (inCall) void session.switchDevice(kind, id || "default");
  };

  return (
    <main>
      <header>
        <h1>{t.appTitle}</h1>
        <select aria-label={t.language} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          <option value="uk">Українська</option>
          <option value="en">English</option>
        </select>
      </header>

      {!inCall && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <label>
            {t.yourName}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          </label>
          <label>
            {t.roomName}
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={64} />
          </label>
          {!BUILT_IN_TOKEN_SERVER_ID && (
            <label>
              {t.tokenServerId}
              <input
                value={tokenServerId}
                onChange={(e) => setTokenServerId(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <small>{t.tokenServerHint}</small>
            </label>
          )}
          {formError && <p className="error">{t.fillAll}</p>}
          {voice.error && (
            <p className="error">
              {voice.error === "mic" ? t.errorMic : t.errorConnect}
              {voice.errorDetail && <small>{voice.errorDetail}</small>}
            </p>
          )}
          <button type="submit" className="primary" disabled={voice.status === "connecting"}>
            {voice.status === "connecting" ? t.joining : t.join}
          </button>
        </form>
      )}

      {inCall && (
        <section className="card">
          {voice.status === "reconnecting" && <p className="warn">{t.reconnecting}</p>}
          <h2>
            {t.participants} · {roomName}
          </h2>
          <ul className="peers">
            {voice.peers.map((p) => (
              <li key={p.identity} className={p.speaking && !p.micMuted ? "speaking" : ""}>
                <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="peer-name">
                  {p.name}
                  {p.isLocal && <em> ({t.you})</em>}
                </span>
                {p.micMuted && <span className="muted-tag">{t.muted}</span>}
              </li>
            ))}
          </ul>
          {voice.peers.length === 1 && <p className="hint">{t.alone}</p>}

          <p className={`tx ${voice.transmitting && !voice.micMuted ? "on" : ""}`}>
            <span className="dot" /> {voice.transmitting && !voice.micMuted ? t.transmitting : t.silent}
          </p>

          <div className="controls">
            <button onClick={() => void session.setMicMuted(!voice.micMuted)}>
              {voice.micMuted ? t.unmute : t.mute}
            </button>
            <button onClick={() => void session.setDeafened(!voice.deafened)}>
              {voice.deafened ? t.undeafen : t.deafen}
            </button>
            <button className="danger" onClick={() => void session.leave()}>
              {t.leave}
            </button>
          </div>
        </section>
      )}

      <section className="card settings" onPointerEnter={unlock}>
        <label>
          {t.sensitivity}: {thresholdDb} dB
          <input
            type="range"
            min={-75}
            max={-25}
            step={1}
            value={thresholdDb}
            onChange={(e) => onThreshold(Number(e.target.value))}
          />
          <small>{t.sensitivityHint}</small>
        </label>
        <label>
          {t.microphone}
          <select value={inputId} onFocus={unlock} onChange={(e) => onDevice("audioinput", e.target.value)}>
            <option value="">{t.defaultDevice}</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.speakers}
          <select value={outputId} onFocus={unlock} onChange={(e) => onDevice("audiooutput", e.target.value)}>
            <option value="">{t.defaultDevice}</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </section>
    </main>
  );
}
