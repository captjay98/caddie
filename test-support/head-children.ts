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
  const rows=await page.evaluate(()=>{
    const out:string[]=[];
    const box=(n:Element)=>{const r=n.getBoundingClientRect();return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;};
    const head=document.querySelector('.project-head');
    head?.querySelector(':scope > *')&&head.querySelectorAll(':scope > *').forEach((n)=>out.push(`head>  ${n.tagName.toLowerCase()}.${String(n.className??'').split(' ').slice(0,2).join('.')}  ${box(n)}  "${(n.textContent??'').replace(/\s+/g,' ').slice(0,40)}"`));
    const wrap=document.querySelector('.project-steps-wrap');
    wrap?.querySelectorAll(':scope > *').forEach((n)=>out.push(`wrap>  ${n.tagName.toLowerCase()}.${String(n.className??'').split(' ').slice(0,2).join('.')}  ${box(n)}`));
    document.querySelectorAll('.project-steps .project-step').forEach((n)=>out.push(`step   ${box(n)} "${(n.textContent??'').replace(/\s+/g,' ').slice(0,40)}"`));
    const pw=document.querySelector('.preview-page'); out.push(`preview-page ${pw?box(pw):'-'}`);
    const head2=document.querySelector('.preview-page > header'); out.push(`page-header ${head2?box(head2):'-'}`);
    return out;
  });
  console.log(`=== ${label} ===`); rows.forEach(r=>console.log('  '+r));
};
await page.waitForTimeout(220); await dump('220ms');
await page.waitForTimeout(400); await dump('620ms');
await page.waitForTimeout(1500); await dump('2100ms');
await browser.close();
