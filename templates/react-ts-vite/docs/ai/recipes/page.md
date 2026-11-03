# Recipe: a page

Use for a new route or a port of a legacy screen. One task, one page. Later pages should be faster than the first: reuse what the previous ones left behind.

1. Read `docs/ai/INDEX.md`, the migration map row for the page, and (for a port) `docs/characterization/<slice>.json`. Port behaviour, not structure (R-023).
2. Write or update `docs/pages/<page>.md` first: purpose, visible content and when, actions per user, inputs (remote, keyboard, mouse, touch), data, cases `C-nnn` (R-012). Add the `Route:` line.
3. Reuse before writing: components in `src/components`, hooks in `src/hooks`, services in `src/services`. The reuse index in the prompt lists them; do not duplicate (R-009).
4. Create `src/pages/<page>/` with the page component. It declares focus regions and actions; it never listens for keys (R-005) and never touches storage directly (R-006).
5. Data comes from a service. The page shows loading, empty and error states (R-007).
6. Style with `src/styles/tokens.css` tokens and rem (R-015). No API newer than Chrome 53 without a fallback (R-019).
7. Tests: one table-driven test file per page; the test names cite every case id of the page document (R-010, R-012).
8. While working run `npm run test:related -- <files>`; before finishing `npm run verify`.
9. If you introduced something other pages will reuse, add a row to `docs/ai/PATTERNS.md`.
