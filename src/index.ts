#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TypstApi } from "./api.js";
import { SessionManager } from "./auth.js";
import { loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";
import { TemplateCatalog } from "./templates.js";
import { TypstService } from "./typst.js";

const config = loadConfig();
const sessions = new SessionManager(config);
const service = new TypstService(new TypstApi(config, sessions), config);
const templates = new TemplateCatalog();

serveStdio(() => createServer({ service, templates }));
console.error(`typst-app-mcp ${VERSION} running on stdio`);
