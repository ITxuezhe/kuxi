import { ConnectionManager, analyzeSql, classifySql, echo, SqliteDriver } from '../index';
import type { IConnectionConfig } from '@kuxi/shared';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  ❌ FAIL:', msg);
    failures++;
  } else {
    console.log('  ✅ PASS:', msg);
  }
}

/** 断言某个 await 会抛出指定 code 的错误，返回错误对象（便于进一步检查） */
async function expectCode(
  fn: () => Promise<unknown>,
  code: string,
  msg: string,
): Promise<{ code?: string; analysis?: { reasons: string[] } } | null> {
  try {
    await fn();
    assert(false, `${msg}（期望抛出 ${code}，实际成功）`);
    return null;
  } catch (e) {
    const err = e as { code?: string; analysis?: { reasons: string[] } };
    assert(err.code === code, `${msg}（实际 code=${err.code}）`);
    return err;
  }
}

async function main(): Promise<void> {
  console.log(echo('core 验证脚本启动'));

  // 1) classifySql 单元测试
  console.log('\n[1] SQL 分类');
  assert(classifySql('SELECT * FROM users') === 'read', 'SELECT 分类为 read');
  assert(classifySql('  select 1') === 'read', '前导空格 + 小写 select 仍为 read');
  assert(classifySql('WITH cte AS (SELECT 1) SELECT * FROM cte') === 'read', 'WITH 查询为 read');
  assert(classifySql('INSERT INTO t VALUES(1)') === 'write', 'INSERT 为 write');
  assert(classifySql('CREATE TABLE t(id INT)') === 'ddl', 'CREATE 为 ddl');
  assert(classifySql('/* 注释 */  select 1') === 'read', '注释后的 select 仍为 read');

  // 2) analyzeSql 风险分析
  console.log('\n[2] SQL 风险分析（危险语句识别）');
  assert(analyzeSql('SELECT 1').dangerous === false, 'SELECT 不危险');
  assert(analyzeSql('DELETE FROM t WHERE id = 1').dangerous === false, '带 WHERE 的 DELETE 不危险');
  assert(analyzeSql('DELETE FROM t').dangerous === true, '不带 WHERE 的 DELETE 判为危险');
  assert(analyzeSql('UPDATE t SET a = 1').dangerous === true, '不带 WHERE 的 UPDATE 判为危险');
  assert(analyzeSql('UPDATE t SET a = 1 WHERE id = 2').dangerous === false, '带 WHERE 的 UPDATE 不危险');
  assert(analyzeSql('DROP TABLE t').dangerous === true, 'DROP 判为危险');
  assert(analyzeSql('TRUNCATE TABLE t').dangerous === true, 'TRUNCATE 判为危险');
  assert(
    analyzeSql("DELETE FROM t WHERE name = 'where drop'").dangerous === false,
    '字符串字面量里的关键字不误导判断',
  );
  assert(analyzeSql('DROP').head === 'DROP', 'head 提取为大写关键字');
  assert(analyzeSql('SELECT 1; SELECT 2').multi === true, '多语句被识别');
  assert(analyzeSql("SELECT ';' AS a").multi === false, '字面量里的分号不算多语句');
  assert(analyzeSql('SELECT 1; SELECT 2').statementCount === 2, '语句条数统计正确');

  // 3) 底层 SqliteDriver 端到端
  console.log('\n[3] SqliteDriver 底层');
  const driver = new SqliteDriver({ name: 'mem', type: 'sqlite', filename: ':memory:' });
  assert(driver.isConnected() === false, '初始未连接');
  await driver.connect();
  assert(driver.isConnected() === true, 'connect 后已连接');
  await driver.query('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
  await driver.query('INSERT INTO t(name) VALUES(?)', ['alice']);
  const ins = await driver.query('INSERT INTO t(name) VALUES(?)', ['bob']);
  assert(ins.affectedRows === 1, `INSERT 返回受影响行数: ${ins.affectedRows}`);
  const r1 = await driver.query('SELECT * FROM t ORDER BY id');
  assert(r1.columns.join(',') === 'id,name', `列名正确: ${r1.columns.join(',')}`);
  assert(r1.rowCount === 2, `行数正确: ${r1.rowCount}`);
  assert(r1.rows[0].name === 'alice', '首行数据正确');
  assert(typeof r1.tookMs === 'number' && r1.tookMs >= 0, `耗时字段存在: ${r1.tookMs}ms`);
  const upd = await driver.query("UPDATE t SET name = 'x' WHERE name = 'alice'");
  assert(upd.affectedRows === 1, `UPDATE 返回受影响行数: ${upd.affectedRows}`);
  const schema = await driver.getSchema();
  assert(schema.tables.length === 1 && schema.tables[0].name === 't', 'schema 包含表 t');
  assert(schema.tables[0].columns.some((c) => c.primaryKey), '主键识别正确');
  const tables = await driver.listTables();
  assert(tables.includes('t'), 'listTables 返回 t');
  await driver.close();
  assert(driver.isConnected() === false, 'close 后断开');

  // 4) ConnectionManager + 分级护栏
  console.log('\n[4] ConnectionManager 与分级护栏');
  const mgr = new ConnectionManager();
  const cfg: IConnectionConfig = { name: 'mem', type: 'sqlite', filename: ':memory:' };
  const id = await mgr.connect(cfg);
  assert(mgr.list().length === 1, '连接已注册');
  await mgr.query(id, 'CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT)', { allowDdl: true });
  await mgr.query(id, "INSERT INTO u(name) VALUES('carol')", { allowWrite: true });
  await mgr.query(id, "INSERT INTO u(name) VALUES('dave')", { allowWrite: true });
  const r2 = await mgr.query(id, 'SELECT * FROM u');
  assert(r2.rowCount === 2 && r2.rows[0].name === 'carol', 'manager 读查询返回种子数据');

  // 只读模式：写被拒
  await expectCode(() => mgr.query(id, 'DELETE FROM u WHERE id = 1'), 'READ_ONLY_REJECTED', '默认只读拒绝 DELETE');

  // 开写但危险语句：要确认
  const err1 = await expectCode(
    () => mgr.execute(id, 'DELETE FROM u', { allowWrite: true }),
    'CONFIRM_REQUIRED',
    '无 WHERE 的 DELETE 需要二次确认',
  );
  assert(Boolean(err1?.analysis?.reasons.length), 'CONFIRM_REQUIRED 带回危险原因');

  // 确认后放行，并返回受影响行数
  const del = await mgr.execute(id, 'DELETE FROM u', { allowWrite: true, confirmed: true });
  assert(del.affectedRows === 2, `确认后 DELETE 生效，影响 ${del.affectedRows} 行`);
  const r3 = await mgr.query(id, 'SELECT * FROM u');
  assert(r3.rowCount === 0, 'DELETE 后表为空');

  // 多语句被拒
  await expectCode(
    () => mgr.execute(id, "INSERT INTO u(name) VALUES('a'); INSERT INTO u(name) VALUES('b')", {
      allowWrite: true,
      confirmed: true,
    }),
    'MULTI_STATEMENT_REJECTED',
    '多语句被拒绝',
  );

  // 事务：成功提交
  const tx = await mgr.transaction(id, [
    "INSERT INTO u(name) VALUES('e1')",
    "INSERT INTO u(name) VALUES('e2')",
  ]);
  assert(tx.executed === 2, `事务执行 2 条，实际 ${tx.executed}`);
  const r4 = await mgr.query(id, 'SELECT * FROM u');
  assert(r4.rowCount === 2, '事务提交后数据可见');

  // 事务：中途失败回滚
  let txFailed = false;
  try {
    await mgr.transaction(id, [
      "INSERT INTO u(name) VALUES('e3')",
      'INSERT INTO not_exist_table(name) VALUES(1)',
    ]);
  } catch {
    txFailed = true;
  }
  assert(txFailed, '事务中失败会抛错');
  const r5 = await mgr.query(id, 'SELECT * FROM u');
  assert(r5.rowCount === 2, `事务失败后回滚，行数仍为 2（实际 ${r5.rowCount}）`);

  // 结果行上限
  await mgr.query(id, 'CREATE TABLE big(id INT)', { allowDdl: true });
  for (let i = 0; i < 5; i++) {
    await mgr.query(id, 'INSERT INTO big(id) VALUES(?)', { allowWrite: true, params: [i] });
  }
  const r6 = await mgr.query(id, 'SELECT * FROM big', { maxRows: 3 });
  assert(r6.rowCount === 3, `结果行被 maxRows 截断为 3: ${r6.rowCount}`);
  assert(r6.truncated === true, 'truncated 标记正确');

  await mgr.disconnect(id);
  assert(mgr.list().length === 0, 'disconnect 后注销');

  // 5) 连接测试
  console.log('\n[5] test() 健康检查');
  const t = await mgr.test({ name: 't', type: 'sqlite', filename: ':memory:' });
  assert(t.ok === true, `SQLite test 通过: ${t.message}`);

  console.log(`\n${failures === 0 ? '🎉 core 全部验证通过' : `⚠️  有 ${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
