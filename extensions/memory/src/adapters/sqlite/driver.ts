import { chmod, mkdir, lstat, open as openFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StatementSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";
import { sha256 } from "../../shared/hash.ts";

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

export async function prepareDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dataDir);
  if (!stat.isDirectory()) throw new Error("Memory data path is not a directory");
  await chmod(dataDir, 0o700);
}

export async function openDatabase(dataDir: string): Promise<SqliteDb> {
  await prepareDataDir(dataDir);
  const dbPath = join(dataDir, "memory.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    db.exec(SCHEMA_SQL);
    const applied = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version ASC").all<{ version: number; checksum: string }>();
    const currentVersion = applied.length > 0 ? Math.max(...applied.map((row) => row.version)) : 0;
    if (currentVersion > SCHEMA_VERSION) throw new Error(`Database schema ${currentVersion} is newer than this extension (${SCHEMA_VERSION})`);
    for (const migration of MIGRATIONS.filter((item) => item.version > currentVersion && item.version <= SCHEMA_VERSION)) {
      withTransaction(db, () => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (?, ?, ?)").run(migration.version, Date.now(), sha256(migration.sql));
      });
    }
    for (const expected of MIGRATIONS.filter((migration) => migration.version <= SCHEMA_VERSION)) {
      const appliedRow = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(expected.version) as { checksum?: string } | undefined;
      if (!appliedRow || appliedRow.checksum !== sha256(expected.sql)) throw new Error(`Schema migration checksum mismatch at version ${expected.version}`);
    }
    verifyIntegrity(db);
    await ensureFileMode(dbPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function ensureFileMode(path: string): Promise<void> {
  const file = await openFile(path, "r");
  await file.close();
  await chmod(path, 0o600);
}

function verifyIntegrity(db: SqliteDb): void {
  const quick = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  const quickValue = quick ? Object.values(quick)[0] : undefined;
  if (quickValue !== "ok") throw new Error(`SQLite integrity check failed: ${String(quickValue)}`);
  const versionRow = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  const version = versionRow.version.split(".").map((part) => Number(part));
  if (version[0] < 3 || (version[0] === 3 && version[1] < 42)) throw new Error(`SQLite ${versionRow.version} is below the required 3.42.0`);
  const ftsRow = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as { enabled: number };
  if (ftsRow.enabled !== 1) throw new Error("SQLite was built without ENABLE_FTS5");
  const secure = db.prepare("SELECT v FROM memory_fts_config WHERE k = 'secure-delete'").get() as { v?: number } | undefined;
  if (secure?.v !== 1) throw new Error("FTS5 secure-delete is not enabled");
  db.prepare("INSERT INTO memory_fts(memory_fts) VALUES ('integrity-check')").run();
}

export function withTransaction<T>(db: SqliteDb, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

export function databasePath(dataDir: string): string {
  return join(dataDir, "memory.db");
}

export function databaseParent(dataDir: string): string {
  return dirname(databasePath(dataDir));
}
