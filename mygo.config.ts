import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "Mile Console",
  identifier: "com.example.mileconsole",
  version: "1.0.0",
  // 原版 resources/icon.png（S32 复制为 mile-icon.png）；不写时 mygo 默认取模板自带的 resources/icon.png
  icon: "resources/mile-icon.png",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
});
