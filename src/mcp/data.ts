import catalogue from "../../catalogue/v1/exercises.json" with { type: "json" };
import type { components } from "../generated/openapi.js";

export type Exercise = components["schemas"]["Exercise"];
export type Routine = components["schemas"]["Routine"];
export type RoutineFolder = components["schemas"]["RoutineFolder"];
export type Workout = components["schemas"]["Workout"];
export type WorkoutSet = components["schemas"]["WorkoutSet"];
export type Profile = components["schemas"]["Profile"];

/** What Claude sees for an exercise, built-in or custom. */
export interface ExerciseInfo {
  /** `builtin:<slug>` or the custom exercise's UUID: the value routines and workouts use. */
  id: string;
  name: string;
  equipment: string;
  primary_muscle: string;
  secondary_muscles?: string[];
  tracking: string;
  custom: boolean;
}

interface CatalogueEntry {
  slug: string;
  name: string;
  equipment: string;
  primary_muscle: string;
  secondary_muscles?: string[];
  tracking: string;
  deprecated?: boolean;
}

const BUILT_IN: readonly CatalogueEntry[] = catalogue.exercises;

export const isLive = (item: { deleted_at: string | null }): boolean => item.deleted_at === null;

/**
 * Every exercise the user can pick: the built-in catalogue (deprecated ones only when
 * `includeDeprecated`, which lookups for old workouts need) plus their live custom exercises.
 */
export function exerciseDirectory(
  custom: readonly Exercise[],
  includeDeprecated = false,
): Map<string, ExerciseInfo> {
  const dir = new Map<string, ExerciseInfo>();
  for (const e of BUILT_IN) {
    if (e.deprecated && !includeDeprecated) continue;
    const info: ExerciseInfo = {
      id: `builtin:${e.slug}`,
      name: e.name,
      equipment: e.equipment,
      primary_muscle: e.primary_muscle,
      tracking: e.tracking,
      custom: false,
    };
    if (e.secondary_muscles) info.secondary_muscles = e.secondary_muscles;
    dir.set(info.id, info);
  }
  for (const e of custom) {
    if (!isLive(e)) continue;
    const info: ExerciseInfo = {
      id: e.id,
      name: e.name,
      equipment: e.equipment,
      primary_muscle: e.primary_muscle,
      tracking: e.tracking,
      custom: true,
    };
    if (e.secondary_muscles) info.secondary_muscles = e.secondary_muscles;
    dir.set(info.id, info);
  }
  return dir;
}

/** Sets that count towards volume and records: completed, not warm-ups. */
export const isWorkingSet = (set: WorkoutSet): boolean =>
  set.completed && set.set_type !== "warmup";

/** Epley estimate of a one-rep max, for sets of 1–12 reps with a weight. */
export function estimatedOneRepMax(set: WorkoutSet): number | undefined {
  if (set.weight_kg === undefined || set.reps === undefined) return undefined;
  if (set.reps < 1 || set.reps > 12) return undefined;
  return set.reps === 1 ? set.weight_kg : set.weight_kg * (1 + set.reps / 30);
}

/** Sum of weight × reps over working sets, in kg. */
export function volumeKg(sets: readonly WorkoutSet[]): number {
  let total = 0;
  for (const set of sets) {
    if (isWorkingSet(set) && set.weight_kg !== undefined && set.reps !== undefined) {
      total += set.weight_kg * set.reps;
    }
  }
  return total;
}

/** Rounds for display in tool output (stored values keep full precision). */
export const round = (n: number, places = 1): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** `YYYY-MM-DD` → the first or last millisecond of that UTC day; full timestamps pass through. */
export function dayBound(value: string, end: "start" | "end"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return end === "start" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  }
  return new Date(value).toISOString();
}
