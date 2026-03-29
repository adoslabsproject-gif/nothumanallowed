/**
 * Web UI v2 — Rewritten from scratch. Mobile-first. BEM CSS. No escape hell.
 */

import { VERSION } from '../constants.mjs';

export function getHTML(port) {
  const ts = Date.now();

  // CSS as a clean block — no template literal nesting issues
  const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--bg2:#111;--bg3:#1a1a1a;--bg4:#222;
  --green:#00ff41;--green2:#00cc33;--green3:#00aa28;--greendim:#0a3a12;
  --cyan:#00e5ff;--amber:#ffb300;--red:#ff1744;
  --text:#c8c8c8;--dim:#666;--bright:#fff;
  --border:#1e1e1e;--border2:#333;
  --font:'JetBrains Mono','Fira Code','SF Mono','Consolas',monospace;
  --r:6px;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.5}
a{color:var(--cyan);text-decoration:none}
button{font-family:var(--font);cursor:pointer;border:none;outline:none}
input,textarea{font-family:var(--font);background:var(--bg2);color:var(--text);border:1px solid var(--border);padding:8px 12px;border-radius:var(--r);outline:none;font-size:13px}
input:focus,textarea:focus{border-color:var(--green3)}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* ---- TASKS ---- */
.task-bar{display:flex;gap:8px;margin-bottom:16px}
.task-bar input{flex:1;font-size:13px;padding:10px 14px}
.task-bar select{background:var(--bg2);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:var(--r);font-size:12px}
.task-bar button{background:var(--green3);color:var(--bg);padding:8px 20px;border-radius:var(--r);font-weight:700;font-size:13px}
.task{display:flex;align-items:center;gap:10px;padding:12px;cursor:pointer}
.task--done{opacity:0.5}
.task__check{width:24px;height:24px;border:2px solid var(--border2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--green);cursor:pointer;flex-shrink:0}
.task__check--done{background:var(--green3);border-color:var(--green)}
.task__desc{flex:1;font-size:13px}
.task__priority{font-size:10px;padding:2px 8px;border-radius:4px;text-transform:uppercase}
.task__priority--critical{background:var(--red);color:var(--bright)}
.task__priority--high{background:#ff6d00;color:var(--bright)}
.task__priority--medium{background:var(--amber);color:var(--bg)}
.task__priority--low{background:var(--border2);color:var(--dim)}

/* ---- LAYOUT: mobile-first ---- */
.app{display:flex;flex-direction:column;height:100vh;height:100dvh}
.header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg);position:relative;z-index:60;flex-shrink:0}
.header__burger{background:none;color:var(--green);font-size:22px;padding:4px 8px;line-height:1}
.header__title{font-size:14px;color:var(--bright);font-weight:700;flex:1}
.header__clock{font-size:10px;color:var(--dim)}

.sidebar{display:none;position:fixed;top:0;left:0;width:260px;height:100vh;height:100dvh;background:var(--bg2);border-right:1px solid var(--border);z-index:200;flex-direction:column;overflow-y:auto;box-shadow:4px 0 20px rgba(0,0,0,0.8)}
.sidebar--open{display:flex}
.sidebar__overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:150}
.sidebar__overlay--open{display:block}
.sidebar__brand{padding:16px;border-bottom:1px solid var(--border)}
.sidebar__brand-name{font-size:16px;color:var(--green);font-weight:700;letter-spacing:2px}
.sidebar__brand-sub{font-size:10px;color:var(--dim);margin-top:2px}
.sidebar__section{padding:12px 0}
.sidebar__label{padding:0 16px;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim);margin-bottom:4px}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 16px;color:var(--dim);cursor:pointer;font-size:12px;border-left:2px solid transparent}
.nav-item:hover,.nav-item--active{color:var(--bright);background:var(--bg3)}
.nav-item--active{border-left-color:var(--green);color:var(--green)}
.nav-item__icon{width:18px;text-align:center}
.nav-item__badge{background:var(--red);color:var(--bright);font-size:9px;padding:1px 5px;border-radius:8px;margin-left:auto}

.content{flex:1;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch}

/* ---- DESKTOP: sidebar always visible ---- */
@media(min-width:901px){
  .app{flex-direction:row}
  .header__burger{display:none}
  .sidebar{display:flex!important;position:static;width:220px;min-width:220px;height:auto;box-shadow:none}
  .sidebar__overlay{display:none!important}
  .content{padding:20px}
}

/* ---- CARDS ---- */
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:10px}
.card__title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:6px}
.card__value{font-size:22px;font-weight:700;color:var(--green)}
.card__sub{font-size:11px;color:var(--dim);margin-top:3px}
.dash-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
@media(min-width:901px){.dash-grid{grid-template-columns:repeat(4,1fr)}}
.section-title{font-size:12px;color:var(--cyan);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}

/* ---- CHAT ---- */
.chat{display:flex;flex-direction:column;height:calc(100vh - 52px);height:calc(100dvh - 52px)}
@media(min-width:901px){.chat{height:calc(100vh - 52px)}}
.chat__messages{flex:1;overflow-y:auto;padding-bottom:12px;-webkit-overflow-scrolling:touch}
.chat__empty{text-align:center;padding:60px 16px;color:var(--dim)}
.chat__empty-title{font-size:28px;color:var(--green);margin-bottom:12px}
.chat__empty-hint{font-size:11px;margin-top:12px}
.msg{margin-bottom:12px}
.msg--user .msg__bubble{background:var(--bg3);border:1px solid var(--border2);border-radius:8px 8px 2px 8px;padding:10px 14px;max-width:85%;margin-left:auto;color:var(--bright)}
.msg--assistant .msg__bubble{background:var(--greendim);border:1px solid var(--green3);border-radius:8px 8px 8px 2px;padding:10px 14px;max-width:85%;color:var(--text);white-space:pre-wrap;word-wrap:break-word}
.msg__label{font-size:10px;color:var(--dim);margin-bottom:2px}
.msg--thinking{color:var(--dim);font-style:italic}
.chat__bar{display:flex;gap:8px;padding:10px 0 0 0;border-top:1px solid var(--border);flex-shrink:0}
.chat__input{flex:1;resize:none;min-height:40px;max-height:100px;padding:10px 14px}
.chat__send{background:var(--green3);color:var(--bg);padding:10px 16px;border-radius:var(--r);font-weight:700;font-size:12px}
.chat__send:disabled{opacity:.4}

/* ---- TASKS ---- */
.task-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.task-bar input{flex:1;min-width:150px}
.task-bar select{background:var(--bg2);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:var(--r);font-size:12px}
.task-bar button{background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px}
.task{display:flex;align-items:center;gap:10px;padding:10px 14px}
.task--done{opacity:.5}
.task__check{width:18px;height:18px;border:2px solid var(--border2);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;color:var(--green)}
.task__check--done{background:var(--green3);border-color:var(--green)}
.task__desc{flex:1;min-width:0}
.task__priority{font-size:9px;padding:2px 6px;border-radius:4px;text-transform:uppercase;font-weight:700}
.task__priority--high,.task__priority--critical{background:var(--red);color:var(--bright)}
.task__priority--medium{background:var(--amber);color:var(--bg)}
.task__priority--low{background:var(--border2);color:var(--dim)}

/* ---- PLAN ---- */
.plan-summary{padding:16px;border-left:3px solid var(--green);background:var(--bg2);border-radius:0 var(--r) var(--r) 0;margin-bottom:16px;line-height:1.6}
.plan-action{display:flex;gap:10px;align-items:baseline;padding:6px 0}
.plan-action__time{color:var(--amber);min-width:50px;font-weight:600}
.plan-action__text{flex:1}
.plan-action__priority{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700}

/* ---- EMAILS ---- */
.email{padding:12px 14px}
.email__header{display:flex;justify-content:space-between;gap:8px}
.email__from{color:var(--cyan);font-weight:600;font-size:12px}
.email__date{color:var(--dim);font-size:10px;white-space:nowrap}
.email__subject{color:var(--bright);margin-top:3px}
.email__snippet{color:var(--dim);font-size:11px;margin-top:3px}

/* ---- CALENDAR ---- */
.event{display:flex;gap:12px;align-items:center;padding:10px 14px}
.event__time{color:var(--amber);font-weight:600;min-width:100px;white-space:nowrap;font-size:12px}
.event__title{color:var(--bright);flex:1}
.event__location{color:var(--dim);font-size:11px}

/* ---- AGENTS ---- */
.agents-grid{display:grid;grid-template-columns:1fr;gap:6px}
@media(min-width:500px){.agents-grid{grid-template-columns:1fr 1fr}}
@media(min-width:901px){.agents-grid{grid-template-columns:1fr 1fr 1fr}}
.agent-card{padding:8px 10px;text-align:left;cursor:pointer;transition:border-color .15s;display:flex;align-items:center;gap:10px}
.agent-card:hover{border-color:var(--green3)}
.agent-card__icon{font-size:18px;flex-shrink:0}
.agent-card__body{min-width:0;flex:1}
.agent-card__name{color:var(--green);font-weight:700;font-size:11px}
.agent-card__tagline{font-size:9px;color:var(--text);line-height:1.3}
.agent-card__cat{display:none}

/* ---- MODAL ---- */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:300;align-items:center;justify-content:center}
.modal-overlay--open{display:flex}
.modal{background:var(--bg2);border:1px solid var(--border2);border-radius:8px;width:92%;max-width:540px;max-height:90vh;display:flex;flex-direction:column}
.modal__header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border)}
.modal__header h2{font-size:16px;color:var(--green)}
.modal__close{background:none;color:var(--dim);font-size:24px;padding:0 4px}
.modal__body{padding:16px;overflow-y:auto;flex:1}
.modal__body textarea{width:100%;min-height:80px;margin-bottom:10px}
.modal__response{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:12px;white-space:pre-wrap;word-wrap:break-word;max-height:300px;overflow-y:auto;font-size:12px}
.modal__footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
.btn{padding:8px 16px;border-radius:var(--r);font-size:12px;font-weight:600}
.btn--primary{background:var(--green3);color:var(--bg)}
.btn--secondary{background:var(--bg3);color:var(--dim);border:1px solid var(--border)}

