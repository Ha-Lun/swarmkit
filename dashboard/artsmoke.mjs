import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, linkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  artifactDisposition, downloadHeaders, ensureArtifactDir,
  listArtifacts, openForDownload, validArtifactName, writtenArtifacts, resolveWritten,
} from './server/artifacts.ts';
import { applyMessage, createTree } from './server/model/reducer.ts';

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'artsmoke-')));
process.env.XDG_CACHE_HOME = path.join(scratch, 'cache');
let failures = 0;
const check = (name, cond) => {
  if (!cond) { failures++; console.error('FAIL:', name); }
  else console.log('ok:', name);
};

check('valid plain', validArtifactName('report.pdf'));
check('reject ..', !validArtifactName('..'));
check('reject slash', !validArtifactName('a/b'));
check('reject dotfile', !validArtifactName('.env'));
check('reject nul', !validArtifactName('a\0b'));
check('reject 201', !validArtifactName('x'.repeat(201)));
check('accept 200', validArtifactName('x'.repeat(200)));

const id = 'smoke-list';
const dir = ensureArtifactDir(id);
writeFileSync(path.join(dir, 'old.txt'), 'old');
writeFileSync(path.join(dir, 'new.txt'), 'new!');
writeFileSync(path.join(dir, '.h'), 'x');
symlinkSync(path.join(dir, 'old.txt'), path.join(dir, 'lnk.txt'));
utimesSync(path.join(dir, 'old.txt'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
const listed = listArtifacts(id);
check('list newest first', listed.map(a => a.name).join(',') === 'new.txt,old.txt');
check('list url', listed[0].url === `/api/sessions/${id}/artifacts/new.txt`);
check('missing dir', listArtifacts('smoke-nope').length === 0);

const opened = await openForDownload(path.join(dir, 'new.txt'));
check('open size', opened?.size === 4);
await opened?.handle.close();
check('symlink refused', (await openForDownload(path.join(dir, 'lnk.txt'))) === undefined);
linkSync(path.join(dir, 'new.txt'), path.join(dir, 'hard.txt'));
check('hardlink refused', (await openForDownload(path.join(dir, 'new.txt'))) === undefined);

const cwd = mkdtempSync(path.join(scratch, 'w-'));
writeFileSync(path.join(cwd, 'a.txt'), 'A');
const w = await writtenArtifacts(id, cwd, ['a.txt', 'missing.txt']);
check('written one', w.length === 1 && w[0].rel === 'a.txt');
const r = await resolveWritten(cwd, ['a.txt'], path.join(cwd, 'a.txt'));
check('resolve ok', r?.size === 1);
await r?.handle.close();
check('resolve unrecorded', (await resolveWritten(cwd, ['a.txt'], path.join(cwd, 'b.txt'))) === undefined);

const tree = createTree('s1', { startedAt: 1 });
const msg = (name, input, uuid, tid) => ({
  type: 'assistant', uuid, timestamp: 1,
  message: { id: 'm1', model: 'x', content: [{ type: 'tool_use', id: tid, name, input }] },
});
applyMessage(tree, msg('Edit', { filePath: '/r/c.txt' }, 'u1', 't1'));
applyMessage(tree, msg('NotebookEdit', { notebook_path: '/r/n.ipynb' }, 'u2', 't2'));
check('reducer paths', [...tree.writtenPaths].join(',') === '/r/c.txt,/r/n.ipynb');

check('disposition', artifactDisposition('a b.pdf') === `attachment; filename="a b.pdf"; filename*=UTF-8''a%20b.pdf`);
const h = downloadHeaders('x.txt', 5);
check('headers', h['Content-Type'] === 'text/plain; charset=utf-8' && h['Content-Length'] === 5 && h['Content-Security-Policy'] === 'sandbox');

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log('SMOKE ALL GREEN');
