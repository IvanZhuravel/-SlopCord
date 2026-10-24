//! Push-to-talk through low-level keyboard and mouse hooks.
//!
//! RegisterHotKey would take the key away from the game, so instead we only
//! watch input and always pass it on. The hook callback does as little as
//! possible: Windows drops hooks that answer slowly, and every key press in
//! every app goes through it. Hooks are only installed while needed (in a call
//! with push-to-talk on, or while picking a key), and the mouse hook only for a
//! mouse button, so games get every mouse move without a detour through us.

#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// Virtual-key code of the push-to-talk key; 0 means push-to-talk is off.
/// Mouse buttons use their virtual-key codes too: 4 middle, 5 and 6 side buttons.
static PTT_VK: AtomicU32 = AtomicU32::new(0);
static PRESSED: AtomicBool = AtomicBool::new(false);
static CAPTURING: AtomicBool = AtomicBool::new(false);
static EVENTS: OnceLock<Sender<Event>> = OnceLock::new();

const VK_ESCAPE: u32 = 0x1B;

enum Event {
    Ptt(bool),
    Captured(u32),
}

#[derive(Clone, Serialize)]
struct Captured {
    vk: u32,
}

/// Called from the hook thread for every key or extra mouse button change.
fn on_input(vk: u32, down: bool) {
    let Some(events) = EVENTS.get() else { return };
    if CAPTURING.load(Ordering::Relaxed) {
        if down {
            CAPTURING.store(false, Ordering::Relaxed);
            // Escape cancels picking a key.
            let vk = if vk == VK_ESCAPE { 0 } else { vk };
            let _ = events.send(Event::Captured(vk));
            platform::refresh();
        }
        return;
    }
    if vk != 0
        && vk == PTT_VK.load(Ordering::Relaxed)
        && PRESSED.swap(down, Ordering::Relaxed) != down
    {
        // Key repeat sends many "down"s; only changes reach the app.
        let _ = events.send(Event::Ptt(down));
    }
}

/// Starts the hook thread and the thread that forwards its events to the window.
pub fn start(app: AppHandle) {
    let (tx, rx) = channel();
    if EVENTS.set(tx).is_err() {
        return;
    }
    std::thread::spawn(move || {
        for event in rx {
            let _ = match event {
                Event::Ptt(down) => app.emit("ptt", down),
                Event::Captured(vk) => app.emit("ptt-captured", Captured { vk }),
            };
        }
    });
    platform::install();
}

#[tauri::command]
pub fn set_ptt_key(vk: u32) {
    PTT_VK.store(vk, Ordering::Relaxed);
    PRESSED.store(false, Ordering::Relaxed);
    platform::refresh();
}

/// The next key or extra mouse button pressed anywhere is sent back as `ptt-captured`.
#[tauri::command]
pub fn capture_ptt_key() {
    CAPTURING.store(true, Ordering::Relaxed);
    platform::refresh();
}

fn is_mouse(vk: u32) -> bool {
    (0x04..=0x06).contains(&vk)
}

/// Which hooks are needed right now: (keyboard, mouse).
fn wanted_hooks() -> (bool, bool) {
    let vk = PTT_VK.load(Ordering::Relaxed);
    let capturing = CAPTURING.load(Ordering::Relaxed);
    (
        capturing || (vk != 0 && !is_mouse(vk)),
        capturing || is_mouse(vk),
    )
}

#[tauri::command]
pub fn key_name(vk: u32) -> String {
    platform::key_name(vk)
}

#[cfg(windows)]
mod platform {
    use super::{on_input, wanted_hooks};
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyNameTextW, MapVirtualKeyW, MAPVK_VK_TO_VSC,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    const VK_MBUTTON: u32 = 0x04;
    const VK_XBUTTON1: u32 = 0x05;

    unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            match wparam as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => on_input(info.vkCode, true),
                WM_KEYUP | WM_SYSKEYUP => on_input(info.vkCode, false),
                _ => {}
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            // High word of mouseData says which side button: 1 or 2.
            let side = VK_XBUTTON1 + ((info.mouseData >> 16) & 0xFFFF).saturating_sub(1);
            match wparam as u32 {
                WM_MBUTTONDOWN => on_input(VK_MBUTTON, true),
                WM_MBUTTONUP => on_input(VK_MBUTTON, false),
                WM_XBUTTONDOWN => on_input(side, true),
                WM_XBUTTONUP => on_input(side, false),
                _ => {}
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    static THREAD: AtomicU32 = AtomicU32::new(0);

    pub fn install() {
        // Low-level hooks are called on the thread that installed them, which must pump messages.
        std::thread::spawn(|| unsafe {
            THREAD.store(GetCurrentThreadId(), Ordering::Relaxed);
            let mut kb: HHOOK = std::ptr::null_mut();
            let mut ms: HHOOK = std::ptr::null_mut();
            let mut msg: MSG = std::mem::zeroed();
            loop {
                let (want_kb, want_ms) = wanted_hooks();
                if want_kb && kb.is_null() {
                    kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
                } else if !want_kb && !kb.is_null() {
                    UnhookWindowsHookEx(kb);
                    kb = std::ptr::null_mut();
                }
                if want_ms && ms.is_null() {
                    ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), std::ptr::null_mut(), 0);
                } else if !want_ms && !ms.is_null() {
                    UnhookWindowsHookEx(ms);
                    ms = std::ptr::null_mut();
                }
                // Hook callbacks run inside GetMessageW; WM_APP from `refresh` wakes the loop to re-check.
                if GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) <= 0 {
                    break;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }

    pub fn refresh() {
        let thread = THREAD.load(Ordering::Relaxed);
        if thread != 0 {
            unsafe { PostThreadMessageW(thread, WM_APP, 0, 0) };
        }
    }

    pub fn key_name(vk: u32) -> String {
        // Keys that share a scan code with the number pad need the "extended" bit to get their own name.
        const EXTENDED: &[u32] = &[
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x6F, 0x90, 0xA3, 0xA5,
            0x5B, 0x5C, 0x5D,
        ];
        unsafe {
            let scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
            if scan == 0 {
                return String::new();
            }
            let mut lparam = (scan as i32) << 16;
            if EXTENDED.contains(&vk) {
                lparam |= 1 << 24;
            }
            let mut buf = [0u16; 64];
            let len = GetKeyNameTextW(lparam, buf.as_mut_ptr(), buf.len() as i32);
            String::from_utf16_lossy(&buf[..len.max(0) as usize])
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn install() {}

    pub fn refresh() {}

    pub fn key_name(_vk: u32) -> String {
        String::new()
    }
}
