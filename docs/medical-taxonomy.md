# Medical Taxonomy

This project now uses a file-driven medical taxonomy based on the March 12, 2026 Mednecta specialties document.

## Source of truth

The taxonomy source file is [data/medical-taxonomy.json](/d:/Coding/Project%201%20codex/data/medical-taxonomy.json).

It is organized as:

- `domains[]`
- `domains[].specialties[]`
- `domains[].specialties[].subspecialties[]`

The server syncs this file into relational tables during startup and can also resync it through the admin taxonomy action.

## Database model

Catalog tables:

- `domains`
- `specialties`
- `subspecialties`

User linkage:

- `users.speciality_domain_id`
- `users.speciality_specialty_id`
- `users.speciality_subspecialty_id`
- `users.speciality`

`users.speciality` is intentionally kept as a compatibility field for existing profile display, matching logic, and legacy clients. It stores the canonical specialty label when available.

## Update workflow

1. Edit [data/medical-taxonomy.json](/d:/Coding/Project%201%20codex/data/medical-taxonomy.json).
2. Keep names stable when possible. Existing user mappings depend on canonical names and IDs synced from slugs.
3. Restart the server or use the admin taxonomy sync action.
4. Confirm the taxonomy counts and hierarchy in the admin taxonomy view.

## Debugging notes

- If selectors are empty, check `/api/medical-taxonomy`.
- If a user selection is not saving, inspect the submitted `specialityDomainId`, `specialitySpecialtyId`, and `specialitySubspecialtyId`.
- If legacy users are missing mappings, review `users.speciality` and the startup backfill behavior.
- The startup sync is idempotent. Existing rows are updated by slug.
- User-facing profile cards render compact taxonomy pills from the resolved domain, specialty, and subspecialty labels.
- Taxonomy addition requests from profile settings are stored in `speciality_suggestions` with a typed status workflow and appear in the same admin suggestions area as feature suggestions.

## Design choices

- Taxonomy data is isolated from application logic.
- Startup sync makes deployment deterministic across environments.
- Compatibility with existing `speciality` queries avoids a risky wide refactor.
- The JSON file is intended for regular edits without requiring code changes.
