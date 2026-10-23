// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [tailwindcss(), solidPlugin()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: { input: fileURLToPath(new URL("./cloud-conversation.html", import.meta.url)) },
  },
})
