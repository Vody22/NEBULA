'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=Number(process.env.PORT||3000),ROOT=__dirname;
const dir=process.env.DATA_DIR||'/tmp/crushcast-live';
fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'data.sqlite'));
db.exec([
'PRAGMA foreign_keys=ON;',
'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,name TEXT NOT NULL,birth TEXT NOT NULL,city TEXT NOT NULL,bio TEXT NOT NULL DEFAULT \'\',interests TEXT NOT NULL DEFAULT \'\',intent TEXT NOT NULL DEFAULT \'Rencontrer quelqu’un\',avatar TEXT NOT NULL DEFAULT \'💜\',created INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0,shared INTEGER NOT NULL DEFAULT 0);',
'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);',
'CREATE TABLE IF NOT EXISTS likes(sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(sender,target));',
'CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,UNIQUE(a,b));',
'CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,match TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,at INTEGER NOT NULL);',
'CREATE TABLE IF NOT EXISTS blocks(sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(sender,target));',
'CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,reason TEXT NOT NULL,at INTEGER NOT NULL);'
].join('\n'));

db.exec([
"CREATE TABLE IF NOT EXISTS passes(sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,at INTEGER NOT NULL,PRIMARY KEY(sender,target));",
"CREATE TABLE IF NOT EXISTS favorites(sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,at INTEGER NOT NULL,PRIMARY KEY(sender,target));",
"CREATE TABLE IF NOT EXISTS date_invites(id TEXT PRIMARY KEY,match TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,idea TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',at INTEGER NOT NULL);",
"CREATE INDEX IF NOT EXISTS message_order ON messages(match,at);",
"CREATE INDEX IF NOT EXISTS invite_order ON date_invites(match,at);"
].join('\n'));
db.exec("CREATE TABLE IF NOT EXISTS conversation_reads(match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,seen_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(match_id,user_id));");

