import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { TemplateCatalog } from "../src/templates.js";
import { TypstService } from "../src/typst.js";
import { FakeTypst } from "./fake-typst.js";

let fake: FakeTypst;
let client: Client;

beforeEach(async () => {
  fake = new FakeTypst();
  const service = new TypstService(fake.asApi(), loadConfig({}));
  const server = createServer({ service, templates: new TemplateCatalog() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[]).filter(c => c.type === "text").map(c => c.text).join("\n");
  return { ...res, text };
};

describe("MCP surface", () => {
  it("exposes every tool with a description and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(26);
    for (const t of tools) {
      expect(t.name).toMatch(/^typst_[a-z_]+$/);
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.annotations).toBeDefined();
    }
    const destructive = tools.filter(t => t.annotations?.destructiveHint && !t.annotations?.idempotentHint).map(t => t.name);
    expect(destructive.sort()).toEqual(["typst_delete_comment", "typst_delete_files", "typst_delete_project", "typst_remove_member"]);
  });

  it("writes, edits and reads a file end to end", async () => {
    expect((await call("typst_write_file", { project_id: "p1", path: "main.typ", content: "= Titel\nText\n" })).text).toMatch(/Created/);
    expect((await call("typst_edit_file", { project_id: "p1", path: "main.typ", edits: [{ old_string: "Text", new_string: "Neu" }] })).text).toMatch(/Applied 1/);
    const read = await call("typst_read_file", { project_id: "p1", path: "main.typ", line_numbers: true });
    expect(read.text).toBe("1│= Titel\n2│Neu\n3│");
  });

  it("returns line ranges with a header", async () => {
    fake.addText("main.typ", "a\nb\nc\nd");
    expect((await call("typst_read_file", { project_id: "p1", path: "main.typ", start_line: 2, end_line: 3 })).text).toBe("main.typ, lines 2-3 of 4:\nb\nc");
  });

  it("returns images inline", async () => {
    fake.addBinary("logo.png", new Uint8Array([137, 80, 78, 71]));
    const res = await client.callTool({ name: "typst_read_file", arguments: { project_id: "p1", path: "logo.png" } });
    expect((res.content as { type: string; mimeType?: string }[])[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("reports service errors as readable tool errors", async () => {
    const res = await call("typst_get_project", { project_id: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/typst_list_projects/);
  });

  it("rejects invalid arguments before they reach typst.app", async () => {
    const res = await call("typst_edit_file", { project_id: "p1", path: "main.typ", edits: [] });
    expect(res.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("refuses to delete a project without the matching name", async () => {
    const res = await call("typst_delete_project", { project_id: "p1", confirm_name: "falsch" });
    expect(res.isError).toBe(true);
    expect(fake.calls).not.toContain("gql:deleteProject");
  });

  it("lists comments with quote and line", async () => {
    fake.addText("main.typ", "eins\nzwei drei\n");
    await call("typst_add_comment", { project_id: "p1", path: "main.typ", content: "Passt?", anchor_text: "drei" });
    expect((await call("typst_list_comments", { project_id: "p1" })).text).toMatch(/main\.typ:2 .*\n> drei\nPasst\?/);
  });
});
