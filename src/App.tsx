import { useCallback, useEffect, useMemo, useState } from "react";
import { detectLang, strings, type Lang } from "./i18n";
import { AuthScreen, ProfileCard } from "./Auth";
import { fetchVoiceToken, RoomList, useRooms, usePresence, type Presence, type Room } from "./Rooms";
import { JoinServer, ServerCard, useServers } from "./Server";
import { supabase, useProfile, useSession } from "./supabase";
import { useUpdater } from "./updater";
import { TokenSource } from "livekit-client";
import { capturePttKey, keyName, onPtt, pttAvailable, setPttKey } from "./ptt";
import { initialVoiceState, VoiceSession, type VoiceState } from "./voice";
import type { GateMode } from "./voiceGate";

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
  const [savedMode, setMode] = usePref<GateMode>("voiceMode", "voice");
  const mode: GateMode = pttAvailable ? savedMode : "voice";
  const [pttKey, setPttKeyPref] = usePref("pttKey", 0);
  const [pttKeyLabel, setPttKeyLabel] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [volumes, setVolumes] = usePref<Record<string, number>>("volumes", {});
  const [inputId, setInputId] = usePref("inputId", "");
  const [outputId, setOutputId] = usePref("outputId", "");
  const [voice, setVoice] = useState<VoiceState>(initialVoiceState);
  const [formError, setFormError] = useState(false);

  const t = strings[lang];
  const session = useMemo(() => new VoiceSession(setVoice), []);
  const inCall = voice.status === "connected" || voice.status === "reconnecting";
  // Device labels only appear after mic permission, so re-list once we are in a call.
  const { inputs, outputs, unlock } = useDevices(inCall);
  const updater = useUpdater();
  const upd = updater.state;
  const authSession = useSession();
  const [profile, setProfile] = useProfile(authSession?.user.id);
  // With Supabase configured you sign in and your profile name is used; without it, the stage 0 name field stays.
  const needsSignIn = supabase !== null && !authSession;
  const voiceName = profile?.display_name ?? name;
  const userId = authSession?.user.id;
  const { servers, reload: reloadServers } = useServers(userId);
  const [savedServerId, setServerId] = usePref("serverId", "");
  const server = servers?.find((s) => s.id === savedServerId) ?? servers?.[0];
  const noServer = servers !== null && servers.length === 0;
  const rooms = useRooms(server?.id);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const currentRoomId = inCall || voice.status === "connecting" ? (currentRoom?.id ?? null) : null;
  const me: Presence | null =
    userId && profile
      ? {
          user_id: userId,
          name: profile.display_name,
          avatar_path: profile.avatar_path,
          room_id: currentRoomId,
          muted: voice.micMuted,
        }
      : null;
  const everyone = usePresence(server?.id, me);
  // In our rooms the LiveKit identity is the user id, so the call tells who is talking right now.
  const speaking = useMemo(
    () => new Set(voice.peers.filter((p) => p.speaking && !p.micMuted).map((p) => p.identity)),
    [voice.peers],
  );

  // Signing out ends the call too.
  useEffect(() => {
    if (needsSignIn) void session.leave();
  }, [needsSignIn, session]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const voiceOptions = {
    thresholdDb,
    mode,
    volumes,
    inputDeviceId: inputId || undefined,
    outputDeviceId: outputId || undefined,
  };

  // Stage 0 path without Supabase: LiveKit's development token server, any room name.
  const joinDev = () => {
    if (!voiceName.trim() || !roomName.trim() || !tokenServerId.trim()) {
      setFormError(true);
      return;
    }
    setFormError(false);
    const source = TokenSource.developmentTokenServer(tokenServerId.trim());
    void session.join({
      fetchToken: () =>
        source.fetch({
          roomName: roomName.trim(),
          participantName: voiceName.trim(),
          participantIdentity: `${voiceName.trim()}-${crypto.randomUUID().slice(0, 8)}`,
        }),
      ...voiceOptions,
    });
  };

  // Our rooms: the livekit-token function checks you are on the server and the room has space.
  const joinRoom = async (room: Room) => {
    if (inCall) await session.leave();
    setCurrentRoom(room);
    void session.join({ fetchToken: () => fetchVoiceToken(room.id), ...voiceOptions });
  };

  const voiceError =
    voice.error === "mic"
      ? t.errorMic
      : voice.errorDetail === "room_full"
        ? t.roomFull
        : voice.errorDetail === "no_access"
          ? t.errorNoAccess
          : t.errorConnect;

  // The key hook runs only during a call in push-to-talk mode.
  useEffect(() => {
    setPttKey(inCall && mode === "ptt" ? pttKey : 0);
  }, [inCall, mode, pttKey]);

  useEffect(() => {
    if (!pttAvailable) return;
    const off = onPtt((down) => session.setPttDown(down));
    return () => void off.then((unlisten) => unlisten());
  }, [session]);

  useEffect(() => {
    session.setMode(mode);
  }, [session, mode]);

  useEffect(() => {
    if (pttKey) void keyName(pttKey, t.mouseButton).then(setPttKeyLabel);
  }, [pttKey, t]);

  const pickPttKey = async () => {
    setCapturing(true);
    try {
      const vk = await capturePttKey();
      if (vk) setPttKeyPref(vk);
    } finally {
      setCapturing(false);
    }
  };

  const onVolume = (identity: string, volume: number) => {
    setVolumes((v) => ({ ...v, [identity]: volume }));
    session.setPeerVolume(identity, volume);
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

      {upd.kind === "available" && (
        <div className="update-banner">
          <span>
            {t.updateAvailable}: {upd.version}
          </span>
          {inCall ? (
            <small>{t.updateAfterCall}</small>
          ) : (
            <button className="primary" onClick={() => void updater.install()}>
              {t.updateNow}
            </button>
          )}
        </div>
      )}
      {upd.kind === "downloading" && (
        <div className="update-banner">
          <span>
            {t.updateDownloading}
            {upd.percent !== undefined && ` ${upd.percent}%`}
          </span>
        </div>
      )}
      {upd.kind === "error" && upd.version && (
        <div className="update-banner">
          <span className="error">{t.updateFailed}</span>
          {!inCall && <button onClick={() => void updater.install()}>{t.updateRetry}</button>}
        </div>
      )}

      {needsSignIn && authSession === null && <AuthScreen t={t} lang={lang} />}

      {userId && noServer && (
        <JoinServer
          t={t}
          onJoined={(id) => {
            setServerId(id);
            void reloadServers();
          }}
        />
      )}

      {userId && servers && servers.length > 1 && (
        <select aria-label={t.server} value={server?.id} onChange={(e) => setServerId(e.target.value)}>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      {userId && server && (
        <ServerCard key={server.id} t={t} server={server} userId={userId} onLeft={() => void reloadServers()} />
      )}

      {userId && server && (
        <RoomList
          t={t}
          serverId={server.id}
          isOwner={server.owner_id === userId}
          rooms={rooms}
          everyone={everyone}
          currentRoomId={currentRoomId}
          speaking={speaking}
          busy={voice.status === "connecting"}
          onJoin={(room) => void joinRoom(room)}
        />
      )}
      {supabase && voice.error && <p className="error">{voiceError}</p>}

      {!supabase && !inCall && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            joinDev();
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
            {t.participants} · {supabase ? currentRoom?.name : roomName}
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
                {!p.isLocal && (
                  <input
                    type="range"
                    className="peer-volume"
                    aria-label={t.volume}
                    title={`${t.volume}: ${Math.round((volumes[p.identity] ?? 1) * 100)}%`}
                    min={0}
                    max={1}
                    step={0.05}
                    value={volumes[p.identity] ?? 1}
                    onChange={(e) => onVolume(p.identity, Number(e.target.value))}
                  />
                )}
              </li>
            ))}
          </ul>
          {voice.peers.length === 1 && <p className="hint">{t.alone}</p>}

          {mode === "ptt" && !pttKey && <p className="warn">{t.pttNoKey}</p>}
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

      {profile && <ProfileCard key={profile.id} t={t} profile={profile} onChange={setProfile} />}

      <section className="card settings" onPointerEnter={unlock}>
        <div className="mode-row" role="radiogroup" aria-label={t.voiceMode}>
          <button type="button" className={mode === "voice" ? "active" : ""} onClick={() => setMode("voice")}>
            {t.voiceActivation}
          </button>
          <button
            type="button"
            className={mode === "ptt" ? "active" : ""}
            onClick={() => setMode("ptt")}
            disabled={!pttAvailable}
            title={pttAvailable ? undefined : t.pttDesktopOnly}
          >
            {t.pushToTalk}
          </button>
        </div>
        {mode === "ptt" ? (
          <label>
            {t.pttKey}
            <button type="button" onClick={() => void pickPttKey()} disabled={capturing}>
              {capturing ? t.pttPress : pttKey ? pttKeyLabel : t.pttChoose}
            </button>
            <small>{t.pttHint}</small>
          </label>
        ) : (
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
        )}
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
        <div className="version-row">
          <span>
            {t.version} {updater.currentVersion}
            {upd.kind === "latest" && <small> · {t.upToDate}</small>}
            {upd.kind === "error" && !upd.version && <small> · {t.updateFailed}</small>}
          </span>
          <button
            onClick={() => void updater.check()}
            disabled={upd.kind === "checking" || upd.kind === "downloading"}
          >
            {upd.kind === "checking" ? t.checking : t.checkUpdates}
          </button>
        </div>
      </section>
    </main>
  );
}
