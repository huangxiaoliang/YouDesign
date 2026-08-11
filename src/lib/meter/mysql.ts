import mysql, { type Pool } from "mysql2/promise";
import { config } from "@/lib/config";

type MysqlGlobal = typeof globalThis & {
  __youdesignMysqlPool?: Pool;
};

const mysqlGlobal = globalThis as MysqlGlobal;

export function mysqlUsageConfigured(): boolean {
  return Boolean(config.mysql.host && config.mysql.database && config.mysql.user && config.mysql.password);
}

/**
 * Node/Next 服务端共用连接池。开发态挂到 globalThis，避免热更新重复创建连接池。
 * 用量表的 DATETIME 统一按 UTC 读写；看板再转换为中国自然日。
 */
export function getMysqlPool(): Pool {
  if (!mysqlUsageConfigured()) {
    throw new Error("MySQL 用量库未配置（需设置 YOUDESIGN_MYSQL_HOST/USER/PASSWORD）");
  }
  if (!mysqlGlobal.__youdesignMysqlPool) {
    mysqlGlobal.__youdesignMysqlPool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      database: config.mysql.database,
      user: config.mysql.user,
      password: config.mysql.password,
      connectionLimit: config.mysql.connectionLimit,
      connectTimeout: config.mysql.connectTimeoutMs,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      timezone: "Z",
      charset: "utf8mb4",
      decimalNumbers: true,
      dateStrings: true,
      multipleStatements: false,
    });
  }
  return mysqlGlobal.__youdesignMysqlPool;
}
