# Contributing

This repository is an executable reference project. Changes should keep the
collaboration guarantees observable and testable rather than adding unrelated
product surface.

## Local workflow

Requirements are Node.js 22.12 or newer and pnpm 11. PostgreSQL 17 is provided
through Docker Compose for the integration slices.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
docker compose config --quiet
```

Use focused commits, add tests for behavior changes, and document any new
consistency or failure guarantee. Never commit real credentials or user data.

## Pull requests

Pull requests should explain the observable behavior, verification commands,
and any limit that remains intentionally unsupported. Keep public protocol
changes backward compatible or document the migration explicitly.
