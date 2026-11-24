"use strict";
/* The Table — pipeline edition.
   Intent → Business Spec → Plan (research · positioning · decisions) →
   Wireframe → Build ⇄ Review/Fix (max 3 loops) → Human approval → Ship.
   Lexi ASSEMBLES the crew per job: agents start away, get summoned by phase.
   Everything is an EVENT {agent, move, edit, say, decide} — today a storyboard
   emits it; next step, a local bridge emits the same events from the real
   Cursor/Kiro agent running on this Mac (see README: "Wiring it for real"). */
const $=s=>document.querySelector(s);
const now=()=>new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
let playing=false, ticker=null, changesUsed=false;

const CREW=[
 {id:"lexi", name:"Lexi", role:"Lead · owns the spec, directs, asks you", color:"#ff444f", home:[50,93], summoned:true},
 {id:"scout",name:"Scout", role:"Research · competitors & best design (Mobbin, optional)", color:"#8a5cf6", home:[6,20]},
 {id:"pixel",name:"Pixel", role:"Design · wireframe → UI", color:"#6b5ce0", home:[7,47]},
 {id:"forge",name:"Forge", role:"Build · constructs the UI", color:"#2f6bd8", home:[93,18]},
 {id:"data", name:"Data",  role:"Wiring · live data & APIs", color:"#0e7a5f", home:[94,45]},
 {id:"words",name:"Words", role:"Copy · words that sell", color:"#b97a0c", home:[50,4]},
 {id:"check",name:"Check", role:"Reviewer · judges against the spec", color:"#2e9e5b", home:[8,74]},
 {id:"probe",name:"Probe", role:"Tester · clicks flows, hunts edge cases", color:"#d96c00", home:[93,72]},
];
const byId=new Map(CREW.map(a=>[a.id,a]));

/* ---------- bot avatars (dots with faces, one personality per agent) ---------- */
const BOT={
 lexi:{eyes:"happy",tip:"star"}, scout:{eyes:"visor",tip:"dot"}, pixel:{eyes:"pixel",tip:"square"},
 forge:{eyes:"round",tip:"bolt"}, data:{eyes:"scan",tip:"dot"}, words:{eyes:"wink",tip:"dot"},
 check:{eyes:"focus",tip:"dot"}, probe:{eyes:"target",tip:"dot"},
};
function botEyes(kind){
  switch(kind){
    case "happy": return `<path d="M15.5 25.5 Q18 22.8 20.5 25.5" /><path d="M27.5 25.5 Q30 22.8 32.5 25.5" />`;
    case "visor": return `<rect x="15" y="22.5" width="18" height="5.5" rx="2.75" fill="#eaf6ff" stroke="none"/><circle cx="20" cy="25.2" r="1.5" fill="#141519" stroke="none"/><circle cx="28" cy="25.2" r="1.5" fill="#141519" stroke="none"/>`;
    case "pixel": return `<rect x="16.5" y="22.8" width="4.4" height="4.4" rx="1" fill="#fff" stroke="none"/><rect x="27.1" y="22.8" width="4.4" height="4.4" rx="1" fill="#fff" stroke="none"/>`;
    case "wink": return `<circle cx="18.5" cy="25" r="2.1" fill="#fff" stroke="none"/><path d="M27.5 25.5 Q30 23.2 32.5 25.5" />`;
    case "scan": return `<path d="M16 25 H32" stroke-dasharray="3.5 3" /><circle cx="18.5" cy="25" r="2" fill="#fff" stroke="none"/><circle cx="29.5" cy="25" r="2" fill="#fff" stroke="none"/>`;
    case "focus": return `<circle cx="18.5" cy="24.6" r="2" fill="#fff" stroke="none"/><circle cx="29.5" cy="24.6" r="2" fill="#fff" stroke="none"/><path d="M15.5 20.8 H21 M27 20.8 H32.5" />`;
    case "target": return `<circle cx="18.5" cy="25" r="3.1" /><circle cx="18.5" cy="25" r="1.1" fill="#fff" stroke="none"/><circle cx="29.5" cy="25" r="2.1" fill="#fff" stroke="none"/>`;
    default: return `<circle cx="18.5" cy="25" r="2.1" fill="#fff" stroke="none"/><circle cx="29.5" cy="25" r="2.1" fill="#fff" stroke="none"/>`;
  }
}
function botTip(kind,color){
  if(kind==="star") return `<path d="M24 1.2 L25.4 4.6 L29 4.9 L26.3 7.1 L27.1 10.6 L24 8.7 L20.9 10.6 L21.7 7.1 L19 4.9 L22.6 4.6 Z" fill="${color}" stroke="#fff" stroke-width="1.1"/>`;
  if(kind==="bolt") return `<path d="M25.4 1 L20.8 7 H23.6 L22.4 11 L27.4 5.4 H24.7 Z" fill="${color}" stroke="#fff" stroke-width="1"/>`;
  if(kind==="square") return `<rect x="20.8" y="2.4" width="6.4" height="6.4" rx="1.6" transform="rotate(45 24 5.6)" fill="${color}" stroke="#fff" stroke-width="1.1"/>`;
  return `<circle cx="24" cy="5.2" r="3.1" fill="${color}" stroke="#fff" stroke-width="1.4"/>`;
}
function botSVG(a){
  const b=BOT[a.id]||{eyes:"round",tip:"dot"};
  const delay=((CREW.findIndex(x=>x.id===a.id)*0.83)%4).toFixed(2);
  return `<svg class="bot" viewBox="0 0 48 48" role="img" aria-label="${a.name} bot" focusable="false">`
    +`<line x1="24" y1="8" x2="24" y2="13" stroke="${a.color}" stroke-width="2.4" stroke-linecap="round"/>${botTip(b.tip,a.color)}`
    +`<rect x="2.8" y="21" width="4.6" height="9" rx="2.3" fill="${a.color}"/><rect x="40.6" y="21" width="4.6" height="9" rx="2.3" fill="${a.color}"/>`
    +`<rect x="6" y="11.5" width="36" height="31" rx="14" fill="${a.color}" stroke="#fff" stroke-width="2.6"/>`
    +`<ellipse cx="17" cy="18" rx="8" ry="4.6" fill="#fff" opacity=".22"/>`
    +`<rect x="12" y="19" width="24" height="17" rx="8" fill="#17181d"/>`
    +`<g class="bot-eyes" style="animation-delay:${delay}s" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round">${botEyes(b.eyes)}</g>`
    +`<path d="M21 32.2 Q24 34 27 32.2" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>`;
}
const youSVG=`<svg class="bot" viewBox="0 0 48 48" role="img" aria-label="You" focusable="false"><rect x="6" y="11.5" width="36" height="31" rx="14" fill="#414652" stroke="#fff" stroke-width="2.6"/><ellipse cx="17" cy="18" rx="8" ry="4.6" fill="#fff" opacity=".18"/><rect x="12" y="19" width="24" height="17" rx="8" fill="#17181d"/><circle cx="24" cy="25.4" r="3.2" fill="#fff"/><path d="M17.8 33.4 Q24 29.6 30.2 33.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;

/* ---------- crew panel + avatars ---------- */
function renderCrew(){
  $("#crew").innerHTML=CREW.map(a=>`<button class="crew-row ${a.summoned?"":"away"}" data-agent="${a.id}"><span class="avatar">${botSVG(a)}</span><span><span class="c-name">${a.name}</span><br><span class="c-role">${a.role}</span></span><span class="c-status" id="cs-${a.id}">${a.summoned?"at the table":"not summoned"}</span></button>`).join("");
  $("#crew-count").textContent=CREW.filter(a=>a.summoned).length+" at the table · local";
  document.querySelectorAll(".crew-row").forEach(r=>r.onclick=()=>{ const a=byId.get(r.dataset.agent); if(!a) return; if(!a.summoned){ chat("sys",a.name+" hasn't been summoned for this job yet — Lexi assembles the crew per intent."); return; } goTo(a.id,"screen"); say(a.id, a.id==="lexi" ? "I run this table — intent in, product out, nothing ships without your OK." : `I'm ${a.name} — ${a.role.toLowerCase()}.`); });
}
const layer=$("#agents-layer"), table=$("#table");
layer.innerHTML=CREW.map(a=>`<div class="agent ${a.summoned?"":"away"}" id="ag-${a.id}"><div class="bubble" id="bub-${a.id}"></div><div class="avatar">${botSVG(a)}</div><span class="a-name">${a.name}</span></div>`).join("");
function place(a,xPct,yPct){ const elx=$("#ag-"+a.id); elx.style.transform=`translate(${table.clientWidth*xPct/100-28}px, ${table.clientHeight*yPct/100-30}px)`; }
function homes(){ CREW.forEach(a=>place(a,a.home[0],a.home[1])); }
addEventListener("resize",homes);
function setStatus(id,s){ const e=byId.has(id)?$("#cs-"+id):null; if(e)e.textContent=s; }
async function summon(id,reason){
  const a=byId.get(id); if(!a||a.summoned) return; a.summoned=true;
  $("#ag-"+a.id).classList.remove("away"); renderCrew(); place(a,a.home[0],a.home[1]);
  chat("sys",`— ${a.name} summoned to the table (${reason}) —`); await wait(500);
}

