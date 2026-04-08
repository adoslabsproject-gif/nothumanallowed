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
  --bg:#0a0a0a;--bg2:#111;--bg3:#1a1a2e;--bg4:#222;
  --green:#a5b4fc;--green2:#818cf8;--green3:#6366f1;--greendim:#12121e;
  --cyan:#38bdf8;--amber:#fbbf24;--red:#ef4444;
  --text:#e4e4e7;--dim:#9ca3af;--bright:#fff;
  --border:#1e1e2e;--border2:#3f3f5e;
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
/* header removed — info moved to sidebar brand */

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
.content--chat{overflow:hidden!important;padding:0!important;display:flex;flex-direction:column}
.chat{display:flex;flex-direction:column;flex:1;min-height:0;padding:16px;padding-bottom:0}
@media(min-width:901px){.content--chat{padding:0!important}}
.chat__messages{flex:1;overflow-y:auto;padding-bottom:12px;-webkit-overflow-scrolling:touch}
.chat__empty{text-align:center;padding:60px 16px;color:var(--dim)}
.chat__empty-title{font-size:28px;color:var(--green);margin-bottom:12px}
.chat__empty-hint{font-size:11px;margin-top:12px}
.msg{margin-bottom:12px}
.msg--user .msg__bubble{background:var(--bg3);border:1px solid var(--border2);border-radius:8px 8px 2px 8px;padding:10px 14px;max-width:85%;margin-left:auto;color:var(--bright)}
.msg--assistant .msg__bubble{background:var(--greendim);border:1px solid var(--green3);border-radius:8px 8px 8px 2px;padding:10px 14px;max-width:85%;color:var(--text);white-space:pre-wrap;word-wrap:break-word;line-height:1.5}
.msg--assistant .msg__bubble img{max-width:100%;border-radius:8px;margin:8px 0;border:1px solid rgba(0,255,65,0.2)}
.msg__label{font-size:10px;color:var(--dim);margin-bottom:2px}
.msg__actions{display:flex;gap:6px;margin-top:4px;opacity:0.4;transition:opacity 0.2s}
.msg:hover .msg__actions{opacity:1}
.msg__actions button{background:none;border:none;color:var(--dim);cursor:pointer;font-size:10px;font-family:var(--mono);padding:2px 4px}
.msg__actions button:hover{color:var(--green)}
#canvasPanel{position:fixed;top:60px;right:12px;width:480px;max-height:calc(100vh - 80px);background:#0d0d0d;border:1px solid var(--green);border-radius:12px;z-index:1000;overflow:hidden;display:none;flex-direction:column;box-shadow:0 0 30px rgba(0,255,65,0.1)}
#canvasPanel.open{display:flex}
#canvasPanel .cvs-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--green);background:rgba(0,255,65,0.05)}
#canvasPanel .cvs-header span{font-family:var(--mono);color:var(--green);font-size:12px}
#canvasPanel .cvs-header button{background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;margin-left:8px}
#canvasPanel iframe{flex:1;border:none;background:#fff;min-height:350px;width:100%}
.msg--thinking{color:var(--dim);font-style:italic}
.tool-indicator{display:inline-block;padding:2px 8px;margin:2px 0;border-radius:4px;font-size:11px;background:var(--bg3);border:1px solid var(--border)}
.tool-indicator--browser{border-color:#9c27b0;color:#ce93d8}
.tool-indicator--web{border-color:var(--cyan);color:var(--cyan)}
.tool-indicator--email{border-color:var(--green3);color:var(--green)}
.screenshot-preview{max-width:100%;border-radius:var(--r);margin:8px 0;border:1px solid var(--border)}
.inline-card{margin:12px 0;padding:0;border-radius:10px;border:1px solid var(--border);overflow:hidden;background:var(--bg2)}
.inline-card iframe{width:100%;height:280px;border:none;border-radius:0 0 10px 10px}
.inline-card a{color:var(--cyan);text-decoration:none}
.inline-card a:hover{text-decoration:underline}
.inline-browser{margin:12px 0;border-radius:10px;border:1px solid var(--green3);overflow:hidden;background:#000}
.inline-browser-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg);border-bottom:1px solid var(--border)}
.inline-browser-dot{width:8px;height:8px;border-radius:50%;background:var(--border2)}
.inline-browser-url{font-family:var(--mono);font-size:10px;color:var(--dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inline-browser img{width:100%;display:block}
.browser-viewer{position:fixed;top:12px;left:12px;width:440px;background:var(--bg2);border:2px solid #9c27b0;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:300;overflow:hidden;display:none;transition:all .3s ease}
.browser-viewer--open{display:block}
.browser-viewer__header{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#1a1a2e;border-bottom:1px solid #9c27b0;font-size:10px;color:#ce93d8}
.browser-viewer__dot{width:6px;height:6px;border-radius:50%;background:#9c27b0;animation:bvpulse 1.5s infinite}
@keyframes bvpulse{0%,100%{opacity:1}50%{opacity:.3}}
.browser-viewer__title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.browser-viewer__close{background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:0 4px}
.browser-viewer__close:hover{color:#fff}
.browser-viewer__frame{width:100%;aspect-ratio:16/9;background:#000;display:flex;align-items:center;justify-content:center}
.browser-viewer__frame img{width:100%;height:100%;object-fit:contain}
.browser-viewer__status{padding:4px 10px;font-size:9px;color:var(--dim);border-top:1px solid var(--border)}
@media(max-width:600px){.browser-viewer{width:calc(100vw - 24px);top:8px;left:8px}}
@media(min-width:901px){.browser-viewer{left:232px}}
.chat__bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 0 12px 0;border-top:1px solid var(--border);flex-shrink:0;align-items:flex-end}
.chat__bar-tools{display:flex;gap:4px;align-items:center;width:100%}
.chat__input{flex:1;resize:none;min-height:44px;max-height:120px;padding:10px 14px;font-size:14px}
.chat__send{background:var(--green3);color:var(--bg);padding:10px 20px;border-radius:var(--r);font-weight:700;font-size:14px;white-space:nowrap}
.chat__send:disabled{opacity:.4}
.chat__stop{white-space:nowrap}

/* ---- MOBILE TOUCH (Termux / small screens) ---- */
@media(max-width:600px){
  .msg--user .msg__bubble,.msg--assistant .msg__bubble{font-size:14px;padding:12px 14px;max-width:94%;line-height:1.55}
  .msg__label{font-size:11px}
  .chat__bar{flex-wrap:wrap;gap:6px;padding:8px 4px 10px 4px}
  .chat__bar-tools{flex-wrap:wrap;gap:4px}
  .chat__input{min-height:48px;font-size:15px;padding:12px 14px;width:100%;flex-basis:100%}
  .chat__send{padding:12px 20px;font-size:15px;flex-grow:1}
  .chat__stop{flex-grow:1}
  .chat__empty-title{font-size:22px}
  .header{padding:10px 12px}
  .header__title{font-size:15px}
  .content{padding:10px}
  /* Conversation sidebar as overlay on mobile, not side panel */
  #convSidebar{position:fixed!important;top:0!important;left:0!important;height:100dvh!important;width:260px!important;box-shadow:4px 0 20px rgba(0,0,0,0.8)!important;z-index:250!important}
}
.chat__stop{background:var(--red);color:var(--bright);padding:10px 16px;border-radius:var(--r);font-weight:700;font-size:12px;display:none}
.chat__stop--visible{display:block}

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
var chatHistory = [];
var activeConvId = null;
var convList = [];
var dash = {emails:[],events:[],tasks:[],plan:null,status:null};
var dashLoaded = {emails:false,events:false,tasks:false,contacts:false,notes:false,drive:false,github:false,notion:false,slack:false};
var chatStreaming = false;
var chatAbortController = null;

function endStreaming(){
  chatStreaming=false;chatAbortController=null;
  var stopBtn=document.getElementById('chatStop');if(stopBtn)stopBtn.classList.remove('chat__stop--visible');
  var sendBtn=document.getElementById('chatSend');if(sendBtn)sendBtn.style.display='';
}
function stopChat(){
  if(chatAbortController){try{chatAbortController.abort()}catch(e){}}
  endStreaming();
  if(chatHistory.length>0){
    var last=chatHistory[chatHistory.length-1];
    if(last.role==='assistant'&&(!last.content||last.content===''))last.content='[Stopped]';
  }
  renderMessages();
}

// ---- BROWSER VIEWER (live preview of headless Chrome) ----
function showBrowserViewer(title,status){
  // Update old monitor viewer
  var v=document.getElementById('browserViewer');if(v)v.classList.add('browser-viewer--open');
  var t=document.getElementById('bvTitle');if(t)t.textContent=title||'Browser';
  var s=document.getElementById('bvStatus');if(s)s.textContent=status||'Loading...';
  // Also auto-open canvas panel in browser tab
  var p=document.getElementById('canvasPanel');
  if(p&&!p.classList.contains('open')){canvasMode='browser';renderCanvasPanel();}
}
function updateBrowserFrame(data){
  // data = {base64?, file?, format, url}
  var imgSrc=data.file?API+'/api/screenshots/'+data.file:'data:image/'+(data.format||'jpeg')+';base64,'+data.base64;
  // Update old monitor viewer
  var f=document.getElementById('bvFrame');if(f)f.innerHTML='<img src="'+imgSrc+'" alt="Browser view">';
  // Save to per-conversation browser history for canvas Browser tab
  addBrowserPage(data.file||null,data.base64||null,data.url);
  // Update canvas browser tab live if open
  var p=document.getElementById('canvasPanel');
  if(p&&p.classList.contains('open')&&canvasMode==='browser'){renderCanvasPanel();}
}
function updateBrowserStatus(status){
  var s=document.getElementById('bvStatus');if(s)s.textContent=status;
}
function closeBrowserViewer(){
  var v=document.getElementById('browserViewer');if(v)v.classList.remove('browser-viewer--open');
}

function loadConvList(){return apiGet('/api/conversations').then(function(r){convList=(r&&r.conversations)||[];renderConvSidebar();})}
function loadConv(id){return apiGet('/api/conversations/'+id).then(function(r){if(r&&r.conversation){activeConvId=r.conversation.id;chatHistory=r.conversation.messages||[];renderMessages();renderConvSidebar();onConversationSwitch();}})}
function createNewConv(){return apiPost('/api/conversations',{}).then(function(r){if(r&&r.conversation){activeConvId=r.conversation.id;chatHistory=[];renderMessages();loadConvList();}})}
function deleteConv(id){return fetch(API+'/api/conversations/'+id,{method:'DELETE'}).then(function(){loadConvList();if(id===activeConvId)createNewConv();})}
function clearChatHistory(){createNewConv()}
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
  var spt=document.getElementById('sidebarPageTitle');
  if(spt)spt.textContent=titles[v]||v;
  // Toggle content--chat class for proper chat layout (no overflow, flex column)
  var ct=document.getElementById('content');
  if(ct){if(v==='chat'){ct.classList.add('content--chat')}else{ct.classList.remove('content--chat')}}
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
  // Load each API independently — render as each arrives (emails are slow)
  apiGet('/api/status').then(function(r){dash.status=r;render()});
  apiGet('/api/tasks').then(function(r){dash.tasks=(r&&r.tasks)||[];dashLoaded.tasks=true;updateBadges();render()});
  apiGet('/api/calendar').then(function(r){dash.events=(r&&r.events)||[];dashLoaded.events=true;updateBadges();render()});
  return apiGet('/api/emails?page=0&pageSize=25').then(function(r){dash.emails=(r&&r.emails)||[];dash._emailHasMore=r&&r.hasMore;dashLoaded.emails=true;emailPage=0;updateBadges();render()});
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
function loadingHTML(label){return '<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim);margin-top:8px;font-size:12px">Loading '+esc(label)+'...</div></div>'}

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
    case 'github':renderGitHub(el);break;
    case 'notion':renderNotion(el);break;
    case 'slack':renderSlack(el);break;
    case 'birthdays':renderBirthdays(el);break;
    case 'agents':renderAgents(el);break;
    case 'collab':renderCollab(el);break;
    case 'settings':renderSettings(el);break;
  }
}

// ---- DASHBOARD ----
function renderDash(el){
  if(!dashLoaded.tasks&&!dashLoaded.events&&!dashLoaded.emails){el.innerHTML=loadingHTML('dashboard');return}
  var t=dash.tasks,e=dash.emails,ev=dash.events;
  var done=t.filter(function(x){return x.status==='done'}).length;
  var pend=t.length-done;
  var pct=t.length>0?Math.round(done/t.length*100):0;
  var h='<div class="dash-grid">'+
    '<div class="card"><div class="card__title">Tasks</div><div class="card__value">'+pend+'</div><div class="card__sub">'+done+'/'+t.length+' done ('+pct+'%)</div></div>'+
    '<div class="card"><div class="card__title">Emails</div><div class="card__value">'+(dashLoaded.emails?e.length:'<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></span>')+'</div><div class="card__sub">'+(dashLoaded.emails?(e.length>0?esc(e[0].from):'Inbox zero'):'Loading...')+'</div></div>'+
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
    el.innerHTML='<div style="display:flex;height:calc(100vh - 56px)">'+
      '<div id="convSidebar" style="width:220px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0;background:var(--bg);z-index:100;display:'+(localStorage.getItem('nha_conv_sidebar')==='hidden'||(typeof window!=='undefined'&&window.innerWidth<600)?'none':'')+'">'+
        '<div style="padding:8px"><button onclick="createNewConv()" style="width:100%;padding:8px;border-radius:var(--r);border:1px solid var(--green);background:transparent;color:var(--green);cursor:pointer;font-size:11px">+ New Chat</button></div>'+
        '<div id="convList"></div>'+
      '</div>'+
      '<div style="flex:1;display:flex;flex-direction:column;min-width:0">'+
        '<div style="padding:6px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">'+
          '<button onclick="toggleConvSidebar()" style="background:none;border:none;cursor:pointer;font-size:14px;color:var(--dim);padding:2px 6px" title="Toggle conversations">&#128172;</button>'+
          '<span id="convTitle" style="flex:1;font-size:12px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">New Chat</span>'+
          '<button onclick="createNewConv()" style="background:none;border:1px solid var(--green);color:var(--green);padding:4px 10px;border-radius:var(--r);cursor:pointer;font-size:10px">+ New</button>'+
          '<button onclick="exportConvMd()" style="background:none;border:1px solid var(--border);color:var(--dim);padding:4px 8px;border-radius:var(--r);cursor:pointer;font-size:10px" title="Export Markdown">Export</button>'+
        '</div>'+
        '<div class="chat"><div class="chat__messages" id="chatMessages"></div>'+
        '<div id="chatAttachInfo" style="display:none;padding:4px 12px;font-size:11px;color:var(--cyan);background:var(--bg2);border-top:1px solid var(--border)"><span id="chatAttachName"></span> <button onclick="clearChatAttach()" style="background:none;border:none;color:#f44;cursor:pointer;font-size:14px;font-weight:700">&times;</button></div>'+
        '<div class="chat__bar">'+
          '<div class="chat__bar-tools">'+
            '<button class="chat__mic" id="chatMic" onclick="toggleVoiceInput()" title="Voice input" style="font-size:16px;padding:4px 6px;background:none;border:none;cursor:pointer">&#127908;</button>'+
            '<button onclick="document.getElementById(\\x27chatFileInput\\x27).click()" style="background:none;border:none;cursor:pointer;font-size:16px;padding:4px 6px" title="Attach file">&#128206;</button>'+
            '<button onclick="document.getElementById(\\x27chatImageInput\\x27).click()" style="background:none;border:none;cursor:pointer;font-size:16px;padding:4px 6px" title="Attach image">&#128247;</button>'+
            '<input type="file" id="chatFileInput" style="display:none" onchange="handleChatFile(this)">'+
            '<input type="file" id="chatImageInput" accept="image/*" style="display:none" onchange="handleChatImage(this)">'+
            '<span style="flex:1"></span>'+
            '<button id="thinkingToggle" onclick="toggleThinking()" style="background:none;border:1px solid var(--border2);border-radius:6px;cursor:pointer;font-size:10px;padding:4px 8px;color:var(--dim);font-family:var(--font);white-space:nowrap" title="Toggle Extended Thinking">Think: off</button>'+
            '<button onclick="reopenCanvas()" style="background:none;border:1px solid var(--border2);border-radius:6px;cursor:pointer;font-size:10px;padding:4px 8px;color:var(--dim);font-family:var(--font);white-space:nowrap;display:flex;align-items:center;gap:3px" title="Panel"><span style="font-size:12px">&#x25A3;</span>Panel</button>'+
          '</div>'+
          '<div style="display:flex;gap:8px;width:100%;align-items:flex-end">'+
            '<textarea class="chat__input" id="chatInput" placeholder="Ask anything..." rows="1"></textarea>'+
            '<button class="chat__send" id="chatSend">Send</button>'+
            '<button class="chat__stop" id="chatStop" onclick="stopChat()">Stop</button>'+
          '</div>'+
        '</div>'+
        '</div>'+
      '</div>'+
    '</div>';
    chatReady=true;
    document.getElementById('chatSend').onclick=sendChat;
    document.getElementById('chatInput').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat()}};
    loadConvList().then(function(){
      if(!activeConvId&&convList.length>0){loadConv(convList[0].id)}
      else if(!activeConvId){createNewConv()}
      else{loadConv(activeConvId)}
    });
    setTimeout(function(){var i=document.getElementById('chatInput');if(i)i.focus()},100);
  }
}
function toggleConvSidebar(){var s=document.getElementById('convSidebar');if(!s)return;var hide=s.style.display!=='none';s.style.display=hide?'none':'';try{localStorage.setItem('nha_conv_sidebar',hide?'hidden':'visible')}catch(e){}}
function renderConvSidebar(){
  var el=document.getElementById('convList');if(!el)return;
  var h='';convList.forEach(function(c){
    var active=c.id===activeConvId;
    var turns=Math.floor(c.messageCount/2);
    h+='<div onclick="loadConv(\\x27'+c.id+'\\x27)" style="padding:8px 12px;cursor:pointer;border-left:3px solid '+(active?'var(--green)':'transparent')+';background:'+(active?'var(--bg2)':'transparent')+'" onmouseover="this.style.background=\\x27var(--bg2)\\x27" onmouseout="this.style.background='+(active?"\\x27var(--bg2)\\x27":"\\x27transparent\\x27")+'">'+
      '<div style="font-size:11px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(c.title)+'</div>'+
      '<div style="font-size:9px;color:var(--dim);display:flex;gap:6px;margin-top:2px"><span>'+turns+' turns</span>'+(active?'':'<span onclick="event.stopPropagation();deleteConv(\\x27'+c.id+'\\x27)" style="color:var(--red);cursor:pointer">del</span>')+'</div>'+
    '</div>';
  });
  el.innerHTML=h;
  var t=document.getElementById('convTitle');
  if(t){var ac=convList.find(function(c){return c.id===activeConvId});t.textContent=ac?ac.title:'New Chat';}
}
function exportConvMd(){if(!activeConvId)return;window.open(API+'/api/conversations/'+activeConvId+'/export?format=md','_blank');}
function renderMessages(){
  var el=document.getElementById('chatMessages');if(!el)return;
  if(chatHistory.length===0){
    el.innerHTML='<div class="chat__empty"><div class="chat__empty-title">NHA Chat</div><div>Personal Operations Assistant — Streaming + Web Search + Browser</div><div class="chat__empty-hint">Try: Show my unread emails / Search the web for React 19 / Open google.com and take a screenshot</div></div>';
    return;
  }
  var h='';chatHistory.forEach(function(m,mi){
    var raw=m.content||'';
    var isA=m.role==='assistant';
    // Strip any raw base64 data that leaked into content
    raw=raw.replace(/data:image\\/[a-z]+;base64,[A-Za-z0-9+\\/=]{200,}/g,'[image]');
    raw=raw.replace(/[A-Za-z0-9+\\/=]{500,}/g,'');
    // Handle canvas markers (assistant only)
    if(isA){
      var cm=raw.match(/\\[CANVAS_RENDER\\]([\\s\\S]*?)\\[\\/CANVAS_RENDER\\]/);
      if(cm){try{var cd=JSON.parse(cm[1]);showCanvas(cd.html,cd.title);}catch(e){} raw=raw.replace(/\\[CANVAS_RENDER\\][\\s\\S]*?\\[\\/CANVAS_RENDER\\]/,'').trim();}
      if(raw.indexOf('[CANVAS_CLEAR]')!==-1){closeCanvas();raw=raw.replace(/\\[CANVAS_CLEAR\\][\\s\\S]*?\\[\\/CANVAS_CLEAR\\]/,'').trim();}
      // Inline cards — rendered as embedded HTML inside the message
      raw=raw.replace(/\\[INLINE_CARD\\]([\\s\\S]*?)\\[\\/INLINE_CARD\\]/g,function(_,html){return '<div class="inline-card">'+html+'</div>';});
      // Inline browser frame — rendered as embedded image inside the message
      raw=raw.replace(/\\[INLINE_BROWSER\\]([^|]+)\\|([^\\]]+)\\[\\/INLINE_BROWSER\\]/g,function(_,file,url){return '<div class="inline-browser"><div class="inline-browser-bar"><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-url">'+esc(url)+'</span></div><img src="/api/screenshots/'+esc(file)+'" alt="'+esc(url)+'"></div>';});
      // Handle screenshot file markers
      var sm=raw.match(/\\[SCREENSHOT_FILE\\](.*?)\\[\\/SCREENSHOT_FILE\\]/);
      if(sm){var fn=sm[1].split('/').pop();raw=raw.replace(/\\[SCREENSHOT_FILE\\].*?\\[\\/SCREENSHOT_FILE\\]/,'');raw='![Screenshot](/api/screenshots/'+fn+')\\n'+raw;}
    }
    var imgs=[];var idx=0;
    var safe=raw.replace(/!\\[([^\\]]*)\\]\\((\\/api\\/screenshots\\/[a-zA-Z0-9._-]+)\\)/g,function(_,alt,src){var ph='__IMG'+idx+'__';imgs.push({ph:ph,alt:alt,src:src});idx++;return ph;});
    var content=esc(safe);
    for(var i=0;i<imgs.length;i++){content=content.replace(imgs[i].ph,'<img class="screenshot-preview" alt="'+esc(imgs[i].alt)+'" src="'+imgs[i].src+'">');}
    // Action buttons + fork navigation
    var acts='<div class="msg__actions">';
    acts+='<button onclick="copyMsg('+mi+')">Copy</button>';
    if(isA){acts+='<button onclick="retryMsg('+mi+')">Retry</button>';}
    else{acts+='<button onclick="editMsg('+mi+')">Edit</button>';}
    // Fork navigation placeholder (filled after render by loadForkInfo)
    if(m.id){acts+='<span class="msg__fork" data-node-id="'+m.id+'"></span>';}
    acts+='</div>';
    var inlineBlock='';
    if(isA&&m.inlineHtml){
      inlineBlock=m.inlineHtml.replace(/\\[INLINE_CARD\\]([\\s\\S]*?)\\[\\/INLINE_CARD\\]/g,function(_,htm){return '<div class="inline-card">'+htm+'</div>';}).replace(/\\[INLINE_BROWSER\\]([^|]+)\\|([^\\]]+)\\[\\/INLINE_BROWSER\\]/g,function(_,file,url){return '<div class="inline-browser"><div class="inline-browser-bar"><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-url">'+esc(url)+'</span></div><img src="/api/screenshots/'+esc(file)+'" alt="'+esc(url)+'"></div>';});
    }
    h+='<div class="msg msg--'+esc(m.role)+'"><div class="msg__label">'+esc(m.role==='user'?'You':'NHA')+'</div><div class="msg__bubble">'+content+'</div>'+inlineBlock+acts+'</div>';
  });
  el.innerHTML=h;el.scrollTop=el.scrollHeight;
  // Load fork info for messages that have IDs
  if(activeConvId){
    apiGet('/api/conversations/'+activeConvId+'/forks').then(function(r){
      if(!r||!r.forks)return;
      var forkEls=document.querySelectorAll('.msg__fork');
      for(var fi=0;fi<forkEls.length;fi++){
        var nodeId=forkEls[fi].getAttribute('data-node-id');
        var forkInfo=r.forks[nodeId];
        if(forkInfo&&forkInfo.total>1){
          forkEls[fi].innerHTML='<button onclick="navigateFork(\\x27'+nodeId+'\\x27,-1)" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px">&#x25C0;</button><span style="font-size:9px;color:var(--dim);margin:0 2px">'+(forkInfo.current+1)+'/'+forkInfo.total+'</span><button onclick="navigateFork(\\x27'+nodeId+'\\x27,1)" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px">&#x25B6;</button>';
        }
      }
    }).catch(function(){});
  }
}
var chatAttachedFile=null;
var chatAttachedImage=null;