/* ---- SPINNER ---- */
.spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- TOASTS (real-time notifications) ---- */
.toast-container{position:fixed;top:16px;right:16px;z-index:500;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{background:var(--bg3);border:1px solid var(--green);border-radius:8px;padding:12px 16px;max-width:320px;animation:toastIn .3s;pointer-events:auto;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.5)}
.toast--email{border-color:var(--cyan)}
.toast--meeting{border-color:var(--amber)}
.toast--security{border-color:var(--red)}
.toast--plan{border-color:var(--green)}
.toast__title{font-size:11px;font-weight:700;margin-bottom:3px}
.toast--email .toast__title{color:var(--cyan)}
.toast--meeting .toast__title{color:var(--amber)}
.toast--security .toast__title{color:var(--red)}
.toast--plan .toast__title{color:var(--green)}
.toast__body{font-size:11px;color:var(--text);line-height:1.4}
.toast--fadeout{animation:toastOut .3s forwards}
@keyframes toastIn{from{transform:translateX(100%);opacity:0}to{transform:none;opacity:1}}
@keyframes toastOut{from{opacity:1}to{opacity:0;transform:translateX(40px)}}

/* ---- VOICE MIC BUTTON (in chat bar) ---- */
.chat__mic{background:var(--bg3);color:var(--green);border:1px solid var(--border2);width:40px;height:40px;border-radius:var(--r);display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;flex-shrink:0;transition:all .2s}
.chat__mic:hover{border-color:var(--green3);background:var(--greendim)}
.chat__mic--recording{border-color:var(--red);color:var(--red);background:rgba(255,23,68,0.1);animation:micPulse 1.5s ease-in-out infinite}
@keyframes micPulse{0%,100%{box-shadow:none}50%{box-shadow:0 0 0 6px rgba(255,23,68,0.2)}}
`;

  // JS as clean block
  const JS = `
var API = '';
var currentView = 'dashboard';
var chatHistory = (function(){try{var s=localStorage.getItem('nha_chat_history');return s?JSON.parse(s):[];}catch(e){return [];}})();
var dash = {emails:[],events:[],tasks:[],plan:null,status:null};

function saveChatToStorage(){try{localStorage.setItem('nha_chat_history',JSON.stringify(chatHistory.slice(-40)));}catch(e){}}
function clearChatHistory(){chatHistory=[];saveChatToStorage();renderMessages();}
var agentsList = [];
var selectedAgent = null;

// ---- NAV ----
function switchView(v) {
  currentView = v;
  // Invalidate cached data so pages always show fresh content
  if(v==='contacts')contactsData=null;
  if(v==='notes')notesData=null;
  if(v==='drive')driveData=null;
  if(v==='onedrive')onedriveData=null;
  if(v==='mstodo')mstodoData=null;
  document.querySelectorAll('.nav-item').forEach(function(el){
    if(el.dataset.view===v){el.classList.add('nav-item--active')}else{el.classList.remove('nav-item--active')}
  });
  var titles = {dashboard:'Dashboard',chat:'Chat',plan:'Daily Plan',tasks:'Tasks',emails:'Emails',calendar:'Calendar',drive:'Drive',contacts:'Contacts',notes:'Notes',onedrive:'OneDrive',mstodo:'Microsoft To Do',agents:'Agents',settings:'Settings'};
  document.getElementById('headerTitle').textContent = titles[v]||v;
  closeSidebar();
  render();
}
function openSidebar() {
  document.getElementById('sidebar').classList.add('sidebar--open');
  document.getElementById('overlay').classList.add('sidebar__overlay--open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('sidebar--open');
  document.getElementById('overlay').classList.remove('sidebar__overlay--open');
}
function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  if(sb.classList.contains('sidebar--open')){closeSidebar()}else{openSidebar()}
}

// ---- CLOCK ----
function updateClock(){
  var d=new Date();
  var el=document.getElementById('clock');
  if(el)el.textContent=d.toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:false})+' '+d.toLocaleDateString('en',{weekday:'short',month:'short',day:'numeric'});
}
setInterval(updateClock,1000);updateClock();

// ---- API ----
function apiGet(p){return fetch(API+p).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}
function apiPost(p,b){return fetch(API+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}
function apiPatch(p){return fetch(API+p,{method:'PATCH'}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}

// ---- LOAD DATA ----
function loadDash(){
  return Promise.all([apiGet('/api/status'),apiGet('/api/emails'),apiGet('/api/calendar'),apiGet('/api/tasks')]).then(function(r){
    dash.status=r[0];dash.emails=(r[1]&&r[1].emails)||[];dash.events=(r[2]&&r[2].events)||[];dash.tasks=(r[3]&&r[3].tasks)||[];
    updateBadges();
  });
}
function loadAgents(){return apiGet('/api/agents').then(function(r){agentsList=(r&&r.agents)||[]})}
function updateBadges(){
  var eb=document.getElementById('emailBadge'),tb=document.getElementById('taskBadge'),cb=document.getElementById('calBadge');
  var ue=dash.emails.filter(function(e){return e.isUnread}).length,ut=dash.tasks.filter(function(t){return t.status!=='done'}).length,uc=dash.events.length;
  if(eb){eb.textContent=ue;eb.style.display=ue>0?'':'none'}
  if(tb){tb.textContent=ut;tb.style.display=ut>0?'':'none'}
  if(cb){cb.textContent=uc;cb.style.display=uc>0?'':'none'}
}

// ---- HELPERS ----
function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}
function fmtTime(iso){if(!iso)return '';try{return new Date(iso).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:true})}catch(e){return iso}}

// ---- RENDER ----
function render(){
  var el=document.getElementById('content');
  if(!el)return;
  switch(currentView){
    case 'dashboard':renderDash(el);break;
    case 'chat':renderChat(el);break;
    case 'plan':renderPlan(el);break;
    case 'tasks':renderTasks(el);break;
    case 'emails':renderEmails(el);break;
    case 'calendar':renderCalendar(el);break;
    case 'drive':renderDrive(el);break;
    case 'contacts':renderContacts(el);break;
    case 'notes':renderNotes(el);break;
    case 'onedrive':renderOneDrive(el);break;
    case 'mstodo':renderMsTodo(el);break;
    case 'agents':renderAgents(el);break;
    case 'settings':renderSettings(el);break;
  }
}

// ---- DASHBOARD ----
function renderDash(el){
  var t=dash.tasks,e=dash.emails,ev=dash.events;
  var done=t.filter(function(x){return x.status==='done'}).length;
  var pend=t.length-done;
  var pct=t.length>0?Math.round(done/t.length*100):0;
  var h='<div class="dash-grid">'+
    '<div class="card"><div class="card__title">Tasks</div><div class="card__value">'+pend+'</div><div class="card__sub">'+done+'/'+t.length+' done ('+pct+'%)</div></div>'+
    '<div class="card"><div class="card__title">Emails</div><div class="card__value">'+e.length+'</div><div class="card__sub">'+(e.length>0?esc(e[0].from):'Inbox zero')+'</div></div>'+
    '<div class="card"><div class="card__title">Events</div><div class="card__value">'+ev.length+'</div><div class="card__sub">'+(ev.length>0?esc(ev[0].summary):'No events')+'</div></div>'+
    '<div class="card"><div class="card__title">Agents</div><div class="card__value">38</div><div class="card__sub">Ready</div></div>'+
  '</div>';
  if(ev.length>0){h+='<div class="section-title">Events</div>';ev.slice(0,5).forEach(function(x){h+='<div class="card event"><span class="event__time">'+(x.isAllDay?'All day':fmtTime(x.start)+' - '+fmtTime(x.end))+'</span><span class="event__title">'+esc(x.summary)+'</span>'+(x.location?'<span class="event__location">'+esc(x.location)+'</span>':'')+'</div>'})}
  if(e.length>0){h+='<div class="section-title">Emails</div>';e.slice(0,5).forEach(function(x){h+='<div class="card email"><div class="email__header"><span class="email__from">'+esc(x.from)+'</span><span class="email__date">'+esc(x.date)+'</span></div><div class="email__subject">'+esc(x.subject)+'</div><div class="email__snippet">'+esc((x.snippet||'').slice(0,120))+'</div></div>'})}
  if(pend>0){h+='<div class="section-title">Tasks</div>';t.filter(function(x){return x.status!=='done'}).slice(0,5).forEach(function(x){h+='<div class="card task"><span class="task__priority task__priority--'+esc(x.priority)+'">'+esc(x.priority)+'</span><span class="task__desc">'+esc(x.description)+'</span></div>'})}
  el.innerHTML=h;
}

// ---- CHAT ----
var chatReady=false;
function renderChat(el){
  if(!chatReady||!document.getElementById('chatMessages')){
    el.innerHTML='<div class="chat"><div class="chat__messages" id="chatMessages"></div><div class="chat__bar"><button class="chat__mic" id="chatMic" onclick="toggleVoiceInput()" title="Voice input">&#127908;</button><textarea class="chat__input" id="chatInput" placeholder="Ask anything..." rows="1"></textarea><button class="chat__send" id="chatSend">Send</button><button onclick="clearChatHistory()" style="background:none;color:var(--dim);font-size:10px;padding:4px 8px" title="Clear chat history">Clear</button></div></div>';
    chatReady=true;
    document.getElementById('chatSend').onclick=sendChat;
    document.getElementById('chatInput').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}};
    renderMessages();
    setTimeout(function(){var i=document.getElementById('chatInput');if(i)i.focus()},100);
  }
}
function renderMessages(){
  var el=document.getElementById('chatMessages');if(!el)return;
  if(chatHistory.length===0){
    el.innerHTML='<div class="chat__empty"><div class="chat__empty-title">NHA Chat</div><div>Personal Operations Assistant</div><div class="chat__empty-hint">Try: Show my unread emails / What is on my calendar? / Add a task</div></div>';
    return;
  }
  var h='';chatHistory.forEach(function(m){
    h+='<div class="msg msg--'+esc(m.role)+'"><div class="msg__label">'+esc(m.role==='user'?'You':'NHA')+'</div><div class="msg__bubble">'+esc(m.content)+'</div></div>';
  });
  el.innerHTML=h;el.scrollTop=el.scrollHeight;
}
function sendChat(){
  var inp=document.getElementById('chatInput');if(!inp)return;
  var msg=inp.value.trim();if(!msg)return;
  chatHistory.push({role:'user',content:msg});
  inp.value='';saveChatToStorage();renderMessages();
  chatHistory.push({role:'assistant',content:'Thinking...'});renderMessages();
  apiPost('/api/chat',{message:msg,history:chatHistory.slice(0,-1)}).then(function(r){
    chatHistory.pop();
    if(r&&r.response){chatHistory.push({role:'assistant',content:r.response})}
    else if(r&&r.error){chatHistory.push({role:'assistant',content:'Error: '+r.error})}
    else{chatHistory.push({role:'assistant',content:'Error: no response from server'})}
    saveChatToStorage();renderMessages();
    // Refresh ALL data after any tool execution
    if(r&&((r.actions&&r.actions.length>0)||(r.toolResults&&r.toolResults.length>0))){
      calEventsCache={};
      contactsData=null;
      notesData=null;
      driveData=null;
      onedriveData=null;
      mstodoData=null;
      loadDash().then(function(){render()}).catch(function(){});
    }
  });
}

