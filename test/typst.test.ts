import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { normalizePath, parseDiagnostics, safeJoin, TypstService } from "../src/typst.js";
import { FakeTypst } from "./fake-typst.js";

let fake: FakeTypst;
let service: TypstService;
let outputDir: string;

beforeEach(() => {
  fake = new FakeTypst();
  outputDir = mkdtempSync(join(tmpdir(), "typst-mcp-out-"));
  service = new TypstService(fake.asApi(), loadConfig({ TYPST_OUTPUT_DIR: outputDir }));
});

describe("paths", () => {
  it("normalizes project paths and rejects traversal", () => {
    expect(normalizePath("/chapters//intro.typ")).toBe("chapters/intro.typ");
    expect(normalizePath("a\\b.typ")).toBe("a/b.typ");
    expect(() => normalizePath("../etc/passwd")).toThrow(/Invalid/);
    expect(() => normalizePath("")).toThrow(/Invalid/);
  });

  it("safeJoin never leaves the root", () => {
    expect(safeJoin("/tmp/root", "a/b.typ")).toBe("/tmp/root/a/b.typ");
    expect(() => safeJoin("/tmp/root", "a/../../x")).toThrow();
  });
});

describe("parseDiagnostics", () => {
  it("parses typst's short diagnostic format relative to the work dir", () => {
    const out = "/tmp/w/main.typ:3:5: error: unknown variable: foo\n/tmp/w/lib.typ:1:1: warning: unused\nerror: file not found";
    expect(parseDiagnostics(out, "/tmp/w")).toEqual([
      { severity: "error", file: "main.typ", line: 3, column: 5, message: "unknown variable: foo" },
      { severity: "warning", file: "lib.typ", line: 1, column: 1, message: "unused" },
      { severity: "error", message: "file not found" }
    ]);
  });
});

describe("files", () => {
  it("resolves files by path or id and suggests near misses", async () => {
    const f = fake.addText("chapters/intro.typ", "x");
    const project = await service.getProject("p1");
    expect(service.resolveFile(project, f.id).name).toBe("chapters/intro.typ");
    expect(service.resolveFile(project, "/chapters/intro.typ").id).toBe(f.id);
    expect(() => service.resolveFile(project, "intro.typ")).toThrow(/Did you mean: chapters\/intro.typ/);
  });

  it("reads text through Yjs and binaries raw", async () => {
    fake.addText("main.typ", "= Hallo");
    fake.addBinary("logo.png", new Uint8Array([137, 80]));
    expect(await service.readFile("p1", "main.typ")).toMatchObject({ kind: "text", text: "= Hallo" });
    expect(await service.readFile("p1", "logo.png")).toMatchObject({ kind: "binary", bytes: new Uint8Array([137, 80]) });
  });

  it("writeText creates missing files with convert=false and keeps the folder", async () => {
    const res = await service.writeText("p1", "chapters/neu.typ", "Inhalt");
    expect(res.created).toBe(true);
    expect(fake.text("chapters/neu.typ")).toBe("Inhalt");
  });

  it("writeText updates existing files via a Yjs delta and skips no-op writes", async () => {
    fake.addText("main.typ", "alt");
    expect((await service.writeText("p1", "main.typ", "neu")).changed).toBe(true);
    expect(fake.text("main.typ")).toBe("neu");
    fake.calls = [];
    expect((await service.writeText("p1", "main.typ", "neu")).changed).toBe(false);
    expect(fake.calls.filter(c => c.startsWith("PUT"))).toEqual([]);
  });

  it("editText applies exact replacements", async () => {
    fake.addText("main.typ", "Hallo Welt, hallo Mond");
    await service.editText("p1", "main.typ", [{ oldString: "Welt", newString: "Erde" }]);
    expect(fake.text("main.typ")).toBe("Hallo Erde, hallo Mond");
    await expect(service.editText("p1", "main.typ", [{ oldString: "allo", newString: "i" }])).rejects.toThrow(/2 times/);
  });

  it("refuses text edits on binary files", async () => {
    fake.addBinary("logo.png", new Uint8Array([1]));
    await expect(service.editText("p1", "logo.png", [{ oldString: "a", newString: "b" }])).rejects.toThrow(/binary/);
  });

  it("uploadBytes replaces binaries in place and routes text files through Yjs", async () => {
    fake.addBinary("logo.png", new Uint8Array([1]));
    fake.addText("refs.bib", "@book{a}");
    await service.uploadBytes("p1", "logo.png", new Uint8Array([2, 3]));
    await service.uploadBytes("p1", "refs.bib", new TextEncoder().encode("@book{b}"));
    expect(fake.files.find(f => f.name === "logo.png")!.bytes).toEqual(new Uint8Array([2, 3]));
    expect(fake.text("refs.bib")).toBe("@book{b}");
    await expect(service.uploadBytes("p1", "refs.bib", new Uint8Array([0xff, 0xfe]))).rejects.toThrow(/UTF-8/);
  });

  it("uploads a local directory recursively, skipping hidden files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "typst-mcp-up-"));
    mkdirSync(join(dir, "img"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "img", "a.png"), "x");
    writeFileSync(join(dir, "main.typ"), "y");
    writeFileSync(join(dir, ".git", "HEAD"), "z");
    const res = await service.uploadLocal("p1", dir, "assets", undefined);
    expect(res.map(r => r.path).sort()).toEqual(["assets/img/a.png", "assets/main.typ"]);
  });

  it("renames and deletes by path", async () => {
    fake.addText("a.typ", "");
    await service.renameFiles("p1", [{ from: "a.typ", to: "kapitel/a.typ" }]);
    expect(fake.files[0].name).toBe("kapitel/a.typ");
    expect(await service.deleteFiles("p1", ["kapitel/a.typ"])).toEqual(["kapitel/a.typ"]);
    expect(fake.files).toEqual([]);
  });
});

