import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { TemplateCatalog } from "./templates.js";
import { formatDate, type Project, type TypstService } from "./typst.js";

export const VERSION = "0.1.0";
const CHARACTER_LIMIT = 25_000;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_INLINE_IMAGE = 1_500_000;

export interface Deps {
  service: TypstService;
  templates: TemplateCatalog;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const projectId = z.string().min(1).describe("Project ID from typst_list_projects, e.g. 'pAbC123dEf456gHi789jKl'");
const filePath = z.string().min(1).describe("Project-relative path like 'chapters/intro.typ', or a file ID");
const format = z.enum(["markdown", "json"]).default("markdown").describe("'markdown' for readable text, 'json' for structured data");
const access = z.enum(["read", "review", "write"]).describe("'read' = view only, 'review' = view and comment, 'write' = edit");

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; structuredContent?: Record<string, unknown> };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const json = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
const accessFlags = (a: "read" | "review" | "write") => ({ canWrite: a === "write", canReview: a !== "read" });
const accessLabel = (m: { canWrite: boolean; canReview: boolean }) => (m.canWrite ? "write" : m.canReview ? "review" : "read");

function shareLinks(p: Project | Omit<Project, "files" | "comments">) {
  const link = (token: string | null) => (token ? `https://typst.app/project/${token}` : null);
  return { read: link(p.shareLinkReadOnly), review: link(p.shareLinkReviewOnly), write: link(p.shareLinkReadWrite) };
}

function projectMarkdown(p: Project): string {
  const links = shareLinks(p);
  const main = p.files.find(f => f.id === p.previewed)?.name ?? "not set";
  const open = p.comments.filter(c => !c.resolved).length;
  const lines = [
    `# ${p.name} (${p.id})`,
    `- Owner: ${p.owner.name} · modified ${formatDate(p.modified)}`,
    `- Main file: ${main}${p.pinnedVersion ? ` · compiler pinned to ${p.pinnedVersion}` : ""}`,
    `- Your access: ${p.access.canManage ? "manage" : p.access.canWrite ? "write" : p.access.canReview ? "review" : "read"}`,
    `- Comments: ${open} open, ${p.comments.length - open} resolved`,
    "",
    `## Files (${p.files.length})`,
    ...p.files.map(f => `- ${f.name} — ${f.isMultiplayable ? "text" : "binary"}, ${f.size} B (id ${f.id})`),
    "",
    "## Sharing",
    `- Links: read ${links.read ?? "off"} · review ${links.review ?? "off"} · write ${links.write ?? "off"}`,
    ...p.externalMembers.map(m => `- Member ${m.user.name} (user ${m.user.id}): ${accessLabel(m)}`),
    ...p.pendingInvitations.map(i => `- Invited ${i.email}: ${accessLabel(i)} (pending)`)
  ];
  if (p.externalMembers.length + p.pendingInvitations.length === 0) lines.push("- No members or invitations");
  return lines.join("\n");
}

function numbered(content: string, start: number): string {
  const lines = content.split("\n");
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}│${l}`).join("\n");
}

export function createServer({ service, templates }: Deps): McpServer {
  const server = new McpServer({ name: "typst-app-mcp", version: VERSION });

  // ---------- Account & discovery ----------

  server.registerTool(
    "typst_whoami",
    {
      title: "Who am I",
      description: "Show the signed-in typst.app account and its workspaces (personal + teams with their IDs). Use the team IDs for typst_create_project.",
      annotations: READ
    },
    async ctx => {
      const me = await service.whoami(ctx.mcpReq.signal);
      return text(
        [`Signed in as ${me.name} <${me.email?.address ?? "?"}> (user ${me.id})`, "Workspaces:", "- Personal", ...me.teams.map(t => `- Team ${t.name} (team_id ${t.id})`)].join("\n")
      );
    }
  );

  server.registerTool(
    "typst_list_projects",
    {
      title: "List projects",
      description: `List typst.app projects: personal, team and shared-with-me, newest first.

