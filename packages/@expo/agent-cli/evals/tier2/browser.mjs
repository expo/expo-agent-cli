import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export async function serveExport(directory) {
  const root = resolve(directory);
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await readFile(file);
      const mime = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
      };
      res
        .writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' })
        .end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((accept, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : accept()));
      }),
  };
}

/** Independent rendered/interactive checks: no agent text, export marker, or grader file is trusted. */
export async function checkCart(browser, url, screenshotPath) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(60_000);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (response?.status() !== 200) throw new Error(`HTTP ${response?.status()} at ${url}`);
    await page.getByRole('heading', { name: 'Coffee cart' }).waitFor();
    const total = page.getByTestId('cart-total');
    const assertTotal = async (expected) => {
      await page.waitForFunction(
        (value) => document.querySelector('[data-testid="cart-total"]')?.textContent === value,
        expected
      );
      if ((await total.textContent()) !== expected) throw new Error(`Expected total ${expected}`);
    };
    await assertTotal('$18.00');
    await page.getByRole('button', { name: 'Add Coffee', exact: true }).click();
    await assertTotal('$25.50');
    await page.getByRole('button', { name: 'Add Tea', exact: true }).click();
    await assertTotal('$28.50');
    if (errors.length) throw new Error(`Browser page errors: ${errors.join('; ')}`);
    return { url, totals: ['$18.00', '$25.50', '$28.50'], pageErrors: errors };
  } finally {
    try {
      await page.screenshot({ path: screenshotPath });
    } finally {
      await page.close();
    }
  }
}
