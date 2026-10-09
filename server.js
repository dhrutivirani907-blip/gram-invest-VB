/**
 * VB Miner Pro API — single-file Express backend.
 * Required env vars: DATABASE_URL, ADMIN_KEY
 * Optional env vars: PORT, DEPOSIT_ADDRESS, MIN_WITHDRAW_GRAM
 *
 * IMPORTANT: Do not commit DATABASE_URL or ADMIN_KEY to source control.
 * Set DATABASE_URL in your hosting provider's environment settings.
 */
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || 'UQAtwnP7Qt-DsZ9iFMY9ruuGdPDUUIPxP9zJ6qsekS2oljWz';
const MIN_WITHDRAW_GRAM = Number(process.env.MIN_WITHDRAW_GRAM || 0.01);
const RATE_VB_PER_GRAM = 1296000;
const MIN_CONVERT_VB = RATE_VB_PER_GRAM;
const MINER_SECONDS = 30 * 24 * 60 * 60;
const VB_PER_SECOND = 1;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is required.');
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.error('FATAL: ADMIN_KEY environment variable is required. Use a long random secret.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = ({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'})[file.mimetype];
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext || '.img'}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype))
});

function userId(req, res, next) {
  const id = String(req.header('x-user-id') || '');
  if (!/^VB-[A-F0-9]{12}$/.test(id)) return res.status(400).json({ success:false, message:'Invalid App ID. Refresh the app and try again.' });
  req.appUserId = id;
  next();
}
function admin(req, res, next) {
  const key = req.header('x-admin-key') || req.query.key || '';
  if (!crypto.timingSafeEqual(Buffer.from(String(key).padEnd(128,' ').slice(0,128)), Buffer.from(String(ADMIN_KEY).padEnd(128,' ').slice(0,128))) || String(key) !== ADMIN_KEY) {
    return res.status(401).json({ success:false, message:'Invalid admin key.' });
  }
  next();
}
function fail(res, err) {
  console.error(err);
  return res.status(500).json({ success:false, message:'Server error. Please try again later.' });
}
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      app_id TEXT PRIMARY KEY, vb_balance BIGINT NOT NULL DEFAULT 0,
      gram_balance NUMERIC(24,8) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS miners (
      id BIGSERIAL PRIMARY KEY, app_id TEXT NOT NULL REFERENCES app_users(app_id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected','completed')),
      starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, last_accrued_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), activated_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES app_users(app_id),
      proof_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES app_users(app_id),
      address TEXT NOT NULL, amount_gram NUMERIC(24,8) NOT NULL CHECK(amount_gram > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS activity_history (
      id BIGSERIAL PRIMARY KEY, app_id TEXT NOT NULL REFERENCES app_users(app_id),
      kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_miners_app_status ON miners(app_id,status);
    CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchase_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_created ON withdrawals(created_at DESC);
  `);
  console.log('PostgreSQL schema ready');
}
async function ensureUser(id) {
  await pool.query('INSERT INTO app_users(app_id) VALUES($1) ON CONFLICT(app_id) DO NOTHING', [id]);
}
async function accrue(id, client = pool) {
  const { rows } = await client.query(`SELECT id, last_accrued_at, ends_at FROM miners WHERE app_id=$1 AND status='active' FOR UPDATE`, [id]);
  const now = Date.now();
  let added = 0;
  for (const m of rows) {
    const last = new Date(m.last_accrued_at || m.starts_at || now).getTime();
    const end = new Date(m.ends_at).getTime();
    const seconds = Math.max(0, Math.floor((Math.min(now,end)-last)/1000));
    if (seconds > 0) {
      const reward = seconds * VB_PER_SECOND;
      await client.query('UPDATE app_users SET vb_balance=vb_balance+$1 WHERE app_id=$2', [reward,id]);
      await client.query(`UPDATE miners SET last_accrued_at=$1, status=CASE WHEN $1 >= ends_at THEN 'completed' ELSE status END WHERE id=$2`, [new Date(Math.min(now,end)),m.id]);
      added += reward;
    }
  }
  return added;
}
async function withUserTransaction(id, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO app_users(app_id) VALUES($1) ON CONFLICT(app_id) DO NOTHING',[id]);
    await work(client);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
app.get('/api/health', async (_req,res)=>{try{await pool.query('SELECT 1');res.json({success:true,status:'ok'})}catch(e){fail(res,e)}});
app.get('/api/config', (_req,res)=>res.json({success:true,depositAddress:DEPOSIT_ADDRESS,rateVBPerGram:RATE_VB_PER_GRAM,minConvertVB:MIN_CONVERT_VB,minWithdrawGram:MIN_WITHDRAW_GRAM}));
app.get('/api/me', userId, async (req,res)=>{
  try {
    await ensureUser(req.appUserId);
    await withUserTransaction(req.appUserId, async client => { await accrue(req.appUserId,client); });
    const {rows:[u]}=await pool.query('SELECT vb_balance,gram_balance FROM app_users WHERE app_id=$1',[req.appUserId]);
    const {rows:[m]}=await pool.query(`SELECT COUNT(*)::int AS n FROM miners WHERE app_id=$1 AND status='active'`,[req.appUserId]);
    const {rows:h}=await pool.query(`SELECT title,detail,status,created_at FROM activity_history WHERE app_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.appUserId]);
    const {rows:w}=await pool.query(`SELECT id,address,amount_gram,status,created_at FROM withdrawals WHERE app_id=$1 ORDER BY created_at DESC LIMIT 20`,[req.appUserId]);
    res.json({success:true,appId:req.appUserId,vbBalance:Number(u.vb_balance),gramBalance:Number(u.gram_balance),activeMiners:m.n,history:h,withdrawals:w});
  } catch(e){fail(res,e)}
});
app.post('/api/purchase-requests', userId, (req,res,next)=>upload.single('proof')(req,res,e=>e?res.status(400).json({success:false,message:e.code==='LIMIT_FILE_SIZE'?'Image must be 5 MB or smaller':'Upload a valid PNG, JPG or WEBP image'}):next()), async (req,res)=>{
  if(!req.file) return res.status(400).json({success:false,message:'Payment proof image is required.'});
  const client=await pool.connect(); const id='PUR-'+crypto.randomBytes(6).toString('hex').toUpperCase();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO app_users(app_id) VALUES($1) ON CONFLICT(app_id) DO NOTHING',[req.appUserId]);
    await client.query('INSERT INTO purchase_requests(id,app_id,proof_path) VALUES($1,$2,$3)',[id,req.appUserId,req.file.filename]);
    await client.query(`INSERT INTO activity_history(app_id,kind,title,detail,status) VALUES($1,'purchase','Miner purchase request','Request '+$2,'pending')`,[req.appUserId,id]);
    await client.query('COMMIT'); res.json({success:true,requestId:id,message:'Request submitted for review.'});
  } catch(e){await client.query('ROLLBACK');try{fs.unlinkSync(req.file.path)}catch{}fail(res,e)} finally{client.release()}
});
app.post('/api/convert', userId, async(req,res)=>{
  try {
    let converted=0,received=0;
    await withUserTransaction(req.appUserId,async client=>{
      await accrue(req.appUserId,client);
      const {rows:[u]}=await client.query('SELECT vb_balance FROM app_users WHERE app_id=$1 FOR UPDATE',[req.appUserId]);
      const balance=Number(u.vb_balance);
      if(balance<MIN_CONVERT_VB) throw Object.assign(new Error('Minimum conversion is 1,296,000 VB.'),{status:400});
      converted=Math.floor(balance/MIN_CONVERT_VB)*MIN_CONVERT_VB;
      received=converted/RATE_VB_PER_GRAM;
      await client.query('UPDATE app_users SET vb_balance=vb_balance-$1, gram_balance=gram_balance+$2 WHERE app_id=$3',[converted,received,req.appUserId]);
      await client.query(`INSERT INTO activity_history(app_id,kind,title,detail,status) VALUES($1,'convert','VB converted to GRAM',$2,'approved')`,[req.appUserId,`${converted} VB → ${received} GRAM`]);
    });
    res.json({success:true,convertedVB:converted,gramReceived:received});
  }catch(e){if(e.status)return res.status(e.status).json({success:false,message:e.message});fail(res,e)}
});
app.post('/api/withdrawals', userId, async(req,res)=>{
  const address=String(req.body.address||'').trim(),amount=Number(req.body.amount);
  if(address.length<10||address.length>200) return res.status(400).json({success:false,message:'Enter a valid TON network address.'});
  if(!Number.isFinite(amount)||amount<MIN_WITHDRAW_GRAM) return res.status(400).json({success:false,message:`Minimum withdrawal is ${MIN_WITHDRAW_GRAM} GRAM.`});
  const id='WD-'+crypto.randomBytes(6).toString('hex').toUpperCase();
  try{
    await withUserTransaction(req.appUserId,async client=>{
      await accrue(req.appUserId,client);
      const {rows:[u]}=await client.query('SELECT gram_balance FROM app_users WHERE app_id=$1 FOR UPDATE',[req.appUserId]);
      if(Number(u.gram_balance)<amount) throw Object.assign(new Error('Insufficient GRAM balance.'),{status:400});
      await client.query('UPDATE app_users SET gram_balance=gram_balance-$1 WHERE app_id=$2',[amount,req.appUserId]);
      await client.query('INSERT INTO withdrawals(id,app_id,address,amount_gram) VALUES($1,$2,$3,$4)',[id,req.appUserId,address,amount]);
      await client.query(`INSERT INTO activity_history(app_id,kind,title,detail,status) VALUES($1,'withdrawal','GRAM withdrawal request',$2,'pending')`,[req.appUserId,`${amount} GRAM · ${id}`]);
    });
    res.json({success:true,requestId:id});
  }catch(e){if(e.status)return res.status(e.status).json({success:false,message:e.message});fail(res,e)}
});

