/**
 * Rows of a device's secure store (both are SQLite databases) as they travel
 * in a snapshot: each value is the SQL literal `quote()` gave it, so a blob or
 * a NULL comes back as what it was, and a restore writes the literal as is.
 */

import { z } from 'zod';
import { invalidState } from '../support.ts';
import { failure } from './host.ts';

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * What `quote()` emits: NULL, a number, a blob, or a string with its quotes
 * doubled. Nothing else may reach a statement. No NUL in a string: the
 * sqlite3 shell cuts its input line there, closing quote included.
 */
const LITERAL = /^(?:NULL|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|X'[0-9A-Fa-f]*'|'(?:[^'\0]|'')*')$/i;

/** Rows of one table, column name to literal. A snapshot is input: this is what keeps a crafted one out of a statement. */
export const Rows = z.array(z.record(z.string().regex(COLUMN), z.string().regex(LITERAL)));
export type Row = z.infer<typeof Rows>[number];

/** Runs statements on a store's database with the sqlite3 shell and returns its output. */
export type Sqlite = (step: string, sql: string) => Promise<Buffer>;
/** Each table's columns on the device at hand, which an OS version can change. */
export type Schema = ReadonlyMap<string, readonly string[]>;

/** A device's secure store. `assigned` names columns the store fills itself, which a snapshot leaves out. */
export class SecureStore {
  constructor(
    private readonly name: string,
    private readonly sqlite: Sqlite,
    private readonly assigned: readonly string[] = [],
  ) {}

  private async columns(table: string): Promise<string[]> {
    const listed = (await this.sqlite(`reading the ${this.name}`, `pragma table_info(${table});`)).toString('utf8');
    // List mode: the name is the second field.
    return listed.split('\n').flatMap((line) => line.split('|').slice(1, 2)).filter((column) => COLUMN.test(column) && !this.assigned.includes(column));
  }

  async schema(tables: readonly string[]): Promise<Schema> {
    return new Map(await Promise.all(tables.map(async (table) => [table, await this.columns(table)] as const)));
  }

  async rows(table: string, where: string): Promise<Row[]> {
    const pairs = (await this.columns(table)).map((column) => `'${column}', quote(${column})`).join(', ');
    const output = await this.sqlite(`reading the ${this.name}`, `select coalesce(json_group_array(json_object(${pairs})), '[]') from ${table} where ${where};`);
    try {
      return Rows.parse(JSON.parse(output.toString('utf8')));
    } catch {
      throw failure(`reading the ${this.name}: the device returned rows this engine cannot read`);
    }
  }

  /** All of `statements` or none. */
  async write(statements: readonly string[]): Promise<void> {
    await this.sqlite(`writing the ${this.name}`, ['begin immediate;', ...statements, 'commit;'].join('\n'));
  }
}

/** An insert of one captured row; `overrides` replace or add columns. */
export function insertRow(table: string, row: Row, schema: Schema, overrides: Row = {}): string {
  const values = { ...row, ...overrides };
  const columns = Object.keys(values);
  const known = schema.get(table) ?? [];
  const missing = columns.filter((column) => !known.includes(column));
  if (missing.length > 0) {
    throw invalidState(`the saved session cannot be restored on this device: its ${table} store has no ${missing.join(', ')} column, so it was saved on another OS version`);
  }
  return `insert into ${table} (${columns.join(', ')}) values (${columns.map((column) => values[column]).join(', ')});`;
}
