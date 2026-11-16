import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import common from "../../schemas/v1/common.json" with { type: "json" };
import exercise from "../../schemas/v1/Exercise.json" with { type: "json" };
import profile from "../../schemas/v1/Profile.json" with { type: "json" };
import routine from "../../schemas/v1/Routine.json" with { type: "json" };
import routineFolder from "../../schemas/v1/RoutineFolder.json" with { type: "json" };
import workout from "../../schemas/v1/Workout.json" with { type: "json" };
import type { components } from "../generated/openapi.js";

export type Entity = components["schemas"]["Entity"];
export type EntityType = Entity["type"];

export const ENTITY_TYPES = [
  "PROFILE",
  "EXERCISE",
  "ROUTINE",
  "ROUTINE_FOLDER",
  "WORKOUT",
] as const satisfies readonly EntityType[];

export const isEntityType = (value: unknown): value is EntityType =>
  typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);

// ajv-formats is CommonJS; under ESM its function may sit on `.default`.
const addFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule;

const SCHEMA_IDS: Record<EntityType, string> = {
  PROFILE: profile.$id,
  EXERCISE: exercise.$id,
  ROUTINE: routine.$id,
  ROUTINE_FOLDER: routineFolder.$id,
  WORKOUT: workout.$id,
};

let validators: Record<EntityType, ValidateFunction> | undefined;

/** Compiled once per Lambda instance, on first use. */
function getValidators(): Record<EntityType, ValidateFunction> {
  if (!validators) {
    const ajv = new Ajv2020({ strict: true, allErrors: false });
    addFormats(ajv);
    for (const schema of [common, exercise, profile, routine, routineFolder, workout]) {
      ajv.addSchema(schema);
    }
    const get = (type: EntityType): ValidateFunction => {
      const fn = ajv.getSchema(SCHEMA_IDS[type]);
      if (!fn) throw new Error(`schema for ${type} not loaded`);
      return fn;
    };
    validators = {
      PROFILE: get("PROFILE"),
      EXERCISE: get("EXERCISE"),
      ROUTINE: get("ROUTINE"),
      ROUTINE_FOLDER: get("ROUTINE_FOLDER"),
      WORKOUT: get("WORKOUT"),
    };
  }
  return validators;
}

export type Validation = { ok: true; entity: Entity } | { ok: false; detail: string };

/** Validates an item against its v1 entity schema (unknown fields rejected). */
export function validateEntity(type: EntityType, item: unknown): Validation {
  const validate = getValidators()[type];
  if (validate(item)) return { ok: true, entity: item as Entity };
  const first = validate.errors?.[0];
  const where = first && first.instancePath !== "" ? first.instancePath : "(item)";
  const detail = first ? `${where} ${first.message ?? "is invalid"}` : "failed validation";
  return { ok: false, detail: detail.slice(0, 500) };
}
