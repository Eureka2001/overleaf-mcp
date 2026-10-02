// Plaintext cookie persistence keyed by Overleaf host.
//
// Stores a single JSON map at <configDir>/overleaf-mcp/cookie.json with mode
// 0600. Multi-host so the same machine can hold credentials for overleaf.com
// and a self-hosted CE side-by-side. No encryption — see README.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../util/logger.js";

export interface StoredCookie {
  cookie: string;
  savedAt: number;
}

interface StoreShape {
  hosts: Record<string, StoredCookie>;
}

function configRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export function cookieFilePath(): string {
  return path.join(configRoot(), "overleaf-mcp", "cookie.json");
}

function hostKey(baseUrl: string): string {
  return new URL(baseUrl).host;
}

async function readStore(strict = false): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(cookieFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return { hosts: parsed.hosts ?? {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { hosts: {} };
    if (strict) throw new Error(`Stored session unreadable (${(err as NodeJS.ErrnoException)?.code ?? "invalid JSON"})`);
    logger.warn(`cookie store unreadable, treating as empty: ${(err as Error).message}`);
    return { hosts: {} };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const file = cookieFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export async function loadStored(baseUrl: string, strict = false): Promise<StoredCookie | null> {
  const store = await readStore(strict);
  const stored = store.hosts?.[hostKey(baseUrl)] ?? null;
  if (strict && stored && (typeof stored.cookie !== "string" || !Number.isFinite(stored.savedAt))) {
    throw new Error("Stored session has an invalid cookie/savedAt shape");
  }
  return stored;
}

export async function saveStored(baseUrl: string, cookie: string): Promise<void> {
  const store = await readStore();
  store.hosts[hostKey(baseUrl)] = { cookie, savedAt: Date.now() };
  await writeStore(store);
}

export async function clearStored(baseUrl: string): Promise<boolean> {
  const store = await readStore();
  const key = hostKey(baseUrl);
  if (!(key in store.hosts)) return false;
  delete store.hosts[key];
  await writeStore(store);
  return true;
}
