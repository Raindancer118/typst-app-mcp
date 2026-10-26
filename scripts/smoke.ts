/**
 * Start-up check: launches the built server over stdio like an MCP host would and exits non-zero on failure.
 * Runs without credentials (CI); with TYPST_EMAIL/TYPST_PASSWORD or TYPST_SESSION set it also checks the live login.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const live = Boolean(process.env.TYPST_SESSION || (process.env.TYPST_EMAIL && process.env.TYPST_PASSWORD));
const env: Record<string, string> = { ...getDefaultEnvironment(), TYPST_SESSION_CACHE: join(mkdtempSync(join(tmpdir(), "typst-smoke-")), "session") };
for (const key of ["TYPST_EMAIL", "TYPST_PASSWORD", "TYPST_SESSION"]) if (process.env[key]) env[key] = process.env[key]!;

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));

const { tools } = await client.listTools();
assert.equal(tools.length, 26, `expected 26 tools, got ${tools.length}`);

const invalid = await client.callTool({ name: "typst_read_file", arguments: { project_id: "" } });
assert.equal(invalid.isError, true, "invalid arguments must be rejected");

const me = await client.callTool({ name: "typst_whoami", arguments: {} });
const text = (me.content as { text?: string }[]).map(c => c.text ?? "").join("");
if (live) {
  assert.ok(!me.isError, `live login failed: ${text}`);
  assert.match(text, /Signed in as/);
} else {
  assert.equal(me.isError, true);
  assert.match(text, /TYPST_EMAIL/, "missing credentials must produce setup instructions");
}

await client.close();
console.error(`Smoke test passed (${tools.length} tools${live ? ", live login ok" : ""})`);
