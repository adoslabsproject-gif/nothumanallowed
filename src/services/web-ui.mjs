/**
 * Web UI v2 — Rewritten from scratch. Mobile-first. BEM CSS. No escape hell.
 */

import { VERSION } from '../constants.mjs';

// JS bundle — served as /nha-ui.js to avoid browser SyntaxError from large inline scripts
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

// ---- MARKDOWN RENDERER ----
// Minimal inline markdown → HTML, no deps, safe (no innerHTML injection)
function renderMd(raw) {
  if (!raw) return '';
  var s = raw;
  // Escape HTML first (safe base)
  s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Fenced code blocks (triple-backtick) — use RegExp() to avoid backtick in template literal
  var BT = String.fromCharCode(96);
  var reTriple = new RegExp(BT+BT+BT+'[a-z]*[\\s\\S]*?'+BT+BT+BT,'g');
  var reSingle = new RegExp(BT+'([^'+BT+']{1,200})'+BT,'g');
  s = s.replace(reTriple, function(m){
    var inner=m.replace(new RegExp(BT+BT+BT+'[a-z]*'),'').replace(new RegExp(BT+BT+BT),'');
    return '<pre class="md-code"><code>'+inner+'</code></pre>';
  });
  // Inline code (single backtick)
  s = s.replace(reSingle,'<code class="md-inline-code">$1</code>');
  // Bold and italic — use [*] to avoid both /* */ comment ambiguity and \* escape issues
  s = s.replace(new RegExp('[*][*]([^*]+)[*][*]','g'),'<strong>$1</strong>');
  s = s.replace(new RegExp('[*]([^*]+)[*]','g'),'<em>$1</em>');
  // Strikethrough ~~text~~
  s = s.replace(/~~([^~]+)~~/g,'<del>$1</del>');
  // Split into lines for block-level parsing — use fromCharCode to avoid template literal newline
  var NL = String.fromCharCode(10);
  var lines = s.split(NL);
  var out = [];
  var inUl = false, inOl = false, inPre = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    // Already inside pre block
    if (l.indexOf('<pre class="md-code">') !== -1) { inPre = true; }
    if (inPre) { out.push(l); if (l.indexOf('</pre>') !== -1) inPre = false; continue; }
    // H1-H3
    var hm = l.match(/^(#{1,3}) (.+)/);
    if (hm) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      var hl = hm[1].length;
      out.push('<h'+hl+' class="md-h'+hl+'">'+hm[2]+'</h'+hl+'>');
      continue;
    }
    // Horizontal rule ---
    if (/^---+$/.test(l.trim())) {
      out.push('<hr class="md-hr">');
      continue;
    }
    // Unordered list: - item or * item
    var ulm = l.match(/^(\s*)[*\-] (.+)/);
    if (ulm) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul class="md-ul">'); inUl = true; }
      out.push('<li>'+ulm[2]+'</li>');
      continue;
    }
    // Ordered list: 1. item
    var olm = l.match(/^(\s*)\d+\. (.+)/);
    if (olm) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol class="md-ol">'); inOl = true; }
      out.push('<li>'+olm[2]+'</li>');
      continue;
    }
    // Close lists on blank or non-list line
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
    // Markdown table: line starting with | and containing at least two |
    if (l.charAt(0) === '|' && l.lastIndexOf('|') > 0) {
      // Separator row (---|---) — skip, handled via <thead>
      if (/^\|[\s\-|:]+\|$/.test(l.trim())) continue;
      var cells = l.split('|').slice(1,-1).map(function(c){ return c.trim(); });
      // Check if next line is a separator → this is a header row
      var nextL = lines[i+1] ? lines[i+1].trim() : '';
      var isHeader = /^\|[\s\-|:]+\|$/.test(nextL);
      if (isHeader) {
        out.push('<table class="md-table"><thead><tr>' + cells.map(function(c){ return '<th>'+c+'</th>'; }).join('') + '</tr></thead><tbody>');
      } else {
        // Check if we need to open tbody (no header case)
        var prevOut = out[out.length-1] || '';
        if (prevOut.indexOf('<tbody>') === -1 && prevOut.indexOf('<tr>') === -1) {
          out.push('<table class="md-table"><tbody>');
        }
        out.push('<tr>' + cells.map(function(c){ return '<td>'+c+'</td>'; }).join('') + '</tr>');
        // Close table if next line is not a table row
        var nextL2 = lines[i+1] ? lines[i+1].trim() : '';
        if (!nextL2 || nextL2.charAt(0) !== '|') { out.push('</tbody></table>'); }
      }
      continue;
    }
    // Close open table if we hit a non-table line
    var lastOut = out[out.length-1] || '';
    if (lastOut.indexOf('<tr>') !== -1 && lastOut.indexOf('</table>') === -1) {
      out.push('</tbody></table>');
    }
    // Blockquote > text
    var bqm = l.match(/^&gt; (.+)/);
    if (bqm) { out.push('<blockquote class="md-bq">'+bqm[1]+'</blockquote>'); continue; }
    // Blank line → paragraph break
    if (l.trim() === '') { out.push('<div class="md-spacer"></div>'); continue; }
    // Regular paragraph line
    out.push('<p class="md-p">'+l+'</p>');
  }
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');
  return out.join('');
}

// ---- DRAG-TO-MOVE for floating panels ----
function makeDraggable(el, handleSelector) {
  var handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) handle = el;
  var ox=0,oy=0,sx=0,sy=0,dragging=false;
  handle.style.cursor='grab';
  handle.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    // Clear transform first so getBoundingClientRect gives the real rendered position
    el.style.transform = '';
    if (el.dataset) el.dataset.expanded = '';
    el.style.width = el.style.width || '';
    el.style.height = el.style.height || '';
    var rect = el.getBoundingClientRect();
    // Switch from CSS right/top to explicit left/top
    el.style.right = 'auto';
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    ox = rect.left; oy = rect.top;
    handle.style.cursor='grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    var nx = ox+dx, ny = oy+dy;
    // Clamp to viewport
    nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, nx));
    ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
    el.style.left = nx+'px'; el.style.top = ny+'px';
  });
  document.addEventListener('mouseup', function() {
    if (dragging) { dragging=false; handle.style.cursor='grab'; }
  });
}

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

function openLightbox(src){
  var o=document.getElementById('lightboxOverlay');
  var img=document.getElementById('lightboxImg');
  if(!o||!img||!src)return;
  img.src=src;
  o.classList.add('lightbox-overlay--open');
  document.addEventListener('keydown',function handler(e){if(e.key==='Escape'){closeLightbox();document.removeEventListener('keydown',handler);}});
}
function closeLightbox(){
  var o=document.getElementById('lightboxOverlay');
  if(o)o.classList.remove('lightbox-overlay--open');
}

function loadConvList(){return apiGet('/api/conversations').then(function(r){convList=(r&&r.conversations)||[];renderConvSidebar();})}
function loadConv(id){return apiGet('/api/conversations/'+id).then(function(r){if(r&&r.conversation){activeConvId=r.conversation.id;chatHistory=r.conversation.messages||[];renderMessages();renderConvSidebar();onConversationSwitch();}})}
function createNewConv(){return apiPost('/api/conversations',{}).then(function(r){if(r&&r.conversation){activeConvId=r.conversation.id;chatHistory=[];renderMessages();loadConvList();}})}
function deleteConv(id){return fetch(API+'/api/conversations/'+id,{method:'DELETE'}).then(function(){loadConvList();if(id===activeConvId)createNewConv();})}
function clearChatHistory(){createNewConv()}
var agentsList = [];
var selectedAgent = null;
var agentChatHistory = []; // [{role:'user'|'agent', text:'...'}]

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
  var spt=document.getElementById('sidebarPageTitle');
  if(spt)spt.textContent=t('nav_'+v)||v;
  // Toggle content--chat class for proper chat layout (no overflow, flex column)
  var ct=document.getElementById('content');
  if(ct){if(v==='chat'){ct.classList.add('content--chat')}else{ct.classList.remove('content--chat')}}
  closeSidebar();
  // Auto-close floating panels when leaving chat/studio
  if(v!=='chat'&&v!=='studio'){closeBrowserViewer();closeCanvas();}
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
function apiPost(p,b,m){return fetch(API+p,{method:m||'POST',headers:{'Content-Type':'application/json'},body:b!=null?JSON.stringify(b):undefined}).then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t||r.status)});return r.text().then(function(t){try{return JSON.parse(t)}catch(e){return null}})})}
function apiPatch(p){return fetch(API+p,{method:'PATCH'}).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}

