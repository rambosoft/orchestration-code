// Deterministic Vue 2 / Nuxt 2 facts for the survey (B-138): what the code says, counted, so a model interprets instead of reading hundreds of files.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSurveyInventory } from "../src/survey-inventory.js";
import { extractVueFacts, renderVueSummary } from "../src/vue-extract.js";

const HOME = `<template>
  <div>
    <hero-banner :items="items" @select="onSelect" />
    <Carousel v-for="row in rows" :key="row.id" v-if="row.items.length" />
    <input v-model="query">
    <nuxt-link to="/x">x</nuxt-link>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex'
import HeroBanner from '~/components/HeroBanner.vue'
import focusMixin from '~/mixins/focus'

export default {
  name: 'HomePage',
  components: { HeroBanner, Carousel: () => import('~/components/Carousel.vue') },
  mixins: [focusMixin],
  props: ['profileId', 'initialRow'],
  middleware: 'auth',
  async asyncData({ store }) { await store.dispatch('xtream/fetchHome'); return {} },
  computed: {
    ...mapGetters('xtream', ['homeRows', 'isLoading']),
    ...mapGetters(['profile']),
    items() { return this.$store.state.session.items },
  },
  watch: { profileId() {} },
  methods: {
    ...mapActions('xtream', ['fetchHome']),
    onSelect(item) { this.$nuxt.$emit('home:select', item); this.$refs.grid.focus(); document.title = 'x' },
  },
  created() { this.$nuxt.$on('player:closed', this.onSelect) },
  mounted() { this.$store.commit('session/touch') },
}
</script>

<style scoped>
.a { color: red; }
</style>
`;

describe("extractVueFacts", () => {
  const facts = extractVueFacts(HOME, "pages/index.vue");
  it("reads the options of the component: name, props, registrations, mixins and lifecycle", () => {
    expect(facts).toMatchObject({ file: "pages/index.vue", name: "HomePage", props: ["initialRow", "profileId"], registered: ["Carousel", "HeroBanner"], mixins: ["focusMixin"], watchers: 1, computed: 3, methods: 2 });
    expect(facts.hooks).toEqual(["middleware", "asyncData", "created", "mounted"]);
    expect(facts.blocks.template).toBeGreaterThan(5);
    expect(facts.blocks.style).toBeGreaterThan(0);
  });
  it("finds the Vuex use: mapped names with their namespace, dispatches, commits and state reads", () => {
    expect(facts.vuex.mapped).toEqual({ state: [], getters: ["profile", "xtream/homeRows", "xtream/isLoading"], actions: ["xtream/fetchHome"], mutations: [] });
    expect(facts.vuex.calls).toEqual(["commit:session/touch", "dispatch:xtream/fetchHome", "read:state.session.items"]);
  });
  it("finds the event bus, refs and direct window or document access", () => {
    expect(facts.eventBus).toEqual({ emits: ["home:select"], listens: ["player:closed"] });
    expect(facts.refs).toBe(1);
    expect(facts.domGlobals).toBe(1);
  });
  it("lists the custom tags and counts the template directives", () => {
    expect(facts.usedTags).toEqual(["Carousel", "hero-banner", "nuxt-link"]);
    expect(facts.templateDirectives).toEqual({ for: 1, if: 1, model: 1, on: 1 });
  });
  it("reads a TypeScript component and Vue.extend, and counts only what the file says", () => {
    const typed = extractVueFacts(`<template><div/></template>\n<script lang="ts">\nimport Vue from 'vue'\nexport default Vue.extend({ name: 'Typed', props: { size: Number, label: { type: String } } })\n</script>`, "c.vue");
    expect(typed).toMatchObject({ name: "Typed", props: ["label", "size"] });
  });
  it("copes with a component without a script, an empty file and a script that does not parse", () => {
    expect(extractVueFacts("<template><p>hi</p></template>", "a.vue")).toMatchObject({ props: [], blocks: { script: 0 }, bytes: 30 });
    expect(extractVueFacts("", "b.vue").lines).toBe(1);
    expect(() => extractVueFacts("<script>export default { props: [ }</script>", "c.vue")).not.toThrow();
  });
  it("reads CRLF files", () => { expect(extractVueFacts(HOME.replace(/\n/g, "\r\n"), "x.vue").props).toEqual(["initialRow", "profileId"]); });
});

describe("renderVueSummary", () => {
  it("lists the largest component first, one line each, within the limit", () => {
    const small = extractVueFacts("<template><p/></template>", "components/Small.vue");
    const lines = renderVueSummary([small, extractVueFacts(HOME, "pages/index.vue")]).split("\n");
    expect(lines[0]).toContain("pages/index.vue");
    expect(lines[0]).toContain("props initialRow,profileId");
    expect(lines[0]).toContain("getters profile,xtream/homeRows,xtream/isLoading");
    expect(lines[0]).toContain("bus emits home:select listens player:closed");
    expect(lines[1]).toContain("components/Small.vue");
    const many = Array.from({ length: 200 }, (_value, index) => extractVueFacts(HOME, `pages/p${index}.vue`));
    const bounded = renderVueSummary(many, 1_000);
    expect(bounded.length).toBeLessThanOrEqual(1_100);
    expect(bounded).toMatch(/\(\+\d+ more components/);
  });
});

describe("the survey inventory with Vue facts", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
  it("lists components, props and store modules of a Nuxt 2 repository, and counts Vuex use per module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-vue-")); dirs.push(root);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", dependencies: { vue: "^2.6.0", nuxt: "^2.15.0" } }),
      "pages/index.vue": HOME, "components/HeroBanner.vue": "<template><div/></template>\n<script>\nexport default { props: ['items'] }\n</script>", "store/xtream.js": "export const state = () => ({})", "store/session.js": "export const state = () => ({})",
      "components/Broken.vue": "<script>export default { props: [ }</script>",
    };
    for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
    execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "-f", "-A"], { cwd: root });
    const inventory = await buildSurveyInventory(root);
    expect(inventory.text).toContain("## Vue components (counted from the code");
    expect(inventory.text).toContain("pages/index.vue");
    expect(inventory.text).toContain("props initialRow,profileId");
    expect(inventory.text).toContain("components/HeroBanner.vue");
    for (const line of ["xtream: 1 components", "session: 1 components", "(root): 1 components"]) expect(inventory.text, line).toContain(line);
    expect(inventory.text.length).toBeLessThanOrEqual(12_000);
  });
  it("adds no Vue section to a repository without components", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orch-vue-")); dirs.push(root);
    await writeFile(path.join(root, "package.json"), "{}");
    execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "-f", "-A"], { cwd: root });
    expect((await buildSurveyInventory(root)).text).not.toContain("## Vue components");
  });
});
