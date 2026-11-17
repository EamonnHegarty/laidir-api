import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Store } from "../api/store.js";
import {
  type Exercise,
  type ExerciseInfo,
  type Profile,
  type Routine,
  type RoutineFolder,
  type Workout,
  dayBound,
  estimatedOneRepMax,
  exerciseDirectory,
  isLive,
  isWorkingSet,
  round,
  volumeKg,
} from "./data.js";
import { notFound, ok } from "./results.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** How many workouts get_exercise_history looks back through. */
const HISTORY_SCAN = 300;

export interface ToolDeps {
  store: Store;
  sub: string;
  now: () => Date;
}

/** Live custom exercises and the full directory (deprecated built-ins included, for old data). */
async function directory(deps: ToolDeps): Promise<Map<string, ExerciseInfo>> {
  const custom = (await deps.store.list(deps.sub, "EXERCISE")) as Exercise[];
  return exerciseDirectory(custom, true);
}

async function weightUnit(deps: ToolDeps): Promise<"kg" | "lb"> {
  const profile = (await deps.store.getProfile(deps.sub)) as Profile | undefined;
  return profile?.weight_unit ?? "kg";
}

const nameOf = (dir: Map<string, ExerciseInfo>, id: string): string =>
  dir.get(id)?.name ?? "(deleted exercise)";

