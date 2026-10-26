import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { TypstApi } from "./api.js";
import type { Config } from "./config.js";
import { applyReplacements, decodeRange, encodeRange, type Replacement, textFromState, updateForNewText } from "./yjs.js";

const run = promisify(execFile);

// ---------- GraphQL documents (shapes taken from the typst.app web client) ----------

const AGENT = "id name";
const FILE_FIELDS = "id name isMultiplayable size version lastChange { date }";
const COMMENT_FIELDS = `id fileId content resolved from to created modified createdBy { id name }
  replies { id content created createdBy { id name } }`;
const PROJECT_META = `id name modified previewed pinnedVersion
  owner { ${AGENT} }
  access { canWrite canReview canManage }
  shareLinkReadOnly shareLinkReviewOnly shareLinkReadWrite
  externalMembers { user { ${AGENT} } canWrite canReview }
  pendingInvitations { id email canWrite canReview }
  folder { id name }`;
const LIST_FIELDS = `id name modified owner { ${AGENT} } access { canWrite canManage } folder { id }`;
const FOLDER_FIELDS = "id name parent { id }";

// ---------- Types ----------

export interface Agent {
  id: string;
  name: string;
}

export interface ProjectFile {
  id: string;
  name: string;
  isMultiplayable: boolean;
  size: number;
  version: string;
  lastChange: { date: number } | null;
}

export interface Comment {
  id: string;
  fileId: string;
  content: string;
  resolved: boolean;
  from: string;
  to: string;
  created: number;
  modified: number;
  createdBy: Agent | null;
  replies: { id: string; content: string; created: number; createdBy: Agent | null }[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  modified: number;
  previewed: string | null;
  pinnedVersion: string | null;
  owner: Agent;
  access: { canWrite: boolean; canReview: boolean; canManage: boolean };
  shareLinkReadOnly: string | null;
  shareLinkReviewOnly: string | null;
  shareLinkReadWrite: string | null;
  externalMembers: { user: Agent; canWrite: boolean; canReview: boolean }[];
  pendingInvitations: { id: string; email: string; canWrite: boolean; canReview: boolean }[];
  folder: { id: string; name: string } | null;
}

export interface Project extends ProjectMeta {
  files: ProjectFile[];
  comments: Comment[];
}

interface ListProject {
  id: string;
  name: string;
  modified: number;
  owner: Agent;
  access: { canWrite: boolean; canManage: boolean };
  folder: { id: string } | null;
}

interface Folder {
  id: string;
  name: string;
  parent: { id: string } | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  workspace: string;
  folder: string | null;
  owner: string;
  modified: string;
  canWrite: boolean;
  canManage: boolean;
}

export type FileContent =
  | { kind: "text"; file: ProjectFile; text: string }
  | { kind: "binary"; file: ProjectFile; bytes: Uint8Array; contentType: string };

export interface Diagnostic {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  outputs: string[];
  diagnostics: Diagnostic[];
  mainFile: string;
  compilerVersion: string;
  pinnedVersion: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  kind: "personal" | "team";
}

// ---------- Helpers ----------

export function normalizePath(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!cleaned || cleaned.split("/").some(part => part === ".." || part === ".")) {
    throw new Error(`Invalid file path "${path}". Use a project-relative path like "chapters/intro.typ".`);
  }
  return cleaned;
}

/** Joins a server-provided path onto a local root and refuses anything that escapes it. */
export function safeJoin(root: string, path: string): string {
  const target = resolve(root, normalizePath(path));
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) {
    throw new Error(`Refusing to write "${path}" outside of ${root}.`);
  }
  return target;
}

export function formatDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "unknown";
}

/** Parses typst's `--diagnostic-format short` output: `path:line:col: error: message`. */
export function parseDiagnostics(output: string, root?: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^(.*?):(\d+):(\d+): (error|warning): (.*)$/);
    if (m) {
      const file = root ? relative(root, resolve(root, m[1])) : m[1];
      diagnostics.push({ severity: m[4] as "error" | "warning", file, line: Number(m[2]), column: Number(m[3]), message: m[5] });
      continue;
    }
    const g = line.match(/^(error|warning): (.*)$/);
    if (g) diagnostics.push({ severity: g[1] as "error" | "warning", message: g[2] });
  }
  return diagnostics;
}

export function slug(name: string): string {
  return name.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "project";
}