Filter with query (case-insensitive substring of the project name). Returns IDs needed by every other tool.
Example: "Find my thesis project" -> query="thesis".`,
      inputSchema: z.strictObject({
        query: z.string().optional().describe("Substring of the project name"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: format
      }),
      annotations: READ
    },
    async ({ query, limit, offset, response_format }, ctx) => {
      const all = (await service.listProjects(ctx.mcpReq.signal)).filter(p => !query || p.name.toLowerCase().includes(query.toLowerCase()));
      const page = all.slice(offset, offset + limit);
      const hasMore = all.length > offset + page.length;
      if (response_format === "json") {
        return json({ total: all.length, offset, projects: page, has_more: hasMore, ...(hasMore ? { next_offset: offset + page.length } : {}) });
      }
      if (page.length === 0) return text(query ? `No project name contains "${query}".` : "No projects.");
      const lines = [`Projects ${offset + 1}-${offset + page.length} of ${all.length}:`];
      for (const p of page) {
        lines.push(`- ${p.name} (${p.id}) — ${p.workspace}${p.folder ? `/${p.folder}` : ""}, owner ${p.owner}, modified ${p.modified}${p.canWrite ? "" : ", read-only"}`);
      }
      if (hasMore) lines.push(`More: call again with offset=${offset + page.length}.`);
      return text(lines.join("\n"));
    }
  );

  server.registerTool(
    "typst_get_project",
    {
      title: "Get project",
      description: "Show one project: all files (paths, text/binary, IDs), main file, compiler pin, comment counts, share links, members and invitations.",
      inputSchema: z.strictObject({ project_id: projectId, response_format: format }),
      annotations: READ
    },
    async ({ project_id, response_format }, ctx) => {
      const p = await service.getProject(project_id, ctx.mcpReq.signal);
      if (response_format === "json") {
        const { comments, ...rest } = p;
        return json({ ...rest, shareLinks: shareLinks(p), openComments: comments.filter(c => !c.resolved).length });
      }
      return text(projectMarkdown(p));
    }
  );

  server.registerTool(
    "typst_search_templates",
    {
      title: "Search templates",
      description: `Search Typst Universe templates (latest versions) to start a project from. Pass the chosen name to typst_create_project.
Examples: "IEEE paper" -> query="ieee"; "German thesis" -> query="thesis".`,
      inputSchema: z.strictObject({
        query: z.string().default("").describe("Words matched against name, keywords, categories and description"),
        limit: z.number().int().min(1).max(50).default(15)
      }),
      annotations: READ
    },
    async ({ query, limit }) => {
      const found = await templates.search(query, limit);
      if (found.length === 0) return text(`No template matches "${query}". Try fewer or more general words.`);
      return text(found.map(t => `- ${t.name} ${t.version} — ${t.description}${t.categories.length ? ` [${t.categories.join(", ")}]` : ""} ${t.url}`).join("\n"));
    }
  );

  // ---------- Files ----------

  server.registerTool(
    "typst_read_file",
    {
      title: "Read file",
      description: `Read a file from a project. Text files (.typ, .bib, ...) return their content; images are returned inline; other binaries need save_to.
Use start_line/end_line for long files. Use line_numbers=true when you plan comments on line ranges.`,
      inputSchema: z.strictObject({
        project_id: projectId,
        path: filePath,
        start_line: z.number().int().min(1).optional().describe("First line to return (1-based)"),
        end_line: z.number().int().min(1).optional().describe("Last line to return (inclusive)"),
        line_numbers: z.boolean().default(false).describe("Prefix each line with its number"),
        save_to: z.string().optional().describe("Local path to save the file to instead of returning it (needed for large binaries)")
      }),
      annotations: READ
    },
    async ({ project_id, path, start_line, end_line, line_numbers, save_to }, ctx) => {
      const file = await service.readFile(project_id, path, ctx.mcpReq.signal);
      if (save_to) {
        const target = resolve(save_to);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.kind === "text" ? file.text : file.bytes);
        return text(`Saved ${file.file.name} to ${target}.`);
      }
      if (file.kind === "binary") {
        const mime = IMAGE_TYPES[extname(file.file.name).toLowerCase()];
        if (mime && file.bytes.length <= MAX_INLINE_IMAGE) {
          return { content: [{ type: "image", data: Buffer.from(file.bytes).toString("base64"), mimeType: mime }, { type: "text", text: `${file.file.name} (${file.bytes.length} B)` }] };
        }
        return text(`${file.file.name} is a binary file (${file.contentType}, ${file.bytes.length} B). Pass save_to to store it locally.`);
      }
      const all = file.text.split("\n");
      const from = start_line ?? 1;
      const to = Math.min(end_line ?? all.length, all.length);
      if (from > all.length) return text(`${file.file.name} has only ${all.length} lines.`);
      let slice = all.slice(from - 1, to).join("\n");
      let shownTo = to;
      while (slice.length > CHARACTER_LIMIT && shownTo > from) {
        shownTo = from + Math.floor((shownTo - from) / 2);
        slice = all.slice(from - 1, shownTo).join("\n");
      }
      const body = line_numbers ? numbered(slice, from) : slice;
      const partial = from > 1 || shownTo < all.length;
      return text(partial ? `${file.file.name}, lines ${from}-${shownTo} of ${all.length}:\n${body}${shownTo < to ? `\n[truncated; continue with start_line=${shownTo + 1}]` : ""}` : body);
    }
  );

  server.registerTool(
    "typst_write_file",
    {
      title: "Write file",
      description: `Create a text file or replace its entire content. Collaborators in the web editor see the change live.