function handleChatFile(input){
  var file=input.files&&input.files[0];if(!file)return;
  var isPDF=file.name.toLowerCase().endsWith('.pdf')||file.type==='application/pdf';
  if(isPDF){
    // PDF: read as base64 and send as document to LLM
    var reader=new FileReader();
    reader.onload=function(e){
      var base64=e.target.result.split(',')[1];
      chatAttachedFile={name:file.name,size:file.size,content:null,base64:base64,mimeType:'application/pdf',isPDF:true};
      chatAttachedImage=null;
      document.getElementById('chatAttachInfo').style.display='';
      document.getElementById('chatAttachName').textContent='📎 '+file.name+' ('+Math.round(file.size/1024)+' KB)';
    };
    reader.readAsDataURL(file);
  }else{
    var reader=new FileReader();
    reader.onload=function(e){
      chatAttachedFile={name:file.name,size:file.size,content:e.target.result};
      chatAttachedImage=null;
      document.getElementById('chatAttachInfo').style.display='';
      document.getElementById('chatAttachName').textContent='📎 '+file.name+' ('+Math.round(file.size/1024)+' KB)';
    };
    reader.readAsText(file);
  }
}

function handleChatImage(input){
  var file=input.files&&input.files[0];if(!file)return;
  var reader=new FileReader();
  reader.onload=function(e){
    var base64=e.target.result.split(',')[1];
    chatAttachedImage={name:file.name,size:file.size,base64:base64,mimeType:file.type||'image/jpeg'};
    chatAttachedFile=null;
    document.getElementById('chatAttachInfo').style.display='';
    document.getElementById('chatAttachName').textContent='📷 '+file.name+' ('+Math.round(file.size/1024)+' KB)';
  };
  reader.readAsDataURL(file);
}

