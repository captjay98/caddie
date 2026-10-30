import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
const BASE='http://localhost:5176', PROJECT='proj_506d61ece6d7ca3a12fdd9a41a281960';
const token=process.env.SESSION_TOKEN!, secret=process.env.BETTER_AUTH_SECRET!;
const signed=`${token}.${createHmac('sha256',secret).update(token).digest('base64')}`;
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:1280,height:900}});
await ctx.addCookies([{name:'better-auth.session_token',value:signed,domain:'localhost',path:'/'}]);
const page=await ctx.newPage();
await page.goto(`${BASE}/app/preview?project=${PROJECT}`,{waitUntil:'domcontentloaded'});
const dump=async(label:string)=>{
  const out=await page.evaluate(()=>{
    const pick=(sel:string)=>{const n=document.querySelector(sel) as HTMLElement|null; if(!n)return `${sel} absent`;
      const cs=getComputedStyle(n); const r=n.getBoundingClientRect();
      return `${sel}: ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)} | display=${cs.display} cols=${cs.gridTemplateColumns} gap=${cs.gap} width=${cs.width}`;};
    return ['.preview-page','.project-head','.project-head-title','.project-steps-wrap','.project-steps','.project-step'].map(pick).concat([`media1024=${matchMedia('(max-width:1024px)').matches} media760=${matchMedia('(max-width:760px)').matches} shellLeft=${Math.round((document.querySelector('.shell-left')?.getBoundingClientRect().width??0))} main=${Math.round((document.querySelector('.shell-main')?.getBoundingClientRect().width??0))}`]);
  });
  console.log(`=== ${label} ===`); out.forEach(l=>console.log('  '+l));
};
await page.waitForTimeout(220); await dump('220ms');
await page.waitForTimeout(500); await dump('720ms');
await browser.close();
