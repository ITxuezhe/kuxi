// @vitest-environment node
/**
 * SQL 分类与多语句守卫测试。
 *
 * 核心：CREATE TRIGGER / PROCEDURE / FUNCTION 的体内合法包含分号，
 * 多语句检测必须感知 BEGIN...END 块与 PG dollar-quote，否则用户建不了触发器；
 * 同时普通多语句（SELECT 1; SELECT 2）与字符串内分号的行为不能回归。
 */
import { describe, it, expect } from 'vitest';
import { analyzeSql } from '@kuxi/core';

describe('analyzeSql 多语句守卫', () => {
  it('普通多语句仍被识别（守卫不能放松）', () => {
    const a = analyzeSql('SELECT 1; SELECT 2;');
    expect(a.multi).toBe(true);
    expect(a.statementCount).toBe(2);
  });

  it('字符串字面量里的分号不参与切分', () => {
    const a = analyzeSql(`SELECT 'a;b' FROM t WHERE c = 'x;y'`);
    expect(a.multi).toBe(false);
    expect(a.statementCount).toBe(1);
  });

  it('DROP ... IF EXISTS 的 IF 不当作块', () => {
    const a = analyzeSql('DROP TABLE IF EXISTS a; SELECT 1;');
    expect(a.multi).toBe(true);
    expect(a.statementCount).toBe(2);
  });

  it('SQLite 触发器（体内含分号）识别为单条 DDL', () => {
    const a = analyzeSql(`CREATE TRIGGER audit AFTER INSERT ON users
      BEGIN
        INSERT INTO log(msg) VALUES ('x');
        DELETE FROM tmp;
      END`);
    expect(a.kind).toBe('ddl');
    expect(a.multi).toBe(false);
    expect(a.statementCount).toBe(1);
    // 体内的 DELETE/INSERT 不影响风险画像（head 是 CREATE）
    expect(a.dangerous).toBe(false);
  });

  it('触发器后粘贴的第二条语句仍会被切出来', () => {
    const a = analyzeSql(`CREATE TRIGGER audit AFTER INSERT ON users
      BEGIN
        SELECT 1;
      END;
      SELECT 2;`);
    expect(a.multi).toBe(true);
    expect(a.statementCount).toBe(2);
  });

  it('MySQL 存储过程：definer 前缀 + BEGIN/IF...THEN/END IF', () => {
    const a = analyzeSql(`CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE p(IN n INT)
      BEGIN
        IF n > 0 THEN
          INSERT INTO t VALUES (n);
        END IF;
      END`);
    expect(a.kind).toBe('ddl');
    expect(a.multi).toBe(false);
    expect(a.statementCount).toBe(1);
  });

  it('PG 函数：$fn$ dollar-quote 内的分号不切分', () => {
    const a = analyzeSql(`CREATE OR REPLACE FUNCTION add_one(n INT) RETURNS INT AS $fn$
      BEGIN
        RETURN n + 1;
      END;
      $fn$ LANGUAGE plpgsql;`);
    expect(a.kind).toBe('ddl');
    expect(a.multi).toBe(false);
    expect(a.statementCount).toBe(1);
  });

  it('未配对的方言形态（MySQL WHILE...DO）回退普通切分，保守拒绝', () => {
    const a = analyzeSql(`CREATE PROCEDURE p()
      BEGIN
        WHILE i < 10 DO
          SET i = i + 1;
        END WHILE;
      END`);
    // WHILE...DO 不在块配对规则里 → 回退按分号切 → 视为多条语句拒绝（宁可误报）
    expect(a.multi).toBe(true);
  });

  it('块内嵌套 CASE...END 不破坏 BEGIN 配对', () => {
    const a = analyzeSql(`CREATE TRIGGER t AFTER UPDATE ON s
      BEGIN
        SELECT CASE WHEN NEW.x > 0 THEN 'a' ELSE 'b' END;
      END`);
    expect(a.multi).toBe(false);
    expect(a.statementCount).toBe(1);
  });
});
