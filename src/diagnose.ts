#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runDiagnostics, type DiagnosticOptions } from "./diagnostics/run.js";
import { aggregateResults, failureResult } from "./diagnostics/model.js";
import { formatReport } from "./diagnostics/format.js";
import { DiagnosticRedactor } from "./diagnostics/redact.js";

export function parseDiagnosticArgs(args: string[]): DiagnosticOptions & { json: boolean; help: boolean } {
  const options: DiagnosticOptions & { json: boolean; help: boolean } = { json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-compile") options.compile = false;
    else if (arg === "--project") {
      const value = args[++i];
      if (!/^[a-f\d]{24}$/i.test(value ?? "")) throw new Error("--project requires a 24-hex project ID");
      options.projectId = value;
    } else if (arg === "--timeout-ms" || arg === "--compile-timeout-ms") {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? "") || Number(value) < 100 || Number(value) > 300_000) throw new Error(`${arg} requires 100..300000 milliseconds`);
      if (arg === "--timeout-ms") options.timeoutMs = Number(value); else options.compileTimeoutMs = Number(value);
    } else throw new Error("Unsupported diagnostics option. Use --help; --full/--write are not implemented.");
  }
  return options;
}

export async function runDiagnosticCli(args: string[]): Promise<number> {
  const redactor = new DiagnosticRedactor();
  redactor.add(process.env.OL_CSRF);
  let json = args.includes("--json");
  try {
    const options = parseDiagnosticArgs(args);
    json = options.json;
    if (options.help) {
      process.stdout.write("Usage: node dist/diagnose.js [--json] [--project ID] [--no-compile]\n       [--timeout-ms 10000] [--compile-timeout-ms 60000]\nSafe mode never edits documents/review or uploads assets. Default compilation updates build outputs and may use quota.\nExit: 0 no failures (check overall/counts for partial coverage), 1 checks failed, 2 usage/startup error.\n");
      return 0;
    }
    const report = await runDiagnostics(options);
    process.stdout.write(formatReport(report, json, redactor) + "\n");
    return report.overall === "failed" ? 1 : 0;
  } catch (error) {
    const report = aggregateResults([failureResult({ id: "diagnose.startup", area: "Environment", category: "LOCAL_ENV", relevantFiles: ["src/diagnose.ts", "src/config.ts"], recommendation: ["Run node dist/diagnose.js --help; check configuration and rebuild."] }, error)]);
    process.stdout.write(formatReport(report, json, redactor) + "\n");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDiagnosticCli(process.argv.slice(2));
}
