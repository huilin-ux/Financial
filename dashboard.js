// ========== CONSTANTS ==========
const COLORS = ['#ffb832','#00c896','#3a7bd5','#9b59b6','#f39c12'];
const DEFAULT_API_KEY = 'meow-cat-financial-2026';

// ========== CLOUD SYNC (Google Sheets via Apps Script Web App) ==========
function getCloudUrl(){ return localStorage.getItem('cloud_api_url') || ''; }
function setCloudUrl(u){ localStorage.setItem('cloud_api_url', String(u||'').trim()); }
function getCloudApiKey(){ return localStorage.getItem('cloud_api_key') || DEFAULT_API_KEY; }
function setCloudApiKey(k){ localStorage.setItem('cloud_api_key', String(k||'').trim()); }

// Allow auto-setup via ?api=... and ?key=... in the page URL. Strips them from the address bar after saving.
(function autoSetupFromQuery(){
  try {
    const params = new URLSearchParams(window.location.search);
    const apiFromUrl = params.get('api');
    if (apiFromUrl && apiFromUrl.startsWith('https://')) {
      setCloudUrl(apiFromUrl);
      params.delete('api');
    }
    const keyFromUrl = params.get('key');
    if (keyFromUrl) {
      setCloudApiKey(keyFromUrl);
      params.delete('key');
    }
    const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    if (clean !== window.location.pathname + window.location.search) {
      history.replaceState(null, '', clean);
    }
  } catch(e) {}
})();

async function loadFromCloud() {
  const url = getCloudUrl();
  if (!url) return null;
  try {
    const res = await fetch(url + '?key=' + encodeURIComponent(getCloudApiKey()));
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return cloudToLocal_(data);
  } catch (e) {
    console.warn('loadFromCloud failed:', e);
    return null;
  }
}

async function saveToCloud() {
  const url = getCloudUrl();
  if (!url) return false;
  try {
    const body = {
      key: getCloudApiKey(),
      holdings: H.map(h => ({stock_tk:h.tk,stock_nm:h.nm,shares:h.s,cost:h.c,buy_alert:h.b,sell_alert:h.sl})),
      watchlist: AL.map(a => ({stock_tk:a.tk,stock_nm:a.nm,buy_price:a.b,take_profit:a.tp,stop_loss:a.stop,plan_shares:a.shares||0,source:a.src,status:a.status,exit_price:a.exit_price||0,exit_date:a.exit_date||''})),
      watchlist_deleted: getDeletedWatchKeys_(),
      dca: DCA_PLANS.map(p => ({stock_tk:p.tk,stock_nm:p.nm,deduct_day:p.day,amount:p.amount,active:true,owner:p.owner||'自己',total_shares:p.totalShares||0,avg_cost:p.avgCost||0})),
      trades: TRADES.map(t => ({date:t.date,type:t.type,stock_tk:t.tk,stock_nm:t.nm,shares:t.shares,price:t.price,source:t.src,pnl:t.pnl})),
      config: { total_assets: TOTAL_ASSETS }
    };
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      // Apps Script Web App needs this content-type quirk:
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // keepalive: let POST complete even if user navigates / refreshes before fetch resolves
      keepalive: true
    });
    if (!res.ok) { console.warn('saveToCloud HTTP '+res.status); return false; }
    let data;
    try { data = await res.json(); }
    catch(parseErr){ console.warn('saveToCloud: response is not JSON (likely auth redirect from wrong deployment access)'); return false; }
    if (data && data.error) { console.warn('saveToCloud server error:', data.error); return false; }
    if (!data || !data.ok) { console.warn('saveToCloud: server did not confirm save'); return false; }
    clearDeletedWatchKeys_();
    return true;
  } catch (e) {
    console.warn('saveToCloud failed:', e);
    return false;
  }
}

function cloudToLocal_(data) {
  const h = (data.holdings||[]).map(r => ({tk:r.stock_tk,nm:r.stock_nm,p:Number(r.price)||r.cost,c:r.cost,s:r.shares,b:r.buy_alert,sl:r.sell_alert}));
  const al = (data.watchlist||[]).map((r,i) => ({id:i+1,tk:r.stock_tk,nm:r.stock_nm,b:r.buy_price,tp:r.take_profit,stop:r.stop_loss,shares:Number(r.plan_shares)||0,src:r.source,note:'',status:r.status,exit_price:Number(r.exit_price)||0,exit_date:r.exit_date||'',p:Number(r.price)||(r.buy_price+(r.take_profit-r.buy_price)*0.3)}));
  const tr = (data.trades||[]).map((r,i) => ({id:i+1,tk:r.stock_tk,nm:r.stock_nm,type:r.type,price:r.price,shares:r.shares,date:r.date,src:r.source,pnl:r.pnl}));
  const dcaPlans = (data.dca||[]).map((r,i) => ({id:i+1,tk:r.stock_tk,nm:r.stock_nm,owner:r.owner||'自己',amount:Number(r.amount)||0,day:Number(r.deduct_day)||15,totalShares:Number(r.total_shares)||0,avgCost:Number(r.avg_cost)||0}));
  const cfg = data.config || {};
  GEMINI_KEY = String(cfg.gemini_key || '').replace(/\s+/g, '');
  OWNER_NAME = String(cfg.owner_name || '朋友').trim();
  LAST_MORNING_REPORT = data.morningReport || null;
  return {
    TOTAL_ASSETS: Number(cfg.total_assets) || 0,
    H: h, AL: al, TRADES: tr, DCA_ENTRIES: [], DCA_PLANS: dcaPlans,
    nid: al.length+1, ntid: tr.length+1, dcaNextId: 1, dcaPlanNextId: dcaPlans.length+1
  };
}

let GEMINI_KEY = '';
let OWNER_NAME = '朋友';
let LAST_MORNING_REPORT = null;

// ========== PERSISTENT DATA (localStorage as offline cache) ==========
function loadData() {
  try {
    const d = JSON.parse(localStorage.getItem('invest_os_data') || 'null');
    if (d) return d;
  } catch(e) {}
  return null;
}
function saveData() {
  localStorage.setItem('invest_os_data', JSON.stringify({
    TOTAL_ASSETS, H, AL, TRADES, DCA_ENTRIES, nid, ntid, dcaNextId, DCA_META, DCA_PLANS, dcaPlanNextId
  }));
  if (getCloudUrl()) {
    setCloudStatus('🔄 同步中…');
    localStorage.setItem('invest_os_dirty', '1');
    saveToCloud().then(ok => {
      if (ok) {
        localStorage.removeItem('invest_os_dirty');
        setCloudStatus('🟢 已同步至 Google Sheet');
        updateLastSync_();
        setTimeout(() => setCloudStatus('🟢 已連動 Google Sheet'), 2000);
      } else {
        setCloudStatus('🔴 同步失敗，本機保留');
      }
    });
  }
}

const saved = loadData();
let TOTAL_ASSETS = saved ? saved.TOTAL_ASSETS : 0;
let H            = saved ? saved.H            : [];
let AL           = saved ? saved.AL           : [];
let nid          = saved ? saved.nid          : 1;
let TRADES       = saved ? saved.TRADES       : [];
let ntid         = saved ? saved.ntid         : 1;
let DCA_ENTRIES  = saved ? saved.DCA_ENTRIES  : [];
let dcaNextId    = saved ? saved.dcaNextId    : 1;
let DCA_META     = saved ? (saved.DCA_META||{}) : {};
// Snapshot model: one plan per (ticker+owner). {id,tk,nm,owner,amount,day,totalShares,avgCost}
let DCA_PLANS    = saved ? (saved.DCA_PLANS||[]) : [];
let dcaPlanNextId= saved ? (saved.dcaPlanNextId||1) : 1;
migrateDcaToPlans();

// One-time migration from the old per-month entry model to snapshot plans.
function migrateDcaToPlans(){
  if(DCA_PLANS.length) return;
  if(!DCA_ENTRIES||!DCA_ENTRIES.length) return;
  const groups={};
  DCA_ENTRIES.forEach(e=>{
    const owner=(e.owner||'自己').trim()||'自己';
    const key=e.tk+'|'+owner;
    if(!groups[key]) groups[key]={tk:e.tk,nm:e.nm||e.tk,owner,amts:{},days:{},shares:0,cost:0};
    const g=groups[key];
    if(e.amt) g.amts[e.amt]=(g.amts[e.amt]||0)+1;
    if(e.date){const d=new Date(e.date).getDate(); if(d) g.days[d]=(g.days[d]||0)+1;}
    if(e.shares&&e.price){g.shares+=e.shares; g.cost+=e.shares*e.price;}
  });
  const mode=o=>{let best=null,n=-1;for(const k in o){if(o[k]>n){n=o[k];best=k;}}return best;};
  Object.values(groups).forEach(g=>{
    const meta=DCA_META[g.tk]||{};
    const amount=Number(mode(g.amts))||0;
    const day=Number(mode(g.days))||15;
    const totalShares=meta.totalShares||g.shares||0;
    const avgCost=meta.avgCost||(g.shares>0?g.cost/g.shares:0);
    DCA_PLANS.push({id:dcaPlanNextId++,tk:g.tk,nm:g.nm,owner:g.owner,amount,day,totalShares,avgCost:Math.round(avgCost*100)/100});
  });
}


// ========== SUMMARY STATS ==========
// ========== UNIFIED HOLDINGS ==========
// Merge manual H[] + 向錢進 持有中 + DCA confirmed entries by ticker.
// Manual entries are the only ones that get full features (buy/sell alerts,
// edit/delete on the 持倉 tab); others are read-only here and must be
// edited in their source tab. Used by renderH / renderSummaryStats /
// renderRisk / renderAllocation so every aggregate reflects everything
// the user actually owns.
function getUnifiedHoldings(){
  const map={};
  H.forEach((h,idx)=>{
    map[h.tk]={
      tk:h.tk, nm:h.nm,
      s:h.s||0, _tc:(h.s||0)*(h.c||0),
      p:h.p, b:h.b, sl:h.sl, _spark:h._spark,
      sources:new Set(['持倉']), manualIdx:idx
    };
  });
  AL.filter(a=>a.status==='holding'&&a.shares>0&&a.b>0).forEach(a=>{
    if(!map[a.tk]) map[a.tk]={tk:a.tk,nm:a.nm,s:0,_tc:0,p:a.p,b:null,sl:null,sources:new Set(),manualIdx:-1};
    map[a.tk].s+=a.shares;
    map[a.tk]._tc+=a.shares*a.b;
    map[a.tk].sources.add('向錢進');
    if(!map[a.tk].p&&a.p) map[a.tk].p=a.p;
  });
  DCA_PLANS.filter(p=>p.totalShares>0).forEach(p=>{
    if(!map[p.tk]) map[p.tk]={tk:p.tk,nm:p.nm,s:0,_tc:0,p:null,b:null,sl:null,sources:new Set(),manualIdx:-1};
    map[p.tk].s+=p.totalShares;
    map[p.tk]._tc+=p.totalShares*(p.avgCost||0);
    map[p.tk].sources.add('DCA');
  });
  return Object.values(map)
    .map(m=>({...m, c:m.s>0?m._tc/m.s:0, sources:[...m.sources]}))
    .filter(m=>m.s>0);
}

function renderSummaryStats(){
  const U=getUnifiedHoldings();
  const totalVal = U.reduce((s,h)=>s+(h.p||h.c)*h.s, 0);
  const totalCost = U.reduce((s,h)=>s+h.c*h.s, 0);
  const totalPnl = totalVal - totalCost;
  const retPct = totalCost ? (totalPnl/totalCost*100).toFixed(1) : 0;
  const assets = totalVal + (TOTAL_ASSETS - totalCost);
  document.getElementById('totalAssets').textContent = Math.round(assets).toLocaleString();
  document.getElementById('totalReturn').textContent = `${retPct>0?'▲':'▼'} ${Math.abs(retPct)}% 報酬率`;
  document.getElementById('totalReturn').className = 'sdelta ' + (retPct>0?'up':'dn');
  const pnlEl = document.getElementById('totalPnlStat');
  pnlEl.textContent = (totalPnl>=0?'+':'')+Math.round(totalPnl).toLocaleString();
  pnlEl.className = 'sval ' + (totalPnl>=0?'up':'dn');
  document.getElementById('totalPnlDelta').textContent = '未實現損益合計';
  document.getElementById('totalPnlDelta').className = 'sdelta ' + (totalPnl>=0?'up':'dn');
}

// ========== CLOCK ==========
function tick(){
  const n=new Date(),z=v=>String(v).padStart(2,'0');
  document.getElementById('hclock').innerHTML=`${n.getFullYear()}.${z(n.getMonth()+1)}.${z(n.getDate())} <em>${z(n.getHours())}:${z(n.getMinutes())}:${z(n.getSeconds())}</em>`;
}
tick(); setInterval(tick,1000);

// ========== TABS ==========
function go(id,btn){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.ntab').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='report') renderMorningReport();
}

