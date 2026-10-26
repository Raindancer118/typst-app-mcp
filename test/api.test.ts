import { describe, expect, it } from "vitest";
import { TypstApi, TypstApiError } from "../src/api.js";
import { loadConfig } from "../src/config.js";

class FakeSessions {
  renewals = 0;
  constructor(private value = "OLD") {}
  async get() {
    return this.value;
  }
  async renew() {
    this.renewals++;
    this.value = "NEW";
    return this.value;
  }
}

function api(handler: (url: string, init: RequestInit) => Response) {
  const sessions = new FakeSessions();
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return { client: new TypstApi(loadConfig({}), sessions, fetchImpl), sessions, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("TypstApi.graphql", () => {
  it("sends the session cookie, origin and the query", async () => {
    const { client, seen } = api(() => json({ data: { user: { id: "u1" } } }));
    const data = await client.graphql<{ user: { id: string } }>("query { user { id } }", {});
    expect(data.user.id).toBe("u1");
    const headers = new Headers(seen[0].init.headers);
    expect(seen[0].url).toBe("https://api.typst.app/v1/graphql");
    expect(headers.get("cookie")).toContain("__Http-typst-session=OLD");
    expect(headers.get("origin")).toBe("https://typst.app");
  });

  it("renews the session once when typst.app answers SIGNIN_NEEDED", async () => {
    const { client, sessions, seen } = api((_url, init) =>
      new Headers(init.headers).get("cookie")!.includes("OLD")
        ? json({ errors: [{ message: "", extensions: { code: ["SIGNIN_NEEDED"] } }], data: null })
        : json({ data: { ok: true } })
    );
    expect(await client.graphql("mutation { ok }", {})).toEqual({ ok: true });
    expect(sessions.renewals).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it("turns error codes into actionable messages", async () => {
    const { client } = api(() => json({ errors: [{ message: "", extensions: { code: ["PROJECT_NOT_FOUND"] } }], data: null }));
    const error = await client.graphql("query { project(id: \"x\") { id } }", {}).catch(e => e);
    expect(error).toBeInstanceOf(TypstApiError);
    expect(error.codes).toEqual(["PROJECT_NOT_FOUND"]);
    expect(error.message).toMatch(/typst_list_projects/);
  });

  it("falls back to typst.app's own message for known codes", async () => {
    const { client } = api(() => json({ errors: [{ message: "", extensions: { code: ["PROJECT_LIMIT_REACHED"] } }], data: null }));
    await expect(client.graphql("mutation { x }", {})).rejects.toThrow("You have reached the maximum number of projects. (PROJECT_LIMIT_REACHED)");
  });

  it("explains the comment limit of free plans", async () => {
    const { client } = api(() => json({ errors: [{ message: "", extensions: { code: ["COMMENT_LIMIT_REACHED"] } }], data: null }));
    await expect(client.graphql("mutation { x }", {})).rejects.toThrow(/plan/);
  });

  it("keeps the server message for unknown codes", async () => {
    const { client } = api(() => json({ errors: [{ message: "boom", extensions: { code: ["WEIRD_THING"] } }] }));
    await expect(client.graphql("query { x }", {})).rejects.toThrow(/WEIRD_THING.*boom/);
  });
});

describe("TypstApi.rest", () => {
  it("returns bytes and builds the URL with query parameters", async () => {
    const { client, seen } = api(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const res = await client.rest("GET", "files/p1/f1", { query: { name: "a b.typ", convert: "false" } });
    expect([...res.bytes]).toEqual([1, 2, 3]);
    expect(res.contentType).toBe("image/png");
    expect(seen[0].url).toBe("https://api.typst.app/v1/files/p1/f1?name=a+b.typ&convert=false");
    expect(new Headers(seen[0].init.headers).get("x-typst-preflight")).toBe("true");
  });

  it("parses the plain-text error format and renews on SIGNIN_NEEDED", async () => {
    let n = 0;
    const { client, sessions } = api(() =>
      n++ === 0
        ? new Response("Error: You must sign in to continue. (SIGNIN_NEEDED)", { status: 403, headers: { "content-type": "text/plain" } })
        : new Response("ok")
    );
    await client.rest("GET", "files/p/f");
    expect(sessions.renewals).toBe(1);
  });

  it("maps FILE_NOT_FOUND to a hint", async () => {
    const { client } = api(
      () => new Response("Error: The file was not found. (FILE_NOT_FOUND)", { status: 404, headers: { "content-type": "text/plain" } })
    );
    await expect(client.rest("GET", "files/p/f")).rejects.toThrow(/typst_get_project/);
  });

  it("parses the JSON error format", async () => {
    const { client } = api(() => json({ code: ["FILE_TOO_LARGE"], message: "too big" }, 413));
    await expect(client.rest("PUT", "files/p/f", { body: new Uint8Array(1) })).rejects.toThrow(/FILE_TOO_LARGE/);
  });

  it("does not retry other failures", async () => {
    const { client, seen } = api(() => new Response("", { status: 500 }));
    await expect(client.rest("GET", "files/p/f")).rejects.toThrow(/HTTP 500/);
    expect(seen).toHaveLength(1);
  });
});
