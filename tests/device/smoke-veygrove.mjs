// Plays veygrove inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veygrove.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veygrove.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veygrove-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veygrove')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veygrove page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const tap = async (x, y) => (page.tapAt ? page.tapAt(x, y) : page.mouse.click(x, y));
const tapPlot = async (i) => { const c = await page.evaluate((i) => vg.plotCenter(i), i); await tap(c.x, c.y); await page.waitForTimeout(250); };
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);
const dismiss = async () => { if (await page.locator('#ui [data-act=close]').count()) { await page.click('#ui [data-act=close]'); await page.waitForTimeout(100); } };
const reload = async () => { await page.evaluate(() => location.reload()); await page.waitForFunction(() => window.vg && (document.querySelector('.logo') || document.querySelector('.note')), null, { timeout: 30000 }); await page.evaluate(bot); };

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veygrove.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vg && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot);
await page.evaluate(() => { vg.settings.music = false; });
await page.waitForTimeout(600);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veygrove');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));
check('daily gift is offered', (await page.locator('[data-act=gift]').count()) === 1);
await page.click('[data-act=gift]'); await page.waitForTimeout(200);
check('daily gift gives coins once a day', await page.evaluate(() => vg.garden.s.coins > 30 && !document.querySelector('[data-act=gift]')));

