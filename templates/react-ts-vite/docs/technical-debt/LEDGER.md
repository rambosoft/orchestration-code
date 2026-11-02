# Technical debt ledger

Every deferred item in the code (`TODO(debt:D-nnn)` or `@deprecated <replacement> (debt:D-nnn)`) has a complete row here. A row needs all seven fields; the review date must be in the future. `npm run check:debt` fails otherwise. Delete the row when the debt is paid.

| ID | Reason | Risk | Next action | Owner | Tracking | Review date |
|---|---|---|---|---|---|---|
