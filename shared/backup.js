// ============================================================
// v1 项目首次覆盖写入前的可恢复备份 —— Node 专用（filelock.js 同例）
// 规则：磁盘上是 v1（或无法解析）的项目文件，在第一次被新版写入覆盖前，
// 把原始字节完整复制到 projects/.v1-backups/；备份失败则调用方必须放弃写入。
// 备份文件名以 .uidoc.v1.json 结尾——不以 .uidoc.json 结尾，
// 因此不会被项目列表/文件监视器当成设计文件。
// ============================================================
import fsSync from 'node:fs';
import path from 'node:path';

export const V1_BACKUP_DIR = '.v1-backups';

function stamp(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 在覆盖写 projectFile 之前调用。读取磁盘现有内容：
 *   · 文件不存在                → { needed: false, reason: 'missing' }（新项目，无需备份）
 *   · 可解析且 version >= 2     → { needed: false, reason: 'already-v2' }
 *   · 其余（v1 / 解析失败）      → 复制原始字节到备份目录，返回 { needed: true, backupPath }
 * 备份失败（目录创建失败、磁盘错误等）会抛出异常——调用方捕获后不得写入原文件。
 */
export function backupV1BeforeWrite(projectFile, { now = new Date() } = {}) {
  let raw;
  try {
    raw = fsSync.readFileSync(projectFile, 'utf8');
  } catch {
    return { needed: false, reason: 'missing' };
  }
  let onDiskVersion = null;
  try { onDiskVersion = JSON.parse(raw).version ?? null; } catch { onDiskVersion = null; }
  if (onDiskVersion != null && onDiskVersion >= 2) {
    return { needed: false, reason: 'already-v2' };
  }
  const dir = path.join(path.dirname(projectFile), V1_BACKUP_DIR);
  fsSync.mkdirSync(dir, { recursive: true });
  const base = path.basename(projectFile).replace(/\.uidoc\.json$/, '') || '未命名';
  const rev = (() => { try { return JSON.parse(raw).revision ?? 0; } catch { return 0; } })();
  // 同一秒内多次备份不互相覆盖
  let backupPath = path.join(dir, `${base}_rev${rev}_${stamp(now)}.uidoc.v1.json`);
  let n = 1;
  while (fsSync.existsSync(backupPath)) {
    backupPath = path.join(dir, `${base}_rev${rev}_${stamp(now)}_${n}.uidoc.v1.json`);
    n++;
  }
  fsSync.writeFileSync(backupPath, raw, 'utf8');
  return { needed: true, backupPath, onDiskVersion };
}
