import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
    css: true,
    // 高负载 Windows integration tests 在 CI 上偶发超过默认 5s 超时
    // （如 setup-page.test.tsx 的 masked credential 用例）；
    // CI 使用 15s 有界超时，本地保持默认 5s 以快速暴露慢用例。
    testTimeout: process.env.CI ? 15000 : 5000,
  },
});
