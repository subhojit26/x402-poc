import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // Buffer is the main one needed by siwe / @x402/evm
      include: ["buffer", "crypto", "process", "util", "stream", "events"],
      globals: { Buffer: true, process: true },
    }),
  ],
  server: {
    port: 5173,
  },
});
