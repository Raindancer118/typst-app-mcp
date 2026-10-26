import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function config(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "typst-mcp-auth-"));
  return loadConfig({ TYPST_SESSION_CACHE: join(dir, "session"), ...extra });
}

const loginFlow = (finalLocation: string, sessionCookie?: string) =>
  fakeFetch((url, init) => {
    if (url.endsWith("/v1/to-signin")) {
      return redirect("https://typst.app/signin/", ["__Http-typst-session=ANON; Domain=typst.app; Path=/; HttpOnly"]);
    }
    if (url.endsWith("/v1/auth/signin")) {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("cookie")).toContain("__Http-typst-session=ANON");
      return redirect(finalLocation, sessionCookie ? [`__Http-typst-session=${sessionCookie}; Domain=typst.app; Path=/`] : []);
    }
    throw new Error(`unexpected ${url}`);
  });

describe("SessionManager", () => {
  it("uses TYPST_SESSION directly without logging in", async () => {
    const f = fakeFetch(() => {
      throw new Error("must not fetch");
    });
    const sm = new SessionManager(config({ TYPST_SESSION: "abc" }), f.fn);
    expect(await sm.get()).toBe("abc");
  });

  it("logs in with email and password, posts the form fields and caches the session (0600)", async () => {
    const cfg = config({ TYPST_EMAIL: "me@example.com", TYPST_PASSWORD: "pw&=?" });
    const f = loginFlow("https://typst.app/", "AUTHED");
    const sm = new SessionManager(cfg, f.fn);

    expect(await sm.get()).toBe("AUTHED");
    const body = new URLSearchParams(String(f.calls[1].init.body));
    expect(body.get("email")).toBe("me@example.com");
    expect(body.get("password")).toBe("pw&=?");
    expect(body.get("captcha-trap")).toBe("");
    expect(readFileSync(cfg.sessionCachePath, "utf8").trim()).toBe("AUTHED");
    expect(statSync(cfg.sessionCachePath).mode & 0o777).toBe(0o600);
  });

  it("reuses the cached session instead of logging in again", async () => {
    const cfg = config({ TYPST_EMAIL: "me@example.com", TYPST_PASSWORD: "pw" });
    writeFileSync(cfg.sessionCachePath, "CACHED\n");
    const f = fakeFetch(() => {
      throw new Error("must not fetch");
    });
    expect(await new SessionManager(cfg, f.fn).get()).toBe("CACHED");
  });

  it("renew() discards a rejected session and logs in again", async () => {
    const cfg = config({ TYPST_EMAIL: "me@example.com", TYPST_PASSWORD: "pw" });
    writeFileSync(cfg.sessionCachePath, "STALE\n");
    const sm = new SessionManager(cfg, loginFlow("https://typst.app/", "FRESH").fn);
    expect(await sm.get()).toBe("STALE");
    expect(await sm.renew()).toBe("FRESH");
  });

  it("reports the error code typst.app puts into the redirect", async () => {
    const sm = new SessionManager(
      config({ TYPST_EMAIL: "me@example.com", TYPST_PASSWORD: "wrong" }),
      loginFlow("https://typst.app/signin/?email=me%40example.com&USER_WRONG_PASSWORD=1").fn
    );
    await expect(sm.get()).rejects.toThrow(/USER_WRONG_PASSWORD/);
  });

  it("explains that accounts with two-factor auth need TYPST_SESSION", async () => {
    const sm = new SessionManager(
      config({ TYPST_EMAIL: "me@example.com", TYPST_PASSWORD: "pw" }),
      loginFlow("https://typst.app/signin/2fa/?token=x", "HALF").fn
    );
    await expect(sm.get()).rejects.toThrow(/two-factor.*TYPST_SESSION/s);
  });

  it("fails with setup instructions when no credentials are configured", async () => {
    const sm = new SessionManager(config(), fakeFetch(() => new Response()).fn);
    await expect(sm.get()).rejects.toThrow(/TYPST_EMAIL.*TYPST_PASSWORD.*TYPST_SESSION/s);
  });

  it("cannot renew a fixed TYPST_SESSION and says so", async () => {
    const sm = new SessionManager(config({ TYPST_SESSION: "abc" }), fakeFetch(() => new Response()).fn);
    await expect(sm.renew()).rejects.toThrow(/expired/);
  });
});