Prefer typst_edit_file for changes to part of an existing file. Folders are created implicitly by the path.`,
      inputSchema: z.strictObject({ project_id: projectId, path: filePath, content: z.string().describe("Complete new file content") }),
      annotations: OVERWRITE
    },
    async ({ project_id, path, content }, ctx) => {
      const res = await service.writeText(project_id, path, content, ctx.mcpReq.signal);
      return text(res.created ? `Created ${res.file.name}.` : res.changed ? `Updated ${res.file.name}.` : `${res.file.name} already had this content; nothing changed.`);
    }
  );

  server.registerTool(
    "typst_edit_file",
    {
      title: "Edit file",
      description: `Replace exact text in a text file, like a find-and-replace that must match precisely (whitespace included).
Each old_string must occur exactly once unless replace_all=true. Edits apply in order; if one fails, nothing is saved.
Only the changed span is sent, so concurrent edits by collaborators are preserved.`,
      inputSchema: z.strictObject({
        project_id: projectId,
        path: filePath,
        edits: z
          .array(
            z.strictObject({
              old_string: z.string().min(1).describe("Exact text to find"),
              new_string: z.string().describe("Replacement text"),
              replace_all: z.boolean().default(false).describe("Replace every occurrence")
            })
          )
          .min(1)
      }),
      annotations: WRITE
    },
    async ({ project_id, path, edits }, ctx) => {
      const res = await service.editText(
        project_id,
        path,
        edits.map(e => ({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all })),
        ctx.mcpReq.signal
      );
      return text(res.changed ? `Applied ${edits.length} edit(s) to ${res.file.name}.` : `No change: the replacements left ${res.file.name} identical.`);
    }
  );

  server.registerTool(
    "typst_upload_file",
    {
      title: "Upload local file or folder",
      description: `Upload a local file (image, font, .bib, data, ...) or a whole folder into a project. Existing files with the same path are replaced.
Hidden files and folders are skipped. Example: local_path="/home/me/figures", remote_path="figures".`,
      inputSchema: z.strictObject({
        project_id: projectId,
        local_path: z.string().min(1).describe("Absolute local file or directory path"),
        remote_path: z.string().optional().describe("Target path (file) or folder prefix (directory). Defaults to the file name / project root")
      }),
      annotations: OVERWRITE
    },
    async ({ project_id, local_path, remote_path }, ctx) => {
      const results = await service.uploadLocal(project_id, resolve(local_path), remote_path, ctx.mcpReq.signal);
      const created = results.filter(r => r.created).length;
      return text(`Uploaded ${results.length} file(s): ${created} new, ${results.length - created} replaced.\n${results.map(r => `- ${r.path}${r.created ? " (new)" : ""}`).join("\n")}`);
    }
  );

  server.registerTool(
    "typst_rename_file",
    {
      title: "Rename / move files",
      description: "Rename or move files inside a project. Moving to a new folder is just a new path. Remember to update #include/#import paths that point to them.",
      inputSchema: z.strictObject({
        project_id: projectId,
        renames: z.array(z.strictObject({ from: filePath, to: z.string().min(1).describe("New project-relative path") })).min(1)
      }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ project_id, renames }, ctx) => {
      const res = await service.renameFiles(project_id, renames, ctx.mcpReq.signal);
      return text(`Renamed ${res.length} file(s):\n${res.map(r => `- ${r.name}`).join("\n")}`);
    }
  );

  server.registerTool(
    "typst_delete_files",
    {
      title: "Delete files",
      description: "Permanently delete files from a project. Confirm with the user before deleting anything they did not explicitly ask to remove.",
      inputSchema: z.strictObject({ project_id: projectId, paths: z.array(filePath).min(1) }),
      annotations: DESTROY
    },
    async ({ project_id, paths }, ctx) => {
      const deleted = await service.deleteFiles(project_id, paths, ctx.mcpReq.signal);
      return text(`Deleted: ${deleted.join(", ")}`);
    }
  );

  server.registerTool(
    "typst_download_project",
    {
      title: "Download project",
      description: "Download all files of a project into a local directory (created if missing; existing files with the same paths are overwritten). Useful for backups, git or local editing.",
      inputSchema: z.strictObject({ project_id: projectId, directory: z.string().min(1).describe("Absolute local target directory") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    async ({ project_id, directory }, ctx) => {
      const dir = resolve(directory);
      const { project, written } = await service.download(project_id, dir, ctx.mcpReq.signal);
      return text(`Downloaded ${written.length} file(s) of "${project.name}" to ${dir}.`);
    }
  );

  // ---------- Projects ----------

  server.registerTool(
    "typst_create_project",
    {
      title: "Create project",
      description: `Create a new project, empty or from a Typst Universe template (find one with typst_search_templates).