/* ---------- chat ---------- */
const log=$("#chat-log");
function scrollChat(){ log.scrollTop=log.scrollHeight; }
function chat(who,text){
  const d=document.createElement("div");
  const msgText=document.createElement("span");
  msgText.className="msg-text";
  msgText.textContent=String(text??"");
  if(who==="sys"){
    d.className="msg sys";
    d.appendChild(msgText);
  } else {
    const isYou=who==="you";
    const a=isYou?null:byId.get(who);
    d.className=isYou?"msg you":"msg";
    const av=document.createElement("span");
    av.className="avatar";
    av.innerHTML=isYou?youSVG:(a?botSVG(a):"");
    const body=document.createElement("div");
    body.className="msg-body";
    const whoEl=document.createElement("div");
    whoEl.className="msg-who";
    whoEl.append(isYou?"You":(a?a.name:String(who??"")));
    const timeEl=document.createElement("time");
    timeEl.textContent=now();
    whoEl.appendChild(timeEl);
    body.append(whoEl,msgText);
    d.append(av,body);
  }
  log.appendChild(d); scrollChat(); return d;
}
function typing(a){ if(!a) return; $("#typing-avatar").innerHTML=botSVG(a); $("#typing-name").textContent=a.name+" is typing"; $("#typing").classList.remove("hidden"); }
function untyping(){ $("#typing").classList.add("hidden"); }
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function say(id,text,ms=1150){ const a=byId.get(id); if(!a) return; text=String(text).replaceAll("@@SAY@@"," ").replace(/\s{2,}/g," ").trim(); typing(a); bubble(a.id,text); await wait(ms); untyping(); chat(a.id,text); await wait(320); clearBubble(a.id); }
function bubble(id,text){ if(!byId.has(id)) return; const b=$("#bub-"+id); if(!b)return; b.textContent=text; b.classList.add("show"); $("#ag-"+id).classList.add("speaking"); }
function clearBubble(id){ if(!byId.has(id)) return; const b=$("#bub-"+id); if(!b)return; b.classList.remove("show"); $("#ag-"+id).classList.remove("speaking"); }