/* Backwards-compatible schema expansion. No existing records are erased. */
const columns=new Set(db.prepare('PRAGMA table_info(users)').all().map(x=>x.name));
if(!columns.has('prompt'))db.exec("ALTER TABLE users ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
if(!columns.has('answer'))db.exec("ALTER TABLE users ADD COLUMN answer TEXT NOT NULL DEFAULT ''");
if(!columns.has('terms_at'))db.exec("ALTER TABLE users ADD COLUMN terms_at INTEGER NOT NULL DEFAULT 0");
const PROMPTS=Object.freeze([
 'Mon dimanche idéal',
 'Une activité que je rêve d’essayer',
 'Le meilleur conseil que j’ai reçu',
 'Une chose qui me fait rire',
 'Mon endroit préféré pour une première rencontre',
 'Trois mots qui me décrivent'
]);
const limits=new Map(),id=()=>crypto.randomUUID(),now=()=>Date.now(),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function rate(k,max,period){const t=now(),b=limits.get(k)||{n:0,until:0};if(b.until<t){b.n=0;b.until=t+period}b.n++;limits.set(k,b);return b.n<=max}
setInterval(()=>{for(const [k,b]of limits)if(b.until<now())limits.delete(k);db.prepare('DELETE FROM sessions WHERE expires<?').run(now())},60000).unref();
const str=(v,n=180)=>typeof v==='string'?v.trim().slice(0,n):'';
function respond(res,status,data,type='application/json; charset=utf-8'){
 res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Strict-Transport-Security':'max-age=31536000','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
 res.end(typeof data==='string'?data:JSON.stringify(data));
}
const err=(r,c,m)=>respond(r,c,{error:m});
function age(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return NaN;const b=new Date(s+'T12:00:00Z');if(!Number.isFinite(b.getTime())||b.toISOString().slice(0,10)!==s)return NaN;const t=new Date();return t.getUTCFullYear()-b.getUTCFullYear()-(t.getUTCMonth()<b.getUTCMonth()||(t.getUTCMonth()===b.getUTCMonth()&&t.getUTCDate()<b.getUTCDate())?1:0)}
function cookie(req){const c=(req.headers.cookie||'').split(';').find(s=>s.trim().startsWith('cc_token='));return c?c.trim().slice(9):''}
function current(req){const raw=cookie(req);if(!/^[0-9a-f]{64}$/.test(raw))return null;const s=db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires>?').get(hash(raw),now());return s?db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id):null}
function profile(u){return {id:u.id,name:u.name,age:age(u.birth),city:u.city,bio:u.bio,interests:u.interests,intent:u.intent,avatar:u.avatar,prompt:u.prompt||'',answer:u.answer||''}}
function me(u){return {...profile(u),email:u.email,birth:u.birth,paused:!!u.paused,shared:!!u.shared,termsAccepted:!!u.terms_at}}
function interestList(t){return [...new Set(str(t||'',180).split(',').map(x=>x.trim().toLocaleLowerCase('fr')).filter(Boolean))].slice(0,8)}
function commonInterests(a,b){const keys=new Set(interestList(b.interests));return interestList(a.interests).filter(x=>keys.has(x))}
const unreadStmt=db.prepare('SELECT COUNT(*) AS n FROM messages WHERE match=? AND sender<>? AND at>COALESCE((SELECT seen_at FROM conversation_reads WHERE match_id=? AND user_id=?),0)');
function unreadFor(matchId,userId){return unreadStmt.get(matchId,userId,matchId,userId).n}
function login(res,u){const raw=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw),u.id,now()+1209600000);res.setHeader('Set-Cookie','cc_token='+raw+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600')}
function otherBlocked(a,b){return !!db.prepare('SELECT 1 FROM blocks WHERE (sender=? AND target=?) OR (sender=? AND target=?)').get(a,b,b,a)}
function body(req){return new Promise((ok,no)=>{let s='';req.on('data',c=>{s+=c;if(s.length>8192){no(Error('Taille maximale dépassée'));req.destroy()}});req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch{no(Error('JSON incorrect'))}});req.on('error',no)})}
function safeHtml(t){return String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
 const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'https://crushcast.local'),p=url.pathname,m=req.method,ip=req.socket.remoteAddress||'local';
 try{
 if(m==='GET'&&(p==='/'||p==='/index.html'))return respond(res,200,fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),'text/html; charset=utf-8');
 if(m==='GET'&&p==='/app.css')return respond(res,200,fs.readFileSync(path.join(ROOT,'app.css'),'utf8'),'text/css; charset=utf-8');
 if(m==='GET'&&p==='/app.js')return respond(res,200,fs.readFileSync(path.join(ROOT,'app.js'),'utf8'),'application/javascript; charset=utf-8');
 if(m==='GET'&&p==='/manifest.webmanifest')return respond(res,200,fs.readFileSync(path.join(ROOT,'manifest.webmanifest'),'utf8'),'application/manifest+json; charset=utf-8');
 if(m==='GET'&&p==='/icon.svg')return respond(res,200,fs.readFileSync(path.join(ROOT,'icon.svg'),'utf8'),'image/svg+xml; charset=utf-8');
 if(m==='GET'&&p==='/health')return respond(res,200,{ok:true,version:'CRUSHCAST V6 beta',temporaryStorage:true});
 if(m==='GET'&&p==='/robots.txt')return respond(res,200,'User-agent: *\nDisallow: /api/\nDisallow: /p/\n','text/plain');
 if(m==='GET'&&p.startsWith('/p/')){
  const target=str(p.slice(3),50),v=db.prepare('SELECT * FROM users WHERE id=? AND shared=1 AND paused=0').get(target);
  if(!v)return err(res,404,'Profil privé ou indisponible');
  const pp=profile(v),page='<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>'+safeHtml(pp.name)+' sur CRUSHCAST</title><link rel="stylesheet" href="/app.css"></head><body><main class="shared"><div class="logo">♥ CRUSHCAST</div><div class="hero-icon">'+safeHtml(pp.avatar)+'</div><h1>'+safeHtml(pp.name)+', '+pp.age+' ans</h1><p>'+safeHtml(pp.city)+'</p><p>'+safeHtml(pp.bio)+'</p><a class="primary-button" href="/">Découvrir CRUSHCAST</a></main></body></html>';
  return respond(res,200,page,'text/html; charset=utf-8');
 }
 if(['POST','PUT','DELETE'].includes(m)&&req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return err(res,403,'Origine interdite')}catch{return err(res,403,'Origine interdite')}}
 if(!p.startsWith('/api/'))return err(res,404,'Page introuvable');
 if(!rate(ip+':all',180,60000))return err(res,429,'Trop de requêtes');
 if((p==='/api/register'||p==='/api/login')&&m==='POST'){
  if(!rate(ip+':auth',14,3600000))return err(res,429,'Trop de tentatives');
  const d=await body(req),email=str(d.email,180).toLowerCase(),pw=d.password;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof pw!=='string'||pw.length<10||pw.length>128)return err(res,400,'E-mail ou mot de passe invalide (10 caractères minimum)');
  if(p==='/api/login'){const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u)return err(res,401,'Identifiants incorrects');const test=crypto.scryptSync(pw,u.salt,64),given=Buffer.from(u.hash,'hex');if(test.length!==given.length||!crypto.timingSafeEqual(test,given))return err(res,401,'Identifiants incorrects');login(res,u);return respond(res,200,{user:me(u)})}
  if(!rate(ip+':signup',5,86400000))return err(res,429,'Limite de création atteinte');
  const name=str(d.name,30),city=str(d.city,55),birth=str(d.birth,10);
  if(d.acceptTerms!==true)return err(res,400,'Tu dois accepter les conditions de la bêta pour créer un compte');
  if(name.length<2||city.length<2||!(age(birth)>=18&&age(birth)<=110))return err(res,400,'Prénom, ville et majorité 18+ requis');
  if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return err(res,409,'Adresse déjà utilisée');
  const salt=crypto.randomBytes(16).toString('hex'),uid=id();
  db.prepare('INSERT INTO users(id,email,salt,hash,name,birth,city,created,terms_at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid,email,salt,crypto.scryptSync(pw,salt,64).toString('hex'),name,birth,city,now(),now());
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(uid);login(res,u);return respond(res,201,{user:me(u)});
 }
 if(p==='/api/logout'&&m==='POST'){const raw=cookie(req);if(/^[0-9a-f]{64}$/.test(raw))db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(raw));res.setHeader('Set-Cookie','cc_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');return respond(res,200,{ok:true})}
 const u=current(req);if(!u)return err(res,401,'Connexion nécessaire');
 if(p==='/api/me'&&m==='GET')return respond(res,200,{user:me(u)});
 if(p==='/api/profile'&&m==='PUT'){
  const d=await body(req),name=str(d.name,30),city=str(d.city,55),bio=str(d.bio,350),interests=str(d.interests,180),intent=str(d.intent,80),avatar=str(d.avatar,8),prompt=str(d.prompt,100),answer=str(d.answer,180);
  if(name.length<2||city.length<2||interests.split(',').length>8||!['💜','🌸','🌞','🌊','✨','🧡','🌻','🎧'].includes(avatar)|| (prompt&&!PROMPTS.includes(prompt)) || (answer&&!prompt))return err(res,400,'Profil invalide');
  db.prepare('UPDATE users SET name=?,city=?,bio=?,interests=?,intent=?,avatar=?,paused=?,shared=?,prompt=?,answer=? WHERE id=?').run(name,city,bio,interests,intent,avatar,d.paused?1:0,d.shared?1:0,prompt,answer,u.id);
  return respond(res,200,{user:me(db.prepare('SELECT * FROM users WHERE id=?').get(u.id))});
 }
 if(p==='/api/discover'&&m==='GET'){
  const query=url.searchParams,city=str(query.get('city'),55).toLowerCase(),interest=str(query.get('interest'),60).toLowerCase();
  const minAge=Math.min(100,Math.max(18,parseInt(query.get('minAge')||'18',10)||18));
  const maxAge=Math.min(100,Math.max(minAge,parseInt(query.get('maxAge')||'100',10)||100));
  const list=db.prepare('SELECT * FROM users WHERE id<>? AND paused=0 AND NOT EXISTS(SELECT 1 FROM blocks WHERE (sender=? AND target=users.id) OR (target=? AND sender=users.id)) AND NOT EXISTS(SELECT 1 FROM likes WHERE sender=? AND target=users.id) AND NOT EXISTS(SELECT 1 FROM passes WHERE sender=? AND target=users.id) ORDER BY created DESC LIMIT 500').all(u.id,u.id,u.id,u.id,u.id);
  const users=(u.paused?[]:list.filter(x=>age(x.birth)>=minAge&&age(x.birth)<=maxAge&&(!city||x.city.toLowerCase().includes(city))&&(!interest||x.interests.toLowerCase().includes(interest)))).sort((a,b)=>commonInterests(u,b).length-commonInterests(u,a).length||b.created-a.created).slice(0,50);
  return respond(res,200,{users:users.map(x=>({...profile(x),commonInterests:commonInterests(u,x)}))});
 }
 if(p==='/api/pass'&&m==='POST'){
  const target=str((await body(req)).id,50);
  if(target===u.id||!db.prepare('SELECT 1 FROM users WHERE id=?').get(target))return err(res,400,'Profil invalide');
  db.prepare('INSERT OR IGNORE INTO passes VALUES(?,?,?)').run(u.id,target,now());
  return respond(res,200,{ok:true});
 }
 if(p==='/api/passes/reset'&&m==='POST'){
  db.prepare('DELETE FROM passes WHERE sender=?').run(u.id);
  return respond(res,200,{ok:true});
 }
 if(p==='/api/favorites'&&m==='GET'){
  const rows=db.prepare('SELECT users.* FROM favorites JOIN users ON users.id=favorites.target WHERE favorites.sender=? AND users.paused=0 ORDER BY favorites.at DESC LIMIT 80').all(u.id).filter(x=>!otherBlocked(u.id,x.id));
  return respond(res,200,{users:rows.map(profile)});
 }
 if(p==='/api/favorites'&&m==='POST'){
  const target=str((await body(req)).id,50),other=db.prepare('SELECT id FROM users WHERE id=? AND paused=0').get(target);
  if(!other||target===u.id||otherBlocked(u.id,target))return err(res,400,'Favori invalide');
  const existing=db.prepare('SELECT 1 FROM favorites WHERE sender=? AND target=?').get(u.id,target);
  if(existing)db.prepare('DELETE FROM favorites WHERE sender=? AND target=?').run(u.id,target);
  else db.prepare('INSERT INTO favorites VALUES(?,?,?)').run(u.id,target,now());
  return respond(res,200,{ok:true,favorited:!existing});
 }
 if(p==='/api/blocked'&&m==='GET'){
  const rows=db.prepare('SELECT users.* FROM blocks JOIN users ON users.id=blocks.target WHERE blocks.sender=?').all(u.id);
  return respond(res,200,{users:rows.map(profile)});
 }
 if(p==='/api/unblock'&&m==='POST'){
  const target=str((await body(req)).id,50);
  db.prepare('DELETE FROM blocks WHERE sender=? AND target=?').run(u.id,target);
  return respond(res,200,{ok:true});
 }
 if(p==='/api/unmatch'&&m==='POST'){
  const mid=str((await body(req)).id,50),x=db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(mid,u.id,u.id);
  if(!x)return err(res,404,'Match introuvable');
  const other=x.a===u.id?x.b:x.a;
  db.prepare('DELETE FROM matches WHERE id=?').run(mid);
  db.prepare('DELETE FROM likes WHERE (sender=? AND target=?) OR (sender=? AND target=?)').run(u.id,other,other,u.id);
  db.prepare('INSERT OR IGNORE INTO passes VALUES(?,?,?)').run(u.id,other,now());
  return respond(res,200,{ok:true});
 }
 if(p==='/api/date-invites'&&m==='GET'){
  const mid=str(url.searchParams.get('match'),50),match=db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(mid,u.id,u.id);
  if(!match||otherBlocked(match.a,match.b))return err(res,403,'Match introuvable');
  return respond(res,200,{invites:db.prepare('SELECT * FROM date_invites WHERE match=? ORDER BY at DESC LIMIT 20').all(mid)});
 }
 if(p==='/api/date-invites'&&m==='POST'){
  const d=await body(req),mid=str(d.match,50),idea=str(d.idea,80),note=str(d.note,200);
  const match=db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(mid,u.id,u.id);
  if(!match||otherBlocked(match.a,match.b))return err(res,403,'Match introuvable');
  if(idea.length<3)return err(res,400,'Propose une activité');
  if(!rate(u.id+':invites',5,86400000))return err(res,429,'Trop de propositions');
  db.prepare('INSERT INTO date_invites(id,match,sender,idea,note,at) VALUES(?,?,?,?,?,?)').run(id(),mid,u.id,idea,note,now());
  return respond(res,201,{ok:true});
 }
 if(p==='/api/date-invites/respond'&&m==='POST'){
  const d=await body(req),inv=db.prepare('SELECT * FROM date_invites WHERE id=?').get(str(d.id,50));
  if(!inv||inv.sender===u.id||!['accepted','declined'].includes(d.status))return err(res,403,'Action interdite');
  const match=db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(inv.match,u.id,u.id);
  if(!match||otherBlocked(match.a,match.b)||inv.status!=='pending')return err(res,403,'Proposition indisponible');
  db.prepare('UPDATE date_invites SET status=? WHERE id=?').run(d.status,inv.id);
  return respond(res,200,{ok:true});
 }
 if(p==='/api/password'&&m==='POST'){
  if(!rate(u.id+':pw',5,3600000))return err(res,429,'Trop de tentatives');
  const d=await body(req),old=d.currentPassword,newPass=d.newPassword;
  if(typeof old!=='string'||typeof newPass!=='string'||newPass.length<10||newPass.length>128)return err(res,400,'Mot de passe invalide');
  const oldHash=crypto.scryptSync(old,u.salt,64),prev=Buffer.from(u.hash,'hex');
  if(!crypto.timingSafeEqual(oldHash,prev))return err(res,403,'Mot de passe actuel incorrect');
  const salt=crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt,crypto.scryptSync(newPass,salt,64).toString('hex'),u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND hash<>?').run(u.id,hash(cookie(req)));
  return respond(res,200,{ok:true});
 }
 if(p==='/api/prompt-library'&&m==='GET')return respond(res,200,{prompts:PROMPTS});
 if(p==='/api/insights'&&m==='GET'){
  const matches=db.prepare('SELECT count(*) as n FROM matches WHERE a=? OR b=?').get(u.id,u.id).n;
  const likes=db.prepare('SELECT count(*) as n FROM likes WHERE sender=?').get(u.id).n;
  const favorites=db.prepare('SELECT count(*) as n FROM favorites WHERE sender=?').get(u.id).n;
  return respond(res,200,{matches,likes,favorites,received:db.prepare('SELECT COUNT(*) AS n FROM likes WHERE target=?').get(u.id).n});
 }
 
 if(p==='/api/like'&&m==='POST'){
  const d=await body(req),to=str(d.id,50),v=db.prepare('SELECT * FROM users WHERE id=? AND paused=0').get(to);
  if(u.paused||!v||u.id===to||otherBlocked(u.id,to))return err(res,400,'Like impossible');
  db.prepare('INSERT OR IGNORE INTO likes VALUES(?,?)').run(u.id,to);
  const mutual=!!db.prepare('SELECT 1 FROM likes WHERE sender=? AND target=?').get(to,u.id);
  if(mutual){const [a,b]=[u.id,to].sort();db.prepare('INSERT OR IGNORE INTO matches VALUES(?,?,?)').run(id(),a,b)}
  return respond(res,200,{ok:true,matched:mutual});
 }
 if(p==='/api/matches'&&m==='GET'){
  const mm=db.prepare('SELECT * FROM matches WHERE a=? OR b=?').all(u.id,u.id);
  return respond(res,200,{matches:mm.flatMap(x=>{const o=db.prepare('SELECT * FROM users WHERE id=?').get(x.a===u.id?x.b:x.a);return o&&!o.paused&&!otherBlocked(u.id,o.id)?[{id:x.id,person:{...profile(o),commonInterests:commonInterests(u,o)},unread:unreadFor(x.id,u.id)}]:[]})});
 }
 if(p==='/api/messages'&&(m==='GET'||m==='POST')){
  const d=m==='POST'?await body(req):{},matchId=str(m==='GET'?url.searchParams.get('match'):d.match,50);
  const x=db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(matchId,u.id,u.id);
  if(!x||otherBlocked(x.a,x.b))return err(res,403,'Conversation indisponible');
  if(m==='GET'){
    const messages=db.prepare('SELECT id,sender,text,at FROM messages WHERE match=? ORDER BY at DESC LIMIT 100').all(matchId).reverse();
    db.prepare('INSERT INTO conversation_reads(match_id,user_id,seen_at) VALUES(?,?,?) ON CONFLICT(match_id,user_id) DO UPDATE SET seen_at=excluded.seen_at').run(matchId,u.id,now());
    return respond(res,200,{messages});
  }
  if(!rate(u.id+':msg',20,60000))return err(res,429,'Trop de messages');
  const msg=str(d.text,1000);if(!msg)return err(res,400,'Écris un message');
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(id(),matchId,u.id,msg,now());
  return respond(res,201,{ok:true});
 }
 if(p==='/api/unread'&&m==='GET'){
  const mm=db.prepare('SELECT id,a,b FROM matches WHERE a=? OR b=?').all(u.id,u.id);
  const byMatch={},total=mm.reduce((sum,x)=>{if(otherBlocked(x.a,x.b))return sum;const other=db.prepare('SELECT paused FROM users WHERE id=?').get(x.a===u.id?x.b:x.a);if(!other||other.paused)return sum;const unread=unreadFor(x.id,u.id);byMatch[x.id]=unread;return sum+unread},0);
  return respond(res,200,{total,byMatch});
 }
 if(p==='/api/block'&&m==='POST'){
  const target=str((await body(req)).id,50);if(target===u.id||!db.prepare('SELECT 1 FROM users WHERE id=?').get(target))return err(res,400,'Profil invalide');
  db.prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(u.id,target);
  db.prepare('DELETE FROM favorites WHERE (sender=? AND target=?) OR (sender=? AND target=?)').run(u.id,target,target,u.id);
  db.prepare('DELETE FROM matches WHERE (a=? AND b=?) OR (a=? AND b=?)').run(u.id,target,target,u.id);
  return respond(res,200,{ok:true});
 }
 if(p==='/api/report'&&m==='POST'){
  if(!rate(u.id+':report',10,86400000))return err(res,429,'Trop de signalements');
  const d=await body(req),target=str(d.id,50),reason=str(d.reason,250);
  if(!reason||u.id===target||!db.prepare('SELECT 1 FROM users WHERE id=?').get(target))return err(res,400,'Signalement invalide');
  db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(id(),u.id,target,reason,now());return respond(res,201,{ok:true});
 }
 if(p==='/api/export'&&m==='GET')return respond(res,200,{profile:me(u),messages:db.prepare('SELECT id,match,sender,text,at FROM messages WHERE sender=?').all(u.id),likes:db.prepare('SELECT target FROM likes WHERE sender=?').all(u.id),favorites:db.prepare('SELECT target FROM favorites WHERE sender=?').all(u.id),blocks:db.prepare('SELECT target FROM blocks WHERE sender=?').all(u.id),dateInvites:db.prepare('SELECT * FROM date_invites WHERE sender=?').all(u.id)});
 if(p==='/api/delete'&&m==='DELETE'){db.prepare('DELETE FROM users WHERE id=?').run(u.id);res.setHeader('Set-Cookie','cc_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');return respond(res,200,{ok:true})}
 return err(res,404,'Action inconnue');
 }catch(e){console.error('CRUSHCAST',e.message);if(!res.writableEnded)err(res,400,'Impossible de traiter la requête')}
});
server.listen(PORT,'0.0.0.0',()=>console.log('CRUSHCAST free beta ready',PORT));