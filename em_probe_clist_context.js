const { chromium } = require('playwright');

function short(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (/cookie/i.test(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

(async() => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'zh-CN'
  });
  const page = await context.newPage();

  const hits = [];

  page.on('request', async (req) => {
    try {
      const url = req.url();
      if (/push2\.eastmoney\.com\/api\/qt\/(clist|get|slist)/i.test(url)) {
        const headers = await req.allHeaders();
        hits.push({
          type: 'request',
          url,
          method: req.method(),
          headers: short(headers)
        });
        console.log('REQ', url);
      }
    } catch (e) {}
  });

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (/push2\.eastmoney\.com\/api\/qt\/(clist|get|slist)/i.test(url)) {
        const headers = await resp.request().allHeaders();
        let body = '';
        try { body = await resp.text(); } catch (_) {}
        hits.push({
          type: 'response',
          url,
          status: resp.status(),
          reqHeaders: short(headers),
          bodyStart: String(body).slice(0, 1500)
        });
        console.log('RESP', resp.status(), url);
        console.log('BODY_START');
        console.log(String(body).slice(0, 800));
        console.log('BODY_END');
      }
    } catch (e) {}
  });

  const target = 'https://quote.eastmoney.com/center/gridlist.html#hs_a_board';
  console.log('GOTO', target);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);

  const cookies = await context.cookies();
  console.log('COOKIES', cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path })).slice(0, 20));

  const candidate = hits.find(x => x.url.includes('/api/qt/clist/get'));
  if (candidate) {
    console.log('FOUND_CLIST', candidate.url);
    const result = await page.evaluate(async ({ url }) => {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'x-requested-with': 'XMLHttpRequest'
          }
        });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, text: text.slice(0, 2000) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, { url: candidate.url });
    console.log('REPLAY_RESULT_START');
    console.log(JSON.stringify(result, null, 2));
    console.log('REPLAY_RESULT_END');
  } else {
    console.log('NO_CLIST_CAPTURED');
    const fallbackUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:13,m:1+t:2,m:1+t:23&fields=f2,f3,f4,f5,f6,f7,f8,f10,f12,f14,f15,f16,f17,f18,f20,f21,f22,f23,f24,f25,f26,f27,f28,f29,f30,f31,f32,f33,f34,f35,f36,f37,f38,f39,f40,f41,f42,f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f59,f60,f61,f62,f63,f64,f65,f66,f67,f68,f69,f70,f71,f72,f73,f74,f75,f76,f77,f78,f79,f80,f81,f82,f83,f84,f85,f86,f87,f88,f89,f90,f91,f92,f93';
    const result = await page.evaluate(async ({ url }) => {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'x-requested-with': 'XMLHttpRequest'
          }
        });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, text: text.slice(0, 2000) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, { url: fallbackUrl });
    console.log('FALLBACK_RESULT_START');
    console.log(JSON.stringify(result, null, 2));
    console.log('FALLBACK_RESULT_END');
  }

  await browser.close();
})();
