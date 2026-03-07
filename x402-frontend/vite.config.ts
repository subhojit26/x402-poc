import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverUrl = env.VITE_SERVER_URL || "http://localhost:4021";

  return {
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
          target: serverUrl,
          changeOrigin: true,
        },
        "/health": {
          target: serverUrl,
          changeOrigin: true,
        },
        "/config": {
          target: serverUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
