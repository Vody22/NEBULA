'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={user:null,tab:'register',page:'discover',matches:[],conversation:null};
async function api(route,method='GET',data){
 const r=await fetch('/api/'+route,{method,credentials:'same-origin',headers:{...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 const d=await r.json().catch(()=>({error:'Réponse inconnue'}));if(!r.ok)throw Error(d.error||'Erreur réseau');return d;
}
function flash(message,bad=false){
 const el=$('#flash');if(!el)return;el.textContent=message;el.style.background=bad?'#802b3b':'#1e6348';el.classList.remove('hidden');
 setTimeout(()=>el.classList.add('hidden'),5000);
}
function authTab(which){
 state.tab=which;$('#tab-register').classList.toggle('active',which==='register');$('#tab-login').classList.toggle('active',which==='login');
 document.querySelectorAll('.register-only').forEach(x=>x.classList.toggle('hidden',which==='login'));
 $('#auth-title').textContent=which==='register'?'Trouve ton prochain crush':'Ravi de te revoir';
 $('#auth-sub').textContent=which==='register'?'Crée ton compte pour commencer.':'Retrouve tes matchs et tes conversations.';
 $('#submit-auth').textContent=which==='register'?'Créer mon compte gratuitement ↗':'Me connecter ↗';
 $('#password').autocomplete=which==='register'?'new-password':'current-password';$('#auth-error').textContent='';
}
async function enter(u){
 state.user=u;$('#welcome').classList.add('hidden');$('#app').classList.remove('hidden');drawMe();
 navigate('discover');
}
function leave(){state.user=null;state.conversation=null;$('#app').classList.add('hidden');$('#welcome').classList.remove('hidden');$('#auth-form').reset();authTab('register')}
function drawMe(){
 const u=state.user;$('#miniuser').innerHTML='<span class="avatar">'+esc(u.avatar)+'</span><span><b>'+esc(u.name)+'</b><br><small>'+esc(u.city)+'</small></span>';
 $('#p-name').value=u.name;$('#p-city').value=u.city;$('#p-bio').value=u.bio||'';$('#p-interests').value=u.interests||'';
 $('#p-avatar').value=u.avatar||'💜';$('#p-intent').value=u.intent||'Rencontrer quelqu’un';$('#p-paused').checked=!!u.paused;$('#p-shared').checked=!!u.shared;
}
function navigate(page){
 state.page=page;
 document.querySelectorAll('.page').forEach(e=>e.classList.toggle('hidden',e.id!=='page-'+page));
 document.querySelectorAll('[data-page]').forEach(e=>e.classList.toggle('active',e.dataset.page===page));
 $('#page-title').textContent={discover:'À découvrir',favorites:'Tes favoris',matches:'Tes matchs',messages:'Vos conversations',profile:'Ton profil'}[page];
 if(page==='discover')discover();if(page==='favorites')favorites();if(page==='matches')matches();if(page==='messages')chatPage();if(page==='profile'){drawMe();blockedList()}
}
function empty(icon,title,description){
 return '<div class="empty"><div class="empty-icon">'+icon+'</div><h3>'+esc(title)+'</h3><p>'+esc(description)+'</p></div>';
}
function tags(u){return String(u.interests||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,4).map(t=>'<span>'+esc(t)+'</span>').join('')}
function personCard(u){
 return '<article class="person-card"><div class="person-cover"><span class="avatar">'+esc(u.avatar)+'</span></div><div class="person-content"><h3>'+esc(u.name)+', '+Number(u.age)+'</h3><div class="person-meta">⌁ '+esc(u.city)+' · '+esc(u.intent)+'</div><p>'+esc(u.bio||'Un nouveau visage à découvrir sur CRUSHCAST.')+'</p><div class="small-tags">'+tags(u)+'</div></div><div class="person-actions"><button data-like="'+esc(u.id)+'">♡ Liker</button><button class="minor" title="Favori" data-fav="'+esc(u.id)+'">☆</button><button class="minor" title="Passer" data-pass="'+esc(u.id)+'">→</button><button class="minor" title="Signaler" data-report="'+esc(u.id)+'">!</button><button class="minor" title="Bloquer" data-block="'+esc(u.id)+'">✕</button></div></article>';
}
async function discover(){
 const root=$('#discover-list');root.innerHTML=empty('♡','Recherche de profils…','');
 try{
  const query=new URLSearchParams({city:$('#f-city').value,interest:$('#f-interest').value,minAge:$('#f-min').value,maxAge:$('#f-max').value});const {users}=await api('discover?'+query.toString());
  root.innerHTML=users.length?users.map(personCard).join(''):empty('✦','Encore un peu de patience','Aucun autre profil réel disponible pour le moment. Invite une connaissance à essayer CRUSHCAST gratuitement.');
 }catch(e){root.innerHTML=empty('⚠','Impossible de charger les profils',e.message)}
}
async function like(target){
 try{const d=await api('like','POST',{id:target});flash(d.matched?'C’est un match ! Vous pouvez discuter. 💖':'Like envoyé ♡');discover();}
 catch(e){flash(e.message,true)}
}
async function matches(){
 const root=$('#matches-list');root.innerHTML=empty('♡','Chargement…','');
 try{
  const d=await api('matches');state.matches=d.matches;
  root.innerHTML=d.matches.length?d.matches.map(m=>'<div class="match-row"><span class="avatar">'+esc(m.person.avatar)+'</span><div class="grow"><b>'+esc(m.person.name)+', '+m.person.age+'</b><small>'+esc(m.person.city)+'</small></div><button class="primary-button" data-chat="'+esc(m.id)+'">Discuter →</button><button class="soft-button" data-unmatch="'+esc(m.id)+'">Annuler</button><button class="soft-button" data-block="'+esc(m.person.id)+'">Bloquer</button></div>').join(''):empty('♡','Pas encore de match','Quand quelqu’un te like aussi, votre match apparaîtra ici.');
 }catch(e){root.innerHTML=empty('⚠','Erreur',e.message)}
}
async function chatPage(){
 try{state.matches=(await api('matches')).matches;const box=$('#chat-matches');
 box.innerHTML=state.matches.length?state.matches.map(m=>'<button data-chat="'+esc(m.id)+'" class="'+(state.conversation===m.id?'active':'')+'">♡ '+esc(m.person.name)+'</button>').join(''):'<p class="subhead">Aucun match pour le moment.</p>';
 if(state.conversation&&!state.matches.some(x=>x.id===state.conversation)){state.conversation=null;$('#chat-thread').innerHTML='';$('#chat-form').classList.add('hidden')}
 if(state.conversation){await conversation();await loadDateInvites();}
 }catch(e){flash(e.message,true)}
}
async function selectChat(id){
 state.conversation=id;navigate('messages');
}
async function conversation(){
 const m=state.matches.find(x=>x.id===state.conversation);if(!m)return;
 $('#chat-heading').textContent='♥ Discussion avec '+m.person.name;
 $('#chat-form').classList.remove('hidden');$('#date-area').classList.remove('hidden');
 document.querySelectorAll('[data-chat]').forEach(x=>x.classList.toggle('active',x.dataset.chat===state.conversation));
 try{
  const {messages}=await api('messages?match='+encodeURIComponent(state.conversation));
  const thread=$('#chat-thread');const atEnd=thread.scrollHeight-thread.scrollTop-thread.clientHeight<55;
  thread.innerHTML=messages.length?messages.map(x=>'<div class="bubble '+(x.sender===state.user.id?'me':'')+'">'+esc(x.text)+'</div>').join(''):empty('✉','Dis bonjour !','La conversation commence ici.');
  if(atEnd)thread.scrollTop=thread.scrollHeight;
 }catch(e){flash(e.message,true)}
}
async function block(id){
 if(!confirm('Bloquer cette personne et supprimer un éventuel match ?'))return;
 try{await api('block','POST',{id});state.conversation=null;flash('Profil bloqué.');navigate(state.page)}catch(e){flash(e.message,true)}
}
async function report(id){
 const reason=prompt('Pourquoi signaler cette personne ? (harcèlement, faux profil, spam…)');
 if(!reason||!reason.trim())return;
 try{await api('report','POST',{id,reason});flash('Signalement enregistré. Tu peux aussi bloquer ce profil.')}catch(e){flash(e.message,true)}
}

async function favorites(){
 const root=$('#favorites-list');root.innerHTML=empty('☆','Chargement des favoris…','');
 try{const d=await api('favorites');root.innerHTML=d.users.length?d.users.map(personCard).join(''):empty('☆','Pas encore de favoris','Appuie sur l’étoile ☆ d’un profil intéressant pour le retrouver ici.')}catch(e){root.innerHTML=empty('⚠','Erreur',e.message)}
}
async function favorite(id){
 try{const d=await api('favorites','POST',{id});flash(d.favorited?'Profil ajouté aux favoris ☆':'Profil retiré des favoris');if(state.page==='favorites')favorites()}catch(e){flash(e.message,true)}
}
async function pass(id){
 try{await api('pass','POST',{id});flash('Profil passé');if(state.page==='favorites')favorites();else discover()}catch(e){flash(e.message,true)}
}
async function unmatch(id){
 if(!confirm('Annuler ce match et effacer votre conversation ?'))return;
 try{await api('unmatch','POST',{id});if(state.conversation===id)state.conversation=null;flash('Match annulé');navigate(state.page)}catch(e){flash(e.message,true)}
}
async function blockedList(){
 const root=$('#blocked-list');
 try{const d=await api('blocked');root.innerHTML=d.users.length?d.users.map(u=>'<div class="blocked-entry"><span>'+esc(u.avatar)+' '+esc(u.name)+'</span><button type="button" class="soft-button" data-unblock="'+esc(u.id)+'">Débloquer</button></div>').join(''):'<p class="subhead">Aucun profil bloqué.</p>'}
 catch(e){root.textContent=e.message}
}
async function unblock(id){
 if(!confirm('Débloquer ce profil ?'))return;
 try{await api('unblock','POST',{id});flash('Profil débloqué');blockedList()}catch(e){flash(e.message,true)}
}
async function loadDateInvites(){
 const root=$('#date-list');
 if(!state.conversation)return;
 try{
 const d=await api('date-invites?match='+encodeURIComponent(state.conversation));
 root.innerHTML=d.invites.length?d.invites.map(v=>{
 const own=v.sender===state.user.id,canReply=!own&&v.status==='pending';
 return '<div class="invite"><span>♡ '+esc(v.idea)+'</span><p>'+esc(v.note||'À organiser ensemble, dans un lieu public')+'</p><small>'+(v.status==='pending'?'En attente':v.status==='accepted'?'Acceptée':'Refusée')+(own?' · Ta proposition':' · Proposition reçue')+'</small>'+(canReply?'<div class="invite-actions"><button class="soft-button" data-dateid="'+esc(v.id)+'" data-datestatus="accepted">Accepter</button><button class="soft-button" data-dateid="'+esc(v.id)+'" data-datestatus="declined">Refuser</button></div>':'')+'</div>';
 }).join(''):'<p class="subhead">Aucune proposition de rendez-vous.</p>';
 }catch(e){root.textContent=e.message}
}
async function respondDate(id,status){
 try{await api('date-invites/respond','POST',{id,status});flash('Réponse enregistrée');loadDateInvites()}catch(e){flash(e.message,true)}
}

$('#tab-register').addEventListener('click',()=>authTab('register'));
$('#tab-login').addEventListener('click',()=>authTab('login'));
$('#auth-form').addEventListener('submit',async e=>{
 e.preventDefault();const btn=$('#submit-auth'),error=$('#auth-error');btn.disabled=true;error.textContent='';
 try{
  const data={email:$('#email').value,password:$('#password').value};
  if(state.tab==='register')Object.assign(data,{name:$('#name').value,birth:$('#birth').value,city:$('#city').value});
  const d=await api(state.tab==='register'?'register':'login','POST',data);enter(d.user);
 }catch(ex){error.textContent=ex.message}finally{btn.disabled=false}
});
$('#nav').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b)navigate(b.dataset.page)});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.like)like(b.dataset.like);
 if(b.dataset.fav)favorite(b.dataset.fav);
 if(b.dataset.pass)pass(b.dataset.pass);
 if(b.dataset.unmatch)unmatch(b.dataset.unmatch);
 if(b.dataset.unblock)unblock(b.dataset.unblock);
 if(b.dataset.dateid)respondDate(b.dataset.dateid,b.dataset.datestatus);
 if(b.dataset.block)block(b.dataset.block);
 if(b.dataset.report)report(b.dataset.report);
 if(b.dataset.chat)selectChat(b.dataset.chat);
});
$('#refresh').addEventListener('click',()=>navigate(state.page));
$('#logout').addEventListener('click',async()=>{await api('logout','POST').catch(()=>{});leave()});
$('#profile-form').addEventListener('submit',async e=>{
 e.preventDefault();
 try{
  const d=await api('profile','PUT',{name:$('#p-name').value,city:$('#p-city').value,avatar:$('#p-avatar').value,intent:$('#p-intent').value,bio:$('#p-bio').value,interests:$('#p-interests').value,paused:$('#p-paused').checked,shared:$('#p-shared').checked});
  state.user=d.user;drawMe();flash('Profil enregistré !');
 }catch(ex){flash(ex.message,true)}
});
$('#chat-form').addEventListener('submit',async e=>{
 e.preventDefault();const input=$('#chat-input'),text=input.value.trim();if(!text||!state.conversation)return;
 try{await api('messages','POST',{match:state.conversation,text});input.value='';conversation()}catch(ex){flash(ex.message,true)}
});

