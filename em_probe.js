const { chromium } = require('playwright');
(async() => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'});
  const interesting = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (/quote|stock|get|push2|api|qt|eastmoney|push/i.test(url)) {
        interesting.push({url, status: resp.status(), ct: resp.headers()['content-type'] || ''});
      }
    } catch(e) {}
  });
  console.log('goto start');
  await page.goto('https://quote.eastmoney.com/sh600519.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('goto done');
  await page.waitForTimeout(8000);
  const title = await page.title();
  const bodyText = await page.locator('body').innerText().catch(()=> '');
  console.log('TITLE', title);
  console.log('BODY_SNIPPET_START');
  console.log(bodyText.slice(0, 2000));
  console.log('BODY_SNIPPET_END');
  console.log('RESPONSES_START');
  for (const item of interesting.slice(0, 200)) console.log(JSON.stringify(item));
  console.log('RESPONSES_END');
  await browser.close();
})();
