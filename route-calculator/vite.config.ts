import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function tsxCliPath(): string {
  const req = createRequire(join(__dirname, "package.json"));
  const pkgDir = dirname(req.resolve("tsx/package.json"));
  return join(pkgDir, "dist/cli.mjs");
}

function runRouteCompute(
  timeBudgetS?: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tsxCli = tsxCliPath();
  const script = join(__dirname, "scripts/compute-route.ts");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (
    timeBudgetS !== undefined &&
    Number.isFinite(timeBudgetS) &&
    timeBudgetS >= 60
  ) {
    env.TIME_BUDGET_S = String(Math.floor(timeBudgetS));
  }
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, script], {
      cwd: __dirname,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    child.on("error", (err) => {
      resolvePromise({ ok: false, error: String(err.message) });
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ ok: true });
      else
        resolvePromise({
          ok: false,
          error: stderr.trim().slice(-4000) || `Protsess lõppes koodiga ${code}`,
        });
    });
  });
}

export default defineConfig({
  root: __dirname,
  publicDir: "public",
  server: {
    port: 5173,
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
  plugins: [
    {
      name: "recompute-route-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== "POST") {
            next();
            return;
          }
          const host = req.headers.host ?? "localhost";
          let pathname: string;
          let searchParams: URLSearchParams;
          try {
            const u = new URL(req.url ?? "", `http://${host}`);
            pathname = u.pathname;
            searchParams = u.searchParams;
          } catch {
            next();
            return;
          }
          if (pathname !== "/api/recompute-route") {
            next();
            return;
          }
          const tb = searchParams.get("timeBudgetS");
          let timeBudgetS: number | undefined;
          if (tb !== null && tb !== "") {
            const n = Number.parseFloat(tb);
            if (Number.isFinite(n) && n >= 60) timeBudgetS = n;
          }
          const result = await runRouteCompute(timeBudgetS);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          if (result.ok) {
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: result.error }));
          }
        });
      },
    },
  ],
});
