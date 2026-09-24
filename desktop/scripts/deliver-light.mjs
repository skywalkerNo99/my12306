import { readdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const files = readdirSync('desktop/light-release').filter(n => process.platform === 'darwin' ? n.endsWith('-bundle.zip') : n.endsWith('.exe'));
if (files.length !== 1) throw new Error('Expected one light installer');
for (const file of files) {
  const target = 'desktop/delivery/' + file;
  copyFileSync('desktop/light-release/' + file, target);
  writeFileSync(target + '.sha256', createHash('sha256').update(readFileSync(target)).digest('hex') + '  ' + file + '\n');
}
