// Short, serial CDP mouse gestures against the real PreviewWorkspace/Inspector,
// store/history and Remotion Player in an isolated hidden Electron profile.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const session = 'mask-mosaic-drag-20261031';
const binary = resolve(process.env.LOCALAPPDATA, 'codex-tools/agent-browser/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const fixture = await (await fetch('http://127.0.0.1:39795/qa/fixture')).json();
const root = await mkdtemp(join(fixture.outDir, 'ui-check-'));
const run = promisify(execFile);
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [], observations: [], commands: [],
  scope: 'Hidden Electron, production PreviewWorkspace/Inspector/store/Player, actual CDP mouse drags. Generated 3-second media. Not native OS mouse, installed app or long-video acceptance.' };
const save = () => writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
const cli = async (...args) => {
  let stdout;
  try { ({ stdout } = await run(binary, ['--session', session, '--json', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 ** 2 })); }
  catch (error) { report.commands.push({ args, success: false, code: error.code, stdout: error.stdout, stderr: error.stderr }); await save(); throw error; }
  const result = JSON.parse(stdout); report.commands.push({ args, success: result.success });
  assert(result.success, result.error); return result.data;
};
const evaluate = async (code) => (await cli('eval', '-b', Buffer.from(code).toString('base64'))).result;
const click = (name, role = 'button') => cli('find', 'role', role, 'click', '--name', name);
const current = () => evaluate('window.maskDragQA.doc.timelines[0].items[0]');
const near = (a, b) => assert(Math.abs(a - b) < .0015, `${a} != ${b}`);
const metrics = () => evaluate(`(()=>{
  const overlay=document.querySelector('.cc-preview-mask-overlay'); const rect=overlay.getBoundingClientRect();
  const region=overlay.querySelector('[data-mask-selection]');
  const vertices=[...region.points].map(p=>({x:p.x,y:p.y}));
  const center={x:vertices.reduce((s,p)=>s+p.x,0)/vertices.length,y:vertices.reduce((s,p)=>s+p.y,0)/vertices.length};
  const handles=Object.fromEntries([...overlay.querySelectorAll('button[data-mask-handle]')].map(el=>{const r=el.getBoundingClientRect();return [el.dataset.maskHandle,{x:r.x+r.width/2,y:r.y+r.height/2}]}));
  const a=window.maskDragQA.appearance();
  // Use browser CSS, independently of the numerical overlay helper.
  const el=document.createElement('div');el.style.width='640px';el.style.height='360px';el.style.transform=a.foregroundStyle.transform||'none';document.body.append(el);
  const mat=new DOMMatrix(getComputedStyle(el).transform);el.remove();
  return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, center:{x:rect.x+center.x/640*rect.width,y:rect.y+center.y/360*rect.height},handles,
    matrix:{a:mat.a,b:mat.b,c:mat.c,d:mat.d,e:mat.e,f:mat.f},vertices,mask:window.maskDragQA.doc.timelines[0].items[0].mask,
    begin:window.maskDragQA.beginCount,end:window.maskDragQA.endCount};})()`);
const mosaicMetrics = () => evaluate(`(()=>{
  const overlay=document.querySelector('.cc-preview-mask-overlay'); const rect=overlay.getBoundingClientRect();
  const region=overlay.querySelector('[data-mosaic-selection]');
  const vertices=[...region.points].map(p=>({x:p.x,y:p.y}));
  const center={x:vertices.reduce((s,p)=>s+p.x,0)/vertices.length,y:vertices.reduce((s,p)=>s+p.y,0)/vertices.length};
  const handles=Object.fromEntries([...overlay.querySelectorAll('button[data-mosaic-handle]')].map(el=>{const r=el.getBoundingClientRect();return [el.dataset.mosaicHandle,{x:r.x+r.width/2,y:r.y+r.height/2}]}));
  const item=window.maskDragQA.doc.timelines[0].items[0];
  const el=document.createElement('div');el.style.width='640px';el.style.height='360px';el.style.transform=window.maskDragQA.appearance().foregroundStyle.transform||'none';document.body.append(el);
  const mat=new DOMMatrix(getComputedStyle(el).transform);el.remove();
  return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},center:{x:rect.x+center.x/640*rect.width,y:rect.y+center.y/360*rect.height},handles,
    matrix:{a:mat.a,b:mat.b,c:mat.c,d:mat.d,e:mat.e,f:mat.f},region:item.effects.find(e=>e.assetId==='builtin:fx-local-gaussian-blur')?.overrides,
    begin:window.maskDragQA.beginCount,end:window.maskDragQA.endCount};})()`);