function lineOffsets(text: string, startLine: number, endLine: number): { from: number; to: number } {
  const lines = text.split("\n");
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error(`Lines ${startLine}-${endLine} are outside the file (it has ${lines.length} lines).`);
  }
  const from = lines.slice(0, startLine - 1).reduce((n, l) => n + l.length + 1, 0);
  const to = from + lines.slice(startLine - 1, endLine).join("\n").length;
  return { from, to };
}

/** Existing output files for an output pattern; `{p}` stands for the page number. */
export async function pageFiles(output: string): Promise<string[]> {
  if (!output.includes("{p}")) {
    return stat(output).then(() => [output], () => []);
  }
  const dir = dirname(output);
  const [head, suffix] = output.slice(dir.length + 1).split("{p}");
  const pages: { n: number; path: string }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const middle = name.slice(head.length, name.length - suffix.length);
    if (name.startsWith(head) && name.endsWith(suffix) && /^\d+$/.test(middle)) pages.push({ n: Number(middle), path: join(dir, name) });
  }
  return pages.sort((a, b) => a.n - b.n).map(p => p.path);
}

// ---------- Service ----------

export class TypstService {
  constructor(
    private readonly api: TypstApi,
    private readonly config: Config
  ) {}

  async whoami(signal?: AbortSignal) {
    const data = await this.api.graphql<{
      user: { id: string; name: string; email: { address: string } | null; teams: { id: string; name: string }[] } | null;
    }>(`query { user { id name email { address } teams { id name } } }`, {}, signal);
    if (!data.user) throw new Error("typst.app reports no signed-in user. Check the configured credentials.");
    return data.user;
  }

  async workspaces(signal?: AbortSignal): Promise<Workspace[]> {
    const me = await this.whoami(signal);
    return [{ id: me.id, name: "Personal", kind: "personal" }, ...me.teams.map(t => ({ ...t, kind: "team" as const }))];
  }

