const {chromium}=require('playwright');
(async()=>{
 const b=await chromium.launch();
 const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});
 const p=await ctx.newPage();p.setDefaultTimeout(8000);
 p.on('pageerror',e=>console.log('E:',e.message.slice(0,200)));
 await p.goto('http://localhost:8000/mobile-app/index.html');await p.waitForTimeout(3000);
 // Home: From / To
 await p.getByPlaceholder('Station name or code').first().click();
 await p.keyboard.type('Vij',{delay:80});await p.waitForTimeout(1500);
 await p.screenshot({path:'1-home-from-vij.png'});
 await p.getByText('Vijayawada Jn',{exact:true}).first().click().catch(()=>console.log('no pick'));
 await p.waitForTimeout(500);
 await p.getByPlaceholder('Station name or code').nth(1).click();
 await p.keyboard.type('Hyd',{delay:80});await p.waitForTimeout(1500);
 await p.screenshot({path:'2-home-to-hyd.png'});
 // Live tracking
 await p.getByText('Live Tracking',{exact:true}).last().click();await p.waitForTimeout(1500);
 const inp=p.getByPlaceholder(/Type a number/);
 await inp.click();await p.keyboard.type('17',{delay:80});await p.waitForTimeout(1500);
 await p.screenshot({path:'3-live-17.png'});
 await p.keyboard.type('2',{delay:80});await p.waitForTimeout(1200);
 await p.screenshot({path:'4-live-172.png'});
 await inp.fill('');await p.keyboard.type('12706',{delay:80});await p.waitForTimeout(1500);
 await p.screenshot({path:'5-live-12706.png'});
 await inp.fill('');await p.keyboard.type('99999',{delay:80});await p.waitForTimeout(1500);
 await p.screenshot({path:'6-live-99999.png'});
 await b.close();process.exit(0);
})();