await page.click('[data-act=enter]'); await page.waitForTimeout(400);
check('garden opens with 4 plots', await page.evaluate(() => vg.inGarden && vg.garden.ownedPlots() === 4 && !document.getElementById('hud').classList.contains('hidden')));
// plant by tapping a plot, then a seed
const first = await page.evaluate(() => vg.garden.s.plots.findIndex((p) => p && !p.plant));
await tapPlot(first);
check('tapping an empty plot opens the seeds', await page.evaluate(() => !document.getElementById('sheet').classList.contains('hidden') && !!document.querySelector('[data-act=seed][data-arg=moonbell]')));
const c0 = await page.evaluate(() => vg.garden.s.coins);
await page.click('[data-act=seed][data-arg=moonbell]'); await page.waitForTimeout(200);
check('planting a seed costs coins', await page.evaluate(([i, c0]) => vg.garden.s.plots[i].plant === 'moonbell' && vg.garden.s.coins === c0 - 5, [first, c0]));
await tapPlot(first);
check('tapping a growing plant waters it', await page.evaluate((i) => vg.garden.s.plots[i].water > 0, first));
// real time passes: plants grow while you watch
const g0 = await page.evaluate((i) => vg.garden.s.plots[i].grown, first); await page.waitForTimeout(2500);
const g1 = await page.evaluate((i) => vg.garden.s.plots[i].grown, first);
check('plants grow in real time (twice as fast when watered)', g1 - g0 > 3.5, `${(g1 - g0).toFixed(1)} growth-s in 2.5 s`);
await page.click('[data-act=plant-all]'); await page.waitForTimeout(200);
await page.click('[data-act=seed-all][data-arg=moonbell]'); await page.waitForTimeout(200);
check('plant all fills every empty plot', await page.evaluate(() => vg.garden.s.plots.filter((p) => p && !p.plant).length === 0));
await page.evaluate(() => vg.skip(25)); await page.waitForTimeout(300);
await shot(page, '2-ready');
const x0 = await page.evaluate(() => ({ c: vg.garden.s.coins, xp: vg.garden.s.xp, n: vg.garden.s.total }));
await dismiss();
await tapPlot(first);
const x1 = await page.evaluate(() => ({ c: vg.garden.s.coins, xp: vg.garden.s.xp, n: vg.garden.s.total }));
check('tapping a ready plant harvests it', x1.n === x0.n + 1 && x1.c === x0.c + 12, `${JSON.stringify(x0)} -> ${JSON.stringify(x1)}`);
await dismiss();
await page.click('[data-act=harvest-all]'); await page.waitForTimeout(200); await dismiss();
check('harvest all picks every ready plant', await page.evaluate(() => vg.garden.s.total === 4));
// requests
await dismiss();
await page.click('[data-act=orders]'); await page.waitForTimeout(200);
check('villager requests show', await page.evaluate(() => document.querySelectorAll('.order').length >= 2));
await page.evaluate(() => { const o = vg.garden.s.orders[0]; o.wants.forEach((w) => { w.got = w.n; }); vg.ui.showOrders(); });
const oc = await page.evaluate(() => vg.garden.s.coins);
await page.click('[data-act=claim]'); await page.waitForTimeout(200);
check('a finished request can be claimed', await page.evaluate((oc) => vg.garden.s.coins > oc, oc));
await dismiss();
if (await page.evaluate(() => !document.getElementById('sheet').classList.contains('hidden'))) await page.click('[data-act=close-sheet]'); await page.waitForTimeout(100);
// shop: new plot, upgrade
await page.evaluate(() => { vg.garden.s.coins = 100000; vg.garden.s.level = 8; vg.afterAction(); });
await dismiss();
await page.click('[data-act=shop]'); await page.waitForTimeout(200);
await page.click('[data-act=buy-plot]'); await page.waitForTimeout(200);
check('buying a plot adds one', await page.evaluate(() => vg.garden.ownedPlots() === 5));
await page.click('[data-act=shop][data-arg=upgrades]'); await page.waitForTimeout(200);
await page.click('[data-act=buy-up][data-arg=fairy]'); await page.waitForTimeout(200);
check('fairy helper can be bought', await page.evaluate(() => vg.garden.s.perks.fairy === 1));
await page.click('[data-act=shop][data-arg=decor]'); await page.waitForTimeout(200);
await page.click('[data-act=buy-decor][data-arg=lanterns]'); await page.waitForTimeout(200);
check('decorations can be bought', await page.evaluate(() => vg.garden.s.decor.includes('lanterns')));
await page.click('[data-act=close-sheet]');
// fairies harvest by themselves
await page.evaluate(() => { const g = vg.garden; g.s.plots.forEach((p, i) => { if (p) { p.plant = 'moonbell'; p.grown = 20; } }); });
await page.waitForTimeout(5500);
check('fairies harvest and replant on their own', await page.evaluate(() => vg.garden.s.total > 4 && vg.garden.s.plots.some((p) => p && p.plant && p.grown < 20)));
const fps = await fpsFor(3000);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps (quality ${await page.evaluate(() => vg.quality)}, dpr ${await page.evaluate(() => vg.dpr)})`);
await shot(page, '3-garden');

// time away: the garden grows while the game is closed (up to 8 hours)
await page.evaluate(() => { const g = vg.garden; g.s.perks.fairy = 0; g.s.plots.forEach((p) => { if (p) { p.plant = 'sunpetal'; p.grown = 0; p.water = 0; } }); vg.persist(); const s = JSON.parse(localStorage.getItem(vg.KEY)); s.lastSeen -= 2 * 3600 * 1000; localStorage.setItem(vg.KEY, JSON.stringify(s)); vg.noSave = true; });
await reload();
check('coming back after 2 hours: welcome back and plants are grown', await page.evaluate(() => /Welcome back/.test(document.body.textContent) && vg.garden.s.plots.filter((p, i) => p && vg.garden.ready(i)).length === vg.garden.ownedPlots()));
await shot(page, '4-welcome');
await page.click('[data-act=close]'); await page.waitForTimeout(150);
check('closing the note goes back to the menu', (await page.locator('.logo').count()) === 1);
await page.evaluate(() => { const g = vg.garden; g.s.perks.fairy = 2; g.s.plots.forEach((p) => { if (p) { p.plant = 'moonbell'; p.grown = 0; } }); vg.persist(); const s = JSON.parse(localStorage.getItem(vg.KEY)); s.lastSeen -= 10 * 3600 * 1000; localStorage.setItem(vg.KEY, JSON.stringify(s)); vg.noSave = true; });
const t0 = await page.evaluate(() => vg.garden.s.total);
await reload();
const away = await page.evaluate(() => ({ total: vg.garden.s.total, text: document.querySelector('.note')?.textContent || '' }));
check('fairies work while away, but only up to their basket (12 each), max 8 hours', away.total - t0 <= 24 && away.total - t0 >= 20 && /8 hours/.test(away.text), `${away.total - t0} harvests`);
await page.click('[data-act=close]');

// a long stretch of play by the bot: the garden keeps growing
const r = await page.evaluate(() => { localStorage.removeItem(vg.KEY); return null; });
void r;
await page.evaluate(() => { vg.garden.s = new vg.Garden(undefined, 77).s; vg.ui.g = vg.garden; });
const b1 = await page.evaluate(() => botGrove(3600));
check('an hour of play: steady progress', b1.level >= 7 && b1.level <= 12 && b1.plots >= 8, JSON.stringify(b1));
const b2 = await page.evaluate(() => botGrove(4 * 3600));
check('five hours of play: still more to do', b2.level >= 12 && b2.level < 25 && b2.decor < 8, JSON.stringify(b2));
await page.evaluate(() => vg.ui.showMenu()); await page.waitForTimeout(100);
await page.click('[data-act=enter]'); await page.waitForTimeout(800);
const fps2 = await fpsFor(3000);
await shot(page, '5-big-garden');
check('frame rate with a big garden', fps2 >= Math.min(20, FPS_MIN * 0.8), `${fps2.toFixed(1)} fps`);

await page.evaluate(() => vg.persist()); const lvl = await page.evaluate(() => vg.garden.s.level);
await reload();
check('save survives restart', (await page.evaluate(() => vg.garden.s.level)) === lvl);
await page.evaluate(() => { localStorage.removeItem('veygrove.debug'); localStorage.removeItem(vg.KEY); });

check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veygrove-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