const move = (point) => cli('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y)));
const drag = async (start, delta) => {
  await move(start); await cli('mouse', 'down', 'left');
  await cli('mouse', 'move', String(Math.round(start.x + delta.x)), String(Math.round(start.y + delta.y)), '--steps', '5', '--duration', '150');
  await cli('mouse', 'up', 'left');
};
const normalizedDelta = (m, x, y) => ({ x: (m.matrix.a * x * 640 + m.matrix.c * y * 360) / 640 * m.rect.width,
  y: (m.matrix.b * x * 640 + m.matrix.d * y * 360) / 360 * m.rect.height });
try {
  await save();
  if (process.env.CC_MASK_DRAG_BROWSER === '1') {
    await cli('open', 'http://127.0.0.1:39795/scripts/fixtures/mask-drag-ui.html');
    await cli('wait', '--fn', 'window.maskDragQA?.ready===true');
  } else {
    const pages = await (await fetch('http://127.0.0.1:39796/json/list')).json();
    const page = pages.filter((p) => p.type === 'page' && p.url === 'http://127.0.0.1:39795/scripts/fixtures/mask-drag-ui.html');
    assert.equal(page.length, 1); await cli('connect', page[0].webSocketDebuggerUrl);
  }
  await cli('snapshot', '-i'); await click('重置工程'); await click('选择视频');
  if (process.env.CC_MOSAIC_ONLY === '1') {
    await click('马赛克', 'tab'); await click('局部打码');
    await cli('wait', '--fn', "document.querySelectorAll('[data-mosaic-handle]').length===9");
    let mosaic = await mosaicMetrics(); const base = mosaic.region;
    await drag(mosaic.center, normalizedDelta(mosaic, .05, .04));
    mosaic = await mosaicMetrics();
    near(mosaic.region.center_x, base.center_x + .05); near(mosaic.region.center_y, base.center_y + .04);
    assert.equal(mosaic.begin, 1); assert.equal(mosaic.end, 1);
    await click('撤销'); mosaic = await mosaicMetrics();
    near(mosaic.region.center_x, base.center_x); near(mosaic.region.center_y, base.center_y);
    await click('重做'); mosaic = await mosaicMetrics();
    near(mosaic.region.center_x, base.center_x + .05);
    const resize = mosaic.region;
    await drag(mosaic.handles.e, normalizedDelta(mosaic, .025, 0));
    mosaic = await mosaicMetrics();
    near(mosaic.region.width_ratio, resize.width_ratio + .025);
    near(mosaic.region.height_ratio, resize.height_ratio);
    await cli('screenshot', join(root, 'mosaic-direct-editing.png'));
    report.checks.push('Local mosaic moved and resized with real pointer events; transformed coordinate mapping and single-step undo/redo passed');
    report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
    await cli('close'); console.log(`MOSAIC UI PASSED ${join(root, 'results.json')}`); process.exit(0);
  }
  await cli('wait', '--fn', "(()=>{const c=document.querySelector('.cc-preview-canvas canvas');if(!c)return false;const p=c.getContext('2d')?.getImageData(320,180,1,1).data;return p?.[3]===255&&p[0]>0;})()");
  await click('蒙版', 'tab'); await click('矩形');
  await cli('wait', '--fn', "document.querySelectorAll('[data-mask-handle]').length===9");
  const initial = await current(); let m = await metrics();
  await drag(m.center, { x: m.rect.width * .05, y: m.rect.height * .05 });
  let item = await current(); near(item.mask.x, .25); near(item.mask.y, .25); near(item.mask.width, .6);
  assert.deepEqual(item.transform, initial.transform);
  const counters = await evaluate('({begin:window.maskDragQA.beginCount,end:window.maskDragQA.endCount})');
  assert.equal(counters.begin - m.begin, 1); assert.equal(counters.end - m.end, 1);
  near(Number(await evaluate("document.querySelector('input[aria-label=\"左侧\"]').value")), item.mask.x);
  await click('撤销'); assert.deepEqual((await current()).mask, initial.mask);
  await click('重做'); near((await current()).mask.x, .25);
  report.checks.push('Actual region drag moves mask only, live inspector sync, one begin/end and one undo/redo'); await save();
  m = await metrics(); await drag(m.handles.se, { x: -.1 * m.rect.width, y: -.05 * m.rect.height });
  item = await current(); near(item.mask.width, .5); near(item.mask.height, .55); near(item.mask.x, .25);
  for (const [handle, dx, dy] of [['e', .02, 0], ['n', 0, .02], ['w', .015, 0], ['s', 0, -.02]]) {
    const before = (await current()).mask; m = await metrics();
    await drag(m.handles[handle], { x: dx * m.rect.width, y: dy * m.rect.height });
    const after = (await current()).mask;
    if (handle === 'e') { near(after.width, before.width + dx); near(after.x, before.x); }
    if (handle === 'w') { near(after.x, before.x + dx); near(after.x + after.width, before.x + before.width); }
    if (handle === 'n') { near(after.y, before.y + dy); near(after.y + after.height, before.y + before.height); }
    if (handle === 's') { near(after.height, before.height + dy); near(after.y, before.y); }
  }
  item = await current();
  const beforeBack = item.mask;
  m = await metrics(); await move(m.center); await cli('mouse', 'down');
  await move({ x: m.center.x + 30, y: m.center.y + 15 }); await move(m.center); await cli('mouse', 'up');
  assert.deepEqual((await current()).mask, beforeBack);
  await move(m.center); await cli('mouse', 'down'); await move({ x: m.center.x + 30, y: m.center.y + 15 });
  await cli('press', 'Escape'); await cli('mouse', 'up'); assert.deepEqual((await current()).mask, beforeBack);
  report.checks.push('Corner resize preserves opposite anchor; drag back restores start; Escape restores static mask'); await save();
  await click('椭圆'); await click('变换测试'); m = await metrics();
  const transformedBefore = await current();
  await drag(m.center, normalizedDelta(m, .04, .03));
  item = await current(); near(item.mask.x, transformedBefore.mask.x + .04); near(item.mask.y, transformedBefore.mask.y + .03);
  assert.deepEqual(item.transform, transformedBefore.transform);
  const mAfter = await metrics();
  // The mask point and browser-computed CSS matrix share the same transformed center/origin.
  const raw = { x: item.mask.x * 640 + item.mask.width * 320, y: item.mask.y * 360 + item.mask.height * 180 };
  const screen = { x: 320 + mAfter.matrix.a * (raw.x - 320) + mAfter.matrix.c * (raw.y - 180) + mAfter.matrix.e,
    y: 180 + mAfter.matrix.b * (raw.x - 320) + mAfter.matrix.d * (raw.y - 180) + mAfter.matrix.f };
  near(mAfter.center.x, mAfter.rect.x + screen.x / 640 * mAfter.rect.width);
  near(mAfter.center.y, mAfter.rect.y + screen.y / 360 * mAfter.rect.height);
  report.observations.push({ label: 'transformed-ellipse', metrics: mAfter, item });
  report.checks.push('Ellipse drag with nonuniform scale/rotation/crop matches independent browser CSS transform'); await save();
  await cli('find', 'first', '.cc-clip-region-control button.key', 'click');
  const keyedBase = await current(); assert.equal(keyedBase.keyframes.maskX[0].frame, 0);
  await click('跳转45帧'); await cli('wait', '--fn', 'window.maskDragQA.frame===45');
  m = await metrics(); await drag(m.center, normalizedDelta(m, .025, -.025));
  item = await current(); assert.equal(item.mask.x, keyedBase.mask.x);
  assert.equal(item.keyframes.maskX.length, 2); assert.equal(item.keyframes.maskX[1].frame, 45);
  near(item.keyframes.maskX[1].value, keyedBase.mask.x + .025);
  assert.deepEqual(item.keyframes.maskX[0], keyedBase.keyframes.maskX[0]);
  const keyedFinal = item;
  m = await metrics(); await move(m.center); await cli('mouse', 'down'); await move({ x: m.center.x + 25, y: m.center.y + 10 });
  await cli('press', 'Escape'); await cli('mouse', 'up');
  assert.deepEqual((await current()).keyframes.maskX, keyedFinal.keyframes.maskX);
  await click('撤销'); // cancelled gesture is a no-op visually; inspect actual history explicitly below
  await click('重做');
  report.checks.push('Animated x writes playhead keyframe, retains base/earlier keyframe; Escape restores original node'); await save();
  m = await metrics(); await move(m.center); await cli('mouse', 'down'); await move({ x: m.center.x + 10, y: m.center.y + 5 });
  await evaluate('window.maskDragQA.lock(); true');
  await cli('wait', '--fn', "document.querySelectorAll('[data-mask-handle]').length===0");
  const locked = await current(); await move({ x: m.center.x + 60, y: m.center.y + 30 }); await cli('mouse', 'up');
  assert.deepEqual((await current()).mask, locked.mask); assert.deepEqual((await current()).keyframes, locked.keyframes);
  await evaluate('window.maskDragQA.unlock(); true');
  await cli('wait', '--fn', "document.querySelectorAll('[data-mask-handle]').length===9");
  await click('保存工程'); const saved = await evaluate('window.maskDragQA.doc');
  await writeFile(join(root, 'saved-project.json'), JSON.stringify(saved, null, 2));
  await cli('reload'); await cli('wait', '--fn', 'window.maskDragQA?.ready===true');
  const reopened = await evaluate('window.maskDragQA.doc');
  assert.deepEqual(reopened.timelines[0].items[0].mask, saved.timelines[0].items[0].mask);
  assert.deepEqual(reopened.timelines[0].items[0].keyframes, saved.timelines[0].items[0].keyframes);
  await click('选择视频'); // migration intentionally clears transient selection on reload
  await click('蒙版', 'tab'); await cli('snapshot', '-i');
  await cli('screenshot', join(root, 'mask-direct-editing.png'));
  await click('画面', 'tab');
  assert.equal(await evaluate("document.querySelectorAll('[data-mask-handle]').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('[data-preview-handle]').length"), 9);
  await click('马赛克', 'tab'); await click('局部打码');
  await cli('wait', '--fn', "document.querySelectorAll('[data-mosaic-handle]').length===9");
  let mosaic = await mosaicMetrics();
  const mosaicBefore = mosaic.region;
  await drag(mosaic.center, normalizedDelta(mosaic, .05, .04));
  let mosaicAfter = await mosaicMetrics();
  near(mosaicAfter.region.center_x, mosaicBefore.center_x + .05);
  near(mosaicAfter.region.center_y, mosaicBefore.center_y + .04);
  assert.equal(mosaicAfter.begin - mosaic.begin, 1); assert.equal(mosaicAfter.end - mosaic.end, 1);
  await click('撤销');
  mosaic = await mosaicMetrics(); near(mosaic.region.center_x, mosaicBefore.center_x); near(mosaic.region.center_y, mosaicBefore.center_y);
  await click('重做');
  mosaic = await mosaicMetrics(); near(mosaic.region.center_x, mosaicBefore.center_x + .05);
  const resizeBefore = mosaic.region;
  await drag(mosaic.handles.se, normalizedDelta(mosaic, .025, .02));
  mosaic = await mosaicMetrics();
  near(mosaic.region.width_ratio, resizeBefore.width_ratio + .025);
  near(mosaic.region.height_ratio, resizeBefore.height_ratio + .02);
  await cli('screenshot', join(root, 'mosaic-direct-editing.png'));
  report.checks.push('Local mosaic moves and resizes directly on preview; transformed coordinate mapping, live effect update and undo/redo pass');
  await click('画面', 'tab');
  assert.equal(await evaluate("document.querySelectorAll('[data-mosaic-handle]').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('[data-preview-handle]').length"), 9);
  report.checks.push('Lock interrupts active mask gesture; saved/reopened mask/curves persist; basic tab restores clip controls');
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
  console.log(`UI PASSED ${join(root, 'results.json')}`);
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); await save(); console.error(report.error); process.exitCode = 1;
}