// ---- LOAD DATA ----
function loadDash(){
  // Load each API independently  -  render as each arrives (emails are slow)
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
    case 'studio':renderStudio(el);break;
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
          '<button onclick="toggleConvSidebar()" style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);cursor:pointer;font-size:11px;color:var(--green);padding:4px 10px;display:flex;align-items:center;gap:4px;font-family:var(--font)" title="Toggle conversations">&#128172; <span>Chats</span></button>'+
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
    el.innerHTML='<div class="chat__empty"><div class="chat__empty-title">NHA Chat</div><div>Personal Operations Assistant  -  Streaming + Web Search + Browser</div><div class="chat__empty-hint">Try: Show my unread emails / Search the web for React 19 / Open google.com and take a screenshot</div></div>';
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
      // Inline cards  -  rendered as embedded HTML inside the message
      raw=raw.replace(/\\[INLINE_CARD\\]([\\s\\S]*?)\\[\\/INLINE_CARD\\]/g,function(_,html){return '<div class="inline-card">'+html+'</div>';});
      // Inline browser frame  -  rendered as embedded image inside the message
      raw=raw.replace(/\\[INLINE_BROWSER\\]([^|]+)\\|([^\\]]+)\\[\\/INLINE_BROWSER\\]/g,function(_,file,url){return '<div class="inline-browser"><div class="inline-browser-bar"><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-url">'+esc(url)+'</span></div><img src="/api/screenshots/'+esc(file)+'" alt="'+esc(url)+'" onclick="openLightbox(this.src)" style="cursor:zoom-in"></div>';});
      // Handle screenshot file markers
      var sm=raw.match(/\\[SCREENSHOT_FILE\\](.*?)\\[\\/SCREENSHOT_FILE\\]/);
      if(sm){var fn=sm[1].split('/').pop();raw=raw.replace(/\\[SCREENSHOT_FILE\\].*?\\[\\/SCREENSHOT_FILE\\]/,'');raw='![Screenshot](/api/screenshots/'+fn+')\\n'+raw;}
    }
    var imgs=[];var idx=0;
    var safe=raw.replace(/!\\[([^\\]]*)\\]\\((\\/api\\/screenshots\\/[a-zA-Z0-9._-]+)\\)/g,function(_,alt,src){var ph='__IMG'+idx+'__';imgs.push({ph:ph,alt:alt,src:src});idx++;return ph;});
    // Assistant messages get markdown rendering; user messages get plain escape
    var content=isA?renderMd(safe):esc(safe);
    for(var i=0;i<imgs.length;i++){content=content.replace(imgs[i].ph,'<img class="screenshot-preview" alt="'+esc(imgs[i].alt)+'" src="'+imgs[i].src+'" onclick="openLightbox(this.src)">');}
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
      inlineBlock=m.inlineHtml.replace(/\\[INLINE_CARD\\]([\\s\\S]*?)\\[\\/INLINE_CARD\\]/g,function(_,htm){return '<div class="inline-card">'+htm+'</div>';}).replace(/\\[INLINE_BROWSER\\]([^|]+)\\|([^\\]]+)\\[\\/INLINE_BROWSER\\]/g,function(_,file,url){return '<div class="inline-browser"><div class="inline-browser-bar"><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-dot"></span><span class="inline-browser-url">'+esc(url)+'</span></div><img src="/api/screenshots/'+esc(file)+'" alt="'+esc(url)+'" onclick="openLightbox(this.src)" style="cursor:zoom-in"></div>';});
    }
    var isStreaming=isA&&(m.content==='Thinking...'||m.content==='');
    var bubbleCls=isA?'msg__bubble md-body':'msg__bubble';
    var displayContent=isStreaming?'<div class="typing-dots"><span></span><span></span><span></span></div>':content;
    var streamCls=isStreaming?' msg--streaming':'';
    h+='<div class="msg msg--'+esc(m.role)+streamCls+'"><div class="msg__label">'+esc(m.role==='user'?'You':'NHA')+'</div><div class="'+bubbleCls+'">'+displayContent+'</div>'+inlineBlock+acts+'</div>';
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
      document.getElementById('chatAttachName').textContent='[file] '+file.name+' ('+Math.round(file.size/1024)+' KB)';
    };
    reader.readAsDataURL(file);
  }else{
    var reader=new FileReader();
    reader.onload=function(e){
      chatAttachedFile={name:file.name,size:file.size,content:e.target.result};
      chatAttachedImage=null;
      document.getElementById('chatAttachInfo').style.display='';
      document.getElementById('chatAttachName').textContent='[file] '+file.name+' ('+Math.round(file.size/1024)+' KB)';
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
    document.getElementById('chatAttachName').textContent='[img] '+file.name+' ('+Math.round(file.size/1024)+' KB)';
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
  // Nav arrows  -  only for canvas mode (browser uses gallery grid)
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
  // Called when user switches conversation  -  update canvas panel
  var p=document.getElementById('canvasPanel');
  if(p&&p.classList.contains('open')){
    var d=getConvCanvasData();
    canvasIdx=d.canvases.length-1;
    browserIdx=d.browsers.length-1;
    renderCanvasPanel();
  }
}

function openCanvasPanel(){
  var cp = document.getElementById('canvasPanel');
  if (!cp) return;
  cp.classList.add('open');
  // If no canvas data, show a tip in the frame area
  if (!studioState.canvas) {
    var cf = document.getElementById('canvasFrame');
    if (cf) {
      var tip = \x27<!DOCTYPE html><html><body style="background:#0a0a0a;color:#6b7280;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:20px"><div><div style="font-size:32px;margin-bottom:16px">&#9632;</div><div style="font-size:13px;line-height:1.6">Nessun Canvas in questo workflow.<br>Aggiungi <strong style=\x22color:#4ade80\x22>html</strong>, <strong style=\x22color:#4ade80\x22>dashboard</strong> o <strong style=\x22color:#4ade80\x22>visual</strong> al prompt,<br>oppure usa un task con 2+ agenti specialisti.</div></div></body></html>\x27;
      cf.srcdoc = tip;
    }
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
  if(p.dataset.expanded==='1'){
    p.dataset.expanded='';
    // Reset to CSS default: fixed position top-right
    p.style.width='';p.style.height='';
    p.style.top='60px';p.style.right='12px';
    p.style.left='';p.style.transform='';
  } else {
    p.dataset.expanded='1';
    p.style.width='80vw';p.style.height='80vh';
    p.style.top='10vh';p.style.left='50%';p.style.right='auto';
    p.style.transform='translateX(-50%)';
  }
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
  // Mark that we're editing  -  sendChat will handle truncation
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

  // Handle edit mode  -  truncate history to edit point before adding
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
    if(!response.ok||!response.body||typeof response.body.getReader!=='function'){
      // Fallback for browsers without ReadableStream support  -  use non-streaming endpoint
      chatHistory[streamIdx].content='Thinking...';renderMessages();
      apiPost('/api/chat',{message:msg,history:allHistory,conversationId:activeConvId,isRetry:isRetry}).then(function(r){
        chatHistory[streamIdx].content=(r&&r.response)||(r&&r.error?'Error: '+r.error:'Error: no response');
        endStreaming();renderMessages();loadConvList();
      });
      return;
    }
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
                if(el){var msgs=el.querySelectorAll('.msg');var last=msgs[msgs.length-1];if(last){last.classList.add('msg--streaming');var bub=last.querySelector('.msg__bubble');if(bub){bub.className='msg__bubble md-body';var renderedContent=isThinking?displayContent:renderMd(displayContent);bub.innerHTML=renderedContent||'<div class="typing-dots"><span></span><span></span><span></span></div>';}}el.scrollTop=el.scrollHeight;}
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
                // Canvas content arrived  -  render it immediately
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
  // Optimistic UI  -  update instantly, sync in background
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
  if(e.length===0){el.innerHTML='<div class="card" style="text-align:center;color:var(--dim);padding:30px">Inbox zero  -  no emails</div>';return}
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
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d,i){
    var isWe=i>=5;
    h+='<div style="text-align:center;font-size:10px;color:'+(isWe?'var(--red)':'var(--dim)')+';padding:4px;font-weight:'+(isWe?'600':'400')+'">'+d+'</div>';
  });
  h+='</div>';

  // Calendar grid  -  square cells
  h+='<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">';
  // Empty cells before first day
  for(var i=0;i<startDay;i++){
    var isWeCol=i>=5;
    h+='<div style="aspect-ratio:1;background:'+(isWeCol?'rgba(255,80,80,0.04)':'var(--bg)')+';border-radius:6px"></div>';
  }
  // Day cells
  for(var d=1;d<=daysInMonth;d++){
    var key=calKey(calYear,calMonth,d);
    var today=isToday(calYear,calMonth,d);
    var evts=calEventsCache[key]||[];
    var count=evts.length;
    var dayOfWeek=(startDay+d-1)%7; // 0=Mon … 5=Sat, 6=Sun
    var isWeekend=dayOfWeek>=5;
    var hasHoliday=evts.some(function(e){return e._isHoliday||e.readOnly});
    var bg=today?'var(--greendim)':isWeekend?'rgba(255,80,80,0.06)':'var(--bg2)';
    var bdr=today?'var(--green3)':hasHoliday?'var(--red)':count>0?'var(--amber)':'var(--border)';
    var numColor=today?'var(--green)':isWeekend?'var(--red)':'var(--text)';
    h+='<div onclick="openDayDetail(\\x27'+key+'\\x27)" style="aspect-ratio:1;background:'+bg+';border:1px solid '+bdr+';border-radius:6px;padding:6px;cursor:pointer;display:flex;flex-direction:column;overflow:hidden">';
    h+='<div style="font-size:14px;font-weight:'+(today?'800':'500')+';color:'+numColor+'">'+d+'</div>';
    if(count>0){
      h+='<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;min-height:0">';
      evts.slice(0,2).forEach(function(x){
        var evtColor=x._isHoliday||x.readOnly?'var(--red)':'var(--amber)';
        h+='<div style="font-size:8px;color:'+evtColor+';overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:var(--bg3);border-radius:2px;padding:1px 3px">'+esc(x.summary)+'</div>';
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
  var monthKey=calYear+'-'+String(calMonth+1).padStart(2,'0');
  // Check if already loaded
  var daysInMonth=new Date(calYear,calMonth+1,0).getDate();
  var allLoaded=true;
  for(var d=1;d<=daysInMonth;d++){if(!calEventsCache[calKey(calYear,calMonth,d)]){allLoaded=false;break}}
  if(allLoaded){var li=document.getElementById('calLoading');if(li)li.style.display='none';return;}

  apiGet('/api/calendar?month='+monthKey).then(function(r){
    if(r&&r.byDate){
      // Fill all days — ensure days with no events get empty array so we don't re-fetch
      for(var d=1;d<=daysInMonth;d++){
        var k=calKey(calYear,calMonth,d);
        calEventsCache[k]=r.byDate[k]||[];
      }
    }
    var li=document.getElementById('calLoading');if(li)li.style.display='none';
    renderCalendar(document.getElementById('content'));
  }).catch(function(){
    var li=document.getElementById('calLoading');if(li)li.style.display='none';
  });
}

function calPrev(){calMonth--;if(calMonth<0){calMonth=11;calYear--}renderCalendar(document.getElementById('content'))}
function calNext(){calMonth++;if(calMonth>11){calMonth=0;calYear++}renderCalendar(document.getElementById('content'))}

var _calDayEvts=[];
var _calDayStr='';
function openDayDetail(dateStr){
  var evts=calEventsCache[dateStr]||[];
  _calDayEvts=evts;
  _calDayStr=dateStr;
  var dayLabel=new Date(dateStr+'T12:00:00').toLocaleDateString('en',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

  function buildDayHtml(){
    var h='<h2 style="color:var(--green);margin-bottom:4px">'+esc(dayLabel)+'</h2>';
    h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
    h+='<span style="color:var(--dim);font-size:11px">'+dateStr+'</span>';
    h+='<button onclick="openEventForm(null,_calDayStr)" style="margin-left:auto;background:var(--green3);color:var(--bg);padding:5px 12px;border-radius:var(--r);font-size:12px;font-weight:700">+ Add Event</button>';
    h+='</div>';
    if(evts.length===0){
      h+='<div style="color:var(--dim);padding:20px;text-align:center">No events on this day</div>';
    } else {
      evts.forEach(function(x,idx){
        var timeStr=x.isAllDay?'All day':fmtTime(x.start)+' - '+fmtTime(x.end);
        var calId=x.calendarId||'primary';
        h+='<div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px;background:var(--bg3)">';
        h+='<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px">';
        h+='<div style="flex:1"><div style="color:var(--amber);font-weight:700;font-size:13px;margin-bottom:4px">'+esc(timeStr)+'</div>';
        h+='<div style="color:var(--bright);font-size:15px;font-weight:700;margin-bottom:6px">'+esc(x.summary)+'</div></div>';
        if(x.id&&!x.readOnly){
          h+='<div style="display:flex;gap:4px;flex-shrink:0">';
          h+='<button onclick="openEventFormByIdx('+idx+')" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:3px 8px;border-radius:4px;font-size:11px">Edit</button>';
          h+='<button onclick="deleteCalEventByIdx('+idx+')" style="background:var(--bg2);border:1px solid var(--red);color:var(--red);padding:3px 8px;border-radius:4px;font-size:11px">Delete</button>';
          h+='</div>';
        }
        if(x.readOnly){
          h+='<span style="font-size:9px;color:var(--dim);flex-shrink:0;padding-top:2px">read-only</span>';
        }
        h+='</div>';
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
    return h;
  }

  selectedAgent=null;
  agentChatHistory=[];
  document.getElementById('modalName').textContent=dayLabel;
  document.getElementById('modalAgentDesc').textContent='';
  var msgEl=document.getElementById('agentMessages');
  if(msgEl){msgEl.innerHTML='<div id="dayDetailBody" class="agent-chat__bubble agent-chat__bubble--agent md-body" style="width:100%;max-width:100%;box-sizing:border-box">'+buildDayHtml()+'</div>';}
  var footer=document.querySelector('.agent-chat__footer');
  if(footer)footer.style.display='none';
  document.getElementById('agentModal').classList.add('modal-overlay--open');
}

function refreshDayDetail(dateStr){
  delete calEventsCache[dateStr];
  apiGet('/api/calendar?date='+dateStr).then(function(r){
    calEventsCache[dateStr]=(r&&r.events)||[];
    openDayDetail(dateStr);
    renderCalendar(document.getElementById('content'));
  });
}

function deleteCalEvent(calId,eventId,dateStr){
  if(!confirm('Delete this event?'))return;
  apiPost('/api/calendar/'+encodeURIComponent(calId)+'/'+encodeURIComponent(eventId),{},'DELETE').then(function(){
    refreshDayDetail(dateStr);
  }).catch(function(e){alert('Error: '+e.message);});
}
function deleteCalEventByIdx(idx){
  var x=_calDayEvts[idx];if(!x)return;
  var calId=x.calendarId||'primary';
  deleteCalEvent(calId,x.id,_calDayStr);
}
function openEventFormByIdx(idx){
  var x=_calDayEvts[idx];if(!x)return;
  var calId=x.calendarId||'primary';
  openEventForm({id:x.id,calId:calId,summary:x.summary,description:x.description||'',location:x.location||'',start:x.start,end:x.end,isAllDay:x.isAllDay},_calDayStr);
}

function openEventForm(evt,dateStr){
  var isEdit=evt&&evt.id;
  var defDate=dateStr||new Date().toISOString().split('T')[0];
  var defStart=evt&&evt.start?evt.start:defDate+'T09:00';
  var defEnd=evt&&evt.end?evt.end:defDate+'T10:00';
  if(defStart.length>16)defStart=defStart.slice(0,16);
  if(defEnd.length>16)defEnd=defEnd.slice(0,16);

  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  var card=document.createElement('div');
  card.style.cssText='background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:24px;width:420px;max-width:95vw;max-height:90vh;overflow-y:auto';
  card.innerHTML='<div style="font-size:16px;font-weight:700;color:var(--bright);margin-bottom:16px">'+(isEdit?'Edit Event':'New Event')+'</div>'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Title *</label>'+
    '<input id="evtTitle" type="text" value="'+esc(evt&&evt.summary||'')+'" placeholder="Event title" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:12px;font-size:13px">'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Start</label>'+
    '<input id="evtStart" type="datetime-local" value="'+esc(defStart)+'" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:12px;font-size:13px">'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">End</label>'+
    '<input id="evtEnd" type="datetime-local" value="'+esc(defEnd)+'" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:12px;font-size:13px">'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Location</label>'+
    '<input id="evtLoc" type="text" value="'+esc(evt&&evt.location||'')+'" placeholder="Optional" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:12px;font-size:13px">'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Description</label>'+
    '<textarea id="evtDesc" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:16px;font-size:13px;height:70px;resize:vertical">'+esc(evt&&evt.description||'')+'</textarea>'+
    '<div style="display:flex;gap:8px;justify-content:flex-end">'+
    '<button id="evtCancelBtn" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 18px;border-radius:var(--r);font-size:13px">Cancel</button>'+
    '<button id="evtSaveBtn" style="background:var(--green3);color:var(--bg);padding:8px 18px;border-radius:var(--r);font-size:13px;font-weight:700">'+(isEdit?'Save Changes':'Create Event')+'</button>'+
    '</div><div id="evtErr" style="color:var(--red);font-size:12px;margin-top:8px"></div>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector('#evtCancelBtn').onclick=function(){document.body.removeChild(overlay);};
  overlay.onclick=function(e){if(e.target===overlay)document.body.removeChild(overlay);};
  card.querySelector('#evtSaveBtn').onclick=function(){
    var title=card.querySelector('#evtTitle').value.trim();
    if(!title){card.querySelector('#evtErr').textContent='Title is required';return;}
    var startVal=card.querySelector('#evtStart').value;
    var endVal=card.querySelector('#evtEnd').value;
    var loc=card.querySelector('#evtLoc').value.trim();
    var desc=card.querySelector('#evtDesc').value.trim();
    var btn=card.querySelector('#evtSaveBtn');
    btn.textContent='Saving...';btn.disabled=true;
    var promise;
    if(isEdit){
      var calId=evt.calId||'primary';
      var patch={summary:title,start:startVal,end:endVal};
      if(loc)patch.location=loc;
      if(desc)patch.description=desc;
      promise=apiPost('/api/calendar/'+encodeURIComponent(calId)+'/'+encodeURIComponent(evt.id),patch,'PATCH');
    } else {
      promise=apiPost('/api/calendar',{summary:title,start:startVal,end:endVal,location:loc,description:desc,date:dateStr});
    }
    promise.then(function(){
      document.body.removeChild(overlay);
      refreshDayDetail(dateStr);
    }).catch(function(e){
      card.querySelector('#evtErr').textContent='Error: '+(e.message||'Unknown error');
      btn.textContent=isEdit?'Save Changes':'Create Event';btn.disabled=false;
    });
  };
}

// ---- GITHUB ----
var ghData=null;var ghRepo='';
function renderGitHub(el){
  function renderGhData(r){
    var user=r.user||null;
    // Header: user profile + repo input
    var userHtml='';
    if(user&&user.login){
      userHtml='<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;padding:10px 14px;background:var(--bg2);border-radius:var(--r);border:1px solid var(--border)">'+(user.avatar?'<img src="'+esc(user.avatar)+'" style="width:36px;height:36px;border-radius:50%;object-fit:cover" alt="">':'')+'<div style="flex:1"><div style="font-weight:700;font-size:13px;color:var(--green)">@'+esc(user.login)+'</div>'+(user.name?'<div style="font-size:11px;color:var(--dim)">'+esc(user.name)+'</div>':'')+'</div><button onclick="disconnectService(\\x27github-token\\x27,function(el){ghData=null;renderGitHub(el)})" style="background:var(--bg3);border:1px solid var(--red);color:var(--red);padding:4px 10px;border-radius:var(--r);font-size:11px">Disconnect</button></div>';
    }
    var h=userHtml+'<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><input type="text" id="ghRepo" placeholder="owner/repo" value="'+esc(ghRepo)+'" style="flex:1;min-width:180px;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)loadGhIssues()"><button onclick="loadGhIssues()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">Issues</button><button onclick="loadGhPRs()" style="background:var(--cyan);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">PRs</button></div>';
    // My repos as clickable pills
    if(user&&user.repos&&user.repos.length>0){
      h+='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">';
      user.repos.slice(0,12).forEach(function(repo){
        h+='<button onclick="ghRepo=\\x27'+esc(repo.full_name)+'\\x27;document.getElementById(\\x27ghRepo\\x27).value=\\x27'+esc(repo.full_name)+'\\x27;loadGhIssues()" style="background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:11px;color:var(--fg);cursor:pointer;white-space:nowrap" title="'+esc(repo.description)+(repo.open_issues?' | '+repo.open_issues+' open issues':'')+'">'+(repo.private?'&#128274; ':'')+esc(repo.full_name)+(repo.open_issues?'<span style="color:var(--amber);margin-left:4px">'+repo.open_issues+'</span>':'')+'</button>';
      });
      h+='</div>';
    }
    // Notifications
    var notifs=r.notifications||[];
    if(notifs.length>0){
      h+='<div style="display:flex;align-items:center;justify-content:space-between"><div class="section-title">Notifications ('+notifs.length+')</div><button onclick="ghMarkRead()" style="background:var(--bg3);color:var(--dim);border:1px solid var(--border);padding:4px 10px;border-radius:var(--r);font-size:10px;cursor:pointer">Mark all read</button></div>';
      notifs.forEach(function(n){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="window.open(\\x27'+esc(n.url)+'\\x27,\\x27_blank\\x27)"><span style="color:var(--cyan);font-size:11px">'+esc(n.repo)+'</span> <span style="color:var(--dim);font-size:10px">['+esc(n.type)+']</span><div style="font-size:13px;margin-top:2px">'+esc(n.title)+'</div><div style="font-size:10px;color:var(--dim)">'+esc(n.reason)+' &middot; '+esc(n.updated)+'</div></div>'});
    }
    // Issues
    if(r.issues&&r.issues.length>0){
      h+='<div class="section-title">Issues — '+esc(r.repo||ghRepo)+'</div>';
      r.issues.forEach(function(i){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="window.open(\\x27'+esc(i.url)+'\\x27,\\x27_blank\\x27)"><span style="color:var(--green);font-weight:700">#'+i.number+'</span> '+esc(i.title)+(i.assignee?' <span style="font-size:10px;color:var(--cyan)">&#8594; '+esc(i.assignee)+'</span>':'')+(i.labels?'<span style="font-size:9px;color:var(--amber);margin-left:6px">['+esc(i.labels)+']</span>':'')+'<div style="font-size:10px;color:var(--dim)">'+esc(i.updated)+'</div></div>'});
    }
    // PRs
    if(r.prs&&r.prs.length>0){
      h+='<div class="section-title">Pull Requests — '+esc(r.repo||ghRepo)+'</div>';
      r.prs.forEach(function(p){h+='<div class="card" style="padding:10px 14px;cursor:pointer" onclick="window.open(\\x27'+esc(p.url)+'\\x27,\\x27_blank\\x27)"><span style="color:var(--cyan);font-weight:700">#'+p.number+'</span> '+esc(p.title)+' <span style="font-size:10px;color:var(--dim)">by '+esc(p.author)+'</span>'+(p.draft?'<span style="font-size:9px;color:var(--amber)"> DRAFT</span>':'')+'<div style="font-size:10px;color:var(--dim)">'+esc(p.updated)+'</div></div>'});
    }
    if(!notifs.length&&!(r.issues&&r.issues.length)&&!(r.prs&&r.prs.length)){
      h+='<div class="card" style="text-align:center;color:var(--dim);padding:20px">Click a repo above or type owner/repo and click Issues or PRs.</div>';
    }
    el.innerHTML=h;
  }
  if(ghData){renderGhData(ghData);return;}
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading GitHub...</div></div>';
  apiGet('/api/github').then(function(r){
    if(r&&r.error){el.innerHTML='<div class="card" style="text-align:center;padding:30px"><div style="color:var(--dim);margin-bottom:8px">'+esc(r.error)+'</div><div style="font-size:11px;color:var(--dim)">Run: nha config set github-token YOUR_PAT</div></div>';return}
    ghData=r;
    renderGhData(r);
  });
}
function loadGhIssues(){var inp=document.getElementById('ghRepo');if(!inp||!inp.value.trim())return;ghRepo=inp.value.trim();apiPost('/api/config',{key:'github-repo',value:ghRepo}).catch(function(){});var el=document.getElementById('content');el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div></div>';apiGet('/api/github/issues?repo='+encodeURIComponent(ghRepo)).then(function(r){if(ghData){ghData.issues=r.issues||[];ghData.prs=ghData.prs||[];ghData.repo=r.repo}else{ghData={issues:r.issues||[],prs:[],notifications:[]}}renderGitHub(document.getElementById('content'))})}
function loadGhPRs(){var inp=document.getElementById('ghRepo');if(!inp||!inp.value.trim())return;ghRepo=inp.value.trim();var el=document.getElementById('content');el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div></div>';apiGet('/api/github/prs?repo='+encodeURIComponent(ghRepo)).then(function(r){if(ghData){ghData.prs=r.prs||[];ghData.issues=ghData.issues||[];ghData.repo=r.repo}else{ghData={prs:r.prs||[],issues:[],notifications:[]}}renderGitHub(document.getElementById('content'))})}
function ghMarkRead(){apiPost('/api/github/mark-read',{}).then(function(){if(ghData)ghData.notifications=[];renderGitHub(document.getElementById('content'))})}

// ---- NOTION ----
function renderNotion(el){
  apiGet('/api/notion/search?q=').then(function(r){
    var isOk=!(r&&r.error);
    var banner=isOk?'':''+setupBanner('Notion','nha config set notion-token YOUR_INTEGRATION_TOKEN')+'<div style="color:var(--dim);font-size:12px;padding:8px 0">Get an Integration Token from notion.so/my-integrations → New integration → Internal → copy Secret</div>';
    var disconnectBtn=isOk?'<button onclick="disconnectService(\\x27notion-token\\x27,renderNotion)" style="background:var(--bg3);border:1px solid var(--red);color:var(--red);padding:4px 10px;border-radius:var(--r);font-size:11px;margin-bottom:12px">Disconnect Notion</button>':'';
    el.innerHTML=banner+disconnectBtn+'<div style="display:flex;gap:8px;margin-bottom:16px"><input type="text" id="notionQuery" placeholder="Search Notion pages..." style="flex:1;font-size:13px;padding:10px 14px" onkeydown="if(event.key===\\x27Enter\\x27)searchNotion()">'+(isOk?'<button onclick="searchNotion()" style="background:var(--green3);color:var(--bg);padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px">Search</button>':'<button style="background:var(--bg3);color:var(--dim);padding:8px 16px;border-radius:var(--r);font-size:12px" disabled>Search</button>')+'</div><div id="notionResults"></div>';
  }).catch(function(){
    el.innerHTML=setupBanner('Notion','nha config set notion-token YOUR_INTEGRATION_TOKEN')+'<div style="display:flex;gap:8px;margin-bottom:16px"><input type="text" id="notionQuery" placeholder="Search Notion pages..." style="flex:1;font-size:13px;padding:10px 14px"><button style="background:var(--bg3);color:var(--dim);padding:8px 16px;border-radius:var(--r);font-size:12px" disabled>Search</button></div>';
  });
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
function disconnectService(configKey,renderFn){
  if(!confirm('Remove this connection? You can reconnect anytime.'))return;
  apiPost('/api/config',{key:configKey,value:''}).then(function(){
    var el=document.getElementById('content');
    if(el&&renderFn)renderFn(el);
  }).catch(function(){});
}
function setupBanner(service,cmd){return '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:var(--r);margin-bottom:14px;font-size:12px"><span style="font-size:20px">&#128274;</span><div><div style="color:var(--fg);font-weight:600;margin-bottom:2px">'+esc(service)+' not configured</div><div style="color:var(--dim);font-family:var(--mono);font-size:11px">'+esc(cmd)+'</div></div></div>';}
var slackData=null;
function renderSlack(el){
  el.innerHTML='<div style="text-align:center;padding:40px"><div class="spinner"></div><div style="color:var(--dim)">Loading Slack channels...</div></div>';
  apiGet('/api/slack/channels').then(function(r){
    if(r&&r.error){el.innerHTML=setupBanner('Slack','nha config set slack-token xoxb-YOUR_TOKEN')+'<div style="color:var(--dim);font-size:12px;padding:8px 0">Get a Bot Token from api.slack.com/apps → OAuth &amp; Permissions → Bot Token Scopes: channels:read, channels:history, users:read</div>';return}
    slackData=r;
    var channels=r.channels||[];
    var h='<div style="display:flex;align-items:center;margin-bottom:8px"><div class="section-title" style="margin:0;flex:1">Channels ('+channels.length+')</div><button onclick="disconnectService(\\x27slack-token\\x27,renderSlack)" style="background:var(--bg3);border:1px solid var(--red);color:var(--red);padding:4px 10px;border-radius:var(--r);font-size:11px">Disconnect</button></div>';
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
    var h='<div style="display:flex;align-items:center;margin-bottom:12px">';
    h+='<div class="section-title" style="margin:0;flex:1">Upcoming Birthdays</div>';
    h+='<button onclick="openBirthdayForm(null)" style="background:var(--green3);color:var(--bg);padding:5px 14px;border-radius:var(--r);font-size:12px;font-weight:700">+ Add Birthday</button>';
    h+='</div>';
    if(bdays.length===0){
      h+='<div class="card" style="text-align:center;padding:30px;color:var(--dim)">No upcoming birthdays found.<br><span style="font-size:11px">Add one above, or add birthdays to your Google Contacts.</span></div>';
    } else {
      bdays.forEach(function(b){
        var isToday=b.daysUntil===0;
        var label=isToday?'<span style="color:var(--red);font-weight:700">TODAY!</span>':b.daysUntil===1?'<span style="color:var(--amber)">Tomorrow</span>':'<span style="color:var(--dim)">in '+b.daysUntil+' days</span>';
        h+='<div class="card" style="padding:10px 14px;display:flex;align-items:center;gap:8px'+(isToday?';border-color:var(--red)':'')+'"><span style="font-size:18px">&#127874;</span><div style="flex:1"><div style="font-weight:700;font-size:13px">'+esc(b.name)+'</div><div style="font-size:11px;color:var(--dim)">'+esc(b.date)+'</div></div><div style="margin-right:8px">'+label+'</div>';
        if(b.contactId){
          h+='<button onclick="openBirthdayForm('+JSON.stringify({contactId:b.contactId,name:b.name,date:b.date})+')" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:3px 8px;border-radius:4px;font-size:11px">Edit</button>';
          h+='<button onclick="deleteBirthday('+JSON.stringify(b.contactId)+','+JSON.stringify(b.name)+')" style="background:var(--bg3);border:1px solid var(--red);color:var(--red);padding:3px 8px;border-radius:4px;font-size:11px;margin-left:4px">Delete</button>';
        }
        h+='</div>';
      });
    }
    el.innerHTML=h;
  });
}

function openBirthdayForm(b){
  var isEdit=b&&b.contactId;
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  var card=document.createElement('div');
  card.style.cssText='background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:24px;width:360px;max-width:95vw';
  card.innerHTML='<div style="font-size:16px;font-weight:700;color:var(--bright);margin-bottom:16px">'+(isEdit?'Edit Birthday':'Add Birthday')+'</div>'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Name *</label>'+
    '<input id="bdayName" type="text" value="'+esc(b&&b.name||'')+'" placeholder="Contact name" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:12px;font-size:13px">'+
    '<label style="font-size:12px;color:var(--dim);display:block;margin-bottom:4px">Birthday (MM-DD or YYYY-MM-DD)</label>'+
    '<input id="bdayDate" type="text" value="'+esc(b&&b.date||'')+'" placeholder="e.g. 03-15 or 1990-03-15" style="width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:16px;font-size:13px">'+
    '<div style="font-size:11px;color:var(--dim);margin-bottom:16px">Birthday will be saved as a Google Calendar event on the specified date.</div>'+
    '<div style="display:flex;gap:8px;justify-content:flex-end">'+
    '<button id="bdayCancelBtn" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 18px;border-radius:var(--r);font-size:13px">Cancel</button>'+
    '<button id="bdaySaveBtn" style="background:var(--green3);color:var(--bg);padding:8px 18px;border-radius:var(--r);font-size:13px;font-weight:700">'+(isEdit?'Save':'Add')+'</button>'+
    '</div><div id="bdayErr" style="color:var(--red);font-size:12px;margin-top:8px"></div>';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector('#bdayCancelBtn').onclick=function(){document.body.removeChild(overlay);};
  overlay.onclick=function(e){if(e.target===overlay)document.body.removeChild(overlay);};
  card.querySelector('#bdaySaveBtn').onclick=function(){
    var name=card.querySelector('#bdayName').value.trim();
    var date=card.querySelector('#bdayDate').value.trim();
    if(!name){card.querySelector('#bdayErr').textContent='Name is required';return;}
    if(!date){card.querySelector('#bdayErr').textContent='Date is required';return;}
    var btn=card.querySelector('#bdaySaveBtn');
    btn.textContent='Saving...';btn.disabled=true;
    // Parse date into a full date for the calendar event
    var fullDate=date;
    if(/^\d{2}-\d{2}$/.test(date))fullDate=new Date().getFullYear()+'-'+date;
    apiPost('/api/birthdays',{name:name,date:fullDate,contactId:isEdit?b.contactId:null,edit:isEdit}).then(function(){
      document.body.removeChild(overlay);
      renderBirthdays(document.getElementById('content'));
    }).catch(function(e){
      card.querySelector('#bdayErr').textContent='Error: '+(e.message||'Unknown error');
      btn.textContent=isEdit?'Save':'Add';btn.disabled=false;
    });
  };
}

function deleteBirthday(contactId,name){
  if(!confirm('Remove birthday for '+name+'?'))return;
  apiPost('/api/birthdays/delete',{contactId:contactId}).then(function(){
    renderBirthdays(document.getElementById('content'));
  }).catch(function(e){alert('Error: '+e.message);});
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

// No client-side polling needed  -  server pushes via WebSocket
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
  h+='<h2 style="font-family:var(--term);color:var(--amber);font-size:18px;margin-bottom:16px">AgentMessenger  -  Encrypted Communication</h2>';

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
    h+='<div style="font-size:32px;margin-bottom:8px">&#128272;</div>';
    h+='<div style="font-family:var(--term);color:var(--amber);font-size:16px;margin-bottom:4px">Alexandria</div>';
    h+='<div style="color:var(--dim);font-size:11px">E2E encrypted messaging for AI agents and teams</div>';
    h+='</div>';
    h+='<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px">';
    h+='<div style="color:var(--amber);font-size:10px;font-family:var(--term);letter-spacing:1px;margin-bottom:8px">HOW TO USE</div>';
    h+='<div style="color:var(--fg);font-size:12px;font-family:var(--mono);margin-bottom:4px"><b>1. Create a channel</b>  -  Click [+ Create Channel] above. Give it a name.</div>';
    h+='<div style="color:var(--dim);font-size:11px;margin-left:4px;margin-bottom:6px">You get an invite code. Share it with your team or another AI session.</div>';
    h+='<div style="color:var(--fg);font-size:12px;font-family:var(--mono);margin-bottom:4px"><b>2. Others join</b>  -  They click [Join Channel] and paste the invite code.</div>';
    h+='<div style="color:var(--dim);font-size:11px;margin-left:4px;margin-bottom:6px">Works from this web UI, the Android app, or the CLI.</div>';
    h+='<div style="color:var(--fg);font-size:12px;font-family:var(--mono);margin-bottom:4px"><b>3. Chat encrypted</b>  -  All messages are E2E encrypted. The server sees only ciphertext.</div>';
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
    h+='&#8226; Two Claude Code instances sharing context in real-time<br>';
    h+='&#8226; Team sharing AI analysis privately (security audits, code reviews)<br>';
    h+='&#8226; Coordinating deployments between AI agents<br>';
    h+='&#8226; Security briefings with auto-delete TTL</div>';
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
  if(collabChannels.length===0){el.innerHTML='<div style="color:var(--dim);font-size:11px;padding:8px">No channels yet  -  click [+ Create Channel] to start, or [Join Channel] to enter an invite code.</div>';return;}
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
  // No polling  -  messages arrive via WebSocket in real-time
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
    // Message will arrive via WebSocket  -  no need to reload
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

function openAgentEditor(mode, prefill) {
  // mode: 'create' | 'edit'
  var isEdit = mode === 'edit';
  var overlay = document.getElementById('agentEditorOverlay');
  overlay.innerHTML =
    '<div class="modal" style="max-width:560px">' +
      '<div class="modal__header">' +
        '<h2 style="color:var(--green)">'+(isEdit?'\u270F\uFE0F Edit Agent':'\u2795 New Agent')+'</h2>' +
        '<button class="modal__close" onclick="closeAgentEditor()">&times;</button>' +
      '</div>' +
      '<div class="modal__body" style="display:flex;flex-direction:column;gap:12px">' +
        (isEdit ? '' :
          '<div><label style="font-size:11px;color:var(--dim);display:block;margin-bottom:4px">Agent name (lowercase, no spaces)</label>' +
          '<input id="aeNameField" placeholder="my-agent" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px"></div>'
        ) +
        '<div><label style="font-size:11px;color:var(--dim);display:block;margin-bottom:4px">Tagline</label>' +
        '<input id="aeTaglineField" value="'+(prefill&&prefill.tagline?esc(prefill.tagline):'')+'" placeholder="Short description of what this agent does" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:13px"></div>' +
        '<div><label style="font-size:11px;color:var(--dim);display:block;margin-bottom:4px">System Prompt</label>' +
        '<textarea id="aeSysPromptField" placeholder="You are an expert in... Your job is to..." style="width:100%;min-height:160px;padding:10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text);font-size:12px;font-family:var(--mono);resize:vertical">'+(prefill&&prefill.systemPrompt?esc(prefill.systemPrompt):'')+'</textarea></div>' +
        '<div id="aeError" style="color:var(--red);font-size:11px;display:none"></div>' +
      '</div>' +
      '<div class="modal__footer">' +
        '<button class="btn btn--secondary" onclick="closeAgentEditor()">Cancel</button>' +
        '<button class="btn btn--primary" id="aeSubmitBtn" onclick="submitAgentEditor(\\''+mode+'\\',\\''+esc((prefill&&prefill.name)||'')+'\\')">'+(isEdit?'Save Changes':'Create Agent')+'</button>' +
      '</div>' +
    '</div>';
  overlay.style.display='flex';
}

function closeAgentEditor(){
  var overlay=document.getElementById('agentEditorOverlay');
  if(overlay){overlay.style.display='none';overlay.innerHTML='';}
}

function submitAgentEditor(mode, existingName){
  var tagline=(document.getElementById('aeTaglineField')||{}).value||'';
  var sysPrompt=(document.getElementById('aeSysPromptField')||{}).value||'';
  var errEl=document.getElementById('aeError');
  var btn=document.getElementById('aeSubmitBtn');
  if(!tagline.trim()||!sysPrompt.trim()){if(errEl){errEl.textContent='Tagline and system prompt are required.';errEl.style.display='';}return;}

  if(mode==='create'){
    var nameEl=document.getElementById('aeNameField');
    var name=(nameEl?nameEl.value:'').toLowerCase().replace(/[^a-z0-9_-]/g,'');
    if(!name){if(errEl){errEl.textContent='Agent name is required (lowercase, no spaces).';errEl.style.display='';}return;}
    if(btn)btn.disabled=true;
    apiPost('/api/agents',{name:name,tagline:tagline,systemPrompt:sysPrompt}).then(function(r){
      if(r&&r.ok){closeAgentEditor();showToast('success','Agent Created',name.toUpperCase()+' is ready to use');loadAgents().then(function(){renderAgents(document.getElementById('content'));});}
      else{if(errEl){errEl.textContent='Error: '+(r&&r.error||'Unknown');errEl.style.display='';}if(btn)btn.disabled=false;}
    });
  } else {
    if(btn)btn.disabled=true;
    fetch(API+'/api/agents/'+existingName,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({tagline:tagline,systemPrompt:sysPrompt,category:'custom'})}).then(function(r){return r.json();}).then(function(r){
      if(r&&r.ok){closeAgentEditor();showToast('success','Agent Updated',existingName.toUpperCase()+' updated');loadAgents().then(function(){renderAgents(document.getElementById('content'));});}
      else{if(errEl){errEl.textContent='Error: '+(r&&r.error||'Unknown');errEl.style.display='';}if(btn)btn.disabled=false;}
    });
  }
}

function showCreateAgentForm(){
  openAgentEditor('create', null);
}

function editAgent(name){
  fetch(API+'/api/agents/'+name).then(function(r){return r.json();}).then(function(data){
    openAgentEditor('edit', {name:name, tagline:data.tagline||'', systemPrompt:data.systemPrompt||''});
  });
}

function deleteAgent(name){
  // Inline confirm via toast-style overlay
  var overlay=document.getElementById('agentEditorOverlay');
  overlay.innerHTML=
    '<div class="modal" style="max-width:380px">' +
      '<div class="modal__header"><h2 style="color:var(--red)">\u26A0\uFE0F Delete Agent</h2><button class="modal__close" onclick="closeAgentEditor()">&times;</button></div>' +
      '<div class="modal__body"><p style="color:var(--bright);font-size:14px">Delete <strong>'+esc(name)+'</strong>?</p><p style="color:var(--dim);font-size:12px">This cannot be undone.</p></div>' +
      '<div class="modal__footer">' +
        '<button class="btn btn--secondary" onclick="closeAgentEditor()">Cancel</button>' +
        '<button class="btn btn--primary" style="background:var(--red)" onclick="confirmDeleteAgent(\\''+esc(name)+'\\')">Delete</button>' +
      '</div>' +
    '</div>';
  overlay.style.display='flex';
}

function confirmDeleteAgent(name){
  closeAgentEditor();
  fetch(API+'/api/agents/'+name,{method:'DELETE'}).then(function(r){return r.json();}).then(function(r){
    if(r&&r.ok){showToast('success','Agent Deleted',name+' removed');loadAgents().then(function(){renderAgents(document.getElementById('content'));});}
    else{showToast('error','Delete Failed',r&&r.error||'Unknown error');}
  });
}

function renderAgentMessages(){
  var el=document.getElementById('agentMessages');
  if(!el)return;
  if(agentChatHistory.length===0){
    var icon=AGENT_ICONS[selectedAgent]||'\uD83E\uDD16';
    var desc=AGENT_DESCRIPTIONS[selectedAgent]||'';
    el.innerHTML='<div style="text-align:center;padding:24px 8px;color:var(--dim);font-size:12px">'+
      '<div style="font-size:28px;margin-bottom:6px">'+icon+'</div>'+
      '<div style="color:var(--fg);font-weight:600;margin-bottom:4px">'+esc(selectedAgent.toUpperCase())+'</div>'+
      (desc?'<div>'+esc(desc)+'</div>':'')+
    '</div>';
    return;
  }
  el.innerHTML=agentChatHistory.map(function(m){
    var cls='agent-chat__bubble agent-chat__bubble--'+(m.role==='user'?'user':'agent');
    var content;
    if(m.role==='user'){
      content=esc(m.text);
    } else if(m.waiting||(m.streaming&&!m.text)){
      content='<span class="thinking-dots"><span></span><span></span><span></span></span>';
    } else if(m.streaming){
      content=esc(m.text)+'\u258B';
    } else {
      content=renderMd(m.text);
    }
    return '<div class="'+cls+' '+(m.role==='agent'?'md-body':'')+'">'+content+'</div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}

function openAgent(name,display){
  selectedAgent=name;
  agentChatHistory=[];
  attachedFileContent=null;attachedFileName=null;
  var icon=AGENT_ICONS[name.toLowerCase()]||'\u{1F916}';
  var desc=AGENT_DESCRIPTIONS[name.toLowerCase()]||'';
  var nameEl=document.getElementById('modalName');
  nameEl.innerHTML=icon+' <span style="color:var(--green)">'+esc(display||name)+'</span>';
  var subEl=document.getElementById('modalAgentDesc');
  if(subEl){subEl.textContent=desc;}
  document.getElementById('modalPrompt').value='';
  document.getElementById('agentFileInfo').style.display='none';
  document.getElementById('agentFileInput').value='';
  document.getElementById('agentFileDropZone').style.borderColor='';
  var askBtn=document.getElementById('agentAskBtn');
  if(askBtn){askBtn.disabled=false;askBtn.textContent='Send';}
  // Ensure footer is visible (may be hidden from calendar day-detail view)
  var footer=document.querySelector('.agent-chat__footer');
  if(footer)footer.style.display='';
  renderAgentMessages();
  document.getElementById('agentModal').classList.add('modal-overlay--open');
  setTimeout(function(){var i=document.getElementById('modalPrompt');if(i)i.focus();},100);
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
    settingsSection('language', 'Language / Lingua', 'Select the language used by all agents and Studio workflows.', [
      ['lang', 'Language', ''],
    ]) +
    settingsSection('llm', 'LLM Provider', 'Or use your own API key for faster, more capable responses.', [
      ['provider', 'Provider', 'nha (free) / anthropic / openai / gemini / deepseek / grok / mistral'],
      ['key', 'API Key', 'Not needed for NHA Free', true],
      ['model', 'Model', 'Leave empty for default'],
      ['thinking', 'Extended Thinking', 'on / off  -  Qwen3 reasoning mode (NHA Free only)'],
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
        {value:'nha',label:'NHA Free (Liara)  -  no API key needed'},
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
    } else if (key === 'lang') {
      var langs = [
        {value:'it',label:'🇮🇹  Italiano'},
        {value:'en',label:'🇬🇧  English'},
        {value:'es',label:'🇪🇸  Español'},
        {value:'fr',label:'🇫🇷  Français'},
        {value:'de',label:'🇩🇪  Deutsch'},
        {value:'pt',label:'🇵🇹  Português'},
        {value:'nl',label:'🇳🇱  Nederlands'},
        {value:'pl',label:'🇵🇱  Polski'},
        {value:'ru',label:'🇷🇺  Русский'},
        {value:'zh',label:'🇨🇳  中文'},
        {value:'ja',label:'🇯🇵  日本語'},
        {value:'ko',label:'🇰🇷  한국어'},
        {value:'ar',label:'🇸🇦  العربية'},
        {value:'hi',label:'🇮🇳  हिन्दी'},
        {value:'tr',label:'🇹🇷  Türkçe'},
        {value:'sv',label:'🇸🇪  Svenska'},
        {value:'da',label:'🇩🇰  Dansk'},
        {value:'fi',label:'🇫🇮  Suomi'},
        {value:'cs',label:'🇨🇿  Čeština'},
      ];
      var curLang = currentVal || 'it';
      h += '<select style="width:100%;padding:8px 12px;font-size:13px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:var(--r)" data-config-key="lang" data-section="' + esc(id) + '">';
      for (var li=0;li<langs.length;li++) {
        var lsel = curLang === langs[li].value ? ' selected' : '';
        h += '<option value="' + langs[li].value + '"' + lsel + '>' + langs[li].label + '</option>';
      }
      h += '</select>';
    } else if (key === 'thinking') {
      // Dropdown for thinking toggle
      h += '<select style="width:100%;padding:8px 12px;font-size:13px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:var(--r)" data-config-key="thinking" data-section="' + esc(id) + '">' +
        '<option value="off"' + (currentVal !== 'on' ? ' selected' : '') + '>Off  -  faster responses</option>' +
        '<option value="on"' + (currentVal === 'on' ? ' selected' : '') + '>On  -  extended reasoning (NHA Free only)</option>' +
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
        if (sectionId === 'language') {
          var langNames = {it:'Italiano',en:'English',es:'Español',fr:'Français',de:'Deutsch',pt:'Português',nl:'Nederlands',pl:'Polski',ru:'Русский',zh:'中文',ja:'日本語',ko:'한국어',ar:'العربية',hi:'हिन्दी',tr:'Türkçe',sv:'Svenska',da:'Dansk',fi:'Suomi',cs:'Čeština'};
          try {
            var cfg2 = JSON.parse(localStorage.getItem('nha_config_cache') || '{}');
            var ln = langNames[cfg2.lang] || cfg2.lang || 'Italian';
            statusEl.textContent = t('lang_set') + ' ' + ln + '. ' + t('agents_respond') + ' ' + ln + '.';
            // Re-render sidebar and current view in new language
            renderSidebar();
            render();
          } catch(e) { statusEl.textContent = t('saved'); }
        } else {
          statusEl.textContent = 'Saved!';
        }
        statusEl.style.color = 'var(--green)';
      } else {
        statusEl.textContent = 'Some fields failed to save.';
        statusEl.style.color = 'var(--red)';
      }
      setTimeout(function() { statusEl.textContent = ''; }, 4000);
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
  var infoId = document.getElementById('agentFileInfo') ? 'agentFileInfo' : 'fileInfo';
  var dropId = document.getElementById('agentFileDropZone') ? 'agentFileDropZone' : 'fileDropZone';
  var infoEl = document.getElementById(infoId);
  var dropEl = document.getElementById(dropId);
  if (file.size > 500000) {
    if(infoEl){infoEl.style.display='block';infoEl.style.color='var(--red)';infoEl.textContent='File too large (max 500KB)';}
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    attachedFileContent = e.target.result;
    attachedFileName = file.name;
    if(infoEl){infoEl.style.display='block';infoEl.style.color='var(--cyan)';infoEl.textContent='Attached: '+file.name+' ('+(file.size/1024).toFixed(1)+' KB)';}
    if(dropEl){dropEl.style.borderColor='var(--green)';}
  };
  reader.readAsText(file);
}

var agentAbortController = null;

function askAgent(){
  var p=document.getElementById('modalPrompt').value.trim();if(!p||!selectedAgent)return;

  // Add user message to history
  agentChatHistory.push({role:'user',text:p});
  // Add waiting placeholder — shows dots until first token arrives
  agentChatHistory.push({role:'agent',text:'',waiting:true});
  renderAgentMessages();
  document.getElementById('modalPrompt').value='';

  // Abort any previous stream
  if(agentAbortController){try{agentAbortController.abort();}catch(e){}}
  agentAbortController=new AbortController();

  var payload={agent:selectedAgent,prompt:p};
  if(attachedFileContent){payload.fileContent=attachedFileContent;payload.fileName=attachedFileName;}

  // Disable Send button while streaming
  var askBtn=document.getElementById('agentAskBtn');
  if(askBtn){askBtn.disabled=true;askBtn.textContent='...';}

  var agentMsgIdx=agentChatHistory.length-1; // index of the streaming placeholder

  function updateStreamingBubble(text,done){
    agentChatHistory[agentMsgIdx]={role:'agent',text:text,waiting:false,streaming:!done};
    renderAgentMessages();
  }

  fetch(API+'/api/ask/stream',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:agentAbortController.signal
  }).then(function(response){
    var reader=response.body.getReader();
    var decoder=new TextDecoder();
    var buf='';
    var accumulated='';
    function pump(){
      return reader.read().then(function(result){
        if(result.done){
          updateStreamingBubble(accumulated||'(empty response)',true);
          if(askBtn){askBtn.disabled=false;askBtn.textContent='Send';}
          return;
        }
        buf+=decoder.decode(result.value,{stream:true});
        var lines=buf.split(String.fromCharCode(10));
        buf=lines.pop();
        lines.forEach(function(line){
          if(line.indexOf('data: ')!==0)return;
          try{
            var ev=JSON.parse(line.slice(6));
            if(ev.token){accumulated+=ev.token;updateStreamingBubble(accumulated,false);}
            if(ev.done){
              updateStreamingBubble(accumulated||'(empty response)',true);
              if(askBtn){askBtn.disabled=false;askBtn.textContent='Send';}
              attachedFileContent=null;attachedFileName=null;
              document.getElementById('agentFileInfo').style.display='none';
              document.getElementById('agentFileInput').value='';
              document.getElementById('agentFileDropZone').style.borderColor='';
            }
            if(ev.error){
              updateStreamingBubble('\u26a0\ufe0f Error: '+ev.error,true);
              if(askBtn){askBtn.disabled=false;askBtn.textContent='Send';}
            }
          }catch(e){}
        });
        return pump();
      });
    }
    return pump();
  }).catch(function(err){
    if(err.name!=='AbortError'){
      updateStreamingBubble('\u26a0\ufe0f Stream error: '+err.message,true);
    }
    if(askBtn){askBtn.disabled=false;askBtn.textContent='Send';}
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
var wsRetryDelay = 2000; // start at 2s, exponential backoff up to 30s
function connectWebSocket() {
  if (wsReconnectTimer) return; // already scheduled
  try {
    ws = new WebSocket('ws://' + window.location.host);
  } catch(e) { return; }

  ws.onopen = function() {
    wsRetryCount = 0;
    wsRetryDelay = 2000;
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
    if (indicator) { indicator.style.color = 'var(--dim)'; indicator.title = 'Live updates: reconnecting...'; }
    ws = null;
    wsRetryCount++;
    var delay = Math.min(wsRetryDelay * Math.pow(1.5, Math.min(wsRetryCount - 1, 6)), 30000);
    wsRetryDelay = delay;
    wsReconnectTimer = setTimeout(function() {
      wsReconnectTimer = null;
      connectWebSocket();
    }, delay);
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
      showToast('security', 'Security Alert', 'Suspicious: ' + (msg.data.from || '') + '  -  ' + (msg.data.subject || ''), 20000);
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
          // Not viewing this channel  -  show badge + toast
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

// ---- STUDIO ----
// ── i18n — UI string translations ────────────────────────────────────────────
var I18N = {
  en: {
    chat:'Chat', studio:'Studio', settings:'Settings', agents:'Agents',
    run:'▶ Run', stop:'⬛ Stop', reset:'New workflow',
    placeholder_chat:'Message NHA... (Enter to send)',
    placeholder_studio:'Describe what you want to accomplish... (Ctrl+Enter to run)',
    planning:'Planning...', workflow_complete:'Workflow complete.',
    workflow_stopped:'Workflow stopped by user.',
    canvas_open:'Open Canvas', canvas_generated:'HTML Dashboard generated in Canvas panel.',
    saved:'Saved!', lang_set:'Language set to',
    agents_respond:'All agents will respond in',
    examples:'Examples', recent_sessions:'Recent sessions',
    restore:'Restore', delete:'Delete',
    send:'Send', attach:'Attach',
    settings_save:'Save',
    no_output:'(no output)', done:'(done)',
    token_label:'Tokens',
    // Sidebar
    nav_overview:'Overview', nav_google:'Google', nav_microsoft:'Microsoft',
    nav_integrations:'Integrations', nav_ai:'AI', nav_config:'Config', nav_help:'Help',
    nav_dashboard:'Dashboard', nav_chat:'Chat', nav_plan:'Plan', nav_tasks:'Tasks',
    nav_emails:'Emails', nav_calendar:'Calendar', nav_drive:'Drive',
    nav_contacts:'Contacts', nav_notes:'Notes', nav_onedrive:'OneDrive',
    nav_mstodo:'To Do', nav_github:'GitHub', nav_notion:'Notion',
    nav_slack:'Slack', nav_birthdays:'Birthdays', nav_agents:'Agents',
    nav_studio:'Studio', nav_collab:'AgentMessenger', nav_settings:'Settings',
    nav_docs:'Documentation', nav_agents_guide:'Agents Guide', nav_mobile:'Mobile App',
  },
  it: {
    chat:'Chat', studio:'Studio', settings:'Impostazioni', agents:'Agenti',
    run:'▶ Avvia', stop:'⬛ Ferma', reset:'Nuovo workflow',
    placeholder_chat:'Scrivi a NHA... (Invio per inviare)',
    placeholder_studio:'Descrivi cosa vuoi fare... (Ctrl+Invio per avviare)',
    planning:'Pianificazione...', workflow_complete:'Workflow completato.',
    workflow_stopped:'Workflow fermato dall\u2019utente.',
    canvas_open:'Apri Canvas', canvas_generated:'Dashboard HTML generata nel pannello Canvas.',
    saved:'Salvato!', lang_set:'Lingua impostata su',
    agents_respond:'Tutti gli agenti risponderanno in',
    examples:'Esempi', recent_sessions:'Sessioni recenti',
    restore:'Ripristina', delete:'Elimina',
    send:'Invia', attach:'Allega',
    settings_save:'Salva',
    no_output:'(nessun output)', done:'(completato)',
    token_label:'Token',
    // Sidebar
    nav_overview:'Panoramica', nav_google:'Google', nav_microsoft:'Microsoft',
    nav_integrations:'Integrazioni', nav_ai:'AI', nav_config:'Config', nav_help:'Aiuto',
    nav_dashboard:'Dashboard', nav_chat:'Chat', nav_plan:'Piano', nav_tasks:'Attivit\u00e0',
    nav_emails:'Email', nav_calendar:'Calendario', nav_drive:'Drive',
    nav_contacts:'Contatti', nav_notes:'Note', nav_onedrive:'OneDrive',
    nav_mstodo:'To Do', nav_github:'GitHub', nav_notion:'Notion',
    nav_slack:'Slack', nav_birthdays:'Compleanni', nav_agents:'Agenti',
    nav_studio:'Studio', nav_collab:'AgentMessenger', nav_settings:'Impostazioni',
    nav_docs:'Documentazione', nav_agents_guide:'Guida Agenti', nav_mobile:'App Mobile',
  },
  es: {
    chat:'Chat', studio:'Studio', settings:'Configuración', agents:'Agentes',
    run:'▶ Ejecutar', stop:'⬛ Detener', reset:'Nuevo flujo',
    placeholder_chat:'Mensaje a NHA... (Enter para enviar)',
    placeholder_studio:'Describe lo que quieres hacer... (Ctrl+Enter para ejecutar)',
    planning:'Planificando...', workflow_complete:'Flujo completado.',
    workflow_stopped:'Flujo detenido por el usuario.',
    canvas_open:'Abrir Canvas', canvas_generated:'Panel HTML generado en Canvas.',
    saved:'¡Guardado!', lang_set:'Idioma establecido en',
    agents_respond:'Todos los agentes responderán en',
    examples:'Ejemplos', recent_sessions:'Sesiones recientes',
    restore:'Restaurar', delete:'Eliminar',
    send:'Enviar', attach:'Adjuntar',
    settings_save:'Guardar',
    no_output:'(sin salida)', done:'(hecho)',
    token_label:'Tokens',
    nav_overview:'Resumen', nav_google:'Google', nav_microsoft:'Microsoft',
    nav_integrations:'Integraciones', nav_ai:'IA', nav_config:'Config', nav_help:'Ayuda',
    nav_dashboard:'Panel', nav_chat:'Chat', nav_plan:'Plan', nav_tasks:'Tareas',
    nav_emails:'Correos', nav_calendar:'Calendario', nav_drive:'Drive',
    nav_contacts:'Contactos', nav_notes:'Notas', nav_onedrive:'OneDrive',
    nav_mstodo:'Tareas MS', nav_github:'GitHub', nav_notion:'Notion',
    nav_slack:'Slack', nav_birthdays:'Cumplea\u00f1os', nav_agents:'Agentes',
    nav_studio:'Studio', nav_collab:'AgentMessenger', nav_settings:'Configuraci\u00f3n',
    nav_docs:'Documentaci\u00f3n', nav_agents_guide:'Gu\u00eda Agentes', nav_mobile:'App M\u00f3vil',
  },
  fr: {
    chat:'Chat', studio:'Studio', settings:'Paramètres', agents:'Agents',
    run:'▶ Lancer', stop:'⬛ Arrêter', reset:'Nouveau flux',
    placeholder_chat:'Message à NHA... (Entrée pour envoyer)',
    placeholder_studio:'Décrivez ce que vous voulez faire... (Ctrl+Entrée pour lancer)',
    planning:'Planification...', workflow_complete:'Flux terminé.',
    workflow_stopped:'Flux arr\u00eat\u00e9 par l\u2019utilisateur.',
    canvas_open:'Ouvrir Canvas', canvas_generated:'Tableau de bord HTML généré dans Canvas.',
    saved:'Sauvegardé!', lang_set:'Langue définie sur',
    agents_respond:'Tous les agents répondront en',
    examples:'Exemples', recent_sessions:'Sessions récentes',
    restore:'Restaurer', delete:'Supprimer',
    send:'Envoyer', attach:'Joindre',
    settings_save:'Sauvegarder',
    no_output:'(aucune sortie)', done:'(terminé)',
    token_label:'Tokens',
    nav_overview:'Aperçu', nav_google:'Google', nav_microsoft:'Microsoft',
    nav_integrations:'Intégrations', nav_ai:'IA', nav_config:'Config', nav_help:'Aide',
    nav_dashboard:'Tableau de bord', nav_chat:'Chat', nav_plan:'Plan', nav_tasks:'T\u00e2ches',
    nav_emails:'Courriels', nav_calendar:'Calendrier', nav_drive:'Drive',
    nav_contacts:'Contacts', nav_notes:'Notes', nav_onedrive:'OneDrive',
    nav_mstodo:'To Do', nav_github:'GitHub', nav_notion:'Notion',
    nav_slack:'Slack', nav_birthdays:'Anniversaires', nav_agents:'Agents',
    nav_studio:'Studio', nav_collab:'AgentMessenger', nav_settings:'Param\u00e8tres',
    nav_docs:'Documentation', nav_agents_guide:'Guide Agents', nav_mobile:'App Mobile',
  },
  de: {
    chat:'Chat', studio:'Studio', settings:'Einstellungen', agents:'Agenten',
    run:'▶ Starten', stop:'⬛ Stopp', reset:'Neuer Workflow',
    placeholder_chat:'Nachricht an NHA... (Enter zum Senden)',
    placeholder_studio:'Beschreibe was du tun möchtest... (Strg+Enter zum Starten)',
    planning:'Planung...', workflow_complete:'Workflow abgeschlossen.',
    workflow_stopped:'Workflow vom Benutzer gestoppt.',
    canvas_open:'Canvas öffnen', canvas_generated:'HTML-Dashboard im Canvas-Panel generiert.',
    saved:'Gespeichert!', lang_set:'Sprache auf',
    agents_respond:'Alle Agenten antworten auf',
    examples:'Beispiele', recent_sessions:'Letzte Sitzungen',
    restore:'Wiederherstellen', delete:'Löschen',
    send:'Senden', attach:'Anhängen',
    settings_save:'Speichern',
    no_output:'(keine Ausgabe)', done:'(erledigt)',
    token_label:'Token',
    nav_overview:'Übersicht', nav_google:'Google', nav_microsoft:'Microsoft',
    nav_integrations:'Integrationen', nav_ai:'KI', nav_config:'Konfig', nav_help:'Hilfe',
    nav_dashboard:'Dashboard', nav_chat:'Chat', nav_plan:'Plan', nav_tasks:'Aufgaben',
    nav_emails:'E-Mails', nav_calendar:'Kalender', nav_drive:'Drive',
    nav_contacts:'Kontakte', nav_notes:'Notizen', nav_onedrive:'OneDrive',
    nav_mstodo:'To Do', nav_github:'GitHub', nav_notion:'Notion',
    nav_slack:'Slack', nav_birthdays:'Geburtstage', nav_agents:'Agenten',
    nav_studio:'Studio', nav_collab:'AgentMessenger', nav_settings:'Einstellungen',
    nav_docs:'Dokumentation', nav_agents_guide:'Agenten-Leitfaden', nav_mobile:'Mobile App',
  },
};
// Fallback to 'en' for unmapped languages
function t(key) {
  try {
    var cfg = JSON.parse(localStorage.getItem('nha_config_cache') || '{}');
    var lang = (cfg.lang || 'it').slice(0,2);
    var map = I18N[lang] || I18N.en;
    return map[key] || I18N.en[key] || key;
  } catch(e) { return I18N.en[key] || key; }
}

function renderSidebar() {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var activeView = typeof currentView !== \x27undefined\x27 ? currentView : \x27dashboard\x27;
  function ni(view, icon, labelKey, badgeId, badgeStyle, extra) {
    var active = view === activeView ? \x27 nav-item--active\x27 : \x27\x27;
    var badge = badgeId ? \x27<span class="nav-item__badge" id="\x27+badgeId+\x27" style="display:none\x27+(badgeStyle?(\x27;\x27+badgeStyle):\x27\x27)+\x27">0</span>\x27 : \x27\x27;
    var ext = extra || \x27\x27;
    return \x27<div class="nav-item\x27+active+\x27" data-view="\x27+view+\x27" onclick="switchView(\\\x27\x27+view+\x27\\\x27)">\x27+
      \x27<span class="nav-item__icon">\x27+icon+\x27</span> \x27+t(\x27nav_\x27+labelKey)+badge+ext+\x27</div>\x27;
  }
  sb.innerHTML =
    \x27<div class="sidebar__brand">\x27+
      \x27<button class="sidebar__close" onclick="closeSidebar()" title="Close menu">&times;</button>\x27+
      \x27<div style="display:flex;align-items:center;gap:8px">\x27+
        \x27<div class="sidebar__brand-name">NHA</div>\x27+
        \x27<span id="wsIndicator" style="color:var(--dim);font-size:8px" title="Daemon WebSocket">&#9679;</span>\x27+
      \x27</div>\x27+
      \x27<div id="sidebarPageTitle" style="font-size:11px;color:var(--bright);margin-top:4px;font-weight:600">\x27+t(\x27nav_dashboard\x27)+\x27</div>\x27+
      \x27<div class="sidebar__brand-sub" id="clock"></div>\x27+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_overview\x27)+\x27</div>\x27+
      ni(\x27dashboard\x27,\x27&#9632;\x27,\x27dashboard\x27)+
      ni(\x27chat\x27,\x27&#128172;\x27,\x27chat\x27)+
      ni(\x27plan\x27,\x27&#9733;\x27,\x27plan\x27)+
      ni(\x27tasks\x27,\x27&#9745;\x27,\x27tasks\x27,\x27taskBadge\x27)+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_google\x27)+\x27</div>\x27+
      ni(\x27emails\x27,\x27&#128231;\x27,\x27emails\x27,\x27emailBadge\x27)+
      ni(\x27calendar\x27,\x27&#128197;\x27,\x27calendar\x27,\x27calBadge\x27,\x27background:var(--amber)\x27)+
      ni(\x27drive\x27,\x27&#128193;\x27,\x27drive\x27)+
      ni(\x27contacts\x27,\x27&#128101;\x27,\x27contacts\x27)+
      ni(\x27notes\x27,\x27&#128221;\x27,\x27notes\x27)+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_microsoft\x27)+\x27</div>\x27+
      ni(\x27onedrive\x27,\x27&#9729;\x27,\x27onedrive\x27)+
      ni(\x27mstodo\x27,\x27&#128203;\x27,\x27mstodo\x27)+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_integrations\x27)+\x27</div>\x27+
      ni(\x27github\x27,\x27&#128736;\x27,\x27github\x27)+
      ni(\x27notion\x27,\x27&#128214;\x27,\x27notion\x27)+
      ni(\x27slack\x27,\x27&#128488;\x27,\x27slack\x27)+
      ni(\x27birthdays\x27,\x27&#127874;\x27,\x27birthdays\x27)+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_ai\x27)+\x27</div>\x27+
      ni(\x27agents\x27,\x27&#129302;\x27,\x27agents\x27)+
      \x27<div class="nav-item\x27+(activeView===\x27studio\x27?\x27 nav-item--active\x27:\x27\x27)+\x27" data-view="studio" onclick="switchView(\\\x27studio\\\x27)">\x27+
        \x27<span class="nav-item__icon">&#9881;</span> \x27+t(\x27nav_studio\x27)+
        \x27<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(99,102,241,.25);color:var(--green);margin-left:4px;font-weight:700">NEW</span>\x27+
      \x27</div>\x27+
      \x27<div class="nav-item\x27+(activeView===\x27collab\x27?\x27 nav-item--active\x27:\x27\x27)+\x27" data-view="collab" onclick="switchView(\\\x27collab\\\x27)">\x27+
        \x27<span class="nav-item__icon">&#128274;</span> \x27+t(\x27nav_collab\x27)+
        \x27<span id="collabBadge" style="display:none;background:var(--red);color:#fff;font-size:9px;padding:1px 5px;border-radius:8px;margin-left:4px;font-family:var(--mono)">0</span>\x27+
      \x27</div>\x27+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_config\x27)+\x27</div>\x27+
      ni(\x27settings\x27,\x27&#9881;\x27,\x27settings\x27)+
    \x27</div>\x27+
    \x27<div class="sidebar__section">\x27+
      \x27<div class="sidebar__label">\x27+t(\x27nav_help\x27)+\x27</div>\x27+
      \x27<a href="https://nothumanallowed.com/docs" target="_blank" class="nav-item" style="text-decoration:none"><span class="nav-item__icon">&#128214;</span> \x27+t(\x27nav_docs\x27)+\x27</a>\x27+
      \x27<a href="https://nothumanallowed.com/docs/agents" target="_blank" class="nav-item" style="text-decoration:none"><span class="nav-item__icon">&#129302;</span> \x27+t(\x27nav_agents_guide\x27)+\x27</a>\x27+
      \x27<a href="https://nothumanallowed.com/docs/mobile" target="_blank" class="nav-item" style="text-decoration:none"><span class="nav-item__icon">&#128241;</span> \x27+t(\x27nav_mobile\x27)+\x27</a>\x27+
    \x27</div>\x27+
    \x27<div style="padding:12px 16px;margin-top:auto;border-top:1px solid var(--border);font-size:10px;color:var(--dim)">nothumanallowed.com<span style="margin-left:6px;opacity:.5">v${VERSION}</span></div>\x27;
}

var studioState = {
  task: '',
  nodes: [],       // [{icon,agent,label,status:'waiting'|'running'|'done'|'error',output:''}]
  log: [],         // [{agent,icon,text,time,type:'agent'|'system'|'error'}]
  result: '',
  canvas: null,    // HTML canvas content if generated
  running: false,
  planned: false,
  parliamentMode: false
};

var studioAbortController = null;

function stopStudio() {
  if (!studioState.running) return;
  if (studioAbortController) { try { studioAbortController.abort(); } catch(e) {} studioAbortController = null; }
  studioState.running = false;
  var btn = document.getElementById('studioRunBtn');
  if (btn) { btn.disabled = false; btn.textContent = t('run'); }
  var stopBtn = document.getElementById('studioStopBtn');
  if (stopBtn) stopBtn.style.display = 'none';
  studioLog('Studio', '⬛', t('workflow_stopped'), 'system');
  // Mark any still-running nodes as error
  studioState.nodes.forEach(function(n) { if (n.status === 'running') n.status = 'error'; });
  renderStudioNodes();
}

function studioReset() {
  if (studioState.running) return;
  studioState.task = '';
  studioState.nodes = [];
  studioState.log = [];
  studioState.result = '';
  studioState.canvas = null;
  studioState.running = false;
  studioState.planned = false;
  studioState.attachmentContext = '';
  studioState.attachmentName = '';
  studioTokens = {in:0, out:0};
  var nudgeEl = document.getElementById(\x27studioParliamentNudge\x27);
  if (nudgeEl) nudgeEl.remove();
  var ta = document.getElementById('studioTaskInput');
  if (ta) ta.value = '';
  var tb = document.getElementById('studioTokenBar');
  if (tb) tb.textContent = '';
  var inlinePdfBtn = document.getElementById('studioInlinePdfBtn');
  if (inlinePdfBtn) inlinePdfBtn.style.display = 'none';
  renderStudioNodes();
  renderStudioLog();
  renderStudioResult();
}

function studioClearAttach() {
  studioState.attachmentContext = '';
  studioState.attachmentName = '';
  var badge = document.getElementById('studioAttachBadge');
  if (badge) badge.remove();
  var fi = document.getElementById('studioFileInput');
  if (fi) fi.value = '';
}

function studioHandleAttach(file) {
  if (!file) return;
  var name = file.name;
  var isPdf = name.toLowerCase().endsWith('.pdf');
  var isImg = new RegExp('[.](png|jpe?g|gif|webp)$', 'i').test(name);
  if (!isPdf && !isImg) { alert('Supported: PDF, PNG, JPG, GIF, WEBP'); return; }

  var reader = new FileReader();
  reader.onload = function(ev) {
    var dataUrl = ev.target.result;
    studioState.attachmentName = name;
    studioState.attachmentContext = (isPdf ? '[ATTACHED PDF: ' : '[ATTACHED IMAGE: ') + name + ']' + String.fromCharCode(10) + 'Base64: ' + dataUrl;
    // Show badge inline without full re-render
    var inputRow = document.querySelector('.studio-input-row');
    if (inputRow) {
      var existing = document.getElementById('studioAttachBadge');
      if (existing) existing.remove();
      var badge = document.createElement('div');
      badge.id = 'studioAttachBadge';
      badge.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--greendim);border:1px solid var(--green3);border-radius:6px;margin-bottom:6px;font-size:11px;color:var(--green);font-family:var(--mono)';
      badge.innerHTML = '&#128206; ' + esc(name) + ' <span onclick="studioClearAttach()" style="cursor:pointer;color:var(--dim);font-size:13px;margin-left:4px" title="Remove">&#215;</span>';
      inputRow.insertBefore(badge, inputRow.children[1]);
    }
  };
  reader.readAsDataURL(file);
}

var STUDIO_EXAMPLES = [
  'Analyze my unread emails and create a priority action plan',
  'Search the web for AI news today and summarize it in a canvas report',
  'Check my calendar for this week and suggest how to optimize my schedule',
  'Review my GitHub notifications and draft responses to open issues',
  'Search for information about a topic, fact-check it, and write a report'
];

function studioLog(agent, icon, text, type, update) {
  // update=true: update the last log entry for this agent instead of adding a new one
  var time = new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
  if (update && studioState.log.length) {
    var last = studioState.log[studioState.log.length - 1];
    if (last.agent === agent) { last.text = text; last.type = type || last.type; renderStudioLog(); return; }
  }
  studioState.log.push({agent: agent, icon: icon, text: text, time: time, type: type||'agent'});
  renderStudioLog();
}

function renderStudioNodes() {
  var el = document.getElementById('studioNodes');
  if (!el) return;
  if (!studioState.nodes.length) {
    el.innerHTML = '<div class="studio-canvas__empty"><div class="studio-canvas__empty-icon">&#9881;</div><div>Describe a task and click Run</div></div>';
    return;
  }
  var html = '<div class="studio-nodes">';
  studioState.nodes.forEach(function(n, i) {
    var cls = 'studio-node';
    if (n.status === 'running') cls += ' studio-node--active';
    else if (n.status === 'done') cls += ' studio-node--done';
    else if (n.status === 'error') cls += ' studio-node--error';
    var statusLabel = {waiting:'&#9711; wait', running:'&#9654; running', done:'&#10003; done', error:'&#10005; error'}[n.status] || '';
    // Only animate nodes that haven't been rendered yet (first appearance)
    var style = n._rendered ? '' : 'animation-delay:' + (i * 110) + 'ms';
    html += '<div class="' + cls + '" style="' + style + '">';
    html += '<div class="studio-node__circle">' + n.icon + '</div>';
    html += '<div class="studio-node__label">' + esc(n.label) + '</div>';
    html += '<div class="studio-node__status studio-node__status--' + n.status + '">' + statusLabel + '</div>';
    if (n.status === 'running') {
      html += '<div class="studio-node__progress"><span></span><span></span><span></span></div>';
    }
    html += '</div>';
    if (i < studioState.nodes.length - 1) {
      var next = studioState.nodes[i + 1];
      var arrowCls = 'studio-arrow';
      if (n.status === 'done' && next.status === 'running') arrowCls += ' studio-arrow--active';
      else if (n.status === 'done') arrowCls += ' studio-arrow--done';
      var arrowStyle = n._rendered ? '' : 'opacity:0;animation:stNodeIn .3s ease ' + (i * 110 + 55) + 'ms forwards';
      html += '<div class="' + arrowCls + '" style="' + arrowStyle + '">&#8594;</div>';
    }
    n._rendered = true;
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderStudioLog() {
  var el = document.getElementById('studioLog');
  if (!el) return;
  if (!studioState.log.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = studioState.log.map(function(e) {
    var cls = 'studio-log-entry' + (e.type === 'system' ? ' studio-log-entry--system' : e.type === 'error' ? ' studio-log-entry--error' : '');
    return '<div class="' + cls + '">' +
      '<div class="studio-log-entry__header">' +
        '<span class="studio-log-entry__icon">' + e.icon + '</span>' +
        '<span class="studio-log-entry__agent">' + esc(e.agent) + '</span>' +
        '<span class="studio-log-entry__time">' + esc(e.time) + '</span>' +
      '</div>' +
      '<div class="studio-log-entry__text md-body">' + renderMd(e.text) + '</div>' +
    '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

var _downloadPdfLast = 0;
function downloadStudioPDF() {
  var now = Date.now();
  if (now - _downloadPdfLast < 3000) return; // debounce: max 1 download every 3s
  _downloadPdfLast = now;
  var task = studioState.task || 'NHA Studio Report';
  var today = new Date().toLocaleDateString('it-IT', {day:'2-digit',month:'2-digit',year:'numeric'});
  var nodes = studioState.nodes || [];
  var fileName = (task).slice(0, 60).replace(/[^a-z0-9\s]/gi,'').trim().replace(/\s+/g,'-') || 'NHA-Studio';

  // If canvas exists, download the canvas HTML directly (preserves colors and layout)
  if (studioState.canvas) {
    var blob = new Blob([studioState.canvas], {type: 'text/html'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.download = fileName + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
    return;
  }

  // ── Markdown → HTML for PDF (full support: tables, lists, headers, inline) ──
  function mdToPdfHtml(raw) {
    var NL2 = String.fromCharCode(10);
    var lines = raw.split(NL2);
    var out = '';
    var inUl = false, inOl = false, inTable = false, inTbody = false;
    function closeAll() {
      if (inUl) { out += '</ul>'; inUl = false; }
      if (inOl) { out += '</ol>'; inOl = false; }
      if (inTable) { if (inTbody) { out += '</tbody>'; inTbody = false; } out += '</table>'; inTable = false; }
    }
    function inlineFormat(t) {
      t = t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      t = t.replace(new RegExp('[*][*]([^*]+)[*][*]','g'),'<strong>$1</strong>');
      t = t.replace(new RegExp('[*]([^*]+)[*]','g'),'<em>$1</em>');
      t = t.replace(/~~([^~]+)~~/g,'<del>$1</del>');
      return t;
    }
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var trimmed = line.trim();
      // Headers
      if (trimmed.slice(0,4) === '### ') { closeAll(); out += '<h3>' + inlineFormat(trimmed.slice(4)) + '</h3>'; continue; }
      if (trimmed.slice(0,3) === '## ')  { closeAll(); out += '<h2>' + inlineFormat(trimmed.slice(3)) + '</h2>'; continue; }
      if (trimmed.slice(0,2) === '# ')   { closeAll(); out += '<h1>' + inlineFormat(trimmed.slice(2)) + '</h1>'; continue; }
      // Horizontal rule
      if (/^---+$/.test(trimmed)) { closeAll(); out += '<hr>'; continue; }
      // Markdown table
      if (trimmed.charAt(0) === '|' && trimmed.lastIndexOf('|') > 0) {
        // Separator row — signals end of header
        if (/^\|[\s\-|:]+\|$/.test(trimmed)) {
          if (inTable) { out += '</thead><tbody>'; inTbody = true; }
          continue;
        }
        var cells = trimmed.split('|').slice(1,-1).map(function(c){ return inlineFormat(c.trim()); });
        var nextTrimmed = lines[li+1] ? lines[li+1].trim() : '';
        var nextIsSep = /^\|[\s\-|:]+\|$/.test(nextTrimmed);
        if (!inTable) {
          out += '<table>';
          inTable = true;
          if (nextIsSep) { out += '<thead>'; inTbody = false; }
          else { out += '<tbody>'; inTbody = true; }
        }
        var tag = (!inTbody) ? 'th' : 'td';
        out += '<tr>' + cells.map(function(c){ return '<'+tag+'>'+c+'</'+tag+'>'; }).join('') + '</tr>';
        continue;
      }
      // Close table if not a table row
      if (inTable) { if (inTbody) { out += '</tbody>'; inTbody = false; } out += '</table>'; inTable = false; }
      // Unordered list
      if (/^[\-\*] /.test(trimmed)) {
        if (inOl) { out += '</ol>'; inOl = false; }
        if (!inUl) { out += '<ul>'; inUl = true; }
        out += '<li>' + inlineFormat(trimmed.slice(2)) + '</li>';
        continue;
      }
      // Ordered list
      var olMatch = trimmed.match(/^\d+\. (.+)/);
      if (olMatch) {
        if (inUl) { out += '</ul>'; inUl = false; }
        if (!inOl) { out += '<ol>'; inOl = true; }
        out += '<li>' + inlineFormat(olMatch[1]) + '</li>';
        continue;
      }
      // Close lists
      if (inUl) { out += '</ul>'; inUl = false; }
      if (inOl) { out += '</ol>'; inOl = false; }
      // Blank line
      if (trimmed === '') { out += '<div style="height:6px"></div>'; continue; }
      // Paragraph
      out += '<p>' + inlineFormat(trimmed) + '</p>';
    }
    closeAll();
    return out;
  }

  // ── Collect workflow metadata ─────────────────────────────────────────────
  var activeNodes = nodes.filter(function(n){ return n.output && n.output !== '(no output)' && n.agent !== 'CanvasAgent'; });
  var totalTokensIn  = studioTokens ? (studioTokens.in  || 0) : 0;
  var totalTokensOut = studioTokens ? (studioTokens.out || 0) : 0;
  var agentNames = activeNodes.map(function(n){ return (n.icon||'') + ' ' + esc(n.label||n.agent); });
  var nowTime = new Date().toLocaleTimeString('it-IT', {hour:'2-digit',minute:'2-digit'});

  // ── Section HTML ──────────────────────────────────────────────────────────
  var sectionsHtml = activeNodes.map(function(n, idx) {
    var agentColor = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#0284c7'][idx % 7];
    return '<div class="section">' +
      '<div class="agent-header" style="border-left-color:' + agentColor + '">' +
        '<span class="agent-icon">' + (n.icon||'&#9632;') + '</span>' +
        '<div><div class="agent-name">' + esc(n.label||n.agent) + '</div>' +
        '<div class="agent-sub">' + esc(n.agent) + ' &nbsp;&#183;&nbsp; Step ' + (idx+1) + ' di ' + activeNodes.length + '</div></div>' +
      '</div>' +
      '<div class="section-body">' + mdToPdfHtml(n.output) + '</div>' +
    '</div>';
  }).join('');

  // ── Full HTML document ────────────────────────────────────────────────────
  var html = '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>' + esc(task) + '</title>' +
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
  '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:"Inter",system-ui,sans-serif;color:#1e1e2e;background:#fff;font-size:13px;line-height:1.7}' +

    // Cover
    '.cover{background:linear-gradient(135deg,#1e1b4b 0%,#312e81 40%,#1e3a5f 100%);color:#fff;padding:64px 60px 56px;page-break-after:always;position:relative;overflow:hidden}' +
    '.cover::before{content:"";position:absolute;top:-80px;right:-80px;width:360px;height:360px;background:radial-gradient(circle,rgba(99,102,241,.25) 0%,transparent 70%);pointer-events:none}' +
    '.cover-brand{font-size:10px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:32px;display:flex;align-items:center;gap:8px}' +
    '.cover-brand::before{content:"";display:inline-block;width:24px;height:2px;background:#6366f1}' +
    '.cover h1{font-size:30px;font-weight:800;line-height:1.25;color:#fff;margin-bottom:20px;max-width:680px}' +
    '.cover-task-label{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:8px}' +
    '.cover-task{font-size:14px;color:rgba(255,255,255,.8);line-height:1.65;max-width:660px;font-style:italic;padding:14px 18px;background:rgba(255,255,255,.07);border-radius:8px;border-left:3px solid #6366f1}' +

    // Stats bar
    '.cover-stats{display:flex;gap:0;margin-top:40px;border-top:1px solid rgba(255,255,255,.12);padding-top:28px}' +
    '.stat{flex:1;padding-right:28px;border-right:1px solid rgba(255,255,255,.1)}' +
    '.stat:last-child{border-right:none;padding-right:0;padding-left:28px}' +
    '.stat:not(:first-child){padding-left:28px}' +
    '.stat-value{font-size:22px;font-weight:800;color:#fff;line-height:1}' +
    '.stat-label{font-size:10px;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.45);margin-top:5px}' +

    // Workflow bar
    '.workflow-bar{padding:28px 60px;background:#f8f7ff;border-bottom:1px solid #e8e5ff;display:flex;align-items:center;gap:0;flex-wrap:wrap}' +
    '.wf-step{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#4f46e5;white-space:nowrap}' +
    '.wf-arrow{color:#c7c2f0;margin:0 6px;font-size:14px}' +
    '.wf-label{font-size:9px;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;color:#9c97c7;margin-right:16px}' +

    // TOC
    '.toc{padding:36px 60px;border-bottom:1px solid #eee;page-break-after:always}' +
    '.toc-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9ca3af;margin-bottom:18px}' +
    '.toc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}' +
    '.toc-item{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f9f9fc;border-radius:8px;border:1px solid #ede9fe}' +
    '.toc-num{width:22px;height:22px;border-radius:50%;background:#4f46e5;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
    '.toc-name{font-size:12px;font-weight:600;color:#1e1e2e}' +

    // Sections
    '.section{padding:36px 60px;border-bottom:1px solid #f0f0f5;page-break-inside:avoid}' +
    '.section:last-child{border-bottom:none}' +
    '.agent-header{display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-left:14px;border-left:3px solid #4f46e5}' +
    '.agent-icon{font-size:22px;line-height:1}' +
    '.agent-name{font-size:14px;font-weight:700;color:#1e1e2e}' +
    '.agent-sub{font-size:10px;font-weight:500;color:#9ca3af;letter-spacing:.5px;margin-top:2px}' +
    '.section-body{font-size:13px;line-height:1.75;color:#374151}' +
    '.section-body h1{font-size:18px;font-weight:700;color:#1e1e2e;margin:20px 0 10px;border-bottom:1px solid #e5e7eb;padding-bottom:6px}' +
    '.section-body h2{font-size:15px;font-weight:700;color:#1e1e2e;margin:18px 0 8px}' +
    '.section-body h3{font-size:13px;font-weight:600;color:#4f46e5;margin:14px 0 6px}' +
    '.section-body p{margin:0 0 10px}' +
    '.section-body ul{margin:8px 0 10px 18px;list-style:disc}' +
    '.section-body ol{margin:8px 0 10px 18px}' +
    '.section-body li{margin-bottom:4px}' +
    '.section-body strong{font-weight:700;color:#1e1e2e}' +
    '.section-body em{color:#6366f1;font-style:italic}' +
    '.section-body table{width:100%;border-collapse:collapse;margin:14px 0;font-size:12px}' +
    '.section-body th{background:#f0eeff;color:#4f46e5;font-weight:700;text-align:left;padding:8px 12px;border:1px solid #e0d9ff;font-size:11px;letter-spacing:.3px}' +
    '.section-body td{padding:7px 12px;border:1px solid #ede9fe;color:#374151}' +
    '.section-body tr:nth-child(even) td{background:#f9f8ff}' +
    '.section-body hr{border:none;border-top:1px solid #e5e7eb;margin:16px 0}' +
    '.section-body blockquote{border-left:3px solid #6366f1;padding:8px 14px;background:#f5f3ff;border-radius:0 6px 6px 0;color:#4f46e5;font-style:italic;margin:10px 0}' +

    // Footer
    '.footer-bar{padding:18px 60px;background:#f8f7ff;border-top:2px solid #e8e5ff;display:flex;justify-content:space-between;align-items:center}' +
    '.footer-left{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9c97c7}' +
    '.footer-right{font-size:10px;color:#b8b4d4}' +

    '@media print{' +
      'body{-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.cover{page-break-after:always}' +
      '.toc{page-break-after:always}' +
      '.section{page-break-inside:avoid}' +
    '}' +
  '</style></head><body>' +

  // ── Cover ────────────────────────────────────────────────────────────────
  '<div class="cover">' +
    '<div class="cover-brand">NotHumanAllowed &nbsp; NHA Studio</div>' +
    '<h1>' + esc(task.length > 90 ? task.slice(0,90)+'...' : task) + '</h1>' +
    '<div class="cover-task-label">Workflow richiesto</div>' +
    '<div class="cover-task">' + esc(task) + '</div>' +
    '<div class="cover-stats">' +
      '<div class="stat"><div class="stat-value">' + activeNodes.length + '</div><div class="stat-label">Agenti eseguiti</div></div>' +
      '<div class="stat"><div class="stat-value">' + today + '</div><div class="stat-label">Data generazione</div></div>' +
      '<div class="stat"><div class="stat-value">' + nowTime + '</div><div class="stat-label">Ora</div></div>' +
      (totalTokensIn > 0 ? '<div class="stat"><div class="stat-value">' + (totalTokensIn + totalTokensOut).toLocaleString() + '</div><div class="stat-label">Token totali</div></div>' : '') +
    '</div>' +
  '</div>' +

  // ── Workflow bar ─────────────────────────────────────────────────────────
  '<div class="workflow-bar">' +
    '<span class="wf-label">Workflow:</span>' +
    activeNodes.map(function(n, idx){
      return '<span class="wf-step">' + (n.icon||'') + ' ' + esc(n.label||n.agent) + '</span>' +
        (idx < activeNodes.length-1 ? '<span class="wf-arrow">&#8594;</span>' : '');
    }).join('') +
  '</div>' +

  // ── TOC ──────────────────────────────────────────────────────────────────
  '<div class="toc">' +
    '<div class="toc-title">Indice dei contenuti</div>' +
    '<div class="toc-grid">' +
    activeNodes.map(function(n, idx){
      return '<div class="toc-item"><div class="toc-num">' + (idx+1) + '</div><div class="toc-name">' + esc(n.label||n.agent) + '</div></div>';
    }).join('') +
    '</div>' +
  '</div>' +

  // ── Sections ─────────────────────────────────────────────────────────────
  sectionsHtml +

  // ── Footer ───────────────────────────────────────────────────────────────
  '<div class="footer-bar">' +
    '<span class="footer-left">NHA Studio &nbsp;&#183;&nbsp; nothumanallowed.com</span>' +
    '<span class="footer-right">' + today + ' ' + nowTime +
      (totalTokensIn > 0 ? ' &nbsp;&#183;&nbsp; ' + totalTokensIn.toLocaleString() + ' token in / ' + totalTokensOut.toLocaleString() + ' out' : '') +
    '</span>' +
  '</div>' +
  '</body></html>';

  // Use Blob URL to avoid popup blockers — opens in new tab, user can Cmd+P to print as PDF
  var blob = new Blob([html], {type: 'text/html'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.download = (studioState.task || 'NHA Studio Report').slice(0, 60).replace(/[^a-z0-9\s]/gi,'').trim().replace(/\s+/g,'-') + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
}

function renderStudioResult() {
  var el = document.getElementById('studioResult');
  if (!el) return;
  if (!studioState.result) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  var hasCanvas = !!(studioState.canvas);
  var body = hasCanvas
    ? '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="color:var(--dim);font-size:13px">&#10003; ' + t('canvas_generated') + '</span><button onclick="openCanvasPanel()" style="padding:6px 14px;background:var(--greendim);border:1px solid var(--green3);border-radius:8px;color:var(--green);font-size:12px;cursor:pointer;font-weight:700">&#x25A3; ' + t('canvas_open') + '</button></div>'
    : '<div class="md-body">' + renderMd(studioState.result) + '</div>';
  var tokLine = (studioTokens && (studioTokens.in > 0 || studioTokens.out > 0))
    ? '<div style="margin-top:8px;font-size:11px;color:var(--dim);font-family:var(--mono)">&#x2B06; ' + (studioTokens.in||0).toLocaleString() + ' token in &nbsp;&#x2B07; ' + (studioTokens.out||0).toLocaleString() + ' token out &nbsp;&#x2022;&nbsp; <strong style="color:var(--green)">' + ((studioTokens.in||0)+(studioTokens.out||0)).toLocaleString() + '</strong> totale</div>'
    : '';
  var dlBtn = '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
    '<button onclick="downloadStudioPDF()" title="Scarica il workflow come PDF" style="display:inline-flex;align-items:center;gap:6px;padding:8px 18px;background:linear-gradient(135deg,#4f46e5,#2563eb);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.3px;box-shadow:0 2px 8px rgba(79,70,229,.35)">&#x2913; Download PDF</button>' +
    '<span style="font-size:11px;color:var(--dim)">Scarica il workflow completo come documento PDF</span>' +
    '</div>';
  el.innerHTML = '<div class="studio-result__title">&#10003; ' + t('workflow_complete') + '</div>' + body + tokLine + dlBtn;
  // Show/hide inline PDF button in the prompt bar
  var inlinePdfBtn = document.getElementById('studioInlinePdfBtn');
  if (inlinePdfBtn) inlinePdfBtn.style.display = 'inline-flex';
  // Update canvas button style: bright green when canvas exists, dimmed otherwise
  var canvasBtn = document.getElementById('studioCanvasBtn');
  if (canvasBtn) {
    if (hasCanvas) {
      canvasBtn.style.background = 'var(--greendim)';
      canvasBtn.style.borderColor = 'var(--green3)';
      canvasBtn.style.color = 'var(--green)';
      canvasBtn.title = t(\x27canvas_open\x27);
    } else {
      canvasBtn.style.background = \x27none\x27;
      canvasBtn.style.borderColor = \x27var(--border)\x27;
      canvasBtn.style.color = \x27var(--dim)\x27;
      canvasBtn.title = \x27Canvas non disponibile per questo workflow\x27;
    }
  }
}

function studioSetNodeStatus(idx, status) {
  if (studioState.nodes[idx]) {
    studioState.nodes[idx].status = status;
    renderStudioNodes();
  }
}

async function runStudio() {
  var ta = document.getElementById('studioTaskInput');
  var task = ta ? ta.value.trim() : '';
  if (!task || studioState.running) return;

  // Reset state
  studioState.task = task;
  studioState.nodes = [];
  studioState.log = [];
  studioState.result = '';
  studioState.canvas = null;
  studioState.running = true;
  studioState.planned = false;
  // Keep attachmentContext — it was loaded before hitting Run
  renderStudioNodes();
  renderStudioLog();
  renderStudioResult();

  studioAbortController = new AbortController();

  var btn = document.getElementById('studioRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('planning'); }
  var stopBtn = document.getElementById('studioStopBtn');
  if (stopBtn) stopBtn.style.display = '';

  studioLog('Studio', '&#9881;', 'Planning workflow for: "' + task + '"', 'system');
  // Show a temporary planning indicator in the nodes area
  var nodesEl = document.getElementById('studioNodes');
  if (nodesEl) nodesEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--dim);font-size:12px;font-family:var(--font)"><span class="thinking-dots"><span></span><span></span><span></span></span><div style="margin-top:8px">Designing workflow...</div></div>';

  try {
    // Step 1: plan the workflow
    var nl = String.fromCharCode(10);
    var taskForPlan = studioState.attachmentContext
      ? task + nl + nl + '[User has attached a file: ' + studioState.attachmentName + '. Agents will receive the full content.]'
      : task;
    // Include PDF info in plan request so server can add DocumentReaderAgent step
    var planBody = {task: taskForPlan};
    if (studioState.attachmentContext && studioState.attachmentContext.indexOf('[ATTACHED PDF:') === 0) {
      planBody.hasPdf = true;
      planBody.pdfName = studioState.attachmentName || 'document.pdf';
    }
    var planRes = await apiPost('/api/studio/plan', planBody);
    if (!planRes || !planRes.steps || !planRes.steps.length) {
      studioLog('Studio', '&#9888;', 'Could not plan workflow. Check your LLM provider config.', 'error');
      studioState.running = false;
      if (btn) btn.disabled = false;
      return;
    }

    studioState.nodes = planRes.steps.map(function(s) {
      return {icon: s.icon, agent: s.agent, label: s.label, status: 'waiting'};
    });
    renderStudioNodes();
    studioLog('Studio', '&#10003;', 'Workflow planned: ' + planRes.steps.map(function(s){return s.label}).join(' -> '), 'system');

    // Parliament suggestion: show nudge if 3+ specialist steps and Parliament not already enabled
    var specialistAgents = planRes.steps.filter(function(s){ return !['WebSearchAgent','EmailAgent','CalendarAgent','GitHubAgent','SlackAgent','NotionAgent','CanvasAgent','HERALD'].includes(s.agent); });
    var parliamentChkEarly = document.getElementById(\x27studioParliamentMode\x27);
    if (specialistAgents.length >= 2 && parliamentChkEarly && !parliamentChkEarly.checked) {
      var nudge = document.getElementById(\x27studioParliamentNudge\x27);
      if (!nudge) {
        nudge = document.createElement(\x27div\x27);
        nudge.id = \x27studioParliamentNudge\x27;
        nudge.style.cssText = \x27margin:8px 0;padding:8px 12px;background:#1a1a2e;border:1px solid #6366f1;border-radius:8px;font-size:11px;color:#a5b4fc;display:flex;align-items:center;gap:10px\x27;
        nudge.innerHTML = \x27&#x2656; <span><strong>Suggerimento:</strong> questo workflow ha \x27 + specialistAgents.length + \x27 agenti specialisti — attiva <strong>Parlamento</strong> per un confronto critico tra le loro analisi.</span><button onclick="document.getElementById(\\\x27studioParliamentMode\\\x27).checked=true;studioState.parliamentMode=true;this.parentNode.remove()" style="margin-left:auto;background:#6366f1;border:none;border-radius:6px;color:#fff;padding:4px 10px;cursor:pointer;font-size:10px;white-space:nowrap">Attiva &#x2656;</button>\x27;
        var tokenBar = document.getElementById(\x27studioTokenBar\x27);
        if (tokenBar && tokenBar.parentNode) tokenBar.parentNode.insertBefore(nudge, tokenBar.parentNode.firstChild);
      }
    }

    // Step 2: execute each step via SSE
    var context = '';
    for (var i = 0; i < studioState.nodes.length; i++) {
      var node = studioState.nodes[i];
      studioSetNodeStatus(i, 'running');
      studioLog(node.label, node.icon, 'Starting...', 'agent');

      if (!studioState.running) break; // stopped by user
      var stepResult = await runStudioStep(i, node, task, context, planRes.steps[i], studioAbortController ? studioAbortController.signal : null);
      if (stepResult.aborted) {
        studioSetNodeStatus(i, 'error');
        break;
      }
      if (stepResult.error) {
        studioSetNodeStatus(i, 'error');
        studioLog(node.label, node.icon, 'Error: ' + stepResult.error, 'error');
        break;
      }
      studioSetNodeStatus(i, 'done');
      var realOutput = (stepResult.output && stepResult.output !== '(no output)') ? stepResult.output : null;
      studioState.nodes[i].output = realOutput || '';
      studioLog(node.label, node.icon, realOutput || (stepResult.canvas ? '[Canvas report generated]' : '(done)'), 'agent', true);
      // If CanvasAgent produced HTML, open it in the canvas panel
      if (stepResult.canvas) {
        var cf = document.getElementById('canvasFrame');
        var cp = document.getElementById('canvasPanel');
        var ct = document.getElementById('canvasTitle');
        if (cf && cp) {
          cf.srcdoc = stepResult.canvas;
          cp.classList.add('open');
          if (ct) ct.textContent = node.label + ' Report';
        }
      }
      // Accumulate context: append each step's output so specialist agents see ALL previous data
      var NL = String.fromCharCode(10);
      if (realOutput) {
        context = context
          ? context + NL + NL + '---' + NL + '## ' + node.label + ':' + NL + realOutput
          : '## ' + node.label + ':' + NL + realOutput;
      } else if (stepResult.canvas) {
        context = context || '[Canvas generated]';
      }
    }

    // Parliament mode: Round 2 cross-reading deliberation
    // Read from both DOM and studioState (supports mid-run activation via nudge)
    var parliamentChk = document.getElementById(\x27studioParliamentMode\x27);
    var parliamentActive = studioState.parliamentMode || (parliamentChk && parliamentChk.checked);
    if (parliamentActive && studioState.nodes.length >= 1) {
      var proposals = studioState.nodes
        .filter(function(n) {
          if (!n.output || n.output === \x27(no output)\x27) return false;
          if (n.agent === \x27CanvasAgent\x27 || n.agent === \x27DocumentReaderAgent\x27) return false;
          if (n.status === \x27error\x27) return false;
          // Exclude nodes whose output is a short error message (< 80 chars containing "error"/"could not")
          if (n.output.length < 120 && /error|could not|fallito|errore/i.test(n.output)) return false;
          return true;
        })
        .map(function(n) { return {agent: n.agent, label: n.label, icon: n.icon, output: n.output}; });
      // Need at least 2 proposals for cross-reading; if only 1, include the full context as a second proposal
      if (proposals.length === 1 && context) {
        proposals.push({agent: \x27Context\x27, label: \x27Contesto workflow\x27, output: context});
      }
      if (proposals.length >= 2) {
        studioLog(\x27Parlamento\x27, \x27&#x2656;\x27, \x27Avvio deliberazione — Round 2 cross-reading tra agenti...\x27, \x27system\x27);
        var deliberateBody = JSON.stringify({task: task, proposals: proposals, language: document.getElementById(\x27langSelect\x27) ? document.getElementById(\x27langSelect\x27).value : \x27it\x27});
        try {
          var delRes = await fetch(\x27/api/studio/deliberate\x27, {method:\x27POST\x27, headers:{\x27Content-Type\x27:\x27application/json\x27}, body: deliberateBody, signal: studioAbortController ? studioAbortController.signal : undefined});
          if (delRes.ok) {
            var delReader = delRes.body.getReader();
            var delDecoder = new TextDecoder();
            var delBuf = \x27\x27;
            var delDone = false;
            while (!delDone) {
              var delChunk = await delReader.read();
              if (delChunk.done) break;
              delBuf += delDecoder.decode(delChunk.value, {stream:true});
              var delLines = delBuf.split(\x27\\n\x27);
              delBuf = delLines.pop();
              delLines.forEach(function(ln) {
                if (!ln.startsWith(\x27data: \x27)) return;
                var dd = ln.slice(6).trim();
                if (dd === \x27[DONE]\x27) { delDone = true; return; }
                try {
                  var dev = JSON.parse(dd);
                  if (dev.token) {
                    // Status tokens from server — update last log entry text inline
                    var delEntries = document.querySelectorAll(\x27.studio-log-entry\x27);
                    var delLast = delEntries[delEntries.length - 1];
                    if (delLast) { var delTb = delLast.querySelector(\x27.studio-log-entry__text\x27); if (delTb) delTb.textContent = dev.token; }
                  } else if (dev.deliberation_r2) {
                    var r2d = dev.deliberation_r2;
                    studioLog(r2d.label || r2d.agent, \x27&#x2656;\x27, \x27[R2] \x27 + (r2d.output || \x27\x27).slice(0, 300), \x27agent\x27, true);
                    var ni2 = studioState.nodes.findIndex(function(x){return x.agent===r2d.agent;});
                    if (ni2 >= 0) { studioState.nodes[ni2].output = r2d.output; }
                    context = r2d.output || context;
                  } else if (dev.deliberation_r3) {
                    studioLog(\x27HERALD\x27, \x27&#128295;\x27, \x27[Mediazione] \x27 + (dev.deliberation_r3.output || \x27\x27).slice(0, 300), \x27system\x27, true);
                    context = dev.deliberation_r3.output || context;
                  } else if (dev.deliberation_done) {
                    var r2Conv = Math.round((dev.r2_convergence || 0) * 100);
                    studioLog(\x27Parlamento\x27, \x27&#x2656;\x27, \x27Deliberazione completa — convergenza R2: \x27 + r2Conv + \x27%\x27, \x27system\x27);
                    if (dev.mediation) { context = dev.mediation; }
                    delDone = true;
                  } else if (dev.done) {
                    delDone = true;
                  }
                } catch(e2) {}
              });
            }
          }
        } catch(e3) {
          if (e3.name !== \x27AbortError\x27) {
            studioLog(\x27Parlamento\x27, \x27&#x2656;\x27, \x27Deliberazione non disponibile: \x27 + (e3.message || String(e3)), \x27error\x27);
          }
        }
      }
    }

    // Final result is the last step's output
    studioState.result = context;
    renderStudioResult();
    studioLog('Studio', '&#127881;', t('workflow_complete'), 'system');

    // Save session to localStorage for reuse in Chat
    saveStudioSession(task, studioState.nodes, studioState.log, context);
    renderStudioSessionsBar();

  } catch(e) {
    if (e.name !== 'AbortError') {
      studioLog('Studio', '&#9888;', 'Unexpected error: ' + (e.message || String(e)), 'error');
    }
  }

  studioState.running = false;
  studioAbortController = null;
  if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
  if (stopBtn) stopBtn.style.display = 'none';
}

// ---- STUDIO SESSIONS ----
function saveStudioSession(task, nodes, log, result) {
  try {
    var sessions = JSON.parse(localStorage.getItem('nha_studio_sessions') || '[]');
    sessions.unshift({
      id: Date.now(),
      task: task,
      nodes: nodes.map(function(n){return {label:n.label,icon:n.icon,agent:n.agent};}),
      result: result,
      log: log.map(function(e){return {agent:e.agent,icon:e.icon,text:e.text,type:e.type,time:e.time};}),
      ts: new Date().toLocaleString()
    });
    sessions = sessions.slice(0, 20); // keep last 20
    localStorage.setItem('nha_studio_sessions', JSON.stringify(sessions));
  } catch(e) {}
}

function loadStudioSessions() {
  try { return JSON.parse(localStorage.getItem('nha_studio_sessions') || '[]'); }
  catch(e) { return []; }
}

function renderStudioSessionsBar() {
  var el = document.getElementById('studioSessionsBar');
  if (!el) return;
  var sessions = loadStudioSessions();
  if (!sessions.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div style="font-size:10px;color:var(--dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">' + t('recent_sessions') + '</div>' +
    '<div style="max-height:220px;overflow-y:auto;padding-right:4px">' +
    sessions.map(function(s,i) {
      return '<div class="studio-session-item">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<span class="studio-session-task">' + esc(s.task.slice(0,60)) + (s.task.length>60?'...':'') + '</span>' +
          '<span style="font-size:9px;color:var(--dim);white-space:nowrap">' + esc(s.ts) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px">' +
          '<button onclick="restoreStudioSession('+i+')" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--green);cursor:pointer">Restore</button>' +
          '<button onclick="importStudioToChat('+i+')" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--cyan);cursor:pointer">Send to Chat</button>' +
          '<button onclick="deleteStudioSession('+i+')" style="font-size:10px;padding:3px 8px;background:none;border:none;color:var(--dim);cursor:pointer">&times;</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
}

function restoreStudioSession(idx) {
  var sessions = loadStudioSessions();
  var s = sessions[idx]; if (!s) return;
  studioState.task = s.task;
  studioState.nodes = s.nodes.map(function(n){return {icon:n.icon,agent:n.agent,label:n.label,status:'done'};});
  studioState.log = s.log;
  studioState.result = s.result;
  studioState.running = false;
  var ta = document.getElementById('studioTaskInput');
  if (ta) ta.value = s.task;
  renderStudioNodes(); renderStudioLog(); renderStudioResult();
  showToast('success', 'Session restored', s.task.slice(0, 60), 3000);
}

function importStudioToChat(idx) {
  var sessions = loadStudioSessions();
  var s = sessions[idx]; if (!s) return;
  // Build a context message and inject into chat
  var NL2 = '\\n\\n';
  var summary = '**Studio Workflow Result**' + NL2 + 'Task: ' + s.task + NL2 + 'Agents: ' + s.nodes.map(function(n){return n.label;}).join(' -> ') + NL2 + '---' + NL2 + (s.result || '');
  // Switch to chat and pre-fill with context
  switchView('chat');
  setTimeout(function() {
    createNewConv().then(function() {
      // Add the studio result as an assistant message in history
      chatHistory = [{role:'assistant', content: summary}];
      renderMessages();
      var inp = document.getElementById('chatInput');
      if (inp) { inp.focus(); inp.placeholder = 'Ask follow-up questions about this studio result...'; }
      toast('Studio result imported into chat. Ask your follow-up question.');
    });
  }, 300);
}

function deleteStudioSession(idx) {
  try {
    var sessions = JSON.parse(localStorage.getItem('nha_studio_sessions') || '[]');
    sessions.splice(idx, 1);
    localStorage.setItem('nha_studio_sessions', JSON.stringify(sessions));
    renderStudioSessionsBar();
  } catch(e) {}
}

// ---- TOKEN COUNTER for Studio ----
var studioTokens = {in: 0, out: 0};
function studioAddTokens(inp, out) {
  studioTokens.in += (inp||0);
  studioTokens.out += (out||0);
  studioUpdateTokenBar();
}
function studioUpdateTokenBar() {
  var el = document.getElementById('studioTokenBar');
  if (!el) return;
  if (studioTokens.in === 0 && studioTokens.out === 0) { el.innerHTML = ''; return; }
  var total = studioTokens.in + studioTokens.out;
  el.innerHTML = '<span style="color:var(--green);font-weight:700">\u2B06 ' + studioTokens.in.toLocaleString() + '</span>' +
    '<span style="color:var(--dim)"> in &nbsp;</span>' +
    '<span style="color:#a5b4fc;font-weight:700">\u2B07 ' + studioTokens.out.toLocaleString() + '</span>' +
    '<span style="color:var(--dim)"> out &nbsp;\u2022&nbsp; </span>' +
    '<span style="color:var(--bright);font-weight:700">' + total.toLocaleString() + '</span>' +
    '<span style="color:var(--dim)"> tot</span>';
}

function runStudioStep(idx, node, task, context, stepDef, signal) {
  return new Promise(function(resolve) {
    var output = '';
    var canvasHtml = null;
    // Inject attachment into first step only — pass PDF/image as dedicated fields,
    // NOT as raw base64 in context (would cause 100k+ token overflow for any real PDF).
    // Cap accumulated context to ~40KB to avoid token overflow — keep the most recent content
    var cappedContext = context && context.length > 40000 ? context.slice(-40000) : context;
    var bodyObj = {stepIdx: idx, agent: node.agent, task: task, context: cappedContext, stepDef: stepDef};
    if (idx === 0 && studioState.attachmentContext) {
      var ac = studioState.attachmentContext;
      var isPdfAttach = ac.indexOf('[ATTACHED PDF:') === 0;
      var isImgAttach = ac.indexOf('[ATTACHED IMAGE:') === 0;
      // Extract base64 data URL from attachment context
      var b64Match = ac.indexOf('Base64: ');
      var dataUrl = b64Match >= 0 ? ac.slice(b64Match + 8).trim() : '';
      if (isPdfAttach && dataUrl) {
        // Pass PDF as dedicated field — agent/llm handles it natively
        bodyObj.pdfBase64 = dataUrl;
        bodyObj.pdfName = studioState.attachmentName;
        // Add a short note in context instead of the full base64
        bodyObj.context = '[User attached PDF: ' + studioState.attachmentName + ']' +
          (context ? String.fromCharCode(10) + String.fromCharCode(10) + context : '');
      } else if (isImgAttach && dataUrl) {
        bodyObj.imageBase64 = dataUrl;
        bodyObj.imageMimeType = dataUrl.indexOf('data:image/png') === 0 ? 'image/png' : 'image/jpeg';
        bodyObj.context = '[User attached image: ' + studioState.attachmentName + ']' +
          (context ? String.fromCharCode(10) + String.fromCharCode(10) + context : '');
      }
    }
    var body = JSON.stringify(bodyObj);
    var fetchOpts = {method: 'POST', headers: {'Content-Type': 'application/json'}, body: body};
    if (signal) fetchOpts.signal = signal;

    fetch('/api/studio/run', fetchOpts).then(function(res) {
      if (!res.ok) { resolve({error: 'HTTP ' + res.status}); return; }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        reader.read().then(function(chunk) {
          if (chunk.done) { resolve({output: output || '(no output)', canvas: canvasHtml}); return; }
          buf += decoder.decode(chunk.value, {stream: true});
          var lines = buf.split('\\n');
          buf = lines.pop();
          lines.forEach(function(line) {
            if (!line.startsWith('data: ')) return;
            var d = line.slice(6).trim();
            if (d === '[DONE]') { resolve({output: output || '(no output)', canvas: canvasHtml}); return; }
            try {
              var ev = JSON.parse(d);
              if (ev.token) {
                var isStatus = ev.token.charAt(0) === \x27[\x27 && ev.token.indexOf(\x27]\x27) > 0 && ev.token.length < 80;
                if (!isStatus) { output += ev.token; }
                // Update live log
                var entries = document.querySelectorAll(\x27.studio-log-entry\x27);
                var last = entries[entries.length - 1];
                if (last) {
                  var tb = last.querySelector(\x27.studio-log-entry__text\x27);
                  if (tb) {
                    if (isStatus) {
                      var st = ev.token.replace(new RegExp(\x27[\\\\r\\\\n]+\x27,\x27g\x27), \x27 \x27);
                      // Render [Searching: "query"] as a styled search chip
                      var srchM = st.match(/^\\[Searching:\\s*"([^"]+)"\\]\\s*$/);
                      if (srchM) {
                        var qEsc = srchM[1].replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                        tb.innerHTML = \x27<span style="display:inline-flex;align-items:center;gap:6px;background:#1c1c28;border:1px solid #6366f133;border-radius:20px;padding:3px 10px 3px 8px;font-size:11px;font-family:var(--mono)"><span style="color:#6366f1">&#128269;</span><span style="color:var(--dim)">Cercando</span><strong style="color:#a5b4fc">\x27 + qEsc + \x27</strong><span style="color:#6366f1;animation:pulse 1s infinite">&#183;&#183;&#183;</span></span>\x27;
                      } else {
                        tb.textContent = st;
                      }
                    } else {
                      // Live token counter — shows progress without raw content
                      var chars = output.length;
                      var toks = Math.ceil(chars / 4);
                      tb.innerHTML = \x27<span style="color:var(--green);font-family:var(--mono);font-size:10px">&#9679; Generating\u2026 \x27 + toks + \x27 token</span>\x27;
                    }
                  }
                }
              }
              if (ev.canvas) {
                canvasHtml = ev.canvas;
                studioState.canvas = ev.canvas;
                // Render canvas immediately when received — don't wait for step resolution
                var cf2 = document.getElementById('canvasFrame');
                var cp2 = document.getElementById('canvasPanel');
                if (cf2 && cp2) {
                  cf2.srcdoc = canvasHtml;
                  cp2.classList.add('open');
                  var ct2 = document.getElementById('canvasTitle');
                  if (ct2) ct2.textContent = \x27Studio Report\x27;
                }
                var scb = document.getElementById('studioCanvasBtn');
                if (scb) scb.style.display = \x27\x27;
              }
              if (ev.usage) { studioAddTokens(ev.usage.input||0, ev.usage.output||0); }
              else if (ev.token && !isStatus) { studioTokens.out += Math.ceil(ev.token.length/4); studioUpdateTokenBar(); }
              if (ev.done) { resolve({output: output || '(no output)', canvas: canvasHtml}); return; }
              if (ev.error) { resolve({error: ev.error}); return; }
            } catch(e) {}
          });
          pump();
        }).catch(function(e) {
          if (e.name === 'AbortError') { resolve({aborted: true}); } else { resolve({error: e.message}); }
        });
      }
      pump();
    }).catch(function(e) {
      if (e.name === 'AbortError') { resolve({aborted: true}); } else { resolve({error: e.message}); }
    });
  });
}

function renderStudio(el) {
  var examplesHtml = STUDIO_EXAMPLES.map(function(ex) {
    return '<button class="studio-example-btn" onclick="document.getElementById(\\'studioTaskInput\\').value=' + JSON.stringify(ex) + '">' + esc(ex.slice(0, 52)) + (ex.length > 52 ? '...' : '') + '</button>';
  }).join('');

  // Agent catalog
  var STUDIO_AGENTS = [
    {icon:'&#128269;',name:'WebSearchAgent',desc:'Search the web'},
    {icon:'&#127760;',name:'BrowserAgent',desc:'Navigate & screenshot pages'},
    {icon:'&#128140;',name:'EmailAgent',desc:'Read & summarize emails'},
    {icon:'&#128197;',name:'CalendarAgent',desc:'Read events & scheduling'},
    {icon:'&#9881;',name:'GitHubAgent',desc:'Issues, PRs, notifications'},
    {icon:'&#128214;',name:'NotionAgent',desc:'Search Notion pages'},
    {icon:'&#128172;',name:'SlackAgent',desc:'Read channels'},
    {icon:'&#128202;',name:'DataAnalystAgent',desc:'Analyze data & patterns'},
    {icon:'&#9999;',name:'WriterAgent',desc:'Write structured documents'},
    {icon:'&#128203;',name:'SummaryAgent',desc:'Summarize long content'},
    {icon:'&#128270;',name:'ResearchAgent',desc:'Deep research & facts'},
    {icon:'&#128247;',name:'CanvasAgent',desc:'Generate HTML visual report'},
    {icon:'&#128274;',name:'SecurityAgent',desc:'Security analysis'},
    {icon:'&#128295;',name:'DevOpsAgent',desc:'Infrastructure analysis'},
  ];

  var toolsHtml = STUDIO_AGENTS.map(function(t){
    return '<div class="studio-tool-item" onclick="addAgentToBuilder(\\x27'+t.name+'\\x27,\\x27'+t.icon+'\\x27)">' +
      '<span class="studio-tool-icon">'+t.icon+'</span>' +
      '<div><div style="font-size:11px;font-weight:600;color:var(--green)">'+t.name+'</div><div style="font-size:10px;color:var(--dim)">'+esc(t.desc)+'</div></div>' +
      '<span style="margin-left:auto;font-size:14px;color:var(--green3);flex-shrink:0">+</span>' +
    '</div>';
  }).join('');

  // 38 specialist agents sidebar
  var SPECIALIST_AGENTS = [
    {icon:'\u{1F6E1}',name:'saber',desc:'Security audits, pentest, OWASP'},
    {icon:'\u{1F50D}',name:'zero',desc:'Vulnerability & dependency audit'},
    {icon:'\u2713',name:'veritas',desc:'Fact-checking & hallucination detection'},
    {icon:'\u{1F52C}',name:'ade',desc:'Full security review, forensics'},
    {icon:'\u{1F512}',name:'heimdall',desc:'OAuth, JWT, RBAC design'},
    {icon:'\u{1F4BB}',name:'jarvis',desc:'Full-stack architecture & API'},
    {icon:'\u2699',name:'forge',desc:'CI/CD, deployment, infra'},
    {icon:'\u{1F527}',name:'pipe',desc:'Build systems, Airflow, automation'},
    {icon:'\u{1F4DF}',name:'shell',desc:'Shell scripts, CLI tools'},
    {icon:'\u{1F41B}',name:'glitch',desc:'Debugging & root cause'},
    {icon:'\u{1F4CA}',name:'oracle',desc:'Data analysis, stats, ML'},
    {icon:'\u{1F9EE}',name:'logos',desc:'Logic, proofs, formal reasoning'},
    {icon:'\u{1F5FA}',name:'atlas',desc:'Terraform, CloudFormation, IaC'},
    {icon:'\u{1F30D}',name:'cartographer',desc:'Geo data, mapping, routing'},
    {icon:'\u270D',name:'scheherazade',desc:'Docs, tutorials, blog posts'},
    {icon:'\u{1F4DD}',name:'quill',desc:'Posts, summaries, abstracts'},
    {icon:'\u{1F3A8}',name:'muse',desc:'Creative brainstorming & ideation'},
    {icon:'\u{1F58C}',name:'murasaki',desc:'UI/UX design, accessibility'},
    {icon:'\u{1F517}',name:'hermes',desc:'Kafka, RabbitMQ, event-driven'},
    {icon:'\u{1F50C}',name:'link',desc:'Community, reputation, engagement'},
    {icon:'\u{1F310}',name:'mercury',desc:'Finance, market, ROI analysis'},
    {icon:'\u2638',name:'shogun',desc:'Kubernetes, Helm, pod security'},
    {icon:'\u{1F504}',name:'flux',desc:'GitOps, rollback planning'},
    {icon:'\u23F0',name:'cron',desc:'GitHub Actions, GitLab CI'},
    {icon:'\u{1F30E}',name:'babel',desc:'API integration, microservices'},
    {icon:'\u{1F5E3}',name:'polyglot',desc:'i18n, localization, translation'},
    {icon:'\u{1F4E2}',name:'herald',desc:'News analysis, trend detection'},
    {icon:'\u{1F4E1}',name:'echo',desc:'Content repurposing: blog\u2192social'},
    {icon:'\u26A1',name:'macro',desc:'Batch processing, data migration'},
    {icon:'\u{1F525}',name:'prometheus',desc:'Strategy, architecture trade-offs'},
    {icon:'\u26A0',name:'cassandra',desc:'Risk prediction, worst-case analysis'},
    {icon:'\u{1F9E0}',name:'athena',desc:'Tech evaluation, benchmarks'},
    {icon:'\u{1F441}',name:'sauron',desc:'Performance profiling, bottlenecks'},
    {icon:'\u{1F3BC}',name:'conductor',desc:'Workflow orchestration'},
    {icon:'\u{1F9ED}',name:'navi',desc:'Data profiling, schema inference'},
    {icon:'\u{1F4C8}',name:'edi',desc:'A/B testing, hypothesis testing'},
    {icon:'\u26C8',name:'tempest',desc:'Climate, weather, environmental'},
    {icon:'\u{1F37D}',name:'epicure',desc:'Recipes, nutrition, dietary'},
  ];
  var specialistHtml = SPECIALIST_AGENTS.map(function(t){
    var ic = t.icon;
    return '<div class="studio-tool-item" onclick="addAgentToBuilder(\\x27'+t.name+'\\x27,\\x27'+ic+'\\x27)">' +
      '<span class="studio-tool-icon">'+ic+'</span>' +
      '<div><div style="font-size:11px;font-weight:600;color:var(--cyan)">'+t.name+'</div><div style="font-size:10px;color:var(--dim)">'+esc(t.desc)+'</div></div>' +
      '<span style="margin-left:auto;font-size:14px;color:var(--green3);flex-shrink:0">+</span>' +
    '</div>';
  }).join('');

  el.innerHTML =
    '<div class="studio-header">' +
      '<h2>&#9881; NHA Studio</h2>' +
      '<p>Build a pipeline manually — click agents to add them in order — or describe your task in natural language and let Studio plan it automatically.</p>' +
    '</div>' +
    '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">' +
      '<div style="flex:1;min-width:0">' +

        // ── MODE TABS ──
        '<div style="display:flex;gap:0;margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
          '<button id="studioTabAuto" onclick="studioSetMode(\\x27auto\\x27)" style="flex:1;padding:8px;font-size:11px;font-weight:600;background:var(--green3);color:#fff;border:none;cursor:pointer">&#128161; Auto Plan</button>' +
          '<button id="studioTabManual" onclick="studioSetMode(\\x27manual\\x27)" style="flex:1;padding:8px;font-size:11px;font-weight:600;background:var(--bg3);color:var(--dim);border:none;cursor:pointer">&#128295; Manual Builder</button>' +
        '</div>' +

        // ── AUTO MODE ──
        '<div id="studioAutoMode">' +
          '<div style="margin-bottom:10px">' +
            '<div style="font-size:10px;color:var(--dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">' + t('examples') + '</div>' +
            examplesHtml +
          '</div>' +
          '<div class="studio-input-row">' +
            '<textarea id="studioTaskInput" placeholder="' + t('placeholder_studio') + '" onkeydown="if(event.key===\\x27Enter\\x27&&(event.ctrlKey||event.metaKey)){runStudio();event.preventDefault()}">' + esc(studioState.task) + '</textarea>' +
            (studioState.attachmentName ? '<div id="studioAttachBadge" style="display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--greendim);border:1px solid var(--green3);border-radius:6px;margin-bottom:6px;font-size:11px;color:var(--green);font-family:var(--mono)">&#128206; ' + esc(studioState.attachmentName) + ' <span onclick="studioClearAttach()" style="cursor:pointer;color:var(--dim);font-size:13px;margin-left:4px" title="Rimuovi">&#215;</span></div>' : '') +
            '<input type="file" id="studioFileInput" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp" style="display:none" onchange="studioHandleAttach(this.files[0])">' +
            '<div style="display:flex;gap:6px">' +
              '<button onclick="document.getElementById(\\x27studioFileInput\\x27).click()" title="Attach PDF or image" style="padding:8px 10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--dim);cursor:pointer;font-size:15px" ' + (studioState.running ? 'disabled' : '') + '>&#128206;</button>' +
              '<button id="studioRunBtn" class="studio-run-btn" onclick="runStudio()" style="flex:1" ' + (studioState.running ? 'disabled' : '') + '>' + t('run') + '</button>' +
              '<button id="studioStopBtn" onclick="stopStudio()" title="' + t('stop') + '" style="padding:8px 14px;background:#7f1d1d;border:1px solid #ef4444;border-radius:8px;color:#ef4444;cursor:pointer;font-size:13px;font-weight:700;white-space:nowrap;' + (studioState.running ? '' : 'display:none') + '">&#9632; ' + t('stop') + '</button>' +
              '<button id="studioInlinePdfBtn" onclick="downloadStudioPDF()" title="Scarica PDF del risultato" style="display:' + (studioState.result ? 'inline-flex' : 'none') + ';align-items:center;gap:5px;padding:8px 12px;background:linear-gradient(135deg,#4f46e5,#2563eb);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:0 2px 6px rgba(79,70,229,.35)">&#x2913; PDF</button>' +
              '<button onclick="studioReset()" title="' + t('reset') + '" style="padding:8px 12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--dim);cursor:pointer;font-size:16px;line-height:1" ' + (studioState.running ? 'disabled' : '') + '>&#8635;</button>' +
            '</div>' +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer;user-select:none">' +
            '<input type="checkbox" id="studioParliamentMode" style="width:15px;height:15px;accent-color:var(--green3)" ' + (studioState.parliamentMode ? \x27checked\x27 : \x27\x27) + ' onchange="studioState.parliamentMode=this.checked">' +
            '<span style="font-size:12px;color:var(--dim)">&#x2656; <strong style="color:var(--green)">Parlamento</strong> — Round 2 cross-reading tra agenti (2x token)</span>' +
          '</label>' +
        '</div>' +

        // ── MANUAL BUILDER MODE ──
        '<div id="studioManualMode" style="display:none">' +
          '<div style="margin-bottom:10px">' +
            '<input id="studioManualTask" placeholder="Describe the overall goal (optional)..." style="width:100%;padding:10px 14px;font-size:13px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">' +
          '</div>' +
          '<div id="studioBuilderPipeline" class="studio-builder-pipeline">' +
            '<div class="studio-builder-empty">Click agents on the right to build your pipeline</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
            '<button onclick="runManualWorkflow()" class="studio-run-btn" style="flex:1">&#9654; Run Pipeline</button>' +
            '<button onclick="clearBuilderPipeline()" style="padding:8px 14px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--dim);cursor:pointer;font-size:12px">Clear</button>' +
          '</div>' +
        '</div>' +

        '<div style="display:flex;align-items:center;gap:8px;margin:8px 0">' +
          '<div id="studioTokenBar" style="font-size:10px;color:var(--dim);font-family:var(--mono);flex:1"></div>' +
          '<button id="studioCanvasBtn" onclick="openCanvasPanel()" title="' + t('canvas_open') + '" style="font-size:12px;padding:5px 14px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--dim);cursor:pointer;font-weight:700;transition:all .2s">&#9632; Canvas</button>' +
        '</div>' +
        '<div class="studio-canvas" id="studioNodes"></div>' +
        '<div class="studio-log" id="studioLog" style="display:none"></div>' +
        '<div id="studioResult"></div>' +
        '<div id="studioSessionsBar" style="margin-top:16px;display:none"></div>' +
      '</div>' +

      // ── AGENT SIDEBAR ──
      '<div class="studio-tools-panel">' +
        // Tab bar
        '<div style="display:flex;gap:0;margin-bottom:10px;border:1px solid var(--border);border-radius:6px;overflow:hidden">' +
          '<button id="sideTabTools" onclick="studioSideTab(\\x27tools\\x27)" style="flex:1;padding:5px;font-size:10px;font-weight:600;background:var(--green3);color:#fff;border:none;cursor:pointer">&#128295; Tools</button>' +
          '<button id="sideTabAgents" onclick="studioSideTab(\\x27agents\\x27)" style="flex:1;padding:5px;font-size:10px;font-weight:600;background:var(--bg3);color:var(--dim);border:none;cursor:pointer">&#129302; Agents</button>' +
        '</div>' +
        '<div style="font-size:9px;color:var(--dim);margin-bottom:8px">Click to add to pipeline</div>' +
        '<div id="sideToolsList">'+toolsHtml+'</div>' +
        '<div id="sideAgentsList" style="display:none">'+specialistHtml+'</div>' +
      '</div>' +
    '</div>';

  renderStudioNodes();
  renderStudioLog();
  renderStudioResult();
  renderStudioSessionsBar();
  studioTokens = {in:0,out:0};
  // Restore pipeline from state
  renderBuilderPipeline();
}

// ---- STUDIO SIDEBAR TAB ----
function studioSideTab(tab) {
  var toolsList = document.getElementById('sideToolsList');
  var agentsList = document.getElementById('sideAgentsList');
  var tabT = document.getElementById('sideTabTools');
  var tabA = document.getElementById('sideTabAgents');
  if (!toolsList || !agentsList) return;
  if (tab === 'tools') {
    toolsList.style.display = '';
    agentsList.style.display = 'none';
    if (tabT) { tabT.style.background='var(--green3)'; tabT.style.color='#fff'; }
    if (tabA) { tabA.style.background='var(--bg3)'; tabA.style.color='var(--dim)'; }
  } else {
    toolsList.style.display = 'none';
    agentsList.style.display = '';
    if (tabA) { tabA.style.background='var(--cyan)'; tabA.style.color='#fff'; }
    if (tabT) { tabT.style.background='var(--bg3)'; tabT.style.color='var(--dim)'; }
  }
}

// ---- STUDIO MODE SWITCHING ----
var studioMode = 'auto';
var builderPipeline = []; // [{icon,name,agent}]

function studioSetMode(mode) {
  studioMode = mode;
  var autoEl = document.getElementById('studioAutoMode');
  var manEl = document.getElementById('studioManualMode');
  var tabA = document.getElementById('studioTabAuto');
  var tabM = document.getElementById('studioTabManual');
  if (!autoEl || !manEl) return;
  if (mode === 'auto') {
    autoEl.style.display = '';
    manEl.style.display = 'none';
    if (tabA) { tabA.style.background='var(--green3)'; tabA.style.color='#fff'; }
    if (tabM) { tabM.style.background='var(--bg3)'; tabM.style.color='var(--dim)'; }
  } else {
    autoEl.style.display = 'none';
    manEl.style.display = '';
    if (tabM) { tabM.style.background='var(--green3)'; tabM.style.color='#fff'; }
    if (tabA) { tabA.style.background='var(--bg3)'; tabA.style.color='var(--dim)'; }
    renderBuilderPipeline();
  }
}

// ---- MANUAL BUILDER ----
function addAgentToBuilder(agentName, icon) {
  if (builderPipeline.length >= 6) { toast('Max 6 agents per pipeline'); return; }
  builderPipeline.push({icon: icon||'&#9881;', name: agentName, agent: agentName, label: agentName.replace('Agent',''), status:'waiting'});
  // Auto-switch to manual mode when user clicks an agent
  studioSetMode('manual');
  renderBuilderPipeline();
}

function removeBuilderAgent(idx) {
  builderPipeline.splice(idx, 1);
  renderBuilderPipeline();
}

function moveBuilderAgent(idx, dir) {
  var newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= builderPipeline.length) return;
  var tmp = builderPipeline[idx];
  builderPipeline[idx] = builderPipeline[newIdx];
  builderPipeline[newIdx] = tmp;
  renderBuilderPipeline();
}

function clearBuilderPipeline() {
  builderPipeline = [];
  renderBuilderPipeline();
}

function renderBuilderPipeline() {
  var el = document.getElementById('studioBuilderPipeline');
  if (!el) return;
  if (!builderPipeline.length) {
    el.innerHTML = '<div class="studio-builder-empty">Click agents on the right to build your pipeline</div>';
    return;
  }
  el.innerHTML = builderPipeline.map(function(a, i) {
    return '<div class="studio-builder-node" draggable="true" ondragstart="builderDragStart('+i+')" ondragover="event.preventDefault()" ondrop="builderDrop('+i+')">' +
      '<span style="font-size:18px;flex-shrink:0">'+a.icon+'</span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:600;color:var(--green)">'+esc(a.label||a.name)+'</div>' +
        '<div style="font-size:10px;color:var(--dim)">Step '+(i+1)+'</div>' +
      '</div>' +
      '<div style="display:flex;gap:2px;align-items:center">' +
        (i>0?'<button onclick="moveBuilderAgent('+i+',-1)" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:2px 4px" title="Move up">&#8593;</button>':'') +
        (i<builderPipeline.length-1?'<button onclick="moveBuilderAgent('+i+',1)" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:2px 4px" title="Move down">&#8595;</button>':'') +
        '<button onclick="removeBuilderAgent('+i+')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:2px 4px" title="Remove">&times;</button>' +
      '</div>' +
      (i<builderPipeline.length-1?'<div style="position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);color:var(--green3);font-size:12px">&#8595;</div>':'') +
    '</div>';
  }).join('');
}

// Drag-and-drop reorder for builder pipeline
var builderDragIdx = -1;
function builderDragStart(idx) { builderDragIdx = idx; }
function builderDrop(toIdx) {
  if (builderDragIdx < 0 || builderDragIdx === toIdx) return;
  var item = builderPipeline.splice(builderDragIdx, 1)[0];
  builderPipeline.splice(toIdx, 0, item);
  builderDragIdx = -1;
  renderBuilderPipeline();
}

async function runManualWorkflow() {
  if (!builderPipeline.length) { toast('Add at least one agent to the pipeline'); return; }
  if (studioState.running) return;

  var taskEl = document.getElementById('studioManualTask');
  var task = taskEl ? taskEl.value.trim() : '';
  if (!task) task = builderPipeline.map(function(a){return a.label||a.name;}).join(' -> ') + ' pipeline';

  // Build steps in the same format runStudio expects, skipping the LLM planner
  var steps = builderPipeline.map(function(a) {
    return {
      agent: a.agent,
      label: a.label || a.name,
      icon: a.icon,
      prompt: task,
      status: 'waiting'
    };
  });

  studioState.task = task;
  studioState.nodes = steps.map(function(s){return {icon:s.icon,agent:s.agent,label:s.label,status:'waiting'};});
  studioState.log = [];
  studioState.result = '';
  studioState.running = true;
  studioTokens = {in:0, out:0};
  var tb = document.getElementById('studioTokenBar');
  if(tb) tb.textContent = '';
  renderStudioNodes();
  renderStudioLog();
  renderStudioResult();

  var context = '';
  try {
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      studioSetNodeStatus(i, 'running');
      studioLog(s.label, s.icon, 'Starting...', 'agent');
      var stepResult = await runStudioStep(i, {agent:s.agent,label:s.label,icon:s.icon}, task, context, s);
      if (stepResult.error) {
        studioSetNodeStatus(i, 'error');
        studioLog(s.label, s.icon, 'Error: '+stepResult.error, 'error');
        break;
      }
      studioSetNodeStatus(i, 'done');
      var realOut2 = (stepResult.output && stepResult.output !== '(no output)') ? stepResult.output : null;
      studioLog(s.label, s.icon, realOut2 || (stepResult.canvas ? '[Canvas report generated]' : '(done)'), 'agent', true);
      if (stepResult.canvas) {
        var cf = document.getElementById('canvasFrame');
        var cp = document.getElementById('canvasPanel');
        if (cf && cp) { cf.srcdoc = stepResult.canvas; cp.classList.add('open'); var ct3=document.getElementById('canvasTitle'); if(ct3) ct3.textContent='Studio Report'; }
      }
      context = realOut2 || stepResult.canvas || context;
    }
    studioState.result = context;
    renderStudioResult();
    studioLog('Studio', '&#127881;', 'Pipeline complete.', 'system');
    saveStudioSession(task, studioState.nodes, studioState.log, context);
    renderStudioSessionsBar();
  } catch(e) {
    studioLog('Studio', '&#9888;', 'Error: '+(e.message||String(e)), 'error');
  }
  studioState.running = false;
}

// ---- INIT ----
function init(){
  renderSidebar();
  var el=document.getElementById('content');
  if(el)el.innerHTML=\x27<div style="display:flex;align-items:center;justify-content:center;height:50vh;flex-direction:column"><div class="spinner"></div><div style="color:var(--dim)">Loading...</div></div>\x27;
  loadDash().then(function(){render()}).catch(function(){render()});
  loadAgents().catch(function(){});
  setInterval(function(){loadDash().then(function(){if(currentView===\x27dashboard\x27)render()}).catch(function(){})},120000);
  connectWebSocket();
  var bv=document.getElementById('browserViewer');
  if(bv)makeDraggable(bv,\x27.browser-viewer__header\x27);
  var cp=document.getElementById('canvasPanel');
  if(cp)makeDraggable(cp,\x27.cvs-header\x27);
  // Telemetry ping — fire and forget
  setTimeout(function(){
    fetch(\x27https://nothumanallowed.com/api/v1/telemetry/ping\x27,{method:\x27POST\x27,headers:{\x27Content-Type\x27:\x27application/json\x27},body:JSON.stringify({platform:\x27web-ui\x27,version:\x27${VERSION}\x27})}).catch(function(){});
  },3000);
}
init();
`;

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
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono','Fira Code','SF Mono','Consolas',monospace;
  --term:'JetBrains Mono','Fira Code','SF Mono','Consolas',monospace;
  --amber3:#d97706;--amberdim:#1a1200;
  --r:6px;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:13.5px;line-height:1.6}
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

/* Mobile burger button */
#mobileBurger{display:block}
.sidebar__close{position:absolute;top:12px;right:12px;background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;padding:4px 8px;z-index:10;line-height:1}
.sidebar__close:hover{color:var(--bright)}
.sidebar__brand{position:relative}

/* ---- DESKTOP: sidebar always visible ---- */
@media(min-width:901px){
  .app{flex-direction:row}
  .header__burger{display:none}
  #mobileBurger{display:none!important}
  .sidebar__close{display:none}
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
.msg--assistant .msg__bubble{background:var(--greendim);border:1px solid var(--green3);border-radius:8px 8px 8px 2px;padding:10px 14px;max-width:85%;color:var(--text);white-space:pre-wrap;word-wrap:break-word;line-height:1.5;min-height:40px;min-width:60px}
.msg--assistant .msg__bubble img{max-width:100%;border-radius:8px;margin:8px 0;border:1px solid rgba(0,255,65,0.2)}
.msg--assistant.msg--streaming .msg__bubble{border-color:var(--green);box-shadow:0 0 8px rgba(0,255,65,0.15)}
.msg__label{font-size:10px;color:var(--dim);margin-bottom:2px}
.typing-dots{display:inline-flex;align-items:center;gap:4px;padding:4px 0}
.typing-dots span{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);opacity:0.3;animation:tdot 1.2s ease-in-out infinite}
.typing-dots span:nth-child(2){animation-delay:0.2s}
.typing-dots span:nth-child(3){animation-delay:0.4s}
@keyframes tdot{0%,80%,100%{opacity:0.2;transform:scale(0.8)}40%{opacity:1;transform:scale(1.2)}}
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
.screenshot-preview{max-width:100%;border-radius:var(--r);margin:8px 0;border:1px solid var(--border);cursor:zoom-in;transition:opacity .15s}
.screenshot-preview:hover{opacity:.88}
.lightbox-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out}
.lightbox-overlay--open{display:flex}
.lightbox-overlay img{max-width:92vw;max-height:88vh;border-radius:8px;object-fit:contain;box-shadow:0 8px 48px rgba(0,0,0,.8)}
.lightbox-close{position:fixed;top:16px;right:20px;color:#fff;font-size:28px;cursor:pointer;line-height:1;opacity:.7}
.lightbox-close:hover{opacity:1}
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
.modal{background:var(--bg2);border:1px solid var(--border2);border-radius:8px;width:92%;max-width:560px;max-height:90vh;display:flex;flex-direction:column}
.modal--chat{height:80vh}
.modal__header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border)}
.modal__header h2{font-size:16px;color:var(--green)}
.modal__close{background:none;color:var(--dim);font-size:24px;padding:0 4px}
.modal__body{padding:16px;overflow-y:auto;flex:1}
.modal__body textarea{width:100%;min-height:80px;margin-bottom:10px}
.modal__response{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:12px;word-wrap:break-word;max-height:400px;overflow-y:auto;font-size:13px}
.modal__footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
.modal--chat .modal__body{padding:0;display:flex;flex-direction:column;overflow:hidden}
.agent-chat{display:flex;flex-direction:column;height:100%;min-height:0;padding:12px 16px;box-sizing:border-box}
.agent-chat__messages{flex:1;overflow-y:auto;padding:4px 0 8px;min-height:0;display:flex;flex-direction:column;gap:8px}
.agent-chat__bubble{max-width:88%;border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.55;word-wrap:break-word}
.agent-chat__bubble--user{align-self:flex-end;background:var(--green3);color:#e8ffe8}
.agent-chat__bubble--agent{align-self:flex-start;background:var(--bg3);border:1px solid var(--border)}
.agent-chat__footer{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--border)}
.agent-chat__drop{border:2px dashed var(--border2);border-radius:6px;padding:8px;text-align:center;color:var(--dim);font-size:11px;cursor:pointer;transition:border-color .2s}
.agent-chat__drop:hover{border-color:var(--green)}
.agent-chat__input-row{display:flex;gap:6px;align-items:flex-end}
.agent-chat__input{flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;color:var(--fg);font-size:13px;font-family:var(--font);resize:none;min-height:36px;max-height:120px;overflow-y:auto;outline:none}
.agent-chat__input:focus{border-color:var(--green)}
.btn{padding:8px 16px;border-radius:var(--r);font-size:12px;font-weight:600}
.btn--primary{background:var(--green3);color:var(--bg)}
.btn--secondary{background:var(--bg3);color:var(--dim);border:1px solid var(--border)}

/* ---- SPINNER ---- */
.spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}
.thinking-dots{display:inline-flex;gap:4px;align-items:center;padding:2px 0}
.thinking-dots span{width:6px;height:6px;border-radius:50%;background:var(--dim);animation:tdot 1.2s ease-in-out infinite}
.thinking-dots span:nth-child(2){animation-delay:.2s}
.thinking-dots span:nth-child(3){animation-delay:.4s}
@keyframes tdot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}

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

/* ---- STUDIO ---- */
.studio-header{margin-bottom:20px}
.studio-header h2{font-size:15px;color:var(--green);margin-bottom:4px}
.studio-header p{font-size:11px;color:var(--dim);line-height:1.5}
.studio-input-row{display:flex;gap:8px;margin-bottom:20px}
.studio-input-row textarea{flex:1;resize:none;height:60px;padding:10px 14px;font-size:13px;border-radius:var(--r);border:1px solid var(--border2)}
.studio-input-row textarea:focus{border-color:var(--green3)}
.studio-run-btn{background:var(--green3);color:var(--bg);padding:0 20px;border-radius:var(--r);font-weight:700;font-size:13px;white-space:nowrap;align-self:stretch;min-width:90px}
.studio-run-btn:disabled{opacity:.4}
.studio-canvas{position:relative;width:100%;min-height:220px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:20px;overflow:hidden}
.studio-canvas__empty{display:flex;align-items:center;justify-content:center;height:180px;color:var(--dim);font-size:11px;flex-direction:column;gap:8px}
.studio-canvas__empty-icon{font-size:32px;opacity:.3}
.studio-nodes{display:flex;align-items:center;gap:0;padding:28px 24px;overflow-x:auto;min-height:130px;background:var(--bg2);border-radius:10px;border:1px solid var(--border);margin-bottom:16px}
.studio-node{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;min-width:106px;max-width:126px;opacity:0;animation:stNodeIn .35s ease forwards}
@keyframes stNodeIn{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:translateY(0) scale(1)}}
.studio-node__circle{width:56px;height:56px;border-radius:14px;border:1.5px solid var(--border2);background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:22px;transition:all .35s;flex-shrink:0}
.studio-node__progress{display:flex;gap:4px;align-items:center;margin-top:2px}
.studio-node__progress span{width:5px;height:5px;border-radius:50%;background:var(--green3);animation:stDot 1.1s ease-in-out infinite}
.studio-node__progress span:nth-child(2){animation-delay:.18s}
.studio-node__progress span:nth-child(3){animation-delay:.36s}
@keyframes stDot{0%,80%,100%{opacity:.2;transform:scale(.7)}40%{opacity:1;transform:scale(1)}}
.studio-node--active .studio-node__circle{border-color:var(--green3);box-shadow:0 0 0 6px rgba(99,102,241,.18),0 0 20px rgba(99,102,241,.25);background:var(--greendim);animation:stRing 1.6s ease-out infinite}
.studio-node--done .studio-node__circle{border-color:#22c55e;background:rgba(34,197,94,.08);box-shadow:0 0 0 3px rgba(34,197,94,.12)}
.studio-node--error .studio-node__circle{border-color:var(--red);background:rgba(239,68,68,.07)}
.studio-node__label{font-size:10px;color:var(--dim);text-align:center;line-height:1.3;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.studio-node--active .studio-node__label{color:var(--green);font-weight:700}
.studio-node--done .studio-node__label{color:#22c55e;font-weight:600}
.studio-node__status{font-size:8px;padding:2px 8px;border-radius:20px;font-weight:700;text-transform:uppercase;letter-spacing:.6px}
.studio-node__status--waiting{background:rgba(156,163,175,.1);color:var(--dim)}
.studio-node__status--running{background:rgba(99,102,241,.15);color:var(--green);animation:stPulse .9s ease-in-out infinite}
.studio-node__status--done{background:rgba(34,197,94,.12);color:#22c55e}
.studio-node__status--error{background:rgba(239,68,68,.12);color:var(--red)}
@keyframes stPulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes stRing{0%{box-shadow:0 0 0 4px rgba(99,102,241,.15)}70%{box-shadow:0 0 0 12px rgba(99,102,241,0)}100%{box-shadow:0 0 0 4px rgba(99,102,241,.15)}}
@keyframes stFlow{0%{opacity:.4;transform:scaleX(.7)}100%{opacity:1;transform:scaleX(1)}}
.studio-arrow{display:flex;align-items:center;color:var(--border2);font-size:18px;padding:0 8px;flex-shrink:0;margin-bottom:30px;transition:color .4s}
.studio-arrow--active{color:var(--green3);animation:stFlow .5s ease-in-out infinite alternate}
.studio-arrow--done{color:#22c55e}
.studio-log{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;max-height:380px;overflow-y:auto;font-size:11.5px;line-height:1.65}
.studio-log-entry{margin-bottom:12px;padding:10px 12px;border-radius:8px;background:var(--bg3);border:1px solid var(--border)}
.studio-log-entry:last-child{margin-bottom:0}
.studio-log-entry__header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.studio-log-entry__icon{font-size:15px}
.studio-log-entry__agent{font-weight:700;color:var(--green);font-size:11px;letter-spacing:.3px}
.studio-log-entry__time{color:var(--dim);font-size:9px;margin-left:auto;opacity:.7}
.studio-log-entry__text{color:var(--text);word-wrap:break-word}
.studio-log-entry--system .studio-log-entry__agent{color:var(--cyan)}
.studio-log-entry--error .studio-log-entry__agent{color:var(--red)}
.studio-result{margin-top:16px;padding:16px;background:var(--greendim);border:1px solid var(--green3);border-radius:8px}
.studio-result__title{font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.studio-result__body{font-size:13px;color:var(--text);word-wrap:break-word;line-height:1.7}
.studio-example-btn{display:inline-block;padding:5px 12px;border:1px solid var(--border2);border-radius:20px;font-size:10px;color:var(--dim);cursor:pointer;background:none;margin:0 4px 6px 0;transition:all .15s}
.studio-example-btn:hover{border-color:var(--green3);color:var(--green);background:var(--greendim)}
.studio-tools-panel{width:220px;flex-shrink:0;border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--bg2);max-height:600px;overflow-y:auto}
.studio-tool-item{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:6px;cursor:pointer;transition:background .15s;margin-bottom:4px}
.studio-tool-item:hover{background:var(--bg3);border-radius:6px}
.studio-tool-icon{font-size:16px;flex-shrink:0;margin-top:1px}
.studio-session-item{padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;margin-bottom:8px}
.studio-session-task{font-size:11px;color:var(--text);font-weight:500}

/* ---- MARKDOWN BODY ---- */
.md-body{line-height:1.75}
.md-body .md-p{margin:0 0 10px;color:var(--text);font-size:13.5px}
.md-body .md-h1{font-size:18px;font-weight:700;color:var(--bright);margin:18px 0 10px;line-height:1.3}
.md-body .md-h2{font-size:15px;font-weight:600;color:var(--bright);margin:16px 0 8px;line-height:1.3}
.md-body .md-h3{font-size:13.5px;font-weight:600;color:var(--green);margin:12px 0 6px;line-height:1.3}
.md-body .md-ul,.md-body .md-ol{margin:6px 0 12px 0;padding-left:22px}
.md-body .md-ul li,.md-body .md-ol li{margin-bottom:5px;color:var(--text);font-size:13.5px;line-height:1.65}
.md-body .md-ul{list-style:disc}
.md-body .md-ol{list-style:decimal}
.md-body .md-code{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:10px 0;overflow-x:auto;font-family:var(--mono);font-size:12px;color:#a5b4fc;white-space:pre}
.md-body .md-inline-code{background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-family:var(--mono);font-size:12px;color:#a5b4fc}
.md-body .md-bq{border-left:3px solid var(--green3);padding:6px 12px;margin:8px 0;color:var(--dim);font-style:italic}
.md-body .md-hr{border:none;border-top:1px solid var(--border);margin:14px 0}
.md-body .md-spacer{height:6px}
.md-body strong{font-weight:700;color:var(--bright)}
.md-body em{font-style:italic;color:var(--dim)}
.md-body del{text-decoration:line-through;color:var(--dim)}
.md-body a{color:var(--cyan);text-decoration:underline}
.md-body .md-table{width:100%;border-collapse:collapse;margin:10px 0 14px;font-size:13px}
.md-body .md-table th{background:var(--bg3);color:var(--bright);font-weight:600;padding:7px 12px;text-align:left;border:1px solid var(--border2);white-space:nowrap}
.md-body .md-table td{padding:6px 12px;border:1px solid var(--border);color:var(--text);vertical-align:top}
.md-body .md-table tbody tr:nth-child(odd){background:rgba(0,0,0,0.15)}
.md-body .md-table tbody tr:hover{background:rgba(0,255,65,0.04)}

/* ---- CHAT bubble markdown tweaks ---- */
.msg--assistant .msg__bubble{white-space:normal}
.msg--user .msg__bubble{white-space:pre-wrap}
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>NHA</title>
<style>${CSS}</style>
</head>
<body>

<div class="toast-container" id="toastContainer"></div>
<div class="sidebar__overlay" id="overlay" onclick="closeSidebar()"></div>

<div class="app">
  <nav class="sidebar" id="sidebar"></nav>

  <button onclick="openSidebar()" style="position:fixed;top:6px;left:6px;z-index:100;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);color:var(--green);font-size:16px;padding:4px 8px;cursor:pointer;line-height:1;opacity:0.85" id="mobileBurger">&#9776;</button>

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
  <div class="modal modal--chat">
    <div class="modal__header">
      <div><h2 id="modalName">Agent</h2><div id="modalAgentDesc" style="font-size:10px;color:var(--dim);margin-top:2px"></div></div>
      <button class="modal__close" onclick="closeModal()">&times;</button>
    </div>
    <div class="modal__body">
      <div class="agent-chat">
        <div class="agent-chat__messages" id="agentMessages"></div>
        <div class="agent-chat__footer">
          <div class="agent-chat__drop" id="agentFileDropZone" onclick="document.getElementById('agentFileInput').click()" ondragover="event.preventDefault();this.style.borderColor='var(--green)'" ondragleave="this.style.borderColor=''" ondrop="event.preventDefault();this.style.borderColor='';handleFileDrop(event)">
            Drop a file or click to attach
            <input type="file" id="agentFileInput" style="display:none" onchange="handleFileSelect(this)">
          </div>
          <div id="agentFileInfo" style="display:none;font-size:10px;color:var(--cyan)"></div>
          <div class="agent-chat__input-row">
            <textarea class="agent-chat__input" id="modalPrompt" rows="1" placeholder="Ask this agent... (Enter to send)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){askAgent();event.preventDefault();}"></textarea>
            <button class="btn btn--primary" id="agentAskBtn" onclick="askAgent()" style="height:36px;padding:0 14px">Send</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="canvasPanel"><div class="cvs-header"><div style="display:flex;align-items:center;gap:8px"><button id="canvasTabC" onclick="canvasShowCanvas()" style="background:none;border:none;border-bottom:2px solid var(--green);color:var(--green);cursor:pointer;font-family:var(--mono);font-size:11px;padding:2px 6px">Canvas</button><button id="canvasTabB" onclick="canvasShowBrowser()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-family:var(--mono);font-size:11px;padding:2px 6px">Browser</button><span id="canvasTitle" style="font-family:var(--mono);color:var(--green);font-size:11px;margin-left:8px">Canvas</span></div><div style="display:flex;align-items:center;gap:4px"><span id="canvasNav" style="display:none;gap:4px"><button onclick="canvasPrev()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Previous">&#x25C0;</button><button onclick="canvasNext()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Next">&#x25B6;</button></span><button onclick="canvasCopyText()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy text content">Copy</button><button onclick="canvasCopyHTML()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy HTML source">HTML</button><button onclick="canvasCopyImage()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy as image">IMG</button><button onclick="toggleCanvasSize()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Resize">&#x2922;</button><button onclick="closeCanvas()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Close">&times;</button></div></div><iframe id="canvasFrame" sandbox="allow-scripts" srcdoc=""></iframe></div>
<div id="agentEditorOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:400;align-items:center;justify-content:center;padding:16px"></div>
<div class="lightbox-overlay" id="lightboxOverlay" onclick="closeLightbox()">
  <span class="lightbox-close" onclick="closeLightbox()">&times;</span>
  <img id="lightboxImg" src="" alt="Preview">
</div>
<script src="/nha-ui.js?v=${ts}"></script>
</body>
</html>`;
}

export function getJS() {
  return JS;
}
