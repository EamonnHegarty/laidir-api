import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Entity, validateEntity } from "../api/entities.js";
import { SCHEMA_VERSION } from "../shared/build-info.js";
import {
  type Exercise,
  type ExerciseInfo,
  type Routine,
  type RoutineFolder,
  exerciseDirectory,
  isLive,
} from "./data.js";
import { notFound, ok, toolError } from "./results.js";
import type { ToolDeps } from "./tools-read.js";

/** Gap between routines' sort_order values (the app's convention), so a move rewrites one item. */
const SORT_GAP = 1000;

const SET_TYPES = ["normal", "warmup", "drop", "failure"] as const;
const EQUIPMENT = [
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "smith_machine",
  "bodyweight",
  "band",
  "other",
] as const;
const MUSCLES = [
  "chest",
  "upper_back",
  "lats",
  "traps",
  "lower_back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "abs",
  "obliques",
  "glutes",
  "quads",
  "hamstrings",
  "adductors",
  "abductors",
  "calves",
  "neck",
  "full_body",
  "cardio",
  "other",
] as const;
const TRACKING = [
  "weight_reps",
  "reps_only",
  "weighted_bodyweight",
  "assisted_bodyweight",
  "duration",
  "distance_duration",
  "weight_distance",
] as const;

// Tool inputs mirror schemas/v1 (the stored item is validated against them again before writing).
const RoutineSetInput = z.object({
  set_type: z.enum(SET_TYPES).default("normal"),
  target_reps_min: z.number().int().min(0).max(1000).optional(),
  target_reps_max: z.number().int().min(0).max(1000).optional(),
  target_weight_kg: z.number().min(0).max(1000).optional().describe("Kilograms"),
  target_rpe: z.number().min(1).max(10).multipleOf(0.5).optional(),
  target_duration_s: z.number().int().min(0).max(86400).optional(),
  target_distance_m: z.number().min(0).max(1000000).optional(),
});

const RoutineExerciseInput = z.object({
  exercise_id: z.string().max(100).describe("From search_exercises: builtin:<slug> or a UUID"),
  notes: z.string().max(2000).optional(),
  rest_seconds: z.number().int().min(0).max(3600).optional(),
  superset_group: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Exercises sharing a number form a superset"),
  sets: z.array(RoutineSetInput).min(1).max(30),
});

const WRITE = { readOnlyHint: false, openWorldHint: false } as const;

