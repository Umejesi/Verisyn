const SITE_URL = 'https://verisyn-five.vercel.app'; // update if your domain changes
const CHAIN_NAMES = {1:'Ethereum',56:'BSC',8453:'Base',42161:'Arbitrum'};

let isLoggedIn = false;
let isPro = false;
let userEmail = null;
let lastAnalysis = null;

function getGuestId(cb){
  chrome.storage.local.get(['verisyn_guest_id'], (data)=>{
    if(data.verisyn_guest_id){ cb(data.verisyn_guest_id); return; }
    const id = crypto.randomUUID();
    chrome.storage.local.set({verisyn_guest_id: id}, ()=> cb(id));
  });
}

async function refreshAuth(){
  try{
    const res = await fetch(`${SITE_URL}/api/auth`, { credentials: 'include' });
    const data = await res.json();
    isLoggedIn = !!data.loggedIn;
    userEmail = data.email || null;
    isPro = !!data.isPro;
  }catch(e){
    isLoggedIn = false; isPro = false; userEmail = null;
  }
  reflectAuthUI();
}

function reflectAuthUI(){
  const accountRow = document.getElementById('accountRow');
  if(isLoggedIn){
    accountRow.innerHTML = `<span>${userEmail}${isPro ? ' · ⭐ Pro' : ''}</span><a href="#" id="logoutLink">Log out</a>`;
    document.getElementById('logoutLink').addEventListener('click', async (e)=>{
      e.preventDefault();
      await fetch(`${SITE_URL}/api/auth`, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'logout'}) });
      await refreshAuth();
    });
  } else {
    accountRow.innerHTML = `<a href="#" id="googleSigninLink">Sign in with Google to sync Pro & watchlist</a>`;
    document.getElementById('googleSigninLink').addEventListener('click', (e)=>{
      e.preventDefault();
      chrome.tabs.create({ url: `${SITE_URL}/?openAuth=1` });
    });
  }
}

document.getElementById('scanBtn').addEventListener('click', runScan);
document.getElementById('address').addEventListener('keydown', e=>{ if(e.key==='Enter') runScan(); });

chrome.storage?.local.get(['prefillAddress','prefillChain'], (data)=>{
  if(data.prefillAddress){
    document.getElementById('address').value = data.prefillAddress;
    if(data.prefillChain) document.getElementById('chain').value = data.prefillChain;
    runScan();
  }
});

function showError(msg){ const b=document.getElementById('error'); b.textContent=msg; b.classList.add('show'); }
function clearError(){ document.getElementById('error').classList.remove('show'); }
function setLoading(on){
  document.getElementById('loading').classList.toggle('show', on);
  document.getElementById('scanBtn').disabled = on;
}

async function runScan(){
  clearError();
  const address = document.getElementById('address').value.trim();
  const chain = document.getElementById('chain').value;

  if(!/^0x[a-fA-F0-9]{40}$/.test(address)){
    showError("That doesn't look like a valid contract address.");
    return;
  }

  document.getElementById('results').classList.remove('show');
  setLoading(true);

  getGuestId(async (guestId)=>{
    try{
      const res = await fetch(`${SITE_URL}/api/scan`, {
        method: 'POST',
        credentials: 'include',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ address, chain, mode:'token', guestId })
      });
      const payload = await res.json();
      if(!res.ok){
        showError(payload.error || 'Scan failed.');
        setLoading(false);
        return;
      }
      const analysis = computeRisk(payload.security, payload.market);
      const aiText = await getAiVerdict(analysis, address, chain);
      analysis.oneliner = aiText || analysis.oneliner;
      lastAnalysis = { analysis, address, chain };
      renderResults(analysis, address, chain, payload.tier, payload.remaining);
    }catch(err){
      console.error(err);
      showError('Scan failed — try again or use the full site for more detail.');
    }finally{
      setLoading(false);
    }
  });
}

async function getAiVerdict(analysis, address, chain){
  const flagSummary = analysis.flags.map(f=>`[${f.level.toUpperCase()}] ${f.title}: ${f.desc}`).join('\n');
  const prompt = `You are a crypto security analyst writing a 2-3 sentence plain-English verdict for a retail user about a token contract.
Chain: ${CHAIN_NAMES[chain]}
Address: ${address}
Safety score: ${analysis.score}/100 (${analysis.tier})
Flags:
${flagSummary}

Write ONLY the verdict paragraph (2-3 sentences, no preamble, no markdown). Focus on what matters most for a decision.`;
  try{
    const res = await fetch(`${SITE_URL}/api/ai`, {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt })
    });
    const data = await res.json();
    return data.text || null;
  }catch(e){ return null; }
}