/* a decision Lexi needs from the human — batched, recommendation first */
function askDecision(title,why,options){
  return new Promise(resolve=>{
    const d=document.createElement("div"); d.className="msg";
    const av=document.createElement("span"); av.className="avatar"; av.innerHTML=botSVG(byId.get("lexi"));
    const body=document.createElement("div"); body.className="msg-body";
    const whoEl=document.createElement("div"); whoEl.className="msg-who"; whoEl.append("Lexi · decision needed");
    const timeEl=document.createElement("time"); timeEl.textContent=now(); whoEl.appendChild(timeEl);
    const card=document.createElement("div"); card.className="dec-card";
    const titleEl=document.createElement("div"); titleEl.className="dec-title"; titleEl.textContent=String(title??"");
    const whyEl=document.createElement("div"); whyEl.className="dec-why"; whyEl.textContent=String(why??"");
    const optsEl=document.createElement("div"); optsEl.className="dec-opts";
    (Array.isArray(options)?options:[]).forEach((o,i)=>{
      const btn=document.createElement("button"); btn.className="dec-opt"; btn.type="button"; btn.dataset.i=String(i);
      if(o?.rec){ const rec=document.createElement("span"); rec.className="rec"; rec.textContent="RECOMMENDED"; btn.appendChild(rec); }
      const labelWrap=document.createElement("span"); labelWrap.append(String(o?.label??""));
      if(o?.note){ labelWrap.appendChild(document.createElement("br")); const noteEl=document.createElement("small"); noteEl.textContent=String(o.note); labelWrap.appendChild(noteEl); }
      btn.appendChild(labelWrap);
      btn.onclick=()=>{ card.classList.add("resolved"); btn.classList.add("chosen"); chat("you",String(o?.label??"")); resolve(i); };
      optsEl.appendChild(btn);
    });
    card.append(titleEl,whyEl,optsEl);
    body.append(whoEl,card);
    d.append(av,body);
    log.appendChild(d); scrollChat();
  });
}
function logDecision(text,assumed){
  const b=$("#decisions-body"); if(b.querySelector(".empty")) b.replaceChildren();
  const p=document.createElement("p");
  if(assumed){ p.className="assumed"; }
  else { const strong=document.createElement("strong"); strong.textContent="You:"; p.append(strong," "); }
  p.append(String(text??""));
  if(assumed){ const em=document.createElement("em"); em.textContent="(assumed)"; p.append(" ",em); }
  b.appendChild(p);
  $("#card-decisions").classList.add("live");
}

/* ---------- movement ---------- */
async function goToEl(id,node){
  const a=byId.get(id); if(!a||!node) return; const e=$("#ag-"+a.id); e.classList.add("working"); setStatus(a.id,"working");
  const r=node.getBoundingClientRect(), t=table.getBoundingClientRect();
  place(a,(r.left-t.left-16)/t.width*100,(r.top-t.top+r.height/2)/t.height*100);
  await wait(1200); e.classList.remove("working");
}
const REGIONS=new Set(["nav","hero","features","pricing","footer"]);
const el=n=>REGIONS.has(n)?document.querySelector(`[data-el="${n}"]`):null;
const goTo=(id,target)=>goToEl(id, target==="screen" ? $("#device") : el(target));
async function goHome(id){ const a=byId.get(id); if(!a) return; place(a,a.home[0],a.home[1]); setStatus(a.id,"at the table"); await wait(850); }

/* ---------- artifacts ---------- */
function artifact(cardId,bodyId,html){ $("#"+cardId).classList.add("live"); $("#"+bodyId).innerHTML=html; }

/* ---------- screen edits ---------- */
function touch(n){ const node=el(n); if(!node) return; node.classList.add("touched"); setTimeout(()=>node.classList.remove("touched"),1600); }
function pin(n){ const node=el(n); if(!node) return; const r=node.getBoundingClientRect(), t=$("#screen").getBoundingClientRect(); const d=document.createElement("div"); d.className="pin"; d.style.left=(r.left-t.left+r.width-40)+"px"; d.style.top=(r.top-t.top+10)+"px"; d.innerHTML="<b>!</b>"; $("#pins").appendChild(d); setTimeout(()=>d.remove(),6000); }
function sketch(n,label,h){
  const e=el(n); if(!e) return;
  e.classList.add("built");
  const box=document.createElement("div");
  box.className="sketch";
  box.style.margin="12px 20px";
  const height=Number(h);
  if(Number.isFinite(height)&&height>0) box.style.minHeight=`${height}px`;
  box.textContent=String(label??"");
  e.replaceChildren(box);
}

function buildNav(){ const e=el("nav"); e.innerHTML=`<span class="brand">acme<em>·</em>markets</span><nav><span>Markets</span><span>Trade</span><span>Portfolio</span></nav><span class="nav-cta">Log in</span>`; e.classList.add("built"); }
function buildHero(){ const bars=[38,52,44,66,58,80,70,92,76,88,64,95]; el("hero").innerHTML=`<div class="hero-kicker">EUR/USD · <span class="tick" data-sym="EURUSD">1.08452</span> · LIVE</div><h2 class="hero-title tight">Trade in under a minute.</h2><p class="hero-sub">Pick a market, set your stake, see exactly what you can win — before you commit a cent.</p><div class="chart">${bars.map((h,i)=>`<i class="${i===5||i===9?"down":""}" style="height:${h}%"></i>`).join("")}</div>`; el("hero").classList.add("built"); }
function buildMarkets(){ el("features").innerHTML=[["Volatility 100 Index","V100","1,523.44"],["EUR/USD","EURUSD","1.08452"],["Gold","GOLD","2,384.10"]].map(m=>`<div class="feat"><b>${m[0]}</b><span class="tick" data-sym="${m[1]}" style="font-size:15px">${m[2]}</span><span>Tap to trade →</span></div>`).join(""); el("features").classList.add("built"); }
function buildTradePanel(fixed,big){
  el("pricing").innerHTML=`<div class="trade-panel">
    <div class="tp-field"><small>STAKE (USD)</small><b>${fixed?"10":"0"}</b></div>
    <div class="tp-field tp-payout ${fixed?"":"hidden-pay"}"><small>PAYOUT IF YOU WIN</small><b>$19.40</b></div>
    <button class="trade-btn ${big?"big":""}">Trade ↑</button></div>
    <p style="font-family:var(--mono);font-size:9.5px;color:var(--mute);margin:9px 2px 0">${fixed?"Payout shown before you buy · Spec R2 ✓ · Min stake $1 — Trade locks at $0":"Payout revealed on the next step…"}</p>`;
  el("pricing").classList.add("built");
}
function buildFooter(){ el("footer").innerHTML=`<span>Markets open</span><span>Built live by Lexi's crew</span>`; el("footer").classList.add("built"); }
function startTicker(){ stopTicker(); const base={"EURUSD":1.08452,"GOLD":2384.10}; ticker=setInterval(()=>{ document.querySelectorAll(".tick").forEach(t=>{ const s=t.dataset.sym; if(s==="EURUSD"){ base[s]+= (Math.random()-.5)*0.0004; t.textContent=base[s].toFixed(5); } }); },1600); }
function stopTicker(){ if(ticker) clearInterval(ticker); ticker=null; }

