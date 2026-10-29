import { spawn } from "node:child_process";
import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

try {
  await access(path.join(standalone, "server.js"));
} catch {
  console.error("No standalone build found. Run `npm run build` first.");
  process.exit(1);
}

// `output: "standalone"` does not copy static assets; do it here so `npm start`
// behaves like a normal production server outside Docker.
await mkdir(path.join(standalone, ".next"), { recursive: true });
await cp(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
});
try {
  await cp(path.join(root, "public"), path.join(standalone, "public"), {
    recursive: true,
  });
} catch {
  // No public directory; nothing to copy.
}

const child = spawn(process.execPath, [path.join(standalone, "server.js")], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
