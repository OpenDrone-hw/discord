// node:sqlite (built into Node 23) backs the fake D1 in these tests only.
// @types/node is not a dependency; this declares the part the tests use.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      all(...params: unknown[]): Array<Record<string, unknown>>;
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}

declare module "node:fs" {
  export function readdirSync(path: string | URL): string[];
}
