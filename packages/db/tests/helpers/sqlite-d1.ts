import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

type SqlParam = string | number | bigint | Uint8Array | null;

/**
 * Lightweight in-memory D1Database test adapter backed by Node's built-in node:sqlite.
 * Allows executing real Drizzle ORM queries and real SQL migration files locally
 * without provisioning a remote Cloudflare D1 database.
 */
export function createSqliteD1TestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  function makeStatement(query: string, params: SqlParam[] = []) {
    return {
      bind(...bound: SqlParam[]) {
        return makeStatement(query, bound);
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const stmt = sqlite.prepare(query);
        const row = stmt.get(...params) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      },
      async run() {
        const stmt = sqlite.prepare(query);
        const info = stmt.run(...params);
        return {
          success: true,
          meta: {
            changed_db: info.changes > 0,
            changes: Number(info.changes),
            duration: 0,
            last_row_id: Number(info.lastInsertRowid ?? 0),
            rows_read: 0,
            rows_written: Number(info.changes),
            size_after: 0
          },
          results: []
        };
      },
      async all<T = Record<string, unknown>>() {
        const stmt = sqlite.prepare(query);
        const rows = stmt.all(...params) as T[];
        return {
          success: true,
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            rows_read: rows.length,
            rows_written: 0,
            size_after: 0
          },
          results: rows
        };
      },
      async raw<T = unknown[]>({ columnNames }: { columnNames?: boolean } = {}) {
        const stmt = sqlite.prepare(query);
        stmt.setReturnArrays(true);
        const values = stmt.all(...params) as T[];
        if (!columnNames || values.length === 0) return values;
        const cols = stmt.columns().map((c) => c.name);
        return [cols as unknown as T, ...values] as T[];
      }
    };
  }

  const d1 = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch(statements: ReturnType<typeof makeStatement>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) {
          results.push(await s.all());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    }
  } as unknown as D1Database;

  return { sqlite, d1 };
}

export function applyPhase1Migrations(sqlite: DatabaseSync) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _test_migrations (name TEXT PRIMARY KEY);');
  const migrationsDir = path.resolve(import.meta.dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const alreadyApplied = sqlite
      .prepare('SELECT 1 FROM _test_migrations WHERE name = ?')
      .get(file);
    if (alreadyApplied) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
    sqlite.prepare('INSERT INTO _test_migrations (name) VALUES (?)').run(file);
  }
}
