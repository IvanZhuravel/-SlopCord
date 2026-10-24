import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./Auth";
import type { Strings } from "./i18n";
import { supabase, type Profile } from "./supabase";

type Attachment = {
  id: string;
  message_id: number;
  path: string;
  thumb_path: string | null;
  mime: string;
  width: number;
  height: number;
};

type Message = {
  id: number;
  room_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: Attachment[];
};

type Author = Pick<Profile, "display_name" | "avatar_path">;

const PAGE = 50;
const MAX_FILES = 4;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 1920;
const THUMB_SIDE = 480;
const COLUMNS = "id, room_id, author_id, body, created_at, edited_at, deleted_at";

// ---------------------------------------------------------------- images

type Prepared = { blob: Blob; thumb?: Blob; mime: string; width: number; height: number };

function encode(bitmap: ImageBitmap, maxSide: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/webp", 0.85),
  );
}

/**
 * Photos are shrunk to 1920 px WebP with a small preview, so a screenshot costs
 * about 200 KB instead of several MB. GIFs stay as they are to keep the animation.
 */
async function prepareImage(file: File): Promise<Prepared> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    if (file.type === "image/gif") {
      if (file.size > MAX_BYTES) throw new Error("too_big");
      return { blob: file, mime: "image/gif", width, height };
    }
    const blob = await encode(bitmap, MAX_SIDE);
    const thumb = Math.max(width, height) > THUMB_SIDE ? await encode(bitmap, THUMB_SIDE) : undefined;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    return { blob, thumb, mime: "image/webp", width: Math.round(width * scale), height: Math.round(height * scale) };
  } finally {
    bitmap.close();
  }
}

// The attachments bucket is private, so pictures load through links that expire after an hour.
const signed = new Map<string, { url: string; until: number }>();

async function signPaths(paths: string[]): Promise<void> {
  const now = Date.now();
  const missing = paths.filter((p) => (signed.get(p)?.until ?? 0) < now + 60_000);
  if (!supabase || missing.length === 0) return;
  const { data } = await supabase.storage.from("attachments").createSignedUrls(missing, 3600);
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) signed.set(item.path, { url: item.signedUrl, until: now + 3_500_000 });
  }
}

function attachmentPaths(messages: Message[]) {
  return messages.flatMap((m) => m.attachments.flatMap((a) => [a.thumb_path ?? a.path, a.path]));
}

// ---------------------------------------------------------------- data

