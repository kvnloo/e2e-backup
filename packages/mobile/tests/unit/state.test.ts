import { describe, expect, it } from 'vitest';
import { restoreAppState, STATE_FORMAT, type StateTarget } from '../../src/state/index.ts';
import { insertRow, SecureStore } from '../../src/state/rows.ts';

const target: StateTarget = { platform: 'ios', deviceId: '00000000-0000-0000-0000-000000000000', app: 'com.example.app' };
const signal = new AbortController().signal;
const state = (data: unknown, version = 1, format = STATE_FORMAT) => ({ format, version, data });
const files = Buffer.from('').toString('base64');

// Each refusal comes before any device command: the target's simulator does not exist.
describe('restoreAppState', () => {
  it('refuses another format or version', async () => {
    await expect(restoreAppState(target, state({}, 1, 'web-storage-state'), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(restoreAppState(target, state({}, 2), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a state saved for another app or platform', async () => {
    await expect(restoreAppState(target, state({ platform: 'ios', app: 'com.example.other', files }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(restoreAppState(target, state({ platform: 'android', app: target.app, files }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a keychain value that is not a SQL literal, or a column that is not an identifier', async () => {
    const withRow = (table: string, row: Record<string, string>) =>
      state({ platform: 'ios', app: target.app, files, keychain: { metadatakeys: [], genp: [], inet: [], cert: [], keys: [], [table]: [row] } });
    // The NUL: the sqlite3 shell cuts a line there, so the closing quote would go and the next value would run as statements.
    for (const literal of ["'a'); drop table genp; --", "x' or '1'='1", 'randomblob(9)', "'unterminated", "'a\0'"]) {
      await expect(restoreAppState(target, withRow('genp', { acct: literal }), signal), literal).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
    await expect(restoreAppState(target, withRow('genp', { 'acct) values (1); --': 'NULL' }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a state without the platform\'s own shape', async () => {
    await expect(restoreAppState(target, state({ platform: 'ios', app: target.app, files }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(restoreAppState({ ...target, platform: 'android' }, state({ platform: 'android', app: target.app, files: 7 }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses an app named by anything but a bundle id or package', async () => {
    await expect(restoreAppState({ ...target, app: 'My App; rm -rf /' }, state({}), signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('secure store rows', () => {
  const schema = new Map([['genp', ['acct', 'data', 'cdat', 'n']]]);
  const storeAnswering = (answer: (sql: string) => string) => {
    const statements: string[] = [];
    const store = new SecureStore('keychain', (_step, sql) => {
      statements.push(sql);
      return Promise.resolve(Buffer.from(answer(sql)));
    }, ['rowid']);
    return { store, statements };
  };

  it('reads every column but the ones the store assigns, as the literal quote() gives it', async () => {
    const { store, statements } = storeAnswering((sql) =>
      sql.startsWith('pragma') ? '0|rowid|INTEGER|0||1\n1|acct|BLOB|0||0\n2|data|BLOB|0||0\n' : `[{"acct":"'it''s'","data":"X'00ff'"}]`,
    );
    expect(await store.rows('genp', '1')).toEqual([{ acct: "'it''s'", data: "X'00ff'" }]);
    expect(statements.at(-1)).toBe("select coalesce(json_group_array(json_object('acct', quote(acct), 'data', quote(data))), '[]') from genp where 1;");
    expect(await store.schema(['genp'])).toEqual(new Map([['genp', ['acct', 'data']]]));
  });

  it('fails on output that is not rows, without quoting it', async () => {
    const { store } = storeAnswering((sql) => (sql.startsWith('pragma') ? '0|acct|BLOB|0||0\n' : 'Error: secret'));
    await expect(store.rows('genp', '1')).rejects.toThrow(/^reading the keychain: the device returned rows this engine cannot read$/);
  });

  it('writes its statements as one transaction', async () => {
    const { store, statements } = storeAnswering(() => '');
    await store.write(['delete from genp where 1;', insertRow('genp', { acct: "'it''s'", data: "X'00ff'", cdat: 'NULL', n: '-1.5e+3' }, schema)]);
    expect(statements).toEqual(["begin immediate;\ndelete from genp where 1;\ninsert into genp (acct, data, cdat, n) values ('it''s', X'00ff', NULL, -1.5e+3);\ncommit;"]);
  });

  it('refuses a row with a column the device does not have: another OS version wrote it', () => {
    expect(() => insertRow('genp', { acct: 'NULL', newer: 'NULL' }, schema)).toThrow(/no newer column/);
  });
});