describe("projects", () => {
  it("deleteProject requires the exact project name", async () => {
    await expect(service.deleteProject("p1", "fake projekt")).rejects.toThrow(/does not match/);
    expect(fake.calls).not.toContain("gql:deleteProject");
    expect(await service.deleteProject("p1", "Fake Projekt")).toBe("Fake Projekt");
  });
});

describe("comments", () => {
  it("anchors a comment on unique text and reads it back with quote and line", async () => {
    fake.addText("main.typ", "Zeile eins\nZeile zwei mit Fehler\n");
    const res = await service.addComment("p1", "main.typ", "Bitte prüfen", { text: "Fehler" });
    expect(res.quote).toBe("Fehler");
    const [comment] = await service.listComments("p1", false);
    expect(comment).toMatchObject({ content: "Bitte prüfen", file: "main.typ", quote: "Fehler", line: 2 });
  });

  it("anchors on a line range", async () => {
    fake.addText("main.typ", "a\nbb\nccc\n");
    const res = await service.addComment("p1", "main.typ", "x", { startLine: 2, endLine: 3 });
    expect(res.quote).toBe("bb\nccc");
  });

  it("asks for disambiguation when the anchor text is not unique", async () => {
    fake.addText("main.typ", "ab ab");
    await expect(service.addComment("p1", "main.typ", "x", { text: "ab" })).rejects.toThrow(/occurs 2 times/);
    expect((await service.addComment("p1", "main.typ", "x", { text: "ab", occurrence: 2 })).quote).toBe("ab");
  });
});

const hasTypst = (() => {
  try {
    execFileSync("typst", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTypst)("compile (local typst CLI)", () => {
  it("compiles the previewed file to PDF including subfolder includes and images", async () => {
    const main = fake.addText("main.typ", '#include "chapters/a.typ"\n#image("img/dot.svg", width: 1cm)');
    fake.addText("chapters/a.typ", "= Kapitel A");
    fake.addText("img/dot.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>');
    fake.previewed = main.id;
    const res = await service.compile("p1", { format: "pdf" });
    expect(res.ok).toBe(true);
    expect(res.mainFile).toBe("main.typ");
    expect(readFileSync(res.outputs[0]).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("returns diagnostics with project-relative paths on errors", async () => {
    fake.addText("main.typ", "#unbekannt");
    const res = await service.compile("p1", { format: "pdf" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]).toMatchObject({ severity: "error", file: "main.typ", line: 1 });
  });

  it("exports one PNG per page and drops stale pages from earlier runs", async () => {
    fake.addText("main.typ", "Eins #pagebreak() Zwei #pagebreak() Drei");
    expect((await service.compile("p1", { format: "png", ppi: 30 })).outputs).toHaveLength(3);
    fake.files[0].doc!.getText("text").delete(0, fake.text("main.typ").length);
    fake.files[0].doc!.getText("text").insert(0, "Nur eine Seite");
    const res = await service.compile("p1", { format: "png", ppi: 30 });
    expect(res.outputs).toHaveLength(1);
    expect(existsSync(res.outputs[0])).toBe(true);
  });
});
