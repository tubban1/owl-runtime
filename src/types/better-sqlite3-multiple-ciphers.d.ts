declare module "better-sqlite3-multiple-ciphers" {
  export interface Statement<Result = unknown> {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Result | undefined;
    all(...params: unknown[]): Result[];
  }

  export interface Database {
    prepare<Result = unknown>(source: string): Statement<Result>;
    exec(source: string): this;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    key(key: Buffer): number;
    rekey(key: Buffer): number;
    close(): this;
  }

  interface DatabaseConstructor {
    new(
      filename?: string | Buffer,
      options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
    ): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
