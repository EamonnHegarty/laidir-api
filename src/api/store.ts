import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Entity, EntityType } from "./entities.js";

/** One row of the sync feed: the entity plus its position (its GSI2 sort key). */
export interface FeedRow {
  entity: Entity;
  position: string;
}

export type PutOutcome = { status: "applied" } | { status: "stale"; current: Entity };

export interface PullPage {
  rows: FeedRow[];
  /** DynamoDB stopped at the page limit; there may be more. */
  hasMore: boolean;
}

/** Data access for one table. Every method is scoped to the caller's `sub`. */
export interface Store {
  /** Conditional upsert: applied only if the item is new or the incoming `updated_at` is later. */
  put(sub: string, entity: Entity, syncedAt: string): Promise<PutOutcome>;
  /** Feed rows with position > `after` (exclusive; "" = from the start) and `synced_at` < `before`. */
  pull(sub: string, opts: { after: string; before: string; limit: number }): Promise<PullPage>;
  getProfile(sub: string): Promise<Entity | undefined>;
  /** Deletes every item the user has (all types, tombstones included). Returns how many. */
  deleteAll(sub: string): Promise<number>;
  /** One item (tombstones included), or undefined. Strongly consistent. */
  get(sub: string, type: EntityType, id: string): Promise<Entity | undefined>;
  /** Every item of one type (tombstones included). Not for WORKOUT: use `workouts`. */
  list(sub: string, type: Exclude<EntityType, "PROFILE" | "WORKOUT">): Promise<Entity[]>;
  /**
   * Workouts newest first by `started_at` (tombstones included), at most `limit`.
   * `from`/`to` bound `started_at` (inclusive, ISO-8601).
   */
  workouts(sub: string, opts: { from?: string; to?: string; limit: number }): Promise<Entity[]>;
}

/** The upper bound for a `<started_at>#<id>` sort key that starts on or before `to`. */
export const WORKOUT_KEY_MAX = "￿";

// ---------------------------------------------------------------------------
// Key layout (laidir-infra docs/access-patterns.md)
// ---------------------------------------------------------------------------

export const userPk = (sub: string): string => `USER#${sub}`;

export const sortKey = (type: EntityType, id: string): string =>
  type === "PROFILE" ? "PROFILE" : `${type}#${id}`;

/** GSI2 sort key: `<synced_at>#<TYPE>#<id>`. `synced_at` is ISO-8601 and never contains `#`. */
export const feedPosition = (syncedAt: string, type: EntityType, id: string): string =>
  `${syncedAt}#${type}#${id}`;

/** Table sort key for a feed position (needed to resume a GSI query from it). */
export function sortKeyFromPosition(position: string): string {
  const [, type = "", id = ""] = position.split("#");
  return type === "PROFILE" ? "PROFILE" : `${type}#${id}`;
}

const INTERNAL_ATTRIBUTES = [
  "PK",
  "SK",
  "GSI1PK",
  "GSI1SK",
  "GSI2PK",
  "GSI2SK",
  "synced_at",
  "expires_at",
] as const;

/** The stored row for an entity: the v1 document plus keys and the server's `synced_at`. */
export function toRow(sub: string, entity: Entity, syncedAt: string): Record<string, unknown> {
  const pk = userPk(sub);
  const row: Record<string, unknown> = {
    ...entity,
    PK: pk,
    SK: sortKey(entity.type, entity.id),
    GSI2PK: pk,
    GSI2SK: feedPosition(syncedAt, entity.type, entity.id),
    synced_at: syncedAt,
  };
  if (entity.type === "WORKOUT") {
    row.GSI1PK = `${pk}#WORKOUT`;
    row.GSI1SK = `${entity.started_at}#${entity.id}`;
  }
  return row;
}

/** Strips keys and server-only attributes, leaving the v1 document. */
export function fromRow(row: Record<string, unknown>): Entity {
  const doc = { ...row };
  for (const attr of INTERNAL_ATTRIBUTES) Reflect.deleteProperty(doc, attr);
  return doc as unknown as Entity;
}

// ---------------------------------------------------------------------------
// DynamoDB implementation
// ---------------------------------------------------------------------------

/** The subset of DynamoDBDocumentClient used here (lets tests stub it). */
export interface DocSender {
  send(command: PutCommand | QueryCommand | GetCommand | BatchWriteCommand): Promise<unknown>;
}

