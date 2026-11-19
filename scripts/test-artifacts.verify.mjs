import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, parse } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createTestArtifacts, finishTestArtifacts, assertArtifactSpace, testArtifactRoot, generatedMediaReady, recordGeneratedMedia } from './test-artifacts.mjs';
import { prepareChapterBundle, chapterSourceDigest } from './chapter-render-bundle.mjs';
const base=mkdtempSync(join(tmpdir(),'zuoren-artifacts-contract-'));
const env={CC_TEST_ARTIFACT_ROOT:join(base,'managed'),CC_TEST_MIN_FREE_BYTES:'0',CC_TEST_MAX_BYTES:'4096'};
try {
  assert.throws(()=>testArtifactRoot({CC_TEST_ARTIFACT_ROOT:'relative'},'win32'),/absolute/);
  if(process.platform==='win32')assert.throws(()=>testArtifactRoot({},'win32',()=>false),/D: is unavailable/);
  assert.throws(()=>assertArtifactSpace(base,100,{env,available:99,used:0}),/Low artifact/);
  assert.throws(()=>assertArtifactSpace(base,100,{env,available:5000,used:4000}),/budget exceeded/);
  const personal=join(base,'personal');mkdirSync(personal);writeFileSync(join(personal,'original.mp4'),'user media');
  assert.throws(()=>createTestArtifacts('unsafe',{env:{...env,CC_TEST_ARTIFACT_ROOT:personal},expectedBytes:1}),/unowned data/);
  assert.equal(readFileSync(join(personal,'original.mp4'),'utf8'),'user media');
  assert.throws(()=>createTestArtifacts('unsafe',{env:{...env,CC_TEST_ARTIFACT_ROOT:process.cwd()},expectedBytes:1}),/separate from the project/);
  assert.throws(()=>createTestArtifacts('unsafe',{env:{...env,CC_TEST_ARTIFACT_ROOT:join(homedir(),'Videos')},expectedBytes:1}),/user data directory/);
  assert.throws(()=>createTestArtifacts('unsafe',{env:{...env,CC_TEST_ARTIFACT_ROOT:parse(base).root},expectedBytes:1}),/drive root/);
  const profile=join(base,'user-profile');mkdirSync(profile);
  assert.throws(()=>createTestArtifacts('unsafe',{env:{...env,OPENCHATCUT_DATA_DIR:profile,CC_TEST_ARTIFACT_ROOT:join(profile,'managed')},expectedBytes:1}),/user profile/);
  assert(!existsSync(join(profile,'managed')));
  const linkedParent=join(base,'linked-parent'), linkTarget=join(base,'linked-target');mkdirSync(linkTarget);
  symlinkSync(linkTarget,linkedParent,process.platform==='win32'?'junction':'dir');
  try {
    assert.throws(()=>createTestArtifacts('unsafe',{env:{...env,CC_TEST_ARTIFACT_ROOT:join(linkedParent,'managed')},expectedBytes:1}),/directory alias/);
    assert(!existsSync(join(linkTarget,'managed')));
  } finally {unlinkSync(linkedParent);}
  const success=createTestArtifacts('success',{env,expectedBytes:1});
  const owner=JSON.parse(readFileSync(join(success,'.zuoren-test-artifacts.json'),'utf8'));
  assert.equal(owner.kind,'success');assert.equal(owner.expectedBytes,1);assert.equal(owner.status,'running');
  assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
  writeFileSync(join(success,'result.log'),'passed');writeFileSync(join(success,'output.mp4'),'generated media');
  const evidence=join(base,'success-evidence');
  const receipt=finishTestArtifacts(success,{status:'passed',evidence});
  assert.equal(receipt.ownerId,owner.id);assert.equal(receipt.expectedBytes,1);assert.equal(receipt.startedAt,owner.startedAt);
  assert(!existsSync(success));assert.equal(readFileSync(join(evidence,'result.log'),'utf8'),'passed');
  assert(!existsSync(join(evidence,'output.mp4')));
  const failure=createTestArtifacts('failure',{env,expectedBytes:1});
  mkdirSync(join(failure,'app'));writeFileSync(join(failure,'app','large-runtime.dll'),'rebuildable runtime');
  writeFileSync(join(failure,'source.mp4'),'small repro');writeFileSync(join(failure,'stderr.log'),'failure');
  const blockedEvidence=join(base,'blocked-evidence');writeFileSync(blockedEvidence,'not a directory');
  assert.throws(()=>finishTestArtifacts(failure,{status:'failed',evidence:blockedEvidence}));
  const failedOwner=JSON.parse(readFileSync(join(failure,'.zuoren-test-artifacts.json'),'utf8'));
  assert.equal(failedOwner.status,'failed');assert.equal(failedOwner.cleanup,'pending');
  assert.equal(readFileSync(join(failure,'source.mp4'),'utf8'),'small repro');
  const failed=join(base,'failure-evidence');finishTestArtifacts(failure,{status:'failed',evidence:failed});
  assert.equal(readFileSync(join(failed,'source.mp4'),'utf8'),'small repro');assert(!existsSync(join(failed,'app')));
  const owned=createTestArtifacts('linked',{env,expectedBytes:1});
  const outside=join(base,'protected-fixture');mkdirSync(outside);writeFileSync(join(outside,'original'),'keep');
  symlinkSync(outside,join(owned,'uploads'),process.platform==='win32'?'junction':'dir');
  finishTestArtifacts(owned,{status:'passed',evidence:join(base,'link-evidence')});
  assert.equal(readFileSync(join(outside,'original'),'utf8'),'keep','outgoing link target survives');
  const unowned=join(base,'unowned');mkdirSync(unowned);
  assert.throws(()=>finishTestArtifacts(unowned,{status:'passed',evidence:join(base,'bad')}),/ENOENT/);
  if(process.platform==='win32'){
    const busy=createTestArtifacts('busy',{env,expectedBytes:1});
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)',busy],{windowsHide:true,stdio:'ignore'});
    await once(child,'spawn');
    try {assert.throws(()=>finishTestArtifacts(busy,{status:'passed',evidence:join(base,'busy-evidence')}),/still in use/);}
    finally {const stopped=once(child,'exit');child.kill();await stopped;}
    finishTestArtifacts(busy,{status:'passed',evidence:join(base,'busy-evidence')});
  }
  const media=join(base,'media');mkdirSync(media);
  assert.equal(generatedMediaReady(media,'recipe1',['source.mp4']),false);
  writeFileSync(join(media,'source.mp4'),'AAAA');
  assert.throws(()=>generatedMediaReady(media,'recipe1',['source.mp4']),/Unidentified/);
  recordGeneratedMedia(media,'recipe1',['source.mp4']);
  assert.equal(generatedMediaReady(media,'recipe1',['source.mp4']),true);
  assert.throws(()=>generatedMediaReady(media,'recipe2',['source.mp4']),/recipe changed/);
  writeFileSync(join(media,'source.mp4'),'BBBB');
  assert.throws(()=>generatedMediaReady(media,'recipe1',['source.mp4']),/fixture changed/);
  const cwd=process.cwd(), product=join(base,'product');
  for(const name of ['src','remotion','shared','assets','config']){mkdirSync(join(product,name),{recursive:true});writeFileSync(join(product,name,'entry.js'),name);}
  writeFileSync(join(product,'package.json'),'{}');
  const cache=join(product,'desktop-dist','remotion-bundle');mkdirSync(cache,{recursive:true});
  writeFileSync(join(cache,'index.html'),'compiled fixture');
  writeFileSync(join(cache,'chapter-source-provenance.json'),JSON.stringify({version:1,sourceDigest:await chapterSourceDigest(product)}));
  try {
    process.chdir(product);let builds=0;
    const output=join(base,'bundle-copy');
    const first=await prepareChapterBundle({output,signal:new AbortController().signal,build:()=>{builds++;throw Error('unexpected build');}});
    assert(first.reused);assert.equal(builds,0);assert.equal(readFileSync(join(output,'index.html'),'utf8'),'compiled fixture');
    writeFileSync(join(product,'src','entry.js'),'new source');
    await assert.rejects(prepareChapterBundle({reuse:cache,signal:new AbortController().signal}),/changed/);
    const next=await prepareChapterBundle({output:join(base,'fresh'),signal:new AbortController().signal,build:async path=>{
      builds++;mkdirSync(path);writeFileSync(join(path,'index.html'),'fresh');return path;
    }});
    assert.equal(next.reused,false);assert.equal(builds,1);
  } finally {process.chdir(cwd);}
  console.log('test-artifacts: space/budget/no implicit C fallback, success/failure retention, ownership and junction safety passed');
} finally {rmSync(base,{recursive:true,force:true});}
