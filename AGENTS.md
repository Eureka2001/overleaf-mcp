# AGENTS.md

Context for Agents (or any future contributor) working in this repo. Read top to bottom — short.

## What this is

`overleaf-mcp` is an MCP server for Overleaf. It speaks Overleaf's Socket.IO web API (the same channel the official editor uses), **not** the Git bridge. The headline feature: edits land as **tracked changes** in Overleaf's Review panel — every other Overleaf MCP punts to the Git bridge and silently overwrites, which makes them unusable for collaborative academic work.

Tools (24): `ping`, `list_projects`, `open_project`, `list_files`, `read_file`, `search_project`, `list_history`, `list_history_files`, `read_history_file`, `compare_versions`, `upload_file`, `edit_file`, `find_and_replace`, `compile`, `read_log`, `download_pdf`, `list_comments`, `read_comment_thread`, `reply_comment`, `resolve_comment`, `reopen_comment`, `list_tracked_changes`, `accept_changes`, `reject_changes`.

## Architecture you should know about before changing things

- **`src/api/socket.ts` is a hand-rolled Socket.IO 0.9 client** built on `fetch` (handshake) + `ws@8` (upgrade). It is **not** using the published [`socket.io-client@0.9.17-overleaf-5`](https://github.com/overleaf/socket.io-client) fork — that fork accepts `extraHeaders` but silently drops them on both transports (its `xmlhttprequest@1.8.0` dep explicitly forbids the `Cookie` header), so the session cookie never reaches the handshake. This is why every other Overleaf MCP falls back to Git. Don't "fix" this by switching to the fork.

- **`update.meta` may contain `tc` and nothing else.** The real-time service validates the `applyOtUpdate` payload with a zod schema ([`services/real-time/app/js/Router.js`](https://github.com/overleaf/overleaf/blob/main/services/real-time/app/js/Router.js)) and sets `meta.source` / `meta.user_id` / `meta.tsRT` itself from the socket and session. Sending those keys ourselves used to be silently ignored; overleaf.com now rejects the whole update with `Unrecognized keys: "source", "ts", "user_id"` **and disconnects the socket 100 ms later**. The official web client only ever sets `meta.tc` ([`share-js-doc.ts`](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/ide-react/editor/share-js-doc.ts)) — mirror it exactly, and send no `meta` at all when not tracking. Note the OSS mirror lags www here, so `main` looking permissive is not evidence.

- **Tracked changes are triggered server-side by `update.meta.tc`** — a Mongo-ObjectId-style 18-hex-char ID seed on the `applyOtUpdate` payload. Source of truth: [`overleaf/overleaf/libraries/ranges-tracker/index.cjs`](https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs) `generateIdSeed`. Ported verbatim into `src/ot/trackedChanges.ts`. **And** the server independently forces tracking for any user with `track_changes_on_for_me: true` — even if our client sent no `meta.tc`. So `track:"off"` is *not* a guarantee the edit lands untracked; check `ap.trackChangesOnForMe`. `edit_file` / `find_and_replace` already do, and report `tracked: true` in that case via a `serverWillTrack` derived field, plus a `track_overridden` flag when the user's request was overridden.

- **Tracked deletes physically remove text from `docLines`.** Per the ranges-tracker source comment: *"deletes correspond to text which is no longer there"*. The deleted text is preserved in `ranges.changes[].op.d` (which is how the Review panel renders the strikethrough), but the visible doc body shrinks. So `new_content` written to docCache after a tracked edit IS a faithful snapshot of the post-edit server state — no special cache handling is needed, and `read_file` does not need a "deleted text still here" notice. A common misreading is to assume tracked deletes leave the original text in place; they don't.

- **Reject is client-side OT**: there's no `/changes/reject` user-facing HTTP endpoint. To reject, we build the inverse op (`d:` for an insert, `i:` for a delete) with `u: true` and send it via `applyOtUpdate`. Server's RangesTracker recognises `u:true` and clears the matching tracked-change entry. Captured live by intercepting Overleaf's web client.

- **Accept is HTTP**: `POST /project/{id}/doc/{docId}/changes/accept` with `{change_ids}`. Batched per doc in `src/tools/trackedChanges.ts`.

- **`edit_file` defaults to `track: "on"`**. For a research workflow the agent should never silently overwrite — every edit goes through the review panel by default. Pass `track: "off"` to opt out. `find_and_replace` shares the same default and the same OT pathway.

- **Stale-cache safety**: `read_file` pins `docCache` to the exact `(text, version)` it returned. `edit_file` diffs against that baseline, so a stale read causes a clean OT transform (or rejection) instead of silent overwrite. There's a manual test for this in `tests/manual/stale-version.mjs`.

- **`search_project` reads live docs without pinning editing baselines.** Literal Unicode-aware matches preserve one-based UTF-16 offsets; cap returned results while counting all occurrences. Report partial read failures, and keep snippets bounded. `ensureSocketForProject` returns cached structure on an open socket, and current SaaS no longer acknowledges repeated `joinProject` on that socket (verified live). `refreshProjectTree` uses `fetchProjectSnapshot` on a short-lived second socket instead. Keep the persistent connection's joined documents, document baselines and last compile intact.

- **`upload_file` is for assets, never editable text.** Use multipart `POST /Project/{id}/upload?folder_id=...` with `name` and `qqfile`; let fetch set the multipart boundary and send CSRF in the header. Overleaf's upload endpoint can replace a same-name entity: default no-overwrite must stage a unique asset and promote it with conflict-checked `POST /project/{id}/file/{id}/rename`. Check downloaded bytes, refresh structure, and clean up only that upload's own temporary asset on failure. Explicit binary overwrite may change the destination even if a subsequent verification fails; report uncertainty rather than deleting it.

- **Concurrency safeguards (`src/ot/verify.ts`)**: each MCP process has its own in-process `docCache`, so parallel agents (or an open OL web editor) race on `applyOtUpdate` with stale `v`. The server's OT transform usually handles this fine, but it can collapse ops to a no-op while still acking success — the user-reported "find_and_replace returned replacements:1 but the doc is unchanged" bug. Two safeguards: (a) `verifyEdit` runs after every `applyOtUpdate` — re-`joinDocs` and reports `silentNoOp` (server text === pre-edit text → fail loud), `matchesExpected` (perfect, no race), or `hadConcurrentWritesAfter` (op landed but doc moved on → warn in response, don't fail). Cache is always synced to actual server state regardless. (b) `checkBaseline` is invoked when `strict_version: true` is passed — refuses to send if the cached `v` is behind the server. Both add one socket round-trip; for the workflow this MCP targets the cost is negligible compared to silently producing wrong edits.

- **`compile.status === "success"` is misleading** — Overleaf returns it whenever a PDF is generated, even with LaTeX errors (TeX runs in `nonstopmode`). Truthful check is `compile.built_cleanly` (PDF + zero `! `-prefixed log lines). `compile` already fetches `output.log` inline; `read_log` is for deeper inspection.

- **`download_pdf` downloads the last build in the same MCP session**, using the cached `output.pdf` URL plus `clsiserverid` / `compileGroup` through `olGet`. It does not recompile, edit the project, or touch tracked changes. Require an absolute local `.pdf` destination, validate the body signature before writing, and preserve the default exclusive-create behavior (`overwrite: false`). For a different root such as a response letter, call `compile(root_doc: ...)` first. Cached artifacts can expire; recompile in that case.

## Historical source and version comparisons

- `src/api/history.ts` uses only public Web GETs: `/updates`, `/labels`, `/filetree/diff` and `/diff?from=&to=&pathname=`. Same-version tree/text diffs read historical snapshots. The internal project-history `/version/:version/:pathname` route is not a SaaS user endpoint. Read source, never restore/download a PDF to inspect TeX.
- History versions are project-wide fenceposts, **not doc OT versions**. Histories are grouped intervals, not individual keystrokes. `nextBeforeTimestamp` is a version cursor and `min_count` is not a cap: truncate at the last delivered entry's `fromV` and bind cursors to project/mode/fixed versions. Do not drop overflow entries by advancing to the server page's tail.
- History must not call `updateDoc`, replace `ActiveProject.entities`, refresh the live tree, switch sockets or update `lastCompile`. Use historical paths; current `findByPath` cannot locate deleted/renamed historical files. Explicit authentication recovery is the existing session-recovery exception; a valid-session history 403 opts out via `HttpContext.forbiddenIsPermission` and must not trigger recovery.
- Project `features.versioning` controls full-history access. Otherwise confirm recent (24h) or labeled versions before body reads; the latest state remains readable. Unknown entitlement stays `unknown` and is restricted conservatively. HTTP 200 alone does not grant full-history access; the web client also applies its feature gate.
- `compare_versions` without path returns only changed-file metadata. With path it returns bounded line/paragraph hunks, not entire unchanged documents. Preserve `from_path` / `to_path`; native edited/renamed diffs must reconstruct both endpoint snapshots. Added/removed source uses the existing endpoint; binaries return metadata only. Exact text/diff continuations preserve UTF-16 positions without splitting surrogate pairs.
- A too-wide range may fall back to same-path endpoint source: report `snapshot_fallback`, no attribution and unverified file identity; do not invent a cross-range rename or author. Project overview requires narrowing the interval if native identity discovery exceeds the server's chunk limit.
- Every GET and body read is bounded (20s / 8 MiB JSON); source processing is bounded at 2 MiB, with separate output limits. Error bodies/credentials/source do not enter logs. Ordinary GETs may process pending history internally, but the tools never POST flush, restore, modify labels, emit OT, change review data or compile.
- `tests/unit/history.spec.ts` drives the actual HTTP client against a simulated service, covering overflow pagination, labels, permissions, compact diffs, file lifecycle, Unicode continuations, malformed/oversized responses, cancellation and live-cache isolation. `tests/manual/history-read.mjs` uses existing history, checks stdio tool registration and emits metadata only.

## License & contribution

**AGPL-3.0-or-later.** We port from two AGPL projects (overleaf-workshop and overleaf/overleaf — see `LICENSE`). If you add code derived from a different license, check compatibility before merging.

## Auth & running

Cookie capture is via a dedicated headless-ish Chrome profile, driven over the Chrome DevTools Protocol — `node dist/index.js login` opens a window pointing at `<OL_BASE_URL>/project`, user logs in normally (captcha / Google OAuth / ORCID / institutional SSO / 2FA all work because it's a real Chrome), cookie is read via `Network.getCookies` once the dashboard loads, persisted to `<configDir>/overleaf-mcp/cookie.json` (mode 0600). The same flow auto-triggers when a tool call hits a 302→/login or 401/403. Dedicated profile means we never touch the user's real Chrome and never trigger a macOS Keychain prompt for it. `OL_BASE_URL` defaults to `https://www.overleaf.com`; `OL_BROWSER` overrides the Chrome binary path; `OL_INSECURE=1` adds `--ignore-certificate-errors` for self-hosted CE with self-signed certs; `OL_CSRF` is optional (auto-discovered from `/project` HTML's `ol-csrfToken` meta).

## Tests

`tests/manual/*.mjs` are end-to-end smoke + edge-case scripts. They spawn the built `dist/index.js` as a child process and drive it over stdio. None require CI infra; all need a cookie file (run `node dist/index.js login` first). Highlights:

- `smoke.mjs <tool>` — single-tool invocation
- `sequence.mjs <project> [doc]` — open→list→read flow
- `tracked-test.mjs <project> <doc>` — verifies `meta.tc` produces a Review-panel suggestion
- `stale-version.mjs <project> [doc]` — two concurrent MCP clients
- `multiop-edit.mjs <project> [doc]` — confirms diff-match-patch produces multi-op updates
- `compile-fix.mjs <project> [doc]` — compile → error log → fix → recompile loop
- `accept-reject.mjs <project>` — list_tracked_changes → accept 1 → reject 1
- `v1_1-followups.mjs <project>` — verifies root-doc-default + inline error_count
- `download-pdf.mjs <project> <absolute-output.pdf> [root_doc]` — compile/download flow, PDF bytes, preconditions, and default no-overwrite behavior (use a new destination)
- `upload-search.mjs <project> [existing-folder]` — live literal search, returned positions/versions, result caps, PNG upload, collision refusal, explicit overwrite and the server rename-conflict guard. Creates only randomly named unreferenced test assets, verifies bytes, then deletes only those assets by ID/path. Does not edit text or review data.

## Diagnostics and protocol drift

Build with `npm run build`, then `npm run diagnose` or `node dist/diagnose.js`. For machine-readable stdout use `node dist/diagnose.js --json` or `npm run --silent diagnose -- --json`. `--project <24-hex-id>` selects a listed, non-trashed project; otherwise the first active project is used. `--no-compile` avoids generating build artifacts/using compile quota. Check deadlines default to 10s, compilation to 60s (`--timeout-ms` / `--compile-timeout-ms`). Exit 0 means no failures, **not full protocol coverage**; 1 means failed checks, 2 usage/startup failure. No session means one actionable auth failure and downstream skips; no active project means skips, not failure.

The diagnostic consumer is `src/diagnostics/run.ts`; contracts, aggregation/categories, redaction and renderers are separate modules. It reuses `fetchProjects`, explicit `HttpContext` on `olGet`/`olPostJson`, `requestCompile`, `OverleafSocket`, `parseJoinDocResponse`, `textToOps`, the pure `buildOtUpdate` builder (including `generateIdSeed`), and upload form/response helpers. An explicit HTTP identity disables browser recovery; the standalone diagnostic socket is not the MCP process's active socket and emits only `joinDoc` or the legacy initial `joinProject` fallback. Never route diagnostics through auth retry, cached document baselines, `submitAndVerify`, comment mutations or change accept/reject.

Safety/coverage contracts:

- No text/OT writes (including no-op updates), comment changes, tracked-change acceptance/rejection or asset upload/deletion. There is no `--write` / `--full` mode. Default compile updates build outputs; use `--no-compile` for reads only.
- Project metadata and file tree are received from realtime `joinProjectResponse` / initial `joinProject`, **not a separate HTTP metadata JSON API**. Do not invent such an endpoint or re-emit `joinProject` on an already joined SaaS socket.
- `PASS` means the specific check ran and verified its stated evidence. `FAIL` means unavailable or incompatible. `WARN` means a nonfatal problem. `SKIP` means not executed. `PARTIAL` means limited evidence; empty review data, local write construction, supplied `OL_CSRF`, and OPTIONS capability evidence cannot prove the unobserved protocol. Reports containing skips/partials never aggregate to `passed`.
- OT safe checks confirm a live integer version, synthetic diff round trip and a tc-only 18-hex seed. They **cannot verify applyOtUpdate acceptance, write ACKs, post-write versions or server tracking**. `review.ranges` with actual entries verifies read schema only. `review.tracking` stays PARTIAL even with recognized per-user state. OPTIONS/Allow cannot confirm an upload actually works or that its required fields/response remain valid.
- Compile HTTP/response-schema success is separate from LaTeX health. Parse `output.log` using existing `summarizeErrors`; LaTeX errors are WARN, not COMPILE_API drift. Missing/empty log is PARTIAL, not a clean-build claim. Response missing status or missing outputFiles on success is a COMPILE_API failure.
- Every network/body read has a deadline and fetch cancellation; socket connect bounds handshake, upgrade and project join together. Closing/disconnecting rejects pending ACKs and clears timers; event timeout differs from malformed envelope/ACK, transport loss and explicit server rejection. Only explicit auth evidence (401/403 before session validation, 401/login/invalid session afterward) permits AUTHENTICATION classification. After auth.session PASS, downstream HTTP 403 retains its endpoint category: inspect CSRF semantics, project permissions, endpoint policy or protocol drift. Unknown type-7 errors and HTTP 5xx must not imply expired credentials.
- All reports go through `DiagnosticRedactor` before returning or formatting; actual cookie components/CSRF are registered, unknown credential fields/headers and URL queries are masked. Diagnostic socket logging is quiet; strict stored-cookie reads avoid raw parse-error logging. Keep document/comment/range text out of reports. Project/doc IDs are intentionally retained. Never save raw HAR/headers/handshake SIDs in fixtures, commits or issue reports.

Source-of-truth hierarchy when behavior changes:

1. Live behavior of the **configured deployment** (overleaf.com for SaaS), with an authenticated browser request/ACK and fresh server state after the operation.
2. The Web Editor client actually deployed there: network traffic, bundled code and its current op construction. Pin observation date/deployment/version where available.
3. Current [Overleaf OSS source](https://github.com/overleaf/overleaf), matching the deployment/version when possible. OSS main can lag SaaS; use it to explain observations, never to overrule a reproducible live rejection.
4. This repository's historical assumptions, AGENTS notes and old captures. Existing tests encode a hypothesis; update them only after obtaining newer evidence.

Use the report's stable `id`, `category`, `kind`, `expected`, `observed`, `relevantFiles` and `recommendation` as the starting point:

| Category | Inspect first / revalidation |
|---|---|
| LOCAL_ENV | Node >=20, built entrypoint/imports, config/session path/read permissions, OL_BASE_URL. Diagnostics does not rebuild or certify build freshness. |
| AUTHENTICATION | GET /project redirect/status/login markup; cookie capture and identity discovery (`src/auth`, `src/session/identity.ts`). Refresh via explicit login. For 403 also check CSRF and project permissions before assuming session expiry. |
| NETWORK / HTTP_ENDPOINT | DNS/TLS/proxy/rate limits/status/redirects, then the exact live HTTP method/path and OSS router/controller. A reachable generic OPTIONS handler is not proof of an upload route. |
| HTTP_SCHEMA | Dashboard POST /api/project, fallback GET /user/projects only for 404/405; identity/CSRF meta tags. Missing `projects` is drift, not an empty account. Compare web Projects/Authentication controllers. |
| SOCKET_HANDSHAKE / SOCKET_TRANSPORT | `/socket.io/1/?projectId=...`, `sid:heartbeat:closeTimeout:transports`, WebSocket upgrade cookies (GCLB affinity). Check load balancer and `services/real-time/app/js/Router.js` before changing 0.9 framing. |
| SOCKET_PROTOCOL / SOCKET_EVENT | Current Web Editor WS traffic; distinguish unparseable envelope / unexpected ACK schema / event timeout / rejection. Inspect realtime `Router.js`, `WebsocketController.js`, joinProjectResponse/legacy ACK and joinDoc packed UTF-8/version tuple. Missing version must not default to 0. |
| OT_PROTOCOL / VERSION_CONFLICT | Deployed `share-js-doc.ts` and `applyOtUpdate(docId, update)`; realtime validator, document-updater and `src/ot/verify.ts`. Check strict baseline and concurrent writes, then re-join and compare text/version; ACK alone can mask a transformed no-op. |
| TRACK_CHANGES | [realtime validator](https://github.com/overleaf/overleaf/blob/main/services/real-time/app/js/Router.js), [share-js-doc.ts](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/ide-react/editor/share-js-doc.ts), [ranges-tracker](https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs), document-updater RangesManager, live meta.tc/GET ranges and per-user forced tracking. Preserve the existing tc-only rule and tracked-delete/reject semantics above. |
| COMMENTS | Live GET /project/:id/threads and /ranges, comment anchors and message content/timestamp shapes; locate the matching web routes/controllers and `src/tools/comments.ts`. Empty map confirms endpoint shape only. |
| COMPILE_API | Live POST /project/:id/compile request/rootResourcePath and response status/outputFiles; web Compile router/controller. Verify CLSI worker/group routing and log fetch separately from project LaTeX errors. |
| UPLOAD_API | Capitalized `/Project/:id/upload?folder_id=...`, multipart `name`/`qqfile`, CSRF header, response success/entity_type/entity_id; locate the matching web upload routes/controllers and `src/tools/uploadFile.ts`. Retain no-overwrite staging/conflict-checked rename/own-asset cleanup. |

Maintenance loop: save the **redacted JSON** with deployment/date → reproduce the failing boundary in the Web Editor → compare the deployed client and matching OSS source → update the shared client contract, not a diagnostics-only workaround → add a minimal sanitized drift fixture → run `npm test`, `npm run typecheck`, `npm run build` and safe diagnostics again. Tests in `tests/unit/diagnostics.spec.ts` exercise production transports against a local simulated service, including safe-mode request allowlists, auth, timeouts, ACK/schema drift and redaction.

If extending with mutation probes later, require a dedicated test project and a separately owned temporary document/asset/thread lifecycle first. Never borrow an existing user doc/comment/change for a probe. Record ownership before writes, handle lost ACKs and concurrent writers, verify only the probe's own state, clean up in finally with a deadline, and report cleanup failure plus exact owned ID/path. Existing manual tracked/accept-reject/compile-fix scripts can modify user data; do not run them as default diagnostics.

## Things not to do without asking

- Don't change `track: "on"` default — collaborators expect to review every agent edit.
- Don't propose wrapper scripts for cookie discovery (e.g. pulling from VSCode storage at runtime) — the user explicitly wants the plaintext-in-config approach until a proper login flow is built.
- Don't add code that bypasses tracked-changes when the project has them enabled.
- Don't switch to the broken `socket.io-client@0.9-overleaf` fork.
