import { getIdentity, type Identity } from "../session/identity.js";
import { withAuthRetry } from "../session/recovery.js";
import { OverleafApiError, OverleafAuthError } from "./errors.js";

function joinUrl(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function throwIfAuthBad(res: Response, forbiddenIsPermission = false): void {
  if (res.status === 401 || (res.status === 403 && !forbiddenIsPermission)) {
    throw new OverleafAuthError(forbiddenIsPermission ? `HTTP ${res.status} on history request` : `HTTP ${res.status} on ${res.url || "request"}`);
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    if (/\/login(\?|$|\/)/i.test(loc)) {
      throw new OverleafAuthError(forbiddenIsPermission ? "History request redirected to login — session expired" : `redirected to ${loc} — session expired`);
    }
  }
}

// An explicit identity bypasses browser recovery and cookie eviction. The
// caller owns cancellation; ordinary MCP calls retain their recovery behavior.
export interface HttpContext {
  identity: Identity;
  signal?: AbortSignal;
  // Resource permissions are not evidence of session expiry after identity
  // validation. Opt in for history; retain existing callers' auth behavior.
  forbiddenIsPermission?: boolean;
}

async function withIdentity<T>(context: HttpContext | undefined, fn: (identity: Identity) => Promise<T>): Promise<T> {
  if (context) return fn(context.identity);
  return withAuthRetry(async () => fn(await getIdentity()));
}

export async function olGet(path: string, extraHeaders: Record<string, string> = {}, context?: HttpContext): Promise<Response> {
  return withIdentity(context, async (id) => {
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "GET",
      redirect: "manual",
      signal: context?.signal,
      headers: { Cookie: id.cookie, Connection: "keep-alive", ...extraHeaders },
    });
    throwIfAuthBad(res, context?.forbiddenIsPermission);
    return res;
  });
}

export async function olPostJson(
  path: string,
  body: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  context?: HttpContext,
): Promise<Response> {
  return withIdentity(context, async (id) => {
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "POST",
      redirect: "manual",
      signal: context?.signal,
      headers: {
        Cookie: id.cookie,
        Connection: "keep-alive",
        "Content-Type": "application/json",
        "X-Csrf-Token": id.csrf,
        ...extraHeaders,
      },
      body: JSON.stringify({ _csrf: id.csrf, ...body }),
    });
    throwIfAuthBad(res);
    return res;
  });
}

export async function olOptions(path: string, context: HttpContext): Promise<Response> {
  const res = await fetch(joinUrl(context.identity.baseUrl, path), {
    method: "OPTIONS", redirect: "manual", signal: context.signal,
    headers: { Cookie: context.identity.cookie },
  });
  throwIfAuthBad(res);
  return res;
}

export async function olDelete(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return withAuthRetry(async () => {
    const id = await getIdentity();
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "DELETE",
      redirect: "manual",
      headers: {
        Cookie: id.cookie,
        Connection: "keep-alive",
        "X-Csrf-Token": id.csrf,
        ...extraHeaders,
      },
    });
    throwIfAuthBad(res);
    return res;
  });
}

// Let fetch generate the multipart boundary. FormData/Blob can be replayed
// after an authentication refresh without reading the local file again.
export async function olPostMultipart(path: string, form: FormData): Promise<Response> {
  return withAuthRetry(async () => {
    const id = await getIdentity();
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: id.cookie, Connection: "keep-alive", "X-Csrf-Token": id.csrf },
      body: form,
    });
    throwIfAuthBad(res);
    return res;
  });
}

export async function expectOk(res: Response, hint?: string): Promise<Response> {
  if (res.ok) return res;
  // Defensive: primitives above already throw on auth-bad responses, but a
  // caller that constructed its own fetch (or bypassed throwIfAuthBad) still
  // benefits from the same classification here.
  throwIfAuthBad(res);
  const body = await res.text().catch(() => "");
  throw new OverleafApiError(res.status, body, hint);
}

export async function asJson<T = unknown>(res: Response, hint?: string): Promise<T> {
  await expectOk(res, hint);
  return (await res.json()) as T;
}
