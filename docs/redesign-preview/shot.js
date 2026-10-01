const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
const p=await b.newPage({deviceScaleFactor:2,viewport:{width:1800,height:1000}});
await p.goto('file://'+__dirname+'/mock.html');
const w=await p.$$('.wrap');
for(let i=0;i<w.length;i++) await w[i].screenshot({path:`screen-${i}.png`});
await p.screenshot({path:'overview.png',fullPage:true});
await b.close()})();
