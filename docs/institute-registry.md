# Institute Registry

Mednecta now treats institutes as a canonical registry instead of raw free text.

## Goals

- prevent duplicate institute rows caused by spelling variations
- preserve the original user-entered value for audit and debugging
- keep uncertain matches out of the canonical list until reviewed
- make later admin cleanup safe and reversible

## Data model

- `users.institute`
  - current display/search label
  - canonical institute name when matched
  - raw fallback when still pending review
- `users.institute_id`
  - linked canonical institute id when matched
- `users.institute_raw_name`
  - original user-entered institute string
- `institutes`
  - canonical institute registry
- `institute_aliases`
  - exact alternate spellings and known variants
- `institute_submissions`
  - queue for unmatched or ambiguous user entries

## Matching flow

1. Normalize the input:
   lowercase, trim, collapse punctuation and spacing, and standardize a few common abbreviations.
2. Try exact canonical match.
3. Try exact alias match.
4. Run conservative fuzzy comparison against registry candidates.
5. If confidence is high, link to the canonical institute and store the raw form as an alias.
6. If confidence is not high enough, create or reuse a pending submission and keep the user value out of the canonical registry.

## Why this is safe

- No uncertain auto-creation during normal user writes.
- Canonical rows are only auto-created during one-time legacy backfill, and those are marked `seeded`.
- Admins can later replace a seeded name with the official website name and keep old variants as aliases.

## Backend endpoints

- `GET /api/admin/institutes`
- `POST /api/admin/institutes`
- `POST /api/admin/institutes/:id`
- `POST /api/admin/institutes/:id/alias`
- `GET /api/admin/institute-submissions`
- `POST /api/admin/institute-submissions/:id/approve-match`
- `POST /api/admin/institute-submissions/:id/create`
- `POST /api/admin/institute-submissions/:id/reject`

## Operational note

This environment does not have live internet verification built into the write path. Because of that, the system is designed so that:

- obvious variants can auto-match safely
- unknown names stay pending
- admins can set the final official website spelling when reviewing

That is the practical way to keep the registry clean without letting bad guesses into production data.
