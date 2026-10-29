import { defineConfig } from "vite";
import collisionPlugin from "./tools/collision-plugin.js";

export default defineConfig({
  // POST /api/collision: generate a collision mesh with splat-transform (dev/preview only).
  plugins: [collisionPlugin()],
  // Spark ships inline workers + wasm; pre-bundling can break them.
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  build: { target: "es2022" },
  // Listen on all interfaces so other devices on the LAN can connect.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
