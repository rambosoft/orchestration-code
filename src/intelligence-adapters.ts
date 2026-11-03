import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { rangeHash, type Fact } from "./intelligence.js";
import { intelligenceRegistry, type IntelligenceAdapter, type IntelligenceContext } from "./intelligence-registry.js";

// The first tools (B-163): read only, offline, no model. Each states facts with provenance (file, line, commit, snippet hash) and says plainly what it cannot see.
const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/i;
const TEST = /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[jt]sx?$/i;
const MAX_SCAN_FILES = 2_000; const MAX_FILE_BYTES = 200_000;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/;

const mk = (tool: string, version: string, context: IntelligenceContext, fact: Pick<Fact, "file" | "startLine" | "endLine" | "relationship" | "target" | "confidence"> & { text?: string }): Fact => {
  const { text, ...rest } = fact;
  return { tool, toolVersion: version, commit: context.commit, ...rest, ...(text !== undefined ? { snippetHash: rangeHash(text, rest.startLine, rest.endLine) } : {}) };
};

/** Resolves a relative import to a file of the repository: the path itself, with an extension, a `.js` written for a `.ts` source, or a folder index. */
export function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stem = base.replace(/\.(?:m?js|cjs|jsx?)$/, "");
  const candidates = [base, ...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => stem + ext), ...EXTENSIONS.map(ext => `${base}/index${ext}`)];
  return candidates.find(candidate => known.has(candidate));
}

type Scanned = { file: string; text: string; imports: Array<{ specifier: string; line: number }> };
async function scan(context: IntelligenceContext, only?: string[]): Promise<Scanned[]> {
  const wanted = (only ?? context.files).filter(file => SOURCE.test(file)).slice(0, MAX_SCAN_FILES);
  const scanned: Scanned[] = [];
  for (const file of wanted) {
    if (context.signal.aborted) throw new Error("aborted");
    const full = path.join(context.worktree, file);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
    const text = (await readFile(full, "utf8").catch(() => "")).replace(/\r\n/g, "\n");
    const imports: Scanned["imports"] = [];
    text.split("\n").forEach((line, index) => { const match = IMPORT.exec(line); if (match) imports.push({ specifier: match[1]!, line: index + 1 }); });
    scanned.push({ file, text, imports });
  }
  return scanned;
}

/** Relative-import graph of ts/js sources: what each affected file imports and which files import it. Limits: a line scan, no tsconfig path aliases, no re-export chains, dynamic specifiers are invisible. */
const tsImports: IntelligenceAdapter = {
  id: "ts-imports", version: "1.0.0", defaultMode: "off", timeoutMs: 10_000, sizeBudgetChars: 24_000,
  async run(context) {
    const known = new Set(context.files); const affected = new Set(context.affectedFiles.filter(file => SOURCE.test(file) && known.has(file)));
    if (!affected.size) return [];
    const facts: Fact[] = [];
    const perFile = new Map<string, number>();
    for (const source of await scan(context)) {
      for (const { specifier, line } of source.imports) {
        const resolved = resolveImport(source.file, specifier, known);
        if (!resolved) continue;
        if (affected.has(source.file)) facts.push(mk("ts-imports", "1.0.0", context, { file: source.file, startLine: line, endLine: line, relationship: "imports", target: resolved, confidence: "verified", text: source.text }));
        if (affected.has(resolved) && source.file !== resolved) {
          const seen = perFile.get(resolved) ?? 0;
          if (seen < 30) { perFile.set(resolved, seen + 1); facts.push(mk("ts-imports", "1.0.0", context, { file: source.file, startLine: line, endLine: line, relationship: "imported_by", target: resolved, confidence: "verified", text: source.text })); }
        }
      }
    }
    return facts;
  },
};

/** Companion tests by naming convention (`name.test.ts`, `name.spec.tsx`, or the same name under a tests folder). Static association only: it never runs a test, and a test file that covers a module under another name is reported missing (inferred). */
const affectedTests: IntelligenceAdapter = {
  id: "affected-tests", version: "1.0.0", defaultMode: "off", timeoutMs: 5_000, sizeBudgetChars: 12_000,
  async run(context) {
    const tests = context.files.filter(file => TEST.test(file));
    const stemOf = (file: string): string => path.posix.basename(file).replace(/\.(?:test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "");
    const facts: Fact[] = [];
    for (const file of context.affectedFiles) {
      if (!SOURCE.test(file) || TEST.test(file) || !context.files.includes(file)) continue;
      const stem = stemOf(file); const dir = path.posix.dirname(file);
      const companions = tests.filter(test => stemOf(test) === stem && (path.posix.dirname(test) === dir || /(?:^|\/)(?:__tests__|tests?|e2e)\//.test(test)));
      const text = (await readFile(path.join(context.worktree, file), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
      if (!text) continue;
      if (companions.length) for (const test of companions.slice(0, 3)) facts.push(mk("affected-tests", "1.0.0", context, { file, startLine: 1, endLine: 1, relationship: "tested_by", target: test, confidence: "verified", text }));
      else if (/^(?:src\/)/.test(file) && !/\.d\.ts$/.test(file) && !/(?:^|\/)index\.[jt]sx?$/.test(file)) facts.push(mk("affected-tests", "1.0.0", context, { file, startLine: 1, endLine: 1, relationship: "missing_test", target: `${stem}.test`, confidence: "inferred", text }));
    }
    return facts;
  },
};

/** Third-party packages the affected files import, with the version range package.json declares (offline: no registry, no node_modules walk). */
const pkgDeps: IntelligenceAdapter = {
  id: "pkg-deps", version: "1.0.0", defaultMode: "off", timeoutMs: 5_000, sizeBudgetChars: 8_000,
  async run(context) {
    const raw = (await readFile(path.join(context.worktree, "package.json"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
    if (!raw) return [];
    let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { manifest = JSON.parse(raw); } catch { return []; }
    const declared = { ...manifest.devDependencies, ...manifest.dependencies };
    const lines = raw.split("\n");
    const facts: Fact[] = []; const seen = new Set<string>();
    for (const source of await scan(context, context.affectedFiles.filter(file => context.files.includes(file)))) {
      for (const { specifier } of source.imports) {
        if (/^(?:\.|\/|node:|@\/|~\/)/.test(specifier)) continue;
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
        if (seen.has(name) || !(name in declared)) continue;
        const line = lines.findIndex(item => item.includes(`"${name}"`)) + 1;
        if (line < 1) continue;
        seen.add(name);
        facts.push(mk("pkg-deps", "1.0.0", context, { file: "package.json", startLine: line, endLine: line, relationship: "declares_dependency", target: `${name}@${declared[name]}`, confidence: "verified", text: raw }));
        if (facts.length >= 40) return facts;
      }
    }
    return facts;
  },
};

/** dependency-cruiser as a gate: the project's own `depcruise` script (B-162) runs in verify. It states no facts; the verdict is the value. */
const depcruise: IntelligenceAdapter = {
  id: "depcruise", version: "1.0.0", defaultMode: "off", timeoutMs: 1_000, sizeBudgetChars: 1_000,
  async run() { return []; },
  async gateCommand(worktree) {
    try { const scripts = (JSON.parse(await readFile(path.join(worktree, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}; return scripts.depcruise ? { executable: "npm", args: ["run", "depcruise"], parallel: true } : undefined; }
    catch { return undefined; }
  },
};

for (const adapter of [tsImports, affectedTests, pkgDeps, depcruise]) if (!intelligenceRegistry.get(adapter.id)) intelligenceRegistry.register(adapter);