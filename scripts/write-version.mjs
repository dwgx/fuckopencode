#!/usr/bin/env node
// postbuild：把 package.json 的 version 写进 dist/version.txt。
// OTA 用这个文件做「当前版本」基线（部署机上没有源码，只有 dist/）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let version = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
} catch {
  // 读不到 package.json 用 0.0.0，不阻断构建
}
const out = path.join(root, 'dist', 'version.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${version}\n`, 'utf8');
console.log(`[write-version] dist/version.txt = ${version}`);