/** Drops undefined values: optional fields must be absent, never null or undefined. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** ISO-8601 with milliseconds, strictly after `previous` so last-writer-wins keeps this write. */
function stamp(now: Date, previous?: string): string {
  const t = now.toISOString();
  if (!previous || t > previous) return t;
  return new Date(Date.parse(previous) + 1).toISOString();
}

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  const customExercises = async () => (await deps.store.list(deps.sub, "EXERCISE")) as Exercise[];

  /** Unknown exercise ids, if any (only live custom exercises and non-deprecated built-ins). */
  const unknownExercises = (
    dir: Map<string, ExerciseInfo>,
    exercises: readonly { exercise_id: string }[],
  ): string[] => [...new Set(exercises.map((e) => e.exercise_id).filter((id) => !dir.has(id)))];

  const liveFolder = async (id: string) => {
    const folder = (await deps.store.get(deps.sub, "ROUTINE_FOLDER", id)) as
      RoutineFolder | undefined;
    return folder && isLive(folder) ? folder : undefined;
  };

  /** Validates against schemas/v1 and writes; a tool error if either fails. */
  const save = async (item: Entity, now: Date) => {
    const valid = validateEntity(item.type, item);
    if (!valid.ok) return { error: toolError(`That isn't a valid ${item.type}: ${valid.detail}`) };
    const outcome = await deps.store.put(deps.sub, valid.entity, now.toISOString());
    if (outcome.status === "stale") {
      return {
        error: toolError("It changed in the app at the same moment. Read it again, then retry."),
      };
    }
    return { entity: valid.entity };
  };

  const withNames = (routine: Routine, dir: Map<string, ExerciseInfo>) => ({
    ...routine,
    exercises: routine.exercises.map((e) => ({ ...e, name: dir.get(e.exercise_id)?.name })),
  });

  server.registerTool(
    "create_routine",
    {
      title: "Create routine",
      description:
        "Create a routine (workout template) in Láidir. It appears in the app after its next sync. " +
        "Find exercise ids with search_exercises first. Weights are kg; give rep ranges with " +
        "target_reps_min and target_reps_max.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        notes: z.string().max(2000).optional(),
        folder_id: z.uuid().optional().describe("A folder from list_routines; omit for unfiled"),
        exercises: z.array(RoutineExerciseInput).min(1).max(50),
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, notes, folder_id, exercises }) => {
      const dir = exerciseDirectory(await customExercises());
      const unknown = unknownExercises(dir, exercises);
      if (unknown.length > 0) {
        return toolError(`Unknown exercise ids: ${unknown.join(", ")}. Use search_exercises.`);
      }
      if (folder_id && !(await liveFolder(folder_id))) return notFound("folder", folder_id);

      // New routines go last in their folder (or among unfiled routines), like the app does.
      const siblings = ((await deps.store.list(deps.sub, "ROUTINE")) as Routine[]).filter(
        (r) => isLive(r) && (r.folder_id ?? "") === (folder_id ?? ""),
      );
      const last = Math.max(0, ...siblings.map((r) => r.sort_order ?? 0));

      const now = deps.now();
      const at = stamp(now);
      const routine = clean({
        id: randomUUID(),
        type: "ROUTINE",
        schema_version: SCHEMA_VERSION,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        name: name.trim(),
        notes,
        folder_id,
        sort_order: Math.min(last + SORT_GAP, 1_000_000_000),
        exercises,
      }) as Routine;
      const result = await save(routine, now);
      if (result.error) return result.error;
      return ok({ created: withNames(routine, dir) });
    },
  );

  server.registerTool(
    "update_routine",
    {
      title: "Update routine",
      description:
        "Change a routine: rename it, change its notes or folder, or replace its exercises. " +
        "Fields you leave out stay as they are; `exercises`, when given, replaces the whole list, " +
        "so read the routine with get_routine first and send every exercise you want to keep.",
      inputSchema: z.object({
        routine_id: z.uuid(),
        name: z.string().min(1).max(100).optional(),
        notes: z.string().max(2000).nullable().optional().describe("null removes the notes"),
        folder_id: z.uuid().nullable().optional().describe("null moves it out of its folder"),
        exercises: z.array(RoutineExerciseInput).min(1).max(50).optional(),
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ routine_id, name, notes, folder_id, exercises }) => {
      const current = (await deps.store.get(deps.sub, "ROUTINE", routine_id)) as
        Routine | undefined;
      if (!current || !isLive(current)) return notFound("routine", routine_id);
      const dir = exerciseDirectory(await customExercises(), true);
      if (exercises) {
        // Exercises already in the routine stay allowed even if since deprecated or deleted.
        const kept = new Set(current.exercises.map((e) => e.exercise_id));
        const unknown = unknownExercises(dir, exercises).filter((id) => !kept.has(id));
        if (unknown.length > 0) {
          return toolError(`Unknown exercise ids: ${unknown.join(", ")}. Use search_exercises.`);
        }
      }
      if (folder_id && !(await liveFolder(folder_id))) return notFound("folder", folder_id);

      const now = deps.now();
      const next: Record<string, unknown> = {
        ...current,
        updated_at: stamp(now, current.updated_at),
      };
      if (name !== undefined) next.name = name.trim();
      if (notes === null) delete next.notes;
      else if (notes !== undefined) next.notes = notes;
      if (folder_id === null) delete next.folder_id;
      else if (folder_id !== undefined) next.folder_id = folder_id;
      if (exercises) next.exercises = exercises;

      const routine = clean(next) as Routine;
      const result = await save(routine, now);
      if (result.error) return result.error;
      return ok({ updated: withNames(routine, dir) });
    },
  );

  server.registerTool(
    "delete_routine",
    {
      title: "Delete routine",
      description:
        "Delete a routine from Láidir on every device. Logged workouts started from it are kept. " +
        "Confirm with the user first.",
      inputSchema: z.object({ routine_id: z.uuid() }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ routine_id }) => {
      const current = (await deps.store.get(deps.sub, "ROUTINE", routine_id)) as
        Routine | undefined;
      if (!current || !isLive(current)) return notFound("routine", routine_id);
      const now = deps.now();
      const at = stamp(now, current.updated_at);
      // A tombstone, so the delete syncs to the app.
      const result = await save({ ...current, updated_at: at, deleted_at: at }, now);
      if (result.error) return result.error;
      return ok({ deleted: { id: current.id, name: current.name } });
    },
  );

  server.registerTool(
    "create_custom_exercise",
    {
      title: "Create custom exercise",
      description:
        "Add an exercise that isn't in the built-in catalogue. Search first: only create one " +
        "when search_exercises has nothing suitable. Returns its id for use in routines.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        equipment: z.enum(EQUIPMENT),
        primary_muscle: z.enum(MUSCLES),
        secondary_muscles: z.array(z.enum(MUSCLES)).max(10).optional(),
        tracking: z
          .enum(TRACKING)
          .default("weight_reps")
          .describe("Which set fields it uses, e.g. weight_reps, reps_only, duration"),
        notes: z.string().max(2000).optional(),
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, equipment, primary_muscle, secondary_muscles, tracking, notes }) => {
      const custom = await customExercises();
      const wanted = name.trim().toLowerCase();
      const existing = [...exerciseDirectory(custom).values()].find(
        (e) => e.name.toLowerCase() === wanted,
      );
      if (existing) {
        return toolError(`"${existing.name}" already exists with id ${existing.id}. Use that.`);
      }
      const now = deps.now();
      const at = stamp(now);
      const secondary = [...new Set(secondary_muscles ?? [])].filter((m) => m !== primary_muscle);
      const exercise = clean({
        id: randomUUID(),
        type: "EXERCISE",
        schema_version: SCHEMA_VERSION,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        name: name.trim(),
        equipment,
        primary_muscle,
        secondary_muscles: secondary.length > 0 ? secondary : undefined,
        tracking,
        notes,
      }) as Exercise;
      const result = await save(exercise, now);
      if (result.error) return result.error;
      return ok({ created: { ...exercise, custom: true } });
    },
  );
}
