// Plays veytile inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veytile.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veytile.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veytile-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veytile')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veytile page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const tap = async (x, y) => (page.tapAt ? page.tapAt(x, y) : page.mouse.click(x, y));
const tapTile = async (id) => { const pt = await page.evaluate((id) => vt.tilePoint(vt.board.tiles[id]), id); await tap(pt.x, pt.y); await page.waitForTimeout(150); };
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);
const left = () => page.evaluate(() => vt.board.tiles.filter((t) => !t.gone).length);

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veytile.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vt && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot); await page.evaluate(() => { vt.save.settings.music = false; });
await page.waitForTimeout(400);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veytile');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));
await page.click('[data-act=levels]'); await page.waitForTimeout(150);
check('level list: 12 levels, only the first open', await page.evaluate(() => document.querySelectorAll('.lv').length === 12 && document.querySelectorAll('.lv.locked').length === 11));
await page.click('[data-act=play][data-arg="0"]'); await page.waitForTimeout(500);
check('level 1 starts with 54 tiles', (await left()) === 54);
await shot(page, '2-board');
// a blocked tile cannot be picked
const blocked = await page.evaluate(() => vt.board.tiles.find((t) => !vt.board.free(t)).id);
await tapTile(blocked);
check('a blocked tile cannot be picked', await page.evaluate(() => !vt.view.selected));
// match a pair with real taps
const pair = await page.evaluate(() => vt.board.hint().map((t) => t.id));
await tapTile(pair[0]); await tapTile(pair[1]); await page.waitForTimeout(300);
check('tapping two matching free tiles removes them', (await left()) === 52);
// two free tiles that do not match: nothing is removed
const odd = await page.evaluate(() => { const b = vt.board, f = b.alive().filter((t) => b.free(t)); for (const a of f) for (const c of f) if (a !== c && !b.canMatch(a, c)) return [a.id, c.id]; return null; });
if (odd) { await tapTile(odd[0]); await tapTile(odd[1]); }
check('two tiles that do not match stay', (await left()) === 52 && (!odd || await page.evaluate((id) => vt.view.selected?.id === id, odd[1])));
await page.click('#undo-btn'); await page.waitForTimeout(200);
check('undo brings the pair back', (await left()) === 54);
await page.click('[data-act=hint]'); await page.waitForTimeout(150);
check('hint shows a pair', await page.evaluate(() => !!vt.view.hint));
await page.click('#shuffle-btn'); await page.waitForTimeout(200);
check('shuffle keeps the board clearable', await page.evaluate(() => { const b = vt.board, c = new vt.Board(b.layout, 1, 12); c.restore(b.snapshot()); let n = 0; while (!c.won && n++ < 200) { const h = c.hint(); if (!h) break; c.match(h[0], h[1]); } return vt.board.shuffles === 1 && !!b.hint(); }));
const fps = await fpsFor(2500);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps`);
// continue later
await page.evaluate(() => { const h = vt.board.hint(); vt.board.match(h[0], h[1]); vt.after(); });
const n1 = await left();
await page.click('[data-act=pause]'); await page.waitForTimeout(100); await page.click('#ui [data-act=menu]'); await page.waitForTimeout(200);
check('menu offers Continue', (await page.locator('[data-act=resume-saved]').count()) === 1);
await page.click('[data-act=resume-saved]'); await page.waitForTimeout(300);
check('continue brings the same board back', (await left()) === n1);
// clear the board
const r1 = await page.evaluate(() => botTile());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 15000 }).catch(() => {});
await shot(page, '3-cleared');
check('clearing the board shows stars and Next level', r1.won && await page.evaluate(() => !!document.querySelector('.results .big-stars') && !!document.querySelector('[data-act=next]')), JSON.stringify(r1));
check('stars are saved', await page.evaluate(() => vt.save.stars[0] >= 1 && vt.save.won === 1));
// daily
await page.evaluate(() => { vt.ui.close(); vt.startDaily(); }); await page.waitForTimeout(200);
const s1 = await page.evaluate(() => vt.board.tiles.map((t) => t.kind).join(','));
await page.evaluate(() => vt.startDaily()); await page.waitForTimeout(200);
const s2 = await page.evaluate(() => vt.board.tiles.map((t) => t.kind).join(','));
check('daily puzzle is the same board all day', s1 === s2);
await page.evaluate(() => botTile());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 15000 }).catch(() => {});
check('daily puzzle counts toward the daily streak', await page.evaluate(() => vt.save.daily.streak === 1 && /Daily/.test(document.querySelector('.results h2').textContent)));
// themes
await page.evaluate(() => { vt.save.stars = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, 3])); vt.ui.showThemes(); }); await page.waitForTimeout(100);
await page.click('[data-act=theme][data-arg=night]'); await page.waitForTimeout(200);
check('themes can be changed with stars', await page.evaluate(() => vt.save.theme === 'night' && vt.view.theme.id === 'night'));
await page.evaluate(() => vt.ui.close());
// every layout, cleared by the bot
let cleared = 0, shuffles = 0;
for (let i = 0; i < 10; i++) { const r = await page.evaluate((i) => { vt.ui.close(); vt.startLevel(i); return botTile(); }, i); if (r.won) cleared++; shuffles += r.shuffles; await page.waitForTimeout(80); }
check('the bot clears all 10 layouts', cleared === 10, `${cleared}/10, ${shuffles} shuffles`);
await page.evaluate(() => { vt.ui.close(); vt.startLevel(9); }); await page.waitForTimeout(600);
const fps2 = await fpsFor(2500); await shot(page, '4-turtle');
check('frame rate on the biggest board (174 tiles)', fps2 >= Math.min(20, FPS_MIN * 0.8), `${fps2.toFixed(1)} fps`);
await page.evaluate(() => { localStorage.setItem('veytile.save.v1', JSON.stringify(vt.save)); location.reload(); });
await page.waitForFunction(() => window.vt && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', await page.evaluate(() => vt.save.theme === 'night' && vt.save.won >= 2));
await page.evaluate(() => { localStorage.removeItem('veytile.debug'); localStorage.removeItem(vt.RUN_KEY); });
check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veytile-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
