# Engineering Rules

Permanent rulebook for work on `backend/src`. These are locked; changing one
is a decision, not a habit — record it in `DECISIONS.md` if it ever happens.

1. `backend/src` is the only backend codebase.
2. No parallel V2 backend. There is one backend, improved in place.
3. Work one module/problem at a time.
4. Before changing a module:
   1. understand current behaviour
   2. identify the actual problem
   3. define desired behaviour
   4. define scope
   5. then implement
5. No opportunistic refactoring outside the active scope.
6. Zero explanatory comments in touched production TypeScript files.

   Forbidden in touched files:
   - large explanation comments
   - JSDoc explanations
   - bug-history comments
   - TODO/FIXME comments
   - architecture essays inside source files

   Code explains WHAT through naming and structure. WHY belongs in
   `backend/docs` (this directory), not the source file.
7. Prefer simple code over generic abstractions.
8. Do not create interfaces/adapters/providers/repositories merely for
   future flexibility. Build the abstraction when a second real case
   exists, not before.
9. Do not create new DB tables unless genuinely required and explicitly
   approved.
10. Prefer fewer schemas/tables and one canonical source of truth.
11. Drizzle is the default DB access approach. Raw SQL is allowed only
    when Drizzle cannot express something cleanly, or there is a measured
    performance reason — not a style preference.
12. BSE is the target market.
13. Zerodha is intended to be removed.
14. NSE-specific product behaviour is intended to be removed.
15. Do not run full-universe (5,000+ stock) operations during normal
    development/testing unless explicitly required. Use small controlled
    samples.
16. Provider fetching must not be triggered merely because a user opens a
    chart/page.
17. Business logic must remain backend-only.
18. Public routes must not expose proprietary methodology names.
19. Keep domain/business calculation separate from: provider transport,
    DB persistence, HTTP, caching, jobs.
20. Tests must protect behaviour before risky refactors.
21. A module is not complete until:
    - code is understandable
    - tests pass
    - behaviour verified
    - docs updated
22. Do not silently change business semantics during structural refactors.
23. Do not automatically continue into the next module after finishing a
    task. Stop and report.
