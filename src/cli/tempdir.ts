import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Removes a scratch directory the CLI created, without ever failing the command over it.
 *
 * Windows refuses to delete a directory while anything still holds it (a process that exited a
 * moment ago, an antivirus scan), so this retries with real pauses. If the directory is still
 * stuck after that, it is left for the operating system's temp cleanup: a leftover scratch
 * folder is not a reason to report a passing demo or doctor run as failed.
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(100 * attempt);
    }
  }
}
