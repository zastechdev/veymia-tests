// Plays veyword inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veyword.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const bot = readFileSync(new URL('./bot-veyword.js', import.meta.url), 'utf8');
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veyword-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veyword')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veyword page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);
// a real swipe: press on the first letter, move through the others, let go
const swipe = async (word) => {
  const pts = await page.evaluate((w) => vw.pathFor(w), word);
  if (!pts) return false;
  if (page.swipePath) { await page.swipePath(pts); await page.waitForTimeout(150); return true; }
  await page.mouse.move(pts[0].x, pts[0].y); await page.mouse.down();
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; for (let k = 1; k <= 4; k++) await page.mouse.move(a.x + (b.x - a.x) * k / 4, a.y + (b.y - a.y) * k / 4); }
  await page.mouse.up(); await page.waitForTimeout(120); return true;
};
const st = () => page.evaluate(() => ({ found: vw.run ? vw.run.found.size : -1, bonus: vw.run ? vw.run.bonus.size : -1, coins: vw.save.coins, jar: vw.save.jar, left: vw.run ? vw.run.left() : -1 }));

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veyword.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vw && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(bot); await page.evaluate(async () => { vw.save.settings.music = false; await vw.dictReady; });
await page.waitForTimeout(400);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veyword');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));
check('word list loaded (bonus words)', await page.evaluate(() => vw.hasDictionary()));
await page.click('[data-act=chapters]'); await page.waitForTimeout(150);
check('chapters: 15, only the first open', await page.evaluate(() => document.querySelectorAll('.chap').length === 15 && document.querySelectorAll('.chap.locked').length === 14));
await page.click('[data-act=chapter][data-arg="0"]'); await page.waitForTimeout(150);
await page.click('[data-act=play][data-arg="0"]'); await page.waitForTimeout(500);
check('level 1 starts with 3 words', (await st()).left === 3);
await shot(page, '2-level1');
const w1 = await page.evaluate(() => vw.run.slots[0].word);
await swipe(w1); await page.waitForTimeout(200);
check('swiping a crossword word fills it in', (await st()).found === 1, w1);
await swipe(w1); await page.waitForTimeout(200);
check('the same word again changes nothing', (await st()).found === 1);
const junk = await page.evaluate(() => { const l = vw.run.letters; return l[0] + l[1]; });
await swipe(junk);
check('a 2-letter swipe is ignored', (await st()).found === 1);
// keyboard
const w2 = await page.evaluate(() => vw.run.slots.find((s) => !vw.run.found.has(s.word)).word);
await page.keyboard.type(w2); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
check('typing a word works on a computer', (await st()).found === 2, w2);
// shuffle keeps the same letters
const l0 = await page.evaluate(() => [...vw.run.letters].sort().join(''));
await page.click('#shuffle-btn'); await page.waitForTimeout(200);
check('shuffle keeps the same letters', await page.evaluate((l0) => [...vw.run.letters].sort().join('') === l0, l0));
// hint costs coins
const c0 = (await st()).coins;
await page.click('#hint-btn'); await page.waitForTimeout(200);
const afterHint = await st();
check('letter hint shows a letter and costs 20 coins', afterHint.coins === c0 - 20, `${c0} -> ${afterHint.coins}`);
// continue later
await page.click('[data-act=pause]'); await page.waitForTimeout(100); await page.click('#ui [data-act=menu]'); await page.waitForTimeout(200);
check('menu offers Continue', (await page.locator('[data-act=resume]').count()) === 1);
await page.click('[data-act=resume]'); await page.waitForTimeout(300);
check('continue brings the same progress back', (await st()).found >= 2);
// finish level 1 by swiping the rest
for (const w of await page.evaluate(() => vw.run.slots.filter((s) => !vw.run.found.has(s.word)).map((s) => s.word))) await swipe(w);
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 8000 }).catch(() => {});
await shot(page, '3-solved');
check('solving the level shows results and Next level', await page.evaluate(() => !!document.querySelector('.results') && !!document.querySelector('[data-act=next]')));
check('solving earns 10 coins and opens level 2', await page.evaluate((c) => vw.save.level === 1 && vw.save.coins === c + 10, afterHint.coins));
// bonus words fill the jar
await page.click('[data-act=next]'); await page.waitForTimeout(300);
await page.evaluate(() => vw.start(40, '')); await page.waitForTimeout(200);
const extra = await page.evaluate(() => { const r = vw.run, grid = new Set(r.slots.map((s) => s.word)), out = new Set(); const L = r.letters;
  const rec = (pre, used) => { if (pre.length >= 3 && !grid.has(pre)) out.add(pre); if (pre.length >= 5) return; L.forEach((c, i) => { if (!used.includes(i)) rec(pre + c, [...used, i]); }); };
  rec('', []); return [...out]; });
