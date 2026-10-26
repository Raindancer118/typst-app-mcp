import { SESSION_COOKIE } from "./auth.js";
import type { Config } from "./config.js";
import { SERVER_MESSAGES } from "./error-messages.js";

export interface Sessions {
  get(): Promise<string>;
  renew(): Promise<string>;
}

const HINTS: Record<string, string> = {
  SIGNIN_NEEDED: "typst.app rejected the session. Check the configured credentials.",
  PROJECT_NOT_FOUND: "Project not found or not accessible. Use typst_list_projects to get valid project IDs.",
  FILE_NOT_FOUND: "File not found. Use typst_get_project to list the project's files and their IDs.",
  FILE_TOO_LARGE: "The file is too large for typst.app.",
  FILE_HISTORY_TOO_LARGE: "The file's edit history is too large; typst.app refuses further edits to it.",
  RATE_LIMIT_EXCEEDED: "typst.app rate limit hit. Wait a minute before retrying.",
  TEMPORARILY_UNAVAILABLE: "typst.app is temporarily unavailable. Try again later.",
  STORAGE_LIMIT_EXCEEDED: "The storage limit of this typst.app account is reached.",
  COMMENT_LIMIT_REACHED:
    "typst.app refuses further comments in this project. Free accounts cannot create comments at all; this needs a paid typst.app plan."
};

export class TypstApiError extends Error {
  constructor(
    readonly codes: string[],
    readonly status: number,
    detail?: string
  ) {
    const hint = codes.map(c => HINTS[c] ?? SERVER_MESSAGES[c]).find(Boolean);
    const label = codes.length > 0 ? codes.join(", ") : `HTTP ${status}`;
    super(hint ? `${hint} (${label})` : `typst.app request failed (${label})${detail ? `: ${detail}` : ""}`);
    this.name = "TypstApiError";
  }

  get needsSignin(): boolean {
    return this.codes.includes("SIGNIN_NEEDED");
  }
}

export interface RestOptions {
  body?: Uint8Array | string;
  query?: Record<string, string>;
  contentType?: string;
  signal?: AbortSignal;
}

export interface RestResult {
  bytes: Uint8Array;
  contentType: string;
}

const TIMEOUT_MS = 60_000;

export class TypstApi {
  // Mirrors the web editor's per-tab client id; the server uses it to attribute changes.
  private readonly clientId = `mcp-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly config: Config,
    private readonly sessions: Sessions,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.withSession(async session => {
      const response = await this.send(`${this.config.apiUrl}/v1/graphql`, {
        method: "POST",
        headers: { ...this.headers(session), "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: T;
        errors?: { message?: string; extensions?: { code?: string[] | string } }[];
      } | null;
      if (payload?.errors?.length) {
        const codes = payload.errors.flatMap(e => {
          const c = e.extensions?.code;
          return Array.isArray(c) ? c : c ? [c] : [];
        });
        const detail = payload.errors.map(e => e.message).filter(Boolean).join("; ");
        throw new TypstApiError(codes, response.status, detail);
      }
      if (!response.ok || !payload?.data) throw new TypstApiError([], response.status);
      return payload.data;
    });
  }

  async rest(method: string, path: string, options: RestOptions = {}): Promise<RestResult> {
    return this.withSession(async session => {
      let url = `${this.config.apiUrl}/v1/${path}`;
      if (options.query) url += `?${new URLSearchParams(options.query).toString()}`;
      const headers = this.headers(session);
      if (options.contentType) headers["content-type"] = options.contentType;
      const response = await this.send(url, { method, headers, body: options.body as BodyInit | undefined, signal: options.signal });
      const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
      if (!response.ok) throw await this.restError(response, contentType);
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
    });
  }

  private async withSession<T>(run: (session: string) => Promise<T>): Promise<T> {
    try {
      return await run(await this.sessions.get());
    } catch (error) {
      if (error instanceof TypstApiError && error.needsSignin) return run(await this.sessions.renew());
      throw error;
    }
  }

  private headers(session: string): Record<string, string> {
    return {
      cookie: `${SESSION_COOKIE}=${session}; INSECURE_SIGNED_IN=yes`,
      origin: "https://typst.app",
      referer: "https://typst.app/",
      "x-typst-client-id": this.clientId,
      "x-typst-preflight": "true"
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`typst.app did not respond within ${TIMEOUT_MS / 1000} seconds. Try again.`);
      }
      throw error;
    }
  }

  private async restError(response: Response, contentType: string): Promise<TypstApiError> {
    const text = await response.text().catch(() => "");
    if (contentType === "application/json") {
      try {
        const body = JSON.parse(text) as { code?: string[]; message?: string };
        if (Array.isArray(body.code)) return new TypstApiError(body.code, response.status, body.message);
      } catch {
        // fall through to the generic error
      }
    }
    const match = text.match(/\(([A-Z_, ]+)\)\s*$/);
    const codes = match ? match[1].split(",").map(c => c.trim()).filter(Boolean) : [];
    return new TypstApiError(codes, response.status, codes.length ? undefined : text.slice(0, 200) || undefined);
  }
}
