const { chromium } = require('playwright');
const fs = require('fs');

(async() => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'zh-CN'
  });
  const page = await context.newPage();

  let captured = null;

  page.on('request', async (req) => {
    try {
      const url = req.url();
      if (!captured && /push2\.eastmoney\.com\/api\/qt\/clist\/get/i.test(url)) {
        const headers = await req.allHeaders();
        const cookies = await context.cookies();
        captured = {
          url,
          method: req.method(),
          headers,
          cookies,
          pageUrl: page.url()
        };
        fs.writeFileSync('logs/em_clist_capture.json', JSON.stringify(captured, null, 2));
        console.log('CAPTURED', url);
      }
    } catch (e) {}
  });

  await page.goto('https://quote.eastmoney.com/center/gridlist.html#hs_a_board', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  if (!captured) {
    console.log('NO_CAPTURE');
  } else {
    console.log('SAVED logs/em_clist_capture.json');
  }
  await browser.close();
})();
