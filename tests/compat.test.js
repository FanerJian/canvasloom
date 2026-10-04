// ============================================================
// v1/v2 兼容层自动检查：迁移语义保持、版本拒绝
// 只读测试：不修改 projects/ 中的任何文件。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeDoc, inspectDocVersion, migrationPreservesSemantics, CompatError } from '../shared/compat.js';
import { validateDoc } from '../shared/validate.js';
import { DOC_VERSION } from '../shared/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(HERE, '..', 'projects');

function loadProjectCopies() {
  return fs.readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.uidoc.json'))
    .map((f) => ({ file: f, doc: JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8')) }));
}

test('现有项目副本均可读且为受支持版本', () => {
  const docs = loadProjectCopies();
  assert.ok(docs.length >= 8, `至少应有 8 个项目文件，实际 ${docs.length}`);
  for (const { file, doc } of docs) {
    assert.equal(inspectDocVersion(doc).supported, true, `${file} 版本检查应通过`);
  }
});

test('upgradeDoc：升级/拷贝除版本号外内容完全一致，且不改原对象', () => {
  for (const { file, doc } of loadProjectCopies()) {
    const upgraded = upgradeDoc(doc);
    assert.equal(upgraded.version, DOC_VERSION, `${file} 升级后应为 v${DOC_VERSION}`);
    assert.deepEqual(upgraded.components, doc.components, `${file} components 必须原样保留`);
    assert.deepEqual(upgraded.resources || {}, doc.resources || {}, `${file} resources 必须原样保留`);
    assert.equal(upgraded.revision, doc.revision, `${file} 修订号必须保留`);
    const chk = migrationPreservesSemantics(doc, upgraded);
    assert.equal(chk.ok, true, `${file} 语义保持检查失败：${chk.reason}`);
  }
});

test('upgradeDoc：升级后的每个项目都能通过静态校验', () => {
  for (const { file, doc } of loadProjectCopies()) {
    const report = validateDoc(upgradeDoc(doc));
    assert.equal(report.ok, true, `${file} 升级后应通过校验：${JSON.stringify(report.errors)}`);
  }
});

test('upgradeDoc：v2 文档原样深拷贝返回', () => {
  const { doc } = loadProjectCopies()[0];
  const v2 = upgradeDoc(doc);
  v2.version = DOC_VERSION;
  const again = upgradeDoc(v2);
  assert.deepEqual(again, v2);
  assert.equal(again.version, DOC_VERSION);
});

test('更高版本被明确拒绝，不自动降级', () => {
  const fake = { format: 'uidoc', version: 3, revision: 1, components: {} };
  assert.throws(() => upgradeDoc(fake), (e) => e instanceof CompatError && e.code === 'E_VERSION_UNSUPPORTED');
  assert.throws(() => inspectDocVersion(fake), (e) => e instanceof CompatError && e.code === 'E_VERSION_UNSUPPORTED');
});

test('format 不是 uidoc 的文档被拒绝', () => {
  assert.throws(() => inspectDocVersion({ format: 'other', version: 1 }), (e) => e instanceof CompatError && e.code === 'E_FORMAT');
});
