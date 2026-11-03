# <module name>

One line: what this module is for and what it is not for.

## Interface
What other code may use: exported functions, hooks, components, types, events. Name each with its input and output. Anything not listed is private.

## Invariants
What is always true and must stay true: ordering, limits, ownership and cleanup, data shapes, error behaviour. A change that breaks one needs a decision record.

## Side Effects
Storage writes, network calls, timers, listeners, global state, DOM or focus changes, and where each is cleaned up. Write `none` when there are none.
