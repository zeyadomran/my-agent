import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { packager } from '@electron/packager';

const stage = resolve('.package-stage');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));

await mkdir(stage, { recursive: true });
try {
  await cp('dist', resolve(stage, 'dist'), { recursive: true });
  await writeFile(
    resolve(stage, 'package.json'),
    JSON.stringify({
      name: manifest.name,
      productName: manifest.productName,
      version: manifest.version,
      description: manifest.description,
      type: manifest.type,
      main: manifest.main,
    }),
  );
  await packager({
    dir: stage,
    out: 'out',
    name: 'my-agent',
    platform: 'win32',
    arch: 'x64',
    electronVersion: manifest.devDependencies.electron,
    asar: true,
    overwrite: true,
    prune: false,
  });
} finally {
  // Only the fixed build staging directory is owned by this script.
  await rm(stage, { recursive: true, force: true });
}
