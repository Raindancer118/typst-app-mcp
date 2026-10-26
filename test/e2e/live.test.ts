/**
 * Live end-to-end test against typst.app through the built server (stdio), like a real MCP host.
 * Run: npm run build && TYPST_E2E=1 (+ TYPST_EMAIL/TYPST_PASSWORD or TYPST_SESSION) npm run test:e2e
 * Creates throwaway projects named "mcp-e2e-*" and deletes them again. Never sends invitations.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.TYPST_E2E === "1";
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

let client: Client;
const created: { id: string; name: string }[] = [];
const work = mkdtempSync(join(tmpdir(), "typst-e2e-"));

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string }[];
  const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return { text, content };
}

async function createProject(name: string, extra: Record<string, unknown> = {}) {
  const { text } = await call("typst_create_project", { name, ...extra });
  const id = text.match(/\((p\w+)\)/)![1];
  created.push({ id, name });
  return id;
}

describe.skipIf(!enabled)("typst.app live", () => {
  let project: string;

  beforeAll(async () => {
    const env: Record<string, string> = { ...getDefaultEnvironment(), TYPST_OUTPUT_DIR: join(work, "out") };
    for (const k of ["TYPST_EMAIL", "TYPST_PASSWORD", "TYPST_SESSION", "TYPST_SESSION_CACHE"]) if (process.env[k]) env[k] = process.env[k]!;
    client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));
    project = await createProject(`mcp-e2e-${Date.now()}`);
  }, 60_000);

  afterAll(async () => {
    for (const p of created) {
      await client.callTool({ name: "typst_delete_project", arguments: { project_id: p.id, confirm_name: p.name } }).catch(() => {});
    }
    await client?.close();
  }, 60_000);

  it("signs in and lists the new project", async () => {
    expect((await call("typst_whoami", {})).text).toMatch(/Signed in as/);
    const { text } = await call("typst_list_projects", { query: "mcp-e2e-" });
    expect(text).toContain(project);
  });

  it("writes, edits and reads text files in subfolders", async () => {
    await call("typst_write_file", { project_id: project, path: "main.typ", content: '#set page(width: 10cm, height: auto)\n= E2E\n#include "chapters/a.typ"\n' });
    await call("typst_write_file", { project_id: project, path: "chapters/a.typ", content: "Kapitel A mit Tippfehlr.\n" });
    await call("typst_edit_file", { project_id: project, path: "chapters/a.typ", edits: [{ old_string: "Tippfehlr", new_string: "Tippfehler" }] });
    expect((await call("typst_read_file", { project_id: project, path: "chapters/a.typ" })).text).toBe("Kapitel A mit Tippfehler.\n");
    expect((await call("typst_write_file", { project_id: project, path: "chapters/a.typ", content: "Kapitel A mit Tippfehler.\n" })).text).toMatch(/nothing changed/);
  });

  it("uploads a local folder with an image and reads the image back inline", async () => {
    const dir = join(work, "assets");
    mkdirSync(join(dir, "img"), { recursive: true });
    writeFileSync(join(dir, "img", "dot.png"), PNG_1PX);
    writeFileSync(join(dir, "refs.bib"), "@book{k, title={T}, author={A}, year={2026}}\n");
    expect((await call("typst_upload_file", { project_id: project, local_path: dir, remote_path: "assets" })).text).toMatch(/2 new/);
    const img = await call("typst_read_file", { project_id: project, path: "assets/img/dot.png" });
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    // Re-upload replaces in place instead of duplicating.
    expect((await call("typst_upload_file", { project_id: project, local_path: dir, remote_path: "assets" })).text).toMatch(/0 new, 2 replaced/);
  });

  it("renames files and shows them in the project overview", async () => {
    await call("typst_rename_file", { project_id: project, renames: [{ from: "assets/refs.bib", to: "refs.bib" }] });
    const { text } = await call("typst_get_project", { project_id: project });
    expect(text).toMatch(/- refs\.bib — text/);
    expect(text).toMatch(/- assets\/img\/dot\.png — binary/);
  });

  it("compiles to PDF and to PNG pages with an inline preview", async () => {
    await call("typst_edit_file", {
      project_id: project,
      path: "main.typ",
      edits: [{ old_string: "= E2E\n", new_string: '= E2E\n#image("assets/img/dot.png", width: 5mm)\n' }]
    });
    const pdf = await call("typst_compile", { project_id: project, format: "pdf" });
    expect(pdf.text).toMatch(/0 error/);
    const path = pdf.text.match(/→ (\S+\.pdf)/)![1];
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("%PDF");
    const png = await call("typst_compile", { project_id: project, format: "png", preview_pages: 1, ppi: 72 });
    expect(png.content.some(c => c.type === "image")).toBe(true);
  }, 120_000);

  it("reports compile errors with file and line", async () => {
    await call("typst_write_file", { project_id: project, path: "broken.typ", content: "ok\n#gibtsnicht\n" });
    const res = await call("typst_compile", { project_id: project, main_file: "broken.typ" });
    expect(res.text).toMatch(/failed/);
    expect(res.text).toMatch(/error broken\.typ:2:/);
    await call("typst_delete_files", { project_id: project, paths: ["broken.typ"] });
  }, 120_000);

  it("runs a full comment thread (or reports the plan limit clearly)", async () => {
    const attempt = await client.callTool({
      name: "typst_add_comment",
      arguments: { project_id: project, path: "chapters/a.typ", content: "E2E-Kommentar", anchor_text: "Tippfehler" }
    });
    const attemptText = (attempt.content as { text?: string }[]).map(c => c.text ?? "").join("");
    if (attempt.isError) {
      // Free typst.app accounts cannot create comments; reading must still work.
      expect(attemptText).toMatch(/paid typst.app plan/);
      expect((await call("typst_list_comments", { project_id: project })).text).toBe("No open comments.");
      return;
    }
    const id = attemptText.match(/comment (\S+) on/)![1];
    await call("typst_edit_file", { project_id: project, path: "chapters/a.typ", edits: [{ old_string: "Kapitel A", new_string: "Das Kapitel A" }] });
    await call("typst_edit_file", { project_id: project, path: "chapters/a.typ", edits: [{ old_string: "Das Kapitel A", new_string: "Kapitel A" }] });
    const list = await call("typst_list_comments", { project_id: project });
    expect(list.text).toMatch(/chapters\/a\.typ:1 .*\n> Tippfehler\nE2E-Kommentar/);
    await call("typst_reply_comment", { project_id: project, comment_id: id, content: "Antwort" });
    await call("typst_resolve_comment", { project_id: project, comment_id: id });
    expect((await call("typst_list_comments", { project_id: project })).text).toBe("No open comments.");
    expect((await call("typst_list_comments", { project_id: project, include_resolved: true })).text).toMatch(/resolved.*\n(.*\n)*.*Antwort/);
    await call("typst_delete_comment", { project_id: project, comment_id: id });
    expect((await call("typst_list_comments", { project_id: project, include_resolved: true })).text).toBe("No comments.");
  });

  it("toggles share links and updates project settings", async () => {
    const on = await call("typst_set_share_links", { project_id: project, read: true });
    expect(on.text).toMatch(/read: https:\/\/typst\.app\/project\/\S+/);
    const off = await call("typst_set_share_links", { project_id: project, read: false });
    expect(off.text).toMatch(/read: off/);
    const upd = await call("typst_update_project", { project_id: project, main_file: "chapters/a.typ" });
    expect(upd.text).toMatch(/Main file: chapters\/a\.typ/);
  });

  it("downloads the project to a local directory", async () => {
    const dir = join(work, "download");
    await call("typst_download_project", { project_id: project, directory: dir });
    expect(readFileSync(join(dir, "chapters", "a.typ"), "utf8")).toBe("Kapitel A mit Tippfehler.\n");
    expect(existsSync(join(dir, "assets", "img", "dot.png"))).toBe(true);
  });

  it("duplicates a project and refuses deletion with a wrong name", async () => {
    const dup = await call("typst_duplicate_project", { project_id: project, name: `${created[0].name}-copy` });
    const id = dup.text.match(/\((p\w+)\)/)![1];
    created.push({ id, name: `${created[0].name}-copy` });
    const wrong = await client.callTool({ name: "typst_delete_project", arguments: { project_id: id, confirm_name: "falsch" } });
    expect(wrong.isError).toBe(true);
  });

  it("creates a project from a Universe template and compiles it", async () => {
    const search = await call("typst_search_templates", { query: "ieee" });
    expect(search.text).toMatch(/charged-ieee/);
    const id = await createProject(`mcp-e2e-tpl-${Date.now()}`, { template: "charged-ieee" });
    const res = await call("typst_compile", { project_id: id });
    expect(res.text).toMatch(/Compiled/);
  }, 180_000);
});
