declare module "node:sqlite" {
  export interface StatementSync {
    run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get<T = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...parameters: unknown[]): T[];
    iterate<T = Record<string, unknown>>(...parameters: unknown[]): Iterable<T>;
    columns(): Array<{ name: string; column: string | null; table: string | null; database: string | null; type: string | null }>;
  }

  export class DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean; enableForeignKeyConstraints?: boolean; timeout?: number });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