function clearChatAttach(){
  chatAttachedFile=null;chatAttachedImage=null;
  document.getElementById('chatAttachInfo').style.display='none';
  document.getElementById('chatFileInput').value='';
  document.getElementById('chatImageInput').value='';
}

// ---- CANVAS + BROWSER (per-conversation history) ----
var allCanvasData={};   // {convId: {canvases:[{html,title,ts}], browsers:[{base64,url,ts}]}}
var canvasIdx=-1;
var browserIdx=-1;
var canvasMode='canvas';

function getConvCanvasData(){
  var id=activeConvId||'_default';
  if(!allCanvasData[id])allCanvasData[id]={canvases:[],browsers:[]};
  return allCanvasData[id];
}

function showCanvas(html,title){
  var d=getConvCanvasData();
  d.canvases.push({html:html,title:title||'Canvas',ts:new Date().toLocaleTimeString()});
  canvasIdx=d.canvases.length-1;
  canvasMode='canvas';
  renderCanvasPanel();
  saveCanvasData();
}

function addBrowserPage(file,base64,url){
  var d=getConvCanvasData();
  var cleanUrl=(url||'Browser').replace(/^https?:\\/\\//, '').slice(0,60);
  // Only add if URL is different from the last entry (avoid frame duplicates)
  if(d.browsers.length>0&&d.browsers[d.browsers.length-1].url===cleanUrl){
    // Update the thumbnail file ref
    if(file)d.browsers[d.browsers.length-1].file=file;
    if(base64)d.browsers[d.browsers.length-1].base64=base64;
    return;
  }
  d.browsers.push({file:file,base64:base64,url:cleanUrl,ts:new Date().toLocaleTimeString()});
  browserIdx=d.browsers.length-1;
  // Persist file refs to localStorage (not base64)
  saveCanvasData();
}

function saveCanvasData(){
  try{
    var save={};
    for(var id in allCanvasData){
      var d=allCanvasData[id];
      if(d.canvases.length>0||d.browsers.length>0){
        save[id]={
          canvases:d.canvases.slice(-20),
          // Save browser entries with file refs only (no base64)
          browsers:d.browsers.slice(-30).map(function(b){return {file:b.file,url:b.url,ts:b.ts};})
        };
      }
    }
    localStorage.setItem('nha_canvas_data',JSON.stringify(save));
  }catch(e){}
}

function loadCanvasData(){
  try{
    var saved=localStorage.getItem('nha_canvas_data');
    if(saved){
      var parsed=JSON.parse(saved);
      for(var id in parsed){
        if(!allCanvasData[id])allCanvasData[id]={canvases:[],browsers:[]};
        allCanvasData[id].canvases=parsed[id].canvases||[];
        allCanvasData[id].browsers=parsed[id].browsers||[];
      }
    }
  }catch(e){}
}
loadCanvasData();

function renderCanvasPanel(){
  var p=document.getElementById('canvasPanel');
  if(!p)return;
  p.classList.add('open');
  var d=getConvCanvasData();
  var list=canvasMode==='browser'?d.browsers:d.canvases;
  var idx=canvasMode==='browser'?browserIdx:canvasIdx;
  var item=list[idx];
  // Header title
  var t=document.getElementById('canvasTitle');
  if(t){
    if(canvasMode==='browser'){t.textContent=d.browsers.length>0?d.browsers.length+' pages visited':'No pages visited';}
    else if(!item){t.textContent='Empty canvas';}
    else{t.textContent=(item.title||'Canvas')+(d.canvases.length>1?' ('+(canvasIdx+1)+'/'+d.canvases.length+')':'');}
  }
  // Nav arrows — only for canvas mode (browser uses gallery grid)
  var navEl=document.getElementById('canvasNav');
  if(navEl){navEl.style.display=d.canvases.length>1&&canvasMode==='canvas'?'flex':'none';}
  // Tab highlight
  var tabC=document.getElementById('canvasTabC');
  var tabB=document.getElementById('canvasTabB');
  if(tabC)tabC.style.borderBottom=canvasMode==='canvas'?'2px solid var(--green)':'none';
  if(tabB)tabB.style.borderBottom=canvasMode==='browser'?'2px solid var(--green)':'none';
  // Render iframe content via srcdoc (no allow-same-origin needed)
  var f=document.getElementById('canvasFrame');if(!f)return;
  if(canvasMode==='browser'){
    var d=getConvCanvasData();
    if(d.browsers.length===0){
      f.srcdoc='<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#555"><div style="text-align:center"><div style="font-size:48px;margin-bottom:12px">&#x1F310;</div><div>No pages visited yet</div><div style="font-size:11px;margin-top:8px;color:#333">in this conversation</div><div style="margin-top:16px;font-size:11px;color:#888">Ask me to search or open a page</div></div></body></html>';
    } else {
      var apiBase=window.API||'';
      var gallery='<html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;padding:12px;font-family:monospace}h3{color:#00ff41;font-size:12px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.card{background:#1a1a1a;border:1px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .2s}.card:hover{border-color:#00ff41}.card img{width:100%;height:120px;object-fit:cover;display:block;background:#222}.card .info{padding:6px 8px}.card .url{color:#8ab4f8;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card .time{color:#555;font-size:9px;margin-top:2px}</style></head><body><h3>Pages visited ('+d.browsers.length+')</h3><div class="grid">';
      for(var bi=0;bi<d.browsers.length;bi++){
        var b=d.browsers[bi];
        var imgSrc=b.file?apiBase+'/api/screenshots/'+b.file:(b.base64?'data:image/jpeg;base64,'+b.base64:'');
        gallery+='<div class="card" onclick="window.parent.postMessage({type:\\x27selectBrowser\\x27,index:'+bi+'},\\x27*\\x27)">'+(imgSrc?'<img src="'+imgSrc+'" alt="'+b.url+'"/>':'<div style="height:120px;display:flex;align-items:center;justify-content:center;color:#555">No preview</div>')+'<div class="info"><div class="url">'+b.url+'</div><div class="time">'+(b.ts||'')+'</div></div></div>';
      }
      gallery+='</div></body></html>';
      f.srcdoc=gallery;
    }
  } else if(!item){
    f.srcdoc='<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#555"><div style="text-align:center"><div style="font-size:48px;margin-bottom:12px">&#x25A3;</div><div>No canvas content</div><div style="font-size:11px;margin-top:8px;color:#333">in this conversation</div></div></body></html>';
  } else {
    f.srcdoc=item.html;
  }
}

function canvasPrev(){
  var d=getConvCanvasData();
  if(canvasMode==='browser'){if(browserIdx>0){browserIdx--;renderCanvasPanel();}}
  else{if(canvasIdx>0){canvasIdx--;renderCanvasPanel();}}
}
function canvasNext(){
  var d=getConvCanvasData();
  if(canvasMode==='browser'){if(browserIdx<d.browsers.length-1){browserIdx++;renderCanvasPanel();}}
  else{if(canvasIdx<d.canvases.length-1){canvasIdx++;renderCanvasPanel();}}
}
// Listen for messages from sandboxed canvas iframe
window.addEventListener('message',function(e){
  if(e.data&&e.data.type==='selectBrowser'&&typeof e.data.index==='number'){selectBrowserPage(e.data.index);}
});
function selectBrowserPage(i){
  browserIdx=i;canvasMode='browser';renderCanvasPanel();
  // Also show in monitor viewer
  var d=getConvCanvasData();var b=d.browsers[i];
  if(b){
    showBrowserViewer(b.url,'Viewing saved page');
    var f=document.getElementById('bvFrame');
    if(f){var src=b.file?API+'/api/screenshots/'+b.file:(b.base64?'data:image/jpeg;base64,'+b.base64:'');if(src)f.innerHTML='<img src="'+src+'" alt="'+b.url+'">';}
  }
}
function canvasShowBrowser(){var d=getConvCanvasData();browserIdx=d.browsers.length-1;canvasMode='browser';renderCanvasPanel();}
function canvasShowCanvas(){var d=getConvCanvasData();canvasIdx=d.canvases.length-1;canvasMode='canvas';renderCanvasPanel();}

function onConversationSwitch(){
  // Called when user switches conversation — update canvas panel
  var p=document.getElementById('canvasPanel');
  if(p&&p.classList.contains('open')){
    var d=getConvCanvasData();
    canvasIdx=d.canvases.length-1;
    browserIdx=d.browsers.length-1;
    renderCanvasPanel();
  }
}

function reopenCanvas(){
  var d=getConvCanvasData();
  canvasIdx=d.canvases.length-1;
  browserIdx=d.browsers.length-1;
  if(d.canvases.length>0){canvasMode='canvas';}
  else if(d.browsers.length>0){canvasMode='browser';}
  else{canvasMode='canvas';} // show empty state
  renderCanvasPanel();
}
function closeCanvas(){var p=document.getElementById('canvasPanel');if(p)p.classList.remove('open');}
function canvasCopyText(){
  var d=getConvCanvasData();var item=d.canvases[canvasIdx];
  if(!item){alert('No canvas content');return;}
  var tmp=document.createElement('div');tmp.innerHTML=item.html.replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi,'');
  var text=tmp.textContent||tmp.innerText||'';
  navigator.clipboard.writeText(text).then(function(){alert('Text copied!')}).catch(function(){alert('Copy failed')});
}
function canvasCopyHTML(){
  var d=getConvCanvasData();var item=d.canvases[canvasIdx];
  if(!item){alert('No canvas content');return;}
  navigator.clipboard.writeText(item.html).then(function(){alert('HTML source copied!')}).catch(function(){alert('Copy failed')});
}
function canvasCopyImage(){
  var f=document.getElementById('canvasFrame');
  if(!f){alert('No canvas frame');return;}
  try{
    // Ask the iframe to capture itself via postMessage
    // Inject a capture script into the iframe
    var d=getConvCanvasData();var item=d.canvases[canvasIdx];
    if(!item){alert('No canvas');return;}
    // Re-render with capture script added
    var captureScript='<script>window.addEventListener("message",function(e){if(e.data==="capture"){try{var c=document.querySelector("canvas");if(c){window.parent.postMessage({type:"canvasCapture",dataUrl:c.toDataURL("image/png")},"*");return;}import("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js").then(function(m){return m.default||window.html2canvas}).then(function(h2c){h2c(document.body,{backgroundColor:"#0a0a0a",scale:2}).then(function(cv){window.parent.postMessage({type:"canvasCapture",dataUrl:cv.toDataURL("image/png")},"*")})}).catch(function(){window.parent.postMessage({type:"canvasCapture",error:"Capture failed"},"*")})}catch(err){window.parent.postMessage({type:"canvasCapture",error:err.message},"*")}}});<\\/script>';
    var htmlWithCapture=item.html.replace('</body>',captureScript+'</body>');
    if(htmlWithCapture===item.html)htmlWithCapture=item.html+captureScript;
    f.srcdoc=htmlWithCapture;
    // Listen for the capture response
    var handler=function(e){
      if(e.data&&e.data.type==='canvasCapture'){
        window.removeEventListener('message',handler);
        if(e.data.error){alert('Capture failed: '+e.data.error);return;}
        // Convert dataUrl to blob and copy/download
        fetch(e.data.dataUrl).then(function(r){return r.blob()}).then(function(blob){
          navigator.clipboard.write([new ClipboardItem({'image/png':blob})]).then(function(){alert('Image copied!')}).catch(function(){
            var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='canvas.png';a.click();alert('Image downloaded as canvas.png');
          });
        });
      }
    };
    window.addEventListener('message',handler);
    // Wait for iframe to load, then trigger capture
    setTimeout(function(){f.contentWindow.postMessage('capture','*')},1500);
  }catch(e){alert('Copy failed: '+e.message);}
}
function toggleCanvasSize(){
  var p=document.getElementById('canvasPanel');if(!p)return;
  if(p.style.width==='80vw'){p.style.width='';p.style.height='';p.style.top='';p.style.right='';}
  else{p.style.width='80vw';p.style.height='80vh';p.style.top='10vh';p.style.right='10vw';}
}
// ---- MSG ACTIONS ----
function copyMsg(i){
  var m=chatHistory[i];if(!m)return;
  var t=(m.content||'').replace(/\\[CANVAS_RENDER\\][\\s\\S]*?\\[\\/CANVAS_RENDER\\]/g,'').replace(/\\[SCREENSHOT_FILE\\].*?\\[\\/SCREENSHOT_FILE\\]/g,'').trim();
  navigator.clipboard.writeText(t).catch(function(){});
}
function retryMsg(i){
  if(i<1||chatHistory[i].role!=='assistant')return;
  if(chatStreaming)return;
  var userMsg=chatHistory[i-1];
  if(!userMsg||userMsg.role!=='user')return;

  // Replace the assistant response at position i and re-stream using the full sendChat flow
  // The old response is saved as a fork branch in the tree
  chatHistory.splice(i); // remove from i onwards
  renderMessages();
  // Put the user message in the input and trigger sendChat with retry flag
  var inp=document.getElementById('chatInput');
  if(inp){inp.value=userMsg.content;}
  // Remove the duplicate user message that sendChat will add
  chatHistory.pop(); // remove the user message (sendChat will re-add it)
  window._nhaRetryMode=true;
  sendChat();
}
function editMsg(i){
  if(chatHistory[i].role!=='user')return;
  var inp=document.getElementById('chatInput');if(!inp)return;
  // Put text in input but DON'T delete anything yet
  // User can press Esc to cancel or Enter to send (which creates a branch)
  inp.value=chatHistory[i].content;
  inp.focus();
  // Mark that we're editing — sendChat will handle truncation
  window._nhaEditIndex=i;
  // Listen for Esc to cancel
  inp.onkeydown=function(e){
    if(e.key==='Escape'){
      inp.value='';
      window._nhaEditIndex=null;
      inp.onkeydown=function(ev){if(ev.key==='Enter'&&!ev.shiftKey){ev.preventDefault();sendChat();}};
    }
  };
}
function navigateFork(nodeId,dir){
  if(!activeConvId)return;
  apiPost('/api/conversations/'+activeConvId+'/navigate',{nodeId:nodeId,direction:dir}).then(function(r){
    if(r&&r.ok&&r.messages){chatHistory=r.messages;renderMessages();}
  });
}
var thinkingEnabled=false;
function toggleThinking(){
  thinkingEnabled=!thinkingEnabled;
  apiPost('/api/config',{key:'thinking',value:thinkingEnabled?'on':'off'}).catch(function(){});
  var btn=document.getElementById('thinkingToggle');
  if(btn){
    btn.textContent='Think: '+(thinkingEnabled?'on':'off');
    btn.style.color=thinkingEnabled?'var(--amber)':'var(--dim)';
    btn.style.borderColor=thinkingEnabled?'var(--amber3)':'var(--border2)';
  }
}
// Init thinking state from config
apiGet('/api/config').then(function(r){
  if(r&&(r.thinking===true||r.thinking==='on'||r.thinking==='true')){
    thinkingEnabled=true;
    var btn=document.getElementById('thinkingToggle');
    if(btn){btn.textContent='Think: on';btn.style.color='var(--amber)';btn.style.borderColor='var(--amber3)';}
  }
}).catch(function(){});
function sendChat(){
  var inp=document.getElementById('chatInput');if(!inp)return;
  var msg=inp.value.trim();
  var hasAttach=!!chatAttachedFile||!!chatAttachedImage;
  if(!msg&&!hasAttach)return;
  if(chatStreaming)return;

  var isRetry=!!window._nhaRetryMode;
  window._nhaRetryMode=false;

  // Handle edit mode — truncate history to edit point before adding
  if(window._nhaEditIndex!=null){
    chatHistory=chatHistory.slice(0,window._nhaEditIndex);
    window._nhaEditIndex=null;
    // Reset keydown handler
    inp.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}};
  }

  var displayMsg=msg;
  if(chatAttachedFile)displayMsg=(msg?msg+' ':'')+'[File: '+chatAttachedFile.name+']';
  if(chatAttachedImage)displayMsg=(msg?msg+' ':'')+'[Image: '+chatAttachedImage.name+']';

  chatHistory.push({role:'user',content:displayMsg});
  inp.value='';renderMessages();

  // If attachment, use regular (non-streaming) endpoint
  if(chatAttachedFile||chatAttachedImage){
    chatHistory.push({role:'assistant',content:'Thinking...'});renderMessages();
    var payload={message:msg||'Analyze this attachment',history:chatHistory.slice(0,-1)};
    if(chatAttachedFile){
      if(chatAttachedFile.isPDF&&chatAttachedFile.base64){payload.pdfBase64=chatAttachedFile.base64;payload.pdfName=chatAttachedFile.name;}
      else{payload.fileContent=chatAttachedFile.content;payload.fileName=chatAttachedFile.name;}
    }
    if(chatAttachedImage){payload.imageBase64=chatAttachedImage.base64;payload.imageMimeType=chatAttachedImage.mimeType;}
    clearChatAttach();
    apiPost('/api/chat',payload).then(function(r){
      chatHistory.pop();
      if(r&&r.response){chatHistory.push({role:'assistant',content:r.response})}
      else if(r&&r.error){chatHistory.push({role:'assistant',content:'Error: '+r.error})}
      else{chatHistory.push({role:'assistant',content:'Error: no response'})}
      renderMessages();loadConvList();
    });
    return;
  }
  clearChatAttach();

  // Streaming SSE
  chatStreaming=true;
  chatAbortController=new AbortController();
  // Show Stop button, hide Send button
  var stopBtn=document.getElementById('chatStop');if(stopBtn)stopBtn.classList.add('chat__stop--visible');
  var sendBtn=document.getElementById('chatSend');if(sendBtn)sendBtn.style.display='none';
  chatHistory.push({role:'assistant',content:''});
  renderMessages();
  var streamIdx=chatHistory.length-1;
  var allHistory=chatHistory.slice(0,-1).map(function(m){return{role:m.role,content:(m.content||'').replace(/!\\[Screenshot\\]\\(data:image\\/[^)]+\\)/g,'[Screenshot taken]')};});
  var payload={message:msg,history:allHistory,conversationId:activeConvId,isRetry:isRetry};

  fetch(API+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:chatAbortController.signal}).then(function(response){
    if(!response.ok||!response.body){chatHistory[streamIdx].content='Error: connection failed';endStreaming();renderMessages();return;}
    var reader=response.body.getReader();var decoder=new TextDecoder();var buffer='';var currentEvent='';
    function pump(){
      reader.read().then(function(result){
        if(result.done){endStreaming();renderMessages();loadConvList();return;}
        buffer+=decoder.decode(result.value,{stream:true});
        var lines=buffer.split('\\n');buffer=lines.pop()||'';
        for(var i=0;i<lines.length;i++){
          var line=lines[i];
          if(line.startsWith('event: ')){currentEvent=line.slice(7).trim();}
          else if(line.startsWith('data: ')){
            try{
              var data=JSON.parse(line.slice(6));
              if(currentEvent==='token'&&data.content){
                chatHistory[streamIdx].content+=data.content;
                // Strip <think>...</think> for display, show indicator
                var displayContent=chatHistory[streamIdx].content;
                var isThinking=displayContent.indexOf('<think>')!==-1&&displayContent.indexOf('</think>')===-1;
                if(isThinking){
                  displayContent='\\u{1F4AD} Thinking...';
                } else {
                  displayContent=displayContent.replace(/<think>[\\s\\S]*?<\\/think>/g,'').trim();
                }
                var el=document.getElementById('chatMessages');
                if(el){var msgs=el.querySelectorAll('.msg');var last=msgs[msgs.length-1];if(last){var bub=last.querySelector('.msg__bubble');if(bub)bub.textContent=displayContent||'Thinking...';}el.scrollTop=el.scrollHeight;}
              }
              if(currentEvent==='tool'){
                var toolLabels={browser_open:'Opening page',browser_screenshot:'Taking screenshot',browser_click:'Clicking element',browser_type:'Typing text',browser_extract:'Extracting content',browser_js:'Running JavaScript',browser_wait:'Waiting for element',browser_scroll:'Scrolling page',browser_key:'Pressing key',browser_close:'Closing browser',web_search:'Searching the web',fetch_url:'Fetching URL',gmail_list:'Searching emails',gmail_read:'Reading email',gmail_send:'Sending email',calendar_today:'Loading calendar',calendar_create:'Creating event'};
                var label=toolLabels[data.action]||data.action;
                var indicator=data.status==='executing'?'\\u23f3 '+label+'...':'\\u2705 '+label;
                if(data.status==='error')indicator='\\u274c '+label+' failed';
                // Show browser viewer for browser and web_search actions
                var isBrowserAction=data.action&&(data.action.startsWith('browser_')||data.action==='web_search');
                if(isBrowserAction&&data.status==='executing'){showBrowserViewer(label,'Executing...');}
                if(isBrowserAction&&data.status==='done'){updateBrowserStatus('\\u2705 '+label);}
                if(isBrowserAction&&data.status==='error'){updateBrowserStatus('\\u274c '+label);}
                if(data.action==='browser_close'&&data.status==='done'){setTimeout(closeBrowserViewer,2000);}
                // Strip JSON action blocks from streamed content (they are internal tool calls, not for the user)
                if(data.status==='executing'){chatHistory[streamIdx].content=chatHistory[streamIdx].content.replace(new RegExp('\\x60\\x60\\x60json[\\\\s\\\\S]*?\\x60\\x60\\x60','g'),'').trim()+'\\n';}
                chatHistory[streamIdx].content+=indicator+'\\n';
                renderMessages();
              }
              if(currentEvent==='screenshot'&&data.base64){
                showBrowserViewer('Screenshot','Captured');
                updateBrowserFrame({base64:data.base64,format:data.format||'jpeg',url:'Screenshot'});
                updateBrowserStatus('Screenshot captured');
              }
              if(currentEvent==='browser_frame'&&(data.base64||data.file)){
                showBrowserViewer(data.url||'Browser','Live');
                updateBrowserFrame(data);
                if(data.url)updateBrowserStatus(data.url);
              }
              if(currentEvent==='canvas'&&data.markers){
                // Canvas content arrived — render it immediately
                var cm=data.markers.match(/\\[CANVAS_RENDER\\]([\\s\\S]*?)\\[\\/CANVAS_RENDER\\]/);
                if(cm){try{var cd=JSON.parse(cm[1]);showCanvas(cd.html,cd.title);}catch(e){}}
                if(data.markers.indexOf('[CANVAS_CLEAR]')!==-1)closeCanvas();
              }
              if(currentEvent==='tool_synthesis'){chatHistory[streamIdx].content='';renderMessages();}
              if(currentEvent==='done'){endStreaming();if(data.content){chatHistory[streamIdx].content=data.content.replace(/<think>[\\s\\S]*?<\\/think>/g,'').trim();}else{chatHistory[streamIdx].content=chatHistory[streamIdx].content.replace(/<think>[\\s\\S]*?<\\/think>/g,'').trim();}var ssf=data.screenshotFiles||[];for(var fi=0;fi<ssf.length;fi++){chatHistory[streamIdx].content+='\\n![Screenshot](/api/screenshots/'+ssf[fi]+')\\n';}if(data.inlineHtml){chatHistory[streamIdx].inlineHtml=data.inlineHtml;}var bt=data.browserThumbs||[];if(bt.length>0){var cd=getConvCanvasData();for(var bti=0;bti<bt.length;bti++){var exists=cd.browsers.some(function(b){return b.file===bt[bti].file;});if(!exists)cd.browsers.push({file:bt[bti].file,url:bt[bti].url,ts:new Date().toLocaleTimeString()});}browserIdx=cd.browsers.length-1;saveCanvasData();}renderMessages();loadConvList();if(activeConvId){setTimeout(function(){loadConv(activeConvId);},500);}}
              if(currentEvent==='error'){endStreaming();chatHistory[streamIdx].content='Error: '+(data.message||'Unknown');renderMessages();}
            }catch(e){}
          }
        }
        pump();
      }).catch(function(e){endStreaming();if(e.name!=='AbortError'){chatHistory[streamIdx].content='Error: '+e.message;renderMessages();}});
    }
    pump();
  }).catch(function(e){endStreaming();if(e.name!=='AbortError'){chatHistory[streamIdx].content='Error: '+e.message;renderMessages();}});
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
  // Optimistic UI — update instantly, sync in background
  var t=dash.tasks.find(function(x){return x.id===id});
  if(t){t.status=t.status==='done'?'pending':'done';t.completedAt=t.status==='done'?new Date().toISOString():null}
  render();
  apiPatch('/api/tasks/'+id+'/done').then(function(){loadDash()});
}
function deleteTaskUI(id){
  if(!confirm('Delete task #'+id+'?'))return;
  dash.tasks=dash.tasks.filter(function(x){return x.id!==id});
  render();
  apiPost('/api/tasks/'+id+'/delete',{}).then(function(){loadDash()});
}
function clearTasksUI(mode){
  var msg=mode==='all'?'Delete ALL tasks? This cannot be undone.':'Remove all completed tasks?';
  if(!confirm(msg))return;
  if(mode==='all'){dash.tasks=[]}else{dash.tasks=dash.tasks.filter(function(x){return x.status!=='done'})}
  render();
  apiPost('/api/tasks/clear',{mode:mode}).then(function(){loadDash()});
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
    if(p.security_alerts&&p.security_alerts.length>0){h+='<div class="section-title" style="color:var(--red)">Security Alerts</div>';p.security_alerts.forEach(function(a){var txt=typeof a==='string'?a:(a.description||a.message||a.action_required||'Alert');var sev=typeof a==='object'&&a.severity?' ['+a.severity.toUpperCase()+']':'';h+='<div class="card" style="border-color:var(--red);padding:14px"><span style="color:var(--red);font-weight:700">!'+esc(sev)+'</span> '+esc(txt)+(typeof a==='object'&&a.action_required&&a.action_required!==txt?'<div style="color:var(--amber);font-size:11px;margin-top:6px">Action: '+esc(a.action_required)+'</div>':'')+'</div>'})}
    if(p.insights&&p.insights.length>0){h+='<div class="section-title">Insights</div>';p.insights.forEach(function(i){var txt=typeof i==='string'?i:(i.message||i.insight||'');h+='<div style="color:var(--dim);padding:4px 0;font-size:12px">\\u2192 '+esc(txt)+'</div>'})}
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
  if(!dashLoaded.emails){el.innerHTML=loadingHTML('emails');return}
  var e=dash.emails;
  if(e.length===0){el.innerHTML='<div class="card" style="text-align:center;color:var(--dim);padding:30px">Inbox zero — no emails</div>';return}
  var unreadCount=e.filter(function(x){return x.isUnread}).length;
  var h='<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">';
  h+='<span style="font-size:12px;color:var(--dim)">'+e.length+' emails'+(unreadCount>0?' ('+unreadCount+' unread)':'')+'</span>';
  if(unreadCount>0)h+='<button class="btn btn--secondary" style="font-size:10px;padding:4px 10px" onclick="markAllEmailsRead()">Mark all read</button>';
  h+='</div>';
  e.forEach(function(x){
    var unreadStyle=x.isUnread?'border-left:3px solid var(--green);font-weight:700':'border-left:3px solid transparent;opacity:0.7';
    h+='<div class="card email" style="cursor:pointer;'+unreadStyle+'" onclick="openEmail(\\x27'+esc(x.id)+'\\x27)"><div class="email__header"><span class="email__from">'+esc(x.from)+'</span><span class="email__date">'+esc(x.date)+(x.isUnread?' <span style="color:var(--green);font-size:9px">NEW</span>':'')+'</span></div><div class="email__subject">'+esc(x.subject)+'</div><div class="email__snippet" style="font-weight:400">'+esc((x.snippet||'').slice(0,150))+'</div></div>';
  });
  // Load More button
  if(dash._emailHasMore!==false){
    h+='<button id="loadMoreEmails" onclick="loadMoreEmails()" style="width:100%;padding:12px;margin-top:8px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);color:var(--cyan);font-family:var(--font);font-size:12px;cursor:pointer;font-weight:700">Load More Emails</button>';
  }
  el.innerHTML=h;
}
var emailPage=0;
function loadMoreEmails(){
  var btn=document.getElementById('loadMoreEmails');
  if(btn){btn.textContent='Loading...';btn.disabled=true;}
  emailPage++;
  apiGet('/api/emails?page='+emailPage+'&pageSize=25').then(function(r){
    if(r&&r.emails){
      for(var i=0;i<r.emails.length;i++){
        if(!dash.emails.find(function(e){return e.id===r.emails[i].id})){
          dash.emails.push(r.emails[i]);
        }
      }
      dash._emailHasMore=r.hasMore;
      updateBadges();
      render();
    }
  });
}
function markAllEmailsRead(){
  apiPost('/api/email/mark-all-read',{}).then(function(r){
    if(r&&r.ok){
      dash.emails.forEach(function(e){e.isUnread=false});
      updateBadges();
      renderEmails(document.getElementById('content'));
      showToast('success','All Read','Marked '+( r.count||0)+' emails as read');
    }else{
      showToast('error','Error',r&&r.error||'Failed');
    }
  });
}
var openEmailId=null;
function openEmail(id){
  openEmailId=id;
  // Mark as read locally + on server
  var emailObj=dash.emails.find(function(e){return e.id===id});
  if(emailObj&&emailObj.isUnread){
    emailObj.isUnread=false;
    updateBadges();
    apiPost('/api/email/mark-read',{messageId:id}).catch(function(){});
  }
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

// ---- GITHUB ----
var ghData=null;var ghRepo='';
function renderGitHub(el){
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading GitHub...</div></div>';
  apiGet('/api/github').then(function(r){
    if(r&&r.error){el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="color:var(--dim);margin-bottom:8px">'+esc(r.error)+'</div><div style="font-size:11px;color:var(--dim)">Run: nha config set github-token YOUR_PAT</div></div>';return}
    ghData=r;
    var h='<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap"><input type="text" id="ghRepo" placeholder="owner/repo" value="'+esc(ghRepo)+'" style="flex:1;min-width:180px;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)loadGhIssues()"><button onclick="loadGhIssues()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">Issues</button><button onclick="loadGhPRs()" style="background:var(--cyan);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">PRs</button></div>';
    var notifs=r.notifications||[];
    if(notifs.length>0){
      h+='<div style="display:flex;align-items:center;justify-content:space-between"><div class="section-title">Notifications ('+notifs.length+')</div><button onclick="ghMarkRead()" style="background:var(--bg3);color:var(--dim);border:1px solid var(--border);padding:4px 10px;border-radius:var(--r);font-size:10px;cursor:pointer">Mark all read</button></div>';
      notifs.forEach(function(n){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="window.open(\\x27'+esc(n.url)+'\\x27,\\x27_blank\\x27)"><span style="color:var(--cyan);font-size:11px">'+esc(n.repo)+'</span> <span style="color:var(--dim);font-size:10px">['+esc(n.type)+']</span><div style="font-size:13px;margin-top:2px">'+esc(n.title)+'</div><div style="font-size:10px;color:var(--dim)">'+esc(n.reason)+' &middot; '+esc(n.updated)+'</div></div>'});
    }
    if(r.issues&&r.issues.length>0){
      h+='<div class="section-title">Issues</div>';
      r.issues.forEach(function(i){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="window.open(\\x27'+esc(i.url)+'\\x27,\\x27_blank\\x27)"><span style="color:var(--green);font-weight:700">#'+i.number+'</span> '+esc(i.title)+(i.assignee?' <span style="font-size:10px;color:var(--cyan)">\\u2192 '+esc(i.assignee)+'</span>':'')+(i.labels?'<span style="font-size:9px;color:var(--amber);margin-left:6px">['+esc(i.labels)+']</span>':'')+'<div style="font-size:10px;color:var(--dim)">'+esc(i.updated)+'</div></div>'});
    }
    if(r.prs&&r.prs.length>0){
      h+='<div class="section-title">Pull Requests</div>';
      r.prs.forEach(function(p){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="window.open(\\x27'+esc(p.url)+'\\x27,\\x27_blank\\x27)"><span style="color:var(--cyan);font-weight:700">#'+p.number+'</span> '+esc(p.title)+' <span style="font-size:10px;color:var(--dim)">by '+esc(p.author)+'</span>'+(p.draft?'<span style="font-size:9px;color:var(--amber)"> DRAFT</span>':'')+'<div style="font-size:10px;color:var(--dim)">'+esc(p.updated)+'</div></div>'});
    }
    if(!notifs.length&&!r.issues?.length&&!r.prs?.length){h+='<div class="card" style="text-align:center;color:var(--dim);padding:20px">Enter a repo above (e.g. owner/repo) and click Issues or PRs.<br>Notifications load automatically.</div>'}
    el.innerHTML=h;
  });
}
function loadGhIssues(){var inp=document.getElementById('ghRepo');if(!inp||!inp.value.trim())return;ghRepo=inp.value.trim();var el=document.getElementById('content');el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div></div>';apiGet('/api/github/issues?repo='+encodeURIComponent(ghRepo)).then(function(r){if(ghData){ghData.issues=r.issues||[];ghData.repo=r.repo}render()})}
function loadGhPRs(){var inp=document.getElementById('ghRepo');if(!inp||!inp.value.trim())return;ghRepo=inp.value.trim();var el=document.getElementById('content');el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div></div>';apiGet('/api/github/prs?repo='+encodeURIComponent(ghRepo)).then(function(r){if(ghData){ghData.prs=r.prs||[];ghData.repo=r.repo}render()})}
function ghMarkRead(){apiPost('/api/github/mark-read',{}).then(function(){if(ghData)ghData.notifications=[];render()})}

// ---- NOTION ----
function renderNotion(el){
  el.innerHTML='<div style="display:flex;gap:8px;margin-bottom:16px"><input type="text" id="notionQuery" placeholder="Search Notion pages..." style="flex:1;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)searchNotion()"><button onclick="searchNotion()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">Search</button></div><div id="notionResults"><div class="card" style="text-align:center;color:var(--dim);padding:20px">Search your Notion workspace. Requires: nha config set notion-token YOUR_TOKEN</div></div>';
}
function searchNotion(){
  var q=document.getElementById('notionQuery');if(!q||!q.value.trim())return;
  var res=document.getElementById('notionResults');res.innerHTML='<div style="text-align:center;padding:20px"><div class="spinner"></div></div>';
  apiGet('/api/notion/search?q='+encodeURIComponent(q.value.trim())).then(function(r){
    if(r&&r.error){res.innerHTML='<div class="card" style="color:var(--red);padding:14px">'+esc(r.error)+'</div>';return}
    var pages=r.pages||[];
    if(pages.length===0){res.innerHTML='<div class="card" style="text-align:center;color:var(--dim);padding:20px">No results for "'+esc(q.value)+'"</div>';return}
    var h='';pages.forEach(function(p){h+='<div class="card" style="padding:12px 14px;cursor:pointer" onclick="loadNotionPage(\\x27'+esc(p.id)+'\\x27)"><span style="font-size:14px">'+esc(p.icon||'')+'</span> <span style="font-weight:700">'+esc(p.title)+'</span> <span style="font-size:10px;color:var(--dim)">['+esc(p.type)+'] edited '+esc(p.edited)+'</span></div>'});
    res.innerHTML=h;
  });
}
function loadNotionPage(id){
  var res=document.getElementById('notionResults');res.innerHTML='<div style="text-align:center;padding:20px"><div class="spinner"></div></div>';
  apiGet('/api/notion/page?id='+encodeURIComponent(id)).then(function(r){
    if(r&&r.error){res.innerHTML='<div class="card" style="color:var(--red);padding:14px">'+esc(r.error)+'</div>';return}
    res.innerHTML='<div class="card" style="padding:16px"><div style="font-size:16px;font-weight:700;margin-bottom:12px;color:var(--green)">'+esc(r.title||'Page')+'</div><div style="white-space:pre-wrap;font-size:13px;line-height:1.6">'+esc(r.content||'(empty)')+'</div></div><button onclick="searchNotion()" style="margin-top:8px;background:var(--bg3);color:var(--dim);border:1px solid var(--border);padding:6px 12px;border-radius:var(--r);font-size:11px;cursor:pointer">Back to results</button>';
  });
}

// ---- SLACK ----
var slackData=null;
function renderSlack(el){
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading Slack channels...</div></div>';
  apiGet('/api/slack/channels').then(function(r){
    if(r&&r.error){el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="color:var(--dim);margin-bottom:8px">'+esc(r.error)+'</div><div style="font-size:11px;color:var(--dim)">Run: nha config set slack-token xoxb-YOUR_TOKEN</div></div>';return}
    slackData=r;
    var channels=r.channels||[];
    var h='<div class="section-title">Channels ('+channels.length+')</div>';
    if(channels.length===0){h+='<div class="card" style="text-align:center;color:var(--dim);padding:20px">No channels found</div>'}
    channels.forEach(function(c){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="loadSlackChannel(\\x27'+esc(c.id)+'\\x27,\\x27'+esc(c.name)+'\\x27)"><span style="color:var(--green);font-weight:700">#'+esc(c.name)+'</span> <span style="font-size:10px;color:var(--dim)">'+c.members+' members</span>'+(c.purpose?'<div style="font-size:11px;color:var(--dim);margin-top:2px">'+esc(c.purpose)+'</div>':'')+'</div>'});
    h+='<div id="slackMessages"></div>';
    el.innerHTML=h;
  });
}
function loadSlackChannel(id,name){
  var res=document.getElementById('slackMessages');if(!res)return;
  res.innerHTML='<div style="text-align:center;padding:20px"><div class="spinner"></div><div style="color:var(--dim)">Loading #'+esc(name)+'...</div></div>';
  apiGet('/api/slack/messages?channel='+encodeURIComponent(id)).then(function(r){
    if(r&&r.error){res.innerHTML='<div class="card" style="color:var(--red);padding:14px">'+esc(r.error)+'</div>';return}
    var msgs=r.messages||[];
    var h='<div class="section-title" style="margin-top:16px">#'+esc(name)+' ('+msgs.length+' messages)</div>';
    msgs.forEach(function(m){h+='<div style="padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--cyan);font-size:11px;font-weight:700">'+esc(m.user)+'</span> <span style="font-size:10px;color:var(--dim)">'+esc(m.time)+'</span><div style="font-size:13px;margin-top:2px">'+esc(m.text)+'</div></div>'});
    if(msgs.length===0)h+='<div style="color:var(--dim);padding:16px;text-align:center">No recent messages</div>';
    res.innerHTML=h;
  });
}

// ---- BIRTHDAYS ----
function renderBirthdays(el){
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading birthdays...</div></div>';
  apiGet('/api/birthdays').then(function(r){
    if(r&&r.error){el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="color:var(--dim)">'+esc(r.error)+'</div></div>';return}
    var bdays=r.birthdays||[];
    if(bdays.length===0){el.innerHTML='<div class="card" style="text-align:center;padding:30px;color:var(--dim)">No upcoming birthdays found. Make sure your Google Contacts have birthday info.</div>';return}
    var h='<div class="section-title">Upcoming Birthdays</div>';
    bdays.forEach(function(b){
      var isToday=b.daysUntil===0;
      var label=isToday?'<span style="color:var(--red);font-weight:700">TODAY!</span>':b.daysUntil===1?'<span style="color:var(--amber)">Tomorrow</span>':'<span style="color:var(--dim)">in '+b.daysUntil+' days</span>';
      h+='<div class="card" style="padding:12px 14px'+(isToday?';border-color:var(--red)':'')+'"><span style="font-size:16px">&#127874;</span> <span style="font-weight:700">'+esc(b.name)+'</span> — '+esc(b.date)+' '+label+'</div>';
    });
    el.innerHTML=h;
  });
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
// ---- DRIVE (Full File Manager) ----
var driveData=null;
var driveFilter='';
var driveEditorFile=null; // {id,name,content,mimeType} when editing
var driveViewerFile=null; // {id,name,base64,mimeType} when viewing image/pdf

function renderDrive(el){
  if(!driveData){
    el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading Drive...</div></div>';
    apiGet('/api/drive').then(function(r){driveData=r||{files:[]};renderDrive(el)}).catch(function(){
      el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Could not load Drive. Run <b>nha google revoke</b> then <b>nha google auth</b> to grant Drive permissions.</div>';
    });
    return;
  }

  // If editor is open, render editor instead
  if(driveEditorFile){renderDriveEditor(el);return;}
  // If viewer is open, render viewer
  if(driveViewerFile){renderDriveViewer(el);return;}

  var files=driveData.files||[];
  var quota=driveData.quota;
  var h='';

  // Quota bar
  if(quota){
    h+='<div class="card" style="margin-bottom:12px;padding:12px"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--bright);font-size:12px">'+esc(quota.usage)+' of '+esc(quota.limit)+' used</span><span style="color:var(--dim);font-size:11px">'+quota.percentUsed+'%</span></div>';
    h+='<div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+Math.min(quota.percentUsed,100)+'%;background:'+(quota.percentUsed>90?'var(--red)':quota.percentUsed>70?'var(--amber)':'var(--green)')+';border-radius:3px"></div></div></div>';
  }

  // Action bar
  h+='<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">';
  ['','recent','starred','shared'].forEach(function(f){
    var label=f||'All Files';
    var active=driveFilter===f;
    h+='<button onclick="filterDrive(\\x27'+f+'\\x27)" style="padding:6px 14px;border-radius:6px;font-size:11px;background:'+(active?'var(--green3)':'var(--bg3)')+';color:'+(active?'var(--bg)':'var(--dim)')+';border:1px solid '+(active?'var(--green)':'var(--border)')+';cursor:pointer">'+esc(label.charAt(0).toUpperCase()+label.slice(1))+'</button>';
  });
  h+='<div style="flex:1"></div>';
  h+='<button onclick="driveNewFile()" style="padding:6px 14px;border-radius:6px;font-size:11px;background:var(--green3);color:var(--bg);border:1px solid var(--green);cursor:pointer">+ New File</button>';
  h+='<button onclick="driveUploadFile()" style="padding:6px 14px;border-radius:6px;font-size:11px;background:var(--amberdim);color:var(--amber);border:1px solid var(--amber3);cursor:pointer">Upload</button>';
  h+='</div>';

  // Search bar
  h+='<div style="margin-bottom:12px"><input type="text" id="driveSearch" placeholder="Search files..." style="width:100%;font-size:11px;padding:8px 12px" onkeydown="if(event.key===\\x27Enter\\x27)searchDrive()"></div>';

  // File list
  if(files.length===0){
    h+='<div class="card" style="text-align:center;color:var(--dim);padding:30px">No files found</div>';
  } else {
    files.forEach(function(f){
      var icon=driveTypeIcon(f.type);
      var date=f.modifiedTime?new Date(f.modifiedTime).toLocaleDateString():'';
      var isText=f.type==='text'||f.type==='doc'||f.mimeType.includes('text')||f.mimeType.includes('json')||f.mimeType.includes('javascript')||f.mimeType.includes('xml')||f.mimeType.includes('csv')||f.mimeType.includes('yaml')||f.mimeType.includes('markdown')||f.mimeType.includes('html')||f.mimeType.includes('css')||f.mimeType.includes('python')||f.mimeType.includes('php')||f.mimeType.includes('vnd.google-apps.document');
      var isImage=f.type==='image';
      var isPdf=f.type==='pdf'||f.mimeType.includes('pdf');

      h+='<div class="card" style="margin-bottom:4px;padding:10px">';
      h+='<div style="display:flex;align-items:center;gap:10px">';
      h+='<span style="font-size:18px">'+icon+'</span>';
      h+='<div style="flex:1;min-width:0">';
      h+='<div style="color:var(--bright);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(f.name)+'</div>';
      h+='<div style="color:var(--dim);font-size:10px">'+esc(date)+(f.size?' &middot; '+esc(f.size):'')+(f.shared?' &middot; Shared':'')+(f.starred?' &#9733;':'')+'</div>';
      h+='</div>';
      // Action buttons
      h+='<div style="display:flex;gap:4px;flex-shrink:0">';
      if(isText){
        h+='<button onclick="event.stopPropagation();driveOpenEditor(\\x27'+f.id+'\\x27,\\x27'+esc(f.name).replace(/'/g,'\\x27')+'\\x27)" style="padding:3px 8px;font-size:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--cyan);cursor:pointer" title="Open in editor">Edit</button>';
      }
      if(isImage){
        h+='<button onclick="event.stopPropagation();driveViewImage(\\x27'+f.id+'\\x27,\\x27'+esc(f.name).replace(/'/g,'\\x27')+'\\x27)" style="padding:3px 8px;font-size:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--green);cursor:pointer" title="View image">View</button>';
      }
      if(isPdf){
        h+='<button onclick="event.stopPropagation();driveViewPdf(\\x27'+f.id+'\\x27,\\x27'+esc(f.name).replace(/'/g,'\\x27')+'\\x27)" style="padding:3px 8px;font-size:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--amber);cursor:pointer" title="View PDF">PDF</button>';
      }
      h+='<button onclick="event.stopPropagation();window.open(\\x27'+esc(f.webViewLink)+'\\x27,\\x27_blank\\x27)" style="padding:3px 8px;font-size:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--dim);cursor:pointer" title="Open in Google Drive">Open</button>';
      h+='<button onclick="event.stopPropagation();driveDeleteFile(\\x27'+f.id+'\\x27,\\x27'+esc(f.name).replace(/'/g,'\\x27')+'\\x27)" style="padding:3px 8px;font-size:10px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--red);cursor:pointer;opacity:0.6" title="Delete">Del</button>';
      h+='</div>';
      h+='</div></div>';
    });
  }

  el.innerHTML=h;
}

// ---- Drive Editor (Notepad) ----
function renderDriveEditor(el){
  var f=driveEditorFile;
  var h='<div style="max-width:900px;margin:0 auto">';
  h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
  h+='<button onclick="driveCloseEditor()" style="padding:4px 10px;font-size:11px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--dim);cursor:pointer">&larr; Back</button>';
  h+='<span style="flex:1;font-size:14px;color:var(--bright);font-weight:bold">'+esc(f.name)+'</span>';
  h+='<button onclick="driveSaveEditor()" style="padding:6px 16px;font-size:11px;background:var(--green3);border:1px solid var(--green);border-radius:6px;color:var(--bg);cursor:pointer;font-weight:bold">Save to Drive</button>';
  h+='</div>';
  h+='<textarea id="driveEditorContent" style="width:100%;min-height:500px;background:var(--bg);border:1px solid var(--border2);border-radius:8px;padding:14px;color:var(--fg);font-family:var(--mono);font-size:12px;line-height:1.6;resize:vertical;tab-size:2" spellcheck="false">'+esc(f.content||'')+'</textarea>';
  h+='<div style="color:var(--dim);font-size:10px;margin-top:6px">File ID: '+esc(f.id)+' &middot; Use Tab for indentation &middot; Changes are NOT auto-saved</div>';
  h+='</div>';
  el.innerHTML=h;
  // Enable Tab key in textarea
  var ta=document.getElementById('driveEditorContent');
  if(ta)ta.addEventListener('keydown',function(e){if(e.key==='Tab'){e.preventDefault();var s=this.selectionStart,end=this.selectionEnd;this.value=this.value.substring(0,s)+'  '+this.value.substring(end);this.selectionStart=this.selectionEnd=s+2;}});
}

function driveOpenEditor(fileId,fileName){
  var el=document.getElementById('content');
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading file...</div></div>';
  apiGet('/api/drive/read/'+fileId).then(function(r){
    driveEditorFile={id:fileId,name:fileName,content:r.content||''};
    renderDrive(el);
  }).catch(function(e){
    el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Error reading file: '+esc(e.message||'unknown')+'</div>';
  });
}

function driveSaveEditor(){
  var ta=document.getElementById('driveEditorContent');
  if(!ta||!driveEditorFile)return;
  var content=ta.value;
  if(!confirm('Save changes to "'+driveEditorFile.name+'" on Drive?'))return;
  apiPost('/api/drive/update/'+driveEditorFile.id,{content:content}).then(function(){
    driveEditorFile.content=content;
    alert('Saved!');
  }).catch(function(e){alert('Save failed: '+(e.message||'unknown'));});
}

function driveCloseEditor(){
  driveEditorFile=null;
  renderDrive(document.getElementById('content'));
}

// ---- Drive Image/PDF Viewer ----
function renderDriveViewer(el){
  var f=driveViewerFile;
  var h='<div style="max-width:900px;margin:0 auto">';
  h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
  h+='<button onclick="driveCloseViewer()" style="padding:4px 10px;font-size:11px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--dim);cursor:pointer">&larr; Back</button>';
  h+='<span style="flex:1;font-size:14px;color:var(--bright);font-weight:bold">'+esc(f.name)+'</span>';
  h+='</div>';
  if(f.mimeType&&f.mimeType.includes('image')){
    h+='<img src="data:'+esc(f.mimeType)+';base64,'+f.base64+'" style="max-width:100%;border-radius:8px;border:1px solid var(--border)" alt="'+esc(f.name)+'">';
  } else {
    h+='<iframe src="data:application/pdf;base64,'+f.base64+'" style="width:100%;height:600px;border:1px solid var(--border);border-radius:8px" title="'+esc(f.name)+'"></iframe>';
  }
  h+='</div>';
  el.innerHTML=h;
}

function driveViewImage(fileId,fileName){
  var el=document.getElementById('content');
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading image...</div></div>';
  apiGet('/api/drive/download/'+fileId).then(function(r){
    driveViewerFile={id:fileId,name:fileName,base64:r.base64,mimeType:r.mimeType};
    renderDrive(el);
  }).catch(function(e){el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Error: '+esc(e.message)+'</div>';});
}

function driveViewPdf(fileId,fileName){
  var el=document.getElementById('content');
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading PDF...</div></div>';
  apiGet('/api/drive/download/'+fileId).then(function(r){
    driveViewerFile={id:fileId,name:fileName,base64:r.base64,mimeType:'application/pdf'};
    renderDrive(el);
  }).catch(function(e){el.innerHTML='<div class="card" style="color:var(--red);padding:20px">Error: '+esc(e.message)+'</div>';});
}

function driveCloseViewer(){
  driveViewerFile=null;
  renderDrive(document.getElementById('content'));
}

// ---- Drive Actions ----
function driveNewFile(){
  var name=prompt('File name (e.g. notes.txt, script.py):');
  if(!name)return;
  apiPost('/api/drive/upload',{name:name,content:'',mimeType:'text/plain'}).then(function(r){
    driveData=null;
    driveEditorFile={id:r.id,name:name,content:''};
    renderDrive(document.getElementById('content'));
  }).catch(function(e){alert('Error: '+(e.message||'unknown'));});
}

function driveUploadFile(){
  var inp=document.createElement('input');
  inp.type='file';
  inp.accept='*/*';
  inp.onchange=function(){
    var file=inp.files[0];
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(){
      var base64=reader.result.split(',')[1]||'';
      apiPost('/api/drive/upload',{name:file.name,content:base64,mimeType:file.type||'application/octet-stream',encoding:'base64'}).then(function(){
        driveData=null;
        renderDrive(document.getElementById('content'));
      }).catch(function(e){alert('Upload error: '+(e.message||'unknown'));});
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

function driveDeleteFile(fileId,fileName){
  if(!confirm('Delete "'+fileName+'" from Drive? (moved to trash)'))return;
  apiPost('/api/drive/delete/'+fileId,{}).then(function(){
    driveData=null;
    renderDrive(document.getElementById('content'));
  }).catch(function(e){alert('Delete error: '+(e.message||'unknown'));});
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

// ---- COLLAB (Alexandria) ----
var collabChannels=[];
var collabMessages=[];
var collabActiveChannel=null;
var collabPolling=null;
var collabLastMessageCount=0;
var collabUnreadCount=0;
var collabGlobalPolling=null;

// No client-side polling needed — server pushes via WebSocket
function startCollabGlobalPolling(){
  // Just load channels list once
  apiGet('/api/collab/channels').then(function(r){
    if(r&&r.channels)collabChannels=r.channels;
  }).catch(function(){});
}

function updateCollabBadge(){
  var badge=document.getElementById('collabBadge');
  if(badge){
    if(collabUnreadCount>0){
      badge.textContent=collabUnreadCount>99?'99+':collabUnreadCount;
      badge.style.display='inline-block';
    } else {
      badge.style.display='none';
    }
  }
}

function renderCollabMessages(){
  var el=document.getElementById('collabMessages');if(!el)return;
  if(collabMessages.length===0){el.innerHTML='<div style="text-align:center;color:var(--dim);padding:20px;font-size:11px">No messages yet</div>';return;}
  var h='';
  for(var i=0;i<collabMessages.length;i++){
    var m=collabMessages[i];
    var time=new Date(m.timestamp).toLocaleTimeString();
    var sender=m.senderName||m.senderFingerprint?.slice(0,8)||'Unknown';
    var content=m.content||m.plaintext||'[encrypted]';
    if(m.type==='system'){h+='<div style="text-align:center;color:var(--dim);font-size:10px;margin:4px 0">'+esc(sender)+' joined</div>';continue;}
    h+='<div style="margin-bottom:8px"><span style="font-size:10px;color:var(--dim)">'+time+'</span> <span style="font-size:11px;color:var(--amber);font-weight:600">'+esc(sender)+'</span><div style="font-size:12px;color:var(--fg);margin-top:2px;white-space:pre-wrap">'+esc(content)+'</div></div>';
  }
  el.innerHTML=h;
  el.scrollTop=el.scrollHeight;
}

// Start global polling on page load
setTimeout(startCollabGlobalPolling,2000);

function renderCollab(el){
  var h='<div style="max-width:800px;margin:0 auto;padding:20px">';
  h+='<h2 style="font-family:var(--term);color:var(--amber);font-size:18px;margin-bottom:16px">AgentMessenger — Encrypted Communication</h2>';

  // Channel list
  h+='<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">';
  h+='<button onclick="collabCreateChannel()" style="padding:6px 12px;background:var(--amberdim);border:1px solid var(--amber3);border-radius:6px;color:var(--amber);font-family:var(--mono);font-size:11px;cursor:pointer">+ Create Channel</button>';
  h+='<button onclick="collabJoinChannel()" style="padding:6px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-family:var(--mono);font-size:11px;cursor:pointer">Join Channel</button>';
  h+='<button onclick="publishConversation()" style="padding:6px 12px;background:var(--greendim);border:1px solid var(--green3);border-radius:6px;color:var(--green);font-family:var(--mono);font-size:11px;cursor:pointer">Publish Current Chat</button>';
  h+='</div>';

  // Load channels from server (synced with CLI)
  apiGet('/api/collab/channels').then(function(r){
    if(r&&r.channels){collabChannels=r.channels;renderCollabChannelList();}
  }).catch(function(){});

  h+='<div id="collabChannelList" style="margin-bottom:16px"><div style="color:var(--dim);font-size:11px;padding:8px">Loading channels...</div></div>';

  // Messages area
  h+='<div id="collabMessages" style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;min-height:300px;max-height:500px;overflow-y:auto;padding:12px;margin-bottom:12px">';
  if(!collabActiveChannel){
    h+='<div style="padding:20px">';
    h+='<div style="text-align:center;margin-bottom:20px">';
    h+='<div style="font-size:32px;margin-bottom:8px">🔐</div>';
    h+='<div style="font-family:var(--term);color:var(--amber);font-size:16px;margin-bottom:4px">Alexandria</div>';
    h+='<div style="color:var(--dim);font-size:11px">E2E encrypted messaging for AI agents and teams</div>';
    h+='</div>';
    h+='<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px">';
    h+='<div style="color:var(--amber);font-size:10px;font-family:var(--term);letter-spacing:1px;margin-bottom:8px">HOW TO USE</div>';
    h+='<div style="color:var(--fg);font-size:12px;font-family:var(--mono);margin-bottom:4px"><b>1. Create a channel</b> — Click [+ Create Channel] above. Give it a name.</div>';
    h+='<div style="color:var(--dim);font-size:11px;margin-left:4px;margin-bottom:6px">You get an invite code. Share it with your team or another AI session.</div>';
    h+='<div style="color:var(--fg);font-size:12px;font-family:var(--mono);margin-bottom:4px"><b>2. Others join</b> — They click [Join Channel] and paste the invite code.</div>';
    h+='<div style="color:var(--dim);font-size:11px;margin-left:4px;margin-bottom:6px">Works from this web UI, the Android app, or the CLI.</div>';
    h+='<div style="color:var(--fg);font-size:12px;font-family:var(--mono);margin-bottom:4px"><b>3. Chat encrypted</b> — All messages are E2E encrypted. The server sees only ciphertext.</div>';
    h+='</div>';
    h+='<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px">';
    h+='<div style="color:var(--amber);font-size:10px;font-family:var(--term);letter-spacing:1px;margin-bottom:8px">FROM CLI (same channels)</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;color:var(--cyan);background:var(--bg2);padding:4px 8px;border-radius:4px;margin-bottom:3px">nha collab create &quot;Project X&quot;</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;color:var(--cyan);background:var(--bg2);padding:4px 8px;border-radius:4px;margin-bottom:3px">nha collab join &lt;invite-code&gt;</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;color:var(--cyan);background:var(--bg2);padding:4px 8px;border-radius:4px;margin-bottom:3px">nha collab send &quot;Hello from CLI&quot;</div>';
    h+='<div style="font-family:var(--mono);font-size:11px;color:var(--cyan);background:var(--bg2);padding:4px 8px;border-radius:4px">nha collab read</div>';
    h+='</div>';
    h+='<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px">';
    h+='<div style="color:var(--amber);font-size:10px;font-family:var(--term);letter-spacing:1px;margin-bottom:8px">USE CASES</div>';
    h+='<div style="color:var(--dim);font-size:11px;font-family:var(--mono);line-height:18px">';
    h+='• Two Claude Code instances sharing context in real-time<br>';
    h+='• Team sharing AI analysis privately (security audits, code reviews)<br>';
    h+='• Coordinating deployments between AI agents<br>';
    h+='• Security briefings with auto-delete TTL</div>';
    h+='</div>';
    h+='</div>';
  }
  h+='</div>';

  // Send bar
  h+='<div style="display:flex;gap:8px">';
  h+='<input id="collabInput" placeholder="Type encrypted message..." style="flex:1;padding:8px 12px;background:var(--bg);border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-family:var(--mono);font-size:12px" onkeydown="if(event.key===\\x27Enter\\x27)collabSend()">';
  h+='<button onclick="collabSend()" style="padding:8px 16px;background:var(--amberdim);border:1px solid var(--amber3);border-radius:6px;color:var(--amber);font-family:var(--mono);font-size:11px;cursor:pointer">Send</button>';
  h+='</div>';

  h+='</div>';
  el.innerHTML=h;

  if(collabActiveChannel)collabLoadMessages();
}

function renderCollabChannelList(){
  var el=document.getElementById('collabChannelList');if(!el)return;
  if(collabChannels.length===0){el.innerHTML='<div style="color:var(--dim);font-size:11px;padding:8px">No channels yet — click [+ Create Channel] to start, or [Join Channel] to enter an invite code.</div>';return;}
  var h='';
  for(var i=0;i<collabChannels.length;i++){
    var ch=collabChannels[i];
    var active=collabActiveChannel===ch.id;
    h+='<div onclick="collabSelect(\\x27'+ch.id+'\\x27)" style="padding:8px 12px;cursor:pointer;border-left:3px solid '+(active?'var(--amber)':'transparent')+';background:'+(active?'var(--bg2)':'transparent')+';margin-bottom:2px;border-radius:0 6px 6px 0">';
    h+='<span style="font-size:12px;color:var(--fg)">'+esc(ch.name)+'</span>';
    h+='<span onclick="event.stopPropagation();navigator.clipboard.writeText(\\x27'+ch.id+'\\x27);this.textContent=\\x27copied!\\x27;setTimeout(function(){this.textContent=\\x27'+ch.id.slice(0,8)+'...\\x27}.bind(this),1500)" style="font-size:9px;color:var(--dim);margin-left:8px;cursor:pointer" title="Click to copy invite code: '+ch.id+'">'+ch.id.slice(0,8)+'...</span>';
    h+='<button onclick="event.stopPropagation();collabDeleteChannel(\\x27'+ch.id+'\\x27)" style="float:right;background:none;border:none;color:var(--red);cursor:pointer;font-size:10px;font-family:var(--mono);opacity:0.5" title="Delete channel">del</button>';
    h+='</div>';
  }
  el.innerHTML=h;
  if(collabActiveChannel)collabLoadMessages();
}
function collabCreateChannel(){
  var name=prompt('Channel name:');if(!name)return;
  apiPost('/api/collab/create',{name:name}).then(function(r){
    if(r.error){alert(r.error);return;}
    // Save to local file via server
    apiPost('/api/collab/channels',{id:r.id,name:name,role:'creator'}).then(function(){
      collabChannels.push({id:r.id,name:name,role:'creator'});
      collabActiveChannel=r.id;
      prompt('Share this invite code with collaborators:',r.id);
      renderCollabChannelList();
    });
  });
}

function collabJoinChannel(){
  var code=prompt('Invite code:');if(!code)return;
  apiPost('/api/collab/join',{channelId:code}).then(function(r){
    if(r.error){alert(r.error);return;}
    apiPost('/api/collab/channels',{id:code,name:r.name||code.slice(0,8),role:'member'}).then(function(){
      collabChannels.push({id:code,name:r.name||code.slice(0,8),role:'member'});
      collabActiveChannel=code;
      renderCollabChannelList();
    });
  });
}

function collabDeleteChannel(id){
  if(!confirm('Delete this channel? Messages will be lost.'))return;
  collabChannels=collabChannels.filter(function(c){return c.id!==id});
  // Call delete endpoint on local server
  apiPost('/api/collab/delete',{channelId:id}).catch(function(){});
  if(collabActiveChannel===id){collabActiveChannel=null;if(collabPolling)clearInterval(collabPolling);}
  renderCollabChannelList();
  var msgEl=document.getElementById('collabMessages');
  if(msgEl)msgEl.innerHTML='<div style="text-align:center;color:var(--dim);padding:40px;font-size:12px">Channel deleted</div>';
}
function collabSelect(id){
  collabActiveChannel=id;
  collabLoadMessages();
  // No polling — messages arrive via WebSocket in real-time
  if(collabPolling)clearInterval(collabPolling);
  collabPolling=null;
}

function collabLoadMessages(){
  if(!collabActiveChannel)return;
  collabUnreadCount=0;
  updateCollabBadge();
  apiGet('/api/collab/messages?channelId='+collabActiveChannel).then(function(r){
    if(r&&r.error){
      var el=document.getElementById('collabMessages');
      if(el)el.innerHTML='<div style="text-align:center;color:var(--red);padding:20px;font-size:11px">'+esc(r.error)+'<br><span style="color:var(--dim);font-size:10px">This channel may have expired or the server was restarted.<br>Delete it and create a new one.</span></div>';
      // Stop any polling for this dead channel
      if(collabPolling){clearInterval(collabPolling);collabPolling=null;}
      return;
    }
    if(!r||!r.messages)return;
    collabMessages=r.messages;
    var ch=collabChannels.find(function(c){return c.id===collabActiveChannel});
    if(ch)ch._lastCount=r.messages.length;
    renderCollabMessages();
  }).catch(function(e){
    var el=document.getElementById('collabMessages');
    if(el)el.innerHTML='<div style="text-align:center;color:var(--red);padding:20px;font-size:11px">Connection error</div>';
  });
}

function collabSend(){
  var inp=document.getElementById('collabInput');if(!inp)return;
  var msg=inp.value.trim();if(!msg||!collabActiveChannel)return;
  inp.value='';
  apiPost('/api/collab/send',{channelId:collabActiveChannel,message:msg}).then(function(r){
    if(r.error){alert(r.error);return;}
    // Message will arrive via WebSocket — no need to reload
  });
}

function publishConversation(){
  if(!activeConvId||chatHistory.length===0){alert('No conversation to publish. Open a chat first.');return;}
  var title=prompt('Title for the published conversation:');if(!title)return;
  var desc=prompt('Short description (optional):','');
  apiPost('/api/collab/publish',{conversationId:activeConvId,title:title,description:desc||''}).then(function(r){
    if(r.error){alert('Error: '+r.error);return;}
    alert('Published on Alexandria!\\nURL: https://nothumanallowed.com/alexandria/'+r.id+'\\nMessages: '+r.messageCount);
  });
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

  h+='<div style="margin-bottom:10px"><button class="btn btn--primary" style="font-size:11px" onclick="showCreateAgentForm()">+ Create Agent</button></div>';
  h+='<div class="agents-grid">';
  filtered.forEach(function(a){
    var name=a.name||a.agentName;
    var display=a.displayName||name;
    var icon=AGENT_ICONS[name.toLowerCase()]||'\\u{1F916}';
    var desc=AGENT_DESCRIPTIONS[name.toLowerCase()]||a.tagline||a.description||'';
    var isCustom=a.category==='custom';
    h+='<div class="card agent-card" style="position:relative">'+
      '<div style="flex:1;cursor:pointer" onclick="openAgent(\\''+esc(name)+'\\',\\''+esc(display)+'\\')">'+
      '<div style="display:flex;align-items:center;gap:8px">'+
      '<div class="agent-card__icon">'+icon+'</div>'+
      '<div class="agent-card__body"><div class="agent-card__name">'+esc(display)+'</div>'+
      '<div class="agent-card__tagline">'+esc(desc)+'</div></div>'+
      '</div></div>'+
      '<div style="display:flex;gap:4px;flex-shrink:0">'+
      '<button onclick="editAgent(\\''+esc(name)+'\\')" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px" title="Edit">\\u{270F}\\u{FE0F}</button>'+
      '<button onclick="deleteAgent(\\''+esc(name)+'\\')" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px;color:#f44" title="Delete">\\u{1F5D1}</button>'+
      '</div>'+
    '</div>';
  });
  h+='</div>';
  el.innerHTML=h;
}
var agentFilter=null;

function showCreateAgentForm(){
  var name=prompt('Agent name (lowercase, no spaces):');
  if(!name)return;
  name=name.toLowerCase().replace(/[^a-z0-9_-]/g,'');
  if(!name)return;
  var tagline=prompt('Tagline (short description):');
  if(!tagline)return;
  var sysPrompt=prompt('System prompt (agent personality & instructions):');
  if(!sysPrompt)return;
  apiPost('/api/agents',{name:name,tagline:tagline,systemPrompt:sysPrompt}).then(function(r){
    if(r&&r.ok){showToast('success','Agent Created',name.toUpperCase()+' is ready to use');loadAgents().then(function(){renderAgents(document.getElementById('content'))});}
    else{alert('Error: '+(r&&r.error||'Unknown'));}
  });
}

function editAgent(name){
  fetch('/api/agents/'+name).then(function(r){return r.json()}).then(function(data){
    var newTagline=prompt('Tagline:',data.tagline||'');
    if(newTagline===null)return;
    var newPrompt=prompt('System prompt:',data.systemPrompt||'');
    if(newPrompt===null)return;
    fetch('/api/agents/'+name,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({tagline:newTagline,systemPrompt:newPrompt,category:data.category||'custom'})}).then(function(r){return r.json()}).then(function(r){
      if(r&&r.ok){showToast('success','Agent Updated',name.toUpperCase()+' updated');loadAgents().then(function(){renderAgents(document.getElementById('content'))});}
      else{alert('Error: '+(r&&r.error||'Unknown'));}
    });
  });
}

function deleteAgent(name){
  if(!confirm('Delete agent "'+name+'"? This cannot be undone.'))return;
  fetch('/api/agents/'+name,{method:'DELETE'}).then(function(r){return r.json()}).then(function(r){
    if(r&&r.ok){showToast('success','Agent Deleted',name+' removed');loadAgents().then(function(){renderAgents(document.getElementById('content'))});}
    else{alert('Error: '+(r&&r.error||'Unknown'));}
  });
}

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
    '<div style="padding:12px 16px;margin-bottom:16px;background:var(--amberdim);border:1px solid var(--amber3);border-radius:8px"><span style="font-family:var(--term);color:var(--amber);font-size:13px;font-weight:700">NHA Free (Liara)</span><div style="font-size:11px;color:var(--dim);margin:4px 0 8px">Powered by Qwen3 32B. Free, no API key needed. Slower (5-15s).</div><button onclick="apiPost(\\x27/api/config\\x27,{key:\\x27provider\\x27,value:\\x27nha\\x27}).then(function(){location.reload()})" style="padding:6px 16px;background:var(--amber3);color:var(--bg);border:none;border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:11px;font-weight:700">Use NHA Free</button></div>' +
    settingsSection('llm', 'LLM Provider', 'Or use your own API key for faster, more capable responses.', [
      ['provider', 'Provider', 'nha (free) / anthropic / openai / gemini / deepseek / grok / mistral'],
      ['key', 'API Key', 'Not needed for NHA Free', true],
      ['model', 'Model', 'Leave empty for default'],
      ['thinking', 'Extended Thinking', 'on / off — Qwen3 reasoning mode (NHA Free only)'],
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
    '<div class="card" style="margin-top:16px"><div class="card__title">Google Account</div>' +
    '<div style="font-size:11px;color:var(--dim);margin-bottom:8px">Connect Gmail, Calendar, Drive, Contacts, and Tasks. Opens a browser window for Google sign-in.</div>' +
    (settingsData.hasGoogle ? '<div style="color:var(--green);font-size:12px;margin-bottom:8px">\\u2705 Connected</div>' : '') +
    '<button onclick="connectGoogle()" style="background:var(--green3);color:var(--bg);padding:8px 20px;border-radius:var(--r);font-weight:700;font-size:12px;cursor:pointer;border:none">' + (settingsData.hasGoogle ? 'Reconnect Google' : 'Connect Google') + '</button>' +
    '<div id="googleStatus" style="margin-top:8px;font-size:10px;color:var(--dim)"></div>' +
    '</div>' +
  '</div>';
}

function connectGoogle() {
  var s = document.getElementById('googleStatus');
  if (s) s.textContent = 'Starting Google sign-in...';
  apiPost('/api/google/auth', {}).then(function(r) {
    if (s) s.textContent = r.message || 'Check the browser window that opened.';
    if (s) s.style.color = 'var(--green)';
  }).catch(function(e) {
    if (s) { s.textContent = 'Error: ' + e.message; s.style.color = 'var(--red)'; }
  });
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
      '<label style="display:block;font-size:11px;color:var(--dim);margin-bottom:3px">' + esc(label) + '</label>';

    if (key === 'provider') {
      // Dropdown for provider selection
      var providers = [
        {value:'nha',label:'NHA Free (Liara) — no API key needed'},
        {value:'anthropic',label:'Anthropic (Claude)'},
        {value:'openai',label:'OpenAI (GPT-4)'},
        {value:'gemini',label:'Google (Gemini)'},
        {value:'deepseek',label:'DeepSeek'},
        {value:'grok',label:'xAI (Grok)'},
        {value:'mistral',label:'Mistral'},
        {value:'cohere',label:'Cohere'},
      ];
      h += '<select style="width:100%;padding:8px 12px;font-size:13px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:var(--r)" data-config-key="provider" data-section="' + esc(id) + '">';
      for (var pi=0;pi<providers.length;pi++) {
        var sel = currentVal === providers[pi].value ? ' selected' : '';
        h += '<option value="' + providers[pi].value + '"' + sel + '>' + providers[pi].label + '</option>';
      }
      h += '</select>';
    } else if (key === 'thinking') {
      // Dropdown for thinking toggle
      h += '<select style="width:100%;padding:8px 12px;font-size:13px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:var(--r)" data-config-key="thinking" data-section="' + esc(id) + '">' +
        '<option value="off"' + (currentVal !== 'on' ? ' selected' : '') + '>Off — faster responses</option>' +
        '<option value="on"' + (currentVal === 'on' ? ' selected' : '') + '>On — extended reasoning (NHA Free only)</option>' +
      '</select>';
    } else {
      h += '<input type="' + (isSecret ? 'password' : 'text') + '" ' +
        'value="' + esc(currentVal) + '" ' +
        'placeholder="' + esc(placeholder) + '" ' +
        'style="width:100%;padding:8px 12px;font-size:13px" ' +
        'data-config-key="' + esc(key) + '" ' +
        'data-section="' + esc(id) + '">';
    }

    h += '</div>';
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
  var inputs = document.querySelectorAll('input[data-section="' + sectionId + '"], select[data-section="' + sectionId + '"]');
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
var wsMaxRetries = 1;
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
      }, 3000); // 3s between retries
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

    case 'collab_message':
      // Real-time Alexandria message via WebSocket
      var cm = msg.message;
      if (cm) {
        // Add to messages if viewing this channel
        if (currentView === 'collab' && collabActiveChannel === msg.channelId) {
          // Avoid duplicates
          var isDup = collabMessages.some(function(m) { return m.timestamp === cm.timestamp && m.content === cm.content; });
          if (!isDup) {
            collabMessages.push({senderName: cm.senderName, timestamp: cm.timestamp, content: cm.content, type: cm.type});
            renderCollabMessages();
          }
        } else {
          // Not viewing this channel — show badge + toast
          collabUnreadCount++;
          updateCollabBadge();
          showToast('collab', 'AgentMessenger', cm.senderName + ': ' + (cm.content || '').slice(0, 100), 5000);
        }
      }
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
      <div style="display:flex;align-items:center;gap:8px">
        <div class="sidebar__brand-name">NHA</div>
        <span id="wsIndicator" style="color:var(--dim);font-size:8px" title="Daemon WebSocket">&#9679;</span>
        <span style="font-size:9px;color:var(--dim)">v${VERSION}</span>
      </div>
      <div id="sidebarPageTitle" style="font-size:11px;color:var(--bright);margin-top:4px;font-weight:600">Dashboard</div>
      <div class="sidebar__brand-sub" id="clock"></div>
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
      <div class="sidebar__label">Integrations</div>
      <div class="nav-item" data-view="github" onclick="switchView('github')"><span class="nav-item__icon">&#128736;</span> GitHub</div>
      <div class="nav-item" data-view="notion" onclick="switchView('notion')"><span class="nav-item__icon">&#128214;</span> Notion</div>
      <div class="nav-item" data-view="slack" onclick="switchView('slack')"><span class="nav-item__icon">&#128488;</span> Slack</div>
      <div class="nav-item" data-view="birthdays" onclick="switchView('birthdays')"><span class="nav-item__icon">&#127874;</span> Birthdays</div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">AI</div>
      <div class="nav-item" data-view="agents" onclick="switchView('agents')"><span class="nav-item__icon">&#129302;</span> Agents</div>
      <div class="nav-item" data-view="collab" onclick="switchView('collab')"><span class="nav-item__icon">&#128274;</span> AgentMessenger <span id="collabBadge" style="display:none;background:var(--red);color:#fff;font-size:9px;padding:1px 5px;border-radius:8px;margin-left:4px;font-family:var(--mono)">0</span></div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">Config</div>
      <div class="nav-item" data-view="settings" onclick="switchView('settings')"><span class="nav-item__icon">&#9881;</span> Settings</div>
    </div>
    <div class="sidebar__section">
      <div class="sidebar__label">Help</div>
      <a href="https://nothumanallowed.com/docs" target="_blank" class="nav-item" style="text-decoration:none"><span class="nav-item__icon">&#128214;</span> Documentation</a>
      <a href="https://nothumanallowed.com/docs/agents" target="_blank" class="nav-item" style="text-decoration:none"><span class="nav-item__icon">&#129302;</span> Agents Guide</a>
      <a href="https://nothumanallowed.com/docs/mobile" target="_blank" class="nav-item" style="text-decoration:none"><span class="nav-item__icon">&#128241;</span> Mobile App</a>
    </div>
    <div style="padding:12px 16px;margin-top:auto;border-top:1px solid var(--border);font-size:10px;color:var(--dim)">nothumanallowed.com</div>
  </nav>

  <button onclick="openSidebar()" style="position:fixed;top:8px;left:8px;z-index:100;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);color:var(--green);font-size:20px;padding:4px 10px;cursor:pointer;line-height:1" id="mobileBurger">&#9776;</button>

  <div class="content" id="content"></div>

  <div class="browser-viewer" id="browserViewer">
    <div class="browser-viewer__header">
      <span class="browser-viewer__dot"></span>
      <span class="browser-viewer__title" id="bvTitle">Browser</span>
      <button class="browser-viewer__close" onclick="closeBrowserViewer()">&times;</button>
    </div>
    <div class="browser-viewer__frame" id="bvFrame">
      <span style="color:var(--dim);font-size:11px">Waiting...</span>
    </div>
    <div class="browser-viewer__status" id="bvStatus">Idle</div>
  </div>
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

<div id="canvasPanel"><div class="cvs-header"><div style="display:flex;align-items:center;gap:8px"><button id="canvasTabC" onclick="canvasShowCanvas()" style="background:none;border:none;border-bottom:2px solid var(--green);color:var(--green);cursor:pointer;font-family:var(--mono);font-size:11px;padding:2px 6px">Canvas</button><button id="canvasTabB" onclick="canvasShowBrowser()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-family:var(--mono);font-size:11px;padding:2px 6px">Browser</button><span id="canvasTitle" style="font-family:var(--mono);color:var(--green);font-size:11px;margin-left:8px">Canvas</span></div><div style="display:flex;align-items:center;gap:4px"><span id="canvasNav" style="display:none;gap:4px"><button onclick="canvasPrev()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Previous">&#x25C0;</button><button onclick="canvasNext()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Next">&#x25B6;</button></span><button onclick="canvasCopyText()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy text content">Copy</button><button onclick="canvasCopyHTML()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy HTML source">HTML</button><button onclick="canvasCopyImage()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy as image">IMG</button><button onclick="toggleCanvasSize()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Resize">&#x2922;</button><button onclick="closeCanvas()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Close">&times;</button></div></div><iframe id="canvasFrame" sandbox="allow-scripts" srcdoc=""></iframe></div>
<script>${JS}</script>
</body>
</html>`;
}
