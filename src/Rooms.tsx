import { FunctionsHttpError } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Auth";
import type { Strings } from "./i18n";
import { supabase } from "./supabase";
import type { VoiceToken } from "./voice";

export type Room = { id: string; name: string; position: number };

/** What each app announces about itself on the server's Realtime channel. */
export type Presence = {
  user_id: string;
  name: string;
  avatar_path: string | null;
  room_id: string | null;
  muted: boolean;
};

export async function fetchVoiceToken(roomId: string): Promise<VoiceToken> {
  if (!supabase) throw new Error("not_configured");
  const { data, error } = await supabase.functions.invoke("livekit-token", { body: { room_id: roomId } });
  if (error) {
    let code = "connect";
    if (error instanceof FunctionsHttpError) {
      try {
        code = (await error.context.json()).error ?? code;
      } catch {
        /* keep the generic code */
      }
    }
    throw new Error(code);
  }
  return data as VoiceToken;
}

/** Rooms of a server, kept fresh by Realtime when anyone adds, renames or removes one. */
export function useRooms(serverId: string | undefined) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const reload = useCallback(async () => {
    if (!supabase || !serverId) return;
    const { data } = await supabase
      .from("rooms")
      .select("id, name, position")
      .eq("server_id", serverId)
      .order("position")
      .order("created_at");
    setRooms((data as Room[] | null) ?? []);
  }, [serverId]);

  useEffect(() => {
    setRooms([]);
    if (!supabase || !serverId) return;
    void reload();
    const channel = supabase
      .channel(`rooms:${serverId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `server_id=eq.${serverId}` },
        () => {
          void reload();
        },
      )
      .subscribe();
    return () => {
      void supabase?.removeChannel(channel);
    };
  }, [serverId, reload]);

  return rooms;
}

/**
 * Who sits in which room, without joining the call: every app tracks itself
 * on one Realtime channel per server. Nothing is stored in the database.
 */
export function usePresence(serverId: string | undefined, me: Presence | null) {
  const [everyone, setEveryone] = useState<Presence[]>([]);
  const [channel, setChannel] = useState<ReturnType<NonNullable<typeof supabase>["channel"]> | null>(null);
  const userId = me?.user_id;

  useEffect(() => {
    setEveryone([]);
    if (!supabase || !serverId || !userId) return;
    const ch = supabase.channel(`presence:${serverId}`, { config: { presence: { key: userId } } });
    ch.on("presence", { event: "sync" }, () => {
      // One entry per person even if they run the app twice: the latest wins.
      setEveryone(Object.values(ch.presenceState<Presence>()).map((list) => list[list.length - 1]));
    }).subscribe((status) => {
      if (status === "SUBSCRIBED") setChannel(ch);
    });
    return () => {
      setChannel(null);
      void supabase?.removeChannel(ch);
    };
  }, [serverId, userId]);

  // Re-announce only when something others can see changes.
  const key = me && JSON.stringify(me);
  useEffect(() => {
    if (channel && key) void channel.track(JSON.parse(key) as Presence);
  }, [channel, key]);

  return everyone;
}

export function RoomList({
  t,
  serverId,
  isOwner,
  rooms,
  everyone,
  currentRoomId,
  selectedRoomId,
  speaking,
  busy,
  onJoin,
  onSelect,
}: {
  t: Strings;
  serverId: string;
  isOwner: boolean;
  rooms: Room[];
  everyone: Presence[];
  currentRoomId: string | null;
  selectedRoomId: string | null;
  speaking: Set<string>;
  busy: boolean;
  onJoin: (room: Room) => void;
  onSelect: (room: Room) => void;
}) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  const create = async () => {
    if (!supabase || !newName.trim()) return;
    const { data: auth } = await supabase.auth.getUser();
    const { error: e } = await supabase
      .from("rooms")
      .insert({ server_id: serverId, name: newName.trim(), position: rooms.length, created_by: auth.user?.id });
    if (e) setError(e.message.includes("too_many_rooms") ? t.tooManyRooms : t.errorNetwork);
    else {
      setError("");
      setNewName("");
    }
  };

  const rename = async (room: Room) => {
    const name = window.prompt(t.renameRoom, room.name)?.trim();
    if (!supabase || !name || name === room.name) return;
    const { error: e } = await supabase.from("rooms").update({ name }).eq("id", room.id);
    if (e) setError(t.errorNetwork);
  };

  const remove = async (room: Room) => {
    if (!supabase || !window.confirm(t.deleteRoomConfirm.replace("{room}", room.name))) return;
    const { error: e } = await supabase.from("rooms").delete().eq("id", room.id);
    if (e) setError(t.errorNetwork);
  };

  return (
    <section className="card">
      <h2>{t.rooms}</h2>
      <ul className="rooms">
        {rooms.map((room) => {
          const here = everyone.filter((p) => p.room_id === room.id);
          return (
            <li
              key={room.id}
              className={[room.id === currentRoomId && "current", room.id === selectedRoomId && "selected"]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="room-row">
                <button
                  type="button"
                  className="room-name"
                  onClick={() => onSelect(room)}
                  onDoubleClick={() => void rename(room)}
                  title={t.roomHint}
                >
                  # {room.name}
                  {here.length > 0 && <small> · {here.length}/10</small>}
                </button>
                {room.id !== currentRoomId && (
                  <button type="button" onClick={() => onJoin(room)} disabled={busy} title={t.join}>
                    {t.joinVoice}
                  </button>
                )}
                {isOwner && rooms.length > 1 && (
                  <button type="button" className="link" onClick={() => void remove(room)} title={t.deleteRoom}>
                    ×
                  </button>
                )}
              </div>
              {here.length > 0 && (
                <ul className="room-people">
                  {here.map((p) => (
                    <li key={p.user_id} className={speaking.has(p.user_id) ? "speaking" : ""}>
                      <Avatar profile={{ display_name: p.name, avatar_path: p.avatar_path }} size={22} />
                      <span>{p.name}</span>
                      {p.muted && <span className="muted-tag">{t.muted}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t.newRoom} maxLength={40} />
        <button type="submit" disabled={!newName.trim()}>
          +
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
