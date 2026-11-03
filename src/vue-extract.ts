import ts from "typescript";

// Deterministic facts about a Vue 2 / Nuxt 2 single-file component (B-138, ADR 0035): what a survey should count instead of asking a model to read hundreds of files. The tools count, the models interpret.
// The script block is parsed with the TypeScript compiler API (a real AST, so props, registrations and store calls are read, not guessed); the template is scanned for tags, directives and events.
// Limits, stated plainly: Vue 3 `<script setup>` is not understood (the old app is Vue 2), a component built by a function or a mixin factory shows only what is written in the file, and template
// expressions are scanned as text, not parsed.

export type VueFacts = {
  file: string; bytes: number; lines: number;
  blocks: { template: number; script: number; style: number };
  name?: string; props: string[]; registered: string[]; mixins: string[];
  /** Custom tags used in the template (a dash or a capital letter), registered or not. */
  usedTags: string[];
  hooks: string[]; watchers: number; computed: number; methods: number;
  vuex: { mapped: Record<"state" | "getters" | "actions" | "mutations", string[]>; calls: string[] };
  eventBus: { emits: string[]; listens: string[] };
  refs: number; domGlobals: number; templateDirectives: { for: number; if: number; model: number; on: number };
};

const HOOKS = new Set(["asyncData", "fetch", "middleware", "layout", "head", "validate", "beforeCreate", "created", "beforeMount", "mounted", "beforeUpdate", "updated", "beforeDestroy", "destroyed", "activated", "deactivated"]);
const HTML_TAGS = new Set("a abbr b body br button canvas div em footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label li link main meta nav ol option p pre script section select small source span strong style svg table tbody td template textarea th thead title tr track ul video audio slot component transition".split(" "));

const block = (source: string, tag: string): { content: string; lang?: string } | undefined => {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, "i").exec(source);
  if (!open) return undefined;
  const close = source.toLowerCase().lastIndexOf(`</${tag}>`);
  if (close < open.index + open[0].length) return undefined;
  return { content: source.slice(open.index + open[0].length, close), ...(/lang=["']?(\w+)/i.exec(open[1]!)?.[1] ? { lang: /lang=["']?(\w+)/i.exec(open[1]!)![1]! } : {}) };
};

const names = (node: ts.Node | undefined): string[] => {
  if (!node) return [];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => ts.isStringLiteralLike(element) ? [element.text] : []);
  if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? [property.name.text] : []);
  return [];
};

function exportedOptions(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const fromExpression = (expression: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (ts.isCallExpression(expression) && expression.arguments[0] && ts.isObjectLiteralExpression(expression.arguments[0])) return expression.arguments[0];
    return undefined;
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) found ??= fromExpression(statement.expression);
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && /module\.exports$/.test(statement.expression.left.getText(sourceFile))) found ??= fromExpression(statement.expression.right);
  }
  return found;
}

