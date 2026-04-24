declare module 'sql.js' {
  interface QueryResults {
    columns: string[];
    values: any[][];
  }

  class Database {
    run(sql: string, params?: any[]): void;
    exec(sql: string, params?: any[]): QueryResults[];
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  interface SqlJsStatic {
    Database: typeof Database;
  }

  function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;

  export default initSqlJs;
  export { Database, SqlJsStatic, SqlJsConfig, QueryResults };
}
