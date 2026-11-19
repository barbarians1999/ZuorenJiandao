// Drives the isolated hidden Electron fixture through documented agent-browser
// accessibility commands. Does not open another tab or a user's browser.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

const session = 'maskblur-final-20261014';
const binary = resolve(process.env.LOCALAPPDATA, 'codex-tools/agent-browser/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const fixture = await (await fetch('http://127.0.0.1:39795/qa/fixture')).json();
const audit = await mkdtemp(join(fixture.outDir, 'ui-check-'));
const run = promisify(execFile);
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [], observations: [], commands: [],
  scope: 'Hidden isolated Electron, production inspector/store/Player and short generated video. Not installed app, full application workflow, native OS drag or long-video acceptance.' };
const save = () => writeFile(join(audit, 'ui-results.json'), JSON.stringify(report, null, 2));
const cli = async (...args) => {
  const started = performance.now();
  let stdout;
  try { ({ stdout } = await run(binary, ['--session', session, '--json', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 ** 2 })); }
  catch (error) {
    report.commands.push({ args, elapsedMs: performance.now() - started, success: false, code: error.code,
      stdout: error.stdout, stderr: error.stderr });
    throw error;
  }
  const payload = JSON.parse(stdout);
  report.commands.push({ args, elapsedMs: performance.now() - started, success: payload.success });
  assert(payload.success, payload.error); return payload.data;
};
const evaluate = async (code) => (await cli('eval', '-b', Buffer.from(code).toString('base64'))).result;
const click = (name, role = 'button') => cli('find', 'role', role, 'click', '--name', name);
const ready = () => cli('wait', '--fn', "window.maskBlurQA.statuses.some(s=>s.kind==='effect'&&s.phase==='ready')");
const precise = async (label, value) => {
  await click(`输入${label}的精确值`);
  await cli('fill', `input[aria-label="输入${label}的精确值"]`, String(value)); await cli('press', 'Enter');
};
try {
  await save();
  const pages = await (await fetch('http://127.0.0.1:39796/json/list')).json();
  const page = pages.filter((entry) => entry.type === 'page' && entry.url === 'http://127.0.0.1:39795/scripts/fixtures/mask-blur-ui.html');
  assert.equal(page.length, 1);
  await cli('connect', page[0].webSocketDebuggerUrl);
  await cli('snapshot', '-i'); await click('重置工程');
  await click('马赛克', 'tab'); await click('局部打码'); await ready();
  let sample = await evaluate('window.maskBlurQA.sample()');
  assert.equal(sample.canvasOpacity, '1'); assert.equal(sample.sourceOpacity, '0'); assert(sample.variation < 2);
  report.observations.push({ label: 'local', sample });
  await precise('模糊强度', 85); await ready();
  assert.equal(await evaluate('window.maskBlurQA.doc.timelines[0].items[0].effects[0].overrides.strength'), 85);
  sample = await evaluate('window.maskBlurQA.sample()');
  assert.equal(sample.canvasOpacity, '1'); assert.equal(sample.sourceOpacity, '0');
  report.checks.push('Click applies Gaussian; paused strength edit updates actual GL without playing/seeking');
  await click('撤销'); await ready();
  assert.equal(await evaluate('window.maskBlurQA.doc.timelines[0].items[0].effects[0].overrides.strength'), 70);
  await click('重做'); await ready();
  assert.equal(await evaluate('window.maskBlurQA.doc.timelines[0].items[0].effects[0].overrides.strength'), 85);
  await click('取消选中'); await click('跳转45帧');
  await cli('wait', '--fn', "window.maskBlurQA.frame===45&&window.maskBlurQA.sample()?.canvasOpacity==='1'");
  sample = await evaluate('window.maskBlurQA.sample()');
  assert(sample.variation < 2); assert.equal(sample.sourceOpacity, '0');
  report.observations.push({ label: 'unselected-seek', sample });
  report.checks.push('Undo/redo and unselected real GL seek remain blurred');
  await click('选择视频'); await click('蒙版', 'tab'); await click('矩形');
  assert.equal(await evaluate('window.maskBlurQA.doc.timelines[0].items[0].mask.type'), 'rectangle');
  await click('椭圆'); await precise('羽化', 5);
  assert.equal(await evaluate('window.maskBlurQA.doc.timelines[0].items[0].mask.feather'), .05);
  await cli('find', 'first', '.cc-clip-region-control button.key', 'click');
  assert.equal(await evaluate('window.maskBlurQA.doc.timelines[0].items[0].keyframes.maskX[0].frame'), 45);
  await click('保存工程');
  const saved = await evaluate('window.maskBlurQA.doc');
  await cli('reload'); await cli('wait', '--fn', 'window.maskBlurQA?.ready===true');
  const reopened = await evaluate('window.maskBlurQA.doc');
  assert.deepEqual(reopened.timelines[0].items[0].effects, saved.timelines[0].items[0].effects);
  assert.deepEqual(reopened.timelines[0].items[0].mask, saved.timelines[0].items[0].mask);
  assert.deepEqual(reopened.timelines[0].items[0].keyframes, saved.timelines[0].items[0].keyframes);
  report.checks.push('Rectangle/ellipse, percent feather input, mask keyframe, save and real reload retain data');
  await click('选择视频'); await click('马赛克', 'tab'); await ready();
  await click('全屏打码'); await ready();
  const full = await evaluate('window.maskBlurQA.doc.timelines[0].items[0].effects[0].overrides');
  assert.equal(full.width_ratio, 1); assert.equal(full.height_ratio, 1);
  await cli('screenshot', join(audit, 'full-mask-ui.png'));
  const sizing = await evaluate("({note:getComputedStyle(document.querySelector('.cc-region-note')).fontSize,button:document.querySelector('.cc-region-presets button').getBoundingClientRect().height})");
  assert(parseFloat(sizing.note) >= 14); assert(sizing.button >= 76);
  report.observations.push({ label: 'sizing', ...sizing });
  await click('无');
  await evaluate("window.qaOriginalCanvasContext=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl2'?null:window.qaOriginalCanvasContext.call(this,kind,...args)}; true");
  await click('局部打码');
  await cli('wait', '--fn', "document.querySelector('#actual-preview').innerText.includes('已隐藏画面')");
  const protection = await evaluate("(()=>{const cs=[...document.querySelectorAll('#actual-preview canvas')];const c=cs[cs.length-1];return {source:getComputedStyle(c.previousElementSibling).opacity,canvas:getComputedStyle(c).opacity,text:document.querySelector('#actual-preview').innerText,status:window.maskBlurQA.statuses};})()");
  assert.equal(protection.source, '0'); assert.equal(protection.canvas, '0');
  assert(protection.text.includes('已隐藏画面'));
  await cli('screenshot', join(audit, 'failure-protection-ui.png'));
  report.observations.push({ label: 'simulated-webgl-unavailable', ...protection });
  report.checks.push('Simulated WebGL failure hides original and shows honest failure prompt');
  await evaluate('HTMLCanvasElement.prototype.getContext=window.qaOriginalCanvasContext; true');
  await click('无'); await click('局部打码'); await ready();
  assert.equal((await evaluate('window.maskBlurQA.sample()')).sourceOpacity, '0');
  report.checks.push('Explicit reapply recovers after simulated failure');
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
  console.log(`UI PASSED ${join(audit, 'ui-results.json')}`);
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); await save(); console.error(report.error); process.exitCode = 1;
}
