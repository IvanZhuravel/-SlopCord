import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent?: number }
  | { kind: "error"; version?: string };

/**
 * Checks GitHub Releases once at startup and again only when asked:
 * no background polling, so nothing runs while you play.
 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [currentVersion, setCurrentVersion] = useState("");
  const update = useRef<Update | null>(null);

  const runCheck = useCallback(async (manual: boolean) => {
    if (manual) setState({ kind: "checking" });
    try {
      const found = await check();
      update.current = found;
      if (found) setState({ kind: "available", version: found.version });
      else setState(manual ? { kind: "latest" } : { kind: "idle" });
    } catch {
      // Offline or GitHub is down: stay quiet at startup, say so when asked.
      setState(manual ? { kind: "error" } : { kind: "idle" });
    }
  }, []);

  useEffect(() => {
    getVersion().then(setCurrentVersion, () => {});
    void runCheck(false);
  }, [runCheck]);

  const install = useCallback(async () => {
    const found = update.current;
    if (!found) return;
    const version = found.version;
    let total = 0;
    let done = 0;
    setState({ kind: "downloading", version });
    try {
      await found.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress" && total > 0) {
          done += e.data.chunkLength;
          setState({ kind: "downloading", version, percent: Math.min(100, Math.round((done / total) * 100)) });
        }
      });
      // On Windows the installer usually closes the app itself; this covers the rest.
      await relaunch();
    } catch {
      setState({ kind: "error", version });
    }
  }, []);

  return { state, currentVersion, check: () => runCheck(true), install };
}
