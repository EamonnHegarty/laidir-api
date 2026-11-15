import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

const addFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule;

const ROOT = join(import.meta.dirname, "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

interface CatalogueExercise {
  slug: string;
  name: string;
  primary_muscle: string;
  secondary_muscles?: string[];
  deprecated?: boolean;
}
interface Catalogue {
  catalogue_version: number;
  exercises: CatalogueExercise[];
}

const catalogue = readJson(join(ROOT, "catalogue", "v1", "exercises.json")) as Catalogue;
const commonSchema = readJson(join(ROOT, "schemas", "v1", "common.json")) as { $id: string };
const catalogueSchema = readJson(join(ROOT, "catalogue", "v1", "exercises.schema.json")) as object;

function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  return ajv;
}

describe("catalogue/v1/exercises.json", () => {
  it("validates against its schema", () => {
    const validate = makeAjv().compile(catalogueSchema);
    expect(validate(catalogue), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("has unique slugs that form valid builtin: exercise refs", () => {
    const slugs = catalogue.exercises.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const isExerciseRef = makeAjv().compile({ $ref: `${commonSchema.$id}#/$defs/ExerciseRef` });
    for (const slug of slugs) {
      expect(isExerciseRef(`builtin:${slug}`), slug).toBe(true);
    }
  });

  it("has unique names, ignoring case", () => {
    const names = catalogue.exercises.map((e) => e.name.toLowerCase());
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it("never lists the primary muscle as a secondary muscle", () => {
    const bad = catalogue.exercises.filter((e) =>
      (e.secondary_muscles ?? []).includes(e.primary_muscle),
    );
    expect(bad.map((e) => e.slug)).toEqual([]);
  });

  it("resolves every builtin: reference used in the schema fixtures", () => {
    const slugs = new Set(catalogue.exercises.map((e) => e.slug));
    const fixtureDir = join(ROOT, "test", "fixtures", "v1", "valid");
    const refs = readdirSync(fixtureDir)
      .flatMap((f) => [...readFileSync(join(fixtureDir, f), "utf8").matchAll(/"builtin:([^"]+)"/g)])
      .map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => r === undefined || !slugs.has(r))).toEqual([]);
  });
});
