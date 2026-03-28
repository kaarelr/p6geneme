import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_PORT = process.env.API_PORT ?? "3000";

export default defineConfig({
  root: __dirname,
  /** GitHub project site: kaarelr.github.io/p6geneme/route-calculator/ */
  base: process.env.CI === "true" ? "/p6geneme/route-calculator/" : "/",
  publicDir: "public",
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${API_PORT}`,
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
