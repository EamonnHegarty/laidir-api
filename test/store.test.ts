import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import type { Entity } from "../src/api/entities.js";
import { type DocSender, DynamoStore, sortKeyFromPosition } from "../src/api/store.js";
import { SUB_A } from "./event.js";

type Command = PutCommand | QueryCommand | GetCommand;

function stub(reply: (command: Command) => unknown) {
  const sent: Command[] = [];
  const client: DocSender = {
    send(command) {
      sent.push(command);
      // A throw inside the executor becomes a rejection, like the real client.
      return new Promise((resolve) => {
        resolve(reply(command));
      });
    },
  };
  return { sent, store: new DynamoStore(client, "laidir-test-data") };
}

const EXERCISE = {
  id: "c0ffee00-1234-4abc-8def-0123456789ab",
  type: "EXERCISE",
  schema_version: 1,
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-11-16T10:00:00.000Z",
  deleted_at: null,
  name: "Cable fly",
  equipment: "cable",
  primary_muscle: "chest",
  tracking: "weight_reps",
} as unknown as Entity;

describe("DynamoStore", () => {
  it("puts conditionally on updated_at, with keys from the caller's sub", async () => {
    const { sent, store } = stub(() => ({}));
    const outcome = await store.put(SUB_A, EXERCISE, "2026-11-16T12:00:00.000Z");
    expect(outcome).toEqual({ status: "applied" });
    const input = (sent[0] as PutCommand).input;
    expect(input).toMatchObject({
      TableName: "laidir-test-data",
      ConditionExpression: "attribute_not_exists(PK) OR updated_at < :incoming",
      ExpressionAttributeValues: { ":incoming": EXERCISE.updated_at },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      Item: {
        PK: `USER#${SUB_A}`,
        SK: `EXERCISE#${EXERCISE.id}`,
        GSI2PK: `USER#${SUB_A}`,
        GSI2SK: `2026-11-16T12:00:00.000Z#EXERCISE#${EXERCISE.id}`,
        synced_at: "2026-11-16T12:00:00.000Z",
        name: "Cable fly",
      },
    });
    expect(input.Item).not.toHaveProperty("GSI1PK");
  });

  it("returns the stored copy (without keys) when the condition fails", async () => {
    const current = { ...EXERCISE, updated_at: "2026-11-16T11:00:00.000Z", name: "Newer" };
    const old = marshall({
      ...current,
      PK: `USER#${SUB_A}`,
      SK: `EXERCISE#${EXERCISE.id}`,
      GSI2PK: `USER#${SUB_A}`,
      GSI2SK: "x",
      synced_at: "2026-11-16T11:00:01.000Z",
    });
    const { store } = stub(() => {
      throw new ConditionalCheckFailedException({ message: "failed", $metadata: {}, Item: old });
    });
    const outcome = await store.put(SUB_A, EXERCISE, "2026-11-16T12:00:00.000Z");
    expect(outcome).toEqual({ status: "stale", current });
  });

  it("rethrows other errors", async () => {
    const { store } = stub(() => {
      throw new Error("ProvisionedThroughputExceeded");
    });
    await expect(store.put(SUB_A, EXERCISE, "2026-11-16T12:00:00.000Z")).rejects.toThrow();
  });

  it("pulls from GSI2 with a settle bound and resumes after the cursor position", async () => {
    const position = `2026-11-16T11:00:00.000Z#WORKOUT#${EXERCISE.id}`;
    const { sent, store } = stub(() => ({
      Items: [{ ...EXERCISE, PK: "p", SK: "s", GSI2PK: "p", GSI2SK: "pos-1", synced_at: "t" }],
      LastEvaluatedKey: { PK: "p" },
    }));
    const page = await store.pull(SUB_A, {
      after: position,
      before: "2026-11-16T12:00:00.000Z",
      limit: 50,
    });
    expect(page).toEqual({ rows: [{ entity: EXERCISE, position: "pos-1" }], hasMore: true });
    expect((sent[0] as QueryCommand).input).toEqual({
      TableName: "laidir-test-data",
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk AND GSI2SK < :before",
      ExpressionAttributeValues: { ":pk": `USER#${SUB_A}`, ":before": "2026-11-16T12:00:00.000Z" },
      Limit: 50,
      ExclusiveStartKey: {
        GSI2PK: `USER#${SUB_A}`,
        GSI2SK: position,
        PK: `USER#${SUB_A}`,
        SK: `WORKOUT#${EXERCISE.id}`,
      },
    });
  });

  it("starts from the beginning without an ExclusiveStartKey", async () => {
    const { sent, store } = stub(() => ({ Items: [] }));
    const page = await store.pull(SUB_A, { after: "", before: "z", limit: 10 });
    expect(page).toEqual({ rows: [], hasMore: false });
    expect((sent[0] as QueryCommand).input.ExclusiveStartKey).toBeUndefined();
  });

  it("reads the profile by the caller's sub", async () => {
    const { sent, store } = stub(() => ({}));
    expect(await store.getProfile(SUB_A)).toBeUndefined();
    expect((sent[0] as GetCommand).input).toMatchObject({
      Key: { PK: `USER#${SUB_A}`, SK: "PROFILE" },
      ConsistentRead: true,
    });
  });

  it("maps a profile feed position back to its table key", () => {
    expect(sortKeyFromPosition(`2026-11-16T11:00:00.000Z#PROFILE#${SUB_A}`)).toBe("PROFILE");
    expect(sortKeyFromPosition(`2026-11-16T11:00:00.000Z#ROUTINE_FOLDER#abc`)).toBe(
      "ROUTINE_FOLDER#abc",
    );
  });
});
