#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import mysql from "mysql2/promise";

function localEnv() {
  if (!existsSync(".env.local")) return {};
  const out = {};
  for (const raw of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = raw.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const fileEnv = localEnv();
const setting = (name, fallback = "") => process.env[name] || fileEnv[name] || fallback;
const required = ["YOUDESIGN_MYSQL_HOST", "YOUDESIGN_MYSQL_USER", "YOUDESIGN_MYSQL_PASSWORD"];
const missing = required.filter((name) => !setting(name));
if (missing.length) {
  console.error(`MySQL 配置缺失: ${missing.join(", ")}`);
  process.exit(1);
}

const connection = await mysql.createConnection({
  host: setting("YOUDESIGN_MYSQL_HOST"),
  port: Number(setting("YOUDESIGN_MYSQL_PORT", "3306")),
  database: setting("YOUDESIGN_MYSQL_DATABASE", "youdesign"),
  user: setting("YOUDESIGN_MYSQL_USER"),
  password: setting("YOUDESIGN_MYSQL_PASSWORD"),
  connectTimeout: Number(setting("YOUDESIGN_MYSQL_CONNECT_TIMEOUT_MS", "5000")),
  charset: "utf8mb4",
  timezone: "Z",
  multipleStatements: false,
});

let transactionOpen = false;
try {
  const [serverRows] = await connection.query("SELECT VERSION() AS version, DATABASE() AS db");
  const [columnRows] = await connection.query("SHOW COLUMNS FROM usage_records");
  const expected = [
    "id",
    "occurred_at",
    "user_id",
    "generation_request_id",
    "model",
    "stage",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_cny",
    "created_at",
  ];
  const actual = new Set(columnRows.map((row) => row.Field));
  const missingColumns = expected.filter((name) => !actual.has(name));
  if (missingColumns.length) throw new Error(`usage_records 缺少字段: ${missingColumns.join(", ")}`);

  await connection.beginTransaction();
  transactionOpen = true;
  const requestId = randomUUID();
  const [insertResult] = await connection.execute(
    `INSERT INTO usage_records
      (occurred_at, user_id, generation_request_id, model, stage,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cny)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [new Date(), "__mysql_verify__", requestId, "__connectivity_test__", "verify", 11, 7, 3, 0, 0.0001]
  );
  const [writtenRows] = await connection.execute(
    "SELECT generation_request_id, input_tokens, output_tokens, cost_cny FROM usage_records WHERE id = ?",
    [insertResult.insertId]
  );
  if (writtenRows.length !== 1 || writtenRows[0].generation_request_id !== requestId) {
    throw new Error("测试写入后未查到一致记录");
  }
  const [aggregateRows] = await connection.execute(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            COALESCE(SUM(cost_cny), 0) AS cost
     FROM usage_records
     WHERE generation_request_id = ?`,
    [requestId]
  );
  if (Number(aggregateRows[0]?.calls) !== 1 || Number(aggregateRows[0]?.inputTokens) !== 11) {
    throw new Error("测试记录聚合查询不一致");
  }
  await connection.rollback();
  transactionOpen = false;

  console.log(JSON.stringify({
    ok: true,
    server: serverRows[0],
    table: "usage_records",
    columns: expected.length,
    writeReadAggregateRollback: "passed",
  }, null, 2));
} finally {
  if (transactionOpen) await connection.rollback().catch(() => {});
  await connection.end();
}