function computeRisk(s, market){
  let score = 100;
  const flags = [];
  const bad=(title,desc,p,why)=>{flags.push({level:'bad',title,desc,why});score-=p;};
  const warn=(title,desc,p,why)=>{flags.push({level:'warn',title,desc,why});score-=p;};
  const ok=(title,desc,why)=>flags.push({level:'ok',title,desc,why});

  if(s.is_honeypot==='1') bad('Honeypot detected','You may not be able to sell after buying.',50,
    "A honeypot lets you buy but blocks selling — one of the most common total-loss scams.");
  else ok('Not a honeypot','Sell function appears functional.', 'A simulated sell succeeded, so selling should work under normal conditions.');

  const buyTax=parseFloat(s.buy_tax||0)*100, sellTax=parseFloat(s.sell_tax||0)*100;
  if(sellTax>=20||buyTax>=20) bad('High tax',`${buyTax.toFixed(1)}% buy / ${sellTax.toFixed(1)}% sell.`,25,
    'A large cut is taken on every trade, regardless of price movement.');
  else if(sellTax>=8||buyTax>=8) warn('Elevated tax',`${buyTax.toFixed(1)}% buy / ${sellTax.toFixed(1)}% sell.`,12,
    'Higher than typical (most legit tokens: 0-5%) and can sometimes be raised further later.');
  else ok('Reasonable tax',`${buyTax.toFixed(1)}% buy / ${sellTax.toFixed(1)}% sell.`, 'Within a normal range.');

  if(s.is_open_source==='0') bad('Not verified','Contract source is closed.',15,
    "Nobody can verify what the code actually does — malicious functions could be hidden.");
  if(s.is_mintable==='1') warn('Mintable','Owner can create new tokens.',10,
    'A large new supply minted and sold can collapse the price overnight.');
  if(s.hidden_owner==='1') bad('Hidden owner','Owner identity concealed.',15,
    'Sometimes used to fake decentralization while secretly keeping control.');
  if(s.can_take_back_ownership==='1') bad('Ownership reclaimable','Can be taken back after renouncing.',15,
    '"Renounced" is a trust signal — this lets a dev fake it, then reclaim control later.');
  if(s.owner_change_balance==='1') bad('Balance manipulation','Owner can alter balances directly.',20,
    'The owner could zero out your balance without any transaction from you.');

  const lp=s.lp_holders||[];
  const lockedPct=lp.filter(h=>h.is_locked===1).reduce((a,h)=>a+parseFloat(h.percent||0),0)*100;
  if(lp.length>0){
    if(lockedPct<30) bad('Liquidity unlocked',`Only ${lockedPct.toFixed(0)}% locked.`,20,
      'Unlocked liquidity can be withdrawn instantly by the developer — the classic rug pull mechanism.');
    else ok('Liquidity locked',`${lockedPct.toFixed(0)}% locked.`, "Locked funds can't be easily pulled early.");
  }
  const top10=parseFloat(s.top10_holder_rate||0)*100;
  if(top10>70) bad('Whale concentration',`Top 10 hold ${top10.toFixed(0)}% of supply.`,15,
    'A few wallets selling can crash the price for everyone else.');
  else if(top10>0) ok('Distribution', `Top 10 hold ${top10.toFixed(0)}% of supply.`, 'Reasonably spread out.');

  if(!market) warn('No trading pair', 'Token may be brand new.',10, "Can't verify real liquidity or price action yet.");

  score = Math.max(0, Math.min(100, Math.round(score)));
  let tier, cls, emoji;
  if(score>=80){tier='Low Risk';cls='safe';emoji='🟢';}
  else if(score>=50){tier='Medium Risk';cls='warn';emoji='🟡';}
  else if(score>=25){tier='High Risk';cls='warn';emoji='🟡';}
  else {tier='Critical Risk';cls='bad';emoji='🔴';}

  const negatives = flags.filter(f=>f.level!=='ok');
  const oneliner = negatives.length===0
    ? 'No meaningful red flags found in the automated checks.'
    : negatives.slice(0,2).map(f=>f.desc).join(' ');

  return {score, tier, cls, emoji, flags, oneliner};
}

function renderResults(analysis, address, chain, planTier, remaining){
  document.getElementById('results').classList.add('show');
  const verdict = document.getElementById('verdict');
  verdict.className = 'verdict ' + analysis.cls;
  document.getElementById('verdictTitle').textContent = `${analysis.emoji} ${analysis.tier} (${analysis.score}/100)`;
  document.getElementById('verdictText').textContent = analysis.oneliner;

  const list = document.getElementById('flags');
  list.innerHTML = '';
  analysis.flags.slice(0,5).forEach(f=>{
    const div = document.createElement('div');
    div.className = `flag ${f.level}`;
    const whyId = 'why_' + Math.random().toString(36).slice(2);
    div.innerHTML = `<div><b>${f.title}</b><span>${f.desc}</span>
      ${f.why ? `<span class="why-toggle" data-target="${whyId}">Why? ▾</span><div class="why-text" id="${whyId}" style="display:none;">${f.why}</div>` : ''}
      </div>`;
    list.appendChild(div);
  });
  list.querySelectorAll('.why-toggle').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const el = document.getElementById(btn.dataset.target);
      const open = el.style.display !== 'none';
      el.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Why? ▾' : 'Why? ▴';
    });
  });

  document.getElementById('fullReport').href = `${SITE_URL}/?a=${address}&c=${chain}`;
  document.getElementById('quotaLine').textContent = planTier === 'pro'
    ? '⭐ Pro — unlimited scans'
    : (remaining !== null && remaining !== undefined ? `${remaining} scans left today` : '');
}

document.getElementById('shareBtn').addEventListener('click', ()=>{
  if(!lastAnalysis) return;
  const { analysis, address, chain } = lastAnalysis;
  const link = `${SITE_URL}/?a=${address}&c=${chain}`;
  const text = encodeURIComponent(`Scanned a token with Verisyn: ${analysis.emoji} ${analysis.tier} (${analysis.score}/100). Check yours before you ape in 👇\n${link}`);
  chrome.tabs.create({ url: `https://twitter.com/intent/tweet?text=${text}` });
});

refreshAuth();
