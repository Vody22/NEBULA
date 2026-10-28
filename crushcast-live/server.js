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
function profile(u){return {id:u.id,name:u.name,age:age(u.birth),city:u.city,bio:u.bio,interests:u.interests,intent:u.intent,avatar:u.avatar}}
function me(u){return {...profile(u),email:u.email,birth:u.birth,paused:!!u.paused,shared:!!u.shared}}
function login(res,u){const raw=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw),u.id,now()+1209600000);res.setHeader('Set-Cookie','cc_token='+raw+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600')}
function otherBlocked(a,b){return !!db.prepare('SELECT 1 FROM blocks WHERE (sender=? AND target=?) OR (sender=? AND target=?)').get(a,b,b,a)}
function body(req){return new Promise((ok,no)=>{let s='';req.on('data',c=>{s+=c;if(s.length>8192){no(Error('Taille maximale dépassée'));req.destroy()}});req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch{no(Error('JSON incorrect'))}});req.on('error',no)})}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'https://crushcast.local'),p=url.pathname,m=req.method,ip=req.socket.remoteAddress||'local';
 try{
 if(m==='GET'&&(p==='/'||p==='/index.html'))return respond(res,200,fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),'text/html; charset=utf-8');
 if(m==='GET'&&p==='/app.css')return respond(res,200,fs.readFileSync(path.join(ROOT,'app.css'),'utf8'),'text/css; charset=utf-8');
 if(m==='GET'&&p==='/app.js')return respond(res,200,fs.readFileSync(path.join(ROOT,'app.js'),'utf8'),'application/javascript; charset=utf-8');
 if(m==='GET'&&p==='/health')return respond(res,200,{ok:true,version:'CRUSHCAST free beta',temporaryStorage:true});
 if(m==='GET'&&p==='/robots.txt')return respond(res,200,'User-agent: *\nDisallow: /\n','text/plain');
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
  if(name.length<2||city.length<2||!(age(birth)>=18&&age(birth)<=110))return err(res,400,'Prénom, ville et majorité 18+ requis');
  if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return err(res,409,'Adresse déjà utilisée');
  const salt=crypto.randomBytes(16).toString('hex'),uid=id();
  db.prepare('INSERT INTO users(id,email,salt,hash,name,birth,city,created) VALUES (?,?,?,?,?,?,?,?)').run(uid,email,salt,crypto.scryptSync(pw,salt,64).toString('hex'),name,birth,city,now());
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(uid);login(res,u);return respond(res,201,{user:me(u)});
 }
 if(p==='/api/logout'&&m==='POST'){const raw=cookie(req);if(/^[0-9a-f]{64}$/.test(raw))db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(raw));res.setHeader('Set-Cookie','cc_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');return respond(res,200,{ok:true})}
 const u=current(req);if(!u)return err(res,401,'Connexion nécessaire');
 if(p==='/api/me'&&m==='GET')return respond(res,200,{user:me(u)});
 if(p==='/api/profile'&&m==='PUT'){
  const d=await body(req),name=str(d.name,30),city=str(d.city,55),bio=str(d.bio,350),interests=str(d.interests,180),intent=str(d.intent,80),avatar=str(d.avatar,8);
  if(name.length<2||city.length<2||interests.split(',').length>8||!['💜','🌸','🌞','🌊','✨','🧡','🌻','🎧'].includes(avatar))return err(res,400,'Profil invalide');
  db.prepare('UPDATE users SET name=?,city=?,bio=?,interests=?,intent=?,avatar=?,paused=?,shared=? WHERE id=?').run(name,city,bio,interests,intent,avatar,d.paused?1:0,d.shared?1:0,u.id);
  return respond(res,200,{user:me(db.prepare('SELECT * FROM users WHERE id=?').get(u.id))});
 }
 if(p==='/api/discover'&&m==='GET'){
  const list=db.prepare('SELECT * FROM users WHERE id<>? AND paused=0 AND NOT EXISTS(SELECT 1 FROM blocks WHERE (sender=? AND target=users.id) OR (target=? AND sender=users.id)) AND NOT EXISTS(SELECT 1 FROM likes WHERE sender=? AND target=users.id) ORDER BY created DESC LIMIT 50').all(u.id,u.id,u.id,u.id);
  return respond(res,200,{users:u.paused?[]:list.map(profile)});
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
  return respond(res,200,{matches:mm.flatMap(x=>{const o=db.prepare('SELECT * FROM users WHERE id=?').get(x.a===u.id?x.b:x.a);return o&&!o.paused&&!otherBlocked(u.id,o.id)?[{id:x.id,person:profile(o)}]:[]})});
 }
 if(p==='/api/messages'&&(m==='GET'||m==='POST')){
  const d=m==='POST'?await body(req):{},matchId=str(m==='GET'?url.searchParams.get('match'):d.match,50);
  const x=db.prepare('SELECT * FROM matches WHERE id=? AND (a=? OR b=?)').get(matchId,u.id,u.id);
  if(!x||otherBlocked(x.a,x.b))return err(res,403,'Conversation indisponible');
  if(m==='GET')return respond(res,200,{messages:db.prepare('SELECT id,sender,text,at FROM messages WHERE match=? ORDER BY at DESC LIMIT 100').all(matchId).reverse()});
  if(!rate(u.id+':msg',20,60000))return err(res,429,'Trop de messages');
  const msg=str(d.text,1000);if(!msg)return err(res,400,'Écris un message');
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(id(),matchId,u.id,msg,now());
  return respond(res,201,{ok:true});
 }
 if(p==='/api/block'&&m==='POST'){
  const target=str((await body(req)).id,50);if(target===u.id||!db.prepare('SELECT 1 FROM users WHERE id=?').get(target))return err(res,400,'Profil invalide');
  db.prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(u.id,target);
  db.prepare('DELETE FROM matches WHERE (a=? AND b=?) OR (a=? AND b=?)').run(u.id,target,target,u.id);
  return respond(res,200,{ok:true});
 }
 if(p==='/api/report'&&m==='POST'){
  if(!rate(u.id+':report',10,86400000))return err(res,429,'Trop de signalements');
  const d=await body(req),target=str(d.id,50),reason=str(d.reason,250);
  if(!reason||u.id===target||!db.prepare('SELECT 1 FROM users WHERE id=?').get(target))return err(res,400,'Signalement invalide');
  db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(id(),u.id,target,reason,now());return respond(res,201,{ok:true});
 }
 if(p==='/api/export'&&m==='GET')return respond(res,200,{profile:me(u),messages:db.prepare('SELECT id,match,sender,text,at FROM messages WHERE sender=?').all(u.id)});
 if(p==='/api/delete'&&m==='DELETE'){db.prepare('DELETE FROM users WHERE id=?').run(u.id);res.setHeader('Set-Cookie','cc_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');return respond(res,200,{ok:true})}
 return err(res,404,'Action inconnue');
 }catch(e){console.error('CRUSHCAST',e.message);if(!res.writableEnded)err(res,400,'Impossible de traiter la requête')}
});
server.listen(PORT,'0.0.0.0',()=>console.log('CRUSHCAST free beta ready',PORT));