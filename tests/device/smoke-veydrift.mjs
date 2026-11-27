// Plays veydrift inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veydrift.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veydrift.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veydrift-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veydrift')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veydrift page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// hold a point on the screen (touch on Android, mouse on Windows / browser)
const hold = async (x, y, ms) => {
  if (page.touchDrag) return page.touchDrag(x, y, 0, ms);
  await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up();
};
const tap = async (x, y) => (page.tapAt ? page.tapAt(x, y) : page.mouse.click(x, y));
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veydrift.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vd && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot);
await page.evaluate(() => { vd.save.settings.music = false; });
await page.waitForTimeout(800);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veydrift');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));

await page.click('[data-act=tracks]'); await page.waitForTimeout(200);
check('track list shows 3 tracks, only the first open', await page.evaluate(() => document.querySelectorAll('.map-card').length === 3 && document.querySelectorAll('.map-card.locked').length === 2));
await page.click('[data-act=play][data-arg="0"]'); await page.waitForTimeout(500);
check('race starts with a countdown', await page.evaluate(() => !!vd.race && vd.race.state === 'count' && !document.getElementById('countdown').classList.contains('hidden')));
await shot(page, '2-countdown');
await page.waitForFunction(() => vd.race && vd.race.state === 'race', null, { timeout: 10000 }).catch(() => {});
const t0 = await page.evaluate(() => vd.race.t); await page.waitForTimeout(3000);
const st = await page.evaluate(() => ({ t: vd.race.t, speed: vd.race.p.speed / vd.race.maxSpeed, z: vd.race.p.z }));
check('ship flies at real speed', st.t - t0 > 2.6 && st.speed > 0.5, `${(st.t - t0).toFixed(2)} race-s in 3 s, speed ${(st.speed * 100).toFixed(0)}%`);

// steering with real input: hold the right side, then the left side
const x0 = await page.evaluate(() => vd.race.p.x);
await hold(vp[0] * 0.9, vp[1] * 0.6, 700);
const x1 = await page.evaluate(() => vd.race.p.x);
await hold(vp[0] * 0.1, vp[1] * 0.6, 1100);
const x2 = await page.evaluate(() => vd.race.p.x);
check('holding the right / left side steers', x1 > x0 + 0.08 && x2 < x1 - 0.08, `x ${x0.toFixed(2)} -> ${x1.toFixed(2)} -> ${x2.toFixed(2)}`);
// the boost button
await page.evaluate(() => { vd.race.p.boost = 1; });
const bb = await page.evaluate(() => { const r = document.getElementById('boost-btn').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
await tap(bb[0], bb[1]); await page.waitForTimeout(250);
check('boost button boosts', await page.evaluate(() => vd.race.p.boostT > 0 && vd.race.p.boost === 0));
await page.waitForTimeout(600); await shot(page, '3-boost');
const fps = await fpsFor(3000);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps (quality ${await page.evaluate(() => vd.quality)}, dpr ${await page.evaluate(() => vd.dpr)})`);
// a rock right in front costs speed
await page.evaluate(() => { const r = vd.race; const s = r.seg(r.p.z + 200 * 1.5 + 200 * 8); s.objs.push({ id: 999999, kind: 'rock', x: r.p.x }); });
await page.waitForTimeout(900);
check('hitting a rock slows the ship', await page.evaluate(() => vd.race.p.hits >= 1));

// leave and continue
const before = await page.evaluate(() => ({ lap: vd.race.lap, z: Math.round(vd.race.p.z / 1000) }));
await page.click('#pause-btn'); await page.waitForTimeout(150); await page.click('[data-act=quit]'); await page.waitForTimeout(300);
check('menu offers Continue after leaving a race', (await page.locator('[data-act=resume-saved]').count()) === 1);
await page.click('[data-act=resume-saved]'); await page.waitForTimeout(300);
const after = await page.evaluate(() => ({ lap: vd.race.lap, z: Math.round(vd.race.p.z / 1000) }));
check('continue puts the ship back where it was', after.lap === before.lap && Math.abs(after.z - before.z) <= 2, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);

// winning a whole race
const r1 = await page.evaluate(() => botDrift());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 20000 }).catch(() => {});
await shot(page, '4-result');
check('finishing shows place, stars and Next track', r1.place <= 3 && await page.evaluate(() => !!document.querySelector('.results .big-stars') && !!document.querySelector('[data-act=next]')), JSON.stringify(r1));
check('place and coins are saved', await page.evaluate(() => vd.save.place[0] >= 1 && vd.save.coins > 0));

// a bad race: no next track, race again
await page.evaluate(() => { vd.ui.close(); vd.start(1); vd.race.cars.forEach((c) => { c.pace = 1.6; }); });
const r2 = await page.evaluate(() => botDrift({ skill: 0.2 }));
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 20000 }).catch(() => {});
check('finishing out of the top 3 offers Race again', r2.place > 3 && await page.evaluate(() => !document.querySelector('[data-act=next]') && !!document.querySelector('[data-act=restart]')), `place ${r2.place}`);

// garage
await page.evaluate(() => { vd.save.coins = 1000; vd.save.spent = 0; });
await page.click('[data-act=garage]'); await page.waitForTimeout(200);
await page.click('[data-act=perk][data-arg="engine"]'); await page.waitForTimeout(200);
check('garage upgrade can be bought with coins', await page.evaluate(() => vd.save.perks.engine === 1 && vd.save.spent === 120));
await page.click('[data-act=menu]'); await page.waitForTimeout(200);

// daily sprint
await page.click('[data-act=daily]'); await page.waitForTimeout(300);
const rd = await page.evaluate(() => botDrift());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 20000 }).catch(() => {});
check('daily sprint plays to the end and saves the best time', await page.evaluate(() => /Sprint/.test(document.querySelector('.results h2').textContent) && vd.save.daily.best > 0), `time ${rd.time}`);

// every track, raced by the bot with the upgrades a player would have by then
let wins = 0, podiums = 0;
for (let i = 0; i < 12; i++) {
  const r = await page.evaluate((i) => { const l = Math.min(4, Math.floor(i / 3)); vd.save.perks = { engine: l, wings: l, booster: l, hull: l }; vd.save.settings.sound = false; vd.ui.close(); vd.start(i); return botDrift(); }, i);
  if (r.place === 1) wins++; if (r.place <= 3) podiums++;
  check(`track ${i + 1}`, r.laps === 3, `place ${r.place} time ${r.time}s hits ${r.hits} crystals ${r.coins}`);
  await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 20000 }).catch(() => {});
}
check('the bot wins or reaches the podium on most tracks', podiums >= 8 && wins >= 4, `${wins} wins, ${podiums} podiums of 12`);

// frame rate in a busy late race, with everything on screen
await page.evaluate(() => { vd.ui.close(); vd.start(11); vd.autopilot = true; });
await page.waitForTimeout(6000);
const fpsLate = await fpsFor(3000);
await shot(page, '5-late-race');
check('frame rate on a late track', fpsLate >= Math.min(20, FPS_MIN * 0.8), `${fpsLate.toFixed(1)} fps`);
await page.evaluate(() => { vd.autopilot = false; });

await page.evaluate(() => { vd.save.place = { 0: 1, 1: 2 }; localStorage.setItem('veydrift.save.v1', JSON.stringify(vd.save)); location.reload(); });
await page.waitForFunction(() => window.vd && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', (await page.evaluate(() => vd.save.place[1])) === 2);
await page.evaluate(() => { localStorage.removeItem('veydrift.debug'); localStorage.removeItem('veydrift.run.v1'); });

check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veydrift-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