// ========== HOLDINGS ==========
function makeAreaChart(vals, color, up){
  if(!vals||vals.length<2) return '';
  const W=400,HH=72,padY=6;
  const mn=Math.min(...vals),mx=Math.max(...vals);
  const rng=mx-mn||1;
  const xs=W/(vals.length-1);
  const pts=vals.map((v,i)=>`${(i*xs).toFixed(1)},${(HH-padY-((v-mn)/rng)*(HH-padY*2)).toFixed(1)}`).join(' ');
  const gradId='ag'+Math.random().toString(36).slice(2,7);
  const fillColor=up?'#00c896':'#ff4560';
  const lastX=((vals.length-1)*xs).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${HH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${fillColor}" stop-opacity="0.35"/><stop offset="100%" stop-color="${fillColor}" stop-opacity="0.02"/></linearGradient></defs><polygon points="${pts} ${lastX},${HH} 0,${HH}" fill="url(#${gradId})"/><polyline points="${pts}" fill="none" stroke="${fillColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function genSparkData(h){
  const steps=24, start=h.c, end=h.p, pts=[];
  for(let i=0;i<=steps;i++){
    const t=i/steps;
    const trend=start+(end-start)*t;
    const noise=(Math.random()-0.5)*Math.abs(end-start)*0.3;
    pts.push(trend+noise);
  }
  pts[pts.length-1]=end; pts[0]=start;
  return pts;
}

function renderH(){
  const tb=document.getElementById('hbody');
  if(!tb) return;
  tb.innerHTML='';
  const U=getUnifiedHoldings();
  if(!U.length){
    tb.innerHTML=`<div style="font-family:var(--mono);font-size:15px;color:var(--text-dim);text-align:center;padding:32px 16px"><div style="font-size:32px;margin-bottom:12px">📊</div>尚無持倉，去設定頁新增（或在向錢進 / 定期定額 新增也會自動出現在這裡）</div>`;
    const phEmpty=document.querySelector('#tab-portfolio .panel .phead span[style*="text-dim"]');
    if(phEmpty) phEmpty.textContent='0 POSITIONS';
    return;
  }
  U.forEach(h=>{
    const pnl=(h.p-h.c)*h.s, pct=h.c>0?((h.p-h.c)/h.c*100).toFixed(1):'0.0', up=pnl>=0, mktVal=h.p*h.s;
    const hasBar=h.b&&h.sl&&h.b!==h.sl;
    const rng=hasBar?h.sl-h.b:1;
    const pos=hasBar?Math.min(100,Math.max(0,(h.p-h.b)/rng*100)):50;
    const barCol=pos<30?'var(--green)':pos>70?'var(--red)':'var(--amber)';
    const nb=h.b&&h.p<=h.b*1.03, ns=h.sl&&h.p>=h.sl*0.97;
    const chips=[h.b?`<span class="chip cb ${nb?'chip-hot':''}">買 ${h.b.toLocaleString()}</span>`:'',h.sl?`<span class="chip cs ${ns?'chip-hot':''}">賣 ${h.sl.toLocaleString()}</span>`:''].join('');
    if(!h._spark) h._spark=genSparkData(h);
    const chartSvg=makeAreaChart(h._spark, up?'#00c896':'#ff4560', up);
    // Source badges: hide '持倉' (default), show others so user knows where to edit
    const otherSources=h.sources.filter(s=>s!=='持倉');
    const srcBadgeHTML=otherSources.length
      ? otherSources.map(s=>{const lbl=s==='向錢進'?'🎯 向錢進':s==='DCA'?'📅 定期定額':s;return `<span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:2px 8px;border-radius:8px">${lbl}</span>`;}).join(' ')
      : '';
    const actions=h.manualIdx>=0
      ? `<div class="hcard-actions">${srcBadgeHTML?'<div style="display:flex;gap:6px;flex:1">'+srcBadgeHTML+'</div>':''}<button class="al-action-btn" onclick="editHolding(${h.manualIdx})">✏️ 編輯</button><button class="al-action-btn danger" onclick="deleteHolding(${h.manualIdx})">🗑️ 刪除</button></div>`
      : `<div class="hcard-actions"><div style="display:flex;gap:6px;flex:1">${srcBadgeHTML}</div><span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);padding:6px 4px">↗ 至來源 tab 編輯</span></div>`;
    tb.innerHTML+=`<div class="hcard"><div class="hcard-top"><div class="hcard-left"><div class="hcard-tk">${h.tk}</div><div class="hcard-nm">${h.nm}</div><div class="hcard-chips">${chips}</div></div><div class="hcard-right"><div class="hcard-price">${h.p.toLocaleString()}</div><div class="hcard-cost">成本 ${h.c.toFixed(2)}</div><div class="hcard-pnl ${up?'up':'dn'}">${up?'+':''}${Math.round(pnl).toLocaleString()}</div><div class="hcard-pct" style="color:${up?'var(--green)':'var(--red)'}">${up?'▲':'▼'}${Math.abs(pct)}%</div></div></div><div class="hcard-chart">${chartSvg}</div><div class="hcard-meta"><div class="hcard-shares">${h.s.toLocaleString()} 股</div><div class="hcard-val">市值 $${Math.round(mktVal).toLocaleString()}</div></div>${hasBar?`<div class="hcard-bar-wrap"><div class="hcard-bar-lbl"><span style="color:var(--green)">買 ${h.b}</span><span>${pos.toFixed(0)}% 位置</span><span style="color:var(--red)">賣 ${h.sl}</span></div><div class="hcard-bar-track"><div class="hcard-bar-fill" style="width:${pos}%;background:${barCol}"></div><div class="hcard-bar-dot" style="left:${pos}%;background:${barCol}"></div></div></div>`:''}${actions}</div>`;
  });
  const ph=document.querySelector('#tab-portfolio .panel .phead span[style*="text-dim"]');
  if(ph) ph.textContent=U.length+' POSITIONS';
}

function renderTA(){
  const el=document.getElementById('tbody'); const trig=[];
  H.forEach(h=>{
    if(h.b && h.p<=h.b*1.03) trig.push({t:'buy',tk:h.tk,nm:h.nm,p:h.p,tgt:h.b,d:'持倉接近買入目標'});
    if(h.sl && h.p>=h.sl*0.97) trig.push({t:'sell',tk:h.tk,nm:h.nm,p:h.p,tgt:h.sl,d:'持倉接近賣出目標'});
  });
  AL.forEach(a=>{
    if(a.b && a.p<=a.b*1.03) trig.push({t:'buy',tk:a.tk,nm:a.nm,p:a.p,tgt:a.b,d:`向錢進買入點達標 (${a.src})`});
    if(a.tp && a.p>=a.tp*0.97) trig.push({t:'sell',tk:a.tk,nm:a.nm,p:a.p,tgt:a.tp,d:`向錢進賣出點達標 (${a.src})`});
  });
  document.getElementById('trigCount').textContent=trig.length||'0';
  if(!trig.length){el.innerHTML=`<div style="font-family:var(--mono);font-size:16px;color:var(--text-dim);letter-spacing:1px">// NO ALERTS TODAY · ALL CLEAR</div>`;return;}
  el.innerHTML=trig.map(t=>`<div class="arow ${t.t==='buy'?'tbuy':'tsell'}"><div class="aicon" style="background:${t.t==='buy'?'rgba(0,200,150,0.1)':'rgba(255,69,96,0.1)'}"><svg width="13" height="13" viewBox="0 0 13 13">${t.t==='buy'?'<path d="M6.5 2L11 11H2L6.5 2Z" fill="var(--green)"/>':'<path d="M6.5 11L2 2H11L6.5 11Z" fill="var(--red)"/>'}</svg></div><div style="flex:1"><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:${t.t==='buy'?'var(--green)':'var(--red)'}">${t.tk} ${t.nm}</div><div style="font-size:16px;color:var(--text-secondary);margin-top:2px">${t.d}</div></div><div style="text-align:right"><div style="font-family:var(--mono);font-size:16px;font-weight:500">${t.p.toLocaleString()}</div><div style="font-size:12px;color:var(--text-dim);font-family:var(--mono);margin-top:2px">目標 ${t.tgt.toLocaleString()}</div></div></div>`).join('');
}

// ========== RISK ==========
function renderRisk(){
  const URisk=getUnifiedHoldings();
  if(!URisk.length || !TOTAL_ASSETS) return;
  const mv=URisk.map(h=>({tk:h.tk,nm:h.nm,val:(h.p||h.c)*h.s}));
  const sorted=[...mv].sort((a,b)=>b.val-a.val);
  const maxC=sorted[0];
  const maxPct=(maxC.val/TOTAL_ASSETS*100).toFixed(1);
  document.getElementById('maxConc').textContent=maxPct+'%';
  document.getElementById('maxConc').className='sval '+(parseFloat(maxPct)>30?'dn':parseFloat(maxPct)>20?'or':'up');
  document.getElementById('maxConcName').textContent=maxC.tk+' '+maxC.nm;
  document.getElementById('dd20').textContent='-'+(maxC.val*0.2/TOTAL_ASSETS*100).toFixed(1)+'%';
  const cx=65,cy=65,r=48,circ=2*Math.PI*r;
  let offset=0,svgPaths='',legHTML='';
  mv.forEach((m,i)=>{
    const pct=m.val/TOTAL_ASSETS,dash=pct*circ,col=COLORS[i%COLORS.length];
    svgPaths+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="18" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" opacity="0.85"/>`;
    legHTML+=`<div class="dl-row"><div class="dl-dot" style="background:${col}"></div><span class="dl-name">${m.tk} ${m.nm}</span><span class="dl-pct" style="color:${col}">${(pct*100).toFixed(1)}%</span></div>`;
    offset+=dash;
  });
  const cashPct=Math.max(0,1-mv.reduce((s,m)=>s+m.val/TOTAL_ASSETS,0));
  if(cashPct>0.01){const cd=cashPct*circ;svgPaths+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(240,230,210,0.12)" stroke-width="18" stroke-dasharray="${cd} ${circ-cd}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;legHTML+=`<div class="dl-row"><div class="dl-dot" style="background:rgba(240,230,210,0.15)"></div><span class="dl-name">現金 / 其他</span><span class="dl-pct" style="color:var(--text-dim)">${(cashPct*100).toFixed(1)}%</span></div>`;}
  svgPaths+=`<circle cx="${cx}" cy="${cy}" r="30" fill="#0f1a28"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-family="'IBM Plex Mono',monospace" font-size="12" font-weight="700" fill="#ffb832">${(mv.reduce((s,m)=>s+m.val,0)/TOTAL_ASSETS*100).toFixed(0)}%</text><text x="${cx}" y="${cy+14}" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="8" fill="rgba(240,230,210,0.4)">已投入</text>`;
  document.getElementById('donutSvg').innerHTML=svgPaths;
  document.getElementById('donutLeg').innerHTML=legHTML;
  let warns='';
  mv.forEach(m=>{const pct=m.val/TOTAL_ASSETS*100;if(pct>30)warns+=`<div class="warn-box warn-red"><div class="warn-icon">⚠</div><div><div class="warn-title" style="color:var(--red)">集中度過高警告</div><div class="warn-text">${m.tk} 佔總資產 ${pct.toFixed(1)}%，超過建議上限 30%。</div></div></div>`;else if(pct>20)warns+=`<div class="warn-box warn-orange"><div class="warn-icon">⚡</div><div><div class="warn-title" style="color:var(--orange)">集中度偏高</div><div class="warn-text">${m.tk} 佔 ${pct.toFixed(1)}%，接近建議上限，留意風險。</div></div></div>`;});
  if(!warns)warns=`<div class="warn-box warn-green"><div class="warn-icon">✓</div><div><div class="warn-title" style="color:var(--green)">集中度正常</div><div class="warn-text">各持倉比例在合理範圍內。</div></div></div>`;
  document.getElementById('concWarns').innerHTML=warns;
  let gHTML='';
  URisk.forEach(h=>{const price=h.p||h.c;[10,20,30].forEach(d=>{const imp=Math.abs((price*(d/100))*h.s)/TOTAL_ASSETS*100;gHTML+=`<div class="rg-row"><span class="rg-label">${h.tk} 跌${d}%</span><div class="rg-bar"><div class="rg-fill" style="width:${Math.min(100,imp*8)}%;background:${imp>5?'var(--red)':imp>3?'var(--orange)':'var(--green)'}"></div></div><span class="rg-val" style="color:${imp>5?'var(--red)':imp>3?'var(--orange)':'var(--green)'}">${imp.toFixed(1)}%</span></div>`;});});
  document.getElementById('stressGauge').innerHTML=gHTML;
  const slb=document.getElementById('slBody');slb.innerHTML='';
  URisk.forEach(h=>{const price=h.p||h.c;const sl10=(h.c*0.9).toFixed(0),sl15=(h.c*0.85).toFixed(0),dist=((price-h.c*0.9)/price*100).toFixed(1),safe=parseFloat(dist)>5;slb.innerHTML+=`<tr><td><div class="htk">${h.tk}</div><div class="hnm">${h.nm}</div></td><td><div class="hp">${h.c.toFixed(2)}</div></td><td><div style="font-family:var(--mono);font-size:15px;color:var(--orange)">${sl10}</div></td><td><div style="font-family:var(--mono);font-size:15px;color:var(--red)">${sl15}</div></td><td><div style="font-family:var(--mono);font-size:15px;color:${safe?'var(--green)':'var(--red)'}">${dist>0?'+':''}${dist}%</div><div style="font-size:13px;color:${safe?'var(--green)':'var(--red)'};">${safe?'安全':'接近停損'}</div></td></tr>`;});
  const maxLoss=TOTAL_ASSETS*0.02;
  document.getElementById('sizeTable').innerHTML=URisk.map(h=>{const price=h.p||h.c;const stopAmt=price*0.10,maxSh=Math.floor(maxLoss/stopAmt),maxVal=maxSh*price;return`<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid rgba(26,37,53,0.6)"><div style="flex:1"><div class="htk">${h.tk} ${h.nm}</div><div class="hnm" style="margin-top:3px">停損10% = $${stopAmt.toFixed(0)}/股</div></div><div style="text-align:right"><div style="font-family:var(--mono);font-size:19px;font-weight:700;color:var(--amber)">最多 ${maxSh} 股</div><div style="font-family:var(--mono);font-size:12px;color:var(--text-dim);margin-top:2px">≈ $${maxVal.toLocaleString()}</div></div></div>`;}).join('');
}

// ========== DCA ==========
// ========== DCA OWNER FILTER ==========
let DCA_OWNER_FILTER=localStorage.getItem('dca_owner_filter')||'all';
function _ownerOf(e){return (e.owner||'自己').trim()||'自己';}
function getDcaOwners(){const s=new Set();DCA_PLANS.forEach(p=>s.add(_ownerOf(p)));return [...s];}
function filterDcaOwner(o,btn){
  DCA_OWNER_FILTER=o;
  localStorage.setItem('dca_owner_filter',o);
  document.querySelectorAll('.dca-owner-filter-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  renderDCA();
}
function renderDcaOwnerFilter(){
  const el=document.getElementById('dcaOwnerFilter');
  if(!el) return;
  const owners=getDcaOwners();
  if(owners.length<=1){ el.style.display='none'; DCA_OWNER_FILTER='all'; }
  else {
    el.style.display='flex';
    const esc=s=>String(s).replace(/'/g,"\\'");
    el.innerHTML=`<button class="al-filter dca-owner-filter-btn ${DCA_OWNER_FILTER==='all'?'active':''}" onclick="filterDcaOwner('all',this)">全部</button>`+
      owners.map(o=>`<button class="al-filter dca-owner-filter-btn ${DCA_OWNER_FILTER===o?'active':''}" onclick="filterDcaOwner('${esc(o)}',this)">👤 ${o}</button>`).join('');
  }
  // Populate datalist for owner input
  const dl=document.getElementById('dcaOwnerList');
  if(dl) dl.innerHTML=owners.map(o=>`<option value="${o}">`).join('');
}

function renderDCA(){
  renderDcaOwnerFilter();
  const VISIBLE=DCA_OWNER_FILTER==='all'
    ? DCA_PLANS
    : DCA_PLANS.filter(p=>_ownerOf(p)===DCA_OWNER_FILTER);
  const showOwners=getDcaOwners().length>1;
  // Aggregate totals across visible plans
  let totalCost=0,totalVal=0,monthlySum=0,allPriced=VISIBLE.length>0,anyShares=false;
  VISIBLE.forEach(p=>{
    totalCost+=(p.totalShares||0)*(p.avgCost||0);
    monthlySum+=p.amount||0;
    const cur=(H.find(x=>x.tk===p.tk)||{}).p;
    if(p.totalShares>0){
      anyShares=true;
      if(cur) totalVal+=cur*p.totalShares; else allPriced=false;
    }
  });
  const pnl=(anyShares&&allPriced&&totalCost>0)?totalVal-totalCost:null;
  const pnlPct=pnl===null?null:(pnl/totalCost*100);
  const pnlCls=pnl===null?'am':pnl>=0?'up':'dn';
  const grid=document.getElementById('dcaSummaryGrid');
  if(grid){
    grid.innerHTML=
      `<div class="stat" data-g="∑"><div class="slbl">總投入成本</div><div class="sval am">${totalCost?'$'+Math.round(totalCost).toLocaleString():'—'}</div><div class="sdelta am">${VISIBLE.length} 個計畫</div></div>`+
      `<div class="stat" data-g="$"><div class="slbl">總市值</div><div class="sval ${pnlCls}">${totalVal?'$'+Math.round(totalVal).toLocaleString():'—'}</div><div class="sdelta ${pnlCls}">${pnl===null?'等股價更新':(pnl>=0?'▲':'▼')+' vs 成本'}</div></div>`+
      `<div class="stat" data-g="${pnl===null?'—':pnl>=0?'▲':'▼'}"><div class="slbl">總損益</div><div class="sval ${pnlCls}">${pnl===null?'—':(pnl>=0?'+':'')+Math.round(pnl).toLocaleString()}</div><div class="sdelta ${pnlCls}">${pnlPct===null?'—':(pnl>=0?'+':'')+pnlPct.toFixed(1)+'%'}</div></div>`+
      `<div class="stat" data-g="月"><div class="slbl">每月扣款</div><div class="sval am">${monthlySum?'$'+monthlySum.toLocaleString():'—'}</div><div class="sdelta am">共 ${VISIBLE.length} 檔</div></div>`;
  }
  const container=document.getElementById('dcaStockPanels');
  if(!container) return;
  container.innerHTML='';
  VISIBLE.forEach(p=>{
    const cur=(H.find(x=>x.tk===p.tk)||{}).p||null;
    const cost=(p.totalShares||0)*(p.avgCost||0);
    const val=(cur&&p.totalShares)?cur*p.totalShares:null;
    const pPnl=(val!==null&&cost>0)?val-cost:null;
    const pPct=pPnl===null?null:(pPnl/cost*100);
    const curPct=(cur&&p.avgCost)?((cur-p.avgCost)/p.avgCost*100):null;
    const pnlColor=pPnl===null?'var(--text-dim)':pPnl>=0?'var(--green)':'var(--red)';
    const ownerBadge=showOwners?`<span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:1px 7px;border-radius:8px;margin-left:8px">👤 ${_ownerOf(p)}</span>`:'';
    const curLine=cur?`現價 $${cur}${curPct!==null?` (${curPct>=0?'+':''}${curPct.toFixed(1)}%)`:''}`:'現價待更新';
    container.innerHTML+=`<div class="panel" style="margin-bottom:10px"><div class="phead"><div class="plabel">${p.tk} ${p.nm}${ownerBadge}</div><div style="display:flex;align-items:center;gap:6px"><button onclick="editDcaPlan(${p.id})" style="background:rgba(255,184,50,0.08);border:1px solid rgba(255,184,50,0.3);color:var(--amber);font-family:var(--mono);font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer" title="編輯這個計畫">✏️ 編輯</button><button onclick="deleteDcaPlan(${p.id})" style="background:rgba(255,69,96,0.08);border:1px solid rgba(255,69,96,0.3);color:var(--red);font-family:var(--mono);font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer" title="刪除這個計畫">🗑️</button></div></div><div class="pbody"><div class="g2" style="margin-bottom:12px"><div><div style="font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px">平均成本</div><div style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--amber)">${p.avgCost?p.avgCost.toFixed(2):'—'}</div><div style="font-family:var(--mono);font-size:11px;color:${cur&&p.avgCost&&cur>=p.avgCost?'var(--green)':cur?'var(--red)':'var(--text-dim)'};margin-top:2px">${curLine}</div></div><div><div style="font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px">損益（台幣）</div><div style="font-family:var(--mono);font-size:22px;font-weight:700;color:${pnlColor}">${pPnl===null?'—':(pPnl>=0?'+':'')+Math.round(pPnl).toLocaleString()}</div><div style="font-family:var(--mono);font-size:11px;color:${pnlColor};margin-top:2px">${pPct===null?'等股價':(pPnl>=0?'+':'')+pPct.toFixed(1)+'%'}</div></div><div><div style="font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px">總股數</div><div style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--text-primary)">${(p.totalShares||0).toLocaleString()}</div><div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-top:2px">${((p.totalShares||0)/1000).toFixed(2)} 張</div></div><div><div style="font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px">投入成本</div><div style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--text-primary)">${cost?'$'+Math.round(cost).toLocaleString():'—'}</div><div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-top:2px">${val!==null?'現值 $'+Math.round(val).toLocaleString():''}</div></div></div><div style="display:flex;gap:14px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--border);font-family:var(--mono);font-size:13px;color:var(--text-secondary)"><span>💰 每月扣 ${p.amount?'$'+p.amount.toLocaleString():'—'}</span><span>📅 每月 ${p.day} 號</span></div></div></div>`;
  });
  if(VISIBLE.length===0){
    const isFiltered=DCA_OWNER_FILTER!=='all'&&DCA_PLANS.length>0;
    container.innerHTML=isFiltered
      ? `<div style="text-align:center;padding:28px 16px"><div style="font-size:32px;margin-bottom:12px">👤</div><div style="font-family:var(--mono);font-size:15px;color:var(--text-dim);margin-bottom:8px">「${DCA_OWNER_FILTER}」這個帳戶還沒有定期定額計畫</div><div style="font-size:14px;color:var(--text-dim);line-height:1.7">切到「全部」看其他帳戶，或新增一筆。</div></div>`
      : `<div style="text-align:center;padding:28px 16px"><div style="font-size:32px;margin-bottom:12px">📅</div><div style="font-family:var(--mono);font-size:15px;color:var(--text-dim);margin-bottom:8px">尚無定期定額計畫</div><div style="font-size:14px;color:var(--text-dim);line-height:1.7">點上方「新增定期定額計畫」<br>照著券商 App 的庫存畫面填 5 個欄位即可<br>系統自動算出損益、扣款日提醒</div></div>`;
  }
  renderDcaStrategy();
}

function renderDcaStrategy(){
  const el=document.getElementById('dcaStrategyBody');
  if(!el) return;
  const tks=[...new Set(DCA_PLANS.map(p=>p.tk))];
  let html=`<div class="kcard" style="margin-bottom:8px"><div class="ktitle" style="color:var(--green)">// 為什麼定期定額有效</div><div class="kbody">不管股價高低每月固定買入，股價低時自動買到更多股，長期平滑成本。你不需要預測市場高低點，時間幫你做事。</div></div><div class="kcard" style="margin-bottom:8px"><div class="ktitle" style="color:var(--amber)">// 什麼時候可以加碼</div><div class="kbody">大盤單日跌超過 3%、VIX 恐慌指數超過 30、遇到重大系統性事件，是加碼好時機。這種時候買比平時多 1-2 倍。</div></div>`;
  const tips={
    '006208':{color:'var(--green)',text:'富邦台50追蹤台灣前50大企業，分散個股風險。長期年報酬約 8-10%，適合作為核心持倉長期定期定額。'},
    '0050':{color:'var(--green)',text:'元大台灣50與006208類似，費用率略高，但流動性最好。同樣適合長期核心持倉。'},
    '00646':{color:'#6ea3f7',text:'元大S&P500追蹤美股500大企業，適合想分散到美股的人。注意匯率風險。'},
    '00662':{color:'#6ea3f7',text:'富邦NASDAQ追蹤美國科技股，波動比S&P500大，適合風險承受度較高的人。'},
    '00878':{color:'var(--amber)',text:'國泰永續高股息，注重配息，適合想要穩定現金流的人。注意配息不等於報酬。'},
    '00919':{color:'var(--amber)',text:'群益台灣精選高息，高配息ETF。了解選股邏輯再決定是否定期定額。'},
  };
  tks.forEach(tk=>{
    const tip=tips[tk];
    const nm=STOCK_NAMES[tk]||DCA_PLANS.find(p=>p.tk===tk)?.nm||tk;
    if(tip) html+=`<div class="kcard" style="margin-bottom:8px"><div class="ktitle" style="color:${tip.color}">// ${tk} ${nm}</div><div class="kbody">${tip.text}</div></div>`;
    else html+=`<div class="kcard" style="margin-bottom:8px"><div class="ktitle" style="color:var(--text-secondary)">// ${tk} ${nm}</div><div class="kbody">定期定額最適合波動性較高但長期有上漲趨勢的標的。記得定期檢視這支的基本面是否仍然成立。</div></div>`;
  });
  el.innerHTML=html;
}

function toggleDcaForm(){
  const f=document.getElementById('dcaForm');
  const arrow=document.getElementById('dcaFormArrow');
  const open=f.style.display==='none';
  f.style.display=open?'block':'none';
  arrow.textContent=open?'▲':'▼';
  if(!open) resetDcaFormUI();
}

let editingPlanId=null;
function resetDcaFormUI(){
  editingPlanId=null;
  ['dca-tk','dca-nm','dca-owner','dca-amt','dca-day','dca-shares','dca-cost'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const lbl=document.getElementById('dca-edit-label'); if(lbl) lbl.style.display='none';
  const cancel=document.getElementById('dcaCancel'); if(cancel) cancel.style.display='none';
  const submit=document.getElementById('dcaSubmit'); if(submit) submit.textContent='確認新增';
}
function cancelDcaEdit(){
  document.getElementById('dcaForm').style.display='none';
  document.getElementById('dcaFormArrow').textContent='▼';
  resetDcaFormUI();
}
function editDcaPlan(id){
  const p=DCA_PLANS.find(x=>x.id===id);
  if(!p) return;
  editingPlanId=id;
  const f=document.getElementById('dcaForm');
  f.style.display='block';
  document.getElementById('dcaFormArrow').textContent='▲';
  document.getElementById('dca-tk').value=p.tk||'';
  document.getElementById('dca-nm').value=p.nm||'';
  document.getElementById('dca-owner').value=_ownerOf(p);
  document.getElementById('dca-amt').value=p.amount||'';
  document.getElementById('dca-day').value=p.day||'';
  document.getElementById('dca-shares').value=p.totalShares||'';
  document.getElementById('dca-cost').value=p.avgCost||'';
  const lbl=document.getElementById('dca-edit-label'); if(lbl){lbl.style.display='block';lbl.textContent='✏️ 編輯 '+p.tk+' '+(p.nm||'')+' 的計畫';}
  const cancel=document.getElementById('dcaCancel'); if(cancel) cancel.style.display='block';
  const submit=document.getElementById('dcaSubmit'); if(submit) submit.textContent='確認更新';
  f.scrollIntoView({behavior:'smooth',block:'center'});
}
function deleteDcaPlan(id){
  const p=DCA_PLANS.find(x=>x.id===id);
  if(!p) return;
  const sameTk=DCA_PLANS.filter(x=>x.tk===p.tk).length>1;
  if(!confirm(`確定要刪除 ${p.tk} ${p.nm||''}${sameTk?'（'+_ownerOf(p)+'）':''} 的定期定額計畫嗎？\n\n此操作無法復原。`)) return;
  DCA_PLANS=DCA_PLANS.filter(x=>x.id!==id);
  saveData(); renderDCA();
}

// Auto-derive trades from 向錢進 entries so users don't have to
// hand-record every BUY twice. Anything in AL with shares + buy_price
// counts as a BUY trade; sold_* entries with an exit_price recorded
// also emit a paired SELL with realized P&L. Manual TRADES win on
// duplicates (same tk + type + matching price), so legacy hand-added
// rows are preserved.
function getUnifiedTrades(){
  const out=TRADES.map(t=>({...t}));
  const same=(a,b)=>Math.abs(Number(a)-Number(b))<0.01;
  AL.forEach(a=>{
    if(!(a.shares>0&&a.b>0)) return;
    const tracked=a.status==='holding'||a.status==='sold_profit'||a.status==='sold_loss';
    if(!tracked) return;
    if(!TRADES.some(t=>t.type==='buy'&&t.tk===a.tk&&same(t.price,a.b))){
      out.push({
        id:'al-buy-'+a.id, tk:a.tk, nm:a.nm,
        type:'buy', price:a.b, shares:a.shares,
        date:a.entered_date||'—', src:a.src||'自己分析',
        pnl:null, _from:'向錢進', _alId:a.id
      });
    }
    if((a.status==='sold_profit'||a.status==='sold_loss')&&a.exit_price){
      if(!TRADES.some(t=>t.type==='sell'&&t.tk===a.tk&&same(t.price,a.exit_price))){
        out.push({
          id:'al-sell-'+a.id, tk:a.tk, nm:a.nm,
          type:'sell', price:a.exit_price, shares:a.shares,
          date:a.exit_date||'—', src:a.src||'自己分析',
          pnl:(a.exit_price-a.b)*a.shares,
          _from:'向錢進', _alId:a.id
        });
      }
    }
  });
  return out;
}

function calcWR(){
  const cl=getUnifiedTrades().filter(t=>t.pnl!==null);
  if(!cl.length) return {wr:0,total:0,pnl:0};
  const w=cl.filter(t=>t.pnl>0).length;
  return {wr:(w/cl.length*100).toFixed(0),total:cl.length,pnl:cl.reduce((s,t)=>s+t.pnl,0)};
}

function renderLog(){
  const trades=getUnifiedTrades();
  const {wr,pnl}=calcWR();
  document.getElementById('totalWR').textContent=wr+'%';
  document.getElementById('totalWR').className='sval '+(parseFloat(wr)>=50?'up':'dn');
  document.getElementById('totalRPnl').textContent=(pnl>=0?'+':'')+pnl.toLocaleString();
  document.getElementById('totalRPnl').className='sval '+(pnl>=0?'up':'dn');
  const srcMap={};
  trades.filter(t=>t.pnl!==null).forEach(t=>{if(!srcMap[t.src])srcMap[t.src]={wins:0,total:0,pnl:0};srcMap[t.src].total++;if(t.pnl>0)srcMap[t.src].wins++;srcMap[t.src].pnl+=t.pnl;});
  document.getElementById('wrBody').innerHTML=Object.entries(srcMap).map(([src,d])=>{const w2=(d.wins/d.total*100).toFixed(0),col=parseFloat(w2)>=50?'var(--green)':'var(--red)';return`<div class="wr-card"><div class="wr-name">${src}</div><div class="wr-bar-wrap"><div class="wr-bar"><div class="wr-win" style="width:${w2}%"></div><div class="wr-loss" style="width:${100-w2}%"></div></div><span style="font-family:var(--mono);font-size:16px;font-weight:700;color:${col};width:34px;text-align:right">${w2}%</span></div><div class="wr-stat"><span>${d.total} 筆</span><span>${d.wins}勝${d.total-d.wins}敗</span><span style="color:${d.pnl>=0?'var(--green)':'var(--red)'}">${d.pnl>=0?'+':''}${d.pnl.toLocaleString()}</span></div></div>`;}).join('')||`<div style="font-family:var(--mono);font-size:16px;color:var(--text-dim)">// 尚無結算記錄</div>`;
  const sorted=[...trades].sort((a,b)=>{const ad=a.date&&a.date!=='—'?new Date(a.date):new Date(0);const bd=b.date&&b.date!=='—'?new Date(b.date):new Date(0);return bd-ad;});
  document.getElementById('tlogBody').innerHTML=sorted.map(t=>{
    const fromBadge=t._from?`<span style="font-family:var(--mono);font-size:10px;color:var(--text-dim);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:1px 6px;border-radius:8px;margin-left:6px">🎯 ${t._from}</span>`:'';
    return `<div class="tlog-row"><span class="tlog-type ${t.type==='buy'?'tlog-buy':'tlog-sell'}">${t.type==='buy'?'BUY':'SELL'}</span><div style="flex:1;min-width:0"><div class="tlog-tk">${t.tk} <span style="font-size:13px;font-weight:400;color:var(--text-secondary)">${t.nm}</span>${fromBadge}</div><div class="tlog-meta">${t.date} · ${t.shares}股 · ${t.src}</div></div><div><div class="tlog-price" style="color:${t.type==='buy'?'var(--amber)':'var(--text-primary)'}">$${t.price.toLocaleString()}</div>${t.pnl!==null?`<div class="tlog-pnl ${t.pnl>=0?'up':'dn'}">${t.pnl>=0?'+':''}${t.pnl.toLocaleString()}</div>`:'<div class="tlog-pnl" style="color:var(--text-dim)">持有中</div>'}</div></div>`;
  }).join('');
}

function openTradeModal(){renderAllSrcChips();document.getElementById('tm-date').value=new Date().toISOString().split('T')[0];document.getElementById('tradeModal').classList.add('open');}
function closeTradeModal(){document.getElementById('tradeModal').classList.remove('open');}
function addTrade(){
  const tk=document.getElementById('tm-tk').value.trim(),nm=document.getElementById('tm-nm').value.trim();
  const type=document.getElementById('tm-type').value,price=parseFloat(document.getElementById('tm-price').value)||0;
  const shares=parseFloat(document.getElementById('tm-shares').value)||0,date=document.getElementById('tm-date').value;
  const src=document.getElementById('tm-src').value.trim()||'自己分析';
  const pnlRaw=document.getElementById('tm-pnl').value,pnl=pnlRaw!==''?parseFloat(pnlRaw):null;
  if(!tk||!price||!shares) return;
  TRADES.push({id:ntid++,tk,nm,type,price,shares,date,src,pnl});
  ['tm-tk','tm-nm','tm-price','tm-shares','tm-src','tm-pnl'].forEach(i=>document.getElementById(i).value='');
  saveData(); closeTradeModal(); renderLog();
}

// ========== ALERTS (向錢進) ==========
let alFilter='all';
function filterAL(f,btn){alFilter=f;document.querySelectorAll('.al-filter:not(#tradeStatsToggle)').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderAL();}
function toggleTradeStats(btn){const sec=document.getElementById('tradeStatsSection');const open=sec.style.display!=='none';sec.style.display=open?'none':'block';btn.classList.toggle('active',!open);}
const AL_STATUS={watching:{label:'👀 追蹤中',cls:'watching'},holding:{label:'💼 持有中',cls:'holding'},sold_profit:{label:'✅ 獲利出場',cls:'sold_profit'},sold_loss:{label:'❌ 停損出場',cls:'sold_loss'}};

function renderAL(){
  const sumEl=document.getElementById('al-summary');
  if(sumEl){
    const counts={watching:0,holding:0,sold_profit:0,sold_loss:0};
    AL.forEach(a=>{if(counts[a.status]!==undefined)counts[a.status]++;});
    sumEl.innerHTML=Object.entries(counts).map(([s,c])=>c>0?`<div class="al-sum-pill">${AL_STATUS[s].label} ${c}</div>`:'').join('');
  }
  // Top-of-tab stats: only count 持有中 items for $ aggregates.
  // 'shares' / 'avg cost' don't make sense across different stocks, so we
  // show 持有檔數 / 已投入 / 市值 / 未實現損益 instead — all are meaningful
  // when summed across multiple tickers.
  const statsEl=document.getElementById('alStatsGrid');
  if(statsEl){
    const holdings=AL.filter(a=>a.status==='holding'&&a.shares>0&&a.b>0);
    const watchingCnt=AL.filter(a=>a.status==='watching').length;
    const totalCost=holdings.reduce((s,a)=>s+a.b*a.shares,0);
    const mktVal=holdings.reduce((s,a)=>s+(a.p||a.b)*a.shares,0);
    const pnl=mktVal-totalCost;
    const pnlPct=totalCost>0?(pnl/totalCost*100):0;
    const pnlCls=pnl===0?'am':pnl>0?'up':'dn';
    const pnlSign=pnl>=0?'+':'';
    const mktCls=mktVal===totalCost?'am':mktVal>totalCost?'up':'dn';
    statsEl.innerHTML=
      `<div class="stat" data-g="∑"><div class="slbl">持有檔數</div><div class="sval am">${holdings.length}</div><div class="sdelta am">${watchingCnt>0?`追蹤中 ${watchingCnt}`:'—'}</div></div>`+
      `<div class="stat" data-g="$"><div class="slbl">已投入</div><div class="sval am">$${Math.round(totalCost).toLocaleString()}</div><div class="sdelta am">${holdings.length>0?'共 '+holdings.length+' 檔':'—'}</div></div>`+
      `<div class="stat" data-g="$"><div class="slbl">市值</div><div class="sval ${mktCls}">${mktVal?'$'+Math.round(mktVal).toLocaleString():'—'}</div><div class="sdelta ${mktCls}">${totalCost?(mktVal>=totalCost?'▲':'▼')+' vs 投入':'—'}</div></div>`+
      `<div class="stat" data-g="${pnl>=0?'▲':'▼'}"><div class="slbl">未實現損益</div><div class="sval ${pnlCls}">${totalCost?pnlSign+Math.round(pnl).toLocaleString():'—'}</div><div class="sdelta ${pnlCls}">${totalCost?pnlSign+pnlPct.toFixed(1)+'%':'—'}</div></div>`;
  }
  const el=document.getElementById('alist');
  const filtered=alFilter==='all'?AL:AL.filter(a=>a.status===alFilter);
  if(!filtered.length){el.innerHTML=`<div style="font-family:var(--mono);font-size:15px;color:var(--text-dim);padding:24px 0;text-align:center">// 此分類暫無紀錄</div>`;return;}
  el.innerHTML=filtered.map(a=>{
    const st=AL_STATUS[a.status]||AL_STATUS.watching;
    const isSold=a.status==='sold_profit'||a.status==='sold_loss';
    const isHolding=a.status==='holding';
    const isWatching=a.status==='watching';
    // Bar range: 停損 → 停利. If either missing, fall back to ±15% of buy.
    const trackMin=(a.stop&&a.stop>0)?a.stop:a.b*0.85;
    const trackMax=(a.tp&&a.tp>a.b)?a.tp:a.b*1.15;
    const trackRng=trackMax-trackMin;
    const curPos=trackRng>0?Math.min(100,Math.max(0,((a.p||a.b)-trackMin)/trackRng*100)):50;
    const buyPos=trackRng>0?Math.min(100,Math.max(0,(a.b-trackMin)/trackRng*100)):0;
    const nearBuy=a.p&&Math.abs(a.p-a.b)/a.b<=0.03;
    const nearStop=a.p&&a.stop&&a.p<=a.stop*1.05;
    const nearTP=a.p&&a.tp&&a.p>=a.tp*0.97;
    let priceCol='var(--text-primary)';
    if(nearStop)priceCol='var(--red)';else if(nearTP)priceCol='var(--amber)';else if(nearBuy)priceCol='var(--green)';
    let cardAlert='';
    if(nearBuy&&isWatching)cardAlert='price-near-buy';
    if(nearStop&&isHolding)cardAlert='price-near-stop';
    // P&L
    const pnlPerShare=(a.p&&a.b)?(a.p-a.b):0;
    const pnlPct=(a.p&&a.b)?((a.p-a.b)/a.b*100):0;
    const totalPnl=pnlPerShare*(a.shares||0);
    const isProfit=pnlPerShare>=0;
    const pnlColor=isProfit?'var(--green)':'var(--red)';
    // Fill segment represents the buy → current journey
    const fillLeft=Math.min(buyPos,curPos);
    const fillWidth=Math.abs(curPos-buyPos);
    const fillBg=isProfit?'linear-gradient(90deg,rgba(46,204,113,0.55),rgba(46,204,113,0.95))':'linear-gradient(90deg,rgba(231,76,60,0.95),rgba(231,76,60,0.55))';
    const dotCol=isProfit?'var(--green)':'var(--red)';
    // P&L badge (top-right, under status badge)
    let pnlBadge='';
    if(isHolding&&a.p&&a.b){
      const sharesText=a.shares?` · ${a.shares}股`:'';
      pnlBadge=`<div class="al-pnl" style="font-size:14px;color:${pnlColor}">${isProfit?'+':''}${a.shares?'$'+Math.round(totalPnl).toLocaleString():''}${a.shares?' ':''}(${isProfit?'+':''}${pnlPct.toFixed(1)}%)<span style="font-size:11px;color:var(--text-dim);font-weight:400">${sharesText}</span></div>`;
    } else if(isWatching&&a.p&&a.b){
      const dist=pnlPct.toFixed(1);
      const distCol=a.p>a.b?'var(--text-dim)':'var(--green)';
      pnlBadge=`<div class="al-pnl" style="font-size:13px;color:${distCol};font-weight:600">距買 ${a.p>a.b?'+':''}${dist}%</div>`;
    }
    const editBtn=`<button class="al-action-btn" onclick="editAlert(${a.id})">✏️ 編輯</button>`;
    let actions='';
    if(isWatching) actions=`<button class="al-action-btn" onclick="setALStatus(${a.id},'holding')">✅ 標記買進</button>${editBtn}<button class="al-action-btn danger" onclick="delA(${a.id})">刪除</button>`;
    else if(isHolding) actions=`<button class="al-action-btn" onclick="setALStatus(${a.id},'sold_profit')">✅ 獲利出場</button><button class="al-action-btn danger" onclick="setALStatus(${a.id},'sold_loss')">🛑 停損出場</button>${editBtn}<button class="al-action-btn danger" onclick="delA(${a.id})">刪除</button>`;
    else actions=`<button class="al-action-btn" onclick="setALStatus(${a.id},'holding')">↩️ 撤回出場</button>${editBtn}<button class="al-action-btn danger" onclick="delA(${a.id})">刪除</button>`;
    const sharesLabel=a.shares?` ｜ 計劃 ${a.shares.toLocaleString()} 股${a.shares>=1000&&a.shares%1000===0?` (${a.shares/1000} 張)`:a.shares<1000?' (零股)':''}`:'';
    const trackHTML=!isSold&&a.p&&a.b?`<div class="al-track"><div class="al-track-bar"><div class="al-track-fill" style="left:${fillLeft}%;width:${fillWidth}%;background:${fillBg}"></div>${a.stop?`<div class="al-buy-marker" style="left:${buyPos}%"></div>`:''}<div class="al-track-dot" style="left:${curPos}%;background:${dotCol}"></div></div><div style="display:flex;justify-content:space-between;font-size:11px;font-family:var(--mono);margin-top:8px"><span style="color:var(--red)">🛑 停損 $${a.stop||'—'}</span><span style="color:var(--text-secondary)">買 $${a.b} → 現 <span style="color:${pnlColor};font-weight:700">$${a.p}</span></span><span style="color:var(--amber)">🎯 停利 $${a.tp||'—'}</span></div></div>`:'';
    return `<div class="al-card ${st.cls} ${cardAlert}"><div class="al-head"><div class="al-stock"><div class="al-tk">${a.tk} <span style="font-size:15px;font-weight:400;color:var(--text-secondary)">${a.nm}</span></div><div class="al-src">情報來源：${a.src}${sharesLabel}</div></div><div style="text-align:right;flex-shrink:0;margin-left:12px"><div class="al-price-lbl">目前股價</div><div class="al-price-big" style="color:${priceCol}">$${a.p||'—'}</div><div style="margin-top:6px"><span class="al-badge ${st.cls}">${st.label}</span></div>${pnlBadge}</div></div><div class="al-trio"><div class="al-trio-item"><div class="al-trio-lbl">買進價</div><div class="al-trio-val" style="color:var(--green)">$${a.b||'—'}</div></div><div class="al-trio-item"><div class="al-trio-lbl">停利價 🎯</div><div class="al-trio-val" style="color:var(--amber)">$${a.tp||'—'}</div></div><div class="al-trio-item"><div class="al-trio-lbl">停損價 🛑</div><div class="al-trio-val" style="color:var(--red)">$${a.stop||'—'}</div></div></div>${trackHTML}${a.note?`<div class="al-note"><span style="font-size:16px;flex-shrink:0">📖</span>${a.note}</div>`:''}<div class="al-actions">${actions}</div></div>`;
  }).join('');
}

function setALStatus(id,newStatus){
  const a=AL.find(x=>x.id===id); if(!a) return;
  if(newStatus==='sold_profit'||newStatus==='sold_loss'){
    if(!a.exit_price){
      const dflt=a.p||a.b;
      const input=prompt(`賣出價是多少？\n（預設為當前股價 $${dflt}，可改）`, dflt);
      if(input===null) return;
      const px=parseFloat(input);
      if(!px||px<=0){ alert('賣出價必須是大於 0 的數字'); return; }
      a.exit_price=px;
      a.exit_date=new Date().toISOString().split('T')[0];
    }
  } else if(a.status==='sold_profit'||a.status==='sold_loss'){
    delete a.exit_price; delete a.exit_date;
  }
  a.status=newStatus;
  saveData();renderAL();renderTA();renderLog();
}
function clearSrcChips(){document.querySelectorAll('#srcChips .src-chip').forEach(c=>c.classList.remove('selected'));}
function toggleForm(){
  const p=document.getElementById('addpanel');
  p.classList.toggle('open');
  if(p.classList.contains('open')) renderSrcChips('srcChips','fi-src');
  else { clearSrcChips(); resetAlertFormUI(); }
}
let editingAlertId=null;
function resetAlertFormUI(){
  editingAlertId=null;
  const t=document.getElementById('addpanelTitle'); if(t) t.textContent='// NEW · 向錢進';
  const s=document.getElementById('addpanelSubmit'); if(s) s.textContent='確認新增';
}
function editAlert(id){
  const a=AL.find(x=>x.id===id); if(!a) return;
  editingAlertId=id;
  document.getElementById('fi-tk').value=a.tk||'';
  document.getElementById('fi-nm').value=a.nm||'';
  document.getElementById('fi-b').value=a.b||'';
  document.getElementById('fi-tp').value=a.tp||'';
  document.getElementById('fi-stop').value=a.stop||'';
  document.getElementById('fi-shares').value=a.shares||'';
  document.getElementById('fi-src').value=a.src||'';
  document.getElementById('fi-note').value=a.note||'';
  document.getElementById('fi-status').value=a.status||'watching';
  const t=document.getElementById('addpanelTitle'); if(t) t.textContent='// EDIT · 向錢進';
  const s=document.getElementById('addpanelSubmit'); if(s) s.textContent='確認更新';
  const p=document.getElementById('addpanel'); p.classList.add('open');
  renderSrcChips('srcChips','fi-src');
  p.scrollIntoView({behavior:'smooth',block:'center'});
}
function addAlert(){
  const tk=document.getElementById('fi-tk').value.trim();
  const nm=document.getElementById('fi-nm').value.trim();
  const b=parseFloat(document.getElementById('fi-b').value)||0;
  const tp=parseFloat(document.getElementById('fi-tp').value)||0;
  const stop=parseFloat(document.getElementById('fi-stop').value)||0;
  const shares=parseInt(document.getElementById('fi-shares').value)||0;
  const src=document.getElementById('fi-src').value.trim()||'未知來源';
  const note=document.getElementById('fi-note').value.trim();
  const status=document.getElementById('fi-status').value||'watching';
  if(!tk||!b) return;
  if(editingAlertId!==null){
    const a=AL.find(x=>x.id===editingAlertId);
    if(a){ Object.assign(a,{tk,nm:nm||tk,b,tp,stop,shares,src,note,status}); }
  } else {
    const mid=b+(tp-b)*0.3;
    AL.push({id:nid++,tk,nm:nm||tk,b,tp,stop,shares,src,note,status,p:parseFloat(mid.toFixed(1))});
  }
  ['fi-tk','fi-nm','fi-b','fi-tp','fi-stop','fi-shares','fi-src','fi-note'].forEach(i=>{const el=document.getElementById(i);if(el)el.value='';});
  clearSrcChips();
  document.getElementById('addpanel').classList.remove('open');
  resetAlertFormUI();
  saveData(); renderAL(); renderLog();
}
function getDeletedWatchKeys_(){try{return JSON.parse(localStorage.getItem('al_deleted_keys')||'[]');}catch(e){return [];}}
function addDeletedWatchKey_(tk){const keys=getDeletedWatchKeys_();if(!keys.includes(tk)){keys.push(tk);localStorage.setItem('al_deleted_keys',JSON.stringify(keys));}}
function clearDeletedWatchKeys_(){localStorage.removeItem('al_deleted_keys');}
function delA(id){
  const a=AL.find(x=>x.id===id);
  if(!a) return;
  const nm=a.nm||a.tk;
  if(!confirm(`確定要刪除「${a.tk} ${nm}」這筆向錢進嗎？\n\n此操作無法復原（含買進價 / 停利 / 停損 / 筆記都會消失）。`)) return;
  if(a.tk) addDeletedWatchKey_(a.tk);
  AL=AL.filter(x=>x.id!==id);
  saveData();renderAL();renderLog();
}

// ========== MORNING REPORT (synced from LINE push) ==========
function renderMorningReport(){
  const mainEl=document.getElementById('mr-main');
  const sourcesEl=document.getElementById('mr-sources');
  const atEl=document.getElementById('mr-at');
  const sourcesPanel=document.getElementById('mr-sources-panel');
  if(!mainEl) return;

  const r=LAST_MORNING_REPORT;
  if(!r||!r.main){
    mainEl.textContent='尚未產生早報。\n每天 08:30 LINE Bot 自動推送，這裡會同步顯示最新一份。\n你也可以在 Apps Script 手動執行 sendMorningReport() 立即產生。';
    atEl.textContent='—';
    sourcesPanel.style.display='none';
    return;
  }
  mainEl.textContent=r.main;
  if(r.sources){
    sourcesEl.textContent=r.sources;
    sourcesPanel.style.display='';
  } else {
    sourcesPanel.style.display='none';
  }
  if(r.at){
    const d=new Date(r.at);
    atEl.textContent=isNaN(d)?r.at:d.toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  } else {
    atEl.textContent='—';
  }
}

// ========== ALLOCATION HISTORY ==========
const ALLOC_HISTORY_KEY='invest_os_alloc_history';
const ALLOC_MAX_POINTS=180;
function loadAllocHistory(){try{return JSON.parse(localStorage.getItem(ALLOC_HISTORY_KEY)||'[]');}catch(e){return [];}}
function saveAllocSnapshot(c,a,ca,t){
  const h=loadAllocHistory();
  const today=new Date().toISOString().split('T')[0];
  if(h.length&&h[h.length-1].date===today) h[h.length-1]={date:today,core:c,attack:a,cash:ca,total:t};
  else h.push({date:today,core:c,attack:a,cash:ca,total:t});
  if(h.length>ALLOC_MAX_POINTS) h.splice(0,h.length-ALLOC_MAX_POINTS);
  localStorage.setItem(ALLOC_HISTORY_KEY,JSON.stringify(h));
}

function renderAllocChart(history){
  const el=document.getElementById('allocChartWrap');
  if(!el) return;
  if(history.length<2){el.innerHTML=`<div style="font-family:var(--mono);font-size:13px;color:var(--text-dim);text-align:center;padding:20px 0;line-height:1.8">📈 每次更新股價就自動記錄一筆<br><span style="font-size:12px;opacity:0.7">累積 2 天後開始顯示趨勢圖</span></div>`;return;}
  const W=600,HH=120,padT=8,padB=20;
  const n=history.length, chartW=W, chartH=HH-padT-padB;
  const xs=i=>(i/(n-1))*chartW;
  const y=(pct,base)=>padT+chartH-((base+pct)/100*chartH);
  const yb=base=>padT+chartH-(base/100*chartH);
  const cashPoly=history.map((d,i)=>`${xs(i).toFixed(1)},${y(d.cash,0).toFixed(1)}`).join(' ')+` ${xs(n-1).toFixed(1)},${(padT+chartH).toFixed(1)} ${xs(0).toFixed(1)},${(padT+chartH).toFixed(1)}`;
  const attackPoly=history.map((d,i)=>`${xs(i).toFixed(1)},${y(d.attack,d.cash).toFixed(1)}`).join(' ')+' '+[...history].reverse().map((d,i)=>`${xs(n-1-i).toFixed(1)},${yb(d.cash).toFixed(1)}`).join(' ');
  const corePoly=history.map((d,i)=>`${xs(i).toFixed(1)},${y(d.core,d.cash+d.attack).toFixed(1)}`).join(' ')+' '+[...history].reverse().map((d,i)=>`${xs(n-1-i).toFixed(1)},${yb(d.cash+d.attack).toFixed(1)}`).join(' ');
  const coreLine=history.map((d,i)=>`${xs(i).toFixed(1)},${y(d.core,d.cash+d.attack).toFixed(1)}`).join(' ');
  const attackLine=history.map((d,i)=>`${xs(i).toFixed(1)},${y(d.attack,d.cash).toFixed(1)}`).join(' ');
  const labelCount=Math.min(n,5);
  const labelIdxs=Array.from({length:labelCount},(_,i)=>Math.round(i*(n-1)/(labelCount-1)));
  const labels=labelIdxs.map(i=>{const d=new Date(history[i].date);return `<text x="${xs(i).toFixed(1)}" y="${HH-2}" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="10" fill="rgba(240,230,210,0.3)">${(d.getMonth()+1)}/${d.getDate()}</text>`;}).join('');
  const last=history[history.length-1];
  el.innerHTML=`<div style="position:relative"><svg viewBox="0 0 ${W} ${HH}" preserveAspectRatio="none" style="width:100%;height:100px;display:block"><defs><linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffb832" stop-opacity="0.55"/><stop offset="100%" stop-color="#ffb832" stop-opacity="0.15"/></linearGradient><linearGradient id="gAtk" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#00c896" stop-opacity="0.55"/><stop offset="100%" stop-color="#00c896" stop-opacity="0.15"/></linearGradient><linearGradient id="gCore" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5b6cf6" stop-opacity="0.65"/><stop offset="100%" stop-color="#5b6cf6" stop-opacity="0.2"/></linearGradient></defs><polygon points="${cashPoly}" fill="url(#gCash)"/><polygon points="${attackPoly}" fill="url(#gAtk)"/><polygon points="${corePoly}" fill="url(#gCore)"/><polyline points="${attackLine}" fill="none" stroke="rgba(0,200,150,0.6)" stroke-width="1.5"/><polyline points="${coreLine}" fill="none" stroke="rgba(91,108,246,0.7)" stroke-width="1.5"/>${labels}</svg><div style="display:flex;gap:14px;justify-content:center;margin-top:8px"><div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:#5b6cf6"></div><span style="font-family:var(--mono);font-size:11px;color:rgba(240,230,210,0.5)">核心 ${last.core}%</span></div><div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:#00c896"></div><span style="font-family:var(--mono);font-size:11px;color:rgba(240,230,210,0.5)">進攻 ${last.attack}%</span></div><div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:#ffb832"></div><span style="font-family:var(--mono);font-size:11px;color:rgba(240,230,210,0.5)">現金 ${last.cash}%</span></div><div style="display:flex;align-items:center;gap:5px"><span style="font-family:var(--mono);font-size:11px;color:rgba(240,230,210,0.3)">${n} 筆紀錄</span></div></div></div>`;
}

function renderAllocation(){
  const el=document.getElementById('allocBody');
  if(!el || !TOTAL_ASSETS) return;
  const UA=getUnifiedHoldings();
  const core=UA.filter(x=>x.tk==='006208').reduce((s,x)=>s+(x.p||x.c)*x.s,0);
  const otherHoldings=UA.filter(x=>x.tk!=='006208').reduce((s,x)=>s+(x.p||x.c)*x.s,0);
  const invested=core+otherHoldings;
  const cash=(CASH_OVERRIDE!==null&&CASH_OVERRIDE>=0)?CASH_OVERRIDE:Math.max(0,TOTAL_ASSETS-invested);
  const total=TOTAL_ASSETS;
  const corePct=Math.round(core/total*100);
  const attackPct=Math.round(otherHoldings/total*100);
  const cashPct=Math.round(cash/total*100);
  const layers=[
    {label:'核心防禦（006208）',pct:corePct,val:core,color:'#5b6cf6',desc:'負責穩健成長，不可隨意賣出'},
    {label:'向錢進（進攻部位）',pct:attackPct,val:otherHoldings,color:'#00c896',desc:'負責波段操作，嚴格執行停利與停損'},
    {label:'戰略預備金（現金）',pct:cashPct,val:cash,color:'#ffb832',desc:'保留子彈，大跌時才有資金加碼 006208'},
  ];
  if(total>0&&UA.length>0) saveAllocSnapshot(corePct,attackPct,cashPct,total);
  renderAllocChart(loadAllocHistory());
  let tip='';
  if(cashPct>=15) tip=`現金水位 ${cashPct}% 充足，遇大跌可以果斷加碼，保持這個配置！`;
  else if(cashPct>=8) tip=`現金水位 ${cashPct}%，稍有餘裕。若市場大幅修正，仍有空間逢低布局。`;
  else tip=`現金水位 ${cashPct}% 偏低，注意風險集中。建議保留至少 10% 作為應急子彈。`;
  el.innerHTML=layers.map(l=>`<div class="alloc-row"><div class="alloc-head"><span class="alloc-label">${l.label}</span><div style="display:flex;align-items:center;gap:8px"><span class="alloc-pct" style="color:${l.color}">${l.pct}%</span><span style="font-family:var(--mono);font-size:13px;color:var(--text-dim)">$${Math.round(l.val).toLocaleString()}</span></div></div><div class="alloc-bar-track"><div class="alloc-bar-fill" style="width:${l.pct}%;background:${l.color}"></div></div><div class="alloc-desc">${l.desc}</div></div>`).join('')+`<div class="alloc-total" style="cursor:default"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><div class="alloc-total-lbl" style="margin-bottom:0">總資產規模（含現金）</div><div style="display:flex;gap:6px"><button onclick="editTotalAssets()" style="font-family:var(--mono);font-size:11px;padding:3px 10px;background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text-dim);border-radius:4px;cursor:pointer">✏ 修改</button><button onclick="clearAllocHistory()" style="font-family:var(--mono);font-size:11px;padding:3px 10px;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text-dim);border-radius:4px;cursor:pointer" title="清除配置歷史紀錄">↺</button></div></div><div id="allocTotalInline"><div class="alloc-total-val">NT$ ${total.toLocaleString()}</div></div><div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between"><div style="font-family:var(--mono);font-size:13px;color:var(--text-dim)">現金子彈</div><div style="display:flex;align-items:center;gap:8px"><span style="font-family:var(--mono);font-size:16px;font-weight:700;color:${cashPct<8?'var(--red)':cashPct<15?'var(--amber)':'var(--green)'}">NT$ ${Math.round(cash).toLocaleString()}</span><button onclick="editCash()" style="font-family:var(--mono);font-size:11px;padding:3px 10px;background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text-dim);border-radius:4px;cursor:pointer">✏</button></div></div><div class="alloc-tip" style="margin-top:10px"><span style="font-size:16px;flex-shrink:0">📖</span>${tip}</div></div>`;
}

function clearAllocHistory(){if(!confirm('清除所有配置歷史紀錄？')) return;localStorage.removeItem(ALLOC_HISTORY_KEY);renderAllocation();}

// ========== ONBOARDING ==========
function showOnboarding(){document.getElementById('onboarding').style.display='block';obAddHolding();}
function obAddHolding(tk='',nm='',shares='',cost='',buy=''){
  const id='oh_'+Date.now()+Math.random().toString(36).slice(2,5);
  const row=document.createElement('div');
  row.className='ob-holding-row';row.id=id;
  row.innerHTML=`<input class="finput" placeholder="代號" value="${tk}" oninput="autoName(this.value,'${id}_nm')" style="font-size:13px"><input class="finput" id="${id}_nm" placeholder="名稱（自動）" value="${nm}" style="font-size:13px"><input class="finput" type="number" placeholder="股數" value="${shares}" style="font-size:13px"><input class="finput" type="number" placeholder="成本" value="${cost}" style="font-size:13px"><input class="finput" type="number" placeholder="買提醒" value="${buy}" style="font-size:13px"><button onclick="document.getElementById('${id}').remove()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:18px;padding:0 4px">✕</button>`;
  document.getElementById('ob-holdings').appendChild(row);
}

function obFinish(){
  const total=parseFloat(document.getElementById('ob-total').value)||0;
  if(!total){alert('請填入總資產金額');return;}
  TOTAL_ASSETS=total;
  H=[];
  document.querySelectorAll('#ob-holdings .ob-holding-row').forEach(row=>{
    const inputs=row.querySelectorAll('input');
    const tk=inputs[0].value.trim(), nm=inputs[1].value.trim();
    const s=parseInt(inputs[2].value)||0, c=parseFloat(inputs[3].value)||0, b=parseFloat(inputs[4].value)||0;
    if(tk&&s&&c) H.push({tk,nm:nm||tk,p:c,c,s,b:b||0,sl:0});
  });
  AL=[];TRADES=[];DCA_ENTRIES=[];DCA_META={};DCA_PLANS=[];nid=1;ntid=1;dcaNextId=1;dcaPlanNextId=1;
  saveData();
  document.getElementById('onboarding').style.display='none';
  renderAll();
}

function obSkip(){
  TOTAL_ASSETS=600000;
  H=[{tk:'006208',nm:'富邦台50',p:118.5,c:105,s:500,b:110,sl:135}];
  AL=[];TRADES=[];DCA_ENTRIES=[];DCA_META={};DCA_PLANS=[];nid=1;ntid=1;dcaNextId=1;dcaPlanNextId=1;
  saveData();
  document.getElementById('onboarding').style.display='none';
  renderAll();
}

// ========== SETTINGS DATA ==========
function renderSettingsData(){
  renderSettingsSrcChips();
  renderBackupFolderStatus();
  const cfgTotal=document.getElementById('cfg-total');
  if(cfgTotal) cfgTotal.value=TOTAL_ASSETS||'';
  const cloudInput=document.getElementById('cloud-api-url');
  if(cloudInput) cloudInput.value=getCloudUrl();
  const el=document.getElementById('cfg-holdings-list');
  if(!el) return;
  if(!H.length){el.innerHTML='<div style="font-family:var(--mono);font-size:13px;color:var(--text-dim);padding:8px 0">尚無持倉</div>';return;}
  el.innerHTML=H.map((h,i)=>`<div class="cfg-h-row"><div style="flex:1;min-width:0"><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--text-primary)">${h.tk} <span style="font-weight:400;color:var(--text-secondary)">${h.nm}</span></div><div style="font-size:13px;color:var(--text-dim);margin-top:2px">${h.s}股 · 成本 $${h.c} · 現價 $${h.p}</div></div><button onclick="editHolding(${i})" style="font-family:var(--mono);font-size:12px;padding:4px 10px;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:var(--text-secondary);border-radius:4px;cursor:pointer;flex-shrink:0">編輯</button><button onclick="deleteHolding(${i})" style="font-family:var(--mono);font-size:12px;padding:4px 10px;background:rgba(255,69,96,0.1);border:1px solid rgba(255,69,96,0.25);color:var(--red);border-radius:4px;cursor:pointer;flex-shrink:0">刪除</button></div>`).join('');
}

function saveTotalAssets(){const v=parseFloat(document.getElementById('cfg-total').value)||0;if(!v)return;TOTAL_ASSETS=v;saveData();renderAll();renderSettingsData();}
function openAddHoldingModal(){
  const tk=prompt('股票代號（如 2330）');
  if(!tk) return;
  const nm=STOCK_NAMES[tk.trim()]||prompt('股票名稱')||tk;
  const s=parseInt(prompt('持有股數'))||0;
  const c=parseFloat(prompt('平均成本價'))||0;
  const b=parseFloat(prompt('買入提醒價（可空白）')||'0')||0;
  const sl=parseFloat(prompt('賣出提醒價（可空白）')||'0')||0;
  if(!tk||!s||!c) return;
  H.push({tk:tk.trim(),nm,p:c,c,s,b,sl});
  saveData();renderAll();renderSettingsData();
}
function editHolding(i){
  const h=H[i];
  const s=parseInt(prompt('持有股數',h.s))||h.s;
  const c=parseFloat(prompt('平均成本',h.c))||h.c;
  const b=parseFloat(prompt('買入提醒價',h.b)||'0')||0;
  const sl=parseFloat(prompt('賣出提醒價',h.sl)||'0')||0;
  H[i]={...H[i],s,c,b,sl};
  saveData();renderAll();renderSettingsData();
}
function deleteHolding(i){if(!confirm(`確定刪除 ${H[i].tk} ${H[i].nm}？`))return;H.splice(i,1);saveData();renderAll();renderSettingsData();}
function clearAllData(){if(!confirm('確定清除所有資料？這個動作不可復原。'))return;localStorage.removeItem('invest_os_data');TOTAL_ASSETS=0;H=[];AL=[];TRADES=[];DCA_ENTRIES=[];DCA_META={};DCA_PLANS=[];nid=1;ntid=1;dcaNextId=1;dcaPlanNextId=1;renderAll();renderSettingsData();showOnboarding();}
function _bkpDB(){return new Promise((res,rej)=>{const r=indexedDB.open('invest_os',1);r.onupgradeneeded=()=>r.result.createObjectStore('handles');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function _saveBkpHandle(h){const db=await _bkpDB();return new Promise((res,rej)=>{const tx=db.transaction('handles','readwrite');tx.objectStore('handles').put(h,'backup_dir');tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
async function _loadBkpHandle(){try{const db=await _bkpDB();return new Promise((res,rej)=>{const tx=db.transaction('handles','readonly');const req=tx.objectStore('handles').get('backup_dir');req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});}catch{return null;}}
async function _verifyBkpPerm(h){const o={mode:'readwrite'};if(await h.queryPermission(o)==='granted')return true;return await h.requestPermission(o)==='granted';}
async function pickBackupFolder(){
  if(!window.showDirectoryPicker){alert('你的瀏覽器不支援此功能，請用 Chrome / Edge / Safari 15.2+');return;}
  try{const h=await window.showDirectoryPicker({mode:'readwrite'});await _saveBkpHandle(h);renderBackupFolderStatus();alert('已綁定備份資料夾：'+h.name);}
  catch(e){if(e.name!=='AbortError')alert('選擇失敗：'+e.message);}
}
async function renderBackupFolderStatus(){
  const el=document.getElementById('bkpFolderStatus');if(!el)return;
  const h=await _loadBkpHandle();
  if(h){el.textContent='📁 '+h.name+' （已綁定）';el.style.color='var(--green)';}
  else{el.textContent='(尚未選定 — 下載到瀏覽器預設位置)';el.style.color='var(--text-dim)';}
}
async function exportData(){
  const data=JSON.stringify({TOTAL_ASSETS,H,AL,TRADES,DCA_PLANS,DCA_META},null,2);
  const filename='invest_os_backup_'+new Date().toISOString().split('T')[0]+'.json';
  try{
    const h=await _loadBkpHandle();
    if(h && await _verifyBkpPerm(h)){
      const fh=await h.getFileHandle(filename,{create:true});
      const w=await fh.createWritable();await w.write(data);await w.close();
      alert('✓ 已存到 '+h.name+'/'+filename);
      return;
    }
  }catch(e){console.warn('Folder save failed, falling back to download:',e);}
  const blob=new Blob([data],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();
}

// ========== INLINE EDIT ==========
function editTotalAssets(){
  const cur=TOTAL_ASSETS||0;
  const el=document.getElementById('allocTotalInline');
  if(!el){const v=parseFloat(prompt('總資產金額（含現金）',cur));if(!isNaN(v)&&v>0){TOTAL_ASSETS=v;saveData();renderAll();}return;}
  el.innerHTML=`<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span style="font-family:var(--mono);font-size:16px;color:var(--text-secondary)">NT$</span><input id="edit-total-input" type="number" value="${cur}" style="flex:1;font-family:var(--mono);font-size:22px;font-weight:700;background:rgba(255,255,255,0.06);border:1px solid var(--amber);border-radius:6px;color:var(--amber);padding:6px 10px;outline:none" onkeydown="if(event.key==='Enter')confirmEditTotal();if(event.key==='Escape')cancelEditTotal()"><button onclick="confirmEditTotal()" style="padding:6px 14px;background:rgba(255,184,50,0.2);border:1px solid var(--amber);color:var(--amber);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:13px;white-space:nowrap">確認</button><button onclick="cancelEditTotal()" style="padding:6px 10px;background:none;border:1px solid var(--border);color:var(--text-dim);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:13px">✕</button></div>`;
  setTimeout(()=>document.getElementById('edit-total-input')?.focus(),50);
}
function confirmEditTotal(){const v=parseFloat(document.getElementById('edit-total-input')?.value);if(!isNaN(v)&&v>0){TOTAL_ASSETS=v;saveData();renderAll();const cfgEl=document.getElementById('cfg-total');if(cfgEl)cfgEl.value=v;}else cancelEditTotal();}
function cancelEditTotal(){renderAllocation();}

function loadCashOverride(){const v=localStorage.getItem('invest_os_cash');return v!==null?parseFloat(v):null;}
function saveCashOverride(val){if(val===null)localStorage.removeItem('invest_os_cash');else localStorage.setItem('invest_os_cash',String(val));}
let CASH_OVERRIDE=loadCashOverride();
function editCash(){
  const invested=H.reduce((s,x)=>s+x.p*x.s,0);
  const autoCash=Math.max(0,TOTAL_ASSETS-invested);
  const cur=CASH_OVERRIDE!==null?CASH_OVERRIDE:autoCash;
  const el=document.getElementById('allocBody');
  if(!el) return;
  const existing=document.getElementById('cash-edit-row');
  if(existing){existing.remove();return;}
  const row=document.createElement('div');
  row.id='cash-edit-row';
  row.style.cssText='margin-top:12px;padding:12px;background:rgba(255,184,50,0.06);border:1px solid rgba(255,184,50,0.25);border-radius:8px';
  row.innerHTML=`<div style="font-family:var(--mono);font-size:12px;color:var(--amber);letter-spacing:1px;margin-bottom:10px">✏ 修改現金子彈</div><div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">自動計算：NT$ ${Math.round(autoCash).toLocaleString()}（總資產 - 持倉市值）<br>如果你另外有備用現金，可以手動覆蓋。</div><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><span style="font-family:var(--mono);font-size:15px;color:var(--text-secondary)">NT$</span><input id="cash-edit-input" type="number" value="${Math.round(cur)}" style="flex:1;font-family:var(--mono);font-size:18px;background:rgba(255,255,255,0.06);border:1px solid var(--amber);border-radius:6px;color:var(--amber);padding:6px 10px;outline:none" onkeydown="if(event.key==='Enter')confirmEditCash();if(event.key==='Escape')cancelEditCash()"></div><div style="display:flex;gap:8px"><button onclick="confirmEditCash()" style="flex:1;padding:8px;background:rgba(255,184,50,0.2);border:1px solid var(--amber);color:var(--amber);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:13px">確認</button><button onclick="resetCashAuto()" style="flex:1;padding:8px;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text-dim);border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:13px">恢復自動計算</button><button onclick="cancelEditCash()" style="padding:8px 12px;background:none;border:none;color:var(--text-dim);cursor:pointer;font-family:var(--mono)">✕</button></div>`;
  el.appendChild(row);
  setTimeout(()=>document.getElementById('cash-edit-input')?.focus(),50);
}
function confirmEditCash(){const v=parseFloat(document.getElementById('cash-edit-input')?.value);if(!isNaN(v)&&v>=0){CASH_OVERRIDE=v;saveCashOverride(v);}cancelEditCash();renderAllocation();}
function resetCashAuto(){CASH_OVERRIDE=null;saveCashOverride(null);cancelEditCash();renderAllocation();}
function cancelEditCash(){document.getElementById('cash-edit-row')?.remove();}

// ========== HINTS ==========
const HINTS={
  alloc:{icon:'🎯',title:'資產配置（核心-衛星策略）',body:`把錢分三層：<br><br><strong>🔵 核心防禦（006208）</strong>：長期 ETF，<strong>佔 60-70%</strong>。<br><strong>🟢 向錢進進攻</strong>：個股波段，<strong>佔 20-30%</strong>，嚴守停利停損。<br><strong>🟡 現金子彈</strong>：<strong>10-15%</strong> 不動用，等大跌加碼。`},
  holdings:{icon:'📊',title:'持倉明細',body:`現價 = Finmind 抓的延遲約 10 分鐘股價。損益 = (現價 − 成本) × 股數。<br>進度條代表現價在「買入提醒」和「賣出提醒」之間的位置。<br>提醒價 ±3% 內會閃爍。`},
  'alerts-today':{icon:'🔔',title:'今日觸發提醒',body:`只是提醒，不是建議。搭配 AI 日報看市場背景再決定。`},
  concentration:{icon:'🍩',title:'持倉集中度',body:`單一股票太多風險就大。<span class="hint-tag hint-tag-r">>30%</span> 過高 / <span class="hint-tag hint-tag-a">20–30%</span> 偏高 / <span class="hint-tag hint-tag-g"><20%</span> OK。`},
  stress:{icon:'💥',title:'壓力測試',body:`某支跌 10/20/30% 對總資產衝擊。超過 5% 要小心，注意停損。`},
  stoploss:{icon:'🛑',title:'停損價',body:`保護本金用，不是賣出目標價。設好就要執行，不要往下調。`},
  sizing:{icon:'⚖️',title:'倉位大小',body:`<strong>單筆最大虧損 ≤ 總資產 2%</strong>。從停損點反推最大買幾股。`},
  dca:{icon:'📅',title:'定期定額',body:`月月固定金額買，自動平滑成本。黃線=每次成交價，綠虛線=累計平均。`},
  watchlist:{icon:'🎯',title:'向錢進',body:`設好買進/停利/停損，到價無腦執行。狀態：👀追蹤 → 💼持有 → ✅/❌出場。`},
  winrate:{icon:'📈',title:'來源勝率',body:`每個消息來源帶來的交易勝率。50%+ 值得參考、50%- 要小心。`},
  trades:{icon:'📝',title:'交易記錄',body:`重點不在賺多少，在於回顧決策品質。記錄消息來源，幾個月後數據說話。`},
  aireport:{icon:'🤖',title:'AI 日報',body:`針對你的持倉做個人化分析。AI 僅供參考，最終決策還是你自己。`}
};
let _hintCurrentBtn=null;
function showHint(key,ev){
  const h=HINTS[key];if(!h)return;
  if(ev){ev.stopPropagation();}
  const pop=document.getElementById('hintPop');
  document.getElementById('hintPopIcon').textContent=h.icon;
  document.getElementById('hintPopTitle').textContent=h.title;
  document.getElementById('hintPopBody').innerHTML=h.body;
  const btn=ev&&ev.target;
  if(btn===_hintCurrentBtn&&pop.classList.contains('open')){closeHint();return;}
  _hintCurrentBtn=btn;
  pop.classList.add('open');
  if(btn){
    const r=btn.getBoundingClientRect();
    const popW=Math.min(280,window.innerWidth-24);
    pop.style.width=popW+'px';
    let left=r.left+window.scrollX+(r.width/2)-(popW/2);
    if(left<12)left=12;
    if(left+popW>window.innerWidth-12)left=window.innerWidth-popW-12;
    const top=r.bottom+window.scrollY+10;
    pop.style.left=left+'px';
    pop.style.top=top+'px';
    const arrow=document.getElementById('hintPopArrow');
    if(arrow){
      const arrowLeft=r.left+window.scrollX+(r.width/2)-left-6;
      arrow.style.left=Math.max(12,Math.min(popW-18,arrowLeft))+'px';
    }
  }
  setTimeout(()=>document.addEventListener('click',_hintOutsideClose,{once:true}),0);
}
function _hintOutsideClose(e){
  const pop=document.getElementById('hintPop');
  if(pop.contains(e.target)||(e.target.classList&&e.target.classList.contains('hint-btn'))){
    document.addEventListener('click',_hintOutsideClose,{once:true});
    return;
  }
  closeHint();
}
function closeHint(){
  const pop=document.getElementById('hintPop');
  if(pop)pop.classList.remove('open');
  _hintCurrentBtn=null;
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeHint();});

// ========== SOURCES ==========
function loadSources(){try{return JSON.parse(localStorage.getItem('invest_os_sources')||'null');}catch(e){return null;}}
function saveSources(){localStorage.setItem('invest_os_sources',JSON.stringify(SOURCES));}
let SOURCES=loadSources()||['定期定額','自己分析'];
function renderSrcChips(chipsId,inputId){
  const el=document.getElementById(chipsId);if(!el)return;
  el.innerHTML=SOURCES.map(s=>`<div class="src-chip" onclick="pickSrcGeneric(this,'${inputId}','${chipsId}')" data-val="${s}">${s}<span onclick="deleteSrc(event,'${s}','${chipsId}','${inputId}')" style="margin-left:5px;opacity:0.45;font-size:12px">✕</span></div>`).join('');
}
function renderAllSrcChips(){renderSrcChips('srcChips','fi-src');renderSrcChips('tmSrcChips','tm-src');}
function pickSrcGeneric(el,inputId,chipsId){document.querySelectorAll('#'+chipsId+' .src-chip').forEach(c=>c.classList.remove('selected'));el.classList.add('selected');const inp=document.getElementById(inputId);if(inp)inp.value=el.dataset.val;}
function addSrcQuick(inputId){const inp=document.getElementById(inputId);if(!inp)return;const val=inp.value.trim();if(!val||SOURCES.includes(val))return;SOURCES.unshift(val);saveSources();renderAllSrcChips();setTimeout(()=>{const chipsId=inputId==='fi-src'?'srcChips':'tmSrcChips';const chips=document.querySelectorAll('#'+chipsId+' .src-chip');if(chips[0])chips[0].classList.add('selected');},10);}
function deleteSrc(e,val,chipsId,inputId){e.stopPropagation();if(!confirm(`刪除快選「${val}」？`))return;SOURCES=SOURCES.filter(s=>s!==val);saveSources();renderAllSrcChips();const inp=document.getElementById(inputId);if(inp&&inp.value===val)inp.value='';}
function renderSettingsSrcChips(){const el=document.getElementById('settingsSrcChips');if(!el)return;el.innerHTML=SOURCES.map(s=>`<div class="src-chip" style="cursor:default">${s}<span onclick="deleteSettingsSrc('${s}')" style="margin-left:5px;opacity:0.5;cursor:pointer;font-size:12px">✕</span></div>`).join('')||'<span style="font-family:var(--mono);font-size:13px;color:var(--text-dim)">尚無自訂來源</span>';}
function addSrcFromSettings(){const inp=document.getElementById('settings-src-input');if(!inp)return;const val=inp.value.trim();if(!val||SOURCES.includes(val)){inp.value='';return;}SOURCES.unshift(val);saveSources();inp.value='';renderSettingsSrcChips();renderAllSrcChips();}
function deleteSettingsSrc(val){SOURCES=SOURCES.filter(s=>s!==val);saveSources();renderSettingsSrcChips();renderAllSrcChips();}


// ========== STOCK NAMES (compact) ==========
const STOCK_NAMES={
// ETF
'0050':'元大台灣50','0056':'元大高股息','006208':'富邦台50','00646':'元大S&P500','00662':'富邦NASDAQ',
'00679B':'元大美債20年','00692':'富邦公司治理','00713':'元大台灣高息低波','00733':'富邦臺灣中小','00757':'統一FANG+',
'00830':'國泰費城半導體','00850':'元大臺灣ESG永續','00878':'國泰永續高股息','00881':'國泰台灣5G+','00891':'中信關鍵半導體',
'00892':'富邦台灣半導體','00893':'國泰智能電動車','00895':'富邦未來車','00900':'富邦特選高股息30','00904':'新光臺灣半導體30',
'00905':'FT臺灣Smart','00908':'富邦入息REITs+','00919':'群益台灣精選高息','00922':'國泰台灣領袖50','00923':'群益台ESG低碳50',
'00929':'復華台灣科技優息','00930':'永豐ESG低碳高息40','00935':'野村臺灣優選','00939':'統一台灣高息動能','00940':'元大台灣價值高息',
'00946':'群益科技高息成長',
// 1xxx 傳產 / 食品 / 塑化 / 紡織 / 化工
'1101':'台泥','1216':'統一','1227':'佳格','1234':'黑松','1301':'台塑','1303':'南亞','1304':'台聚','1314':'中石化',
'1326':'台化','1402':'遠東新','1455':'集盛','1605':'華新','1717':'長興','1722':'台肥','1762':'中化生',
// 2xxx 鋼鐵 / 紡織 / 電子 / 半導體 / 金融 / 航運 / 食品 / 通訊
'2002':'中鋼','2009':'第一銅','2027':'大成鋼','2049':'上銀','2059':'川湖','2105':'正新','2206':'三陽工業','2207':'和泰車','2228':'劍麟',
'2301':'光寶科','2303':'聯電','2308':'台達電','2317':'鴻海','2327':'國巨','2329':'華泰','2330':'台積電','2337':'旺宏','2344':'華邦電',
'2347':'聯強','2353':'宏碁','2354':'鴻準','2356':'英業達','2357':'華碩','2360':'致茂','2363':'矽統','2371':'大同','2376':'技嘉',
'2377':'微星','2379':'瑞昱','2380':'虹光','2382':'廣達','2383':'台光電','2385':'群光','2395':'研華','2408':'南亞科','2409':'友達',
'2412':'中華電','2417':'圓剛','2421':'建準','2439':'美律','2449':'京元電子','2451':'創見','2454':'聯發科','2458':'義隆','2465':'麗臺',
'2467':'志聖','2474':'可成','2492':'華新科',
'2542':'興富發','2603':'長榮','2606':'裕民','2609':'陽明','2610':'華航','2615':'萬海','2618':'長榮航',
'2723':'美食-KY','2727':'王品',
'2823':'中壽','2855':'統一證','2880':'華南金','2881':'富邦金','2882':'國泰金','2883':'開發金','2884':'玉山金','2885':'元大金',
'2886':'兆豐金','2887':'台新金','2890':'永豐金','2891':'中信金','2892':'第一金','2912':'統一超',
// 3xxx 電子 / 半導體 / 通訊
'3005':'神基','3008':'大立光','3014':'聯陽','3017':'奇鋐','3019':'亞光','3030':'德律','3034':'聯詠','3035':'智原','3037':'欣興','3041':'揚智',
'3045':'台灣大','3105':'穩懋','3231':'緯創','3260':'威剛','3406':'玉晶光','3413':'京鼎','3443':'創意','3530':'晶相光','3552':'同致','3596':'智易','3653':'健策',
'3661':'世芯-KY','3702':'大聯大',
// 4xxx 生技 / 化工 / 通訊
'4128':'中天','4174':'浩鼎','4737':'華廈','4763':'材料-KY','4904':'遠傳','4938':'和碩','4961':'天鈺','4977':'眾達-KY',
// 5xxx 金融 / 半導體 / 食品 / 建設
'5306':'桂盟','5483':'中美晶','5522':'遠雄','5871':'中租-KY','5876':'上海商銀','5880':'合庫金',
// 6xxx 電子 / 半導體 / 軟體 / 生技
'6005':'群益證','6121':'新普','6176':'瑞儀','6196':'帆宣','6213':'聯茂','6239':'力成','6271':'同欣電','6285':'啟碁','6409':'旭隼','6415':'矽力-KY','6443':'元晶','6446':'藥華藥',
'6488':'環球晶','6505':'台塑化','6515':'穎崴','6531':'愛普','6533':'晶心科','6669':'緯穎','6770':'力積電',
// 8xxx 半導體 / 電子
'8044':'網家','8069':'元太','8081':'致新','8086':'宏捷科','8210':'勤誠','8261':'富鼎',
// 9xxx 自行車 / 餐飲 / 工程
'9914':'美利達','9921':'巨大','9933':'中鼎','9941':'裕融','9942':'茂順'
};
let _autoNameTimer=null;
function _readNameCache(){try{return JSON.parse(localStorage.getItem('stock_name_cache')||'{}');}catch(e){return {};}}
function _writeNameCache(tk,nm){try{const c=_readNameCache();c[tk]=nm;localStorage.setItem('stock_name_cache',JSON.stringify(c));}catch(e){}}
function autoName(tk,targetId){
  tk=tk.trim();
  const el=document.getElementById(targetId);
  if(!el) return;
  let nm=STOCK_NAMES[tk];
  if(!nm){const src=[...H,...AL,...DCA_PLANS,...TRADES].find(x=>x.tk===tk);if(src)nm=src.nm;}
  if(!nm){const c=_readNameCache();if(c[tk])nm=c[tk];}
  if(nm){el.value=nm;el.style.color='var(--green)';setTimeout(()=>{el.style.color='';},1000);return;}
  // Fall through to backend Yahoo lookup if local sources didn't have it.
  if(_autoNameTimer)clearTimeout(_autoNameTimer);
  if(!getCloudUrl()||tk.length<4)return;
  _autoNameTimer=setTimeout(async()=>{
    try{
      const res=await fetch(getCloudUrl()+'?action=name&tk='+encodeURIComponent(tk)+'&key='+encodeURIComponent(getCloudApiKey()));
      if(!res.ok)return;
      const data=await res.json();
      if(!data.name)return;
      _writeNameCache(tk,data.name);
      const elNow=document.getElementById(targetId);
      if(elNow&&!elNow.value.trim()){
        elNow.value=data.name;
        elNow.style.color='var(--amber)';
        setTimeout(()=>{elNow.style.color='';},1500);
      }
    }catch(e){console.warn('autoName fetch failed:',e);}
  },500);
}

// ========== DCA PLAN ==========
// Snapshot model: create or update one plan per (ticker+owner).
// Mirrors the broker app's holding screen — no per-month entries.
function addDCA(){
  const tk=document.getElementById('dca-tk').value.trim();
  const nm=document.getElementById('dca-nm').value.trim()||STOCK_NAMES[tk]||tk;
  const owner=(document.getElementById('dca-owner').value||'').trim()||'自己';
  const amount=parseInt(document.getElementById('dca-amt').value)||0;
  const day=Math.min(28,Math.max(1,parseInt(document.getElementById('dca-day').value)||15));
  const totalShares=parseInt(document.getElementById('dca-shares').value)||0;
  const avgCost=parseFloat(document.getElementById('dca-cost').value)||0;
  if(!tk) return;
  if(editingPlanId!==null){
    const p=DCA_PLANS.find(x=>x.id===editingPlanId);
    if(p) Object.assign(p,{tk,nm,owner,amount,day,totalShares,avgCost});
  } else {
    DCA_PLANS.push({id:dcaPlanNextId++,tk,nm,owner,amount,day,totalShares,avgCost});
  }
  document.getElementById('dcaForm').style.display='none';
  document.getElementById('dcaFormArrow').textContent='▼';
  resetDcaFormUI();
  saveData(); renderDCA();
}

// ========== INIT ==========
function renderAll(){renderH();renderTA();renderAL();renderLog();renderRisk();renderDCA();renderAllocation();renderSettingsData();renderAllSrcChips();renderSummaryStats();renderMorningReport();}

function showCloudSetup(){ document.getElementById('cloud-setup').style.display='block'; }
function hideCloudSetup(){ document.getElementById('cloud-setup').style.display='none'; }

async function doCloudSetup(){
  const url=(document.getElementById('setup-url').value||'').trim();
  const rawKey=(document.getElementById('setup-key').value||'').trim();
  const key=rawKey||DEFAULT_API_KEY;
  const msgEl=document.getElementById('setup-msg');
  const btn=document.getElementById('setup-btn');
  if(!url.startsWith('https://')){
    msgEl.style.color='var(--red)';msgEl.textContent='⚠ 請貼上完整的 https:// 網址';return;
  }
  btn.disabled=true;btn.textContent='連接中…';
  msgEl.style.color='var(--text-dim)';msgEl.textContent='';
  try{
    const res=await fetch(url+'?key='+encodeURIComponent(key));
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    if(data.error) throw new Error(data.error);
    setCloudUrl(url);setCloudApiKey(key);
    const merged=cloudToLocal_(data);
    TOTAL_ASSETS=merged.TOTAL_ASSETS;H=merged.H;AL=merged.AL;TRADES=merged.TRADES;DCA_ENTRIES=merged.DCA_ENTRIES;DCA_PLANS=merged.DCA_PLANS;
    nid=merged.nid;ntid=merged.ntid;dcaNextId=merged.dcaNextId;dcaPlanNextId=merged.dcaPlanNextId;
    saveData();
    msgEl.style.color='var(--green)';msgEl.textContent='✓ 連接成功！';
    setCloudStatus('🟢 已連動 Google Sheet');
    setTimeout(()=>{ hideCloudSetup(); renderAll(); },700);
  }catch(e){
    btn.disabled=false;btn.textContent='連接 →';
    msgEl.style.color='var(--red)';
    const em=e.message;
    msgEl.textContent=em==='unauthorized'?'✗ 密碼錯誤，請確認 api_key':'✗ 連接失敗：'+em;
  }
}

function skipCloudSetup(){
  localStorage.setItem('cloud_setup_skipped','1');
  hideCloudSetup();
  if(!loadData()) showOnboarding(); else renderAll();
}

async function bootstrap(){
  if(!getCloudUrl()&&!localStorage.getItem('cloud_setup_skipped')){
    showCloudSetup();return;
  }
  // If local has unpushed changes, don't let the cloud pull overwrite them.
  // Try to push them up first, then continue with local state.
  if (getCloudUrl() && localStorage.getItem('invest_os_dirty')) {
    setCloudStatus('🟡 偵測到未同步資料，重試推送…');
    const ok = await saveToCloud();
    if (ok) {
      localStorage.removeItem('invest_os_dirty');
      setCloudStatus('🟢 已同步至 Google Sheet');
    } else {
      setCloudStatus('🔴 仍無法同步，本機保留');
    }
    if (loadData()) { renderAll(); return; }
  }
  const cloud = await loadFromCloud();
  if (cloud) {
    TOTAL_ASSETS = cloud.TOTAL_ASSETS;
    H = cloud.H; AL = cloud.AL; TRADES = cloud.TRADES; DCA_ENTRIES = cloud.DCA_ENTRIES; DCA_PLANS = cloud.DCA_PLANS;
    nid = cloud.nid; ntid = cloud.ntid; dcaNextId = cloud.dcaNextId; dcaPlanNextId = cloud.dcaPlanNextId;
    saveData();
    setCloudStatus('🟢 已連動 Google Sheet');
    updateLastSync_();
    renderAll();
    return;
  }
  if (loadData()) {
    setCloudStatus(getCloudUrl() ? '🟡 雲端讀取失敗，用本機快取' : '⚪ 未連動雲端');
    renderAll();
  } else {
    showOnboarding();
  }
}

function setCloudStatus(msg){
  const el = document.getElementById('cloudStatus');
  if (el) el.textContent = msg;
}
function updateLastSync_(){
  const now=new Date();
  const el=document.getElementById('lastUpdateStat');
  if(!el) return;
  const z=v=>String(v).padStart(2,'0');
  el.textContent=`${z(now.getMonth()+1)}/${z(now.getDate())} ${z(now.getHours())}:${z(now.getMinutes())}`;
}

async function manualSync(){
  setCloudStatus('🔄 同步中…');
  const ok = await saveToCloud();
  if (ok) {
    setCloudStatus('🟢 已同步至 Google Sheet');
    setTimeout(() => setCloudStatus('🟢 已連動 Google Sheet'), 2000);
  } else {
    setCloudStatus('🔴 同步失敗，檢查 API URL');
  }
}

async function pullFromCloud(){
  if (!getCloudUrl()) { alert('請先填入 Apps Script Web App URL'); return; }
  setCloudStatus('🔄 從雲端拉取…');
  const cloud = await loadFromCloud();
  if (cloud) {
    TOTAL_ASSETS = cloud.TOTAL_ASSETS;
    H = cloud.H; AL = cloud.AL; TRADES = cloud.TRADES; DCA_ENTRIES = cloud.DCA_ENTRIES; DCA_PLANS = cloud.DCA_PLANS;
    nid = cloud.nid; ntid = cloud.ntid; dcaNextId = cloud.dcaNextId; dcaPlanNextId = cloud.dcaPlanNextId;
    localStorage.setItem('invest_os_data', JSON.stringify({TOTAL_ASSETS,H,AL,TRADES,DCA_ENTRIES,DCA_PLANS,DCA_META,nid,ntid,dcaNextId,dcaPlanNextId}));
    setCloudStatus('🟢 已從 Google Sheet 拉取');
    updateLastSync_();
    renderAll();
  } else {
    setCloudStatus('🔴 拉取失敗，檢查 API URL');
  }
}

function saveCloudConfig(){
  const url = document.getElementById('cloud-api-url').value.trim();
  setCloudUrl(url);
  if (url) {
    setCloudStatus('🔄 測試連線中…');
    pullFromCloud();
  } else {
    setCloudStatus('⚪ 未連動雲端');
  }
}

bootstrap();
