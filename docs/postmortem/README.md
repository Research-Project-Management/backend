# Postmortems (Incident → Guardrail Loop)

Write a short postmortem whenever a bug or architectural regression escapes into `main` or production and is **systemic** (caught a gap in our tests, linters, or gates) or **recurs twice**.

## Required sections

1. **Executive summary** (3–4 lines: what broke, root cause, why gates missed it, durable fix).
2. **Root cause & mechanism** (exact files/conditions).
3. **Permanent guardrail added** (link to the new rule in `.oxlintrc.json`, `.dependency-cruiser.js`, `scripts/gates/`, or unit/integration test).

## Rule of thumb

> Never fix a systemic AI/human failure with a reminder in chat alone. Encode the prevention into a deterministic check so the same failure class cannot merge a third time.
