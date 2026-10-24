import { useRef, useState } from "react";
import type { Strings } from "./i18n";
import { avatarUrl, supabase, uploadAvatar, type Profile } from "./supabase";

type Mode = "signIn" | "signUp";

function authError(t: Strings, message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return t.errorBadLogin;
  if (m.includes("already registered")) return t.errorEmailTaken;
  if (m.includes("password")) return t.errorWeakPassword;
  if (m.includes("rate limit")) return t.errorTooMany;
  return t.errorNetwork;
}

export function AuthScreen({ t, lang }: { t: Strings; lang: "uk" | "en" }) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!supabase) return;
    const name = displayName.trim();
    if (!email.trim() || password.length < 8 || (mode === "signUp" && name.length < 2)) {
      setError(mode === "signUp" ? t.signUpRules : t.fillAll);
      return;
    }
    setBusy(true);
    setError("");
    const { error: e } =
      mode === "signIn"
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: { data: { display_name: name, locale: lang } },
          });
    setBusy(false);
    // On success the session listener in App switches the screen.
    if (e) setError(authError(t, e.message));
  };

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="tabs">
        <button type="button" className={mode === "signIn" ? "active" : ""} onClick={() => setMode("signIn")}>
          {t.signIn}
        </button>
        <button type="button" className={mode === "signUp" ? "active" : ""} onClick={() => setMode("signUp")}>
          {t.signUp}
        </button>
      </div>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <label>
        {t.password}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signIn" ? "current-password" : "new-password"}
        />
        {mode === "signUp" && <small>{t.passwordHint}</small>}
      </label>
      {mode === "signUp" && (
        <label>
          {t.yourName}
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? t.wait : mode === "signIn" ? t.signIn : t.signUp}
      </button>
    </form>
  );
}

export function Avatar({ profile, size = 32 }: { profile: Pick<Profile, "display_name" | "avatar_path">; size?: number }) {
  const src = avatarUrl(profile.avatar_path);
  return src ? (
    <img className="avatar" src={src} alt="" width={size} height={size} />
  ) : (
    <span className="avatar" style={{ width: size, height: size }}>
      {profile.display_name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ProfileCard({
  t,
  profile,
  onChange,
}: {
  t: Strings;
  profile: Profile;
  onChange: (p: Profile) => void;
}) {
  const [name, setName] = useState(profile.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!supabase || trimmed === profile.display_name) return;
    if (trimmed.length < 2) {
      setError(t.nameRules);
      return;
    }
    setBusy(true);
    const { error: e } = await supabase.from("profiles").update({ display_name: trimmed }).eq("id", profile.id);
    setBusy(false);
    if (e) setError(t.errorNetwork);
    else {
      setError("");
      onChange({ ...profile, display_name: trimmed });
    }
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const path = await uploadAvatar(profile.id, file, profile.avatar_path);
      setError("");
      onChange({ ...profile, avatar_path: path });
    } catch {
      setError(t.errorAvatar);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <section className="card">
      <h2>{t.profile}</h2>
      <div className="profile-row">
        <button type="button" className="avatar-button" onClick={() => fileInput.current?.click()} disabled={busy} title={t.changeAvatar}>
          <Avatar profile={profile} size={48} />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => void pickAvatar(e.target.files?.[0])}
        />
        <label className="grow">
          {t.yourName}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => e.key === "Enter" && void saveName()}
            maxLength={32}
            disabled={busy}
          />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <button type="button" onClick={() => void supabase?.auth.signOut()}>
        {t.signOut}
      </button>
    </section>
  );
}