/** The facts of one component file. A file that is not a single-file component still returns its size. */
export function extractVueFacts(source: string, file: string): VueFacts {
  const text = source.replace(/\r\n/g, "\n");
  const template = block(text, "template"); const script = block(text, "script"); const style = block(text, "style");
  const facts: VueFacts = {
    file, bytes: Buffer.byteLength(source), lines: text.split("\n").length,
    blocks: { template: template ? template.content.split("\n").length : 0, script: script ? script.content.split("\n").length : 0, style: style ? style.content.split("\n").length : 0 },
    props: [], registered: [], mixins: [], usedTags: [], hooks: [], watchers: 0, computed: 0, methods: 0,
    vuex: { mapped: { state: [], getters: [], actions: [], mutations: [] }, calls: [] }, eventBus: { emits: [], listens: [] }, refs: 0, domGlobals: 0, templateDirectives: { for: 0, if: 0, model: 0, on: 0 },
  };
  if (template) {
    const tags = new Set<string>();
    for (const match of template.content.matchAll(/<([A-Za-z][A-Za-z0-9-]*)/g)) { const tag = match[1]!; if (!HTML_TAGS.has(tag.toLowerCase()) && (tag.includes("-") || /^[A-Z]/.test(tag))) tags.add(tag); }
    facts.usedTags = [...tags].sort();
    facts.templateDirectives = { for: (template.content.match(/\bv-for=/g) ?? []).length, if: (template.content.match(/\bv-(?:if|else-if|show)=/g) ?? []).length, model: (template.content.match(/\bv-model\b/g) ?? []).length, on: (template.content.match(/(?:\bv-on:|@)[A-Za-z]/g) ?? []).length };
  }
  if (!script) return facts;
  const kind = script.lang === "ts" || script.lang === "tsx" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(`${file}.${kind === ts.ScriptKind.TS ? "ts" : "js"}`, script.content, ts.ScriptTarget.Latest, true, kind);
  const options = exportedOptions(sourceFile);
  for (const property of options?.properties ?? []) {
    if (!property.name || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) continue;
    const key = property.name.text;
    const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
    if (key === "name" && value && ts.isStringLiteralLike(value)) facts.name = value.text;
    else if (key === "props") facts.props = names(value);
    else if (key === "components") facts.registered = ts.isShorthandPropertyAssignment(property) ? [key] : names(value);
    else if (key === "mixins" && value && ts.isArrayLiteralExpression(value)) facts.mixins = value.elements.map(element => element.getText(sourceFile));
    else if (key === "watch") facts.watchers = names(value).length;
    else if (key === "computed") facts.computed = names(value).length + (value && ts.isObjectLiteralExpression(value) ? value.properties.filter(ts.isSpreadAssignment).length : 0);
    else if (key === "methods") facts.methods = names(value).length + (value && ts.isObjectLiteralExpression(value) ? value.properties.filter(ts.isSpreadAssignment).length : 0);
    else if (HOOKS.has(key)) facts.hooks.push(key);
  }
  const mapped = facts.vuex.mapped; const calls = new Set<string>(); const emits = new Set<string>(); const listens = new Set<string>(); let refs = 0; let dom = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      const mapper = callee && /^map(State|Getters|Actions|Mutations)$/.exec(callee)?.[1]?.toLowerCase() as keyof typeof mapped | undefined;
      if (mapper) {
        const [first, second] = node.arguments;
        const namespace = first && ts.isStringLiteralLike(first) ? first.text : undefined;
        mapped[mapper].push(...names(namespace ? second : first).map(name => namespace ? `${namespace}/${name}` : name));
      }
      const target = ts.isPropertyAccessExpression(node.expression) ? node.expression : undefined;
      if (target) {
        const member = target.name.text; const owner = target.expression.getText(sourceFile);
        if ((member === "dispatch" || member === "commit") && /(?:^|\.)\$?store$/.test(owner) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) calls.add(`${member}:${node.arguments[0].text}`);
        if (/\$nuxt$|\$root$|\bbus$|EventBus$|eventBus$/.test(owner) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) { if (member === "$emit") emits.add(node.arguments[0].text); if (member === "$on" || member === "$once") listens.add(node.arguments[0].text); }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const full = node.getText(sourceFile);
      if (/\$store\.(?:state|getters)\./.test(full) && !ts.isPropertyAccessExpression(node.parent)) calls.add(`read:${full.replace(/^.*\$store\./, "")}`);
      if (/\$refs$/.test(node.expression.getText(sourceFile))) refs += 1;
      if (ts.isIdentifier(node.expression) && (node.expression.text === "document" || node.expression.text === "window")) dom += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const key of Object.keys(mapped) as Array<keyof typeof mapped>) mapped[key] = [...new Set(mapped[key])].sort();
  facts.vuex.calls = [...calls].sort(); facts.eventBus = { emits: [...emits].sort(), listens: [...listens].sort() }; facts.refs = refs; facts.domGlobals = dom;
  facts.registered = [...new Set(facts.registered)].sort(); facts.props = [...new Set(facts.props)].sort();
  return facts;
}

/** One bounded line per component, largest first, for the survey inventory. */
export function renderVueSummary(all: VueFacts[], maxChars = 3_000): string {
  const line = (facts: VueFacts): string => {
    const parts = [
      `${facts.file} (${facts.lines} lines)`,
      facts.props.length ? `props ${facts.props.slice(0, 6).join(",")}` : "",
      facts.registered.length ? `registers ${facts.registered.slice(0, 4).join(",")}` : "",
      facts.hooks.length ? `hooks ${facts.hooks.join(",")}` : "",
      facts.mixins.length ? `mixins ${facts.mixins.join(",")}` : "",
      Object.entries(facts.vuex.mapped).filter(([, list]) => list.length).map(([kind, list]) => `${kind} ${list.slice(0, 4).join(",")}`).join("; "),
      facts.vuex.calls.length ? `store ${facts.vuex.calls.slice(0, 4).join(",")}` : "",
      facts.eventBus.emits.length || facts.eventBus.listens.length ? `bus emits ${facts.eventBus.emits.slice(0, 4).join(",") || "-"} listens ${facts.eventBus.listens.slice(0, 4).join(",") || "-"}` : "",
      facts.refs ? `${facts.refs} $refs` : "", facts.domGlobals ? `${facts.domGlobals} window/document` : "",
    ].filter(Boolean);
    return parts.join("; ");
  };
  const sorted = [...all].sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const out: string[] = [];
  let used = 0;
  for (const facts of sorted) { const row = line(facts); if (used + row.length + 1 > maxChars) { out.push(`(+${sorted.length - out.length} more components, see the files)`); break; } out.push(row); used += row.length + 1; }
  return out.join("\n");
}

