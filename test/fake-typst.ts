import * as Y from "yjs";
import { TypstApiError, type RestOptions, type RestResult } from "../src/api.js";
import type { TypstApi } from "../src/api.js";

interface FakeFile {
  id: string;
  name: string;
  isMultiplayable: boolean;
  doc?: Y.Doc;
  bytes?: Uint8Array;
}

const TEXT_EXT = /\.(typ|bib|txt|md|csv|json|yml|yaml|toml|xml|svg|tex)$/i;

/** In-memory stand-in for the typst.app API, implementing just the operations the service uses. */
export class FakeTypst {
  files: FakeFile[] = [];
  comments: { id: string; fileId: string; content: string; resolved: boolean; from: string; to: string }[] = [];
  calls: string[] = [];
  previewed: string | null = null;
  name = "Fake Projekt";
  private seq = 0;

  addText(name: string, text: string): FakeFile {
    const doc = new Y.Doc();
    doc.getText("text").insert(0, text);
    const file = { id: `f${++this.seq}`, name, isMultiplayable: true, doc };
    this.files.push(file);
    return file;
  }

  addBinary(name: string, bytes: Uint8Array): FakeFile {
    const file = { id: `f${++this.seq}`, name, isMultiplayable: false, bytes };
    this.files.push(file);
    return file;
  }

  text(name: string): string {
    return this.files.find(f => f.name === name)!.doc!.getText("text").toString();
  }

  private meta() {
    return {
      id: "p1",
      name: this.name,
      modified: 0,
      previewed: this.previewed,
      pinnedVersion: null,
      owner: { id: "u1", name: "Tom" },
      access: { canWrite: true, canReview: true, canManage: true },
      shareLinkReadOnly: null,
      shareLinkReviewOnly: null,
      shareLinkReadWrite: null,
      externalMembers: [],
      pendingInvitations: [],
      folder: null,
      files: this.files.map(f => ({ id: f.id, name: f.name, isMultiplayable: f.isMultiplayable, size: 0, version: "0", lastChange: null })),
      comments: this.comments.map(c => ({ ...c, created: 0, modified: 0, createdBy: { id: "u1", name: "Tom" }, replies: [] }))
    };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const op = query.match(/\{\s*(\w+)/)![1];
    this.calls.push(`gql:${op}`);
    const v = variables as Record<string, any>;
    switch (op) {
      case "project":
        if (v.id !== "p1") throw new TypstApiError(["PROJECT_NOT_FOUND"], 200);
        return { project: this.meta() } as T;
      case "updateFiles":
        for (const u of v.updates) this.files.find(f => f.id === u.id)!.name = u.fileName;
        return { updateFiles: v.updates.map((u: any) => ({ id: u.id, name: u.fileName })) } as T;
      case "deleteFiles":
        this.files = this.files.filter(f => !v.ids.includes(f.id));
        return { deleteFiles: v.ids } as T;
      case "deleteProject":
        return { deleteProject: true } as T;
      case "createComment": {
        const id = `c${++this.seq}`;
        this.comments.push({ id, fileId: v.file, content: v.content, resolved: false, from: v.from, to: v.to });
        return { createComment: { id } } as T;
      }
      default:
        throw new Error(`FakeTypst: unsupported operation ${op}`);
    }
  }

  async rest(method: string, path: string, options: RestOptions = {}): Promise<RestResult> {
    this.calls.push(`${method} ${path}`);
    const [, , fileId, yjs] = path.split("/");
    const body = typeof options.body === "string" ? new TextEncoder().encode(options.body) : options.body ?? new Uint8Array();
    if (method === "POST") {
      const name = options.query!.name;
      const file = TEXT_EXT.test(name) ? this.addText(name, new TextDecoder().decode(body)) : this.addBinary(name, body);
      return { bytes: new TextEncoder().encode(JSON.stringify({ id: file.id, name, isMultiplayable: file.isMultiplayable })), contentType: "application/json" };
    }
    const file = this.files.find(f => f.id === fileId);
    if (!file) throw new TypstApiError(["FILE_NOT_FOUND"], 404);
    if (yjs) {
      if (method === "GET") return { bytes: Y.encodeStateAsUpdate(file.doc!), contentType: "application/octet-stream" };
      Y.applyUpdate(file.doc!, body);
      return { bytes: new Uint8Array(), contentType: "application/octet-stream" };
    }
    if (method === "GET") return { bytes: file.bytes!, contentType: "image/png" };
    file.bytes = body;
    return { bytes: new Uint8Array(), contentType: "application/json" };
  }

  asApi(): TypstApi {
    return this as unknown as TypstApi;
  }
}
