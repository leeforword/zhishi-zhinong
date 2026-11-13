import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const PORT=9281;
const CHROME=['C://Program Files\\Google\\Chrome\\Application\\chrome.exe','C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
const dir=path.join(process.env.TEMP||'.','cdp_sh_'+Date.now()); fs.mkdirSync(dir,{recursive:true});
const proc=spawn(CHROME,['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--remote-debugging-port='+PORT,'--user-data-dir='+dir,'--window-size=1600,1200','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function tgt(){for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl;}catch(e){}await sleep(250);}throw new Error('no cdp');}
const ws=new WebSocket(await tgt()); await new Promise(r=>ws.addEventListener('open',r));
let id=0; const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(m,p)=>{const i=++id;ws.send(JSON.stringify({id:i,method:m,params:p||{}}));return new Promise(r=>pend.set(i,r));};
const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return r.result&&r.result.result?r.result.result.value:undefined;};
await send('Page.enable'); await send('Runtime.enable');

async function shot(w,h,dpr,file,scroll){
  await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:dpr,mobile:w<500});
  await send('Page.navigate',{url:'http://127.0.0.1:8945/'});
  for(let i=0;i<60;i++){await sleep(700);const ok=await ev(`document.querySelectorAll('svg.chart').length>0||/暂无合适窗口/.test(document.body.innerText)`);if(ok)break;}
  await sleep(1200);
  if(scroll){await ev('window.scrollTo(0,'+scroll+')');await sleep(700);}
  const r=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(file, Buffer.from(r.result.data,'base64'));
  const st=fs.statSync(file).size;
  console.log('WROTE',file,st);
}
await shot(1600,1200,1,'D:/zhishi-zhinong/web/screenshots/01-desktop-overview.png',0);
await shot(390,844,2,'D:/zhishi-zhinong/web/screenshots/12-mobile-iphone.png',0);
ws.close();proc.kill();process.exit(0);