// ---- TASKS ----
function renderTasks(el){
  var t=dash.tasks;
  var h='<div class="task-bar"><input id="taskInput" placeholder="Add a new task..."><select id="taskPriority"><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option><option value="low">Low</option></select><button onclick="addTaskUI()">Add</button></div>';
  if(t.length>0){
    h+='<div style="display:flex;gap:8px;margin-bottom:12px"><button onclick="clearTasksUI(\\x27done\\x27)" style="background:var(--bg3);color:var(--dim);border:1px solid var(--border);padding:6px 12px;border-radius:var(--r);font-size:11px;cursor:pointer">Clear completed</button><button onclick="clearTasksUI(\\x27all\\x27)" style="background:var(--bg3);color:var(--red);border:1px solid var(--border);padding:6px 12px;border-radius:var(--r);font-size:11px;cursor:pointer">Clear all</button></div>';
  }
  t.sort(function(a,b){if(a.status==='done'&&b.status!=='done')return 1;if(a.status!=='done'&&b.status==='done')return -1;return 0});
  t.forEach(function(x){
    var isDone=x.status==='done';
    h+='<div class="card task'+(isDone?' task--done':'')+'"><span class="task__check'+(isDone?' task__check--done':'')+'" onclick="toggleTask('+x.id+')">'+(isDone?'\\u2713':'')+'</span><span class="task__desc" onclick="toggleTask('+x.id+')">'+esc(x.description)+'</span><span class="task__priority task__priority--'+esc(x.priority)+'">'+esc(x.priority)+'</span><span onclick="deleteTaskUI('+x.id+')" style="color:var(--dim);cursor:pointer;padding:4px 8px;font-size:14px;opacity:0.5" title="Delete task">&times;</span></div>';
  });
  el.innerHTML=h;
  var inp=document.getElementById('taskInput');
  if(inp)inp.onkeydown=function(e){if(e.key==='Enter')addTaskUI()};
}
function addTaskUI(){
  var inp=document.getElementById('taskInput'),sel=document.getElementById('taskPriority');
  if(!inp||!inp.value.trim())return;
  apiPost('/api/tasks',{description:inp.value.trim(),priority:sel?sel.value:'medium'}).then(function(){
    inp.value='';loadDash().then(function(){if(currentView==='tasks')render()});
  });
}
function toggleTask(id){
  apiPatch('/api/tasks/'+id+'/done').then(function(){loadDash().then(function(){if(currentView==='tasks'||currentView==='dashboard')render()})});
}
function deleteTaskUI(id){
  if(!confirm('Delete task #'+id+'?'))return;
  apiPost('/api/tasks/'+id+'/delete',{}).then(function(){loadDash().then(function(){render()})});
}
function clearTasksUI(mode){
  var msg=mode==='all'?'Delete ALL tasks? This cannot be undone.':'Remove all completed tasks?';
  if(!confirm(msg))return;
  apiPost('/api/tasks/clear',{mode:mode}).then(function(){loadDash().then(function(){render()})});
}

