# typst-app-mcp

MCP server for the [typst.app](https://typst.app) web editor. Lets an AI assistant read and edit your online Typst projects, manage files, comments and sharing, and compile them locally.

typst.app has no public API. This server speaks the same internal API as the web editor (GraphQL + REST + Yjs). It can break whenever typst.app changes, and using it is at your own risk under typst.app's terms.

## Tools

| Area | Tools |
|---|---|
| Account | `typst_whoami`, `typst_list_projects`, `typst_get_project`, `typst_search_templates` |
| Files | `typst_read_file`, `typst_write_file`, `typst_edit_file`, `typst_upload_file`, `typst_rename_file`, `typst_delete_files`, `typst_download_project` |
| Projects | `typst_create_project` (empty or from a Universe template), `typst_duplicate_project`, `typst_update_project`, `typst_delete_project` |
| Sharing | `typst_set_share_links`, `typst_invite_member`, `typst_update_member`, `typst_remove_member`, `typst_revoke_invitation` |
| Comments | `typst_list_comments`, `typst_add_comment`, `typst_reply_comment`, `typst_resolve_comment`, `typst_delete_comment` |
| Build | `typst_compile` (PDF/PNG/SVG via the local `typst` CLI, diagnostics with file:line, inline page previews) |

Text edits are sent as minimal Yjs updates, so people editing the same file in the browser keep their changes and cursors.

## Setup

Needs Node ≥ 20.3 and, for `typst_compile`, the [typst CLI](https://github.com/typst/typst).

```bash
npm ci && npm run build
```

Configuration (environment):

| Variable | |
|---|---|
| `TYPST_EMAIL`, `TYPST_PASSWORD` | Password login; the session is cached in `~/.cache/typst-app-mcp/session` (0600) and renewed automatically |
| `TYPST_SESSION` | Alternative: value of the `__Http-typst-session` cookie from a signed-in browser. Required for accounts with 2FA |
| `TYPST_BIN` | typst CLI path (default `typst`) |
| `TYPST_OUTPUT_DIR` | Where compile output goes (default `~/.cache/typst-app-mcp/output`) |

Claude Code, with credentials injected from a vault via [vault-mcp](https://github.com/Raindancer118/vault-mcp)'s launcher:

```bash
claude mcp add typst-app -s user -- node /path/to/vault-mcp/dist/launch.js \
  --env TYPST_EMAIL=typst.app:username --env TYPST_PASSWORD=typst.app \
  -- node /path/to/typst-app-mcp/dist/index.js
```

## Limits

- Free typst.app accounts cannot create comments (`COMMENT_LIMIT_REACHED`); reading them works.
- `typst_compile` uses your local compiler version, which can differ from the version pinned in the web app.

## Development

```bash
npm test            # unit + MCP protocol tests (offline)
npm run smoke       # start-up test of the built server
TYPST_E2E=1 TYPST_EMAIL=… TYPST_PASSWORD=… npm run test:e2e   # live test, creates and deletes "mcp-e2e-*" projects
```

Releases: `git tag X.Y.Z && git push origin X.Y.Z` (must match `package.json`); CI builds and attaches the package to a GitHub release.
