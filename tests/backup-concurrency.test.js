// ============================================================
// v1 备份与并发防覆盖自动检查（全部在系统临时目录进行，不碰 projects/）
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupV1BeforeWrite } from '../shared/backup.js';
import { withFileLock, lockFileFor } from '../shared/filelock.js';

let tmpRoot = '';

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canvasloom-test-'));
});
test.after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 测试专用文件名：仅允许固定字符集的 basename，且解析后必须落在 tmpRoot 内
function tmpFile(basename) {
  if (typeof basename !== 'string' || !basename.match(/^[A-Za-z0-9_-]+\.uidoc\.json$/)) {
    throw new Error('测试文件名不合法：' + basename);
  }
  const file = path.join(tmpRoot, basename);
  if (!file.startsWith(tmpRoot + path.sep)) throw new Error('路径越界');
  return file;
}

function tmpProject(basename, doc) {
  const file = tmpFile(basename + '.uidoc.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return file;
}

const v1Sample = () => ({
  format: 'uidoc', version: 1, revision: 4, name: '备份测试',
  canvas: { width: 100, height: 80, background: '#ffffff' },
  resources: {}, components: {},
});

test('backupV1BeforeWrite：v1 文件被备份且字节一致，备份名不被当作设计文件', () => {
  const file = tmpProject('bk1', v1Sample());
  const r = backupV1BeforeWrite(file);
  assert.equal(r.needed, true);
  assert.ok(fs.existsSync(r.backupPath));
  assert.equal(fs.readFileSync(r.backupPath, 'utf8'), fs.readFileSync(file, 'utf8'), '备份内容必须与原文件逐字节一致');
  assert.ok(!r.backupPath.endsWith('.uidoc.json'), '备份文件名不得以 .uidoc.json 结尾');
  assert.ok(r.backupPath.includes('.v1-backups'));
});

test('backupV1BeforeWrite：v2 文件无需备份；缺失文件返回 missing', () => {
  const v2File = tmpProject('bk2', { ...v1Sample(), version: 2 });
  assert.equal(backupV1BeforeWrite(v2File).needed, false);
  assert.equal(backupV1BeforeWrite(tmpFile('missing0.uidoc.json')).reason, 'missing');
});

test('backupV1BeforeWrite：无法解析的文件也先备份（保护原数据）', () => {
  const file = tmpFile('broken.uidoc.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const r = backupV1BeforeWrite(file);
  assert.equal(r.needed, true);
  assert.equal(fs.readFileSync(r.backupPath, 'utf8'), '{ 这不是 JSON');
});

test('backupV1BeforeWrite：备份目录创建失败时抛错（调用方必须放弃写入）', () => {
  const dir = path.join(tmpRoot, 'bkfail');
  fs.mkdirSync(dir);
  // 预先占用 .v1-backups 为普通文件 → mkdirSync 必然失败
  fs.writeFileSync(path.join(dir, '.v1-backups'), '占用', 'utf8');
  const file = path.join(dir, 'x.uidoc.json');
  fs.writeFileSync(file, JSON.stringify(v1Sample()), 'utf8');
  assert.throws(() => backupV1BeforeWrite(file));
});

// ---------- 并发防覆盖 ----------
function writerSim(file, baseRevision) {
  // 模拟 server PUT / CLI apply 的事务：锁内比较 baseRevision → 写入
  return withFileLock(lockFileFor(file), () => {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (baseRevision !== cur.revision) return { conflict: true, currentRevision: cur.revision };
    cur.revision = cur.revision + 1;
    const tmp = file + '.tmp-writer';
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, revision: cur.revision };
  });
}

test('同一 baseRevision 的两次提交：恰好一次成功，另一次冲突且文件未损坏', () => {
  const file = tmpProject('conc', { ...v1Sample(), revision: 3 });
  const a = writerSim(file, 3);
  assert.equal(a.ok, true);
  assert.equal(a.revision, 4);
  const b = writerSim(file, 3);
  assert.equal(b.conflict, true);
  assert.equal(b.currentRevision, 4);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.revision, 4, '冲突写入不得落盘');
});

test('filelock：互斥——持锁期间再次获取按超时失败', () => {
  const file = tmpProject('lock', v1Sample());
  const lock = lockFileFor(file);
  const fd = fs.openSync(lock, 'wx');
  try {
    assert.throws(() => withFileLock(lock, () => {}, { timeoutMs: 150, retryMs: 10 }),
      (e) => e.code === 'E_LOCK_TIMEOUT');
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
});

test('filelock：陈旧锁（超过 staleMs）被抢占', () => {
  const file = tmpProject('stale', v1Sample());
  const lock = lockFileFor(file);
  fs.writeFileSync(lock, 'dead-token', 'utf8');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lock, past, past);
  const r = withFileLock(lock, () => 'ran');
  assert.equal(r, 'ran', '陈旧锁应可被抢占并进入临界区');
});