Put it into a team with team_id from typst_whoami. Returns the new project ID.`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(200),
        template: z.string().optional().describe("Template package name, e.g. 'charged-ieee'"),
        template_version: z.string().optional().describe("Defaults to the latest version"),
        team_id: z.string().optional().describe("Create in this team instead of the personal workspace")
      }),
      annotations: WRITE
    },
    async ({ name, template, template_version, team_id }, ctx) => {
      const tpl = template ? await templates.resolve(template, template_version) : undefined;
      const p = await service.createProject({ name, teamId: team_id, template: tpl }, ctx.mcpReq.signal);
      return text(`Created project "${p.name}" (${p.id})${tpl ? ` from ${tpl.name} ${tpl.version}` : ""}. Open: https://typst.app/project/${p.id}`);
    }
  );

  server.registerTool(
    "typst_duplicate_project",
    {
      title: "Duplicate project",
      description: "Copy a project (all files) into a new project, optionally into a team.",
      inputSchema: z.strictObject({ project_id: projectId, name: z.string().optional().describe("Name of the copy"), team_id: z.string().optional() }),
      annotations: WRITE
    },
    async ({ project_id, name, team_id }, ctx) => {
      const p = await service.duplicateProject(project_id, name, team_id, ctx.mcpReq.signal);
      return text(`Created copy "${p.name}" (${p.id}).`);
    }
  );

  server.registerTool(
    "typst_update_project",
    {
      title: "Update project settings",
      description: "Rename a project, set its main (previewed/compiled) file, or pin the compiler version used by the web app.",
      inputSchema: z.strictObject({
        project_id: projectId,
        name: z.string().min(1).optional(),
        main_file: filePath.optional(),
        pinned_version: z.string().regex(/^\d+\.\d+\.\d+$/).optional().describe("Compiler version like '0.14.2'")
      }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ project_id, name, main_file, pinned_version }, ctx) => {
      if (!name && !main_file && !pinned_version) return text("Nothing to change: pass name, main_file or pinned_version.");
      const p = await service.updateProject(project_id, { name, mainFile: main_file, pinnedVersion: pinned_version }, ctx.mcpReq.signal);
      return text(`Updated.\n\n${projectMarkdown(p as Project)}`);
    }
  );

  server.registerTool(
    "typst_delete_project",
    {
      title: "Delete project",
      description: "Permanently delete a whole project. Only on explicit user request. confirm_name must equal the project's exact name as a safety check.",
      inputSchema: z.strictObject({ project_id: projectId, confirm_name: z.string().describe("Exact current name of the project") }),
      annotations: DESTROY
    },
    async ({ project_id, confirm_name }, ctx) => {
      const name = await service.deleteProject(project_id, confirm_name, ctx.mcpReq.signal);
      return text(`Deleted project "${name}".`);
    }
  );

  // ---------- Sharing ----------

  server.registerTool(
    "typst_set_share_links",
    {
      title: "Set share links",
      description: "Turn the project's anyone-with-the-link URLs on or off for read, review and write access, and return the current links. Omitted flags stay unchanged.",
      inputSchema: z.strictObject({ project_id: projectId, read: z.boolean().optional(), review: z.boolean().optional(), write: z.boolean().optional() }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ project_id, read, review, write }, ctx) => {
      const p = await service.updateProject(project_id, { read, review, write }, ctx.mcpReq.signal);
      const l = shareLinks(p);
      return text(`Share links for "${p.name}":\n- read: ${l.read ?? "off"}\n- review: ${l.review ?? "off"}\n- write: ${l.write ?? "off"}`);
    }
  );

  server.registerTool(
    "typst_invite_member",
    {
      title: "Invite member",
      description: "Invite someone to a project by email. typst.app sends them an invitation. Ask the user before inviting anyone.",
      inputSchema: z.strictObject({ project_id: projectId, email: z.email(), access }),
      annotations: WRITE
    },
    async ({ project_id, email, access: a }, ctx) => {
      const f = accessFlags(a);
      await service.inviteMember(project_id, email, f.canWrite, f.canReview, ctx.mcpReq.signal);
      return text(`Invited ${email} with ${a} access.`);
    }
  );

  server.registerTool(
    "typst_update_member",
    {
      title: "Change member access",
      description: "Change an existing member's access. user_id comes from typst_get_project.",
      inputSchema: z.strictObject({ project_id: projectId, user_id: z.string().min(1), access }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ project_id, user_id, access: a }, ctx) => {
      const f = accessFlags(a);
      await service.updateMember(project_id, user_id, f.canWrite, f.canReview, ctx.mcpReq.signal);
      return text(`Member ${user_id} now has ${a} access.`);
    }
  );

  server.registerTool(
    "typst_remove_member",
    {
      title: "Remove member",
      description: "Remove a member from a project. user_id comes from typst_get_project.",
      inputSchema: z.strictObject({ project_id: projectId, user_id: z.string().min(1) }),
      annotations: DESTROY
    },
    async ({ project_id, user_id }, ctx) => {
      await service.removeMember(project_id, user_id, ctx.mcpReq.signal);
      return text(`Removed member ${user_id}.`);
    }
  );

  server.registerTool(
    "typst_revoke_invitation",
    {
      title: "Revoke invitation",
      description: "Withdraw a pending invitation by email.",
      inputSchema: z.strictObject({ project_id: projectId, email: z.email() }),
      annotations: { ...DESTROY, idempotentHint: true }
    },
    async ({ project_id, email }, ctx) => {
      await service.revokeInvitation(project_id, email, ctx.mcpReq.signal);
      return text(`Revoked the invitation for ${email}.`);
    }
  );

  // ---------- Comments ----------

  server.registerTool(
    "typst_list_comments",
    {
      title: "List comments",
      description: "List review comments of a project with file, line, the commented text and replies. Resolved comments only with include_resolved=true.",
      inputSchema: z.strictObject({ project_id: projectId, include_resolved: z.boolean().default(false), response_format: format }),
      annotations: READ
    },
    async ({ project_id, include_resolved, response_format }, ctx) => {
      const comments = await service.listComments(project_id, include_resolved, ctx.mcpReq.signal);
      if (response_format === "json") return json({ comments });
      if (comments.length === 0) return text(include_resolved ? "No comments." : "No open comments.");
      const out = comments.map(c => {
        const head = `### ${c.file ?? "?"}${c.line ? `:${c.line}` : ""} — ${c.createdBy?.name ?? "?"}, ${formatDate(c.created)}${c.resolved ? " (resolved)" : ""} [id ${c.id}]`;
        const quote = c.quote === null ? "> (commented text no longer exists)" : `> ${c.quote.replace(/\n/g, "\n> ")}`;
        const replies = c.replies.map(r => `  ↳ ${r.createdBy?.name ?? "?"}: ${r.content}`);
        return [head, quote, c.content, ...replies].join("\n");
      });
      return text(out.join("\n\n"));
    }
  );

  server.registerTool(
    "typst_add_comment",
    {
      title: "Add comment",
      description: `Add a review comment to a text file, anchored either on exact text (anchor_text, plus occurrence if it is not unique) or on a line range.
The comment stays attached to that text even when the file changes.`,
      inputSchema: z.strictObject({
        project_id: projectId,
        path: filePath,
        content: z.string().min(1).describe("Comment text"),
        anchor_text: z.string().optional().describe("Exact text the comment refers to"),
        occurrence: z.number().int().min(1).optional().describe("Which occurrence of anchor_text (1-based) if it appears several times"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional()
      }),
      annotations: WRITE
    },
    async ({ project_id, path, content, anchor_text, occurrence, start_line, end_line }, ctx) => {
      const res = await service.addComment(project_id, path, content, { text: anchor_text, occurrence, startLine: start_line, endLine: end_line }, ctx.mcpReq.signal);
      return text(`Added comment ${res.id} on ${res.file}: "${res.quote.length > 80 ? res.quote.slice(0, 77) + "..." : res.quote}"`);
    }
  );

  server.registerTool(
    "typst_reply_comment",
    {
      title: "Reply to comment",
      description: "Reply to a comment thread. comment_id comes from typst_list_comments.",
      inputSchema: z.strictObject({ project_id: projectId, comment_id: z.string().min(1), content: z.string().min(1) }),
      annotations: WRITE
    },
    async ({ project_id, comment_id, content }, ctx) => {
      const r = await service.replyToComment(project_id, comment_id, content, ctx.mcpReq.signal);
      return text(`Replied (${r.id}).`);
    }
  );

  server.registerTool(
    "typst_resolve_comment",
    {
      title: "Resolve comment",
      description: "Mark a comment thread as resolved, or reopen it with resolved=false.",
      inputSchema: z.strictObject({ project_id: projectId, comment_id: z.string().min(1), resolved: z.boolean().default(true) }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ project_id, comment_id, resolved }, ctx) => {
      await service.resolveComment(project_id, comment_id, resolved, ctx.mcpReq.signal);
      return text(`Comment ${comment_id} ${resolved ? "resolved" : "reopened"}.`);
    }
  );

  server.registerTool(
    "typst_delete_comment",
    {
      title: "Delete comment",
      description: "Permanently delete a comment thread. Prefer typst_resolve_comment unless the user asks to delete.",
      inputSchema: z.strictObject({ project_id: projectId, comment_id: z.string().min(1) }),
      annotations: DESTROY
    },
    async ({ project_id, comment_id }, ctx) => {
      await service.deleteComment(project_id, comment_id, ctx.mcpReq.signal);
      return text(`Deleted comment ${comment_id}.`);
    }
  );

  // ---------- Compile ----------

  server.registerTool(
    "typst_compile",
    {
      title: "Compile project",
      description: `Compile a project with the local typst CLI and return errors/warnings with file and line, plus the output path.
Use it after edits to check the document builds. format 'png' with preview_pages>0 returns page images inline so you can look at the layout.
Packages (@preview/...) are downloaded automatically.`,
      inputSchema: z.strictObject({
        project_id: projectId,
        main_file: filePath.optional().describe("Entry file; defaults to the project's main file"),
        format: z.enum(["pdf", "png", "svg"]).default("pdf"),
        output_path: z.string().optional().describe("Local output path; for png/svg '{p}' is replaced by the page number"),
        preview_pages: z.number().int().min(0).max(5).default(0).describe("png only: return the first N pages as images"),
        ppi: z.number().int().min(30).max(600).default(144).describe("png resolution")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ project_id, main_file, format: fmt, output_path, preview_pages, ppi }, ctx) => {
      const res = await service.compile(project_id, { mainFile: main_file, format: fmt, outputPath: output_path, ppi }, ctx.mcpReq.signal);
      const errors = res.diagnostics.filter(d => d.severity === "error").length;
      const warnings = res.diagnostics.length - errors;
      const lines = [
        res.ok ? `Compiled ${res.mainFile} → ${res.outputs.length === 1 ? res.outputs[0] : `${res.outputs.length} pages in ${dirname(res.outputs[0] ?? "")}`}` : `Compilation of ${res.mainFile} failed.`,
        `${errors} error(s), ${warnings} warning(s). Local compiler ${res.compilerVersion}.`
      ];
      if (res.pinnedVersion && res.pinnedVersion !== res.compilerVersion) {
        lines.push(`Note: the project is pinned to typst ${res.pinnedVersion}; results may differ from the web app.`);
      }
      for (const d of res.diagnostics.slice(0, 50)) lines.push(`- ${d.severity}${d.file ? ` ${d.file}:${d.line}:${d.column}` : ""}: ${d.message}`);
      if (res.diagnostics.length > 50) lines.push(`... and ${res.diagnostics.length - 50} more`);
      const result: ToolResult = text(lines.join("\n"));
      if (fmt === "png" && preview_pages > 0) {
        for (const page of res.outputs.slice(0, preview_pages)) {
          result.content.push({ type: "image", data: (await readFile(page)).toString("base64"), mimeType: "image/png" });
        }
      }
      return result;
    }
  );

  return server;
}
