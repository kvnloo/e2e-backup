/**
 * Real browser screenshots for the equivalence suite and the benchmarks: an
 * app-like page in headless Chromium, at the sizes e2e handles every step (a
 * 1280 by 720 viewport at 2x, a phone at 3x), and variants of it a
 * comparison has to tell apart: one word changed, a block moved one pixel,
 * translucent overlays. Rendered once and kept in `.cache/` (gitignored).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

/** One screenshot, and what it shows. */
export interface Screenshot {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const CACHE = path.join(import.meta.dirname, '..', '.cache', 'screenshots');

/** An app screen with text at several sizes, form controls, a table, gradients, shadows, and an inline SVG chart. */
function page(variant: 'base' | 'word' | 'moved' | 'overlay'): string {
  const rows = Array.from({ length: 14 }, (_, at) => `<tr><td>#${1040 + at}</td><td>Order for customer ${['Ada', 'Grace', 'Linus', 'Ken', 'Barbara'][at % 5]}</td><td>${(at * 37.5 + 12).toFixed(2)} EUR</td><td><span class="pill p${at % 3}">${['paid', 'pending', 'refunded'][at % 3]}</span></td></tr>`).join('');
  const bars = Array.from({ length: 24 }, (_, at) => `<rect x="${at * 14}" y="${120 - ((at * 53) % 100)}" width="10" height="${(at * 53) % 100}" rx="2" fill="hsl(${200 + at * 4} 70% 55%)"/>`).join('');
  return `<!doctype html><html><head><style>
    body { margin: 0; font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1d2330; background: #f4f6fb; }
    header { height: 56px; display: flex; align-items: center; gap: 24px; padding: 0 24px; background: linear-gradient(90deg, #1b2a4a, #3b5b9a); color: white; }
    header b { font-size: 18px; } header a { color: #dce6ff; text-decoration: none; }
    main { display: grid; grid-template-columns: 240px 1fr; gap: 20px; padding: 20px; }
    nav, section { background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(30,40,80,.06); padding: 16px; }
    nav li { list-style: none; padding: 6px 8px; border-radius: 6px; } nav li.on { background: #e8eeff; color: #2847a8; font-weight: 600; }
    h1 { font-size: 22px; margin: 0 0 12px; } h2 { font-size: 15px; margin: 16px 0 8px; color: #59607a; }
    form { display: flex; gap: 10px; ${variant === 'moved' ? 'margin-left: 1px;' : ''} }
    input { flex: 1; padding: 8px 10px; border: 1px solid #c9cfdf; border-radius: 6px; font: inherit; }
    button { padding: 8px 14px; border: 0; border-radius: 6px; background: #2f5bd8; color: white; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; } td { padding: 6px 8px; border-bottom: 1px solid #eef0f5; }
    .pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; } .p0 { background: #e3f6e8; color: #1c7a3a; } .p1 { background: #fff4d6; color: #8a6100; } .p2 { background: #fde7e7; color: #a12a2a; }
    .overlay { position: fixed; right: 32px; bottom: 32px; width: 320px; padding: 16px; border-radius: 12px; background: rgba(20,30,60,.72); color: white; backdrop-filter: blur(6px); }
  </style></head><body>
    <header><b>Acme Console</b><a href="#">Dashboard</a><a href="#">Orders</a><a href="#">Customers</a><a href="#">Settings</a></header>
    <main>
      <nav><ul style="margin:0;padding:0"><li class="on">Overview</li><li>Orders</li><li>Invoices</li><li>Shipping</li><li>Reports</li><li>Team</li></ul></nav>
      <section>
        <h1>Orders ${variant === 'word' ? 'overview' : 'summary'}</h1>
        <form><input placeholder="Search orders, customers, or invoices" value="refund 1043"><button>Search</button></form>
        <h2>Revenue, last 24 hours</h2>
        <svg width="340" height="130" viewBox="0 0 340 130">${bars}</svg>
        <h2>Recent orders</h2>
        <table>${rows}</table>
        <p style="color:#6b7186">Showing 14 of 1,284 orders. Totals include tax; refunds settle within 5 business days. ✓ Synced 2 minutes ago.</p>
      </section>
    </main>
    ${variant === 'overlay' ? '<div class="overlay"><b>Export ready</b><br>orders-2026-11.csv, 1,284 rows</div>' : ''}
  </body></html>`;
}

/** The screenshots, rendered on first use. */
export async function screenshots(): Promise<readonly Screenshot[]> {
  const shots = [
    { name: 'desktop-2560x1440', variant: 'base', viewport: { width: 1280, height: 720 }, scale: 2 },
    { name: 'desktop-2560x1440-word', variant: 'word', viewport: { width: 1280, height: 720 }, scale: 2 },
    { name: 'desktop-2560x1440-moved', variant: 'moved', viewport: { width: 1280, height: 720 }, scale: 2 },
    { name: 'desktop-2560x1440-overlay', variant: 'overlay', viewport: { width: 1280, height: 720 }, scale: 2 },
    { name: 'desktop-1280x720', variant: 'base', viewport: { width: 1280, height: 720 }, scale: 1 },
    { name: 'desktop-1280x720-word', variant: 'word', viewport: { width: 1280, height: 720 }, scale: 1 },
    { name: 'phone-1170x2532', variant: 'base', viewport: { width: 390, height: 844 }, scale: 3 },
    { name: 'phone-1170x2532-overlay', variant: 'overlay', viewport: { width: 390, height: 844 }, scale: 3 },
  ] as const;
  const missing = shots.filter((shot) => !existsSync(path.join(CACHE, `${shot.name}.png`)));
  if (missing.length > 0) {
    mkdirSync(CACHE, { recursive: true });
    const browser = await chromium.launch();
    try {
      for (const shot of missing) {
        const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: shot.scale });
        const tab = await context.newPage();
        await tab.setContent(page(shot.variant));
        writeFileSync(path.join(CACHE, `${shot.name}.png`), await tab.screenshot());
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
  return shots.map((shot) => ({ name: shot.name, bytes: new Uint8Array(readFileSync(path.join(CACHE, `${shot.name}.png`))) }));
}
