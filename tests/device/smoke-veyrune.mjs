// Plays veyrune inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veyrune.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veyrune.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veyrune-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veyrune')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veyrune page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// real input: touch on Android, mouse on Windows / browser
const tap = async (x, y) => (page.tapAt ? page.tapAt(x, y) : page.mouse.click(x, y));
const swipe = async (x, y, dx, dy) => {
  if (page.swipe) return page.swipe(x, y, dx, dy);
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  await page.mouse.up();
};
const settle = async (ms = 12000) => { await page.waitForTimeout(150); await page.waitForFunction(() => !vr.busy, null, { timeout: ms }).catch(() => {}); await page.waitForTimeout(150); };
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);

// enable the test hook and start from a clean save
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veyrune.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vr && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot);
await page.evaluate(() => { vr.save.settings.music = false; vr.save.settings.hints = false; });
await page.waitForTimeout(600);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veyrune');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));

// levels list, then level 1 through the menus
await page.click('[data-act=levels]'); await page.waitForTimeout(200);
check('level list shows 12 levels, only the first open', await page.evaluate(() => document.querySelectorAll('.lv').length === 12 && document.querySelectorAll('.lv.locked').length === 11));
await page.click('[data-act=intro][data-arg="0"]'); await page.waitForTimeout(200);
check('level card shows the goal and moves', await page.evaluate(() => !!document.querySelector('.goal-row') && /moves/.test(document.querySelector('.modal-screen').textContent)));
await page.click('[data-act=play][data-arg="0"]');
await settle();
check('level starts', await page.evaluate(() => !!vr.board && vr.def.index === 0 && !document.getElementById('hud').classList.contains('hidden')));
await shot(page, '2-level');

// a real swipe on the screen
const swipeMove = async () => {
  const m = await page.evaluate(() => { const [a, b] = vr.board.findMoves()[0]; return { a, b, pa: vr.cellCenter(a.x, a.y), pb: vr.cellCenter(b.x, b.y), moves: vr.board.movesLeft }; });
  await swipe(m.pa.x, m.pa.y, m.pb.x - m.pa.x, m.pb.y - m.pa.y);
  await settle();
  return m;
};
let m0 = await swipeMove();
let st = await page.evaluate(() => ({ moves: vr.board.movesLeft, score: vr.board.score }));
check('swiping a rune swaps it and scores', st.moves === m0.moves - 1 && st.score > 0, JSON.stringify(st));
// tap one rune, then its neighbour
const mt = await page.evaluate(() => { const [a, b] = vr.board.findMoves()[0]; return { pa: vr.cellCenter(a.x, a.y), pb: vr.cellCenter(b.x, b.y), moves: vr.board.movesLeft }; });
await tap(mt.pa.x, mt.pa.y); await page.waitForTimeout(120); await tap(mt.pb.x, mt.pb.y);
await settle();
check('tap, tap also swaps', (await page.evaluate(() => vr.board.movesLeft)) === mt.moves - 1);
// a swap that makes no match goes back and costs nothing
const bad = await page.evaluate(() => {
  const B = vr.board, good = new Set(B.findMoves().map(([a, b]) => `${a.x},${a.y},${b.x},${b.y}`));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 7; x++) { const a = B.at(x, y), b = B.at(x + 1, y); if (a && b && a.kind === 'n' && b.kind === 'n' && !good.has(`${x},${y},${x + 1},${y}`)) return { pa: vr.cellCenter(x, y), pb: vr.cellCenter(x + 1, y), moves: B.movesLeft }; }
  return null;
});
if (bad) { await swipe(bad.pa.x, bad.pa.y, bad.pb.x - bad.pa.x, 0); await settle(); }
check('a swap without a match goes back, no move used', !bad || (await page.evaluate(() => vr.board.movesLeft)) === bad.moves);

// frame rate while runes fall and explode
const fpsIdle = await fpsFor(2000);
check('frame rate', fpsIdle >= FPS_MIN, `${fpsIdle.toFixed(1)} fps (quality ${await page.evaluate(() => vr.quality)}, dpr ${await page.evaluate(() => vr.dpr)})`);
// special runes: a burst and a line swapped together, then two prisms (clears the whole board)
await page.evaluate(() => { const B = vr.board; B.movesLeft = 30; const a = B.at(3, 4), b = B.at(4, 4); a.kind = 'b'; b.kind = 'h'; vr.view.reset(B); });
await settle();
const busyFps = page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 2500 ? requestAnimationFrame(f) : res(n / 2.5); }; requestAnimationFrame(f); }));
const sc0 = await page.evaluate(() => vr.board.score);
await page.evaluate(() => vr.trySwap({ x: 3, y: 4 }, { x: 4, y: 4 }));
await page.waitForTimeout(400); await shot(page, '3-combo');
await settle();
const sc1 = await page.evaluate(() => vr.board.score);
check('special runes combo clears a big area', sc1 - sc0 >= 600, `+${sc1 - sc0} points`);
await page.evaluate(() => { const B = vr.board; const a = B.at(2, 5), b = B.at(2, 6); a.kind = 'p'; a.color = -1; b.kind = 'p'; b.color = -1; vr.view.reset(B); });
await settle();
await page.evaluate(() => vr.trySwap({ x: 2, y: 5 }, { x: 2, y: 6 }));
await page.waitForTimeout(300); await shot(page, '4-prism');
const fpsBusy = await busyFps;
await settle();
check('two prisms clear the board', (await page.evaluate(() => vr.board.score)) - sc1 >= 1500);
check('frame rate during big combos', fpsBusy >= Math.min(20, FPS_MIN * 0.7), `${fpsBusy.toFixed(1)} fps`);
check('board is full and still after cascades', await page.evaluate(() => { const B = vr.board; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (B.mask[y][x] && !B.grid[y][x]) return false; return B.findGroups().length === 0 && B.findMoves().length > 0; }));

