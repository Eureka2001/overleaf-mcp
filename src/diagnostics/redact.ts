const SENSITIVE_KEY = /cookie|csrf|authorization|token|secret|password|session|api[-_]?key/i;

// One boundary for reports, both renderers and CLI errors. Known credentials
// cover unlabeled server echoes; field/header patterns cover unknown tokens.
export class DiagnosticRedactor {
  private secrets = new Set<string>();

  add(...values: (string | undefined)[]): void {
    for (const value of values) {
      if (!value) continue;
      this.secrets.add(value);
      this.secrets.add(encodeURIComponent(value));
      this.secrets.add(JSON.stringify(value).slice(1, -1));
    }
  }

  addCookie(cookie: string): void {
    this.add(cookie);
    for (const part of cookie.split(";")) {
      const equal = part.indexOf("=");
      if (equal < 0) continue;
      const name = part.slice(0, equal).trim();
      const value = part.slice(equal + 1).trim();
      // Preference cookies commonly contain "1" / "true". Those are not
      // credentials and replacing every occurrence destroys IDs, versions and
      // report keys. Still register auth values and all opaque cookie values.
      if (/session|csrf|token|auth/i.test(name) || value.length >= 8) this.add(value);
    }
  }

  text(value: string): string {
    let out = value;
    // Errors often embed serialized response JSON after an HTTP prefix. Redact
    // it structurally too, including secret objects/arrays rather than only
    // string-valued fields. Failed parsing falls back to text patterns below.
    const begin = out.search(/[\[{]/);
    const end = Math.max(out.lastIndexOf("}"), out.lastIndexOf("]"));
    if (begin >= 0 && end > begin) {
      try { out = out.slice(0, begin) + JSON.stringify(this.value(JSON.parse(out.slice(begin, end + 1)))) + out.slice(end + 1); }
      catch { /* not an embedded JSON payload */ }
    }
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[REDACTED]");
    out = out.replace(/((?:set-cookie|cookie|authorization)\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]");
    out = out.replace(/(["'][^"']*(?:cookie|csrf|authorization|token|secret|password|session|api[-_]?key)[^"']*["']\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
    out = out.replace(/(["']?\b[\w-]*(?:csrf|token|secret|password|session|api[-_]?key)[\w-]*["']?\s*[:=]\s*)('[^']*'|[^\s,;}"&]+)/gi, "$1[REDACTED]");
    out = out.replace(/(<(?:meta|input)\b[^>]*(?:name|id)=["'][^"']*(?:csrf|token|secret|password|session)[^"']*["'][^>]*(?:content|value)=["'])[^"']*(["'])/gi, "$1[REDACTED]$2");
    out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z\d+/._~=-]+/gi, "$1 [REDACTED]");
    out = out.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
    out = out.replace(/([?&][^\s=&#"'<>]+=)[^\s&#"'<>]*/g, "$1[REDACTED]");
    out = out.replace(/(\/socket\.io\/1\/websocket\/)[^\s/?"']+/g, "$1[REDACTED]");
    // Terminal control sequences cannot be allowed to hide/rewrite findings.
    return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  }

  value<T>(input: T): T {
    const visit = (value: unknown): unknown => {
      if (typeof value === "string") return this.text(value);
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object") {
        if (value instanceof Error) return this.text(value.message);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.text(key), SENSITIVE_KEY.test(key) ? "[REDACTED]" : visit(item)]));
      }
      return value;
    };
    return visit(input) as T;
  }
}
