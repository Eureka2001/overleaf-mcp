import type { DiagnosticReport, DiagnosticStatus } from "./model.js";
import { DiagnosticRedactor } from "./redact.js";

const SYMBOLS: Record<DiagnosticStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "~", partial: "?" };

export function formatReport(report: DiagnosticReport, json = false, redactor = new DiagnosticRedactor()): string {
  const safe = redactor.value(report);
  if (json) return JSON.stringify(safe, null, 2);
  const lines = ["Overleaf MCP Diagnostics", "Safe mode: no document/review/asset writes; compilation can update build outputs.", ""];
  const areas = [...new Set(safe.results.map((r) => r.area))];
  for (const area of areas) {
    lines.push(area);
    for (const result of safe.results.filter((r) => r.area === area)) {
      lines.push(`  ${SYMBOLS[result.status]} ${result.status.toUpperCase()} ${result.id}: ${result.summary}`);
      if (result.status === "pass" || result.status === "skip") continue;
      if (result.category) lines.push(`    Category: ${result.category}${result.kind ? ` (${result.kind})` : ""}`);
      if (result.expected) lines.push(`    Expected: ${result.expected}`);
      if (result.observed) lines.push(`    Observed: ${result.observed}`);
      for (const detail of result.details ?? []) lines.push(`    ${detail}`);
      if (result.relevantFiles?.length) lines.push(`    Implementation: ${result.relevantFiles.join(", ")}`);
      for (const [i, item] of (result.recommendation ?? []).entries()) lines.push(`    Investigate ${i + 1}: ${item}`);
    }
  }
  lines.push("", `Summary: ${safe.overall}`, Object.entries(safe.counts).map(([status, count]) => `${count} ${status}`).join(", "));
  return lines.join("\n");
}
