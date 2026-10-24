import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and does not need Vite to clear the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    // WebView2 on Windows is evergreen Chromium.
    target: "chrome110",
    sourcemap: false,
    // livekit-client is most of the bundle; it is loaded from disk, not the network.
    chunkSizeWarningLimit: 1000,
  },
});
