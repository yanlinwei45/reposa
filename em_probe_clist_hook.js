const { chromium } = require('playwright');

(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  page.on('console', msg => console.log('PAGELOG', msg.text()));

  await page.addInitScript(() => {
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = String(args[0] && args[0].url ? args[0].url : args[0]);
      try {
        const resp = await origFetch(...args);
        if (/push2\.eastmoney\.com\/api\/qt\/clist\/get/i.test(url)) {
          const text = await resp.clone().text().catch(() => '[[clone text failed]]');
          console.log('HOOK_FETCH_CLIST', JSON.stringify({ url, ok: resp.ok, status: resp.status, text: text.slice(0, 1000) }));
        }
        return resp;
      } catch (e) {
        if (/push2\.eastmoney\.com\/api\/qt\/clist\/get/i.test(url)) {
          console.log('HOOK_FETCH_CLIST_ERR', JSON.stringify({ url, error: String(e) }));
        }
        throw e;
      }
    };

    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__url = url;
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('loadend', function() {
        try {
          const url = String(this.__url || '');
          if (/push2\.eastmoney\.com\/api\/qt\/clist\/get/i.test(url)) {
            console.log('HOOK_XHR_CLIST', JSON.stringify({ url, status: this.status, text: String(this.responseText || '').slice(0, 1000) }));
          }
        } catch (e) {}
      });
      return send.call(this, ...args);
    };
  });

  await page.goto('https://quote.eastmoney.com/center/gridlist.html#hs_a_board', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  await browser.close();
})();
