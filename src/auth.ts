import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";

export const SESSION_COOKIE = "__Http-typst-session";
const ORIGIN = "https://typst.app";

function sessionFrom(response: Response): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      if (value) return value;
    }
  }
  return undefined;
}

/** The sign-in endpoint reports failures as an UPPER_CASE flag in the redirect query. */
function errorCodeFrom(location: string): string | undefined {
  try {
    return [...new URL(location, ORIGIN).searchParams.keys()].find(k => /^[A-Z][A-Z0-9_]+$/.test(k));
  } catch {
    return undefined;
  }
}

export class SessionManager {
  private current?: string;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async get(): Promise<string> {
    if (this.current) return this.current;
    if (this.config.session) return (this.current = this.config.session);
    const cached = this.readCache();
    if (cached) return (this.current = cached);
    return this.login();
  }

  /** Called when the API rejected the current session. */
  async renew(): Promise<string> {
    if (this.config.session) {
      throw new Error(
        "typst.app rejected the session from TYPST_SESSION; it has probably expired. Copy a fresh __Http-typst-session cookie from the browser, or configure TYPST_EMAIL and TYPST_PASSWORD instead."
      );
    }
    this.current = undefined;
    rmSync(this.config.sessionCachePath, { force: true });
    return this.login();
  }

  private async login(): Promise<string> {
    const { email, password, apiUrl } = this.config;
    if (!email || !password) {
      throw new Error(
        "Not signed in to typst.app. Set TYPST_EMAIL and TYPST_PASSWORD (e.g. injected by vault-mcp's launcher), or TYPST_SESSION with the __Http-typst-session cookie from a signed-in browser."
      );
    }

    // The sign-in form only accepts posts that carry an anonymous session.
    const anon = sessionFrom(await this.fetchImpl(`${apiUrl}/v1/to-signin`, { redirect: "manual" }));
    if (!anon) throw new Error("typst.app did not hand out an anonymous session for sign-in. Try again later.");

    const response = await this.fetchImpl(`${apiUrl}/v1/auth/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${anon}`,
        origin: ORIGIN,
        referer: `${ORIGIN}/`
      },
      body: new URLSearchParams({ email, password, redirect: "", "grant-id": "", "captcha-trap": "" }).toString()
    });

    const location = response.headers.get("location") ?? "";
    if (location.includes("/2fa")) {
      throw new Error(
        "This typst.app account uses two-factor authentication, which the password login cannot complete. Set TYPST_SESSION to the __Http-typst-session cookie of a signed-in browser instead."
      );
    }
    const code = errorCodeFrom(location);
    const session = sessionFrom(response);
    if (code || !session) {
      throw new Error(`typst.app sign-in failed (${code ?? `HTTP ${response.status}`}). Check TYPST_EMAIL and TYPST_PASSWORD.`);
    }
    this.writeCache(session);
    return (this.current = session);
  }

  private readCache(): string | undefined {
    try {
      return readFileSync(this.config.sessionCachePath, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private writeCache(session: string): void {
    const path = this.config.sessionCachePath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${session}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