let got = 0; const j0 = (await st()).jar;
for (const w of extra.slice(0, 400)) { const isBonus = await page.evaluate((w) => { const r = vw.run, b = r.bonus.size; const res = r.try(w); return res === 'bonus' ? (r.bonus.delete(w), true) : false; }, w); if (isBonus) { await swipe(w); got++; if (got >= 3) break; } }
const sb = await st();
check('real extra words go into the bonus jar', got >= 1 && sb.bonus === got && sb.jar === j0 + got, `${got} bonus words, jar ${sb.jar}`);
const fps = await fpsFor(2500);
check('frame rate', fps >= FPS_MIN, `${fps.toFixed(1)} fps`);
await shot(page, '4-bonus');
// jar pays out at 10
await page.evaluate(() => { vw.save.jar = 9; });
const c1 = (await st()).coins;
const more = await page.evaluate(() => { const r = vw.run, grid = new Set(r.slots.map((s) => s.word)), L = r.letters, out = new Set(); const rec = (pre, used) => { if (pre.length >= 3 && !grid.has(pre)) out.add(pre); if (pre.length >= 6) return; L.forEach((c, i) => { if (!used.includes(i)) rec(pre + c, [...used, i]); }); }; rec('', []); for (const w of out) { if (r.bonus.has(w)) continue; const res = r.try(w); if (res === 'bonus') { r.bonus.delete(w); return w; } } return null; });
if (more) await swipe(more);
check('a full jar pays 30 coins', more && await page.evaluate((c) => vw.save.coins === c + 30 && vw.save.jar === 0, c1), more);
// word hint
const c2 = (await st()).coins, l2 = (await st()).left;
await page.click('#word-btn'); await page.waitForTimeout(200);
check('word hint shows a whole word for 50 coins', await page.evaluate(([c, l]) => vw.save.coins === c - 50 && vw.run.left() === l - 1, [c2, l2]));
// daily
await page.evaluate(() => { vw.ui.close(); vw.start(-1, vw.dayKey()); }); await page.waitForTimeout(200);
const d1 = await page.evaluate(() => vw.run.p.l);
await page.evaluate(() => vw.start(-1, vw.dayKey())); 
check('daily puzzle is the same all day', await page.evaluate((d) => vw.run.p.l === d || [...vw.run.p.l].sort().join('') === [...d].sort().join(''), d1));
await page.evaluate(() => botWord());
await page.waitForFunction(() => !!document.querySelector('.results'), null, { timeout: 8000 }).catch(() => {});
check('daily puzzle pays 50 coins and starts a streak', await page.evaluate(() => vw.save.daily.streak === 1 && /Daily/.test(document.querySelector('.results h2').textContent)));
// every 25th level can be solved
let solved = 0; for (let i = 0; i < 300; i += 25) { const r = await page.evaluate((i) => { vw.ui.close(); vw.start(i, ''); return botWord(); }, i); if (r.won) solved++; await page.waitForTimeout(40); }
check('levels across all chapters can be solved', solved === 12, `${solved}/12`);
await page.evaluate(() => { vw.ui.close(); vw.start(290, ''); }); await page.waitForTimeout(600);
const fps2 = await fpsFor(2500); await shot(page, '5-late');
check('frame rate on a late level', fps2 >= FPS_MIN, `${fps2.toFixed(1)} fps`);
await page.evaluate(() => { localStorage.setItem('veyword.save.v1', JSON.stringify(vw.save)); location.reload(); });
await page.waitForFunction(() => window.vw && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', await page.evaluate(() => vw.save.level >= 1 && vw.save.daily.streak === 1 && vw.save.bonusTotal >= 1));
await page.evaluate(() => { localStorage.removeItem('veyword.debug'); });
check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veyword-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
