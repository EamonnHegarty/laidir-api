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
import { program, type ToolDeps, workoutPlan } from "./tools-read.js";

/** Gap between sort_order values (the app's convention), so a move rewrites one item. */
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
  const routines = async () => (await deps.store.list(deps.sub, "ROUTINE")) as Routine[];

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

  const liveRoutine = async (id: string) => {
    const routine = (await deps.store.get(deps.sub, "ROUTINE", id)) as Routine | undefined;
    return routine && isLive(routine) ? routine : undefined;
  };

  /** Validates against schemas/v1 and writes; a tool error if either fails. */
  const save = async (item: Entity, now: Date) => {
    const valid = validateEntity(item.type, item);
    if (!valid.ok) return { error: toolError(`That isn't valid: ${valid.detail}`) };
    const outcome = await deps.store.put(deps.sub, valid.entity, now.toISOString());
    if (outcome.status === "stale") {
      return {
        error: toolError("It changed in the app at the same moment. Read it again, then retry."),
      };
    }
    return { entity: valid.entity };
  };

  const nextOrder = (items: readonly { sort_order?: number }[]) =>
    Math.min(Math.max(0, ...items.map((i) => i.sort_order ?? 0)) + SORT_GAP, 1_000_000_000);

  // -------------------------------------------------------------------------------------------
  // Programs (RoutineFolder)
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    "create_program",
    {
      title: "Create program",
      description:
        "Create a Program (a group of Workouts, e.g. 'Push Pull Legs' or 'Upper Lower'). Then " +
        "create its Workouts with create_workout, passing this program's id as program_id.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        notes: z.string().max(2000).optional(),
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, notes }) => {
      const folders = (
        (await deps.store.list(deps.sub, "ROUTINE_FOLDER")) as RoutineFolder[]
      ).filter(isLive);
      const now = deps.now();
      const at = stamp(now);
      const folder = clean({
        id: randomUUID(),
        type: "ROUTINE_FOLDER",
        schema_version: SCHEMA_VERSION,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        name: name.trim(),
        sort_order: nextOrder(folders),
        notes,
      }) as RoutineFolder;
      const result = await save(folder, now);
      if (result.error) return result.error;
      return ok({ created: program(folder) });
    },
  );

  server.registerTool(
    "update_program",
    {
      title: "Update program",
      description: "Rename a Program or change its notes. Fields you leave out stay as they are.",
      inputSchema: z.object({
        program_id: z.uuid(),
        name: z.string().min(1).max(100).optional(),
        notes: z.string().max(2000).nullable().optional().describe("null removes the notes"),
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ program_id, name, notes }) => {
      const current = await liveFolder(program_id);
      if (!current) return notFound("program", program_id);
      const now = deps.now();
      const next: Record<string, unknown> = {
        ...current,
        updated_at: stamp(now, current.updated_at),
      };
      if (name !== undefined) next.name = name.trim();
      if (notes === null) delete next.notes;
      else if (notes !== undefined) next.notes = notes;
      const folder = clean(next) as RoutineFolder;
      const result = await save(folder, now);
      if (result.error) return result.error;
      return ok({ updated: program(folder) });
    },
  );

  server.registerTool(
    "delete_program",
    {
      title: "Delete program",
      description:
        "Delete a Program on every device. Its Workouts are kept (moved out of the Program) unless " +
        "delete_workouts is true. Logged sessions are always kept. Confirm with the user first.",
      inputSchema: z.object({
        program_id: z.uuid(),
        delete_workouts: z.boolean().default(false).describe("Also delete the Workouts in it"),
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ program_id, delete_workouts }) => {
      const current = await liveFolder(program_id);
      if (!current) return notFound("program", program_id);
      const now = deps.now();
      // The contract's folder delete: tombstone the folder, then push each of its routines with
      // folder_id removed (or tombstoned too).
      const at = stamp(now, current.updated_at);
      const result = await save({ ...current, updated_at: at, deleted_at: at }, now);
      if (result.error) return result.error;
      const inside = (await routines()).filter((r) => isLive(r) && r.folder_id === program_id);
      const handled: string[] = [];
      for (const routine of inside) {
        const t = stamp(now, routine.updated_at);
        const next: Record<string, unknown> = { ...routine, updated_at: t };
        if (delete_workouts) next.deleted_at = t;
        else delete next.folder_id;
        const saved = await save(clean(next) as Entity, now);
        if (!saved.error) handled.push(routine.name);
      }
      return ok({
        deleted: program(current),
        [delete_workouts ? "workouts_deleted" : "workouts_kept_without_program"]: handled,
      });
    },
  );

  // -------------------------------------------------------------------------------------------
  // Workouts (Routine): plans the user starts in the app
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    "create_workout",
    {
      title: "Create workout",
      description:
        "Create a Workout: a plan the user starts in the app (e.g. 'Push Day'), with all its " +
        "exercises and target sets in one call. Put it in a Program with program_id (see " +
        "list_programs or create_program). Find exercise ids with search_exercises first. Weights " +
        "are kg; give rep ranges with target_reps_min and target_reps_max. It appears in the app " +
        "after its next sync.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        notes: z.string().max(2000).optional(),
        program_id: z.uuid().optional().describe("The Program to put it in; omit for none"),
        exercises: z.array(RoutineExerciseInput).min(1).max(50).describe("In order"),
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, notes, program_id, exercises }) => {
      const dir = exerciseDirectory(await customExercises());
      const unknown = unknownExercises(dir, exercises);
      if (unknown.length > 0) {
        return toolError(`Unknown exercise ids: ${unknown.join(", ")}. Use search_exercises.`);
      }
      if (program_id && !(await liveFolder(program_id))) return notFound("program", program_id);

      // New workouts go last in their Program (or among those without one), like the app does.
      const siblings = (await routines()).filter(
        (r) => isLive(r) && (r.folder_id ?? "") === (program_id ?? ""),
      );
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
        folder_id: program_id,
        sort_order: nextOrder(siblings),
        exercises,
      }) as Routine;
      const result = await save(routine, now);
      if (result.error) return result.error;
      return ok({ created: workoutPlan(routine, dir) });
    },
  );

  server.registerTool(
    "update_workout",
    {
      title: "Update workout",
      description:
        "Change a Workout plan: rename it, change its notes, move it to another Program, or replace " +
        "its exercises. Fields you leave out stay as they are; `exercises`, when given, replaces the " +
        "whole list, so read it with get_workout first and send every exercise you want to keep.",
      inputSchema: z.object({
        workout_id: z.uuid(),
        name: z.string().min(1).max(100).optional(),
        notes: z.string().max(2000).nullable().optional().describe("null removes the notes"),
        program_id: z.uuid().nullable().optional().describe("null takes it out of its Program"),
        exercises: z.array(RoutineExerciseInput).min(1).max(50).optional(),
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ workout_id, name, notes, program_id, exercises }) => {
      const current = await liveRoutine(workout_id);
      if (!current) return notFound("workout", workout_id);
      const dir = exerciseDirectory(await customExercises(), true);
      if (exercises) {
        // Exercises already in the workout stay allowed even if since deprecated or deleted.
        const kept = new Set(current.exercises.map((e) => e.exercise_id));
        const unknown = unknownExercises(dir, exercises).filter((id) => !kept.has(id));
        if (unknown.length > 0) {
          return toolError(`Unknown exercise ids: ${unknown.join(", ")}. Use search_exercises.`);
        }
      }
      if (program_id && !(await liveFolder(program_id))) return notFound("program", program_id);

      const now = deps.now();
      const next: Record<string, unknown> = {
        ...current,
        updated_at: stamp(now, current.updated_at),
      };
      if (name !== undefined) next.name = name.trim();
      if (notes === null) delete next.notes;
      else if (notes !== undefined) next.notes = notes;
      if (program_id === null) delete next.folder_id;
      else if (program_id !== undefined) {
        if (program_id !== current.folder_id) {
          const siblings = (await routines()).filter(
            (r) => isLive(r) && r.folder_id === program_id,
          );
          next.sort_order = nextOrder(siblings);
        }
        next.folder_id = program_id;
      }
      if (exercises) next.exercises = exercises;

      const routine = clean(next) as Routine;
      const result = await save(routine, now);
      if (result.error) return result.error;
      return ok({ updated: workoutPlan(routine, dir) });
    },
  );

  server.registerTool(
    "delete_workout",
    {
      title: "Delete workout",
      description:
        "Delete a Workout plan on every device. Sessions already logged from it are kept. " +
        "Confirm with the user first.",
      inputSchema: z.object({ workout_id: z.uuid() }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async ({ workout_id }) => {
      const current = await liveRoutine(workout_id);
      if (!current) return notFound("workout", workout_id);
      const now = deps.now();
      const at = stamp(now, current.updated_at);
      // A tombstone, so the delete syncs to the app.
      const result = await save({ ...current, updated_at: at, deleted_at: at }, now);
      if (result.error) return result.error;
      return ok({ deleted: { id: current.id, name: current.name } });
    },
  );

  // -------------------------------------------------------------------------------------------
  // Custom exercises
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    "create_custom_exercise",
    {
      title: "Create custom exercise",
      description:
        "Add an exercise that isn't in the built-in catalogue. Search first: only create one " +
        "when search_exercises has nothing suitable. Returns its id for use in workouts.",
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
