import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DiagnosticClient {
  version: string | null;
  revision: string | null;
}

export function getClientMetadata(root = new URL("../../", import.meta.url)): DiagnosticClient {
  let version: string | null = null;
  let revision: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch { /* Metadata must never prevent a diagnostics report. */ }
  // Do not attribute an installed package to an unrelated ancestor repository
  // or to the caller's working directory. A worktree's .git file also qualifies.
  if (existsSync(new URL(".git", root))) {
    try {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fileURLToPath(root), encoding: "utf8", timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      }).trim();
      if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) revision = sha;
    } catch { /* Git may be absent, inaccessible or have no commit. */ }
  }
  return { version, revision };
}
