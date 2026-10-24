import { useCallback, useEffect, useState } from "react";
import { Avatar } from "./Auth";
import type { Strings } from "./i18n";
import { supabase } from "./supabase";

export type Server = { id: string; name: string; owner_id: string };
type Member = {
  user_id: string;
  role: "owner" | "member";
  profiles: { display_name: string; avatar_path: string | null } | null;
};
type Invite = { code: string; expires_at: string; max_uses: number; uses: number };

const INSTALL_URL = "https://github.com/IvanZhuravel/SlopCord/releases/latest";

/** Servers you belong to. `null` while loading. */
export function useServers(userId: string | undefined) {
  const [servers, setServers] = useState<Server[] | null>(null);
  const reload = useCallback(async () => {
    if (!supabase || !userId) return;
    const { data } = await supabase.from("servers").select("id, name, owner_id").order("created_at");
    setServers((data as Server[] | null) ?? []);
  }, [userId]);
  useEffect(() => {
    setServers(null);
    void reload();
  }, [reload]);
  return { servers, reload };
}

/** Shown when you are not on any server yet: join by code or start your own. */
export function JoinServer({ t, onJoined }: { t: Strings; onJoined: (serverId: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const join = async () => {
    if (!supabase || !code.trim()) return;
    setBusy(true);
    setError("");
    const { data, error: e } = await supabase.rpc("accept_invite", { invite_code: code });
    setBusy(false);
    if (e) setError(e.message.includes("too_many") ? t.errorTooMany : e.message.includes("server_full") ? t.serverFull : t.errorNetwork);
    else if (!data) setError(t.badInvite);
    else onJoined(data as string);
  };

  const create = async () => {
    if (!supabase || !name.trim()) return;
    setBusy(true);
    setError("");
    const { data, error: e } = await supabase.rpc("create_server", { server_name: name });
    setBusy(false);
    if (e || !data) setError(t.errorNetwork);
    else onJoined(data as string);
  };

  return (
    <section className="card">
      <h2>{t.joinServer}</h2>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void join();
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t.inviteCode}
          maxLength={12}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="primary" disabled={busy || !code.trim()}>
          {t.joinByCode}
        </button>
      </form>
      <small>{t.orCreate}</small>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.serverName} maxLength={50} />
        <button type="submit" disabled={busy || !name.trim()}>
          {t.create}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function inviteText(t: Strings, code: string) {
  return t.inviteMessage.replace("{url}", INSTALL_URL).replace("{code}", code);
}

/** Server name, people on it, and for the owner: invites and removing people. */
export function ServerCard({
  t,
  server,
  userId,
  onLeft,
}: {
  t: Strings;
  server: Server;
  userId: string;
  onLeft: () => void;
}) {
  const isOwner = server.owner_id === userId;
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase
      .from("members")
      .select("user_id, role, profiles(display_name, avatar_path)")
      .eq("server_id", server.id)
      .order("joined_at");
    setMembers((data as unknown as Member[] | null) ?? []);
    if (isOwner) {
      const { data: inv } = await supabase
        .from("invites")
        .select("code, expires_at, max_uses, uses")
        .eq("server_id", server.id)
        .eq("revoked", false)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });
      setInvites(((inv as Invite[] | null) ?? []).filter((i) => i.uses < i.max_uses));
    }
  }, [server.id, isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(inviteText(t, code));
      setCopied(code);
    } catch {
      setError(t.copyFailed);
    }
  };

  const newInvite = async () => {
    if (!supabase) return;
    const { data, error: e } = await supabase
      .from("invites")
      .insert({ server_id: server.id, created_by: userId })
      .select("code")
      .single();
    if (e || !data) return setError(t.errorNetwork);
    setError("");
    await copy(data.code as string);
    void load();
  };

  const revoke = async (code: string) => {
    if (!supabase) return;
    await supabase.from("invites").update({ revoked: true }).eq("code", code);
    void load();
  };

  const remove = async (memberId: string) => {
    if (!supabase) return;
    if (memberId === userId && !window.confirm(t.leaveConfirm.replace("{server}", server.name))) return;
    const { error: e } = await supabase.from("members").delete().eq("server_id", server.id).eq("user_id", memberId);
    if (e) return setError(t.errorNetwork);
    if (memberId === userId) onLeft();
    else void load();
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {server.name} · {members.length}/50
        </h2>
        {isOwner && (
          <button type="button" className="primary" onClick={() => void newInvite()}>
            {t.invite}
          </button>
        )}
      </div>
      {copied && <p className="hint">{t.inviteCopied}</p>}

      {isOwner && invites.length > 0 && (
        <ul className="invites">
          {invites.map((i) => (
            <li key={i.code}>
              <code>{i.code}</code>
              <small>
                {i.uses}/{i.max_uses} · {t.until} {new Date(i.expires_at).toLocaleDateString()}
              </small>
              <button type="button" onClick={() => void copy(i.code)}>
                {t.copy}
              </button>
              <button type="button" onClick={() => void revoke(i.code)}>
                {t.revoke}
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="peers">
        {members.map((m) => (
          <li key={m.user_id}>
            <Avatar profile={m.profiles ?? { display_name: "?", avatar_path: null }} />
            <span className="peer-name">
              {m.profiles?.display_name ?? "?"}
              {m.user_id === userId && <em> ({t.you})</em>}
              {m.role === "owner" && <em> · {t.owner}</em>}
            </span>
            {isOwner && m.role !== "owner" && (
              <button type="button" className="link" onClick={() => void remove(m.user_id)}>
                {t.kick}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      {!isOwner && (
        <button type="button" onClick={() => void remove(userId)}>
          {t.leaveServer}
        </button>
      )}
    </section>
  );
}