/* ---------- phases ---------- */
const PHASES=["Intent","Spec","Plan","Wireframe","Prototype","Build","Review ⇄ Fix","Your approval","Ship"];
function setPhase(i){ $("#phase-line").innerHTML=PHASES.map((p,j)=>`${j?'<span class="phase-sep"></span>':""}<span class="phase ${j<i?"done":j===i?"now":""}"><i></i>${p}</span>`).join(""); }

/* ---------- approval gate ---------- */
function waitApproval(sub,title){
  $("#approval-title").textContent=title||"Your approval needed — Ship is locked.";
  $("#approval-sub").textContent=sub; $("#approval").classList.remove("hidden");
  $("#approval").scrollIntoView({behavior:"smooth",block:"nearest"});
  return new Promise(res=>{ $("#btn-approve").onclick=()=>{ $("#approval").classList.add("hidden"); res("approve"); }; $("#btn-changes").onclick=()=>{ $("#approval").classList.add("hidden"); res("changes"); }; });
}

/* ================= THE PIPELINE, AS A STORYBOARD ================= */
async function buildStory(intent){
  if(playing) return; playing=true; changesUsed=false; $("#btn-start").disabled=true;
  chat("sys","— a new build opens on the table —"); chat("you",intent);
  $("#project-name").textContent="Acme Markets — first-trade app";
  $("#project-sub").textContent="Intent received. Lexi runs the pipeline: spec → plan → wireframe → build ⇄ review → your approval → ship.";

  /* 1 · INTENT + SPEC */
  setPhase(0);
  await say("lexi","Intent noted: Acme Markets, a first-trade app. First question I always ask — what's the source of truth?");
  setPhase(1);
  artifact("card-spec","spec-body",`<p><strong>For:</strong> first-time traders who find pro platforms intimidating.</p><p><strong>Core journey:</strong> pick a market → set stake → trade, in under a minute.</p><p><strong>R1</strong> Demo before real money. <strong>R2</strong> Payout always visible <em>before</em> buying. <strong>R3</strong> Never hide the risk.</p>`);
  await say("lexi","Business Spec found — that's our contract. Everything later gets checked against it, not against taste. If it didn't exist, I'd grill you for it before anyone drew a pixel.");

  /* 2 · PLAN: research → positioning → decisions */
  setPhase(2);
  await summon("scout","competitor research · Mobbin MCP");
  await goToEl("scout",$("#card-research"));
  artifact("card-research","research-body",`<p><strong>5 rival trading apps</strong> pulled via Mobbin — screens, flows, sections:</p><p>· All 5 show price before any commitment</p><p>· 4 of 5 gate the first trade behind sign-up</p><p>· Pro charting dominates every home screen</p>`);
  await say("scout","Mobbin teardown done. Patterns, not pixels: rivals win on clarity before commitment — and lose first-timers with chart clutter.");
  await goHome("scout");
  artifact("card-positioning","positioning-body",`
    <p class="pos match"><i>MATCH</i><span>Price & payout visible before commitment — table stakes</span></p>
    <p class="pos beat"><i>BEAT</i><span>First trade in &lt;1 minute, demo-first (R1) — rivals take 4+ steps</span></p>
    <p class="pos ignore"><i>IGNORE</i><span>Pro charting suites — spec says first-timers first</span></p>`);
  await say("lexi","Positioning set from the spec: match the table stakes, beat them on time-to-first-trade, ignore the pro clutter. Two things I won't guess on, though —");
  const audience=await askDecision("Who is the first release for?", "The spec leans first-timers, but audience decides how much we strip down. Wrong call here bends the whole design.",
    [{label:"First-time traders",note:"Simplest possible first trade · spec R1–R3 as written",rec:true},{label:"Experienced traders",note:"Charting and depth move to the home screen"},{label:"Both at once",note:"Two experiences to design, review and test"}]);
  logDecision(audience===0?"Audience: first-time traders":audience===1?"Audience: experienced traders":"Audience: both — two experiences");
  logDecision("Demo mode before real money (R1)",true); logDecision("One home currency, USD",true);
  await say("lexi", audience===0 ? "Locked: first-timers. Assumed defaults logged — demo-first, USD — correct any of them in chat any time." : "Locked. Assumed defaults logged on the right — correct any of them in chat any time.");

  /* 3 · WIREFRAME */
  setPhase(3);
  await summon("pixel","wireframe & UI design");
  await goTo("pixel","hero");
  sketch("nav","NAV — logo · Markets · Trade · Portfolio · Log in",34);
  sketch("hero","HERO — live price + one-line promise + chart",84);
  sketch("features","MARKETS — 3 tap-to-trade cards",56);
  sketch("pricing","TRADE PANEL — stake · payout · Trade",56);
  await say("pixel","Wireframe's on the screen — grey boxes only, shape before colour. Chart up top because the spec's journey starts at the market.");
  const wf=await askDecision("Wireframe shape — good to build?", "Approving the shape now is the cheapest fix you'll ever make. Changes after Forge builds cost a loop.",
    [{label:"Approve wireframe",note:"Forge builds exactly this shape",rec:true},{label:"Make the chart bigger",note:"Chart takes more of the screen; markets move down"}]);
  if(wf===1){ sketch("hero","HERO — live price + BIG chart",130); await say("pixel","Done — chart's the hero now, markets pushed down. Building on this shape."); logDecision("Wireframe: enlarged chart (your call)"); }
  else { await say("pixel","Shape locked. Forge — it's yours."); logDecision("Wireframe approved as drawn"); }

  /* 4 · BUILD */
  setPhase(4);
  await summon("forge","builds the UI"); await summon("data","live market wiring");
  await say("lexi","Crew for this job: Forge builds, Data wires live prices. Words sits this one out — the spec's copy is already fixed, nobody re-invents it.");
  await goTo("forge","nav"); buildNav(); touch("nav");
  await goTo("forge","hero"); buildHero(); touch("hero"); await say("forge","Nav and hero are real. Chart's drawn from live ticks.");
  await goTo("data","features"); buildMarkets(); startTicker(); touch("features"); await say("data","Markets wired — those prices are moving, not pasted."); await goHome("data");
  await goTo("forge","pricing"); buildTradePanel(false,false); buildFooter(); touch("pricing"); await say("forge","Trade panel and footer on. Built UI's complete — review it."); await goHome("forge");

  /* 5 · REVIEW ⇄ FIX (max 3 loops) */
  setPhase(5);
  await summon("check","reviews against the spec"); await summon("probe","tests the flows");
  chat("sys",`— review ⇄ fix · loop 1 of max 3 —`);
  await goTo("check","pricing"); pin("pricing");
  await say("check","Against the spec, not taste: R2 says payout visible BEFORE buying. This panel blurs it until the next step. That's a spec violation — fix it.");
  await goTo("probe","pricing"); pin("pricing");
  await say("probe","I clicked the journey: stake sits at $0 and Trade still fires. A first-timer can 'trade' nothing. Bug, not opinion.");
  await say("lexi","Both stand. Loop 1: Forge — payout visible up front, Trade locked below min stake. Probe re-tests after.");
  await goTo("forge","pricing"); buildTradePanel(true,false); touch("pricing"); await say("forge","Fixed both. Payout's in the open, stake starts at $10, Trade locks at $0."); await goHome("forge");
  await goTo("probe","pricing"); await say("probe","Re-clicked the whole journey. Stake, payout, trade — holds. From me: pass."); await goHome("probe");
  await goTo("check","hero"); await say("check","Re-checked against every rule: R1 demo-first ✓, R2 payout-first ✓, R3 risk never hidden ✓. Reviewer: pass."); await goHome("check");

  /* 6 · HUMAN APPROVAL */
  setPhase(6);
  await say("lexi","Built UI vs wireframe: same shape. Review found 2 problems, both fixed, 0 open. Loops used: 1 of 3. The screen is yours — Ship stays locked until you say so.");
  let verdict=await waitApproval("Acme Markets · matches wireframe · review 2 found / 2 fixed / 0 open · loop 1 of 3");
  if(verdict==="changes"){
    changesUsed=true; chat("you","Request changes — make the Trade button impossible to miss.");
    await say("lexi","Heard. Forge — the Trade action becomes the loudest thing on the panel.");
    await summon("forge","your requested change"); await goTo("forge","pricing"); buildTradePanel(true,true); touch("pricing"); await say("forge","Trade button's twice as loud. Back to you for the call."); await goHome("forge");
    verdict=await waitApproval("Change applied · Trade button enlarged · review still green · your call");
  }

  /* 7 · SHIP */
  setPhase(7);
  $("#ship-badge").classList.remove("hidden");
  await say("lexi","Approved by you, shipped by the table. Preview is live — and the decision log on the right is the whole story of how we got here.");
  chat("sys","— shipped · preview live · crew standing by for your next intent —");
  playing=false; $("#btn-start").disabled=false;
}