const BATCH_DELETE = 25;
const MAX_BATCH_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export class DynamoStore implements Store {
  constructor(
    private readonly client: DocSender,
    private readonly tableName: string,
  ) {}

  async put(sub: string, entity: Entity, syncedAt: string): Promise<PutOutcome> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toRow(sub, entity, syncedAt),
          // Last writer wins on the client's updated_at.
          ConditionExpression: "attribute_not_exists(PK) OR updated_at < :incoming",
          ExpressionAttributeValues: { ":incoming": entity.updated_at },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return { status: "applied" };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || isConditionFailure(err)) {
        const raw = (err as { Item?: Record<string, unknown> }).Item;
        if (raw) return { status: "stale", current: fromRow(unmarshallIfNeeded(raw)) };
        // Shouldn't happen (ALL_OLD), but fall back to a read.
        const current = await this.get(sub, entity.type, entity.id);
        if (current) return { status: "stale", current };
      }
      throw err;
    }
  }

  async pull(
    sub: string,
    opts: { after: string; before: string; limit: number },
  ): Promise<PullPage> {
    const pk = userPk(sub);
    const input: QueryCommandInput = {
      TableName: this.tableName,
      IndexName: "GSI2",
      // Positions start with synced_at, so `< before` keeps only settled writes.
      KeyConditionExpression: "GSI2PK = :pk AND GSI2SK < :before",
      ExpressionAttributeValues: { ":pk": pk, ":before": opts.before },
      Limit: opts.limit,
    };
    if (opts.after) {
      input.ExclusiveStartKey = {
        GSI2PK: pk,
        GSI2SK: opts.after,
        PK: pk,
        SK: sortKeyFromPosition(opts.after),
      };
    }
    const out = (await this.client.send(new QueryCommand(input))) as {
      Items?: Record<string, unknown>[];
      LastEvaluatedKey?: Record<string, unknown>;
    };
    const rows = (out.Items ?? []).map((row) => ({
      entity: fromRow(row),
      position: String(row.GSI2SK),
    }));
    return { rows, hasMore: out.LastEvaluatedKey !== undefined };
  }

  getProfile(sub: string): Promise<Entity | undefined> {
    return this.get(sub, "PROFILE", sub);
  }

  async deleteAll(sub: string): Promise<number> {
    const pk = userPk(sub);
    let deleted = 0;
    let start: Record<string, unknown> | undefined;
    do {
      // Keys only. Every item of a user shares the partition key, so this finds all of them
      // (GSI rows go with their items).
      const page = (await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey: start,
        }),
      )) as { Items?: { PK: string; SK: string }[]; LastEvaluatedKey?: Record<string, unknown> };
      const keys = (page.Items ?? []).map(({ PK, SK }) => ({ PK, SK }));
      for (let i = 0; i < keys.length; i += BATCH_DELETE) {
        await this.deleteBatch(keys.slice(i, i + BATCH_DELETE));
      }
      deleted += keys.length;
      start = page.LastEvaluatedKey;
    } while (start);
    return deleted;
  }

  /** BatchWriteItem deletes, retrying whatever DynamoDB leaves unprocessed (with backoff). */
  private async deleteBatch(keys: { PK: string; SK: string }[]): Promise<void> {
    let requests = keys.map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error("DynamoDB kept items unprocessed");
      if (attempt > 0) await sleep(50 * 2 ** attempt);
      const out = (await this.client.send(
        new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
      )) as { UnprocessedItems?: Record<string, typeof requests> };
      requests = out.UnprocessedItems?.[this.tableName] ?? [];
    }
  }

  async list(sub: string, type: Exclude<EntityType, "PROFILE" | "WORKOUT">): Promise<Entity[]> {
    const items: Entity[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      // The trailing `#` matters: `ROUTINE#` must not match `ROUTINE_FOLDER#...`.
      const page = (await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": userPk(sub), ":prefix": `${type}#` },
          ExclusiveStartKey: start,
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const row of page.Items ?? []) items.push(fromRow(row));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  async workouts(
    sub: string,
    opts: { from?: string; to?: string; limit: number },
  ): Promise<Entity[]> {
    const items: Entity[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      // GSI1 sort key is `<started_at>#<id>`, so a string range on it is a date range.
      const page = (await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to",
          ExpressionAttributeValues: {
            ":pk": `${userPk(sub)}#WORKOUT`,
            ":from": opts.from ?? "",
            ":to": `${opts.to ?? WORKOUT_KEY_MAX}#${WORKOUT_KEY_MAX}`,
          },
          ScanIndexForward: false,
          Limit: opts.limit - items.length,
          ExclusiveStartKey: start,
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const row of page.Items ?? []) items.push(fromRow(row));
      start = page.LastEvaluatedKey;
    } while (start && items.length < opts.limit);
    return items;
  }

  async get(sub: string, type: EntityType, id: string): Promise<Entity | undefined> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userPk(sub), SK: sortKey(type, id) },
        ConsistentRead: true,
      }),
    )) as { Item?: Record<string, unknown> };
    return out.Item ? fromRow(out.Item) : undefined;
  }
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";
}

/** The exception carries the old item in DynamoDB's wire format (`{ PK: { S: "..." } }`). */
function unmarshallIfNeeded(item: Record<string, unknown>): Record<string, unknown> {
  const pk = item.PK;
  if (pk !== null && typeof pk === "object" && "S" in pk) {
    return unmarshall(item as Parameters<typeof unmarshall>[0]);
  }
  return item;
}
