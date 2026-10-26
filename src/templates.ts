const INDEX_URL = "https://packages.typst.org/preview/index.json";
const CACHE_MS = 60 * 60 * 1000;

interface IndexEntry {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  categories?: string[];
  authors?: string[];
  template?: unknown;
}

export interface TemplateInfo {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  categories: string[];
  url: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export class TemplateCatalog {
  private cache?: { at: number; entries: IndexEntry[] };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async entries(): Promise<IndexEntry[]> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const response = await this.fetchImpl(INDEX_URL, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Typst Universe index unavailable (HTTP ${response.status}). Try again later.`);
      this.cache = { at: Date.now(), entries: (await response.json()) as IndexEntry[] };
    }
    return this.cache.entries;
  }

  private async latestTemplates(): Promise<Map<string, IndexEntry>> {
    const latest = new Map<string, IndexEntry>();
    for (const e of await this.entries()) {
      if (!e.template) continue;
      const known = latest.get(e.name);
      if (!known || compareVersions(e.version, known.version) > 0) latest.set(e.name, e);
    }
    return latest;
  }

  async search(query: string, limit: number): Promise<TemplateInfo[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: { score: number; entry: IndexEntry }[] = [];
    for (const entry of (await this.latestTemplates()).values()) {
      const name = entry.name.toLowerCase();
      const tags = [...(entry.keywords ?? []), ...(entry.categories ?? [])].map(t => t.toLowerCase());
      const description = (entry.description ?? "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        const s = name === term ? 10 : name.includes(term) ? 6 : tags.some(t => t.includes(term)) ? 4 : description.includes(term) ? 2 : 0;
        if (s === 0) {
          score = -1;
          break;
        }
        score += s;
      }
      if (score >= 0) scored.push({ score, entry });
    }
    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, limit).map(({ entry }) => ({
      name: entry.name,
      version: entry.version,
      description: entry.description ?? "",
      keywords: entry.keywords ?? [],
      categories: entry.categories ?? [],
      url: `https://typst.app/universe/package/${entry.name}`
    }));
  }

  async resolve(name: string, version?: string): Promise<{ namespace: string; name: string; version: string }> {
    const all = (await this.entries()).filter(e => e.name === name);
    if (all.length === 0) throw new Error(`No package "${name}" in Typst Universe. Use typst_search_templates to find one.`);
    const templates = all.filter(e => e.template);
    if (templates.length === 0) throw new Error(`"${name}" is a package but not a template. Use typst_search_templates to find templates.`);
    const latest = templates.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b));
    if (version && !templates.some(e => e.version === version)) {
      throw new Error(`Template "${name}" has no version ${version}; the latest is ${latest.version}.`);
    }
    return { namespace: "preview", name, version: version ?? latest.version };
  }
}
