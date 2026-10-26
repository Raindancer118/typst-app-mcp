import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  apiUrl: string;
  email?: string;
  password?: string;
  /** Fixed session cookie value; bypasses the password login (needed for accounts with 2FA). */
  session?: string;
  sessionCachePath: string;
  typstBin: string;
  /** Where compile results and downloads go when the caller gives no path. */
  outputDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cacheBase = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return {
    apiUrl: (env.TYPST_API_URL || "https://api.typst.app").replace(/\/+$/, ""),
    email: env.TYPST_EMAIL || undefined,
    password: env.TYPST_PASSWORD || undefined,
    session: env.TYPST_SESSION || undefined,
    sessionCachePath: env.TYPST_SESSION_CACHE || join(cacheBase, "typst-app-mcp", "session"),
    typstBin: env.TYPST_BIN || "typst",
    outputDir: env.TYPST_OUTPUT_DIR || join(cacheBase, "typst-app-mcp", "output")
  };
}
