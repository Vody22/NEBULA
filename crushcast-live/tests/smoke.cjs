'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-smoke-'));
 const port=39281;
 const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),DATA_DIR:dir}});
 const url='http://127.0.0.1:'+port;
 async function request(endpoint,method='GET',data=null,cookie=''){
  const r=await fetch(url+endpoint,{method,headers:{...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:data?JSON.stringify(data):undefined});
  return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  let ready=false;
  for(let i=0;i<100;i++){try{if((await request('/health')).status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.ok(ready,'App must boot');
  const pw='TestPassword1234!',key=Date.now();
  const register=async(name,city)=>request('/api/register','POST',{email:name+key+'@example.test',name,birth:'1995-01-15',city,password:pw});
  const a=await register('Alice','Paris'),b=await register('Bruno','Lyon');
  assert.equal(a.status,201);assert.equal(b.status,201);
  const ac=a.cookie,bc=b.cookie,aid=a.body.user.id,bid=b.body.user.id;
  const info={name:'Alice',city:'Paris',bio:'Voyages',interests:'cinéma,randonnée',avatar:'🌸',intent:'Rencontrer quelqu’un',shared:true,paused:false};
  assert.equal((await request('/api/profile','PUT',info,ac)).status,200);
  assert.equal((await request('/api/favorites','POST',{id:bid},ac)).status,200);
  assert.equal((await request('/api/like','POST',{id:bid},ac)).body.matched,false);
  assert.equal((await request('/api/like','POST',{id:aid},bc)).body.matched,true);
  const matches=await request('/api/matches','GET',null,ac),id=matches.body.matches[0].id;
  assert.equal((await request('/api/messages','POST',{match:id,text:'Bonjour'},ac)).status,201);
  assert.equal((await request('/api/messages?match='+id,'GET',null,bc)).body.messages[0].text,'Bonjour');
  assert.equal((await request('/api/date-invites','POST',{match:id,idea:'Café en ville'},ac)).status,201);
  assert.equal((await request('/api/date-invites?match='+id,'GET',null,bc)).body.invites.length,1);
  assert.equal((await request('/api/block','POST',{id:bid},ac)).status,200);
  assert.equal((await request('/api/messages?match='+id,'GET',null,bc)).status,403);
  assert.equal((await request('/api/delete','DELETE',null,ac)).status,200);
  process.stdout.write('CRUSHCAST end-to-end API smoke: OK\n');
 }finally{child.kill();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
