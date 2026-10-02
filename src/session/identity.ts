import { loadConfig, type Config } from "../config.js";
import { OverleafAuthError } from "../api/errors.js";
import { logger } from "../util/logger.js";
import { discoverCookie } from "../auth/discover.js";

export interface Identity {
  baseUrl: string;
  cookie: string;
  csrf: string;
  userId: string;
  userEmail: string;
}

let cached: Identity | null = null;
let pending: Promise<Identity> | null = null;

export function extractMeta(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`);
  return html.match(re)?.[1];
}

export async function validateCookie(cookie: string, config: Config = loadConfig()): Promise<Identity> {
  return resolveIdentity(cookie, config);
}

async function resolveIdentity(cookie: string, config: Config): Promise<Identity> {
  const url = `${config.baseUrl}/project`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { Cookie: cookie, Connection: "keep-alive" },
  });
  if (res.status === 301 || res.status === 302) {
    const location = res.headers.get("location") ?? "";
    throw new OverleafAuthError(
      `Session cookie rejected (redirected to ${location || "login"}). ` +
        "The cookie is likely expired — run `overleaf-mcp login` to refresh.",
    );
  }
  if (!res.ok) {
    throw new OverleafAuthError(`GET /project returned HTTP ${res.status}`);
  }
  const html = await res.text();
  const userId = extractMeta(html, "ol-user_id");
  const userEmail = extractMeta(html, "ol-usersEmail") ?? "";
  const csrf = config.csrfOverride ?? extractMeta(html, "ol-csrfToken");
  if (!userId) {
    throw new OverleafAuthError(
      "Could not find ol-user_id meta tag on /project page. " +
        "The cookie may be invalid or this is an unsupported Overleaf version.",
    );
  }
  if (!csrf) {
    throw new OverleafAuthError(
      "Could not find ol-csrfToken meta tag and OL_CSRF was not set. " +
        "Pass OL_CSRF as a fallback or check that your Overleaf server emits the meta tag.",
    );
  }
  logger.info(`authenticated as ${userEmail || userId}`);
  return { baseUrl: config.baseUrl, cookie, csrf, userId, userEmail };
}

export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  if (pending) return pending;
  const config = loadConfig();
  pending = (async () => {
    const cookie = await discoverCookie(config.baseUrl);
    return resolveIdentity(cookie, config);
  })()
    .then((id) => {
      cached = id;
      return id;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function clearIdentity(): void {
  cached = null;
}
