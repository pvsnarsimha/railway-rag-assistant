const {chromium}=require('playwright');
const mons=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pad=n=>String(n).padStart(2,'0');
const T=(off)=>{const d=new Date(Date.now()+off*60000);return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}-${mons[d.getMonth()]}`};
const defs=[['SC','Secunderabad Jn',-400,0,'passed'],['KZJ','Kazipet Jn',-330,5,'passed'],['KMT','Khammam',-250,9,'passed'],['BZA','Vijayawada Jn',-150,12,'passed'],['EE','Eluru',-60,15,'passed'],['RJY','Rajahmundry',-5,18,'current'],['SLO','Samalkot Jn',20,18,'upcoming'],['AKP','Anakapalle',100,18,'upcoming'],['VSKP','Visakhapatnam',150,18,'upcoming']];
const timeline=defs.map(([code,name,off,d,status],i)=>({code,name,status,kind:'halt',distance_km:[0,132,222,350,410,490,520,610,650][i],halt_minutes:2,
 arrival:{scheduled:T(off-d),expected:T(off),actual:status==='upcoming'?null:T(off),delay_minutes:d,actual_is_predicted:false},
 departure:{scheduled:T(off-d+2),expected:T(off+2),actual:status==='passed'?T(off+2):null,delay_minutes:d,actual_is_predicted:false}}));
const payload={train_number:'12706',train_name:'Simhapuri Express',timeline,current_station:'Rajahmundry',next_station:'Samalkot Jn',lat:17.0,lng:81.8,
 delay_minutes:18,current_delay_minutes:18,display_speed_kmph:68,instant_speed_kmph:68,avg_speed_kmph:62,distance_remaining_to_next_km:12,eta_to_next_minutes:14,
 status_updated_at:new Date().toISOString(),live_source:'railradar',position_source:'live',direction:'UP',source_station:'SC',destination_station:'VSKP'};
(async()=>{
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'}).catch(()=>chromium.launch());
 const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
 const p=await ctx.newPage();p.setDefaultTimeout(8000);
 await p.routeWebSocket(/\/ws\/track\//,ws=>{ws.send(JSON.stringify(payload));});
 await p.route(/:8000\/(?!ws)/,r=>r.fulfill({status:200,contentType:'application/json',body:'{"found":true,"minutes_remaining":150,"delay_minutes":18,"watches":[],"alerts":[]}'}));
 console.log('goto');await p.goto('http://localhost:8098/mobile-app/index.html');console.log('loaded');
 await p.waitForTimeout(3000);
 await p.getByText('Live Tracking',{exact:true}).last().click().catch(()=>{});
 await p.waitForTimeout(1500);
 await p.screenshot({path:'0-initial.png'});
 await p.getByPlaceholder(/12709/).fill('12706').catch(e=>console.log('no train input'));
 await p.getByPlaceholder(/VSKP/).fill('VSKP').catch(()=>{});
 await p.waitForTimeout(500);
 await p.screenshot({path:'0b-initial-filled.png'});
 await p.getByText('Start tracking',{exact:true}).click().catch(e=>console.log('no start'));
 await p.waitForTimeout(4000);
 await p.evaluate(()=>{document.querySelectorAll('*').forEach(e=>{if(e.scrollTop>0)e.scrollTop=0})});await p.waitForTimeout(600);await p.screenshot({path:'1-live-top.png'});
 await p.mouse.move(200,500);await p.mouse.wheel(0,560);await p.waitForTimeout(800);
 await p.screenshot({path:'2-live-scrolled.png'});
 await p.mouse.wheel(0,800);await p.waitForTimeout(800);
 await p.screenshot({path:'3-live-timeline.png'});
 await b.close();process.exit(0);
})();
