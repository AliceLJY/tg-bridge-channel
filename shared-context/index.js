/**
 * 共享上下文工厂 — 根据配置选择 SQLite / JSON / Redis 后端
 */
import { createSqliteBackend } from "./sqlite.js";
import { createJsonBackend } from "./json.js";
import { createRedisBackend } from "./redis.js";

let backend = null;
let backendType = "";
let lastWriteError = null;
let lastReadError = null;

const BACKENDS = { sqlite: createSqliteBackend, json: createJsonBackend, redis: createRedisBackend };

/**
 * 初始化共享上下文后端
 * @param {object} config
 * @param {string} [config.sharedContextBackend] - "sqlite" | "json" | "redis"
 * @param {string} [config.sharedContextDb] - SQLite 文件路径
 * @param {string} [config.sharedContextJsonPath] - JSON 文件路径
 * @param {string} [config.redisUrl] - Redis 连接地址
 * @param {string} [config._baseDir] - 相对路径的基准目录
 */
export async function initSharedContext(config) {
  const type = config.sharedContextBackend || "sqlite";
  const factory = BACKENDS[type] || BACKENDS.sqlite;
  backend = factory(config);
  backendType = type;
  lastWriteError = null;
  lastReadError = null;
  try {
    await backend.init();
    console.log(`[shared-context] Backend: ${type}`);
  } catch (error) {
    // 初始化失败(典型:Redis 不可用)降级为无共享上下文,绝不让整个 bridge 启动崩溃。
    // 运行时 write/read 见 backend=null 已 fail-open 跳过(只丢跨 bot 可见性,私聊不受影响)。
    // 否则 bridge.js 顶层 `await initSharedContext` 抛错 → start.js main().catch exit(1)
    // + plist KeepAlive=true → Redis 一抖动就把 bot 拖进崩溃重启循环(bridge-4.log 实录)。
    backend = null;
    lastWriteError = { message: `init failed: ${error.message}`, ts: Date.now() };
    console.error(`[shared-context] init failed (backend=${type}),降级运行,跨 bot 共享上下文暂不可用: ${error.message}`);
  }
}

/**
 * 写入一条共享消息
 */
export async function writeSharedMessage(chatId, msg) {
  if (!backend) return;
  try {
    await backend.write(chatId, msg);
    lastWriteError = null;
  } catch (error) {
    lastWriteError = {
      message: error.message,
      ts: Date.now(),
    };
    console.warn(`[shared-context] write failed: ${error.message}`);
  }
}

/**
 * 读取共享消息
 * @returns {Promise<Array<{ source: string, backend: string, role: string, text: string, tokens: number, ts: number }>>}
 */
export async function readSharedMessages(chatId, opts) {
  if (!backend) return [];
  try {
    const messages = await backend.read(chatId, opts);
    lastReadError = null;
    return messages;
  } catch (error) {
    lastReadError = {
      message: error.message,
      ts: Date.now(),
    };
    console.warn(`[shared-context] read failed: ${error.message}`);
    return [];
  }
}

export function getSharedContextStatus() {
  return {
    backend: backendType,
    lastWriteError,
    lastReadError,
  };
}

export function __setSharedContextBackendForTest(testBackend, type = "test") {
  backend = testBackend;
  backendType = type;
  lastWriteError = null;
  lastReadError = null;
}
