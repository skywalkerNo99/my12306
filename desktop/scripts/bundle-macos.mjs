import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('macOS 分发包请在 macOS 上创建');
const light = process.env.MY12306_LIGHT === '1';
const releaseDir = light ? 'light-release' : 'release';
const { version } = JSON.parse(readFileSync(path.join(desktop, 'app/package.json'), 'utf8'));
const installer = path.resolve(process.argv[2] || path.join(desktop, releaseDir, `my12306-${version}-mac-${process.arch}-unsigned.dmg`));
if (!/^my12306-[\w.-]+\.dmg$/.test(path.basename(installer))) throw new Error('请指定 my12306 的 DMG 安装包');
const name = path.basename(installer, '.dmg') + '-bundle';
const output = path.join(desktop, releaseDir, name + '.zip');
const temporary = mkdtempSync(path.join(desktop, releaseDir, '.bundle-'));
try {
  const stage = path.join(temporary, name); mkdirSync(stage);
  cpSync(installer, path.join(stage, path.basename(installer)));
  for (const file of ['macos-quarantine.sh', 'macos-adhoc-sign.sh', '打不开时点这里.command', '恢复隔离标记.command']) {
    cpSync(path.join(desktop, 'distribution', file), path.join(stage, file));
    if (light) { const target = path.join(stage, file); writeFileSync(target, readFileSync(target, 'utf8').replaceAll('my12306.app', 'my12306-light.app').replaceAll('cn.my12306.desktop', 'cn.my12306.light')); }
  }
  const architecture = path.basename(installer).includes('-arm64') ? 'Apple 芯片 Mac（M 系列，arm64）' : 'Intel 芯片 Mac（x64）';
  writeFileSync(path.join(stage, '使用说明.txt'), readFileSync(path.join(desktop, 'distribution/使用说明-macOS.txt'), 'utf8').replace('__ARCH_LABEL__', architecture).replaceAll('my12306', light ? 'my12306-light' : 'my12306'));
  const checksums = readdirSync(stage).sort().map(file => `${createHash('sha256').update(readFileSync(path.join(stage, file))).digest('hex')}  ${file}`).join('\n') + '\n';
  writeFileSync(path.join(stage, 'SHA256SUMS.txt'), checksums);
  // ditto writes UTF-8 filenames without the ZIP UTF-8 flag, garbling Chinese helper
  // names in some extractors. Python's ZIP writer records Unicode and executable modes.
  const zip = spawnSync('python3', ['-c', `
import pathlib, sys, zipfile
stage, output = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for item in sorted(stage.iterdir()):
        archive.write(item, arcname=stage.name + '/' + item.name,
                      compress_type=zipfile.ZIP_STORED if item.suffix == '.dmg' else zipfile.ZIP_DEFLATED)
`, stage, output], { stdio: 'inherit' });
  if (zip.error) throw zip.error;
  if (zip.status !== 0) throw new Error('创建分发压缩包失败');
  writeFileSync(output + '.sha256', `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${path.basename(output)}\n`);
  console.log(`分发包：${output}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
