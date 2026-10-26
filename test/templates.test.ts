import { describe, expect, it } from "vitest";
import { compareVersions, TemplateCatalog } from "../src/templates.js";

const index = [
  { name: "charged-ieee", version: "0.1.0", description: "IEEE paper", keywords: ["paper"], categories: ["paper"], template: { path: "t" } },
  { name: "charged-ieee", version: "0.1.10", description: "IEEE paper", keywords: ["paper"], categories: ["paper"], template: { path: "t" } },
  { name: "charged-ieee", version: "0.1.9", description: "IEEE paper", keywords: ["paper"], categories: ["paper"], template: { path: "t" } },
  { name: "cetz", version: "0.3.4", description: "Drawing with paper-like canvas", keywords: [], categories: ["visualization"] },
  { name: "thesis-de", version: "1.0.0", description: "Abschlussarbeit", keywords: ["thesis", "bachelor"], categories: ["thesis"], template: { path: "t" } }
];

function catalog() {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return new Response(JSON.stringify(index));
  }) as unknown as typeof fetch;
  return { catalog: new TemplateCatalog(fetchImpl), fetches: () => fetches };
}

describe("TemplateCatalog", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns only templates, latest version only, best match first", async () => {
    const { catalog: c } = catalog();
    const res = await c.search("paper", 10);
    expect(res.map(t => `${t.name}@${t.version}`)).toEqual(["charged-ieee@0.1.10"]);
  });

  it("matches keywords and caches the index", async () => {
    const { catalog: c, fetches } = catalog();
    expect((await c.search("bachelor", 10))[0].name).toBe("thesis-de");
    await c.search("", 10);
    expect(fetches()).toBe(1);
  });

  it("resolves the latest version of a template and rejects non-templates", async () => {
    const { catalog: c } = catalog();
    expect(await c.resolve("charged-ieee")).toEqual({ namespace: "preview", name: "charged-ieee", version: "0.1.10" });
    expect(await c.resolve("charged-ieee", "0.1.0")).toEqual({ namespace: "preview", name: "charged-ieee", version: "0.1.0" });
    await expect(c.resolve("cetz")).rejects.toThrow(/not a template/);
    await expect(c.resolve("charged-ieee", "9.9.9")).rejects.toThrow(/0.1.10/);
  });
});
