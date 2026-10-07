// ============================================================
// 导出目录发布器（S1 B08）—— Node 专用（server / CLI 共用）
// 问题与证据.md B08 的修复约定：唯一任务标识 + 临时导出目录，
// 全部文件成功后原子重命名发布；目标目录已存在（同一秒并发导出等）
// 时自动追加序号重试，绝不覆盖既有导出包；任一步失败清理临时目录
// 并抛出，不留下半成品目录。
// 目录名带短随机后缀，从源头避免同一秒两次导出生成同名目录。
// ============================================================
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// writeFiles(tmpDir)：把全部产物写入临时目录；成功后由本函数重命名发布。
// 返回最终发布目录的绝对路径。
export async function publishExportDir(rootDir, baseName, writeFiles) {
  for (let attempt = 1; attempt <= 100; attempt++) {
    const final = path.join(rootDir, attempt === 1 ? baseName : `${baseName}-${attempt}`);
    const tmp = path.join(rootDir, `.${path.basename(final)}.tmp-${randomUUID()}`);
    try {
      await fsp.mkdir(tmp, { recursive: true });
      await writeFiles(tmp);
      await fsp.rename(tmp, final);
      return final;
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      const collides = e && (e.code === 'EEXIST' || e.code === 'ENOTEMPTY' || e.code === 'EPERM');
      if (!collides) throw e;
      // 目标目录已被并发导出占用：换下一个序号重试
    }
  }
  throw new Error('无法生成唯一的导出目录（连续 100 次碰撞）：' + baseName);
}

// 导出目录名的唯一任务后缀（同秒并发也不重名；显示上仍是 时间戳_短标识）
export function exportTaskSuffix() {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}