export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_exercises",
    {
      title: "Search exercises",
      description:
        "Find exercises in Láidir: the built-in catalogue plus the user's custom exercises. " +
        "Use the returned `id` (e.g. `builtin:barbell-bench-press`) when building routines. " +
        "Call with no filters to list everything.",
      inputSchema: z.object({
        query: z.string().max(100).optional().describe("Words to match in the name, e.g. 'bench'"),
        muscle: z.string().max(30).optional().describe("Primary or secondary muscle, e.g. 'chest'"),
        equipment: z.string().max(30).optional().describe("e.g. barbell, dumbbell, cable, machine"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, muscle, equipment, limit }) => {
      const custom = (await deps.store.list(deps.sub, "EXERCISE")) as Exercise[];
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [...exerciseDirectory(custom).values()].filter((e) => {
        const name = e.name.toLowerCase();
        if (!words.every((w) => name.includes(w))) return false;
        if (muscle && e.primary_muscle !== muscle && !e.secondary_muscles?.includes(muscle)) {
          return false;
        }
        return !equipment || e.equipment === equipment;
      });
      return ok({ total: matches.length, exercises: matches.slice(0, limit) });
    },
  );

  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description:
        "List the user's routines (workout templates) with their folders, in the order the app shows them.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const [routines, folders] = await Promise.all([
        deps.store.list(deps.sub, "ROUTINE") as Promise<Routine[]>,
        deps.store.list(deps.sub, "ROUTINE_FOLDER") as Promise<RoutineFolder[]>,
      ]);
      const liveFolders = folders.filter(isLive);
      const folderIds = new Set(liveFolders.map((f) => f.id));
      const byOrder = <T extends { sort_order?: number; name: string }>(a: T, b: T) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
      const summary = (r: Routine) => ({
        id: r.id,
        name: r.name,
        exercises: r.exercises.length,
        sets: r.exercises.reduce((n, e) => n + e.sets.length, 0),
        ...(r.notes ? { notes: r.notes } : {}),
        updated_at: r.updated_at,
      });
      const live = routines.filter(isLive);
      // A folder_id pointing at a missing or deleted folder means unfiled.
      const inFolder = (r: Routine) =>
        r.folder_id && folderIds.has(r.folder_id) ? r.folder_id : "";
      return ok({
        folders: liveFolders.sort(byOrder).map((f) => ({
          id: f.id,
          name: f.name,
          routines: live
            .filter((r) => inFolder(r) === f.id)
            .sort(byOrder)
            .map(summary),
        })),
        unfiled: live
          .filter((r) => inFolder(r) === "")
          .sort(byOrder)
          .map(summary),
      });
    },
  );

  server.registerTool(
    "get_routine",
    {
      title: "Get routine",
      description:
        "One routine in full: exercises (with names) and target sets. Weights are in kg.",
      inputSchema: z.object({ routine_id: z.uuid() }),
      annotations: READ_ONLY,
    },
    async ({ routine_id }) => {
      const routine = (await deps.store.get(deps.sub, "ROUTINE", routine_id)) as
        Routine | undefined;
      if (!routine || !isLive(routine)) return notFound("routine", routine_id);
      const dir = await directory(deps);
      return ok({
        ...routine,
        weight_unit_preference: await weightUnit(deps),
        exercises: routine.exercises.map((e) => ({ ...e, name: nameOf(dir, e.exercise_id) })),
      });
    },
  );

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts",
      description:
        "The user's logged workouts, newest first, with totals. Dates are YYYY-MM-DD (UTC) or " +
        "ISO-8601 timestamps. Volume is the sum of weight × reps over completed working sets, in kg.",
      inputSchema: z.object({
        from: z.string().max(30).optional().describe("Earliest start date, inclusive"),
        to: z.string().max(30).optional().describe("Latest start date, inclusive"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, limit }) => {
      const opts: { from?: string; to?: string; limit: number } = { limit };
      if (from) opts.from = dayBound(from, "start");
      if (to) opts.to = dayBound(to, "end");
      // Ask for a few extra in case some are tombstones.
      const rows = (await deps.store.workouts(deps.sub, {
        ...opts,
        limit: limit + 20,
      })) as Workout[];
      const workouts = rows.filter(isLive).slice(0, limit);
      return ok({
        weight_unit_preference: await weightUnit(deps),
        workouts: workouts.map((w) => {
          const sets = w.exercises.flatMap((e) => e.sets);
          return {
            id: w.id,
            name: w.name,
            started_at: w.started_at,
            ...(w.ended_at
              ? {
                  ended_at: w.ended_at,
                  duration_min: round(
                    (Date.parse(w.ended_at) - Date.parse(w.started_at)) / 60000,
                    0,
                  ),
                }
              : { in_progress: true }),
            exercises: w.exercises.length,
            completed_sets: sets.filter(isWorkingSet).length,
            volume_kg: round(volumeKg(sets)),
          };
        }),
      });
    },
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get workout",
      description:
        "One logged workout in full: every exercise (with names) and set. Weights in kg.",
      inputSchema: z.object({ workout_id: z.uuid() }),
      annotations: READ_ONLY,
    },
    async ({ workout_id }) => {
      const workout = (await deps.store.get(deps.sub, "WORKOUT", workout_id)) as
        Workout | undefined;
      if (!workout || !isLive(workout)) return notFound("workout", workout_id);
      const dir = await directory(deps);
      return ok({
        ...workout,
        weight_unit_preference: await weightUnit(deps),
        exercises: workout.exercises.map((e) => ({ ...e, name: nameOf(dir, e.exercise_id) })),
      });
    },
  );

  server.registerTool(
    "get_exercise_history",
    {
      title: "Get exercise history",
      description:
        "How one exercise has gone over time: each workout's completed sets, best set, estimated " +
        "one-rep max (Epley, sets of 1–12 reps) and volume, newest first. Weights in kg. " +
        "Use search_exercises to find the exercise id.",
      inputSchema: z.object({
        exercise_id: z.string().max(100).describe("`builtin:<slug>` or a custom exercise UUID"),
        limit: z.number().int().min(1).max(100).default(20).describe("Workouts to return"),
      }),
      annotations: READ_ONLY,
    },
    async ({ exercise_id, limit }) => {
      const dir = await directory(deps);
      const info = dir.get(exercise_id);
      if (!info) return notFound("exercise", exercise_id);
      const rows = (await deps.store.workouts(deps.sub, { limit: HISTORY_SCAN })) as Workout[];
      const sessions = [];
      let bestEver: { e1rm_kg: number; weight_kg: number; reps: number; date: string } | undefined;
      for (const w of rows.filter(isLive)) {
        const sets = w.exercises
          .filter((e) => e.exercise_id === exercise_id)
          .flatMap((e) => e.sets);
        const working = sets.filter(isWorkingSet);
        if (working.length === 0) continue;
        let best: { weight_kg: number; reps: number; e1rm_kg: number } | undefined;
        for (const s of working) {
          const e1rm = estimatedOneRepMax(s);
          if (e1rm !== undefined && s.weight_kg !== undefined && s.reps !== undefined) {
            if (!best || e1rm > best.e1rm_kg)
              best = { weight_kg: s.weight_kg, reps: s.reps, e1rm_kg: e1rm };
          }
        }
        if (best && (!bestEver || best.e1rm_kg > bestEver.e1rm_kg)) {
          bestEver = { ...best, date: w.started_at };
        }
        if (sessions.length < limit) {
          sessions.push({
            workout_id: w.id,
            date: w.started_at,
            sets: working.map((s) => ({
              ...(s.weight_kg !== undefined ? { weight_kg: s.weight_kg } : {}),
              ...(s.reps !== undefined ? { reps: s.reps } : {}),
              ...(s.duration_s !== undefined ? { duration_s: s.duration_s } : {}),
              ...(s.distance_m !== undefined ? { distance_m: s.distance_m } : {}),
              ...(s.rpe !== undefined ? { rpe: s.rpe } : {}),
              ...(s.set_type !== "normal" ? { set_type: s.set_type } : {}),
            })),
            ...(best ? { best_set: { ...best, e1rm_kg: round(best.e1rm_kg) } } : {}),
            volume_kg: round(volumeKg(working)),
          });
        }
      }
      return ok({
        exercise: info,
        weight_unit_preference: await weightUnit(deps),
        workouts_checked: rows.length,
        ...(bestEver ? { best_ever: { ...bestEver, e1rm_kg: round(bestEver.e1rm_kg) } } : {}),
        sessions,
      });
    },
  );
}
