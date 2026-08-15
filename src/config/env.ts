import { readFile } from "node:fs/promises";

/**
 * A minimal `.env` loader. No dependency - the whole thing is a handful of
 * lines, and pulling in a package for it would be exactly the kind of
 * unnecessary dependency the target app's own build deliberately avoids.
 *
 * Values already present in `process.env` always win, so `FOO=x npm run
 * discover` overrides `.env` without editing the file.
 */
export async function loadEnvFile(path = ".env"): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // no .env is a valid state - every setting has a default
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
