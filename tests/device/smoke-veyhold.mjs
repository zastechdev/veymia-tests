// Plays veyhold inside the real app (Windows WebView2 or Android WebView) through the
// Chrome DevTools Protocol and checks that everything works.
// Usage: node smoke-veyhold.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veyhold.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veyhold-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veyhold')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veyhold page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// a real tap on the screen: touch on Android, mouse on Windows
const tap = async (x, y) => (page.tapAt ? page.tapAt(x, y) : page.mouse.click(x, y));
const cellXY = (cx, cy) => page.evaluate(([cx, cy]) => { const v = vh.view(); return [v.ox + (cx + 0.5) * 48 * v.sc, v.oy + (cy + 0.5) * 48 * v.sc]; }, [cx, cy]);

// enable the test hook and start from a clean save
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veyhold.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vh && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot);
await page.evaluate(() => { vh.save.settings.music = false; });
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veyhold');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));

// choose the first map through the menus
await page.click('[data-act=maps]'); await page.waitForTimeout(200);
check('map list shows 6 maps, only the first open', await page.evaluate(() => document.querySelectorAll('.map-card').length === 6 && document.querySelectorAll('.map-card.locked').length === 5));
await page.click('[data-act=play][data-arg="0"]'); await page.waitForTimeout(400);
check('map starts', await page.evaluate(() => !!vh.level && vh.level.mapIndex === 0 && vh.level.state === 'ready'));

// build by tapping the screen: find a square beside the road
const spot = await page.evaluate(() => { const L = vh.level; for (let cy = 1; cy < 13; cy++) for (let cx = 0; cx < 9; cx++) if (L.canBuild(cx, cy) && [...L.pathCells].some((k) => Math.abs(k % 9 - cx) + Math.abs(Math.floor(k / 9) - cy) === 1)) return [cx, cy]; return null; });
const [sx, sy] = await cellXY(...spot);
await tap(sx, sy); await page.waitForTimeout(300);
check('tapping an empty square opens the build panel', await page.evaluate(() => !document.getElementById('sheet').classList.contains('hidden') && !!document.querySelector('[data-act=build]')));
await shot(page, '2-build');
const g0 = await page.evaluate(() => vh.level.gold);
await page.click('[data-act=build][data-arg="archer"]'); await page.waitForTimeout(300);
const built = await page.evaluate(([cx, cy]) => ({ tower: !!vh.level.towerAt(cx, cy), gold: vh.level.gold }), spot);
check('building an archer tower', built.tower && built.gold < g0, `gold ${g0} -> ${built.gold}`);
await page.click('[data-act=upgrade]'); await page.waitForTimeout(200);
check('upgrading it', await page.evaluate(([cx, cy]) => vh.level.towerAt(cx, cy).lvl === 2, spot));
await page.click('[data-act=close-sheet]');

