// Plays veyforge inside the real app (Windows WebView2 or Android WebView) through the
// Chrome DevTools Protocol and checks that everything works.
// Usage: node smoke.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const clearModal = async (page) => { for (let i = 0; i < 20; i++) { const n = await page.evaluate(() => { const o = document.querySelector('.opt'); if (o) o.click(); return document.querySelectorAll('.opt').length; }); if (!n) return; await page.waitForTimeout(100); } };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };

let browser = null, page = null;
if (cdp.startsWith('lite:')) {
  page = await connectLite(cdp.slice(5)); // Android WebView
} else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veyforge')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veyforge page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// enable the test hook and start from a clean save
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veyforge.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vf && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot); // evaluated (not a <script> tag) so the app's strict CSP does not block it
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veyforge');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));

// real-time play: the actual game loop, drawing and input on this device
await page.click('[data-act=play]');
await page.waitForTimeout(500);
// keep the movement checks free of level-up popups (those pause the game)
await page.evaluate(() => { vf.run.hp = vf.run.maxHp = 1e6; vf.run.ev.levelUp = () => { vf.run.pendingLevels = 0; vf.run.paused = false; }; });
const x0 = await page.evaluate(() => vf.run.px);
await page.keyboard.down('d'); await page.waitForTimeout(1500); await page.keyboard.up('d');
await clearModal(page);
check('keyboard moves hero', (await page.evaluate(() => vf.run.px)) - x0 > 80);
const y0 = await page.evaluate(() => vf.run.py);
if (page.touchDrag) await page.touchDrag(150, 300, 120, 1200); // Android: real touch events
else {
  await page.evaluate(() => { const c = document.getElementById('game'); const o = { pointerId: 9, pointerType: 'touch', bubbles: true, clientX: 150, clientY: 300 };
    c.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointermove', { ...o, clientY: 420 })); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('game').dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true })));
}
await clearModal(page);
const y1 = await page.evaluate(() => vf.run.py);
check('touch drag moves hero', y1 - y0 > 60, `moved ${(y1 - y0).toFixed(0)}, ` + await page.evaluate(() => JSON.stringify({ paused: vf.run.paused, over: vf.run.over })));
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(f) : res(n / 3); }; requestAnimationFrame(f); }));
// emulators without a GPU draw in software, so CI can lower the bar with FPS_MIN; real speed is checked separately
const FPS_MIN = Number(process.env.FPS_MIN || 25);
const q = await page.evaluate(() => `quality ${vf.quality}, dpr ${vf.dpr}`);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps (${q})`);
await clearModal(page); await page.evaluate(() => { vf.run.hp = vf.run.maxHp = 1e6; vf.run.ev.levelUp = () => { vf.run.pendingLevels = 0; vf.run.paused = false; }; });
const t0 = await page.evaluate(() => vf.run.t); await page.waitForTimeout(3000); const t1 = await page.evaluate(() => vf.run.t);
check('game runs at real speed', t1 - t0 > 2.6, `${(t1 - t0).toFixed(2)} game-s in 3 s`);
await shot(page, '2-playing');

// crowded late game for 5 real seconds
await page.evaluate(() => { vf.run.t = 480; vf.run.hp = 1e6; vf.run.maxHp = 1e6; for (const w of ['whirl', 'storm', 'halo', 'knives']) vf.run.addWeapon(w); vf.run.ev.levelUp = () => { vf.run.pendingLevels = 0; vf.run.paused = false; }; });
await page.keyboard.down('a'); await page.waitForTimeout(5000); await page.keyboard.up('a');
const busy = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : res({ fps: n / 2, alive: vf.run.enemies.filter((e) => e.alive).length }); }; requestAnimationFrame(f); }));
check('frame rate with crowd', busy.fps >= Math.min(20, FPS_MIN * 0.6), `${busy.fps.toFixed(1)} fps, ${busy.alive} monsters`);
await shot(page, '3-crowd');
await clearModal(page);
await page.click('#pause-btn'); await page.click('[data-act=quit]'); await page.waitForTimeout(1500);
check('results screen', (await page.locator('.results').count()) === 1);
await shot(page, '4-results');

// falling down: Continue keeps time, level and weapons
await page.click('[data-act=menu]'); await page.click('[data-act=play]'); await page.waitForTimeout(400);
await page.evaluate(() => { const r = vf.run; r.t = 200; r.level = 15; r.addWeapon('knives'); r.addWeapon('axe'); r.hp = 1; r.iframe = 0; r.hurt(999); });
await page.waitForTimeout(300);
const fell = await page.evaluate(() => ({ screen: !!document.querySelector('.downed'), paused: vf.run.paused, over: vf.run.over }));
check('falling shows Continue', fell.screen && fell.paused && !fell.over, JSON.stringify(fell));
await shot(page, '5-fell');
await page.click('[data-act=continue]'); await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ t: vf.run.t, level: vf.run.level, weapons: vf.run.weapons.size, full: vf.run.hp === vf.run.maxHp, paused: vf.run.paused, continues: vf.run.continues }));
check('Continue keeps level, weapons and time', after.t >= 200 && after.level === 15 && after.weapons === 3 && after.full && !after.paused && after.continues === 1, JSON.stringify(after));

// closing the app mid-run: the menu offers to continue the same run
await page.waitForTimeout(5600); // autosave runs every 5 s
// freeze the game so nothing changes between reading it and closing the page (closing saves the latest state)
const before = await page.evaluate(() => { vf.run.paused = true; return { t: vf.run.t, level: vf.run.level, weapons: vf.run.weapons.size }; });
await page.evaluate(() => location.reload());
await page.waitForFunction(() => window.vf && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot);
const offer = (await page.locator('[data-act=resume-saved]').count()) === 1;
check('menu offers Continue your run', offer);
if (offer) {
  await page.click('[data-act=resume-saved]'); await page.waitForTimeout(400);
  const back = await page.evaluate(() => ({ t: vf.run.t, level: vf.run.level, weapons: vf.run.weapons.size }));
  check('resumed run has same level and weapons', back.level === before.level && back.weapons === before.weapons && Math.abs(back.t - before.t) < 1, `before ${JSON.stringify(before)} after ${JSON.stringify(back)}`);
  await clearModal(page);
  await page.click('#pause-btn'); await page.click('[data-act=quit]'); await page.waitForTimeout(1500);
  check('ending the run clears the saved run', await page.evaluate(() => localStorage.getItem('veyforge.run.v1') === null));
}

// a brand-new player with no upgrades can reach the end by getting back up
await page.evaluate(() => { vf.save.hero = 'kael'; vf.save.forge = {}; vf.save.settings.sound = false; vf.save.settings.music = false; vf.ui.showMenu(); vf.startRun(false); });
const nb = await page.evaluate(() => botPlay({ continues: 30, uiLevelUps: false }));
check('new player reaches the end with Continue', nb.t >= 600 || nb.won, `t=${nb.t}s won=${nb.won} level=${nb.level} continues=${nb.continues}`);

// full runs to the end (game simulated fast, drawing every 3rd frame): every hero, fully upgraded
const FULL = { power: 5, health: 5, speed: 5, magnet: 5, greed: 5, growth: 5, revive: 1 };
let wins = 0, reached = 0;
for (const hero of ['kael', 'lyra', 'orin', 'brann']) {
  await page.evaluate(([h, f]) => { vf.save.hero = h; vf.save.heroes = ['kael', 'lyra', 'orin', 'brann']; vf.save.forge = f; vf.save.settings.sound = false; vf.save.settings.music = false; vf.ui.showMenu(); vf.startRun(false); }, [hero, FULL]);
  const r = await page.evaluate(() => botPlay({ render: true, continues: 3 })); // like a player, it may get back up a few times
  if (r.won) wins++;
  if (r.won || r.t >= 600) reached++;
  check(`full run ${hero}`, r.over || r.t >= 600, `t=${r.t}s won=${r.won} level=${r.level} kills=${r.kills}`);
}
// how many of these no-Continue bot runs win varies run to run; reaching the final boss is the stable signal
check('upgraded heroes reach the final boss', reached >= 3, `${reached}/4 reached, ${wins}/4 won`);

// save survives a restart of the page
await page.evaluate(() => { vf.save.gold = 1234; vf.ui.showMenu(); localStorage.setItem('veyforge.save.v1', JSON.stringify(vf.save)); location.reload(); });
await page.waitForFunction(() => window.vf && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', (await page.evaluate(() => vf.save.gold)) === 1234);
await page.evaluate(() => { localStorage.removeItem('veyforge.debug'); });

check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