// Admin UI is served from the same HTML document in admin mode.
app.get('/admin', (_req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>VB Miner Admin</title><style>body{margin:0;background:#030916;color:#eaf6ff;font:14px system-ui;padding:18px}.wrap{max-width:1100px;margin:auto}h1{color:#55ddff}input,select{background:#07172c;border:1px solid #20527d;border-radius:9px;color:white;padding:11px;margin:4px}button{background:linear-gradient(100deg,#075be8,#00c8ff);border:0;color:white;border-radius:9px;padding:10px 13px;font-weight:bold;cursor:pointer;margin:3px}.panel{background:#08172b;border:1px solid #17446f;border-radius:14px;padding:15px;margin:14px 0;overflow:auto}.tabs{display:flex;flex-wrap:wrap;gap:6px}.tabs button{background:#0b2c51}.muted{color:#90accb;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}.metric{background:#051124;border:1px solid #16436b;border-radius:10px;padding:13px}.metric b{display:block;font-size:24px;color:#5be4ff}table{border-collapse:collapse;width:100%;min-width:650px}td,th{text-align:left;padding:10px;border-bottom:1px solid #17334f;vertical-align:top}th{color:#63dcff}.status{color:#ffd56b}.proof{max-width:240px;max-height:180px;display:block}.danger{background:#9e2446}.hidden{display:none}</style></head><body><div class="wrap"><h1>VB MINER · ADMIN PANEL</h1><p class="muted">Private operations dashboard. Keep your admin key secret.</p><div class="panel"><label>Admin key <input id="key" type="password" placeholder="Enter ADMIN_KEY" style="width:min(500px,80%)"></label><button onclick="saveKey()">Unlock panel</button><span id="msg" class="muted"></span></div><div id="dashboard" class="hidden"><div class="grid" id="metrics"></div><div class="panel"><div class="tabs"><button onclick="load('purchases')">Purchase requests</button><button onclick="load('withdrawals')">Withdrawals</button><button onclick="load('users')">Users & balances</button><button onclick="load('miners')">Miners</button></div><p class="muted">Approving a purchase activates a 30-day miner. Approving a withdrawal only marks it approved; send the on-chain payment separately.</p><div id="content">Choose a section.</div></div><div class="panel"><h3>Manually activate miner</h3><p class="muted">Use only after independently verifying the payment.</p><input id="activateId" placeholder="VB-APPID" style="width:280px"><button onclick="activateMiner()">Activate 30-day miner</button></div></div></div><script>let key=sessionStorage.getItem('vb_admin_key')||'';document.getElementById('key').value=key;function saveKey(){key=document.getElementById('key').value.trim();sessionStorage.setItem('vb_admin_key',key);document.getElementById('dashboard').classList.remove('hidden');loadOverview();load('purchases')}async function req(url,opts={}){let r=await fetch(url,{...opts,headers:{'Content-Type':'application/json','x-admin-key':key,...(opts.headers||{})}});let d=await r.json();if(!r.ok||d.success===false)throw Error(d.message||'Request failed');return d}function say(s){document.getElementById('msg').textContent=s}async function loadOverview(){try{let d=await req('/admin-api/overview');document.getElementById('metrics').innerHTML=[['Users',d.users],['Pending purchases',d.pendingPurchases],['Pending withdrawals',d.pendingWithdrawals],['Active miners',d.activeMiners]].map(x=>'<div class="metric">'+x[0]+'<b>'+x[1]+'</b></div>').join('');say('Authenticated')}catch(e){say(e.message);document.getElementById('dashboard').classList.add('hidden')}}async function load(which){let el=document.getElementById('content');el.innerHTML='Loading…';try{let d=await req('/admin-api/'+which);let a=d.items||[];if(which==='purchases')el.innerHTML='<table><tr><th>Request / App ID</th><th>Proof</th><th>Status</th><th>Submitted</th><th>Review</th></tr>'+a.map(x=>'<tr><td><b>'+esc(x.id)+'</b><br>'+esc(x.app_id)+'<br><button onclick="copyText(\''+esc(x.app_id)+'\')">Copy App ID</button></td><td><img class="proof" src="'+x.proof_url+'?key='+encodeURIComponent(key)+'" alt="Proof" onerror="this.style.display=\'none\'"></td><td>'+esc(x.status)+'<br><span class="muted">'+esc(x.admin_note||'')+'</span></td><td>'+new Date(x.created_at).toLocaleString()+'</td><td><button onclick="review(\'purchases\',\''+esc(x.id)+'\',\'approve\')">Approve & activate</button><button class="danger" onclick="review(\'purchases\',\''+esc(x.id)+'\',\'reject\')">Reject</button></td></tr>').join('')+'</table>';else if(which==='withdrawals')el.innerHTML='<table><tr><th>ID / App ID</th><th>Amount</th><th>TON address</th><th>Status</th><th>Review</th></tr>'+a.map(x=>'<tr><td>'+esc(x.id)+'<br>'+esc(x.app_id)+'</td><td>'+esc(x.amount_gram)+' GRAM</td><td>'+esc(x.address)+'<br><button onclick="copyText(\''+esc(x.address)+'\')">Copy address</button></td><td>'+esc(x.status)+'<br>'+esc(x.admin_note||'')+'</td><td><button onclick="review(\'withdrawals\',\''+esc(x.id)+'\',\'approve\')">Mark paid / approve</button><button class="danger" onclick="review(\'withdrawals\',\''+esc(x.id)+'\',\'reject\')">Reject & refund</button></td></tr>').join('')+'</table>';else if(which==='users')el.innerHTML='<table><tr><th>App ID</th><th>VB balance</th><th>GRAM balance</th><th>Active miners</th><th>Created</th></tr>'+a.map(x=>'<tr><td>'+esc(x.app_id)+' <button onclick="copyText(\''+esc(x.app_id)+'\')">Copy</button></td><td>'+Number(x.vb_balance).toLocaleString()+'</td><td>'+esc(x.gram_balance)+'</td><td>'+x.active_miners+'</td><td>'+new Date(x.created_at).toLocaleString()+'</td></tr>').join('')+'</table>';else el.innerHTML='<table><tr><th>Miner</th><th>App ID</th><th>Status</th><th>Start</th><th>End</th></tr>'+a.map(x=>'<tr><td>#'+x.id+'</td><td>'+esc(x.app_id)+'</td><td>'+esc(x.status)+'</td><td>'+ (x.starts_at?new Date(x.starts_at).toLocaleString():'—')+'</td><td>'+ (x.ends_at?new Date(x.ends_at).toLocaleString():'—')+'</td></tr>').join('')+'</table>';if(!a.length)el.innerHTML='No records yet.'}catch(e){el.textContent=e.message}}function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function review(type,id,action){let note=prompt('Optional review note:')||'';try{await req('/admin-api/'+type+'/'+encodeURIComponent(id)+'/review',{method:'POST',body:JSON.stringify({action,note})});say('Request updated');loadOverview();load(type)}catch(e){alert(e.message)}}async function activateMiner(){try{let appId=document.getElementById('activateId').value.trim();let d=await req('/admin-api/miners/activate',{method:'POST',body:JSON.stringify({appId})});say('Miner #'+d.minerId+' activated');loadOverview();load('miners')}catch(e){alert(e.message)}}async function copyText(s){try{await navigator.clipboard.writeText(s);say('Copied')}catch{prompt('Copy this:',s)}}saveKey();</script></body></html>`));
// Admin endpoints are protected by x-admin-key; never expose the key in public frontend source.
app.get('/admin-api/overview',admin,async(_req,res)=>{
  try{
    const [users,purchases,withdrawals,miners]=await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM app_users`),
      pool.query(`SELECT COUNT(*)::int AS n FROM purchase_requests WHERE status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM withdrawals WHERE status='pending'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM miners WHERE status='active'`)
    ]);
    res.json({success:true,users:users.rows[0].n,pendingPurchases:purchases.rows[0].n,pendingWithdrawals:withdrawals.rows[0].n,activeMiners:miners.rows[0].n});
  }catch(e){fail(res,e)}
});
app.get('/admin-api/purchases',admin,async(_req,res)=>{try{const {rows}=await pool.query(`SELECT p.id,p.app_id,p.proof_path,p.status,p.created_at,p.admin_note FROM purchase_requests p ORDER BY p.created_at DESC LIMIT 300`);res.json({success:true,items:rows.map(r=>({...r,proof_url:'/admin-api/proof/'+encodeURIComponent(r.id)}))})}catch(e){fail(res,e)}});
app.get('/admin-api/proof/:id',admin,async(req,res)=>{try{const {rows}=await pool.query('SELECT proof_path FROM purchase_requests WHERE id=$1',[req.params.id]);if(!rows[0])return res.sendStatus(404);const file=path.join(UPLOAD_DIR,path.basename(rows[0].proof_path));if(!fs.existsSync(file))return res.sendStatus(404);res.sendFile(file)}catch(e){fail(res,e)}});
app.post('/admin-api/purchases/:id/review',admin,async(req,res)=>{
  const action=String(req.body.action||''),note=String(req.body.note||'').slice(0,500);
  if(!['approve','reject'].includes(action))return res.status(400).json({success:false,message:'Action must be approve or reject.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT * FROM purchase_requests WHERE id=$1 FOR UPDATE',[req.params.id]);
    const p=rows[0];if(!p)throw Object.assign(new Error('Request not found.'),{status:404});
    if(p.status!=='pending')throw Object.assign(new Error('This request has already been reviewed.'),{status:409});
    if(action==='approve'){
      const miner=await client.query(`INSERT INTO miners(app_id,status) VALUES($1,'active') RETURNING id`,[p.app_id]);
      const now=new Date(),end=new Date(now.getTime()+MINER_SECONDS*1000);
      await client.query(`UPDATE miners SET starts_at=$1,ends_at=$2,last_accrued_at=$1,activated_at=$1 WHERE id=$3`,[now,end,miner.rows[0].id]);
    }
    await client.query('UPDATE purchase_requests SET status=$1,admin_note=$2,reviewed_at=NOW() WHERE id=$3',[action==='approve'?'approved':'rejected',note,p.id]);
    await client.query(`UPDATE activity_history SET status=$1,detail=detail || $2 WHERE app_id=$3 AND detail LIKE $4 AND kind='purchase'`,[action==='approve'?'approved':'rejected',note?` · ${note}`:'',p.app_id,`%${p.id}%`]);
    await client.query('COMMIT');res.json({success:true,message:action==='approve'?'Purchase approved and miner activated.':'Purchase request rejected.'});
  }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({success:false,message:e.message});fail(res,e)}finally{client.release()}
});
app.get('/admin-api/withdrawals',admin,async(_req,res)=>{try{const {rows}=await pool.query(`SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 500`);res.json({success:true,items:rows})}catch(e){fail(res,e)}});
app.post('/admin-api/withdrawals/:id/review',admin,async(req,res)=>{
  const action=String(req.body.action||''),note=String(req.body.note||'').slice(0,500);
  if(!['approve','reject'].includes(action))return res.status(400).json({success:false,message:'Action must be approve or reject.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[req.params.id]);const w=rows[0];
    if(!w)throw Object.assign(new Error('Request not found.'),{status:404});
    if(w.status!=='pending')throw Object.assign(new Error('Already reviewed.'),{status:409});
    if(action==='reject')await client.query('UPDATE app_users SET gram_balance=gram_balance+$1 WHERE app_id=$2',[w.amount_gram,w.app_id]);
    await client.query('UPDATE withdrawals SET status=$1,admin_note=$2,reviewed_at=NOW() WHERE id=$3',[action==='approve'?'approved':'rejected',note,w.id]);
    await client.query(`UPDATE activity_history SET status=$1,detail=detail || $2 WHERE app_id=$3 AND detail LIKE $4 AND kind='withdrawal'`,[action==='approve'?'approved':'rejected',note?` · ${note}`:'',w.app_id,`%${w.id}%`]);
    await client.query('COMMIT');res.json({success:true,message:action==='approve'?'Withdrawal marked approved. Complete the on-chain payment separately.':'Withdrawal rejected and balance refunded.'});
  }catch(e){await client.query('ROLLBACK');if(e.status)return res.status(e.status).json({success:false,message:e.message});fail(res,e)}finally{client.release()}
});
app.get('/admin-api/users',admin,async(_req,res)=>{try{const {rows}=await pool.query(`SELECT u.app_id,u.vb_balance,u.gram_balance,u.created_at,(SELECT COUNT(*) FROM miners m WHERE m.app_id=u.app_id AND m.status='active')::int AS active_miners FROM app_users u ORDER BY u.created_at DESC LIMIT 500`);res.json({success:true,items:rows})}catch(e){fail(res,e)}});
app.post('/admin-api/miners/activate',admin,async(req,res)=>{
  const id=String(req.body.appId||'').trim();if(!/^VB-[A-F0-9]{12}$/.test(id))return res.status(400).json({success:false,message:'Invalid App ID.'});
  try{
    await ensureUser(id);
    const now=new Date(),end=new Date(now.getTime()+MINER_SECONDS*1000);
    const {rows}=await pool.query(`INSERT INTO miners(app_id,status,starts_at,ends_at,last_accrued_at,activated_at) VALUES($1,'active',$2,$3,$2,$2) RETURNING id`,[id,now,end]);
    await pool.query(`INSERT INTO activity_history(app_id,kind,title,detail,status) VALUES($1,'miner','Miner activated',$2,'approved')`,[id,`Miner #${rows[0].id} · 30 days`]);
    res.json({success:true,minerId:rows[0].id});
  }catch(e){fail(res,e)}
});
app.get('/admin-api/miners',admin,async(_req,res)=>{try{const {rows}=await pool.query(`SELECT id,app_id,status,starts_at,ends_at,created_at FROM miners ORDER BY created_at DESC LIMIT 500`);res.json({success:true,items:rows})}catch(e){fail(res,e)}});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({success:false,message:'Unexpected server error.'})});
initDb().then(()=>app.listen(PORT,()=>console.log(`VB Miner API listening on ${PORT}`))).catch(e=>{console.error('Database initialization failed',e);process.exit(1)});
