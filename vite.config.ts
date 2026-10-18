import { defineConfig, type Plugin } from "vite";
import { build as esbuild, type BuildOptions } from "esbuild";
import { handleProxyRequest, attachWebSocketProxy } from "./server/proxy.js";

// The shim and service worker are classic (non-module) scripts with fixed URLs,
// so they are bundled with esbuild instead of going through Vite's module graph.
const extraBundles: Record<string, BuildOptions> = {
  "/o4w/shim.js": { entryPoints: ["src/shim/index.ts"], format: "iife", target: "es2022" },
  "/o4w/shim.css": { entryPoints: ["src/shim/shim.css"] },
  "/sw.js": { entryPoints: ["src/sw/sw.ts"], format: "iife", target: "es2022" },
};

async function bundle(url: string, minify: boolean): Promise<string> {
  const r = await esbuild({
    ...extraBundles[url],
    bundle: true,
    write: false,
    minify,
    sourcemap: minify ? false : "inline",
    define: { global: "globalThis" },
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

function o4w(): Plugin {
  return {
    name: "obsidian4web",
    configureServer(server) {
      if (server.httpServer) attachWebSocketProxy(server.httpServer);
      server.middlewares.use(async (req, res, next) => {
        try {
          if (await handleProxyRequest(req, res)) return;
          const path = (req.url ?? "").split("?")[0];
          if (path in extraBundles) {
            const code = await bundle(path, false);
            res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
            res.setHeader("Cache-Control", "no-cache");
            res.end(code);
            return;
          }
        } catch (e) {
          console.error(e);
          res.statusCode = 500;
          res.end(String(e));
          return;
        }
        next();
      });
    },
    async generateBundle() {
      for (const url of Object.keys(extraBundles)) {
        this.emitFile({ type: "asset", fileName: url.slice(1), source: await bundle(url, true) });
      }
    },
  };
}

export default defineConfig({
  plugins: [o4w()],
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