function useMessages(roomId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [, setSignedVersion] = useState(0);

  const withUrls = useCallback(async (list: Message[]) => {
    await signPaths(attachmentPaths(list));
    setSignedVersion((v) => v + 1);
  }, []);

  const fetchPage = useCallback(
    async (beforeId?: number) => {
      if (!supabase) return [];
      let query = supabase
        .from("messages")
        .select(`${COLUMNS}, attachments(id, message_id, path, thumb_path, mime, width, height)`)
        .eq("room_id", roomId)
        .order("id", { ascending: false })
        .limit(PAGE);
      if (beforeId) query = query.lt("id", beforeId);
      const { data } = await query;
      const page = ((data as Message[] | null) ?? []).reverse();
      setHasOlder(page.length === PAGE);
      await withUrls(page);
      return page;
    },
    [roomId, withUrls],
  );

  useEffect(() => {
    setMessages([]);
    setHasOlder(false);
    if (!supabase) return;
    let live = true;
    void fetchPage().then((page) => live && setMessages(page));

    const upsert = (row: Omit<Message, "attachments">) =>
      setMessages((list) => {
        const i = list.findIndex((m) => m.id === row.id);
        if (i === -1) return [...list, { ...row, attachments: [] }];
        const next = list.slice();
        next[i] = { ...list[i], ...row };
        return next;
      });

    const channel = supabase
      .channel(`chat:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        (change) => {
          if (change.eventType !== "DELETE") upsert(change.new as Omit<Message, "attachments">);
        },
      )
      // Attachments carry no room id to filter on; Row Level Security already limits them to our servers.
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "attachments" }, (change) => {
        const a = change.new as Attachment;
        void signPaths([a.thumb_path ?? a.path, a.path]).then(() =>
          setMessages((list) =>
            list.map((m) =>
              m.id === a.message_id && !m.attachments.some((x) => x.id === a.id)
                ? { ...m, attachments: [...m.attachments, a] }
                : m,
            ),
          ),
        );
      })
      .subscribe();
    return () => {
      live = false;
      void supabase?.removeChannel(channel);
    };
  }, [roomId, fetchPage]);

  const loadOlder = async () => {
    const oldest = messages[0]?.id;
    if (!oldest) return;
    const page = await fetchPage(oldest);
    setMessages((list) => [...page.filter((m) => !list.some((x) => x.id === m.id)), ...list]);
  };

  return { messages, setMessages, hasOlder, loadOlder };
}

/** Names and avatars of everyone on the server, to sign each message. */
function useAuthors(serverId: string) {
  const [authors, setAuthors] = useState<Map<string, Author>>(new Map());
  useEffect(() => {
    if (!supabase) return;
    void supabase
      .from("members")
      .select("user_id, profiles(display_name, avatar_path)")
      .eq("server_id", serverId)
      .then(({ data }) => {
        const rows = (data as unknown as { user_id: string; profiles: Author | null }[] | null) ?? [];
        setAuthors(new Map(rows.filter((r) => r.profiles).map((r) => [r.user_id, r.profiles!])));
      });
  }, [serverId]);
  return authors;
}

// ---------------------------------------------------------------- UI

export function Chat({
  t,
  lang,
  serverId,
  roomId,
  roomName,
  userId,
  isOwner,
}: {
  t: Strings;
  lang: string;
  serverId: string;
  roomId: string;
  roomName: string;
  userId: string;
  isOwner: boolean;
}) {
  const { messages, setMessages, hasOlder, loadOlder } = useMessages(roomId);
  const authors = useAuthors(serverId);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [viewer, setViewer] = useState<Attachment | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);

  // Follow new messages only if you were already at the bottom.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    stickToBottom.current = true;
    setFiles([]);
    setEditing(null);
    setError("");
  }, [roomId]);

  const addFiles = (incoming: Iterable<File>) => {
    const images = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setFiles((current) => {
      const next = [...current, ...images];
      if (next.length > MAX_FILES) setError(t.tooManyFiles);
      return next.slice(0, MAX_FILES);
    });
  };

  const send = async () => {
    const body = text.trim();
    if (!supabase || sending || (!body && files.length === 0)) return;
    setSending(true);
    setError("");
    try {
      // Pictures first: a message never points at a picture that failed to upload.
      const uploaded = [];
      for (const file of files) {
        const img = await prepareImage(file);
        const ext = img.mime === "image/gif" ? "gif" : "webp";
        const base = `${serverId}/${roomId}/${crypto.randomUUID()}`;
        const path = `${base}.${ext}`;
        const up = await supabase.storage.from("attachments").upload(path, img.blob, { contentType: img.mime });
        if (up.error) throw up.error;
        let thumbPath: string | null = null;
        if (img.thumb) {
          thumbPath = `${base}_t.webp`;
          const th = await supabase.storage
            .from("attachments")
            .upload(thumbPath, img.thumb, { contentType: "image/webp" });
          if (th.error) thumbPath = null;
        }
        uploaded.push({
          path,
          thumb_path: thumbPath,
          mime: img.mime,
          size_bytes: img.blob.size,
          width: img.width,
          height: img.height,
        });
      }

      const { data: msg, error: e } = await supabase
        .from("messages")
        .insert({ room_id: roomId, author_id: userId, body })
        .select(COLUMNS)
        .single();
      if (e || !msg) throw e ?? new Error("insert");
      let attachments: Attachment[] = [];
      if (uploaded.length > 0) {
        const { data: rows, error: ae } = await supabase
          .from("attachments")
          .insert(uploaded.map((u) => ({ ...u, message_id: msg.id })))
          .select("id, message_id, path, thumb_path, mime, width, height");
        if (ae) throw ae;
        attachments = (rows as Attachment[]) ?? [];
        await signPaths(attachmentPaths([{ ...(msg as Message), attachments }]));
      }
      stickToBottom.current = true;
      setMessages((all) => {
        const rest = all.filter((m) => m.id !== msg.id);
        const existing = all.find((m) => m.id === msg.id);
        const merged = [
          ...(existing?.attachments ?? []),
          ...attachments.filter((a) => !existing?.attachments.some((x) => x.id === a.id)),
        ];
        return [...rest, { ...(msg as Message), attachments: merged }].sort((a, b) => a.id - b.id);
      });
      setText("");
      setFiles([]);
    } catch (e) {
      setError(e instanceof Error && e.message === "too_big" ? t.fileTooBig : t.errorSend);
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async (m: Message) => {
    const body = editText.trim();
    setEditing(null);
    if (!supabase || body === m.body || (!body && m.attachments.length === 0)) return;
    const { error: e } = await supabase.from("messages").update({ body }).eq("id", m.id);
    if (e) setError(t.errorSend);
  };

  const remove = async (m: Message) => {
    if (!supabase || !window.confirm(t.deleteMessageConfirm)) return;
    // The database stamps the time and clears the text; the row stays as a "message deleted" line.
    const { error: e } = await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", m.id);
    if (e) setError(t.errorSend);
  };

  const time = (iso: string) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <section
      className="card chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <h2># {roomName}</h2>
      <div
        className="messages"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {hasOlder && (
          <button type="button" className="link older" onClick={() => void loadOlder()}>
            {t.olderMessages}
          </button>
        )}
        {messages.length === 0 && <p className="hint">{t.noMessages}</p>}
        {messages.map((m, i) => {
          const author = (m.author_id && authors.get(m.author_id)) || { display_name: "?", avatar_path: null };
          const prev = messages[i - 1];
          // Messages from the same person within 5 minutes stack under one name.
          const grouped =
            prev &&
            prev.author_id === m.author_id &&
            new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
          const mine = m.author_id === userId;
          return (
            <article key={m.id} className={`message ${grouped ? "grouped" : ""}`}>
              {!grouped && <Avatar profile={author} size={32} />}
              <div className="message-body">
                {!grouped && (
                  <header>
                    <strong>{author.display_name}</strong>
                    <small>{time(m.created_at)}</small>
                  </header>
                )}
                {m.deleted_at ? (
                  <p className="deleted">{t.messageDeleted}</p>
                ) : editing === m.id ? (
                  <textarea
                    autoFocus
                    value={editText}
                    maxLength={2000}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => void saveEdit(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void saveEdit(m);
                      }
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  m.body && (
                    <p className="text">
                      {m.body}
                      {m.edited_at && <small> ({t.edited})</small>}
                    </p>
                  )
                )}
                {!m.deleted_at && m.attachments.length > 0 && (
                  <div className="attachments">
                    {m.attachments.map((a) => (
                      <button type="button" key={a.id} className="thumb" onClick={() => setViewer(a)}>
                        <img
                          src={signed.get(a.thumb_path ?? a.path)?.url}
                          alt=""
                          width={a.width}
                          height={a.height}
                          loading="lazy"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!m.deleted_at && (mine || isOwner) && editing !== m.id && (
                <div className="message-actions">
                  {mine && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setEditing(m.id);
                        setEditText(m.body);
                      }}
                    >
                      {t.edit}
                    </button>
                  )}
                  <button type="button" className="link" onClick={() => void remove(m)}>
                    {t.delete}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span>{f.name || t.image}</span>
              <button type="button" className="link" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button type="button" onClick={() => fileInput.current?.click()} title={t.attachImage} disabled={sending}>
          +
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files ?? []);
            e.target.value = "";
          }}
        />
        <textarea
          value={text}
          rows={1}
          maxLength={2000}
          placeholder={t.messagePlaceholder.replace("{room}", roomName)}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => addFiles(e.clipboardData.files)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="primary" disabled={sending || (!text.trim() && files.length === 0)}>
          {sending ? "…" : t.send}
        </button>
      </form>

      {viewer && (
        <div className="viewer" role="dialog" onClick={() => setViewer(null)}>
          <img src={signed.get(viewer.path)?.url} alt="" />
        </div>
      )}
    </section>
  );
}
