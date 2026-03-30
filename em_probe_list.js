const { chromium } = require('playwright');
(async() => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'});
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (/push2\.eastmoney\.com\/api\/qt\/(clist|get|slist)/i.test(url)) {
        console.log('URL', url);
      }
    } catch(e) {}
  });
  await page.goto('https://quote.eastmoney.com/center/gridlist.html#hs_a_board', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  await browser.close();
})();
