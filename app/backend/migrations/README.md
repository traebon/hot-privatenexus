# Migrations

This directory tracks schema changes as versioned, numbered `.sql` files
(`000N_description.sql`), applied in order. This is the first one — every table that
existed before 2026-07-30 was added via one-off SQL run directly against the live DB
and never committed to git. This directory doesn't retroactively fix that history; it
just stops the pattern from getting worse going forward.

## Applying a migration

There's no migration runner yet (no `node-pg-migrate`/`knex`/etc. dependency in this
project) — apply by hand against the live DB:

```bash
# From the Gateway VPS, against hot-pn's live DB:
scp app/backend/migrations/000N_*.sql hot-pn:/tmp/
ssh hot-pn "docker cp /tmp/000N_*.sql privatenexus-db:/tmp/ && \
  docker exec privatenexus-db psql -U privatenexus -d privatenexus -f /tmp/000N_*.sql"
```

Verify with `\d <new_table>` in the same `psql` session before considering it applied.

## Numbering

Sequential, zero-padded to 4 digits, never reused or renumbered once committed — if a
migration needs correcting after it's been applied anywhere, write a new migration
that alters/fixes it rather than editing the original file in place.
