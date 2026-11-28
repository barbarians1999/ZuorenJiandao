// Only generated test data belongs here. Never use this for user profiles or releases.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, realpathSync, mkdirSync, mkdtempSync,
  readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, statfsSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const GiB = 1024 ** 3;
const marker = '.zuoren-test-artifacts.json';
const rootMarker = '.zuoren-managed-test-root.json';
export function artifactHash(path) {
  const fd=openSync(path,'r'), hash=createHash('sha256'), buffer=Buffer.alloc(1024*1024);
  try {let bytes;while((bytes=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,bytes));return hash.digest('hex');}
  finally {closeSync(fd);}
}
export function testArtifactRoot(env = process.env, platform = process.platform, available = existsSync) {
  const configured = env.CC_TEST_ARTIFACT_ROOT?.trim();
  const defaultWinDrive = available('G:/') ? 'G:/' : (available('D:/') ? 'D:/' : null);
  const root = configured || (platform === 'win32' ? `${defaultWinDrive ?? 'G:/'}ZuorenJiandao-TestData/managed` : join(tmpdir(), 'zuoren-managed-tests'));
  assert(isAbsolute(root), 'CC_TEST_ARTIFACT_ROOT must be absolute');
  if (platform === 'win32' && !available(dirname(resolve(root)))) {
    // Missing data drive must fail, not silently produce another multi-GB C: fallback.
    assert(configured || defaultWinDrive !== null, 'G: and D: are unavailable; explicitly configure CC_TEST_ARTIFACT_ROOT');
  }
  return resolve(root);
}
export function treeInventory(root) {
  const files = [], links = [];
  const visit = path => {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) { links.push(path); return; }
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else { assert(s.isFile(), path); files.push({ path, bytes: s.size }); }
  };
  if (existsSync(root)) visit(root);
  return { files, links, bytes: files.reduce((n,f) => n+f.bytes,0) };
}
export function ensureManagedTestRoot(root, env = process.env) {
  const base=resolve(root), project=realpathSync(process.cwd());
  const contains=(parent,child)=>{const r=relative(parent,child);return r==='' || (r!=='..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));};
  assert.notEqual(base,parse(base).root, 'Managed test root must not be a drive root');
  assert(!contains(base,project) && !contains(project,base), 'Managed test root must be separate from the project');
  const protectedFolders=['Documents','Downloads','Desktop','Pictures','Videos','Music'].map(name=>resolve(homedir(),name));
  assert(!protectedFolders.some(path=>contains(base,path)), 'Managed test root must not be a user data directory');
  const profile=env.OPENCHATCUT_DATA_DIR?.trim();
  if(profile)assert(!contains(base,resolve(profile)) && !contains(resolve(profile),base), 'Managed test root must be separate from the user profile');
  let ancestor=base;
  while(!existsSync(ancestor)){const parent=dirname(ancestor);assert.notEqual(parent,ancestor);ancestor=parent;}
  const canonical=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
  assert.equal(canonical(realpathSync(ancestor)),canonical(ancestor),'Managed test root must not pass through a directory alias');
  mkdirSync(base,{recursive:true});
  assert.equal(canonical(realpathSync(base)),canonical(base),'Managed test root must not be a directory alias');
  const path=join(base,rootMarker);
  if(existsSync(path)) {
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),'Managed root marker must be a regular file');
    const owner=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(owner.version,1);assert.equal(owner.root,base,'Managed root marker belongs to another path');
  } else {
    assert.equal(readdirSync(base).length,0,'Managed test root contains unowned data; choose a separate empty directory');
    writeFileSync(path,JSON.stringify({version:1,root:base,createdAt:new Date().toISOString()}),{flag:'wx'});
  }
  return base;
}
export function generatedMediaReady(directory, recipe, names) {
  const path=join(directory,'generated-media-identity.json');
  if(!existsSync(path)) {
    assert(!names.some(name=>existsSync(join(directory,name))), 'Unidentified/partial generated fixture exists; inspect it, do not regenerate over it');
    return false;
  }
  const manifest=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(manifest.recipe,recipe,'Generated fixture recipe changed');
  assert.deepEqual(manifest.files.map(f=>f.name),names);
  for(const f of manifest.files)assert.equal(artifactHash(join(directory,f.name)),f.sha256,`Generated fixture changed: ${f.name}`);
  return true;
}
export function recordGeneratedMedia(directory, recipe, names) {
  const files=names.map(name=>({name,sha256:artifactHash(join(directory,name))}));
  writeFileSync(join(directory,'generated-media-identity.json'),JSON.stringify({recipe,files},null,2));
}
export function assertArtifactSpace(root, expectedBytes = GiB, { env = process.env,
  available, used } = {}) {
  const reserve = Number(env.CC_TEST_MIN_FREE_BYTES ?? 8 * GiB);
  const budget = Number(env.CC_TEST_MAX_BYTES ?? 16 * GiB);
  assert([reserve,budget,expectedBytes].every(n=>Number.isSafeInteger(n)&&n>=0) && budget>0, 'Invalid artifact budget');
  let disk = resolve(root); while(!existsSync(disk)) { const parent=dirname(disk); assert.notEqual(parent,disk); disk=parent; }
  const space = available ?? (()=>{const s=statfsSync(disk);return s.bavail*s.bsize;})();
  const bytes = used ?? treeInventory(root).bytes;
  assert(space >= expectedBytes+reserve, `Low artifact disk space: need ${expectedBytes+reserve}, available ${space}; no C: fallback`);
  assert(bytes+expectedBytes <= budget, `Test artifact budget exceeded (${bytes}+${expectedBytes}>${budget}); inspect retained evidence/cache`);
  return { availableBytes: space, existingBytes: bytes, expectedBytes, reserveBytes: reserve, budgetBytes: budget };
}
export function createTestArtifacts(prefix, { expectedBytes = GiB, env = process.env } = {}) {
  assert(/^[a-z0-9-]+$/.test(prefix), 'Invalid test artifact prefix');
  const base=ensureManagedTestRoot(testArtifactRoot(env),env);
  assertArtifactSpace(base,expectedBytes,{env});
  const root=mkdtempSync(join(base,`${prefix}-`));
  writeFileSync(join(root,marker),JSON.stringify({version:1,root,base,pid:process.pid,id:randomUUID(),
    kind:prefix,expectedBytes,startedAt:new Date().toISOString(),status:'running'}));
  return root;
}
export function assertArtifactNotInUse(root) {
  if(process.platform!=='win32') return;
  const path=Buffer.from(root).toString('base64');
  const command=`$ProgressPreference='SilentlyContinue'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}')); Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne ${process.pid} -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($p+'\\',[StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -in @('node.exe','electron.exe','ffmpeg.exe','chrome-headless-shell.exe','7za.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0))} | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
  assert(!result,`Managed artifacts still in use: ${result}`);
}
export function finishTestArtifacts(root, { status, evidence, retain = [] } = {}) {
  const owner=JSON.parse(readFileSync(join(root,marker),'utf8'));
  assert.equal(owner.version,1); assert.equal(owner.root,resolve(root));
  assert.equal(dirname(resolve(root)),owner.base); assert.equal(realpathSync(root),resolve(root));
  assert.notEqual(resolve(evidence),resolve(root));
  assert(!resolve(evidence).startsWith(resolve(root)+sep), 'Evidence must survive scratch cleanup');
  assertArtifactNotInUse(root);
  owner.status=status;owner.finishedAt=new Date().toISOString();owner.cleanup='pending';
  writeFileSync(join(root,marker),JSON.stringify(owner));
  const inventory=treeInventory(root);
  const selected=inventory.files.filter(f=>(!relative(root,f.path).startsWith(`app${sep}`) && /\.(?:log|jsonl?|txt)$/i.test(f.path))
    || retain.some(p=>relative(root,f.path)===p||relative(root,f.path).startsWith(p+sep))
    || (status!=='passed' && !relative(root,f.path).startsWith(`app${sep}`) && /\.(?:mp4|wav|png|jpe?g)$/i.test(f.path)));
  const preservedBytes=selected.reduce((n,f)=>n+f.bytes,0);
  assert(preservedBytes<=512*1024**2,'Failure evidence exceeds512MiB; keep scratch and inspect rather than discard it');
  mkdirSync(evidence,{recursive:true});
  for(const f of selected){const dest=join(evidence,relative(root,f.path));mkdirSync(dirname(dest),{recursive:true});copyFileSync(f.path,dest);
    assert.equal(artifactHash(f.path),artifactHash(dest),`Evidence copy changed: ${f.path}`);}
  // Unlink owned outgoing media junctions first; never recurse through their targets.
  for(const link of inventory.links){assert(lstatSync(link).isSymbolicLink());unlinkSync(link);}
  assert.equal(treeInventory(root).links.length,0);
  rmSync(root,{recursive:true});
  const receipt={status,root,evidence:resolve(evidence),ownerId:owner.id,pid:owner.pid,kind:owner.kind,
    expectedBytes:owner.expectedBytes,startedAt:owner.startedAt,removedScratchBytes:inventory.bytes,
    retainedBytes:preservedBytes,at:new Date().toISOString()};
  writeFileSync(join(evidence,'artifact-cleanup.json'),JSON.stringify(receipt,null,2));
  console.log(`[artifacts] ${status}; scratch removed; evidence: ${resolve(evidence)}`);
  return receipt;
}