// ---- PLAN ----
function renderPlan(el){
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading plan...</div></div>';
  apiGet('/api/plan').then(function(r){
    var p=r&&r.plan;
    if(!p){el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="color:var(--dim);margin-bottom:12px">No plan generated yet.</div><button class="btn btn--primary" onclick="refreshPlan()">Generate Plan</button></div>';return}
    var h='<div class="plan-summary">'+esc(p.executive_summary||'No summary')+'</div>';
    if(p.priority_actions&&p.priority_actions.length>0){h+='<div class="section-title">Priority Actions</div>';p.priority_actions.forEach(function(a){h+='<div class="card plan-action"><span class="plan-action__time">'+esc(a.time||'')+'</span><span class="plan-action__text">'+esc(a.action)+'</span></div>'})}
    if(p.schedule&&p.schedule.length>0){h+='<div class="section-title">Schedule</div>';p.schedule.forEach(function(s){h+='<div class="card event"><span class="event__time">'+esc(s.time_start)+'-'+esc(s.time_end)+'</span><span class="event__title">'+esc(s.title)+'</span></div>'})}
    if(p.security_alerts&&p.security_alerts.length>0){h+='<div class="section-title" style="color:var(--red)">Security Alerts</div>';p.security_alerts.forEach(function(a){h+='<div class="card" style="border-color:var(--red)"><span style="color:var(--red)">'+esc(typeof a==='string'?a:a.message||JSON.stringify(a))+'</span></div>'})}
    if(p.insights&&p.insights.length>0){h+='<div class="section-title">Insights</div>';p.insights.forEach(function(i){h+='<div style="color:var(--dim);padding:4px 0;font-size:12px">\\u2192 '+esc(typeof i==='string'?i:i.message||'')+'</div>'})}
    h+='<div style="margin-top:16px;text-align:center"><button class="btn btn--secondary" onclick="refreshPlan()">Regenerate</button></div>';
    el.innerHTML=h;
  });
}
function refreshPlan(){
  var el=document.getElementById('content');
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Generating plan with 5 agents...</div></div>';
  apiPost('/api/plan/refresh',{}).then(function(){renderPlan(el)});
}

// ---- EMAILS ----
function renderEmails(el){
  var e=dash.emails;
  if(e.length===0){el.innerHTML='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No unread emails</div>';return}
  var h='';e.forEach(function(x){
    var unreadStyle=x.isUnread?'border-left:3px solid var(--green);font-weight:700':'border-left:3px solid transparent;opacity:0.7';
    h+='<div class="card email" style="cursor:pointer;'+unreadStyle+'" onclick="openEmail(\\x27'+esc(x.id)+'\\x27)"><div class="email__header"><span class="email__from">'+esc(x.from)+'</span><span class="email__date">'+esc(x.date)+(x.isUnread?' <span style="color:var(--green);font-size:9px">NEW</span>':'')+'</span></div><div class="email__subject">'+esc(x.subject)+'</div><div class="email__snippet" style="font-weight:400">'+esc((x.snippet||'').slice(0,150))+'</div></div>';
  });
  el.innerHTML=h;
}
var openEmailId=null;
function openEmail(id){
  openEmailId=id;
  var el=document.getElementById('content');
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading email...</div></div>';
  apiPost('/api/email/read',{messageId:id}).then(function(r){
    if(!r||r.error){el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Error: '+(r&&r.error||'Failed to load email')+'</div>';return}
    var m=r.message||r;
    var h='<div style="margin-bottom:12px"><button class="btn btn--secondary" onclick="switchView(\\x27emails\\x27)" style="font-size:11px">&larr; Back to inbox</button></div>';
    h+='<div class="card" style="padding:20px">';
    h+='<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)">';
    h+='<div style="font-size:16px;font-weight:700;color:var(--bright);margin-bottom:8px">'+esc(m.subject||'(no subject)')+'</div>';
    h+='<div style="font-size:12px;color:var(--dim);margin-bottom:4px"><strong style="color:var(--text)">From:</strong> '+esc(m.from||'')+'</div>';
    h+='<div style="font-size:12px;color:var(--dim);margin-bottom:4px"><strong style="color:var(--text)">To:</strong> '+esc(m.to||'')+'</div>';
    h+='<div style="font-size:12px;color:var(--dim)"><strong style="color:var(--text)">Date:</strong> '+esc(m.date||'')+'</div>';
    h+='</div>';
    h+='<div style="font-size:13px;line-height:1.7;color:var(--text);white-space:pre-wrap;word-wrap:break-word">'+esc(m.body||m.snippet||'(no content)')+'</div>';
    h+='</div>';
    // Action buttons
    h+='<div style="display:flex;gap:8px;margin-top:12px">';
    h+='<button class="btn btn--primary" onclick="replyToEmail(\\x27'+esc(id)+'\\x27)" style="font-size:12px">Reply</button>';
    h+='<button class="btn btn--secondary" onclick="askAgentAboutEmail(\\x27'+esc(id)+'\\x27)" style="font-size:12px">Ask SABER to scan</button>';
    h+='</div>';
    el.innerHTML=h;
  });
}
function replyToEmail(id){
  switchView('chat');
  setTimeout(function(){
    var inp=document.getElementById('chatInput');
    if(inp){inp.value='Reply to email '+id+': ';inp.focus()}
  },200);
}
function askAgentAboutEmail(id){
  switchView('chat');
  setTimeout(function(){
    var inp=document.getElementById('chatInput');
    if(inp){inp.value='Scan email '+id+' for phishing or security threats';inp.focus()}
  },200);
}

// ---- CALENDAR (monthly grid + day detail modal) ----
var calYear, calMonth;
var calEventsCache = {};
(function(){var d=new Date();calYear=d.getFullYear();calMonth=d.getMonth()})();

function calKey(y,m,d){return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0')}
function isToday(y,m,d){var t=new Date();return t.getFullYear()===y&&t.getMonth()===m&&t.getDate()===d}

function renderCalendar(el){
  var firstDay=new Date(calYear,calMonth,1).getDay();
  var daysInMonth=new Date(calYear,calMonth+1,0).getDate();
  var monthName=new Date(calYear,calMonth,1).toLocaleDateString('en',{month:'long',year:'numeric'});
  // Adjust so Monday=0
  var startDay=(firstDay+6)%7;

  var h='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'+
    '<button class="btn btn--secondary" onclick="calPrev()">&larr;</button>'+
    '<div style="flex:1;text-align:center;font-size:16px;font-weight:700;color:var(--bright)">'+esc(monthName)+'</div>'+
    '<button class="btn btn--secondary" onclick="calNext()">&rarr;</button>'+
  '</div>';

  // Day headers
  h+='<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px">';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d){
    h+='<div style="text-align:center;font-size:10px;color:var(--dim);padding:4px">'+d+'</div>';
  });
  h+='</div>';

  // Calendar grid — square cells
  h+='<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">';
  // Empty cells before first day
  for(var i=0;i<startDay;i++){h+='<div style="aspect-ratio:1;background:var(--bg);border-radius:6px"></div>'}
  // Day cells
  for(var d=1;d<=daysInMonth;d++){
    var key=calKey(calYear,calMonth,d);
    var today=isToday(calYear,calMonth,d);
    var evts=calEventsCache[key]||[];
    var count=evts.length;
    var bg=today?'var(--greendim)':'var(--bg2)';
    var bdr=today?'var(--green3)':count>0?'var(--amber)':'var(--border)';
    h+='<div onclick="openDayDetail(\\x27'+key+'\\x27)" style="aspect-ratio:1;background:'+bg+';border:1px solid '+bdr+';border-radius:6px;padding:6px;cursor:pointer;display:flex;flex-direction:column;overflow:hidden">';
    h+='<div style="font-size:14px;font-weight:'+(today?'800':'500')+';color:'+(today?'var(--green)':'var(--text)')+'">'+d+'</div>';
    if(count>0){
      h+='<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;min-height:0">';
      evts.slice(0,2).forEach(function(x){
        h+='<div style="font-size:8px;color:var(--amber);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:var(--bg3);border-radius:2px;padding:1px 3px">'+esc(x.summary)+'</div>';
      });
      if(count>2)h+='<div style="font-size:8px;color:var(--dim);text-align:center">+'+String(count-2)+'</div>';
      h+='</div>';
    }
    h+='</div>';
  }
  h+='</div>';

  // Loading indicator
  h+='<div id="calLoading" style="text-align:center;padding:8px;color:var(--dim);font-size:10px">Loading events...</div>';

  el.innerHTML=h;
  loadMonthEvents();
}

function loadMonthEvents(){
  var daysInMonth=new Date(calYear,calMonth+1,0).getDate();
  var promises=[];
  for(var d=1;d<=daysInMonth;d++){
    var key=calKey(calYear,calMonth,d);
    if(!calEventsCache[key]){
      (function(k,day){
        promises.push(apiGet('/api/calendar?date='+k).then(function(r){
          calEventsCache[k]=(r&&r.events)||[];
        }));
      })(key,d);
    }
  }
  if(promises.length===0){
    var li=document.getElementById('calLoading');if(li)li.style.display='none';
    return;
  }
  Promise.all(promises).then(function(){
    var li=document.getElementById('calLoading');if(li)li.style.display='none';
    // Re-render just the grid cells with events
    renderCalendar(document.getElementById('content'));
  });
}

function calPrev(){calMonth--;if(calMonth<0){calMonth=11;calYear--}renderCalendar(document.getElementById('content'))}
function calNext(){calMonth++;if(calMonth>11){calMonth=0;calYear++}renderCalendar(document.getElementById('content'))}

function openDayDetail(dateStr){
  var evts=calEventsCache[dateStr]||[];
  var dayLabel=new Date(dateStr+'T12:00:00').toLocaleDateString('en',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  var h='<h2 style="color:var(--green);margin-bottom:4px">'+esc(dayLabel)+'</h2>';
  h+='<div style="color:var(--dim);font-size:11px;margin-bottom:12px">'+dateStr+'</div>';

  if(evts.length===0){
    h+='<div style="color:var(--dim);padding:20px;text-align:center">No events on this day</div>';
  } else {
    evts.forEach(function(x){
      var timeStr=x.isAllDay?'All day':fmtTime(x.start)+' - '+fmtTime(x.end);
      h+='<div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px;background:var(--bg3)">';
      h+='<div style="color:var(--amber);font-weight:700;font-size:13px;margin-bottom:4px">'+esc(timeStr)+'</div>';
      h+='<div style="color:var(--bright);font-size:15px;font-weight:700;margin-bottom:6px">'+esc(x.summary)+'</div>';
      if(x.location)h+='<div style="color:var(--cyan);font-size:12px;margin-bottom:4px">Location: '+esc(x.location)+'</div>';
      if(x.organizer)h+='<div style="color:var(--dim);font-size:11px;margin-bottom:4px">Organizer: '+esc(x.organizer)+'</div>';
      if(x.attendees&&x.attendees.length>0){
        h+='<div style="color:var(--dim);font-size:11px;margin-bottom:4px">Attendees:</div>';
        x.attendees.forEach(function(a){
          var status=a.responseStatus==='accepted'?'var(--green)':a.responseStatus==='declined'?'var(--red)':'var(--dim)';
          h+='<div style="font-size:11px;color:'+status+';padding-left:8px">'+esc(a.name||a.email)+' ('+esc(a.responseStatus)+')</div>';
        });
      }
      if(x.description){
        h+='<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;color:var(--text);font-size:12px;white-space:pre-wrap;word-wrap:break-word">'+esc(x.description)+'</div>';
      }
      if(x.hangoutLink){
        h+='<div style="margin-top:8px"><a href="'+esc(x.hangoutLink)+'" target="_blank" style="color:var(--cyan);font-size:12px;font-weight:700">Join Video Call</a></div>';
      }
      if(x.htmlLink){
        h+='<div style="margin-top:4px"><a href="'+esc(x.htmlLink)+'" target="_blank" style="color:var(--dim);font-size:10px">Open in Google Calendar</a></div>';
      }
      h+='</div>';
    });
  }

  // Use the agent modal for day detail
  document.getElementById('modalName').textContent=dayLabel;
  document.getElementById('modalPrompt').style.display='none';
  document.getElementById('fileDropZone').style.display='none';
  document.getElementById('fileInfo').style.display='none';
  document.getElementById('modalResponse').style.display='block';
  document.getElementById('modalResponse').innerHTML=h;
  document.getElementById('agentModal').classList.add('modal-overlay--open');
  var sendBtn=document.getElementById('agentModal').querySelector('.btn--primary');
  if(sendBtn)sendBtn.style.display='none';
}

// ---- AGENTS ----
var AGENT_DESCRIPTIONS = {
  saber:'Security audits, OWASP Top 10, threat modeling, pentest planning',
  zero:'Vulnerability scanning, dependency audit, secret detection in code',
  veritas:'Fact-checking claims, evidence verification, hallucination detection',
  ade:'Full project security review, forensics, incident response',
  heimdall:'Auth design: OAuth, JWT, RBAC, session management',
  jarvis:'Full-stack architecture, system design, API planning',
  forge:'CI/CD pipelines, deployment strategies, infrastructure design',
  pipe:'Build systems, Airflow/Dagster orchestration, automation',
  shell:'Shell scripts, CLI tools, terminal automation, dotfiles',
  glitch:'Debugging, error analysis, root cause investigation',
  oracle:'Data analysis, statistics, ML insights, visualization',
  logos:'Logic validation, proof auditing, formal reasoning',
  atlas:'Infrastructure as code: Terraform, CloudFormation, Pulumi',
  cartographer:'Geographic data, mapping, spatial queries, routing',
  scheherazade:'Technical writing, documentation, tutorials, blog posts',
  quill:'Short-form content: posts, summaries, abstracts',
  muse:'Creative brainstorming, ideation, problem-solving',
  murasaki:'UI/UX design guidance, accessibility, design systems',
  hermes:'Event-driven architecture, Kafka/RabbitMQ/NATS design',
  link:'Community management, reputation systems, engagement',
  mercury:'Financial analysis, market modeling, ROI projection',
  shogun:'Kubernetes manifests, Helm charts, pod security, scaling',
  flux:'GitOps, deployment strategies, rollback planning',
  cron:'GitHub Actions, GitLab CI, workflow automation',
  babel:'API integration, microservice communication, data sync',
  polyglot:'Localization, i18n strategy, translation quality',
  herald:'News analysis, trend detection, meeting briefs, alerts',
  echo:'Content adaptation: one piece to Twitter, LinkedIn, blog, Slack',
  macro:'Bulk operations, batch processing, data migration scripts',
  prometheus:'Strategic planning, architecture trade-offs, agent routing',
  cassandra:'Risk prediction, worst-case analysis, adversarial challenges',
  athena:'Tech evaluation, benchmark analysis, framework comparison',
  sauron:'Root cause analysis, performance profiling, bottleneck detection',
  conductor:'Workflow orchestration, task delegation, resource allocation',
  navi:'Data profiling, exploratory analysis, schema inference',
  edi:'A/B testing, statistical modeling, hypothesis testing',
  tempest:'Climate data analysis, weather patterns, environmental impact',
  epicure:'Recipe analysis, nutritional computation, dietary planning'
};
var AGENT_ICONS = {
  saber:'\\u{1F6E1}',zero:'\\u{1F50D}',veritas:'\\u2713',ade:'\\u{1F52C}',heimdall:'\\u{1F512}',
  jarvis:'\\u{1F4BB}',forge:'\\u2699',pipe:'\\u{1F527}',shell:'\\u{1F4DF}',glitch:'\\u{1F41B}',
  oracle:'\\u{1F4CA}',logos:'\\u{1F9EE}',atlas:'\\u{1F5FA}',cartographer:'\\u{1F30D}',
  scheherazade:'\\u270D',quill:'\\u{1F4DD}',muse:'\\u{1F3A8}',murasaki:'\\u{1F58C}',
  hermes:'\\u{1F517}',link:'\\u{1F50C}',mercury:'\\u{1F310}',
  shogun:'\\u2638',flux:'\\u{1F504}',cron:'\\u23F0',
  babel:'\\u{1F30E}',polyglot:'\\u{1F5E3}',herald:'\\u{1F4E2}',
  echo:'\\u{1F4E1}',macro:'\\u26A1',
  prometheus:'\\u{1F525}',cassandra:'\\u26A0',athena:'\\u{1F9E0}',sauron:'\\u{1F441}',conductor:'\\u{1F3BC}',
  navi:'\\u{1F9ED}',edi:'\\u{1F4C8}',tempest:'\\u26C8',epicure:'\\u{1F37D}'
};
// ---- DRIVE ----
var driveData=null;
var driveFilter='';
function renderDrive(el){
  if(!driveData){
    el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading Drive...</div></div>';
    apiGet('/api/drive').then(function(r){driveData=r||{files:[]};renderDrive(el)}).catch(function(){
      el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Could not load Drive. Run <b>nha google revoke</b> then <b>nha google auth</b> to grant Drive permissions.</div>';
    });
    return;
  }
  var files=driveData.files||[];
  var quota=driveData.quota;

  var h='';

  // Quota bar
  if(quota){
    h+='<div class="card" style="margin-bottom:12px;padding:12px"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--bright);font-size:12px">'+esc(quota.usage)+' of '+esc(quota.limit)+' used</span><span style="color:var(--dim);font-size:11px">'+quota.percentUsed+'%</span></div>';
    h+='<div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+Math.min(quota.percentUsed,100)+'%;background:'+( quota.percentUsed>90?'var(--red)':quota.percentUsed>70?'var(--amber)':'var(--green)')+';border-radius:3px"></div></div></div>';
  }

  // Filter bar
  h+='<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">';
  ['','recent','starred','shared'].forEach(function(f){
    var label=f||'All Files';
    var active=driveFilter===f;
    h+='<button onclick="filterDrive(\\x27'+f+'\\x27)" style="padding:6px 14px;border-radius:6px;font-size:11px;background:'+(active?'var(--green3)':'var(--bg3)')+';color:'+(active?'var(--bg)':'var(--dim)')+';border:1px solid '+(active?'var(--green)':'var(--border)')+'">'+esc(label.charAt(0).toUpperCase()+label.slice(1))+'</button>';
  });
  h+='<input type="text" id="driveSearch" placeholder="Search files..." style="flex:1;min-width:120px;font-size:11px;padding:6px 10px" onkeydown="if(event.key===\\x27Enter\\x27)searchDrive()">';
  h+='</div>';

  // File list
  if(files.length===0){
    h+='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No files found</div>';
  } else {
    files.forEach(function(f){
      var icon=driveTypeIcon(f.type);
      var date=f.modifiedTime?new Date(f.modifiedTime).toLocaleDateString():'';
      h+='<div class="card" style="margin-bottom:6px;padding:10px;cursor:pointer" onclick="window.open(\\x27'+esc(f.webViewLink)+'\\x27,\\x27_blank\\x27)">';
      h+='<div style="display:flex;align-items:center;gap:10px">';
      h+='<span style="font-size:20px">'+icon+'</span>';
      h+='<div style="flex:1;min-width:0">';
      h+='<div style="color:var(--bright);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(f.name)+'</div>';
      h+='<div style="color:var(--dim);font-size:10px">'+esc(date)+(f.size?' &middot; '+esc(f.size):'')+(f.shared?' &middot; Shared':'')+(f.starred?' &#9733;':'')+'</div>';
      h+='</div>';
      h+='<span style="color:var(--dim);font-size:10px">'+esc(f.type)+'</span>';
      h+='</div></div>';
    });
  }

  el.innerHTML=h;
}

function driveTypeIcon(type){
  var icons={folder:'&#128193;',doc:'&#128196;',sheet:'&#128202;',slides:'&#127916;',pdf:'&#128213;',image:'&#127748;',video:'&#127910;',audio:'&#127925;',archive:'&#128230;',text:'&#128221;',file:'&#128196;'};
  return icons[type]||icons.file;
}

function filterDrive(f){
  driveFilter=f;
  driveData=null;
  var params=f?'?filter='+f:'';
  apiGet('/api/drive'+params).then(function(r){driveData=r||{files:[]};renderDrive(document.getElementById('content'))});
}

function searchDrive(){
  var inp=document.getElementById('driveSearch');
  if(!inp||!inp.value.trim())return;
  driveData=null;
  apiGet('/api/drive?q='+encodeURIComponent(inp.value.trim())).then(function(r){driveData=r||{files:[]};renderDrive(document.getElementById('content'))});
}

// ---- CONTACTS ----
var contactsData=null;
function renderContacts(el){
  if(!contactsData){
    el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading contacts...</div></div>';
    apiGet('/api/contacts').then(function(r){contactsData=r||{contacts:[]};renderContacts(el)}).catch(function(){
      el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Could not load contacts. Run <b>nha google revoke</b> then <b>nha google auth</b> to grant Contacts permission.</div>';
    });
    return;
  }
  var contacts=contactsData.contacts||[];
  var h='<div style="display:flex;gap:8px;margin-bottom:12px"><input type="text" id="contactSearch" placeholder="Search contacts..." style="flex:1;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)searchContacts()"><button onclick="showAddContact()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px;white-space:nowrap">+ Add</button></div>';

  if(contacts.length===0){
    h+='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No contacts found</div>';
  } else {
    contacts.forEach(function(c,idx){
      h+='<div class="card" style="margin-bottom:6px;padding:12px">';
      h+='<div style="display:flex;align-items:center;gap:10px">';
      h+='<div style="width:36px;height:36px;border-radius:50%;background:var(--green3);display:flex;align-items:center;justify-content:center;color:var(--bg);font-weight:700;font-size:14px">'+esc((c.name||'?')[0].toUpperCase())+'</div>';
      h+='<div style="flex:1">';
      h+='<div style="color:var(--bright);font-size:13px;font-weight:700">'+esc(c.name||'(no name)')+'</div>';
      if(c.email)h+='<div style="color:var(--cyan);font-size:11px">'+esc(c.email)+'</div>';
      if(c.phone)h+='<div style="color:var(--dim);font-size:11px">'+esc(c.phone)+'</div>';
      if(c.company)h+='<div style="color:var(--dim);font-size:10px">'+esc(c.company)+(c.title?' - '+esc(c.title):'')+'</div>';
      if(c.address)h+='<div style="color:var(--dim);font-size:10px">'+esc(c.address)+'</div>';
      if(c.birthday)h+='<div style="color:var(--amber);font-size:10px">&#127874; '+esc(c.birthday)+'</div>';
      h+='</div>';
      h+='<div style="display:flex;flex-direction:column;gap:4px">';
      if(c.email)h+='<button onclick="composeToContact('+JSON.stringify(c.email)+','+JSON.stringify(c.name)+')" style="background:var(--green3);color:var(--bg);padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700">Email</button>';
      h+='<button onclick="editContactUI('+idx+')" style="background:var(--bg3);color:var(--dim);padding:4px 10px;border-radius:4px;font-size:10px;border:1px solid var(--border)">Edit</button>';
      h+='<button onclick="deleteContactUI('+idx+')" style="background:none;color:var(--red);padding:4px 10px;border-radius:4px;font-size:10px;border:1px solid var(--red)">Delete</button>';
      h+='</div>';
      h+='</div></div>';
    });
  }
  el.innerHTML=h;
}
function searchContacts(){
  var inp=document.getElementById('contactSearch');
  if(!inp||!inp.value.trim())return;
  contactsData=null;
  apiGet('/api/contacts?q='+encodeURIComponent(inp.value.trim())).then(function(r){contactsData=r||{contacts:[]};renderContacts(document.getElementById('content'))});
}
function showAddContact(){
  var el=document.getElementById('content');
  el.innerHTML='<div style="max-width:500px;margin:0 auto"><div style="margin-bottom:12px"><button class="btn btn--secondary" onclick="contactsData=null;switchView(\\x27contacts\\x27)" style="font-size:11px">&larr; Back</button></div>'+
    '<div class="card" style="padding:16px"><div style="color:var(--green);font-size:14px;font-weight:700;margin-bottom:12px">New Contact</div>'+
    '<input id="acName" placeholder="Name" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="acEmail" placeholder="Email" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="acPhone" placeholder="Phone" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="acCompany" placeholder="Company" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="acAddress" placeholder="Address" style="width:100%;margin-bottom:12px;padding:8px 12px;font-size:13px">'+
    '<button onclick="saveNewContact()" style="background:var(--green3);color:var(--bg);padding:10px 24px;border-radius:var(--r);font-weight:700;font-size:13px">Save Contact</button>'+
    '<span id="acStatus" style="margin-left:12px;font-size:11px;color:var(--dim)"></span>'+
    '</div></div>';
}
function saveNewContact(){
  var data={name:document.getElementById('acName').value,email:document.getElementById('acEmail').value,phone:document.getElementById('acPhone').value,company:document.getElementById('acCompany').value,address:document.getElementById('acAddress').value};
  if(!data.name){document.getElementById('acStatus').textContent='Name required';return}
  document.getElementById('acStatus').textContent='Saving...';
  apiPost('/api/contacts',data).then(function(r){
    if(r&&r.contact){document.getElementById('acStatus').textContent='Saved!';document.getElementById('acStatus').style.color='var(--green)';setTimeout(function(){contactsData=null;switchView('contacts')},1000)}
    else{document.getElementById('acStatus').textContent='Error: '+(r&&r.error||'unknown');document.getElementById('acStatus').style.color='var(--red)'}
  });
}
function editContactUI(idx){
  var c=(contactsData&&contactsData.contacts||[])[idx];
  if(!c)return;
  var el=document.getElementById('content');
  el.innerHTML='<div style="max-width:500px;margin:0 auto"><div style="margin-bottom:12px"><button class="btn btn--secondary" onclick="contactsData=null;switchView(\\x27contacts\\x27)" style="font-size:11px">&larr; Back</button></div>'+
    '<div class="card" style="padding:16px"><div style="color:var(--green);font-size:14px;font-weight:700;margin-bottom:12px">Edit Contact</div>'+
    '<input id="ecName" value="'+esc(c.name)+'" placeholder="Name" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="ecEmail" value="'+esc(c.email)+'" placeholder="Email" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="ecPhone" value="'+esc(c.phone)+'" placeholder="Phone" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="ecCompany" value="'+esc(c.company)+'" placeholder="Company" style="width:100%;margin-bottom:8px;padding:8px 12px;font-size:13px">'+
    '<input id="ecAddress" value="'+esc(c.address)+'" placeholder="Address" style="width:100%;margin-bottom:12px;padding:8px 12px;font-size:13px">'+
    '<div style="display:flex;gap:8px"><button onclick="saveEditContact(\\x27'+esc(c.resourceName)+'\\x27)" style="background:var(--green3);color:var(--bg);padding:10px 24px;border-radius:var(--r);font-weight:700;font-size:13px">Save</button>'+
    '<span id="ecStatus" style="font-size:11px;color:var(--dim);line-height:40px"></span></div>'+
    '</div></div>';
}
function saveEditContact(rn){
  var data={name:document.getElementById('ecName').value,email:document.getElementById('ecEmail').value,phone:document.getElementById('ecPhone').value,company:document.getElementById('ecCompany').value,address:document.getElementById('ecAddress').value};
  var st=document.getElementById('ecStatus');
  if(st)st.textContent='Saving...';
  apiPost('/api/contacts/update',{resourceName:rn,fields:data}).then(function(r){
    if(r&&!r.error){if(st){st.textContent='Saved!';st.style.color='var(--green)'}setTimeout(function(){contactsData=null;switchView('contacts')},1000)}
    else{if(st){st.textContent='Error: '+(r&&r.error||'unknown');st.style.color='var(--red)'}}
  });
}
function deleteContactUI(idx){
  var c=(contactsData&&contactsData.contacts||[])[idx];
  if(!c)return;
  if(!confirm('Delete contact "'+c.name+'"?'))return;
  apiPost('/api/contacts/delete',{resourceName:c.resourceName}).then(function(r){
    if(r&&r.ok){contactsData=null;switchView('contacts')}
    else{alert('Error: '+(r&&r.error||'unknown'))}
  });
}
function composeToContact(email,name){
  switchView('chat');
  setTimeout(function(){
    var inp=document.getElementById('chatInput');
    if(inp){inp.value='Send an email to '+name+' ('+email+') about ';inp.focus()}
  },200);
}

// ---- NOTES ----
var notesData=null;
function renderNotes(el){
  if(!notesData){
    el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading notes...</div></div>';
    apiGet('/api/notes').then(function(r){notesData=r||{notes:[]};renderNotes(el)}).catch(function(){
      el.innerHTML='<div class="card" style="color:var(--dim);padding:20px">Could not load notes.</div>';
    });
    return;
  }
  var notes=notesData.notes||[];
  var h='<div style="display:flex;gap:8px;margin-bottom:12px"><input type="text" id="noteTitle" placeholder="New note title..." style="flex:1;font-size:13px;padding:8px 12px"><button onclick="createNewNote()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">+ Add Note</button></div>';

  if(notes.length===0){
    h+='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No notes yet. Create your first note above.</div>';
  } else {
    notes.forEach(function(n){
      var date=n.updatedAt?new Date(n.updatedAt).toLocaleDateString():'';
      h+='<div class="card" style="margin-bottom:6px;padding:12px;cursor:pointer" onclick="editNote(\\x27'+esc(n.id)+'\\x27)">';
      h+='<div style="display:flex;justify-content:space-between;align-items:center">';
      h+='<div style="color:var(--bright);font-size:13px;font-weight:700">'+esc(n.title||'(untitled)')+'</div>';
      h+='<span style="color:var(--dim);font-size:10px">'+esc(date)+'</span>';
      h+='</div>';
      if(n.content)h+='<div style="color:var(--dim);font-size:11px;margin-top:4px;max-height:40px;overflow:hidden">'+esc(n.content.slice(0,150))+'</div>';
      if(n.tags&&n.tags.length>0)h+='<div style="margin-top:4px">'+n.tags.map(function(t){return '<span style="background:var(--bg3);color:var(--dim);padding:1px 6px;border-radius:3px;font-size:9px;margin-right:4px">'+esc(t)+'</span>'}).join('')+'</div>';
      h+='</div>';
    });
  }
  el.innerHTML=h;
}
function createNewNote(){
  var inp=document.getElementById('noteTitle');
  if(!inp||!inp.value.trim())return;
  apiPost('/api/notes',{title:inp.value.trim(),content:''}).then(function(r){
    if(r&&r.note){inp.value='';notesData=null;renderNotes(document.getElementById('content'))}
  });
}
function editNote(id){
  apiGet('/api/notes/'+id).then(function(r){
    if(!r||!r.note)return;
    var n=r.note;
    var el=document.getElementById('content');
    el.innerHTML='<div style="margin-bottom:12px"><button class="btn btn--secondary" onclick="notesData=null;switchView(\\x27notes\\x27)" style="font-size:11px">&larr; Back</button></div>'+
      '<div class="card" style="padding:16px">'+
      '<input type="text" id="editNoteTitle" value="'+esc(n.title)+'" style="width:100%;font-size:16px;font-weight:700;margin-bottom:12px;padding:8px 12px;background:var(--bg2);border:1px solid var(--border);color:var(--bright)">'+
      '<textarea id="editNoteContent" style="width:100%;min-height:300px;font-size:13px;padding:12px;background:var(--bg2);border:1px solid var(--border);color:var(--text);resize:vertical;line-height:1.6" placeholder="Write your note...">'+esc(n.content)+'</textarea>'+
      '<div style="display:flex;gap:8px;margin-top:12px">'+
      '<button onclick="saveNote(\\x27'+esc(n.id)+'\\x27)" style="background:var(--green3);color:var(--bg);padding:8px 24px;border-radius:var(--r);font-weight:700;font-size:13px">Save</button>'+
      '<button onclick="deleteNote(\\x27'+esc(n.id)+'\\x27)" style="background:var(--red);color:var(--bright);padding:8px 16px;border-radius:var(--r);font-size:11px">Delete</button>'+
      '<span id="noteStatus" style="color:var(--dim);font-size:11px;line-height:36px"></span>'+
      '</div></div>';
  });
}
function saveNote(id){
  var title=document.getElementById('editNoteTitle').value;
  var content=document.getElementById('editNoteContent').value;
  apiPost('/api/notes/'+id,{title:title,content:content}).then(function(r){
    var s=document.getElementById('noteStatus');
    if(s){s.textContent=r&&r.ok?'Saved!':'Error';s.style.color=r&&r.ok?'var(--green)':'var(--red)';setTimeout(function(){s.textContent=''},2000)}
  });
}
function deleteNote(id){
  if(!confirm('Delete this note?'))return;
  apiPost('/api/notes/'+id+'/delete',{}).then(function(){notesData=null;switchView('notes')});
}

// ---- ONEDRIVE ----
var onedriveData=null;
function renderOneDrive(el){
  if(!onedriveData){
    el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading OneDrive...</div></div>';
    apiGet('/api/onedrive').then(function(r){onedriveData=r||{files:[]};renderOneDrive(el)}).catch(function(){
      el.innerHTML='<div class="card" style="padding:20px"><div style="color:var(--amber);margin-bottom:8px">OneDrive requires Microsoft authentication.</div><div style="color:var(--dim);font-size:12px">Run <b>nha microsoft auth</b> in the terminal to connect your Microsoft account.</div></div>';
    });
    return;
  }
  var files=onedriveData.files||[];
  var quota=onedriveData.quota;
  var h='';
  if(quota){
    h+='<div class="card" style="margin-bottom:12px;padding:12px"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--bright);font-size:12px">'+esc(quota.usage)+' of '+esc(quota.limit)+' used</span><span style="color:var(--dim);font-size:11px">'+quota.percentUsed+'%</span></div>';
    h+='<div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+Math.min(quota.percentUsed,100)+'%;background:'+(quota.percentUsed>90?'var(--red)':quota.percentUsed>70?'var(--amber)':'var(--cyan)')+';border-radius:3px"></div></div></div>';
  }
  h+='<div style="margin-bottom:12px"><input type="text" id="odSearch" placeholder="Search OneDrive files..." style="width:100%;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)searchOneDrive()"></div>';
  if(files.length===0){h+='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No files found</div>'}
  else{files.forEach(function(f){
    var icon=driveTypeIcon(f.type);
    var date=f.modifiedTime?new Date(f.modifiedTime).toLocaleDateString():'';
    h+='<div class="card" style="margin-bottom:6px;padding:10px;cursor:pointer" onclick="window.open(\\x27'+esc(f.webViewLink)+'\\x27,\\x27_blank\\x27)">';
    h+='<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">'+icon+'</span><div style="flex:1;min-width:0"><div style="color:var(--bright);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(f.name)+'</div><div style="color:var(--dim);font-size:10px">'+esc(date)+(f.size?' &middot; '+esc(f.size):'')+'</div></div></div></div>';
  })}
  el.innerHTML=h;
}
function searchOneDrive(){
  var inp=document.getElementById('odSearch');if(!inp||!inp.value.trim())return;
  onedriveData=null;apiGet('/api/onedrive?q='+encodeURIComponent(inp.value.trim())).then(function(r){onedriveData=r||{files:[]};renderOneDrive(document.getElementById('content'))});
}

// ---- MICROSOFT TO DO ----
var mstodoData=null;
function renderMsTodo(el){
  if(!mstodoData){
    el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading To Do...</div></div>';
    apiGet('/api/mstodo').then(function(r){mstodoData=r||{tasks:[]};renderMsTodo(el)}).catch(function(){
      el.innerHTML='<div class="card" style="padding:20px"><div style="color:var(--amber);margin-bottom:8px">Microsoft To Do requires Microsoft authentication.</div><div style="color:var(--dim);font-size:12px">Run <b>nha microsoft auth</b> in the terminal to connect.</div></div>';
    });
    return;
  }
  var tasks=mstodoData.tasks||[];
  var h='<div style="display:flex;gap:8px;margin-bottom:12px"><input type="text" id="mstodoInput" placeholder="Add a new task..." style="flex:1;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)addMsTodo()"><button onclick="addMsTodo()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">+ Add</button></div>';
  if(tasks.length===0){h+='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No active tasks</div>'}
  else{tasks.forEach(function(t){
    var imp=t.importance==='high'?'var(--red)':t.importance==='low'?'var(--dim)':'var(--amber)';
    h+='<div class="card" style="margin-bottom:6px;padding:12px;display:flex;align-items:center;gap:10px">';
    h+='<span style="width:20px;height:20px;border:2px solid var(--border2);border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center" onclick="completeMsTodo(\\x27'+esc(t.id)+'\\x27,\\x27'+esc(t.listId)+'\\x27)"></span>';
    h+='<div style="flex:1"><div style="color:var(--bright);font-size:13px">'+esc(t.title)+'</div>';
    if(t.dueDate)h+='<div style="color:var(--dim);font-size:10px">Due: '+esc(t.dueDate.split('T')[0])+'</div>';
    h+='</div><span style="color:'+imp+';font-size:10px;text-transform:uppercase">'+esc(t.importance)+'</span></div>';
  })}
  el.innerHTML=h;
}
function addMsTodo(){
  var inp=document.getElementById('mstodoInput');if(!inp||!inp.value.trim())return;
  apiPost('/api/mstodo',{title:inp.value.trim()}).then(function(r){if(r&&r.task){inp.value='';mstodoData=null;renderMsTodo(document.getElementById('content'))}});
}
function completeMsTodo(taskId,listId){
  apiPost('/api/mstodo/'+taskId+'/complete',{listId:listId}).then(function(){mstodoData=null;renderMsTodo(document.getElementById('content'))});
}

function renderAgents(el){
  if(agentsList.length===0){el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading agents...</div></div>';loadAgents().then(function(){renderAgents(el)});return}

  // Category filter
  var cats={};agentsList.forEach(function(a){var c=a.category||'other';cats[c]=(cats[c]||0)+1});
  var h='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">';
  h+='<button class="btn btn--secondary" style="font-size:11px" onclick="agentFilter=null;renderAgents(document.getElementById(\\x27content\\x27))">All ('+agentsList.length+')</button>';
  Object.keys(cats).sort().forEach(function(c){
    h+='<button class="btn btn--secondary" style="font-size:11px" onclick="agentFilter=\\x27'+esc(c)+'\\x27;renderAgents(document.getElementById(\\x27content\\x27))">'+esc(c)+' ('+cats[c]+')</button>';
  });
  h+='</div>';

  var filtered=agentFilter?agentsList.filter(function(a){return a.category===agentFilter}):agentsList;

  h+='<div class="agents-grid">';
  filtered.forEach(function(a){
    var name=a.name||a.agentName;
    var display=a.displayName||name;
    var icon=AGENT_ICONS[name.toLowerCase()]||'\\u{1F916}';
    var desc=AGENT_DESCRIPTIONS[name.toLowerCase()]||a.tagline||a.description||'';
    h+='<div class="card agent-card" onclick="openAgent(\\''+esc(name)+'\\',\\''+esc(display)+'\\')">'+
      '<div class="agent-card__icon">'+icon+'</div>'+
      '<div class="agent-card__body"><div class="agent-card__name">'+esc(display)+'</div>'+
      '<div class="agent-card__tagline">'+esc(desc)+'</div></div>'+
    '</div>';
  });
  h+='</div>';
  el.innerHTML=h;
}
var agentFilter=null;
function openAgent(name,display){
  selectedAgent=name;
  attachedFileContent=null;attachedFileName=null;
  document.getElementById('modalName').textContent=display||name;
  document.getElementById('modalPrompt').value='';
  document.getElementById('modalPrompt').style.display='';
  document.getElementById('modalResponse').style.display='none';
  document.getElementById('modalResponse').textContent='';
  document.getElementById('modalResponse').innerHTML='';
  document.getElementById('fileInfo').style.display='none';
  document.getElementById('fileDropZone').style.display='';
  document.getElementById('fileDropZone').style.borderColor='var(--border2)';
  document.getElementById('fileInput').value='';
  var sendBtn=document.getElementById('agentModal').querySelector('.btn--primary');
  if(sendBtn)sendBtn.style.display='';
  document.getElementById('agentModal').classList.add('modal-overlay--open');
}
function closeModal(){
  document.getElementById('agentModal').classList.remove('modal-overlay--open');
}

// ---- SETTINGS ----
var settingsLoaded = false;
var settingsData = {};

function renderSettings(el) {
  if (!settingsLoaded) {
    el.innerHTML = '<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading settings...</div></div>';
    apiGet('/api/config').then(function(r) {
      settingsData = r || {};
      // Populate cache for fields
      var cache = {};
      var p = settingsData.profile || {};
      if (p.name) cache['name'] = p.name;
      if (p.email) cache['email'] = p.email;
      if (p.phone) cache['phone'] = p.phone;
      if (p.homeAddress) cache['home-address'] = p.homeAddress;
      if (p.workAddress) cache['work-address'] = p.workAddress;
      if (p.city) cache['city'] = p.city;
      if (p.country) cache['country'] = p.country;
      if (p.company) cache['company'] = p.company;
      if (p.role) cache['role'] = p.role;
      if (p.notes) cache['profile-notes'] = p.notes;
      if (settingsData.provider) cache['provider'] = settingsData.provider;
      if (settingsData.model) cache['model'] = settingsData.model;
      if (settingsData.planTime) cache['plan-time'] = settingsData.planTime;
      if (settingsData.summaryTime) cache['summary-time'] = settingsData.summaryTime;
      if (settingsData.meetingAlert) cache['meeting-alert'] = String(settingsData.meetingAlert);
      localStorage.setItem('nha_config_cache', JSON.stringify(cache));
      settingsLoaded = true;
      renderSettings(el);
    });
    return;
  }

  el.innerHTML = '<div style="max-width:600px;margin:0 auto">' +
    settingsSection('profile', 'User Profile', 'Agents use this when you say "my home", "my city", etc.', [
      ['name', 'Name', 'e.g. John Smith'],
      ['email', 'Email', 'e.g. john@example.com'],
      ['phone', 'Phone', 'e.g. +1 555 123 4567'],
      ['home-address', 'Home Address', 'e.g. 123 Main St, New York'],
      ['work-address', 'Work Address', 'e.g. 456 Office Blvd, New York'],
      ['city', 'City', 'e.g. New York'],
      ['country', 'Country', 'e.g. USA'],
      ['company', 'Company', 'e.g. Acme Inc'],
      ['role', 'Role', 'e.g. Software Engineer'],
      ['profile-notes', 'Notes', 'Anything else agents should know about you'],
    ]) +
    settingsSection('llm', 'LLM Provider', 'The AI model that powers your agents.', [
      ['provider', 'Provider', 'anthropic / openai / gemini / deepseek / grok / mistral'],
      ['key', 'API Key', 'sk-ant-api03-...', true],
      ['model', 'Model', 'Leave empty for default'],
    ]) +
    settingsSection('responder', 'Message Responder', 'Auto-reply to Telegram and Discord messages.', [
      ['telegram-bot-token', 'Telegram Bot Token', 'Get from @BotFather', true],
      ['discord-bot-token', 'Discord Bot Token', 'From Discord Developer Portal', true],
    ]) +
    settingsSection('ops', 'Daily Operations', 'Configure daily plan and alert timing.', [
      ['plan-time', 'Daily Plan Time', '07:00'],
      ['summary-time', 'Summary Time', '18:00'],
      ['meeting-alert', 'Meeting Alert (minutes)', '30'],
    ]) +
  '</div>';
}

function settingsSection(id, title, desc, fields) {
  var h = '<form class="card" style="margin-bottom:16px" id="settings-' + id + '" onsubmit="event.preventDefault();saveSettingsSection(\\x27' + id + '\\x27)">' +
    '<div class="card__title" style="color:var(--green);font-size:14px;margin-bottom:4px">' + esc(title) + '</div>' +
    '<div style="font-size:11px;color:var(--dim);margin-bottom:12px">' + esc(desc) + '</div>';

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var key = f[0], label = f[1], placeholder = f[2], isSecret = f[3] || false;
    var currentVal = '';
    try { var cfg = JSON.parse(localStorage.getItem('nha_config_cache') || '{}'); currentVal = cfg[key] || ''; } catch(e) {}

    h += '<div style="margin-bottom:10px">' +
      '<label style="display:block;font-size:11px;color:var(--dim);margin-bottom:3px">' + esc(label) + '</label>' +
      '<input type="' + (isSecret ? 'password' : 'text') + '" ' +
        'value="' + esc(currentVal) + '" ' +
        'placeholder="' + esc(placeholder) + '" ' +
        'style="width:100%;padding:8px 12px;font-size:13px" ' +
        'data-config-key="' + esc(key) + '" ' +
        'data-section="' + esc(id) + '">' +
    '</div>';
  }

  h += '<div style="display:flex;align-items:center;gap:12px;margin-top:14px">' +
    '<button onclick="saveSettingsSection(\\x27' + id + '\\x27)" ' +
      'style="background:var(--green3);color:var(--bg);padding:8px 24px;border-radius:var(--r);font-weight:700;font-size:13px;cursor:pointer">' +
      'Save' +
    '</button>' +
    '<span id="settings-status-' + id + '" style="font-size:11px;color:var(--dim)"></span>' +
  '</div>';

  h += '</form>';
  return h;
}

function saveSettingsSection(sectionId) {
  var inputs = document.querySelectorAll('input[data-section="' + sectionId + '"]');
  var statusEl = document.getElementById('settings-status-' + sectionId);
  if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = 'var(--amber)'; }

  var promises = [];
  inputs.forEach(function(input) {
    var key = input.dataset.configKey;
    var val = input.value.trim();
    if (!key) return;
    promises.push(
      apiPost('/api/config', { key: key, value: val }).then(function(r) {
        if (r && r.ok) {
          try {
            var cfg = JSON.parse(localStorage.getItem('nha_config_cache') || '{}');
            cfg[key] = val;
            localStorage.setItem('nha_config_cache', JSON.stringify(cfg));
          } catch(e) {}
          return true;
        }
        return false;
      })
    );
  });

  Promise.all(promises).then(function(results) {
    var allOk = results.every(function(r) { return r; });
    if (statusEl) {
      if (allOk) {
        statusEl.textContent = 'Saved!';
        statusEl.style.color = 'var(--green)';
      } else {
        statusEl.textContent = 'Some fields failed to save.';
        statusEl.style.color = 'var(--red)';
      }
      setTimeout(function() { statusEl.textContent = ''; }, 3000);
    }
  });
}

var attachedFileContent = null;
var attachedFileName = null;

function handleFileDrop(e) {
  var file = e.dataTransfer.files[0];
  if (file) readFile(file);
}
function handleFileSelect(input) {
  var file = input.files[0];
  if (file) readFile(file);
}
function readFile(file) {
  if (file.size > 500000) {
    document.getElementById('fileInfo').style.display = 'block';
    document.getElementById('fileInfo').textContent = 'File too large (max 500KB)';
    document.getElementById('fileInfo').style.color = 'var(--red)';
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    attachedFileContent = e.target.result;
    attachedFileName = file.name;
    var info = document.getElementById('fileInfo');
    info.style.display = 'block';
    info.style.color = 'var(--cyan)';
    info.textContent = 'Attached: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    document.getElementById('fileDropZone').style.borderColor = 'var(--green)';
  };
  reader.readAsText(file);
}

function askAgent(){
  var p=document.getElementById('modalPrompt').value.trim();if(!p||!selectedAgent)return;
  var resp=document.getElementById('modalResponse');
  resp.style.display='block';resp.textContent='Thinking...';

  var payload = {agent:selectedAgent, prompt:p};
  if (attachedFileContent) {
    payload.fileContent = attachedFileContent;
    payload.fileName = attachedFileName;
  }

  apiPost('/api/ask', payload).then(function(r){
    resp.textContent=(r&&r.response)||'Error: no response';
    // Reset file after ask
    attachedFileContent = null;
    attachedFileName = null;
    document.getElementById('fileInfo').style.display = 'none';
    document.getElementById('fileDropZone').style.borderColor = 'var(--border2)';
    document.getElementById('fileInput').value = '';
  });
}

// ---- TOASTS (real-time notification overlay) ----
function showToast(type, title, body, durationMs) {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var toast = document.createElement('div');
  toast.className = 'toast toast--' + type;
  toast.innerHTML = '<div class="toast__title">' + esc(title) + '</div><div class="toast__body">' + esc(body) + '</div>';
  toast.onclick = function() {
    toast.classList.add('toast--fadeout');
    setTimeout(function() { toast.remove(); }, 300);
    // Navigate to relevant view
    if (type === 'email') switchView('emails');
    else if (type === 'meeting') switchView('calendar');
    else if (type === 'plan') switchView('plan');
  };
  container.appendChild(toast);
  // Auto-remove after duration
  setTimeout(function() {
    if (toast.parentNode) {
      toast.classList.add('toast--fadeout');
      setTimeout(function() { toast.remove(); }, 300);
    }
  }, durationMs || 8000);
}

// ---- WEBSOCKET (connect to daemon for real-time events) ----
var ws = null;
var wsReconnectTimer = null;
var wsRetryCount = 0;
var wsMaxRetries = 3;
function connectWebSocket() {
  if (wsRetryCount >= wsMaxRetries) return; // Stop trying after 3 failures
  try {
    ws = new WebSocket('ws://' + window.location.host);
  } catch(e) { return; }

  ws.onopen = function() {
    wsRetryCount = 0;
    var indicator = document.getElementById('wsIndicator');
    if (indicator) { indicator.style.color = 'var(--green)'; indicator.title = 'Live updates: connected'; }
  };

  ws.onmessage = function(event) {
    try {
      var msg = JSON.parse(event.data);
      handleDaemonEvent(msg);
    } catch(e) {}
  };

  ws.onclose = function() {
    var indicator = document.getElementById('wsIndicator');
    if (indicator) { indicator.style.color = 'var(--dim)'; indicator.title = 'Live updates: disconnected'; }
    ws = null;
    wsRetryCount++;
    if (wsRetryCount < wsMaxRetries && !wsReconnectTimer) {
      wsReconnectTimer = setTimeout(function() {
        wsReconnectTimer = null;
        connectWebSocket();
      }, 30000); // 30s between retries
    }
  };

  ws.onerror = function() {
    try { ws.close(); } catch(e) {}
  };
}

function handleDaemonEvent(msg) {
  switch(msg.type) {
    case 'new_email':
      showToast('email', 'New Email', 'From: ' + (msg.data.from || 'unknown') + '\\n' + (msg.data.subject || ''), 10000);
      // Auto-refresh emails
      loadDash().then(function() {
        if (currentView === 'dashboard' || currentView === 'emails') render();
      }).catch(function(){});
      break;

    case 'meeting_alert':
      showToast('meeting', 'Meeting in ' + msg.data.minutesUntil + ' min', msg.data.summary + (msg.data.location ? '\\n@ ' + msg.data.location : ''), 15000);
      // Auto-refresh calendar
      loadDash().then(function() {
        if (currentView === 'dashboard' || currentView === 'calendar') render();
      }).catch(function(){});
      break;

    case 'security_alert':
      showToast('security', 'Security Alert', 'Suspicious: ' + (msg.data.from || '') + ' — ' + (msg.data.subject || ''), 20000);
      break;

    case 'plan_ready':
      showToast('plan', 'Daily Plan Ready', 'Your plan for ' + msg.data.date + ' has been generated.', 10000);
      if (currentView === 'plan') renderPlan(document.getElementById('content'));
      break;
  }
}

// ---- VOICE INPUT (in chat view) ----
var voiceRecognition = null;
var voiceRecording = false;

function toggleVoiceInput() {
  if (voiceRecording) {
    stopVoiceInput();
  } else {
    startVoiceInput();
  }
}

function startVoiceInput() {
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('security', 'Not Supported', 'Speech Recognition requires Chrome or Edge.', 5000);
    return;
  }

  voiceRecording = true;
  var mic = document.getElementById('chatMic');
  if (mic) mic.classList.add('chat__mic--recording');

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;
  voiceRecognition.lang = navigator.language || 'en-US';

  voiceRecognition.onresult = function(event) {
    var transcript = '';
    for (var i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    if (transcript.trim()) {
      var inp = document.getElementById('chatInput');
      if (inp) {
        inp.value = transcript.trim();
        sendChat();
      }
    }
    stopVoiceInput();
  };

  voiceRecognition.onerror = function(e) {
    if (e.error !== 'no-speech') {
      showToast('security', 'Voice Error', e.error, 4000);
    }
    stopVoiceInput();
  };

  voiceRecognition.onend = function() {
    stopVoiceInput();
  };

  voiceRecognition.start();
}

function stopVoiceInput() {
  voiceRecording = false;
  var mic = document.getElementById('chatMic');
  if (mic) mic.classList.remove('chat__mic--recording');
  if (voiceRecognition) {
    try { voiceRecognition.stop(); } catch(e) {}
    voiceRecognition = null;
  }
}

// ---- INIT ----
function init(){
  var el=document.getElementById('content');
  if(el)el.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:50vh;flex-direction:column"><div class="spinner"></div><div style="color:var(--dim)">Loading...</div></div>';
  loadDash().then(function(){render()}).catch(function(){render()});
  loadAgents().catch(function(){});
  setInterval(function(){loadDash().then(function(){if(currentView==='dashboard')render()}).catch(function(){})},120000);
  // Connect to daemon WebSocket for real-time notifications
  connectWebSocket();
}
init();
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="NHA">
<meta name="theme-color" content="#0a0a0a">
<link rel="manifest" href="/manifest.json">
<title>NHA</title>
<style>${CSS}</style>
</head>
<body>

<div class="toast-container" id="toastContainer"></div>
<div class="sidebar__overlay" id="overlay" onclick="closeSidebar()"></div>

<div class="app">
  <nav class="sidebar" id="sidebar">
    <div class="sidebar__brand">
      <div class="sidebar__brand-name">NHA</div>
      <div class="sidebar__brand-sub">Operations Console</div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">Overview</div>
      <div class="nav-item nav-item--active" data-view="dashboard" onclick="switchView('dashboard')"><span class="nav-item__icon">&#9632;</span> Dashboard</div>
      <div class="nav-item" data-view="chat" onclick="switchView('chat')"><span class="nav-item__icon">&#128172;</span> Chat</div>
      <div class="nav-item" data-view="plan" onclick="switchView('plan')"><span class="nav-item__icon">&#9733;</span> Plan</div>
      <div class="nav-item" data-view="tasks" onclick="switchView('tasks')"><span class="nav-item__icon">&#9745;</span> Tasks <span class="nav-item__badge" id="taskBadge" style="display:none">0</span></div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">Google</div>
      <div class="nav-item" data-view="emails" onclick="switchView('emails')"><span class="nav-item__icon">&#128231;</span> Emails <span class="nav-item__badge" id="emailBadge" style="display:none">0</span></div>
      <div class="nav-item" data-view="calendar" onclick="switchView('calendar')"><span class="nav-item__icon">&#128197;</span> Calendar <span class="nav-item__badge" id="calBadge" style="display:none;background:var(--amber)">0</span></div>
      <div class="nav-item" data-view="drive" onclick="switchView('drive')"><span class="nav-item__icon">&#128193;</span> Drive</div>
      <div class="nav-item" data-view="contacts" onclick="switchView('contacts')"><span class="nav-item__icon">&#128101;</span> Contacts</div>
      <div class="nav-item" data-view="notes" onclick="switchView('notes')"><span class="nav-item__icon">&#128221;</span> Notes</div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">Microsoft</div>
      <div class="nav-item" data-view="onedrive" onclick="switchView('onedrive')"><span class="nav-item__icon">&#9729;</span> OneDrive</div>
      <div class="nav-item" data-view="mstodo" onclick="switchView('mstodo')"><span class="nav-item__icon">&#128203;</span> To Do</div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">AI</div>
      <div class="nav-item" data-view="agents" onclick="switchView('agents')"><span class="nav-item__icon">&#129302;</span> Agents</div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">Config</div>
      <div class="nav-item" data-view="settings" onclick="switchView('settings')"><span class="nav-item__icon">&#9881;</span> Settings</div>
    </div>
    <div style="padding:12px 16px;margin-top:auto;border-top:1px solid var(--border);font-size:10px;color:var(--dim)">NHA v${VERSION}</div>
  </nav>

  <div class="header">
    <button class="header__burger" onclick="toggleSidebar()">&#9776;</button>
    <span class="header__title" id="headerTitle">Dashboard</span>
    <span id="wsIndicator" style="color:var(--dim);font-size:8px;margin-right:4px" title="Daemon WebSocket">&#9679;</span>
    <span class="header__clock" id="clock"></span>
  </div>

  <div class="content" id="content"></div>
</div>

<div class="modal-overlay" id="agentModal">
  <div class="modal">
    <div class="modal__header">
      <h2 id="modalName">Agent</h2>
      <button class="modal__close" onclick="closeModal()">&times;</button>
    </div>
    <div class="modal__body">
      <textarea id="modalPrompt" placeholder="Ask this agent something..."></textarea>
      <div id="fileDropZone" style="border:2px dashed var(--border2);border-radius:6px;padding:12px;text-align:center;color:var(--dim);font-size:11px;cursor:pointer;margin-bottom:10px;transition:border-color .2s" onclick="document.getElementById('fileInput').click()" ondragover="event.preventDefault();this.style.borderColor='var(--green)'" ondragleave="this.style.borderColor='var(--border2)'" ondrop="event.preventDefault();this.style.borderColor='var(--border2)';handleFileDrop(event)">
        Drop a file here or click to attach
        <input type="file" id="fileInput" style="display:none" onchange="handleFileSelect(this)">
      </div>
      <div id="fileInfo" style="display:none;font-size:10px;color:var(--cyan);margin-bottom:8px"></div>
      <div class="modal__response" id="modalResponse" style="display:none"></div>
    </div>
    <div class="modal__footer">
      <button class="btn btn--secondary" onclick="closeModal()">Close</button>
      <button class="btn btn--primary" onclick="askAgent()">Ask</button>
    </div>
  </div>
</div>

<script>${JS}</script>
</body>
</html>`;
}
