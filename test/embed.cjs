const { chromium } = require('playwright');
const B = 'http://localhost:8799';
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const outer = await ctx.newPage(); const heights = []; const msgs = [];
  outer.on('console', (m) => msgs.push(m.type() + ' ' + m.text())); outer.on('requestfailed', (r) => msgs.push('FAILED ' + r.url() + ' ' + r.failure().errorText));
  await outer.exposeFunction('onH', (h) => heights.push(h));
  await outer.route('http://localhost:8800/', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div style="height:300px">Homepage</div><iframe id="f" src="' + B + '/?lang=en" style="width:100%;border:0;height:200px" scrolling="no"></iframe><script>addEventListener("message",e=>{if(e.data&&e.data.type==="n3-games-height"){document.getElementById("f").style.height=e.data.height+"px";onH(e.data.height)}})</script></body></html>' }));
  await outer.goto('http://localhost:8800/'); await outer.waitForTimeout(2500);
  console.log('frames', outer.frames().map((f) => f.url()), 'heights', heights.slice(0, 5)); console.log(msgs.slice(0, 8));
  await b.close();
})();
