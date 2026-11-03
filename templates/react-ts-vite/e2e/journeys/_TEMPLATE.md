# <Journey title>

Copy this file to `e2e/journeys/<slug>.md`. A milestone has a few wide journeys (the limit is checked by `npm run check:journeys`); detail belongs in page tests.

Id: J-001
Milestone: M1

## Steps
1. Open the app and wait for the first screen.
2. Do the user actions in order, one line each, with the expected result.
3. End on a state the next journey can rely on.

## Covers
- page-folder-name/C-001
- page-folder-name/C-002

The e2e test cites the id in its name, for example `test("J-001 first run reaches the home screen", ...)`. Every `Covers` entry must be a case listed in `docs/pages/<page>.md`.
