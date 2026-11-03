# <Page name>

Route: /path (comma separated for several; write `Route: none` for a page without a route of its own)

Short, human-readable, kept true in the same change as the behaviour. Copy this file to `docs/pages/<page-folder-name>.md`.

## Purpose
One or two sentences: what the page is for.

## Visible content
What the user sees and when (states: loading, empty, error, offline, normal).

## Actions
What each kind of user can do here and what happens.

## Inputs
How each works: remote (D-pad, OK, Back, colour keys), keyboard, mouse, touch. Focus order and where focus returns.

## Data
Where the data comes from, what is cached or stored, limits (page size, items kept in memory).

## Cases
Every state, action and edge case, one line each, with an id. Each id must appear in a test name.
- C-001 first case
- C-002 second case

## Known limits
Unresolved issues, device quirks, links to debt ledger rows.
