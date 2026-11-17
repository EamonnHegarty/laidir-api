import type { Entity } from "../src/api/entities.js";
import {
  type FeedRow,
  type PullPage,
  type PutOutcome,
  type Store,
  fromRow,
  sortKey,
  toRow,
  userPk,
} from "../src/api/store.js";

/**
 * In-memory Store with DynamoDB's semantics for what the API relies on: the conditional write
 * (new item, or strictly later updated_at), GSI2 ordering by position, the exclusive start and
 * the `< before` key condition. Rows go through the real toRow/fromRow.
 */
export class FakeStore implements Store {
  readonly rows = new Map<string, Record<string, unknown>>();

  put(sub: string, entity: Entity, syncedAt: string): Promise<PutOutcome> {
    const key = `${userPk(sub)}|${sortKey(entity.type, entity.id)}`;
    const existing = this.rows.get(key);
    if (existing && !(String(existing.updated_at) < entity.updated_at)) {
      return Promise.resolve({ status: "stale", current: fromRow(structuredClone(existing)) });
    }
    this.rows.set(key, structuredClone(toRow(sub, entity, syncedAt)));
    return Promise.resolve({ status: "applied" });
  }

  pull(sub: string, opts: { after: string; before: string; limit: number }): Promise<PullPage> {
    const feed = [...this.rows.values()]
      .filter((row) => row.GSI2PK === userPk(sub))
      .map((row) => ({ row, position: String(row.GSI2SK) }))
      .filter(({ position }) => position < opts.before && position > opts.after)
      .sort((a, b) => (a.position < b.position ? -1 : 1));
    const page = feed.slice(0, opts.limit);
    const rows: FeedRow[] = page.map(({ row, position }) => ({
      entity: fromRow(structuredClone(row)),
      position,
    }));
    // DynamoDB returns LastEvaluatedKey whenever it stopped at Limit.
    return Promise.resolve({ rows, hasMore: page.length === opts.limit });
  }

  deleteAll(sub: string): Promise<number> {
    let n = 0;
    for (const [key, row] of this.rows) {
      if (row.PK === userPk(sub)) {
        this.rows.delete(key);
        n++;
      }
    }
    return Promise.resolve(n);
  }

  getProfile(sub: string): Promise<Entity | undefined> {
    const row = this.rows.get(`${userPk(sub)}|PROFILE`);
    return Promise.resolve(row ? fromRow(structuredClone(row)) : undefined);
  }
}