// real-time play: the actual loop, drawing and input on this device
await page.evaluate(() => { const L = vh.level; L.gold = 600; L.lives = 999; });
await page.click('#wave-btn'); await page.waitForTimeout(300);
check('start wave button starts wave 1', await page.evaluate(() => vh.level.wave === 1 && vh.level.state === 'wave'));
const t0 = await page.evaluate(() => vh.level.t); await page.waitForTimeout(3000); const t1 = await page.evaluate(() => vh.level.t);
check('game runs at real speed', t1 - t0 > 2.6, `${(t1 - t0).toFixed(2)} game-s in 3 s`);
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(f) : res(n / 3); }; requestAnimationFrame(f); }));
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps (quality ${await page.evaluate(() => vh.quality)})`);
check('monsters walk and get defeated', await page.evaluate(() => vh.level.kills > 0 || vh.level.enemies.some((e) => e.d > 20)), await page.evaluate(() => `kills ${vh.level.kills}`));
await shot(page, '3-playing');

// a busy late wave: many towers, many monsters
await page.evaluate(() => {
  const L = vh.level; L.gold = 99999;
  const types = ['archer', 'cannon', 'frost', 'storm'];
  let i = 0; for (let cy = 0; cy < 14; cy++) for (let cx = 0; cx < 9; cx++) if (L.canBuild(cx, cy) && (cx + cy) % 2 === 0) { L.build(types[i++ % 4], cx, cy); }
  L.towers.forEach((t) => { L.upgrade(t); L.upgrade(t); });
  for (let k = 0; k < 120; k++) L.queue.push({ kind: ['slime', 'bat', 'imp', 'wisp', 'golem'][k % 5], at: L.waveT + k * 0.05, hpMul: 6 });
});
await page.waitForTimeout(3000);
const busy = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : res({ fps: n / 2, alive: vh.level.enemies.length, towers: vh.level.towers.length }); }; requestAnimationFrame(f); }));
check('frame rate with a full map', busy.fps >= Math.min(20, FPS_MIN * 0.6), `${busy.fps.toFixed(1)} fps, ${busy.alive} monsters, ${busy.towers} towers`);
await shot(page, '4-busy');

// losing, then trying the same wave again with the towers back
await page.evaluate(() => { const L = vh.level; L.queue = []; L.enemies = []; });
await page.waitForFunction(() => vh.level.state === 'break', null, { timeout: 20000 }).catch(() => {});
const before = await page.evaluate(() => ({ wave: vh.level.wave, towers: vh.level.towers.length }));
await page.evaluate(() => { const L = vh.level; L.nextWave(); L.lives = 1; L.towers = []; for (let k = 0; k < 6; k++) L.queue.push({ kind: 'wisp', at: L.waveT + k * 0.1, hpMul: 50 }); });
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 40000 }).catch(() => {});
check('losing shows the result screen with "try again"', await page.evaluate(() => !!document.querySelector('.results') && !!document.querySelector('[data-act=retry-wave]')));
await shot(page, '5-lost');
await page.click('[data-act=retry-wave]'); await page.waitForTimeout(400);
const again = await page.evaluate(() => ({ wave: vh.level.wave, towers: vh.level.towers.length, state: vh.level.state, lives: vh.level.lives }));
check('try again restores the towers from the start of the wave', again.towers === before.towers && again.wave === before.wave && again.lives >= 5, `before ${JSON.stringify(before)} after ${JSON.stringify(again)}`);

// leaving mid-map: the menu offers to continue
await page.click('#pause-btn'); await page.click('[data-act=quit]'); await page.waitForTimeout(300);
check('menu offers Continue after leaving a map', (await page.locator('[data-act=resume-saved]').count()) === 1);
await page.click('[data-act=resume-saved]'); await page.waitForTimeout(300);
check('continue brings the towers back', await page.evaluate((n) => vh.level && vh.level.towers.length === n, before.towers));

// whole maps, played to the end by the bot (with the upgrades a player would have by then)
const perks = [{}, {}, { chest: 1, walls: 1 }, { chest: 2, sharp: 2, walls: 1, builders: 1 }, { chest: 2, sharp: 2, walls: 1, builders: 1 }, { chest: 3, sharp: 3, walls: 2, builders: 1 }];
let wins = 0;
for (let m = 0; m < 6; m++) {
  const r = await page.evaluate(([m, p]) => { vh.save.perks = p; vh.save.settings.sound = false; vh.ui.close(); vh.startLevel(m); return botHold({ render: true }); }, [m, perks[m]]);
  if (r.won) wins++;
  check(`full map ${m + 1}`, r.won || r.wave >= r.waves - 2, `won=${r.won} wave=${r.wave}/${r.waves} lives=${r.lives} stars=${r.stars} towers=${r.towers}`);
}
check('the bot wins most maps', wins >= 4, `${wins}/6`);

// save survives a restart of the page
await page.evaluate(() => { vh.save.stars = { meadow: 3 }; localStorage.setItem('veyhold.save.v1', JSON.stringify(vh.save)); location.reload(); });
await page.waitForFunction(() => window.vh && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', (await page.evaluate(() => vh.save.stars.meadow)) === 3);
await page.evaluate(() => { localStorage.removeItem('veyhold.debug'); localStorage.removeItem('veyhold.run.v1'); });

check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veyhold-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
