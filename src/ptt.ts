import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Push-to-talk needs the Windows app: a browser tab cannot see keys pressed in a game. */
export const pttAvailable = "__TAURI_INTERNALS__" in window;

/** 0 turns push-to-talk off and removes the keyboard and mouse hooks. */
export function setPttKey(vk: number) {
  if (pttAvailable) void invoke("set_ptt_key", { vk });
}

/** Resolves with the next key or extra mouse button pressed anywhere; 0 when Escape cancels. */
export async function capturePttKey(): Promise<number> {
  let resolve: (vk: number) => void = () => {};
  const picked = new Promise<number>((r) => (resolve = r));
  const stop = await listen<{ vk: number }>("ptt-captured", (e) => resolve(e.payload.vk));
  try {
    await invoke("capture_ptt_key");
    return await picked;
  } finally {
    stop();
  }
}

export function onPtt(handler: (down: boolean) => void) {
  return listen<boolean>("ptt", (e) => handler(e.payload));
}

const MOUSE_BUTTONS: Record<number, number> = { 4: 3, 5: 4, 6: 5 };

/** Name of a key as Windows prints it in the current keyboard layout, e.g. "Caps Lock". */
export async function keyName(vk: number, mouseLabel: string): Promise<string> {
  if (MOUSE_BUTTONS[vk]) return `${mouseLabel} ${MOUSE_BUTTONS[vk]}`;
  const name = pttAvailable ? await invoke<string>("key_name", { vk }) : "";
  return name || `0x${vk.toString(16).toUpperCase()}`;
}