$('#filter-form').addEventListener('submit',e=>{e.preventDefault();discover()});
$('#f-reset').addEventListener('click',()=>{$('#filter-form').reset();discover()});
$('#date-form').addEventListener('submit',async e=>{
 e.preventDefault();if(!state.conversation)return;
 try{await api('date-invites','POST',{match:state.conversation,idea:$('#date-idea').value,note:$('#date-note').value});
 $('#date-form').reset();flash('Proposition envoyée !');loadDateInvites();}catch(e){flash(e.message,true)}
});
$('#password-form').addEventListener('submit',async e=>{
 e.preventDefault();try{await api('password','POST',{currentPassword:$('#pw-current').value,newPassword:$('#pw-new').value});
 $('#password-form').reset();flash('Mot de passe modifié.')}catch(e){flash(e.message,true)}
});
$('#copy-share').addEventListener('click',async()=>{
 if(!state.user.shared||state.user.paused){flash('Enregistre ton profil en activant le partage et sans mode pause.',true);return}
 const url=location.origin+'/p/'+encodeURIComponent(state.user.id);
 try{await navigator.clipboard.writeText(url);flash('Lien copié : '+url)}catch{prompt('Copie ton lien public :',url)}
});

$('#export').addEventListener('click',async()=>{
 try{const d=await api('export');const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
 const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mes-donnees-crushcast.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);
 }catch(e){flash(e.message,true)}
});
$('#delete').addEventListener('click',async()=>{
 if(!confirm('Supprimer définitivement ton compte, tes matchs et messages ?'))return;
 if(!confirm('Confirmer la suppression définitive ?'))return;
 try{await api('delete','DELETE');leave()}catch(e){flash(e.message,true)}
});
setInterval(()=>{if(state.user&&state.page==='messages'&&state.conversation)conversation()},7000);
(async()=>{try{const d=await api('me');enter(d.user)}catch{leave()}})();