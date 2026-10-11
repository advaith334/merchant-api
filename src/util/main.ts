import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when this module is the process entry point. (import.meta.main is false for .ts entries on Node 24.2.) */
export function isMain(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
