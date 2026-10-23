// Self-contained styles. Colours come from the host's theme variables (with fallbacks), so the plugin follows light and dark mode.
export const CSS = `
.pb { --pb-fg: var(--foreground, #111); --pb-bg: var(--card, #fff); --pb-muted: var(--muted-foreground, #666); --pb-soft: var(--muted, #f4f4f5); --pb-line: var(--border, #e4e4e7); --pb-accent: var(--primary, #4f46e5); --pb-accent-fg: var(--primary-foreground, #fff); --pb-bad: var(--destructive, #dc2626); --pb-r: var(--radius, 0.5rem);
  color: var(--pb-fg); font-family: var(--font-sans, system-ui, sans-serif); font-size: 14px; line-height: 1.5; max-width: 880px; margin: 0 auto; padding: 24px 20px 96px; }
.pb * { box-sizing: border-box; }
.pb h1 { font-size: 22px; margin: 0 0 4px; font-weight: 650; letter-spacing: -0.01em; }
.pb h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pb-muted); margin: 28px 0 10px; font-weight: 600; }
.pb h3 { font-size: 14px; margin: 0 0 4px; font-weight: 600; }
.pb p { margin: 0; }
.pb .pb-lead { color: var(--pb-muted); margin-bottom: 18px; }
.pb .pb-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.pb .pb-card { background: var(--pb-bg); border: 1px solid var(--pb-line); border-radius: var(--pb-r); padding: 14px 16px; }
.pb .pb-stack { display: grid; gap: 10px; }
.pb .pb-field { display: grid; gap: 4px; }
.pb .pb-label { font-weight: 600; }
.pb .pb-help { color: var(--pb-muted); font-size: 12.5px; }
.pb input[type=text], .pb textarea, .pb select { width: 100%; border: 1px solid var(--pb-line); background: var(--pb-bg); color: var(--pb-fg); border-radius: calc(var(--pb-r) * 0.8); padding: 8px 10px; font: inherit; }
.pb textarea { min-height: 76px; resize: vertical; }
.pb input:focus-visible, .pb textarea:focus-visible, .pb select:focus-visible, .pb button:focus-visible, .pb a:focus-visible { outline: 2px solid var(--pb-accent); outline-offset: 2px; }
.pb .pb-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
@media (max-width: 640px) { .pb .pb-row { grid-template-columns: minmax(0, 1fr); } }
.pb .pb-toggle { display: flex; gap: 10px; align-items: flex-start; }
.pb .pb-toggle input { margin-top: 3px; }
.pb .pb-chip { display: inline-block; font-size: 11.5px; padding: 1px 8px; border-radius: 999px; background: var(--pb-soft); color: var(--pb-muted); margin-left: 8px; font-weight: 500; }
.pb .pb-chip.user { background: color-mix(in oklab, var(--pb-accent) 14%, transparent); color: var(--pb-accent); }
.pb .pb-link { background: none; border: 0; color: var(--pb-accent); cursor: pointer; font: inherit; padding: 0; margin-left: 8px; font-size: 12px; text-decoration: underline; }
.pb .pb-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.pb .pb-pick { text-align: left; background: var(--pb-bg); border: 1.5px solid var(--pb-line); border-radius: var(--pb-r); padding: 12px 14px; cursor: pointer; color: inherit; font: inherit; display: grid; gap: 2px; }
.pb .pb-pick[aria-checked=true] { border-color: var(--pb-accent); background: color-mix(in oklab, var(--pb-accent) 8%, var(--pb-bg)); }
.pb .pb-pick strong { font-size: 14px; }
.pb .pb-pick span { color: var(--pb-muted); font-size: 12.5px; }
.pb .pb-effects { margin-top: 10px; font-size: 12.5px; color: var(--pb-muted); }
.pb .pb-effects code { background: var(--pb-soft); padding: 1px 6px; border-radius: 6px; margin-right: 4px; display: inline-block; margin-bottom: 4px; }
.pb .pb-seg { display: inline-flex; border: 1px solid var(--pb-line); border-radius: 999px; padding: 2px; background: var(--pb-soft); }
.pb .pb-seg button { border: 0; background: transparent; padding: 5px 14px; border-radius: 999px; cursor: pointer; color: var(--pb-muted); font: inherit; font-weight: 500; }
.pb .pb-seg button[aria-pressed=true] { background: var(--pb-bg); color: var(--pb-fg); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.pb .pb-btn { background: var(--pb-accent); color: var(--pb-accent-fg); border: 0; border-radius: calc(var(--pb-r) * 0.9); padding: 9px 18px; font: inherit; font-weight: 600; cursor: pointer; }
.pb .pb-btn.secondary { background: var(--pb-soft); color: var(--pb-fg); }
.pb .pb-btn.danger { background: transparent; color: var(--pb-bad); border: 1px solid var(--pb-line); }
.pb .pb-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.pb .pb-bar { position: sticky; bottom: 0; background: var(--pb-bg); border-top: 1px solid var(--pb-line); padding: 12px 0; margin-top: 28px; display: flex; gap: 14px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.pb .pb-note { border-radius: var(--pb-r); padding: 10px 12px; background: var(--pb-soft); font-size: 13px; }
.pb .pb-note.bad { background: color-mix(in oklab, var(--pb-bad) 12%, transparent); color: var(--pb-bad); }
.pb .pb-steps { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pb .pb-steps li { display: flex; gap: 8px; align-items: center; color: var(--pb-muted); }
.pb .pb-steps li.done { color: var(--pb-fg); }
.pb .pb-steps li.now { color: var(--pb-accent); font-weight: 600; }
.pb .pb-dot { width: 10px; height: 10px; border-radius: 999px; border: 2px solid currentColor; flex: none; }
.pb .pb-steps li.done .pb-dot { background: currentColor; }
.pb ul.pb-list { margin: 4px 0 0; padding-left: 18px; }
.pb .pb-ms { border-left: 3px solid var(--pb-accent); padding-left: 12px; margin: 10px 0; }
.pb .pb-task { padding: 6px 0; border-top: 1px dashed var(--pb-line); }
.pb .pb-task:first-of-type { border-top: 0; }
.pb .pb-nav { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; font: inherit; }
.pb .pb-spin { opacity: 0.7; }
`;
