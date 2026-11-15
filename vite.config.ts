import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // 与原版 electron.vite.config.ts 的 renderer 段一致
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    // 原版用 @shared/* 指 src/shared；这里指到同一处，搬过来的 import 不用改
    alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
  },
  server: {
    // The app loads this address during `mygo dev` (devUrl in mygo.json).
    port: 5173,
    strictPort: true,
    // The development app and the packaged builds are not the page's.
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
});
