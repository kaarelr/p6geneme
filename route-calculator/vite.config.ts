import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function tsxCliPath(): string {
  const req = createRequire(join(__dirname, "package.json"));
  const pkgDir = dirname(req.resolve("tsx/package.json"));
  return join(pkgDir, "dist/cli.mjs");
}

function runGraphBuild(
  groundSpeedsKmh?: Record<number, number>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tsxCli = tsxCliPath();
  const script = join(__dirname, "scripts/build-graph.ts");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (groundSpeedsKmh !== undefined && Object.keys(groundSpeedsKmh).length > 0) {
    env.GROUND_SPEEDS_KMH = JSON.stringify(groundSpeedsKmh);
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

function runRouteCompute(
  timeBudgetS?: number,
  startLon?: number,
  startLat?: number,
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
  if (startLon !== undefined && Number.isFinite(startLon)) {
    env.START_LON = String(startLon);
  }
  if (startLat !== undefined && Number.isFinite(startLat)) {
    env.START_LAT = String(startLat);
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
  /** GitHub project site: kaarelr.github.io/p6geneme/route-calculator/ */
  base: process.env.CI === "true" ? "/p6geneme/route-calculator/" : "/",
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
          const full = req.url ?? "";
          const qMark = full.indexOf("?");
          const pathname = qMark === -1 ? full : full.slice(0, qMark);

          if (pathname === "/api/rebuild-graph") {
            const ct = req.headers["content-type"] ?? "";
            let groundSpeedsKmh: Record<number, number> | undefined;
            let timeBudgetS: number | undefined;
            let startLon: number | undefined;
            let startLat: number | undefined;
            if (ct.includes("application/json")) {
              try {
                const raw = await readRequestBody(req);
                if (raw) {
                  const j = JSON.parse(raw) as {
                    groundSpeedsKmh?: unknown;
                    timeBudgetS?: unknown;
                    startLon?: unknown;
                    startLat?: unknown;
                  };
                  if (
                    j.groundSpeedsKmh !== undefined &&
                    j.groundSpeedsKmh !== null &&
                    typeof j.groundSpeedsKmh === "object" &&
                    !Array.isArray(j.groundSpeedsKmh)
                  ) {
                    const out: Record<number, number> = {};
                    for (const [k, v] of Object.entries(
                      j.groundSpeedsKmh as Record<string, unknown>,
                    )) {
                      const nk = Number(k);
                      const nv =
                        typeof v === "number" ? v : Number(v);
                      if (Number.isFinite(nk) && Number.isFinite(nv)) {
                        out[nk] = nv;
                      }
                    }
                    if (Object.keys(out).length > 0) groundSpeedsKmh = out;
                  }
                  if (j.timeBudgetS !== undefined && j.timeBudgetS !== null) {
                    const n = Number(j.timeBudgetS);
                    if (Number.isFinite(n) && n >= 60) timeBudgetS = n;
                  }
                  if (j.startLon !== undefined && j.startLon !== null) {
                    const n = Number(j.startLon);
                    if (Number.isFinite(n)) startLon = n;
                  }
                  if (j.startLat !== undefined && j.startLat !== null) {
                    const n = Number(j.startLat);
                    if (Number.isFinite(n)) startLat = n;
                  }
                }
              } catch {
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: "Vigane JSON" }));
                return;
              }
            }

            const buildResult = await runGraphBuild(groundSpeedsKmh);
            if (!buildResult.ok) {
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: buildResult.error }));
              return;
            }
            const routeResult = await runRouteCompute(
              timeBudgetS,
              startLon,
              startLat,
            );
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            if (routeResult.ok) {
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: routeResult.error }));
            }
            return;
          }

          if (pathname !== "/api/recompute-route") {
            next();
            return;
          }

          let timeBudgetS: number | undefined;
          let startLon: number | undefined;
          let startLat: number | undefined;
          const qs = qMark === -1 ? "" : full.slice(qMark + 1);
          const fromQuery = new URLSearchParams(qs).get("timeBudgetS");
          if (fromQuery !== null && fromQuery !== "") {
            const n = Number.parseFloat(fromQuery);
            if (Number.isFinite(n) && n >= 60) timeBudgetS = n;
          }

          const ct = req.headers["content-type"] ?? "";
          if (ct.includes("application/json")) {
            try {
              const raw = await readRequestBody(req);
              if (raw) {
                const j = JSON.parse(raw) as {
                  timeBudgetS?: unknown;
                  startLon?: unknown;
                  startLat?: unknown;
                };
                if (j.timeBudgetS !== undefined && j.timeBudgetS !== null) {
                  const n = Number(j.timeBudgetS);
                  if (Number.isFinite(n) && n >= 60) timeBudgetS = n;
                }
                if (j.startLon !== undefined && j.startLon !== null) {
                  const n = Number(j.startLon);
                  if (Number.isFinite(n)) startLon = n;
                }
                if (j.startLat !== undefined && j.startLat !== null) {
                  const n = Number(j.startLat);
                  if (Number.isFinite(n)) startLat = n;
                }
              }
            } catch {
              /* ignore bad JSON */
            }
          }

          const result = await runRouteCompute(timeBudgetS, startLon, startLat);
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
