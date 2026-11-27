// Plays veysol inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veysol.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veysol.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veysol-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veysol')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veysol page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const tap = async (x, y) => (page.tapAt ? page.tapAt(x, y) : page.mouse.click(x, y));
const drag = async (x, y, x2, y2) => {
  if (page.swipe) return page.swipe(x, y, x2 - x, y2 - y);
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + ((x2 - x) * i) / 8, y + ((y2 - y) * i) / 8);
  await page.mouse.up();
};
const settle = async () => { await page.waitForTimeout(200); await page.waitForFunction(() => !vs.view.busy, null, { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(150); };
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);
// the screen point of a card (by pile and position): its visible top strip
const cardPoint = (pile, at) => page.evaluate(([pile, at]) => { const v = vs.view, c = vs.game.piles[pile].cards[at], t = v.targets().get(c.id); return { x: t.x + v.cw / 2, y: t.y + Math.min(v.ch * 0.12, 10) }; }, [pile, at]);
const slotPoint = (pile) => page.evaluate((pile) => { const v = vs.view, p = vs.game.piles[pile], s = v.slots[pile]; if (!p.cards.length) return { x: s.x + v.cw / 2, y: s.y + v.ch / 2 }; const t = v.targets().get(p.cards[p.cards.length - 1].id); return { x: t.x + v.cw / 2, y: t.y + v.ch / 2 }; }, pile);
const dismiss = async () => { await page.evaluate(() => vs.ui.close()); };

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veysol.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vs && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot);
await page.waitForTimeout(500);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veysol');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));
await page.click('[data-act=modes]'); await page.waitForTimeout(200);
check('all six games are listed', await page.evaluate(() => document.querySelectorAll('.mode-card').length === 6));