  async listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    const data = await this.api.graphql<{
      user: {
        projects: ListProject[];
        externalProjects: ListProject[];
        folders: Folder[];
        teams: { name: string; projects: ListProject[]; folders: Folder[] }[];
      };
    }>(
      `query { user {
        projects { ${LIST_FIELDS} } externalProjects { ${LIST_FIELDS} } folders { ${FOLDER_FIELDS} }
        teams { name projects { ${LIST_FIELDS} } folders { ${FOLDER_FIELDS} } }
      } }`,
      {},
      signal
    );
    const user = data.user;
    const folders = new Map<string, Folder>();
    for (const f of [...user.folders, ...user.teams.flatMap(t => t.folders)]) folders.set(f.id, f);
    const folderPath = (id: string | undefined): string | null => {
      const parts: string[] = [];
      for (let f = id ? folders.get(id) : undefined; f && parts.length < 32; f = f.parent ? folders.get(f.parent.id) : undefined) {
        parts.unshift(f.name);
      }
      return parts.length ? parts.join("/") : null;
    };
    const summarize = (p: ListProject, workspace: string): ProjectSummary => ({
      id: p.id,
      name: p.name,
      workspace,
      folder: folderPath(p.folder?.id),
      owner: p.owner.name,
      modified: formatDate(p.modified),
      canWrite: p.access.canWrite,
      canManage: p.access.canManage
    });
    const all = [
      ...user.projects.map(p => summarize(p, "Personal")),
      ...user.teams.flatMap(t => t.projects.map(p => summarize(p, `Team: ${t.name}`))),
      ...user.externalProjects.map(p => summarize(p, "Shared with me"))
    ];
    return all.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
    const data = await this.api.graphql<{ project: Project }>(
      `query($id: ID!) { project(id: $id) { ${PROJECT_META} files { ${FILE_FIELDS} } comments { ${COMMENT_FIELDS} } } }`,
      { id: projectId },
      signal
    );
    data.project.files.sort((a, b) => a.name.localeCompare(b.name));
    return data.project;
  }

  /** Accepts either a file ID or a project-relative path. */
  resolveFile(project: Project, pathOrId: string): ProjectFile {
    const byId = project.files.find(f => f.id === pathOrId);
    if (byId) return byId;
    const path = normalizePath(pathOrId);
    const byPath = project.files.find(f => f.name === path);
    if (byPath) return byPath;
    const similar = project.files.filter(f => f.name.endsWith(path.split("/").pop()!)).map(f => f.name);
    throw new Error(
      `No file "${pathOrId}" in project "${project.name}".` +
        (similar.length ? ` Did you mean: ${similar.slice(0, 5).join(", ")}?` : " Use typst_get_project to list its files.")
    );
  }

  async readFile(projectId: string, pathOrId: string, signal?: AbortSignal): Promise<FileContent> {
    const project = await this.getProject(projectId, signal);
    return this.readResolved(projectId, this.resolveFile(project, pathOrId), signal);
  }

  private async readResolved(projectId: string, file: ProjectFile, signal?: AbortSignal): Promise<FileContent> {
    if (file.isMultiplayable) {
      const { bytes } = await this.api.rest("GET", `files/${projectId}/${file.id}/yjs`, { signal });
      return { kind: "text", file, text: textFromState(bytes) };
    }
    const { bytes, contentType } = await this.api.rest("GET", `files/${projectId}/${file.id}`, { signal });
    return { kind: "binary", file, bytes, contentType };
  }

  /** Creates the file or replaces its whole content. Returns whether it was newly created. */
  async writeText(projectId: string, path: string, content: string, signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    const name = normalizePath(path);
    const existing = project.files.find(f => f.name === name);
    if (!existing) return { created: true, changed: true, file: await this.createFile(projectId, name, content, signal) };
    if (!existing.isMultiplayable) {
      await this.api.rest("PUT", `files/${projectId}/${existing.id}`, { body: content, signal });
      return { created: false, changed: true, file: existing };
    }
    const changed = await this.setText(projectId, existing, content, signal);
    return { created: false, changed, file: existing };
  }

  async editText(projectId: string, pathOrId: string, replacements: Replacement[], signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    const file = this.resolveFile(project, pathOrId);
    if (!file.isMultiplayable) throw new Error(`"${file.name}" is a binary file; use typst_upload_file to replace it.`);
    const { bytes } = await this.api.rest("GET", `files/${projectId}/${file.id}/yjs`, { signal });
    const next = applyReplacements(textFromState(bytes), replacements);
    const update = updateForNewText(bytes, next);
    if (update) await this.api.rest("PUT", `files/${projectId}/${file.id}/yjs`, { body: update, signal });
    return { file, changed: update !== null, text: next };
  }

  private async setText(projectId: string, file: ProjectFile, content: string, signal?: AbortSignal): Promise<boolean> {
    const { bytes } = await this.api.rest("GET", `files/${projectId}/${file.id}/yjs`, { signal });
    const update = updateForNewText(bytes, content);
    if (update) await this.api.rest("PUT", `files/${projectId}/${file.id}/yjs`, { body: update, signal });
    return update !== null;
  }

  private async createFile(projectId: string, name: string, body: Uint8Array | string, signal?: AbortSignal): Promise<ProjectFile> {
    // convert=true would make the server drop the directory part of the name.
    const { bytes } = await this.api.rest("POST", `files/${projectId}`, {
      query: { name, convert: "false" },
      body,
      contentType: "application/octet-stream",
      signal
    });
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as ProjectFile;
  }

  /** Uploads raw bytes. Text files the server tracks collaboratively are updated through Yjs like in the editor. */
  async uploadBytes(projectId: string, path: string, bytes: Uint8Array, signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    const name = normalizePath(path);
    const existing = project.files.find(f => f.name === name);
    if (!existing) return { created: true, file: await this.createFile(projectId, name, bytes, signal) };
    if (existing.isMultiplayable) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`"${name}" is a text file on typst.app, but the upload is not valid UTF-8. Delete it first or pick another name.`);
      }
      await this.setText(projectId, existing, text, signal);
    } else {
      await this.api.rest("PUT", `files/${projectId}/${existing.id}`, { body: bytes, signal });
    }
    return { created: false, file: existing };
  }

  async uploadLocal(projectId: string, localPath: string, remotePath: string | undefined, signal?: AbortSignal) {
    const info = await stat(localPath);
    const uploads: { local: string; remote: string }[] = [];
    if (info.isDirectory()) {
      const prefix = remotePath ? normalizePath(remotePath) + "/" : "";
      for (const entry of await readdir(localPath, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = join(entry.parentPath, entry.name);
        const rel = relative(localPath, full).split(sep).join("/");
        if (rel.split("/").some(p => p.startsWith("."))) continue;
        uploads.push({ local: full, remote: prefix + rel });
      }
    } else {
      uploads.push({ local: localPath, remote: normalizePath(remotePath ?? localPath.split(sep).pop()!) });
    }
    if (uploads.length > 200) throw new Error(`${uploads.length} files is too many for one upload; upload subdirectories separately.`);
    const results: { path: string; created: boolean }[] = [];
    for (const u of uploads) {
      const { created } = await this.uploadBytes(projectId, u.remote, await readFile(u.local), signal);
      results.push({ path: u.remote, created });
    }
    return results;
  }

  async renameFiles(projectId: string, renames: { from: string; to: string }[], signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    const updates = renames.map(r => ({ id: this.resolveFile(project, r.from).id, fileName: normalizePath(r.to) }));
    const data = await this.api.graphql<{ updateFiles: { id: string; name: string }[] }>(
      `mutation($projectId: ID!, $updates: [FileUpdate!]!) { updateFiles(projectId: $projectId, updates: $updates) { id name } }`,
      { projectId, updates },
      signal
    );
    return data.updateFiles;
  }

  async deleteFiles(projectId: string, paths: string[], signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    const files = paths.map(p => this.resolveFile(project, p));
    await this.api.graphql(
      `mutation($projectId: ID!, $ids: [ID!]!) { deleteFiles(projectId: $projectId, ids: $ids) }`,
      { projectId, ids: files.map(f => f.id) },
      signal
    );
    return files.map(f => f.name);
  }

  // ---------- Projects ----------

  async createProject(
    input: { name: string; teamId?: string; folderId?: string; template?: { namespace: string; name: string; version: string } },
    signal?: AbortSignal
  ) {
    const data = await this.api.graphql<{ createProject: { id: string; name: string } }>(
      `mutation($name: String!, $owner: ID, $template: TemplateId, $folder: ID) {
        createProject(name: $name, owner: $owner, template: $template, folder: $folder) { id name }
      }`,
      { name: input.name, owner: input.teamId ?? null, template: input.template ?? null, folder: input.folderId ?? null },
      signal
    );
    return data.createProject;
  }

  async duplicateProject(projectId: string, name: string | undefined, teamId: string | undefined, signal?: AbortSignal) {
    const data = await this.api.graphql<{ duplicateProject: { id: string; name: string } }>(
      `mutation($id: ID!, $name: String, $owner: ID) { duplicateProject(id: $id, name: $name, owner: $owner) { id name } }`,
      { id: projectId, name: name ?? null, owner: teamId ?? null },
      signal
    );
    return data.duplicateProject;
  }

  async deleteProject(projectId: string, confirmName: string, signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    if (project.name !== confirmName) {
      throw new Error(`confirm_name "${confirmName}" does not match the project name "${project.name}". Nothing was deleted.`);
    }
    await this.api.graphql(`mutation($id: ID!) { deleteProject(id: $id) }`, { id: projectId }, signal);
    return project.name;
  }

  async updateProject(
    projectId: string,
    changes: { name?: string; mainFile?: string; pinnedVersion?: string; read?: boolean; review?: boolean; write?: boolean },
    signal?: AbortSignal
  ): Promise<ProjectMeta> {
    let previewed: string | undefined;
    if (changes.mainFile) previewed = this.resolveFile(await this.getProject(projectId, signal), changes.mainFile).id;
    const data = await this.api.graphql<{ updateProject: { id: string } }>(
      `mutation($id: ID!, $name: String, $previewed: ID, $pinnedVersion: String, $read: Boolean, $review: Boolean, $write: Boolean) {
        updateProject(id: $id, name: $name, previewed: $previewed, pinnedVersion: $pinnedVersion, read: $read, review: $review, write: $write) { id }
      }`,
      {
        id: projectId,
        name: changes.name ?? null,
        previewed: previewed ?? null,
        pinnedVersion: changes.pinnedVersion ?? null,
        read: changes.read ?? null,
        review: changes.review ?? null,
        write: changes.write ?? null
      },
      signal
    );
    return this.getProject(data.updateProject.id, signal);
  }

  // ---------- Members ----------

  async inviteMember(projectId: string, email: string, canWrite: boolean, canReview: boolean, signal?: AbortSignal) {
    const data = await this.api.graphql<{ inviteProjectMember: { id: string; email: string } }>(
      `mutation($projectId: ID!, $email: String!, $canReview: Boolean, $canWrite: Boolean) {
        inviteProjectMember(projectId: $projectId, email: $email, canReview: $canReview, canWrite: $canWrite) { id email }
      }`,
      { projectId, email, canWrite, canReview: canReview || canWrite },
      signal
    );
    return data.inviteProjectMember;
  }

  async updateMember(projectId: string, userId: string, canWrite: boolean, canReview: boolean, signal?: AbortSignal) {
    await this.api.graphql(
      `mutation($projectId: ID!, $userId: ID!, $canReview: Boolean, $canWrite: Boolean) {
        updateProjectMember(projectId: $projectId, userId: $userId, canReview: $canReview, canWrite: $canWrite) { projectMembers { user { id } } }
      }`,
      { projectId, userId, canWrite, canReview: canReview || canWrite },
      signal
    );
  }

  async removeMember(projectId: string, userId: string, signal?: AbortSignal) {
    await this.api.graphql(
      `mutation($projectId: ID!, $userId: ID!) { deleteProjectMember(projectId: $projectId, userId: $userId) }`,
      { projectId, userId },
      signal
    );
  }

  async revokeInvitation(projectId: string, email: string, signal?: AbortSignal) {
    await this.api.graphql(
      `mutation($projectId: ID!, $email: String!) { revokeProjectInvitation(projectId: $projectId, email: $email) }`,
      { projectId, email },
      signal
    );
  }

  // ---------- Comments ----------

  async listComments(projectId: string, includeResolved: boolean, signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    const comments = project.comments.filter(c => includeResolved || !c.resolved);
    const states = new Map<string, Uint8Array>();
    const result = [];
    for (const c of comments) {
      const file = project.files.find(f => f.id === c.fileId);
      let quote: string | null = null;
      let line: number | null = null;
      if (file?.isMultiplayable) {
        if (!states.has(file.id)) states.set(file.id, (await this.api.rest("GET", `files/${projectId}/${file.id}/yjs`, { signal })).bytes);
        const state = states.get(file.id)!;
        const range = decodeRange(state, c.from, c.to);
        if (range) {
          const text = textFromState(state);
          quote = text.slice(range.from, range.to);
          line = text.slice(0, range.from).split("\n").length;
        }
      }
      result.push({ ...c, file: file?.name ?? null, quote, line });
    }
    return result;
  }

  async addComment(
    projectId: string,
    pathOrId: string,
    content: string,
    anchor: { text?: string; occurrence?: number; startLine?: number; endLine?: number },
    signal?: AbortSignal
  ) {
    const project = await this.getProject(projectId, signal);
    const file = this.resolveFile(project, pathOrId);
    if (!file.isMultiplayable) throw new Error(`Comments can only be placed in text files; "${file.name}" is binary.`);
    const { bytes } = await this.api.rest("GET", `files/${projectId}/${file.id}/yjs`, { signal });
    const text = textFromState(bytes);

    let range: { from: number; to: number };
    if (anchor.text) {
      const hits: number[] = [];
      for (let i = text.indexOf(anchor.text); i !== -1; i = text.indexOf(anchor.text, i + 1)) hits.push(i);
      if (hits.length === 0) throw new Error(`anchor_text not found in ${file.name}. Copy the exact text from typst_read_file.`);
      const occurrence = anchor.occurrence ?? 1;
      if (hits.length > 1 && anchor.occurrence === undefined) {
        throw new Error(`anchor_text occurs ${hits.length} times in ${file.name}. Make it longer or pass occurrence (1-${hits.length}).`);
      }
      if (occurrence > hits.length) throw new Error(`occurrence ${occurrence} requested, but anchor_text occurs only ${hits.length} times.`);
      range = { from: hits[occurrence - 1], to: hits[occurrence - 1] + anchor.text.length };
    } else if (anchor.startLine) {
      range = lineOffsets(text, anchor.startLine, anchor.endLine ?? anchor.startLine);
    } else {
      throw new Error("Pass anchor_text or start_line to say where the comment belongs.");
    }

    const encoded = encodeRange(bytes, range.from, range.to);
    const data = await this.api.graphql<{ createComment: { id: string } }>(
      `mutation($project: ID!, $file: ID!, $content: String!, $from: Bytes!, $to: Bytes!) {
        createComment(project: $project, file: $file, content: $content, from: $from, to: $to) { id }
      }`,
      { project: projectId, file: file.id, content, from: encoded.from, to: encoded.to },
      signal
    );
    return { id: data.createComment.id, file: file.name, quote: text.slice(range.from, range.to) };
  }

  async replyToComment(projectId: string, commentId: string, content: string, signal?: AbortSignal) {
    const data = await this.api.graphql<{ createCommentReply: { id: string } }>(
      `mutation($project: ID!, $comment: ID!, $content: String!) { createCommentReply(project: $project, comment: $comment, content: $content) { id } }`,
      { project: projectId, comment: commentId, content },
      signal
    );
    return data.createCommentReply;
  }

  async resolveComment(projectId: string, commentId: string, resolved: boolean, signal?: AbortSignal) {
    await this.api.graphql(
      `mutation($project: ID!, $id: ID!, $resolved: Boolean!) { resolveComment(project: $project, id: $id, resolved: $resolved) { id } }`,
      { project: projectId, id: commentId, resolved },
      signal
    );
  }

  async deleteComment(projectId: string, commentId: string, signal?: AbortSignal) {
    await this.api.graphql(`mutation($project: ID!, $id: ID!) { deleteComment(project: $project, id: $id) }`, { project: projectId, id: commentId }, signal);
  }

  // ---------- Local copies & compilation ----------

  /** Writes every project file below `dir`. Returns the project and the written paths. */
  async download(projectId: string, dir: string, signal?: AbortSignal) {
    const project = await this.getProject(projectId, signal);
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const file of project.files) {
      const target = safeJoin(dir, file.name);
      const content = await this.readResolved(projectId, file, signal);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content.kind === "text" ? content.text : content.bytes);
      written.push(file.name);
    }
    return { project, written };
  }

  async compile(
    projectId: string,
    options: { mainFile?: string; format: "pdf" | "png" | "svg"; outputPath?: string; ppi?: number },
    signal?: AbortSignal
  ): Promise<CompileResult> {
    const work = await mkdtemp(join(tmpdir(), "typst-app-mcp-"));
    try {
      const { project } = await this.download(projectId, work, signal);
      const main = options.mainFile
        ? this.resolveFile(project, options.mainFile)
        : project.files.find(f => f.id === project.previewed) ?? project.files.find(f => f.name === "main.typ");
      if (!main) throw new Error("Could not determine the main file. Pass main_file explicitly.");

      const ext = options.format;
      const base = options.outputPath
        ? resolve(options.outputPath)
        : join(this.config.outputDir, slug(project.name), `${slug(main.name.replace(/\.typ$/, "").split("/").pop()!)}.${ext}`);
      // Multi-page image formats need a page placeholder in the file name.
      const output = ext === "pdf" || base.includes("{p}") ? base : base.replace(new RegExp(`\\.${ext}$`), "") + `-{p}.${ext}`;
      await mkdir(dirname(output), { recursive: true });

      const args = ["compile", "--root", work, "--diagnostic-format", "short", "--format", ext];
      if (ext === "png") args.push("--ppi", String(options.ppi ?? 144));
      args.push(join(work, main.name), output);

      for (const stale of await pageFiles(output)) await rm(stale, { force: true });

      let stderr = "";
      let ok = true;
      try {
        ({ stderr } = await run(this.config.typstBin, args, { cwd: work, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, signal }));
      } catch (error) {
        const e = error as { code?: string | number; stderr?: string };
        if (e.code === "ENOENT") throw new Error(`typst CLI not found ("${this.config.typstBin}"). Install it or set TYPST_BIN.`);
        ok = false;
        stderr = e.stderr ?? String(error);
      }
      const diagnostics = parseDiagnostics(stderr, work);
      if (!ok && diagnostics.length === 0) diagnostics.push({ severity: "error", message: stderr.trim() || "typst compile failed" });

      const outputs = ok ? await pageFiles(output) : [];
      return { ok, outputs, diagnostics, mainFile: main.name, compilerVersion: await this.compilerVersion(), pinnedVersion: project.pinnedVersion };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private versionCache?: string;
  private async compilerVersion(): Promise<string> {
    if (!this.versionCache) {
      const { stdout } = await run(this.config.typstBin, ["--version"]);
      this.versionCache = stdout.trim().split(/\s+/)[1] ?? stdout.trim();
    }
    return this.versionCache;
  }
}