// winning: the bot finishes level 1, the game plays the rune rush and shows the stars
await page.evaluate(() => { vr.board.movesLeft = 25; });
const r1 = await page.evaluate(() => botRune());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 40000 }).catch(() => {});
await shot(page, '5-won');
check('winning shows stars and Next level', r1.won && await page.evaluate(() => !!document.querySelector('.results.win .big-stars') && !!document.querySelector('[data-act=next]')), JSON.stringify(r1));
check('stars are saved', (await page.evaluate(() => vr.save.stars[0] || 0)) > 0);

// out of moves: 5 free moves once, then the result
await page.click('[data-act=next]'); await settle();
await page.evaluate(() => { vr.board.movesLeft = 1; });
await page.evaluate(() => vr.trySwap(...vr.board.findMoves()[0]));
await page.waitForFunction(() => !!document.querySelector('[data-act=extra]'), null, { timeout: 15000 }).catch(() => {});
check('out of moves offers 5 free moves', await page.evaluate(() => !!document.querySelector('[data-act=extra]')));
await shot(page, '6-out-of-moves');
await page.click('[data-act=extra]'); await page.waitForTimeout(300);
check('+5 moves continues the level', (await page.evaluate(() => vr.board && vr.board.movesLeft)) === 5);
await page.evaluate(() => { vr.board.movesLeft = 1; });
await settle();
await page.evaluate(() => vr.trySwap(...vr.board.findMoves()[0]));
await page.waitForFunction(() => !!document.querySelector('[data-act=give-up]'), null, { timeout: 15000 }).catch(() => {});
check('free moves only once per try', await page.evaluate(() => !document.querySelector('[data-act=extra]') && !!document.querySelector('[data-act=give-up]')));
await page.click('[data-act=give-up]'); await page.waitForTimeout(300);
check('losing shows Try again', await page.evaluate(() => !!document.querySelector('.results') && !!document.querySelector('[data-act=restart]')));

// leaving mid-level: the menu offers to continue with the same board
await page.click('[data-act=restart]'); await settle();
await page.evaluate(() => vr.trySwap(...vr.board.findMoves()[0])); await settle();
const before = await page.evaluate(() => ({ moves: vr.board.movesLeft, score: vr.board.score, first: vr.board.grid[7][3]?.color }));
await page.click('#pause-btn'); await page.waitForTimeout(150); await page.click('[data-act=quit]'); await page.waitForTimeout(300);
check('menu offers Continue after leaving a level', (await page.locator('[data-act=resume-saved]').count()) === 1);
await page.click('[data-act=resume-saved]'); await settle();
const after = await page.evaluate(() => ({ moves: vr.board.movesLeft, score: vr.board.score, first: vr.board.grid[7][3]?.color }));
check('continue brings the same board back', JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
await page.click('#pause-btn'); await page.waitForTimeout(150); await page.click('[data-act=quit]'); await page.waitForTimeout(300);

// daily rune
await page.click('[data-act=daily]'); await settle();
const rd = await page.evaluate(() => botRune());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 40000 }).catch(() => {});
check('daily rune plays to the end and saves the best score', await page.evaluate(() => /Daily rune/.test(document.querySelector('.results h2').textContent) && vr.save.daily.best > 0), `score ${rd.score}`);
await shot(page, '7-daily');

// whole levels, played by the bot (a good player who takes the free moves)
const levels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17, 23, 29, 35, 41, 47, 53, 59];
let wins = 0;
for (const i of levels) {
  const r = await page.evaluate((i) => { vr.save.settings.sound = false; vr.ui.close(); vr.start(i); return botRune(); }, i);
  if (r.won) wins++;
  check(`level ${i + 1}`, true, `won=${r.won} score=${r.score} moves=${r.moves} extra=${r.extra} left=${r.goals.join(',')}`);
  await page.waitForFunction(() => !!document.querySelector('.results') || !!document.querySelector('[data-act=give-up]'), null, { timeout: 40000 }).catch(() => {});
}
check('the bot wins most levels', wins >= levels.length * 0.75, `${wins}/${levels.length}`);

// save survives a restart of the page
await page.evaluate(() => { vr.save.stars = { 0: 3, 1: 2 }; localStorage.setItem('veyrune.save.v1', JSON.stringify(vr.save)); location.reload(); });
await page.waitForFunction(() => window.vr && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', (await page.evaluate(() => vr.save.stars[1])) === 2);
await page.evaluate(() => { localStorage.removeItem('veyrune.debug'); localStorage.removeItem('veyrune.run.v1'); });

check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veyrune-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
