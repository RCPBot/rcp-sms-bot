import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const _dir = typeof __dirname !== "undefined"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(_dir, "client", "src"),
      "@shared": path.join(_dir, "shared"),
      "@assets": path.join(_dir, "attached_assets"),
    },
  },
  root: path.join(_dir, "client"),
  base: "./",
  build: {
    outDir: path.join(_dir, "dist", "public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
