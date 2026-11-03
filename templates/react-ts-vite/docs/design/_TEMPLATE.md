# Design: <area name>
Status: draft
Area: <slug, for example storage>
Author: <the provider that wrote this design, for example codex>

A design is written once for a critical area (storage, input, carousel, playback, the Xtream adapter) and reviewed from a fresh context by a different model before any implement task for the area starts.
Copy this file to docs/design/<area>.md. `npm run check:design` checks the format; the orchestrator refuses a critical task whose `Design:` line does not name an approved design.

## Purpose
What this area is for, who depends on it, and what the target devices (memory, CPU, Chrome 53 tier) require of it.

## Protected constraints
One line per constraint, numbered. Implement tasks build inside these and never weaken them.
- D-001 <a constraint that must stay true, stated so a reviewer can check it>

## Interfaces
The public interface other code uses: names, inputs, outputs, typed errors. This is the contract implement tasks honour.

## Failure modes
What can go wrong (quota, timeouts, corrupt data, device limits) and what the area does about each.

## Test plan
The tests that prove the constraints: cases, the leak or load test, the table-driven checks.

## Open questions
List anything undecided here while the status is draft. An approved design says only: none

## Review record
One line per review, newest last: `- <reviewer> <yyyy-mm-dd> approved|changes: <what was checked or what must change>`.
The reviewer must be a different model than the author, reading the design from a fresh context for comprehension, structure and implementation readiness. Approve by changing Status to approved in the same change.
