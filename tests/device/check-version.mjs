// Prints the version of the game running in an app (Android WebView via the lite connection).
// Usage: node check-version.mjs lite:http://127.0.0.1:9222
import { connectLite } from './cdp-lite.mjs';
const page = await connectLite(process.argv[2].slice(5));
let v = null, u = null;
for (let i = 0; i < 20 && !v; i++) { try { v = await page.evaluate(() => window.__vmVersion || null); u = await page.evaluate(() => window.__vmUpdate || null); } catch { /* page loading */ } if (!v) await new Promise((r) => setTimeout(r, 1000)); }
console.log(`version=${v} update=${u}`);
page.close(); process.exit(0);