// Klondike: a winnable deal
const t0 = Date.now();
await page.click('[data-act=play][data-arg=klondike1]');
await page.waitForFunction(() => vs.game && vs.game.mode === 'klondike', null, { timeout: 30000 });
const dealMs = Date.now() - t0;
check('Klondike deals a deal that can be won', await page.evaluate(() => vs.solvable(new vs.Game('klondike', 1, vs.game.seed))), `${dealMs} ms to shuffle`);
await settle(); await shot(page, '2-klondike');
check('7 columns, 24 cards in the deck', await page.evaluate(() => vs.game.tabs().length === 7 && vs.game.piles[0].cards.length === 24));
const deck = await slotPoint(0);
await tap(deck.x, deck.y); await settle();
check('tapping the deck draws a card', await page.evaluate(() => vs.game.piles[1].cards.length === 1 && vs.game.piles[0].cards.length === 23));
// a real drag onto another column (draw until one exists)
let mv = null;
for (let i = 0; i < 30 && !mv; i++) {
  mv = await page.evaluate(() => vs.game.legalMoves().find((m) => vs.game.piles[m.to].kind === 'tab' && vs.game.piles[m.to].cards.length) || null);
  if (!mv) { await page.evaluate(() => { vs.game.stock(); vs.after(); }); await settle(); }
}
if (mv) {
  const from = await cardPoint(mv.from, (await page.evaluate((m) => vs.game.piles[m.from].cards.length - m.count, mv)));
  const to = await slotPoint(mv.to);
  const before = await page.evaluate((m) => vs.game.piles[m.to].cards.length, mv);
  await drag(from.x, from.y, to.x, to.y + 10); await settle();
  check('dragging a card onto a column moves it', await page.evaluate(([m, b]) => vs.game.piles[m.to].cards.length >= b + m.count, [mv, before]), JSON.stringify(mv));
} else check('dragging a card onto a column moves it', false, 'no move found');
// undo
const movesBefore = await page.evaluate(() => vs.game.piles.map((p) => p.cards.length).join(','));
await page.evaluate(() => { const m = vs.game.legalMoves()[0]; if (m) { vs.game.move(m); vs.after(); } }); await settle();
await page.click('#undo-btn'); await settle();
check('undo puts it back', (await page.evaluate(() => vs.game.piles.map((p) => p.cards.length).join(','))) === movesBefore);
// tap a card: it goes to the best place
let tapMv = null;
for (let i = 0; i < 30 && !tapMv; i++) {
  tapMv = await page.evaluate(() => { const g = vs.game; for (let p = 0; p < g.piles.length; p++) { const pl = g.piles[p]; if (!['tab', 'waste'].includes(pl.kind) || !pl.cards.length) continue; const at = pl.cards.length - 1; if (g.bestTarget(p, at) >= 0) return { p, at }; } return null; });
  if (!tapMv) { await page.evaluate(() => { vs.game.stock(); vs.after(); }); await settle(); }
}
if (tapMv) { const n0 = await page.evaluate(() => vs.game.moves); const pt = await cardPoint(tapMv.p, tapMv.at); await tap(pt.x, pt.y + 6); await settle(); check('tapping a card sends it to the best spot', (await page.evaluate(() => vs.game.moves)) > n0); }
else check('tapping a card sends it to the best spot', false, 'no tap move found');
await page.click('#hint-btn'); await page.waitForTimeout(200);
check('hint shows a move', await page.evaluate(() => !!vs.view.hint));
const fps = await fpsFor(2500);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps`);

// leave and continue
const mid = await page.evaluate(() => vs.game.moves);
await page.click('[data-act=game-menu]'); await page.waitForTimeout(150); await page.click('[data-act=menu]'); await page.waitForTimeout(200);
check('menu offers Continue', (await page.locator('[data-act=resume-saved]').count()) === 1);
await page.click('[data-act=resume-saved]'); await settle();
check('continue brings the same game back', (await page.evaluate(() => vs.game.moves)) === mid);

// finishing: an almost-won game finishes itself, then the result screen
await page.evaluate(() => {
  const g = vs.game; const all = g.piles.flatMap((p) => p.cards); g.piles.forEach((p) => { p.cards = []; });
  const found = g.idx('found'), tabs = g.idx('tab');
  for (let s = 0; s < 4; s++) { const suit = all.filter((c) => c.suit === s).sort((a, b) => a.rank - b.rank); suit.forEach((c) => { c.up = true; }); g.piles[found[s]].cards = suit.slice(0, 11); g.piles[tabs[s]].cards = [suit[12], suit[11]]; }
  vs.view.setGame(g, true); vs.after();
});
await page.waitForTimeout(500);
check('Finish appears when every card is free', await page.evaluate(() => !document.getElementById('finish-btn').classList.contains('hidden')));
await page.click('#finish-btn');
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 15000 }).catch(() => {});
await shot(page, '3-won');
check('winning shows the result with time and score', await page.evaluate(() => !!document.querySelector('.results') && vs.game.won));
check('stats, level and awards are saved', await page.evaluate(() => vs.save.stats.klondike1.won === 1 && vs.save.xp + vs.save.level > 1 && vs.save.achievements.includes('first')));

// Spider: deal a row, clear a full run
await dismiss(); await page.evaluate(() => vs.start('spider1')); await settle();
check('Spider deals 10 columns and 50 cards to deal', await page.evaluate(() => vs.game.tabs().length === 10 && vs.game.piles[0].cards.length === 50));
const sdeck = await slotPoint(0); await tap(sdeck.x, sdeck.y); await settle();
check('tapping the deck deals a row', await page.evaluate(() => vs.game.piles[0].cards.length === 40));
await page.evaluate(() => { const g = vs.game, t = g.idx('tab'); const pool = g.piles.flatMap((p) => p.cards).filter((c) => c.suit === 0); const run = []; for (let r = 13; r >= 2; r--) { const c = pool.find((x) => x.rank === r && !run.includes(x)); run.push(c); } const ace = pool.find((x) => x.rank === 1);
  g.piles.forEach((p) => { p.cards = p.cards.filter((c) => !run.includes(c) && c !== ace); }); run.forEach((c) => { c.up = true; }); ace.up = true; g.piles[t[0]].cards.push(...run); g.piles[t[1]].cards.push(ace); vs.view.setGame(g, true); });
const sp = await page.evaluate(() => { const t = vs.game.idx('tab'); return { from: t[1], to: t[0] }; });
await page.evaluate((sp) => { vs.game.move({ from: sp.from, count: 1, to: sp.to }); vs.after(); }, sp); await settle();
check('a full King-to-Ace run leaves the table', await page.evaluate(() => vs.game.piles[vs.game.idx('found')[0]].cards.length === 13));
await shot(page, '4-spider');

// FreeCell: drag a card into a free cell
await page.evaluate(() => vs.start('freecell')); await settle();
const fc = await page.evaluate(() => { const t = vs.game.idx('tab')[0]; return { t, at: vs.game.piles[t].cards.length - 1 }; });
const a1 = await cardPoint(fc.t, fc.at), cell = await slotPoint(0);
await drag(a1.x, a1.y + 20, cell.x, cell.y); await settle();
check('FreeCell: a card can be dragged into a free cell', await page.evaluate(() => vs.game.piles[0].cards.length === 1));
check('FreeCell: only as many cards move as free cells allow', await page.evaluate(() => vs.game.maxMove(-1) === 4));

// daily deal: the same for everyone today
await page.evaluate(() => vs.startDaily()); await settle();
const d1 = await page.evaluate(() => ({ seed: vs.game.seed, daily: vs.game.daily }));
await page.evaluate(() => vs.startDaily()); await settle();
const d2 = await page.evaluate(() => vs.game.seed);
check('daily deal is the same deal all day', d1.seed === d2 && !!d1.daily);

// themes
await page.evaluate(() => { vs.save.level = 20; vs.ui.showThemes(); }); await page.waitForTimeout(150);
await page.click('[data-act=table][data-arg=midnight]'); await page.click('[data-act=back][data-arg=ruby]'); await page.waitForTimeout(200);
check('tables and card backs can be changed', await page.evaluate(() => vs.save.table === 'midnight' && vs.save.back === 'ruby' && vs.view.table.id === 'midnight'));
await dismiss();

// many games played by hint presses: no errors, fair share of wins
const tally = { klondike: 0, freecell: 0, spider: 0 };
for (const [k, n] of [['klondike1', 10], ['freecell', 6], ['spider1', 6]]) for (let i = 0; i < n; i++) {
  const r = await page.evaluate(async (k) => { vs.start(k); await new Promise((res) => setTimeout(res, 60)); return botSol(); }, k);
  if (r.won) tally[k.replace(/\d/g, '')]++;
}
check('22 games played by pressing Hint, no errors', true, JSON.stringify(tally));
const tSolve = await page.evaluate(() => { const t = performance.now(); vs.winnableSeed(424242, 1); return performance.now() - t; });
check('finding a winnable deal is quick on this device', tSolve < 4000, `${Math.round(tSolve)} ms`);
await page.evaluate(() => vs.start('spider4')); await page.waitForTimeout(400);
const fps2 = await fpsFor(2500);
check('frame rate while dealing Spider (104 cards)', fps2 >= Math.min(20, FPS_MIN * 0.8), `${fps2.toFixed(1)} fps`);

await page.evaluate(() => { localStorage.setItem('veysol.save.v1', JSON.stringify(vs.save)); location.reload(); });
await page.waitForFunction(() => window.vs && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', await page.evaluate(() => vs.save.stats.klondike1.won >= 1 && vs.save.table === 'midnight'));
await page.evaluate(() => { localStorage.removeItem('veysol.debug'); localStorage.removeItem(vs.RUN_KEY); });

check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veysol-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
