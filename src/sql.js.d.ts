// Minimal type declarations for sql.js loaded via CDN script tag
declare module "sql.js" {
  export interface QueryExecResult {
    columns: string[];
    values: Array<Array<string | number | null>>;
  }

  export interface Database {
    exec(sql: string): QueryExecResult[];
    // Executes one or more statements, discarding any rows. Used to redefine
    // views on the in-memory copy of a downloaded DB. With `params` it takes a
    // single statement and binds them — the only way into this file that isn't
    // string interpolation, so it's what any value-carrying INSERT should use.
    run(sql: string, params?: Array<string | number | null>): Database;
    close(): void;
  }
}
