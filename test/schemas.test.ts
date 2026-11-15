import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

// ajv-formats is CommonJS; under ESM its function may sit on `.default`.
const addFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule;

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas", "v1");
const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "v1");
const BASE = "https://raw.githubusercontent.com/EamonnHegarty/laidir-api/main/schemas/v1/";

const ENTITY_SCHEMAS: Record<string, string> = {
  PROFILE: "Profile.json",
  EXERCISE: "Exercise.json",
  ROUTINE: "Routine.json",
  WORKOUT: "Workout.json",
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    ajv.addSchema(readJson(join(SCHEMA_DIR, file)) as object);
  }
  return ajv;
}

function validatorFor(ajv: Ajv2020, item: unknown) {
  const type = (item as { type?: string }).type ?? "";
  const file = ENTITY_SCHEMAS[type];
  if (!file) throw new Error(`fixture has unknown type ${JSON.stringify(type)}`);
  const validate = ajv.getSchema(BASE + file);
  if (!validate) throw new Error(`schema ${file} not loaded`);
  return validate;
}

const fixtures = (kind: "valid" | "invalid") =>
  readdirSync(join(FIXTURE_DIR, kind))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, readJson(join(FIXTURE_DIR, kind, f))] as const);

describe("schemas/v1", () => {
  it("compile in strict mode, and every schema's $id matches its file name", () => {
    const ajv = makeAjv();
    for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
      const schema = readJson(join(SCHEMA_DIR, file)) as { $id: string };
      expect(schema.$id).toBe(BASE + file);
      expect(() => ajv.getSchema(schema.$id)).not.toThrow();
    }
  });

  it("has an entity schema for every type", () => {
    const ajv = makeAjv();
    for (const file of Object.values(ENTITY_SCHEMAS)) {
      expect(ajv.getSchema(BASE + file), file).toBeDefined();
    }
  });

  describe.each(fixtures("valid"))("accepts %s", (_name, item) => {
    it("validates", () => {
      const validate = validatorFor(makeAjv(), item);
      expect(validate(item), JSON.stringify(validate.errors, null, 2)).toBe(true);
    });
  });

  describe.each(fixtures("invalid"))("rejects %s", (_name, item) => {
    it("fails validation", () => {
      const validate = validatorFor(makeAjv(), item);
      expect(validate(item)).toBe(false);
    });
  });
});
