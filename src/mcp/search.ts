import type { ExerciseInfo } from "./data.js";

/**
 * Exercise search that copes with how people (and Claude) write lift names: plurals ("rows",
 * "pull ups"), joined or hyphenated forms ("pullups", "pull-up"), common abbreviations ("rdl",
 * "ohp", "db") and any word order. Every query word must match; if nothing matches all of them,
 * the exercises matching the most words come back instead, so a near miss still finds something.
 */
const ALIASES: Record<string, string> = {
  rdl: "romanian deadlift",
  rdls: "romanian deadlift",
  ohp: "overhead press",
  military: "overhead",
  bb: "barbell",
  db: "dumbbell",
  kb: "kettlebell",
  ez: "ez bar",
  pullup: "pull up",
  pullups: "pull up",
  chinup: "chin up",
  chinups: "chin up",
  pushup: "push up",
  pushups: "push up",
  situp: "sit up",
  situps: "sit up",
  bentover: "bent over",
  lats: "lat",
};

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** A crude singular: presses → press, rows → row, ups → up (never touches "press" itself). */
function stem(word: string): string {
  if (word.length > 4 && /(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length >= 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function queryTerms(query: string): string[] {
  return words(query)
    .flatMap((w) => {
      const alias = ALIASES[w];
      return alias === undefined ? [w] : words(alias);
    })
    .map(stem);
}

/** Exercises matching `query`, best first (catalogue order within the same score). */
export function searchExercises(
  exercises: readonly ExerciseInfo[],
  query: string | undefined,
): ExerciseInfo[] {
  const terms = queryTerms(query ?? "");
  if (terms.length === 0) return [...exercises];
  const scored = exercises.map((exercise, index) => {
    const tokens = new Set(words(exercise.name).map(stem));
    const compact = [...tokens].join("");
    let hits = 0;
    for (const term of terms) {
      if (tokens.has(term) || (term.length >= 4 && compact.includes(term))) hits++;
    }
    return { exercise, hits, index };
  });
  const all = scored.filter((s) => s.hits === terms.length);
  const pool =
    all.length > 0
      ? all
      : scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits || a.index - b.index);
  return pool.map((s) => s.exercise);
}
