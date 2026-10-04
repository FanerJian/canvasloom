// ============================================================
// 项目文件锁 —— 让"读修订号 → 比较 → 写入"成为跨进程互斥事务
// Node 专用（同步阻塞实现，本地低并发场景足够）。
// 锁文件带写入者令牌；超过 staleMs 的陈旧锁视为进程崩溃残留，允许抢占。
// ============================================================
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 在 lockFile 的独占锁内执行 fn() 并返回其结果。
 * @param {string} lockFile
 * @param {() => any} fn  锁内临界区（建议全部用同步 fs）
 * @param {{ timeoutMs?: number, staleMs?: number, retryMs?: number }} opts
 */
export function withFileLock(lockFile, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 10000;
  const retryMs = opts.retryMs ?? 25;
  const start = Date.now();
  const token = randomUUID();
  fsSync.mkdirSync(path.dirname(lockFile), { recursive: true });

  let fd = null;
  for (;;) {
    try {
      fd = fsSync.openSync(lockFile, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁抢占（持锁进程崩溃残留）
      try {
        const st = fsSync.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fsSync.unlinkSync(lockFile); } catch { /* 别人抢先释放 */ }
        }
      } catch { /* 锁刚刚被释放，直接重试 */ }
      if (Date.now() - start > timeoutMs) {
        const err = new Error('获取项目写入锁超时：' + lockFile);
        err.code = 'E_LOCK_TIMEOUT';
        throw err;
      }
      sleepSync(retryMs);
    }
  }

  try {
    fsSync.writeFileSync(fd, token);
    try { fsSync.closeSync(fd); } catch { /* 下方统一忽略 */ }
    fd = null;
    return fn();
  } finally {
    // 只删除自己创建的锁，避免误删他人的新锁
    try {
      if (fsSync.readFileSync(lockFile, 'utf8') === token) fsSync.unlinkSync(lockFile);
    } catch { /* 已被抢占或清理 */ }
  }
}

/** 由项目文件路径推导锁文件路径（同目录 .locks/ 下，与文件同名） */
export function lockFileFor(projectFile) {
  const dir = path.join(path.dirname(projectFile), '.locks');
  const base = path.basename(projectFile) + '.lock';
  return path.join(dir, base);
}
