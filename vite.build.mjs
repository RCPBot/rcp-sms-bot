// Plain JS build config for Railway — no TypeScript, no import.meta
import { build } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(__dirname, "client", "src"),
      "@shared": path.join(__dirname, "shared"),
      "@assets": path.join(__dirname, "attached_assets"),
    },
  },
  root: path.join(__dirname, "client"),
  base: "./",
  build: {
    outDir: path.join(__dirname, "dist", "public"),
    emptyOutDir: true,
  },
});

console.log("Client build complete.");
