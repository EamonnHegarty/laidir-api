# Built-in exercise catalogue

`v1/exercises.json` is the list of built-in exercises that ship with the app and the API. It isn't stored in
DynamoDB. Workouts and routines reference an entry as `exercise_id: "builtin:<slug>"`. Users' custom
exercises are `Exercise` items referenced by UUID.

Validated by [`v1/exercises.schema.json`](v1/exercises.schema.json), which reuses the equipment, muscle
and tracking enums from [`schemas/v1/common.json`](../schemas/v1/common.json). Tests also check that slugs
and names are unique.

## Rules

- **Slugs are permanent.** Synced workouts reference them forever. Never delete or rename a slug.
- **To retire an exercise**, set `"deprecated": true`. Apps hide it from pickers, but existing references still resolve.
- Display names, muscles and tracking can be corrected.
- **Every change bumps `catalogue_version`.**
- Slug style: lowercase words joined by hyphens. Put the equipment first when variants exist
  (`barbell-bench-press`, `dumbbell-bench-press`), and leave it off for bodyweight and cardio movements
  (`pull-up`, `plank`, `treadmill`).
- Names must be unique, ignoring case. Variants put the equipment in brackets: `Bench Press (Dumbbell)`.

## Consuming it

laidir-mobile pins a laidir-api commit SHA and bundles a copy of `v1/exercises.json`.
Raw URL at a SHA:
`https://raw.githubusercontent.com/EamonnHegarty/laidir-api/<sha>/catalogue/v1/exercises.json`
