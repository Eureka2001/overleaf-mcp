export class OverleafAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverleafAuthError";
  }
}

export class OverleafApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, hint?: string) {
    super(`Overleaf API error ${status}${hint ? ` (${hint})` : ""}: ${body.slice(0, 200)}`);
    this.name = "OverleafApiError";
    this.status = status;
    this.body = body;
  }
}

// Keep the failing wire boundary for diagnostics and future reverse engineering.
export class OverleafProtocolError extends Error {
  constructor(
    readonly stage: string,
    readonly kind: "schema" | "protocol" | "timeout" | "transport" | "rejection",
    readonly expected: string,
    readonly observed: string,
  ) {
    super(`${stage}: ${kind}: ${observed}`);
    this.name = "OverleafProtocolError";
  }
}

// Never include values from document text or authentication-bearing payloads.
export function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})[${value.slice(0, 6).map(describeShape).join(", ")}]`;
  if (typeof value === "object") return `object{${Object.entries(value).slice(0, 20).map(([key, item]) => `${key}: ${Array.isArray(item) ? `array(${item.length})` : item === null ? "null" : typeof item}`).join(", ")}}`;
  return typeof value;
}
