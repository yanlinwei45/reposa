const { chromium } = require('playwright');
(async() => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'});
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (url.includes('/api/qt/stock/get')) {
        console.log('TARGET_URL', url);
        const text = await resp.text();
        console.log('TARGET_BODY_START');
        console.log(text.slice(0, 4000));
        console.log('TARGET_BODY_END');
      }
    } catch(e) { console.error(String(e)); }
  });
  await page.goto('https://quote.eastmoney.com/sh600519.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await browser.close();
})();
