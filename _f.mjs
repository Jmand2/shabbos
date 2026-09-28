import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const f=(n)=>readFileSync(new URL(`./${n}`,import.meta.url),'utf8');
const dom=new JSDOM(f('index.html'),{runScripts:'outside-only',url:'https://x.test/',pretendToBeVisual:true});
const w=dom.window;
const R=w.Date; class F extends R{constructor(...a){super(...(a.length?a:['2026-09-28T10:00:00-04:00']))}static now(){return new R('2026-09-28T10:00:00-04:00').getTime()}}
w.Date=F;
w.fetch=async(u)=>{const p=String(u).replace(/^.*?(data\/[^?]+).*$/,'$1');return {ok:true,json:async()=>JSON.parse(f(p))};};
w.navigator.wakeLock={request:async()=>({})};
w.eval(f('vendor/kosher-zmanim.min.js'));
w.eval(['util.js','calendar.js','settings.js','minyanim.js','weather.js','sports.js','display.js','app.js'].map(f).join('\n'));
await new Promise(r=>setTimeout(r,250));
console.log('footer:', w.document.getElementById('freshness').textContent.trim());
