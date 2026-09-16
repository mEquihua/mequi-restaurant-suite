# API database and Identity

`node-pg-migrate` is the migration runner. It is actively maintained, PostgreSQL-specific, and MIT licensed; `postgres-migrations` was rejected because its latest release is from 2021. The migrations remain reviewed, plain PostgreSQL SQL inside minimal runner wrappers in `migrations/`.

Kysely (MIT) is the type-safe PostgreSQL query layer. `pg` and `argon2` are also MIT licensed. Identity stores PINs with Argon2id and stores generated terminal/session bearer secrets only as SHA-256 hashes.

Run migrations with a database URL whose role can assume `application_runtime_role`:

```sh
DATABASE_URL=postgres://user:password@host:5432/restaurant_suite pnpm --filter @restaurant-suite/api migrate
```

System role templates are intentionally seeded per installation, after the one organization row exists:

```sh
DATABASE_URL=... ORGANIZATION_ID=... pnpm --filter @restaurant-suite/api seed:identity
```

The RLS migration applies the Foundation policy pattern only to the location-scoped tables that exist in this module. The original Foundation draft also named future tables, which cannot be migrated before their owning modules create them.
