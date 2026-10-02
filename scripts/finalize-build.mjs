import { chmodSync } from "node:fs";

// npm uses cmd.exe on Windows; a shell chmod command is not portable.
if (process.platform !== "win32") {
  for (const file of ["dist/index.js", "dist/diagnose.js"]) chmodSync(file, 0o755);
}
