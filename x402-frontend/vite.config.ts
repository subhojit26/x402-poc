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
    proxy: {
      // Forward API calls to the x402 server during local development.
      // Set VITE_SERVER_URL in .env.local to override for a remote server.
      "/premium": {
        target: "http://localhost:4021",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:4021",
        changeOrigin: true,
      },
    },
  },
});
