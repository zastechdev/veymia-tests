// Plays veyblock inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veyblock.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veyblock.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veyblock-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veyblock')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veyblock page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);
// a real drag: press on the piece in the tray, move it over the board, let go
const drag = async (from, to) => {
  const pts = []; for (let k = 0; k <= 8; k++) pts.push({ x: from.x + (to.x - from.x) * k / 8, y: from.y + (to.y - from.y) * k / 8 });
  if (page.swipePath) { await page.swipePath(pts); await page.waitForTimeout(200); return; }
  await page.mouse.move(pts[0].x, pts[0].y); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y); await page.mouse.up(); await page.waitForTimeout(200);
};
const st = () => page.evaluate(() => { const g = vb.game; return g ? { moves: g.moves, score: g.score, filled: g.filled(), tray: g.tray.filter(Boolean).length, gems: g.gemsLeft, over: g.over } : null; });

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veyblock.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vb && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot); await page.evaluate(() => { vb.save.settings.music = false; });
await page.waitForTimeout(400);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veyblock');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));
await page.click('[data-act=classic]'); await page.waitForTimeout(500);
check('classic starts with an empty board and 3 blocks', JSON.stringify(await st()).includes('"filled":0') && (await st()).tray === 3);
await shot(page, '2-classic');
// real drag of the first block to a spot where it fits
const plan = await page.evaluate(() => { const g = vb.game; for (let s = 0; s < 3; s++) { const sh = g.tray[s].shape; if (g.fits(sh, 1, 1)) return { s, cells: sh.cells.length, ...vb.dragPoints(s, 1, 1) }; } return null; });
await drag(plan.from, plan.to);
let s1 = await st();
check('dragging a block onto the board places it', s1.moves === 1 && s1.filled === plan.cells && s1.tray === 2, JSON.stringify(s1));
// dropping outside the board puts the block back
const slot2 = await page.evaluate(() => vb.game.tray.findIndex(Boolean));
const c2 = await page.evaluate((s) => vb.view.slotCenter(s), slot2);
const hgt = await page.evaluate(() => innerHeight); await drag(c2, { x: c2.x, y: hgt - 3 });
check('dropping a block off the board puts it back', (await st()).moves === 1 && (await st()).tray === 2);
// a full row clears
await page.evaluate(() => { const g = vb.game; for (const c of g.cells) { c.c = 0; c.gem = false; } for (let x = 0; x < 7; x++) g.cells[7 * 8 + x].c = 3; g.tray = [{ shape: vb.SHAPES.find((s) => s.group === 'dot'), color: 5, used: false }, g.tray[1] || null, g.tray[2] || null]; if (!g.tray[1]) g.tray[1] = { shape: vb.SHAPES[0], color: 2, used: false }; vb.game.score = 0; });
const p3 = await page.evaluate(() => vb.dragPoints(0, 7, 7));
await drag(p3.from, p3.to); await page.waitForTimeout(300);
const s3 = await st();
check('filling a row clears it and scores', s3.filled === 0 && s3.score >= 11, JSON.stringify(s3));
await shot(page, '3-cleared');
// new set of blocks after using all three
await page.evaluate(() => { const g = vb.game; for (const c of g.cells) c.c = 0; let n = 0; while (g.tray.some(Boolean) && n++ < 5) { const m = vb.bestMove(g); vb.placed(m.slot, m.x, m.y); } });
check('using all three blocks deals three new ones', (await st()).tray === 3);
const fps = await fpsFor(2500);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps`);
// continue later
await page.click('[data-act=pause]'); await page.waitForTimeout(100); await page.click('#ui [data-act=menu]'); await page.waitForTimeout(200);
check('menu offers Continue', (await page.locator('[data-act=resume]').count()) === 1);
const before = await page.evaluate(() => vb.save.run.score);
await page.click('[data-act=resume]'); await page.waitForTimeout(300);
check('continue brings the same game back', (await st()).score === before);
// play until no block fits: game over shows the score and saves the best
const r1 = await page.evaluate(() => botBlock(2000));
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 15000 }).catch(() => {});
check('game over shows the score and saves the best', r1.over && await page.evaluate((sc) => !!document.querySelector('.big-score') && vb.save.best === sc, r1.score), `score ${r1.score}`);
// fair blocks: every new set has a block that fits
const fair = await page.evaluate(() => { let bad = 0; for (let t = 0; t < 40; t++) { vb.start('classic'); const g = vb.game; let n = 0; while (!g.over && n++ < 300) { if (g.tray.filter(Boolean).length === 3 && !g.tray.some((p) => g.canPlace(p.shape)) && g.filled() < 60) bad++; const m = vb.bestMove(g); if (!m) break; g.place(m.slot, m.x, m.y); } } vb.ui.close(); return bad; });
check('fair blocks: every new set has a block that fits', fair === 0, `${fair} unfair sets`);
// adventure
await page.evaluate(() => { vb.ui.close(); vb.ui.showLevels(0); }); await page.waitForTimeout(150);
check('adventure: 12 levels, only the first open', await page.evaluate(() => document.querySelectorAll('.lv').length === 12 && document.querySelectorAll('.lv.locked').length === 11));
await page.click('[data-act=level][data-arg="0"]'); await page.waitForTimeout(400);
const a0 = await st();
check('level 1 has gems to collect', a0.gems >= 2 && a0.filled > 0, JSON.stringify(a0));
await shot(page, '4-adventure');
let won = false; for (let t = 0; t < 4 && !won; t++) { const r = await page.evaluate(() => botBlock()); won = r.won; if (!won) await page.evaluate(() => { vb.ui.close(); vb.start('adventure', 0); }); }
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 15000 }).catch(() => {});
check('collecting every gem wins with stars', won && await page.evaluate(() => !!document.querySelector('.results .big-stars') && vb.save.stars[0] >= 1));
// daily
await page.evaluate(() => { vb.ui.close(); vb.start('daily'); }); await page.waitForTimeout(200);
const d1 = await page.evaluate(() => vb.game.tray.map((p) => p.shape.id).join(','));
await page.evaluate(() => vb.start('daily'));
const d2 = await page.evaluate(() => vb.game.tray.map((p) => p.shape.id).join(','));
check('daily challenge deals the same blocks all day', d1 === d2, d1);
await page.evaluate(() => botBlock(2000));
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 15000 }).catch(() => {});
check('daily challenge counts toward the streak', await page.evaluate(() => vb.save.daily.streak === 1 && vb.save.daily.best > 0));
// many levels can be won
let wins = 0; for (let i = 0; i < 60; i += 6) { let w = false; for (let t = 0; t < 3 && !w; t++) w = (await page.evaluate((i) => { vb.ui.close(); vb.start('adventure', i); return botBlock(); }, i)).won; if (w) wins++; await page.waitForTimeout(40); }
check('adventure levels across all chapters can be won', wins >= 8, `${wins}/10`);
await page.evaluate(() => { vb.ui.close(); vb.save.stars = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, 3])); vb.ui.showThemes(); }); await page.waitForTimeout(100);
await page.click('[data-act=theme][data-arg=mint]'); await page.waitForTimeout(150);
check('themes can be changed with stars', await page.evaluate(() => vb.save.theme === 'mint' && vb.view.theme.id === 'mint'));
await page.evaluate(() => { vb.ui.close(); vb.start('adventure', 50); }); await page.waitForTimeout(600);
const fps2 = await fpsFor(2500); await shot(page, '5-late');
check('frame rate on a busy board', fps2 >= FPS_MIN, `${fps2.toFixed(1)} fps`);
await page.evaluate(() => { localStorage.setItem('veyblock.save.v1', JSON.stringify(vb.save)); location.reload(); });
await page.waitForFunction(() => window.vb && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', await page.evaluate(() => vb.save.theme === 'mint' && vb.save.best > 0 && vb.save.daily.streak === 1));
await page.evaluate(() => { localStorage.removeItem('veyblock.debug'); });
check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veyblock-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
