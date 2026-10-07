/**
 * Read-only load check: simulates N visitors opening a checkout page at the same moment.
 * Each visitor loads the page HTML, then the product config (what the browser does).
 * It never calls /api/payment/create, so nothing is charged or stored.
 *
 *   node tests/load.js https://p.example.com my-product-slug 100 500 1000
 */
const [base, slug, ...levels] = process.argv.slice(2);
if (!base || !slug) { console.error('usage: node tests/load.js <baseUrl> <slug> [visitors...]'); process.exit(1); }

const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

async function visitor() {
  const t0 = performance.now();
  try {
    const page = await fetch(`${base}/subscribe/${slug}`, { signal: AbortSignal.timeout(30000) });
    await page.arrayBuffer();
    const cfg = await fetch(`${base}/api/products/slug/${slug}/config`, { signal: AbortSignal.timeout(30000) });
    await cfg.arrayBuffer();
    return { ms: performance.now() - t0, ok: page.status === 200 && cfg.status === 200, status: `${page.status}/${cfg.status}` };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, status: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message) };
  }
}

(async () => {
  for (const n of (levels.length ? levels : ['50']).map(Number)) {
    const t0 = performance.now();
    const res = await Promise.all(Array.from({ length: n }, visitor));
    const total = (performance.now() - t0) / 1000;
    const ok = res.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    const bad = {};
    for (const r of res.filter((x) => !x.ok)) bad[r.status] = (bad[r.status] || 0) + 1;
    console.log(`${String(n).padStart(5)} visitors | ok ${ok.length}/${n} | median ${Math.round(pct(ok, 0.5))}ms | p95 ${Math.round(pct(ok, 0.95))}ms | slowest ${Math.round(ok.at(-1) || 0)}ms | all done in ${total.toFixed(1)}s` + (Object.keys(bad).length ? ` | failures ${JSON.stringify(bad)}` : ''));
    await new Promise((r) => setTimeout(r, 4000));
  }
})();
