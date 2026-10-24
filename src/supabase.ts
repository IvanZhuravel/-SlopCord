import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

// Both values are public by design (the anon key only works through the
// Row Level Security rules in supabase/migrations). Set at build time.
const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** null until the build knows which Supabase project to use; the app then runs as the stage 0 prototype. */
export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;

export type Profile = {
  id: string;
  display_name: string;
  avatar_path: string | null;
  locale: "uk" | "en";
};

/** Current sign-in; `undefined` while the saved session is still being read. */
export function useSession() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

export function useProfile(userId: string | undefined) {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (!supabase || !userId) {
      setProfile(null);
      return;
    }
    let live = true;
    supabase
      .from("profiles")
      .select("id, display_name, avatar_path, locale")
      .eq("id", userId)
      .single()
      .then(({ data }) => live && setProfile(data as Profile | null));
    return () => {
      live = false;
    };
  }, [userId]);
  return [profile, setProfile] as const;
}

export function avatarUrl(path: string | null): string | null {
  if (!supabase || !path) return null;
  return supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}

/** Square-crops and shrinks a picture to a 256 px WebP (about 20 KB) before upload. */
async function toAvatarWebp(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d")!.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    256,
    256,
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/webp", 0.85),
  );
}

export async function uploadAvatar(userId: string, file: File, previous: string | null): Promise<string> {
  if (!supabase) throw new Error("not configured");
  const blob = await toAvatarWebp(file);
  // A new file name each time, so friends do not keep seeing the cached old picture.
  const path = `${userId}/${Date.now()}.webp`;
  const { error } = await supabase.storage.from("avatars").upload(path, blob, { contentType: "image/webp" });
  if (error) throw error;
  const { error: updateError } = await supabase.from("profiles").update({ avatar_path: path }).eq("id", userId);
  if (updateError) throw updateError;
  if (previous) await supabase.storage.from("avatars").remove([previous]);
  return path;
}