/* small live edit after ship / mid-table chat */
async function smallEdit(text){
  if(playing) return; playing=true; chat("you",text);
  await say("lexi","On it — Forge takes it, Check keeps an eye on it.");
  const target=/price|payout|trade|stake/i.test(text)?"pricing":/market/i.test(text)?"features":/chart|hero|top/i.test(text)?"hero":"nav";
  await summon("forge","live edit"); await goTo("forge",target); touch(target); await say("forge","Done — changed on the screen. Take a look."); await goHome("forge");
  await say("lexi","Done. What next?"); playing=false;
}

/* ================= LEXI BRIDGE (real agents on this machine) =================
   When the bridge (apps/build/bridge) is live, Start sends the intent there and
   the stage is driven by real events. The bridge serves this page itself, so
   the socket is the page's own origin; opened from a file or another static
   server, the page falls back to the bridge's default address.
   Otherwise the storyboard above remains as the offline demo. */
const BRIDGE_HTTP = /^https?:$/.test(location.protocol) && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) && location.port && location.port !== "4173"
  ? location.origin : "http://127.0.0.1:7341";
const BRIDGE_WS = BRIDGE_HTTP.replace(/^http/, "ws");
let bridgeWs=null, bridgeReady=false, bridgeRunning=false, sayChain=Promise.resolve(), sawReplay=false;
const queueSay=(id,text)=>{ sayChain=sayChain.then(()=>say(id,text)).catch(()=>{}); return sayChain; };
const SAFE_TAGS=new Map([
  "a","article","aside","b","blockquote","br","button","code","dd","div","dl","dt",
  "em","figcaption","figure","footer","h1","h2","h3","h4","h5","h6","header","hr",
  "i","img","kbd","label","li","main","mark","nav","ol","p","pre","s","section",
  "small","span","strong","sub","sup","table","tbody","td","tfoot","th","thead","time","tr","u","ul",
].map(t=>[t,t]));
const VOID_TAGS=new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
const DROP_CONTENT_TAGS=new Set(["script","style","iframe","object","embed","template","svg","math","noscript"]);
const NAMED_ENTITIES={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:"\u00a0",middot:"·",rarr:"→",larr:"←",uarr:"↑",darr:"↓",mdash:"—",ndash:"–"};
function decodeEntities(str){
  return String(str||"").replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g,(m,body)=>{
    if(body[0]==="#"){
      const cp=body[1]==="x"||body[1]==="X"?parseInt(body.slice(2),16):parseInt(body.slice(1),10);
      return Number.isFinite(cp)&&cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):m;
    }
    return Object.hasOwn(NAMED_ENTITIES,body)?NAMED_ENTITIES[body]:m;
  });
}
function isSafeRelativeUrl(val){
  const v=String(val||"").trim();
  return v.startsWith("#")||(v.startsWith("/")&&!v.startsWith("//")&&!v.startsWith("/\\"));
}
function sanitizeInlineStyle(val){
  return String(val||"").split(";").map(d=>d.trim()).filter(d=>{
    const idx=d.indexOf(":");
    if(idx<=0) return false;
    const prop=d.slice(0,idx).trim().toLowerCase();
    const rhs=d.slice(idx+1).trim();
    if(!/^[a-z]{2,24}(?:-[a-z]{1,24}){0,3}$/.test(prop)) return false;
    return /^(?:#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9-]{1,40}\)|[a-zA-Z]{2,20}(?:-[a-zA-Z]{2,20})?|-?\d{1,5}(?:\.\d{1,4})?(?:px|%|rem|em|vh|vw|s|ms)?(?:\s+-?\d{1,5}(?:\.\d{1,4})?(?:px|%|rem|em|vh|vw)?){0,3})$/.test(rhs);
  }).join("; ");
}
function parseTagAttributes(raw){
  const attrs=[];
  let i=0;
  const n=raw.length;
  while(i<n){
    while(i<n&&raw.charCodeAt(i)<=32) i++;
    if(i>=n||raw[i]==="/") break;
    const nameStart=i;
    while(i<n&&raw.charCodeAt(i)>32&&raw[i]!=="="&&raw[i]!== "/"&&raw[i]!==">") i++;
    const name=raw.slice(nameStart,i).toLowerCase();
    while(i<n&&raw.charCodeAt(i)<=32) i++;
    let value="";
    if(raw[i]==="="){
      i++;
      while(i<n&&raw.charCodeAt(i)<=32) i++;
      if(raw[i]==='"'||raw[i]==="'"){
        const q=raw[i++];
        const valStart=i;
        const endQ=raw.indexOf(q,i);
        if(endQ===-1){ value=raw.slice(valStart); i=n; }
        else { value=raw.slice(valStart,endQ); i=endQ+1; }
      } else {
        const valStart=i;
        while(i<n&&raw.charCodeAt(i)>32&&raw[i]!==">") i++;
        value=raw.slice(valStart,i);
      }
    }
    if(name) attrs.push([name,decodeEntities(value)]);
  }
  return attrs;
}
function applySafeAttributes(node,tag,attrs){
  for(const [name,val] of attrs){
    switch(name){
      case "class": node.className=val; break;
      case "title": node.title=val; break;
      case "alt": if(tag==="img") node.setAttribute("alt",val); break;
      case "aria-label": node.setAttribute("aria-label",val); break;
      case "aria-hidden": if(val==="true"||val==="false") node.setAttribute("aria-hidden",val); break;
      case "aria-current": node.setAttribute("aria-current",val); break;
      case "role": node.setAttribute("role",val); break;
      case "data-sym": node.dataset.sym=val; break;
      case "colspan": if(/^\d{1,2}$/.test(val)) node.setAttribute("colspan",val); break;
      case "rowspan": if(/^\d{1,2}$/.test(val)) node.setAttribute("rowspan",val); break;
      case "type": if(tag==="button"&&(val==="button"||val==="reset")) node.setAttribute("type",val); break;
      case "href": if(isSafeRelativeUrl(val)) node.setAttribute("href",val.trim()); break;
      case "src": if(isSafeRelativeUrl(val)) node.setAttribute("src",val.trim()); break;
      case "style": { const s=sanitizeInlineStyle(val); if(s) node.setAttribute("style",s); break; }
    }
  }
  if(tag==="button"&&!node.hasAttribute("type")) node.setAttribute("type","button");
}
function renderSafeHtml(container,html){
  const src=String(html||"");
  const root=document.createDocumentFragment();
  const stack=[{tag:null,node:root}];
  let pos=0;
  while(pos<src.length){
    const lt=src.indexOf("<",pos);
    if(lt===-1){
      stack[stack.length-1].node.appendChild(document.createTextNode(decodeEntities(src.slice(pos))));
      break;
    }
    if(lt>pos){
      stack[stack.length-1].node.appendChild(document.createTextNode(decodeEntities(src.slice(pos,lt))));
    }
    if(src.startsWith("<!--",lt)){
      let scan=lt+4, endComment=-1;
      while(scan<src.length){
        const dash=src.indexOf("--",scan);
        if(dash===-1) break;
        if(src[dash+2]===">"){ endComment=dash+3; break; }
        if(src[dash+2]==="!"&&src[dash+3]===">"){ endComment=dash+4; break; }
        scan=dash+1;
      }
      pos=endComment===-1?src.length:endComment;
      continue;
    }
    const gt=src.indexOf(">",lt+1);
    if(gt===-1){
      stack[stack.length-1].node.appendChild(document.createTextNode(decodeEntities(src.slice(lt))));
      break;
    }
    const inside=src.slice(lt+1,gt).trim();
    pos=gt+1;
    if(!inside||inside[0]==="!"||inside[0]==="?") continue;
    if(inside[0]==="/"){
      const closeName=inside.slice(1).trim().split(/[\s/]/,1)[0].toLowerCase();
      for(let s=stack.length-1;s>=1;s--){
        if(stack[s].tag===closeName){ stack.length=s; break; }
      }
      continue;
    }
    let nameEnd=0;
    while(nameEnd<inside.length&&inside.charCodeAt(nameEnd)>32&&inside[nameEnd]!== "/") nameEnd++;
    const rawTag=inside.slice(0,nameEnd).toLowerCase();
    const selfClosing=inside.endsWith("/")||VOID_TAGS.has(rawTag);
    if(DROP_CONTENT_TAGS.has(rawTag)){
      if(!selfClosing){
        const lowerRest=src.slice(pos).toLowerCase();
        const closeNeedle="</"+rawTag;
        const relClose=lowerRest.indexOf(closeNeedle);
        if(relClose===-1){ break; }
        const closeGt=src.indexOf(">",pos+relClose+closeNeedle.length);
        pos=closeGt===-1?src.length:closeGt+1;
      }
      continue;
    }
    const safeTag=SAFE_TAGS.get(rawTag);
    if(!safeTag) continue;
    const elem=document.createElement(safeTag);
    applySafeAttributes(elem,safeTag,parseTagAttributes(inside.slice(nameEnd)));
    stack[stack.length-1].node.appendChild(elem);
    if(!selfClosing) stack.push({tag:safeTag,node:elem});
  }
  container.replaceChildren(root);
}
const ARTIFACT_CARDS=new Set(["spec","research","positioning","decisions"]);
const ARTIFACT_KINDS=new Map([["match","MATCH"],["beat","BEAT"],["ignore","IGNORE"]]);
function renderBridgeArtifact(card,lines){
  if(!ARTIFACT_CARDS.has(card)) return;
  const body=$("#"+card+"-body"); if(!body) return;
  body.classList.add("dec-log");
  const nodes=(Array.isArray(lines)?lines:[]).map(l=>{
    const p=document.createElement("p");
    const text=String(l?.text??"");
    const badge=ARTIFACT_KINDS.get(l?.kind);
    if(badge){
      p.className="pos "+l.kind;
      const iEl=document.createElement("i"); iEl.textContent=badge;
      const span=document.createElement("span"); span.textContent=text;
      p.append(iEl,span);
    } else if(l?.kind==="assumed"){
      p.className="assumed";
      const em=document.createElement("em"); em.textContent="(assumed)";
      p.append(text," ",em);
    } else if(l?.kind==="decision"){
      const strong=document.createElement("strong"); strong.textContent=text;
      p.appendChild(strong);
    } else {
      p.textContent=text;
    }
    return p;
  });
  body.replaceChildren(...nodes);
  $("#card-"+card).classList.add("live");
}
function applyRunnerState(r){
  const pill=$("#bridge-status"); if(!pill) return;
  if(r.authenticated){ pill.className="bridge-status on"; pill.textContent="bridge · "+r.label+" live"; bridgeReady=true; }
  else if(r.available){ pill.className="bridge-status warn"; pill.textContent="bridge · "+r.label+" login needed"; bridgeReady=false; }
  else { pill.className="bridge-status warn"; pill.textContent="bridge · "+r.label+" not installed"; bridgeReady=false; }
  pill.title="Agents: "+r.label+(r.model?" · model "+r.model:"")+" · "+(r.detail||"");
}
function handleBridgeEvent(ev){
  if(ev.replay) sawReplay=true;
  switch(ev.type){
    case "session": bridgeRunning=!!ev.running; playing=!!ev.running; $("#btn-start").disabled=!!ev.running; if(ev.running) chat("sys","— reconnected · the build kept running · table rebuilt —"); break;
    case "hello": {
      const sel=$("#runner-select");
      if(sel && Array.isArray(ev.runners)){
        const opts=ev.runners.map(r=>{
          const opt=document.createElement("option");
          opt.value=String(r?.id??"");
          opt.selected=r?.id===ev.runner;
          opt.textContent=String(r?.label??"")+(r?.authenticated?"":r?.available?" · login needed":" · not installed");
          return opt;
        });
        sel.replaceChildren(...opts);
        sel.value=String(ev.runner??"");
      }
      const cur=(ev.runners||[]).find(r=>r.id===ev.runner);
      if(cur) applyRunnerState(cur); else { bridgeReady=false; }
      chat("sys","— Lexi Bridge connected · choose who works (Kiro / Claude / Cursor / Codex) in the topbar · Start runs the real pipeline with the chosen runner —");
      break; }
    case "runner": applyRunnerState(ev); chat("sys",`— agents: ${ev.label||""}${ev.model?` · model ${ev.model}`:""} · ${ev.detail||""} —`); break;
    case "project": $("#project-name").textContent=ev.name||"Untitled product"; $("#project-sub").textContent="Real build · agents working in "+(ev.workspace||"a local workspace"); break;
    case "phase": { const i=PHASES.indexOf(ev.name); if(i>=0) setPhase(i); break; }
    case "sys": chat("sys",ev.text); break;
    case "status-report": queueSay("lexi",ev.text); break;
    case "summon": summon(ev.agent,ev.reason||""); break;
    case "move": ev.card ? goToEl(ev.agent,document.getElementById(ev.card)) : goTo(ev.agent,ev.to||"screen"); break;
    case "say": if(ev.replay){ const a=byId.get(ev.agent); if(a) chat(a.id,ev.text); } else queueSay(ev.agent,ev.text); break;
    case "pin": pin(ev.element||"hero"); break;
    case "wireframe": (ev.sketches||[]).forEach(s=>sketch(s.element,s.label,s.height)); break;
    case "edit": { const e=el(ev.element); if(e){ renderSafeHtml(e,ev.html); e.classList.add("built"); touch(ev.element); } break; }
    case "artifact": renderBridgeArtifact(ev.card,ev.lines); break;
    case "decision": askDecision(ev.title,ev.why,ev.options||[]).then(i=>{ if(bridgeWs?.readyState===1) bridgeWs.send(JSON.stringify({type:"decision-answer",id:ev.id,index:i})); }); break;
    case "approval": waitApproval(ev.summary||"",ev.title).then(v=>{ if(bridgeWs?.readyState===1) bridgeWs.send(JSON.stringify({type:"approval-answer",id:ev.id,verdict:v,instruction:v==="changes"?"Make it clearer and stronger — rework the main region.":undefined})); }); break;
    case "ship": $("#ship-badge").classList.remove("hidden"); chat("sys",`— shipped · preview ${BRIDGE_HTTP}${ev.preview||""} · workspace ${ev.workspace||""} —`); break;
    case "error": chat("sys","— "+(ev.message||"bridge error")+" —"); playing=false; bridgeRunning=false; $("#btn-start").disabled=false; break;
    case "done": playing=false; bridgeRunning=false; $("#btn-start").disabled=false; chat("sys","— pipeline complete · crew standing by —"); break;
  }
}
function connectBridge(){
  try { bridgeWs=new WebSocket(BRIDGE_WS); } catch { setTimeout(connectBridge,4000); return; }
  bridgeWs.onmessage=(m)=>{ try { handleBridgeEvent(JSON.parse(m.data)); } catch {} };
  bridgeWs.onclose=()=>{ bridgeReady=false; const p=$("#bridge-status"); if(p){ p.className="bridge-status"; p.textContent="bridge · offline"; } setTimeout(connectBridge,4000); };
  bridgeWs.onerror=()=>{ try{ bridgeWs.close(); }catch{} };
}
function startBridgeBuild(intent){
  resetTable(); bridgeRunning=true; playing=true; $("#btn-start").disabled=true;
  chat("sys","— real build opening on the table —"); chat("you",intent);
  bridgeWs.send(JSON.stringify({type:"intent",text:intent}));
}

/* ---------- reset / controls ---------- */
function resetTable(){
  stopTicker(); ["nav","hero","features","pricing","footer"].forEach(n=>{ el(n).classList.remove("built"); el(n).innerHTML=""; });
  $("#pins").innerHTML=""; $("#blank").style.display="grid"; $("#ship-badge").classList.add("hidden"); $("#approval").classList.add("hidden");
  ["spec","research","positioning","decisions"].forEach(k=>{ $("#card-"+k).classList.remove("live"); $("#"+k+"-body").innerHTML=`<p class="empty">Not created yet</p>`; });
  CREW.forEach(a=>{ if(a.id!=="lexi"){ a.summoned=false; $("#ag-"+a.id).classList.add("away"); } });
  renderCrew(); homes(); setPhase(0);
  $("#project-name").textContent="Untitled product";
  $("#project-sub").textContent="Give Lexi an intent. She plans against the Business Spec, builds on this screen, and ships nothing without your approval.";
}
$("#btn-start").onclick=()=>{ if(bridgeReady) startBridgeBuild("Build Acme Markets — a first-trade app for beginners"); else buildStory("Build Acme Markets — a first-trade app for beginners"); };
$("#btn-replay").onclick=()=>{ if(playing) return; if(bridgeReady) startBridgeBuild("Build Acme Markets — a first-trade app for beginners"); else { resetTable(); buildStory("Build Acme Markets — a first-trade app for beginners"); } };
$("#ask-form").addEventListener("submit",e=>{ e.preventDefault(); const v=$("#ask-input").value.trim(); if(!v) return; $("#ask-input").value="";
  const isStatus=/^(status|eta)\b|what.*(doing|happening|going on)|how long|progress|where are (we|you)/i.test(v);
  if(isStatus){
    chat("you",v);
    if(bridgeWs?.readyState===1) bridgeWs.send(JSON.stringify({type:"status-query"}));
    else { const now=document.querySelector(".phase.now")?.textContent.trim()||"Intent"; queueSay("lexi", playing ? `Status: simulated run · we're in the ${now} phase. (Bridge offline — real status & ETA need the bridge.)` : "Status: at the table, nothing running. Give me an intent and I'll assemble the crew."); }
    return;
  }
  const isQuestion=/^(why|what|how|when|who|which|where)\b/i.test(v) || (/\?\s*$/.test(v) && !/^(can|could|will|would) you (make|change|add|remove|fix|build|create|update|move|use|keep|switch)/i.test(v));
  if(isQuestion && bridgeWs?.readyState===1){ chat("you",v); bridgeWs.send(JSON.stringify({type:"ask",text:v})); return; }
  if(playing && bridgeRunning && bridgeWs?.readyState===1){ chat("you",v); bridgeWs.send(JSON.stringify({type:"steer",text:v})); return; }
  if(playing) return;
  $("#blank").style.display="none";
  if(bridgeReady && !el("nav").classList.contains("built")) startBridgeBuild(v);
  else if(!el("nav").classList.contains("built")) buildStory(v); else smallEdit(v); });
document.querySelectorAll(".dt").forEach(b=>b.onclick=()=>{ document.querySelectorAll(".dt").forEach(x=>x.classList.toggle("on",x===b));
  const mobile=b.dataset.device==="mobile"; $("#device").classList.toggle("phone",mobile);
  $("#device-url").textContent= mobile ? "Acme · app" : "preview.localhost";
  setTimeout(homes,60); if(byId.get("lexi").summoned) say("lexi", mobile ? "Table's a phone now. Same pipeline, smaller canvas." : "Back to the laptop screen.",800); });

/* ---------- crew collapse (chat keeps the height) ---------- */
$("#crew-toggle").addEventListener("click",()=>{
  const section=$("#crew-section"), collapsed=section.classList.toggle("collapsed");
  $("#crew-toggle").setAttribute("aria-expanded",String(!collapsed));
  scrollChat();
});

/* ---------- boot ---------- */
$("#runner-select").addEventListener("change",e=>{
  const id=e.target.value;
  if(bridgeWs?.readyState===1) bridgeWs.send(JSON.stringify({type:"set-runner",runner:id}));
  else chat("sys","— bridge offline · "+id+" will be used once it connects —");
});
connectBridge();
["spec","research","positioning","decisions"].forEach(k=>{ $("#"+k+"-body").innerHTML=`<p class="empty">Not created yet</p>`; });
renderCrew(); homes(); setTimeout(homes,300); setPhase(0);
chat("sys","The table is empty. Agents run on this machine, through a local agent CLI — you direct, they draw.");
setTimeout(async()=>{ if(sawReplay) return; /* a build was restored on refresh — don't talk over it */ await say("lexi","I'm Lexi. Give me an intent and I'll run it properly: Business Spec first, competitor research (through Mobbin when it is configured), positioning, your decisions, a wireframe — then we build, review, fix, and nothing ships without your approval.",1900); if(sawReplay) return; await say("lexi","Press “Start: build the sample app”, or type your own intent below. I assemble the crew per job — watch who I summon.",1500); },500);
new MutationObserver(()=>{ if(el("nav").classList.contains("built")) $("#blank").style.display="none"; }).observe($("#screen"),{subtree:true,attributes:true,attributeFilter:["class"]});
