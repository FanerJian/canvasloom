// ============================================================
// S0 端到端验收脚本（对测试副本服务 http://127.0.0.1:18520 执行）
//   A01a  GET 8 个项目 → 文件哈希不变（打开不改源文件）
//   A01b  PUT v2 升级保存 → 返回 v1Backup；备份字节 == 原文件；磁盘变 v2 且语义保持
//   A01c  用旧 baseRevision 再次保存 → 409 冲突，文件未损坏
//   A01d  CLI apply 同样升级 v1→v2 并留备份
// 用法：node tests/acceptance/s0-acceptance.mjs
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PROJECTS = path.join(ROOT, 'projects');
const BASE = 'http://127.0.0.1:18520';

const results = [];
function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} ${id} ${name}${detail ? ' —— ' + detail : ''}`);
}

function hashTree() {
  const map = {};
  for (const f of fs.readdirSync(PROJECTS)) {
    if (!f.endsWith('.uidoc.json')) continue;
    map[f] = fs.readFileSync(path.join(PROJECTS, f), 'utf8');
  }
  return map;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- A01a：GET 全部 8 个项目，文件不变 ----------
const before = hashTree();
const names = Object.keys(before).map((f) => f.replace(/\.uidoc\.json$/, ''));
let getOk = true;
const getDetail = [];
for (const name of names) {
  const r = await fetch(`${BASE}/api/project?name=${encodeURIComponent(name)}`);
  const j = await r.json();
  if (!(r.status === 200 && j.ok && j.doc && j.doc.format === 'uidoc')) { getOk = false; getDetail.push(`${name}:${r.status}`); }
  else getDetail.push(`${name}:v${j.doc.version}`);
}
const afterGet = hashTree();
const unchanged = JSON.stringify(before) === JSON.stringify(afterGet);
record('A01a', 'GET 8 个项目且文件哈希不变', getOk && unchanged, getDetail.join('、') + (unchanged ? '；文件字节不变' : '；⚠ 文件被改动！'));

// ---------- A01b：升级保存 示例页面 → 备份 + v2 + 语义保持 ----------
const target = '示例页面';
const originalRaw = before[target + '.uidoc.json'];
const originalDoc = JSON.parse(originalRaw);
const get1 = await (await fetch(`${BASE}/api/project?name=${encodeURIComponent(target)}`)).json();
const upgraded = JSON.parse(JSON.stringify(get1.doc));
upgraded.version = 2;
const put1 = await fetch(`${BASE}/api/project`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: target, doc: upgraded, baseRevision: originalDoc.revision }),
});
const put1j = await put1.json();
let a01bOk = put1.status === 200 && put1j.ok;
let a01bDetail = `PUT ${put1.status}`;
const backupRel = put1j.v1Backup;
let backupBytesMatch = false;
if (a01bOk && backupRel) {
  const backupAbs = path.resolve(ROOT, backupRel);
  backupBytesMatch = fs.existsSync(backupAbs) && fs.readFileSync(backupAbs, 'utf8') === originalRaw;
  a01bDetail += `；备份 ${path.relative(ROOT, backupAbs)}${backupBytesMatch ? ' 字节一致' : ' ⚠内容不一致'}`;
}
const onDiskNow = JSON.parse(fs.readFileSync(path.join(PROJECTS, target + '.uidoc.json'), 'utf8'));
const semanticsOk = JSON.stringify(onDiskNow.components) === JSON.stringify(originalDoc.components)
  && onDiskNow.revision === originalDoc.revision + 1
  && onDiskNow.version === 2
  && JSON.stringify(onDiskNow.resources || {}) === JSON.stringify(originalDoc.resources || {});
a01bOk = a01bOk && backupBytesMatch && semanticsOk;
a01bDetail += `；磁盘版本 v${onDiskNow.version}，修订号 ${originalDoc.revision}→${onDiskNow.revision}，${semanticsOk ? '树/资源/修订语义保持' : '⚠语义变化！'}`;
record('A01b', 'v1 首存自动备份并写 v2', a01bOk, a01bDetail);

// ---------- A01c：旧 baseRevision 再保存 → 409 ----------
const put2 = await fetch(`${BASE}/api/project`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: target, doc: upgraded, baseRevision: originalDoc.revision }),
});
const rawAfterConflict = fs.readFileSync(path.join(PROJECTS, target + '.uidoc.json'), 'utf8');
const conflictOk = put2.status === 409 && rawAfterConflict === JSON.stringify(onDiskNow, null, 2);
record('A01c', '过期 baseRevision 被拒绝（409）且文件未损坏', conflictOk, `PUT ${put2.status}；文件与冲突前逐字节一致：${rawAfterConflict === JSON.stringify(onDiskNow, null, 2)}`);

// ---------- A01d：CLI apply 对另一个 v1 项目升级 ----------
const cliTarget = '布局规则核对';
const cliOriginalRaw = before[cliTarget + '.uidoc.json'];
const cliOriginal = JSON.parse(cliOriginalRaw);
const opsFile = path.join(HERE, 's0-ops.json');
fs.writeFileSync(opsFile, JSON.stringify({
  ops: [{ action: 'update', id: 'root', fields: { purpose: 'S0 验收：CLI 升级保存检查' } }],
  baseRevision: cliOriginal.revision,
}, null, 2), 'utf8');
const cli = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'cli.js'), 'apply', cliTarget, '--ops', opsFile, '--json'], { encoding: 'utf8' });
let cliOk = cli.status === 0;
let cliDetail = `exit ${cli.status}`;
try {
  const cj = JSON.parse(cli.stdout);
  const disk = JSON.parse(fs.readFileSync(path.join(PROJECTS, cliTarget + '.uidoc.json'), 'utf8'));
  const cliBackupOk = cj.v1Backup && fs.existsSync(path.resolve(ROOT, cj.v1Backup)) &&
    fs.readFileSync(path.resolve(ROOT, cj.v1Backup), 'utf8') === cliOriginalRaw;
  const cliSemantics = JSON.stringify(disk.components) === JSON.stringify(cliOriginal.components) ||
    disk.components.root.purpose === 'S0 验收：CLI 升级保存检查';
  cliOk = cliOk && cj.ok && disk.version === 2 && cliBackupOk && cliSemantics && disk.revision === cliOriginal.revision + 1;
  cliDetail += `；v${disk.version} rev${disk.revision}；备份${cliBackupOk ? '有效' : '无效'}`;
} catch (e) { cliDetail += '；解析失败：' + e.message; }
record('A01d', 'CLI apply 触发同样的 v1 备份 + v2 升级', cliOk, cliDetail);

// ---------- 汇总 ----------
fs.writeFileSync(path.join(HERE, 's0-acceptance-result.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');
const fails = results.filter((r) => !r.ok);
console.log(`\n==== S0 端到端验收：${results.length - fails.length}/${results.length} 通过 ====`);
process.exit(fails.length ? 1 : 0);
