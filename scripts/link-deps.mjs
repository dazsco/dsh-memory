// Dev-env helper: (re)create junction links for all `link:` dependencies in
// package.json under node_modules/. Use when pnpm's symlink creation is
// unavailable in the current shell (e.g. sandboxed command environments where
// fs.symlink 'dir' is virtualized). Junctions are real directory reparse
// points and track the linked package live.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const pj = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

const links = {};
for (const [name, spec] of Object.entries({ ...(pj.dependencies || {}), ...(pj.devDependencies || {}) })) {
  if (typeof spec === 'string' && spec.startsWith('link:')) {
    // `link:D:/Repos/deepseek-harness/...` — strip the scheme and any leading slash.
    const target = path.resolve(spec.slice(5).replace(/^\/+/, ''));
    links[name] = target;
  }
}

for (const [name, target] of Object.entries(links)) {
  const dest = path.join(nm, name); // name already carries its @scope/ prefix
  try {
    await fs.access(target);
  } catch {
    console.log('MISSING TARGET', name, target);
    process.exitCode = 1;
    continue;
  }
  let st = null;
  try {
    st = await fs.lstat(dest);
  } catch {}
  if (st) {
    if (st.isSymbolicLink()) {
      const cur = await fs.readlink(dest);
      if (path.relative(cur, target) === '') {
        console.log('OK (exists)  ', name);
        continue;
      }
      await fs.rm(dest, { force: true });
    } else {
      await fs.rm(dest, { recursive: true, force: true });
    }
  }
  await fs.symlink(target, dest, 'junction');
  const v = await fs.lstat(dest);
  console.log(v.isSymbolicLink() ? 'LINKED        ' : 'BROKEN        ', name, '->', target);
  if (!v.isSymbolicLink()) process.exitCode = 1;
}
console.log(`linked ${Object.keys(links).length} dependency paths`);
