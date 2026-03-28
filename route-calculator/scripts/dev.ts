import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function viteBin(): string {
  return join(root, "node_modules/.bin/vite");
}

function tsxCli(): string {
  const req = createRequire(join(root, "package.json"));
  const pkgDir = dirname(req.resolve("tsx/package.json"));
  return join(pkgDir, "dist/cli.mjs");
}

const children: ChildProcess[] = [];

function cleanup() {
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

const server = spawn(
  process.execPath,
  [tsxCli(), "--watch", join(root, "src/server/index.ts")],
  { cwd: root, stdio: "inherit", env: { ...process.env } },
);
children.push(server);

const vite = spawn(process.execPath, [viteBin()], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
});
children.push(vite);

function onExit(name: string) {
  return (code: number | null) => {
    console.log(`[dev] ${name} exited (code ${code})`);
    cleanup();
    process.exit(code ?? 1);
  };
}

server.on("close", onExit("server"));
vite.on("close", onExit("vite"));
