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
    // H1-H4
    var hm = l.match(/^(#{1,4}) (.+)/);
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
  // Update canvas browser tab live if open — show detail view of new page
  var p=document.getElementById('canvasPanel');
  if(p&&p.classList.contains('open')&&canvasMode==='browser'){
    var dBr=getConvCanvasData();
    browserViewIdx=dBr.browsers.length-1;
    renderCanvasPanel();
  }
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
var browserViewIdx=-1;   // -1=gallery, >=0=detail page view
var _canvasFrameLoadedHtml=null; // tracks what is currently loaded in the canvas iframe — avoids reload flicker

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
  // In canvas mode: if list is empty but studioState.canvas exists, use it as a virtual item
  var item=list[idx];
  if(!item && canvasMode==='canvas' && studioState.canvas){
    item={html:studioState.canvas,title:'Studio Report',ts:''};
  }
  // Header title
  var t=document.getElementById('canvasTitle');
  if(t){
    if(canvasMode==='browser'&&browserViewIdx>=0&&d.browsers[browserViewIdx]){
      var bvTitle=d.browsers[browserViewIdx].url||'Page';
      try{var u=new URL(bvTitle);bvTitle=u.hostname+(u.pathname!=='/'?u.pathname:'');}catch(e){}
      t.textContent=bvTitle;
    } else if(canvasMode==='browser'){t.textContent=d.browsers.length>0?d.browsers.length+' pages visited':'No pages visited';}
    else if(!item){t.textContent='Canvas';}
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
  // _canvasFrameLoadedHtml: skip assignment if content unchanged — prevents Safari black flash on tab switch
  var f=document.getElementById('canvasFrame');if(!f)return;
  function setFrameSrcdoc(html){
    if(_canvasFrameLoadedHtml===html)return; // identical content — skip to avoid flicker
    _canvasFrameLoadedHtml=html;
    f.srcdoc=html;
  }
  if(canvasMode==='browser'){
    var d=getConvCanvasData();
    if(d.browsers.length===0){
      setFrameSrcdoc('<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#555"><div style="text-align:center"><div style="font-size:48px;margin-bottom:12px">&#x1F310;</div><div>No pages visited yet</div><div style="font-size:11px;margin-top:8px;color:#333">in this conversation</div><div style="margin-top:16px;font-size:11px;color:#888">Ask me to search or open a page</div></div></body></html>');
    } else if(browserViewIdx>=0&&d.browsers[browserViewIdx]){
      // Detail view: URL bar + screenshot + prev/next + back button
      var bv=d.browsers[browserViewIdx];
      var apiBase=window.API||'';
      var imgSrc=bv.file?apiBase+'/api/screenshots/'+bv.file:(bv.base64?'data:image/jpeg;base64,'+bv.base64:'');
      var total=d.browsers.length;
      var prevBtn=browserViewIdx>0?'<button onclick="window.parent.postMessage({type:\\x27browserNav\\x27,dir:-1},\\x27*\\x27)" style="background:none;border:1px solid #444;color:#aaa;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">&larr;</button>':'<button disabled style="background:none;border:1px solid #222;color:#333;padding:4px 10px;border-radius:4px;font-size:12px">&larr;</button>';
      var nextBtn=browserViewIdx<total-1?'<button onclick="window.parent.postMessage({type:\\x27browserNav\\x27,dir:1},\\x27*\\x27)" style="background:none;border:1px solid #444;color:#aaa;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">&rarr;</button>':'<button disabled style="background:none;border:1px solid #222;color:#333;padding:4px 10px;border-radius:4px;font-size:12px">&rarr;</button>';
      var detail='<html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;display:flex;flex-direction:column;height:100vh;font-family:monospace}.toolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;flex-shrink:0}.back-btn{background:none;border:1px solid #444;color:#00ff41;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap}.url-bar{flex:1;background:#0d0d0d;border:1px solid #333;color:#8ab4f8;padding:4px 8px;border-radius:4px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.counter{color:#555;font-size:11px;white-space:nowrap}.content{flex:1;overflow-y:auto;display:flex;align-items:flex-start;justify-content:center;padding:8px}.content img{max-width:100%;height:auto;display:block;border:1px solid #222;border-radius:4px}.no-img{color:#555;font-size:12px;margin:auto}</style></head><body>';
      detail+='<div class="toolbar"><button class="back-btn" onclick="window.parent.postMessage({type:\\x27browserBack\\x27},\\x27*\\x27)">&#x25C4; All</button>';
      detail+=prevBtn+nextBtn;
      detail+='<div class="url-bar" title="'+bv.url+'">'+bv.url+'</div>';
      detail+='<span class="counter">'+(browserViewIdx+1)+'/'+total+'</span>';
      detail+='</div>';
      detail+='<div class="content">'+(imgSrc?'<img src="'+imgSrc+'" alt="screenshot"/>':'<div class="no-img">No screenshot available</div>')+'</div>';
      detail+='</body></html>';
      setFrameSrcdoc(detail);
    } else {
      // Gallery view
      var apiBase=window.API||'';
      var gallery='<html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;padding:12px;font-family:monospace}h3{color:#00ff41;font-size:12px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.card{background:#1a1a1a;border:1px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .2s}.card:hover{border-color:#00ff41}.card img{width:100%;height:120px;object-fit:cover;display:block;background:#222}.card .info{padding:6px 8px}.card .url{color:#8ab4f8;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card .time{color:#555;font-size:9px;margin-top:2px}</style></head><body><h3>Pages visited ('+d.browsers.length+')</h3><div class="grid">';
      for(var bi=0;bi<d.browsers.length;bi++){
        var b=d.browsers[bi];
        var imgSrc=b.file?apiBase+'/api/screenshots/'+b.file:(b.base64?'data:image/jpeg;base64,'+b.base64:'');
        gallery+='<div class="card" onclick="window.parent.postMessage({type:\\x27selectBrowser\\x27,index:'+bi+'},\\x27*\\x27)">'+(imgSrc?'<img src="'+imgSrc+'" alt="'+b.url+'"/>':'<div style="height:120px;display:flex;align-items:center;justify-content:center;color:#555">No preview</div>')+'<div class="info"><div class="url">'+b.url+'</div><div class="time">'+(b.ts||'')+'</div></div></div>';
      }
      gallery+='</div></body></html>';
      setFrameSrcdoc(gallery);
    }
  } else if(!item){
    // Fallback: if studioState has a canvas (loaded but not yet in allCanvasData), show it directly
    if(studioState.canvas){
      setFrameSrcdoc(studioState.canvas);
    } else {
      setFrameSrcdoc('<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#555"><div style="text-align:center"><div style="font-size:48px;margin-bottom:12px">&#x25A3;</div><div>No canvas content</div><div style="font-size:11px;margin-top:8px;color:#333">in this conversation</div></div></body></html>');
    }
  } else {
    setFrameSrcdoc(item.html);
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
  if(!e.data)return;
  if(e.data.type==='selectBrowser'&&typeof e.data.index==='number'){selectBrowserPage(e.data.index);}
  else if(e.data.type==='browserBack'){browserViewIdx=-1;renderCanvasPanel();}
  else if(e.data.type==='browserNav'){
    var d=getConvCanvasData();
    var next=browserViewIdx+e.data.dir;
    if(next>=0&&next<d.browsers.length){browserViewIdx=next;renderCanvasPanel();}
  }
});
function selectBrowserPage(i){
  browserIdx=i;browserViewIdx=i;canvasMode='browser';renderCanvasPanel();
}
function canvasShowBrowser(){_canvasFrameLoadedHtml=null;var d=getConvCanvasData();browserIdx=d.browsers.length-1;browserViewIdx=-1;canvasMode='browser';renderCanvasPanel();}
function canvasShowCanvas(){
  // Reset iframe tracker so switching back from Browser always reloads Canvas content
  _canvasFrameLoadedHtml=null;
  canvasMode='canvas';
  var d=getConvCanvasData();
  canvasIdx=Math.max(0,d.canvases.length-1);
  renderCanvasPanel();
}

function onConversationSwitch(){
  // Called when user switches conversation  -  update canvas panel
  _canvasFrameLoadedHtml = null; // new conversation = new iframe content
  var p=document.getElementById('canvasPanel');
  if(p&&p.classList.contains('open')){
    var d=getConvCanvasData();
    canvasIdx=d.canvases.length-1;
    browserIdx=d.browsers.length-1;
    browserViewIdx=-1;
    renderCanvasPanel();
  }
}

function openCanvasPanel(){
  var cp = document.getElementById('canvasPanel');
  if (!cp) return;
  cp.classList.add('open');
  // Always reset tracker so renderCanvasPanel reloads fresh content
  _canvasFrameLoadedHtml = null;
  canvasMode = 'canvas';
  var d = getConvCanvasData();
  canvasIdx = Math.max(0, d.canvases.length - 1);
  renderCanvasPanel();
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
function canvasDownloadHTML(){
  var d=getConvCanvasData();var item=d.canvases[canvasIdx];
  var html=(item&&item.html)||studioState.canvas;
  if(!html){alert('No dashboard to download');return;}
  var t=document.getElementById('canvasTitle');
  var name=((t&&t.textContent)||'NHA-Dashboard').slice(0,60).replace(/[^a-z0-9\s]/gi,'').trim().replace(/\s+/g,'-')||'NHA-Dashboard';
  var blob=new Blob([html],{type:'text/html'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download=name+'.html';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);},5000);
}
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
  var parlEl = document.getElementById('studioParliamentBlock');
  if (parlEl) { parlEl.innerHTML = ''; parlEl.style.display = 'none'; }
  var canvasBtn = document.getElementById('studioCanvasBtn');
  if (canvasBtn) { canvasBtn.style.background = ''; canvasBtn.style.borderColor = ''; canvasBtn.style.color = 'var(--dim)'; }
  _canvasFrameLoadedHtml = null; // reset iframe tracker so next open always loads fresh
  closeCanvas();
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

// ── Workflow node character SVG ──────────────────────────────────────────────
// Generates a compact animated "agent at desk" illustration for each pipeline node card.
// isRunning = prl-arm/prl-head animations active; isDone = green checkmark.
function buildWorkflowChar(n) {
  var lbl = n.label || n.agent || \x27?\x27;
  var ico = n.icon || \x27&#9632;\x27;
  var isActive = n.status === \x27running\x27;
  var isDone = n.status === \x27done\x27;
  var skinColors = [\x27#fbbf24\x27,\x27#f97316\x27,\x27#a78bfa\x27,\x27#34d399\x27,\x27#60a5fa\x27,\x27#f472b6\x27];
  var skinIdx = Math.abs((lbl.charCodeAt(0)||65)+(lbl.charCodeAt(lbl.length-1)||90)) % skinColors.length;
  var skin = skinColors[skinIdx];
  var shirtColors = [\x27#4f46e5\x27,\x27#0891b2\x27,\x27#7c3aed\x27,\x27#059669\x27,\x27#dc2626\x27,\x27#d97706\x27];
  var shirt = shirtColors[skinIdx];
  var hairColors = [\x27#1a1a1a\x27,\x27#4a3728\x27,\x27#c4a35a\x27,\x27#8b0000\x27,\x27#2c4a7c\x27,\x27#3d2b1f\x27];
  var hair = hairColors[skinIdx];
  var accentColor = isActive ? \x27#6366f1\x27 : (isDone ? \x27#22c55e\x27 : \x27#333360\x27);
  var deskBg = isDone ? \x27#1a3a1a\x27 : (isActive ? \x27#1a1a3e\x27 : \x27#1a1a2a\x27);
  var monGlow = isActive ? \x27filter:drop-shadow(0 0 4px #6366f1)\x27 : \x27\x27;
  var armCls = isActive ? \x27class="prl-arm"\x27 : \x27\x27;
  var headCls = isActive ? \x27class="prl-head"\x27 : \x27\x27;
  var glowStyle = isActive ? \x27filter:drop-shadow(0 0 5px #6366f1)\x27 : \x27\x27;
  var svg = \x27<svg viewBox="0 0 80 96" width="70" height="84" xmlns="http://www.w3.org/2000/svg" style="\x27+glowStyle+\x27;display:block;margin:0 auto">\x27+
    // Desk
    \x27<path d="M4 55 L76 55 L76 63 L4 63 Z" fill="\x27+deskBg+\x27" stroke="\x27+accentColor+\x27" stroke-width="1.2"/>\x27+
    \x27<path d="M4 63 L76 63 L76 70 L4 70 Z" fill="#0e0e1c"/>\x27+
    \x27<line x1="4" y1="63" x2="76" y2="63" stroke="\x27+accentColor+\x2760" stroke-width=".8"/>\x27+
    \x27<path d="M10 70 C10 70 9 82 9 84 C9 86 11 87 13 87 C15 87 17 86 17 84 C17 82 16 70 16 70 Z" fill="#111128"/>\x27+
    \x27<path d="M63 70 C63 70 62 82 62 84 C62 86 64 87 66 87 C68 87 70 86 70 84 C70 82 69 70 69 70 Z" fill="#111128"/>\x27+
    \x27<rect x="17" y="79" width="46" height="3" rx="1.5" fill="#161626"/>\x27+
    // Monitor
    \x27<ellipse cx="35" cy="56" rx="14" ry="2" fill="rgba(0,0,0,.4)"/>\x27+
    \x27<ellipse cx="35" cy="57" rx="7" ry="1.5" fill="#1a1a2e"/>\x27+
    \x27<rect x="33" y="50" width="4" height="6" rx="1" fill="#1a1a2e"/>\x27+
    \x27<rect x="17" y="26" width="36" height="25" rx="4" fill="#050510"/>\x27+
    \x27<rect x="18" y="27" width="34" height="23" rx="3" fill="#0d0d20" stroke="\x27+accentColor+\x27" stroke-width="\x27+(isActive?\x272\x27:\x271\x27)+\x27" style="\x27+monGlow+\x27"/>\x27+
    \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="#0a0a18"/>\x27+
    (isActive ?
      \x27<defs><linearGradient id="wsg\x27+skinIdx+\x27" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366f122"/><stop offset="1" stop-color="#6366f108"/></linearGradient></defs>\x27+
      \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="url(#wsg\x27+skinIdx+\x27)"/>\x27+
      \x27<line x1="22" y1="32" x2="48" y2="32" stroke="#6366f1ee" stroke-width="1.2" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="35" x2="44" y2="35" stroke="#6366f1aa" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="38" x2="46" y2="38" stroke="#6366f188" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="41" x2="40" y2="41" stroke="#6366f166" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="44" x2="43" y2="44" stroke="#6366f144" stroke-width="1" stroke-linecap="round"/>\x27
      :
      \x27<line x1="22" y1="33" x2="46" y2="33" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="36" x2="42" y2="36" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="39" x2="44" y2="39" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="42" x2="38" y2="42" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27
    )+
    \x27<circle cx="35" cy="28.2" r=".9" fill="\x27+(isActive?\x27#6366f1\x27:\x27#2a2a40\x27)+\x27"/>\x27+
    // Keyboard
    \x27<rect x="13" y="48" width="36" height="7" rx="2.5" fill="#0c0c1e" stroke="#202036" stroke-width="1"/>\x27+
    \x27<rect x="14" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="18" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="22" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="26" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="30" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="34" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="38" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="15" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="21" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="27" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="33" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
    \x27<rect x="19" y="55" width="24" height="1.8" rx=".9" fill="#181830"/>\x27+
    // Chair
    \x27<ellipse cx="34" cy="72" rx="12" ry="4" fill="#111124"/>\x27+
    \x27<rect x="32" y="65" width="4" height="8" rx="1" fill="#1a1a2c"/>\x27+
    \x27<path d="M22 60 Q22 56 34 56 Q46 56 46 60 L46 66 Q46 68 34 68 Q22 68 22 66 Z" fill="#1c1c2c" stroke="#2a2a3e" stroke-width="1"/>\x27+
    \x27<path d="M24 44 Q23 38 34 37 Q45 38 44 44 L44 58 Q44 60 34 60 Q24 60 24 58 Z" fill="#191928" stroke="#2a2a3c" stroke-width="1"/>\x27+
    \x27<path d="M26 46 Q26 41 34 40 Q42 41 42 46 L42 57 Q42 58 34 58 Q26 58 26 57 Z" fill="#1e1e30"/>\x27+
    // Shirt
    \x27<path d="M27 44 Q27 42 34 41 Q41 42 41 44 L42 58 L26 58 Z" fill="\x27+shirt+\x27"/>\x27+
    \x27<path d="M27 44 Q27 42 34 41 L34 58 L26 58 Z" fill="rgba(0,0,0,.12)"/>\x27+
    \x27<path d="M34 41 L31 46 L34 44.5 L37 46 Z" fill="\x27+skin+\x27ee"/>\x27+
    // Arms
    \x27<g \x27+armCls+\x27>\x27+
    \x27<path d="M28 45 C24 47 22 50 21 53 C21 55 23 56 25 55 C27 54 27 52 28 49 Z" fill="\x27+shirt+\x27"/>\x27+
    \x27<path d="M21 53 C19 55 18 57 18 59 C18 61 20 62 22 61 C24 60 24 58 25 55 Z" fill="\x27+skin+\x27"/>\x27+
    \x27<ellipse cx="19" cy="60" rx="4" ry="3" fill="\x27+skin+\x27" transform="rotate(-10 19 60)"/>\x27+
    \x27<path d="M40 45 C44 47 46 50 47 53 C47 55 45 56 43 55 C41 54 41 52 40 49 Z" fill="\x27+shirt+\x27"/>\x27+
    \x27<path d="M47 53 C49 55 50 57 50 59 C50 61 48 62 46 61 C44 60 44 58 43 55 Z" fill="\x27+skin+\x27"/>\x27+
    \x27<ellipse cx="49" cy="60" rx="4" ry="3" fill="\x27+skin+\x27" transform="rotate(10 49 60)"/>\x27+
    \x27</g>\x27+
    // Head
    \x27<g \x27+headCls+\x27>\x27+
    \x27<path d="M30 40 L38 40 L38 43 Q38 45 34 45 Q30 45 30 43 Z" fill="\x27+skin+\x27"/>\x27+
    \x27<ellipse cx="34" cy="29" rx="11" ry="12.5" fill="\x27+skin+\x27"/>\x27+
    \x27<path d="M23 28 C21 28 20 30 20 31.5 C20 33 21 34.5 23 34.5 C24 34.5 24.5 33.5 24 31.5 C24.5 29.5 24 28 23 28" fill="\x27+skin+\x27"/>\x27+
    \x27<path d="M45 28 C47 28 48 30 48 31.5 C48 33 47 34.5 45 34.5 C44 34.5 43.5 33.5 44 31.5 C43.5 29.5 44 28 45 28" fill="\x27+skin+\x27"/>\x27+
    \x27<path d="M23 28 C22 22 24 16 34 15 C44 16 46 22 45 28 C44 22 42 18 34 17 C26 18 24 22 23 28" fill="\x27+hair+\x27"/>\x27+
    \x27<path d="M28 17 C30 15 33 15 36 16 C33 14 29 15 28 17" fill="rgba(255,255,255,.12)"/>\x27+
    \x27<path d="M27 23 Q29.5 21.5 32 23" stroke="\x27+hair+\x27" stroke-width="1.6" fill="none" stroke-linecap="round"/>\x27+
    \x27<path d="M36 23 Q38.5 21.5 41 23" stroke="\x27+hair+\x27" stroke-width="1.6" fill="none" stroke-linecap="round"/>\x27+
    \x27<ellipse cx="30" cy="27.5" rx="3" ry="3.5" fill="#fff"/>\x27+
    \x27<ellipse cx="38" cy="27.5" rx="3" ry="3.5" fill="#fff"/>\x27+
    \x27<circle cx="30" cy="28" r="2.2" fill="#3d4a6b"/>\x27+
    \x27<circle cx="38" cy="28" r="2.2" fill="#3d4a6b"/>\x27+
    \x27<circle cx="30" cy="28" r="1.3" fill="#0a0a14"/>\x27+
    \x27<circle cx="38" cy="28" r="1.3" fill="#0a0a14"/>\x27+
    \x27<circle cx="31" cy="27" r=".8" fill="rgba(255,255,255,.9)"/>\x27+
    \x27<circle cx="39" cy="27" r=".8" fill="rgba(255,255,255,.9)"/>\x27+
    \x27<path d="M33 31 Q33 33 34 33.5 Q35 34 35 33 Q36 33 36 31" stroke="\x27+skin+\x27" stroke-width="1.1" fill="none" opacity=".7"/>\x27+
    (isDone ?
      \x27<path d="M29 37 Q34 42 39 37" stroke="#8b4513" stroke-width="1.8" fill="none" stroke-linecap="round"/>\x27+
      \x27<path d="M30 37.5 Q34 41 38 37.5 Q34 40 30 37.5" fill="#fff" opacity=".8"/>\x27
      :
      \x27<path d="M30.5 37 Q34 38.5 37.5 37" stroke="#8b4513" stroke-width="1.4" fill="none" stroke-linecap="round"/>\x27
    )+
    \x27<circle cx="38.5" cy="48" r="5.5" fill="#0f0f1e" stroke="\x27+shirt+\x2780" stroke-width="1.2"/>\x27+
    \x27<circle cx="38.5" cy="48" r="4" fill="#161622"/>\x27+
    \x27<text x="38.5" y="51" text-anchor="middle" font-size="6">\x27+ico+\x27</text>\x27+
    \x27</g>\x27+
    (isDone ?
      \x27<circle cx="67" cy="9" r="9" fill="#0a2010"/>\x27+
      \x27<circle cx="67" cy="9" r="7" fill="#16a34a"/>\x27+
      \x27<circle cx="67" cy="9" r="5.5" fill="#22c55e"/>\x27+
      \x27<path d="M63 9 L66 12 L71 5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>\x27
      : \x27\x27)+
    // Flying papers when running
    (isActive ?
      \x27<g class="prl-fly-doc" style="animation-delay:.2s;animation-duration:1.6s;transform-origin:35px 50px">\x27+
      \x27<path d="M0,0 L11,0 L14,3 L14,18 L0,18 Z" fill="#0d0d20" stroke="#6366f1" stroke-width="1.2" transform="translate(35,50)"/>\x27+
      \x27<line x1="37" y1="53" x2="47" y2="53" stroke="#6366f1" stroke-width=".8" opacity=".7"/>\x27+
      \x27<line x1="37" y1="56" x2="47" y2="56" stroke="#6366f1" stroke-width=".8" opacity=".5"/>\x27+
      \x27</g>\x27
      : \x27\x27)+
    \x27</svg>\x27;
  return svg;
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
    var isActive = n.status === 'running';
    var isDone = n.status === 'done';
    var isErr = n.status === 'error';
    var isWait = !isActive && !isDone && !isErr;
    var cls = 'studio-node';
    if (isActive) cls += ' studio-node--active';
    else if (isDone) cls += ' studio-node--done';
    else if (isErr) cls += ' studio-node--error';
    // Only animate entrance on first appearance
    var style = n._rendered ? '' : 'animation-delay:' + (i * 110) + 'ms';
    html += '<div class="' + cls + '" data-agent-label="' + esc(n.label || n.agent) + '" style="' + style + ';cursor:pointer" onclick="studioScrollToAgent(this.getAttribute(String.fromCharCode(100,97,116,97,45,97,103,101,110,116,45,108,97,98,101,108)))" title="' + esc(n.label || n.agent) + '">';
    if (isActive || isDone) {
      // Show animated office character
      html += '<div class="studio-node__char">' + buildWorkflowChar(n) + '</div>';
      if (isActive) {
        var desc = n.label || n.agent;
        html += '<div class="studio-node__bubble prl-action-bubble prl-action-bubble--active">...analizza</div>';
      } else {
        html += '<div class="studio-node__bubble prl-action-bubble" style="background:#0a2010;border-color:#22c55e;color:#4ade80">\u2714 completato</div>';
      }
      html += '<div class="studio-node__label studio-node__label--char">' + esc(n.label) + '</div>';
    } else {
      // Waiting / error: keep original compact pill
      html += '<div class="studio-node__circle">' + n.icon + '</div>';
      html += '<div class="studio-node__label">' + esc(n.label) + '</div>';
    }
    if (n.reason) {
      html += '<div class="studio-node__reason" onclick="event.stopPropagation();this.classList.toggle(String.fromCharCode(111,112,101,110))" title="' + esc(n.reason) + '">&#x2139;<span class="studio-node__reason-tip">' + esc(n.reason) + '</span></div>';
    }
    html += '</div>';
    if (i < studioState.nodes.length - 1) {
      var next = studioState.nodes[i + 1];
      var arrowCls = 'studio-arrow';
      if (isDone && next.status === 'running') arrowCls += ' studio-arrow--active';
      else if (isDone) arrowCls += ' studio-arrow--done';
      var arrowStyle = n._rendered ? '' : 'opacity:0;animation:stNodeIn .3s ease ' + (i * 110 + 55) + 'ms forwards';
      html += '<div class="' + arrowCls + '" style="' + arrowStyle + '">&#8594;</div>';
    }
    n._rendered = true;
  });
  html += '</div>';
  el.innerHTML = html;
}

function studioScrollToAgent(agentLabel) {
  var logEl = document.getElementById('studioLog');
  if (!logEl) return;
  var entries = logEl.querySelectorAll('.studio-log-entry');
  var target = null;
  var labelLow = agentLabel.toLowerCase();
  // Pass 1: exact match
  for (var i2 = 0; i2 < entries.length; i2++) {
    var agentSpan = entries[i2].querySelector('.studio-log-entry__agent');
    if (agentSpan && agentSpan.textContent.trim() === agentLabel) { target = entries[i2]; break; }
  }
  // Pass 2: startsWith (handles Parliament label that changes to "ATHENA ⇄ ...")
  if (!target) {
    for (var i3 = 0; i3 < entries.length; i3++) {
      var sp = entries[i3].querySelector('.studio-log-entry__agent');
      if (sp && (sp.textContent.trim().toLowerCase().indexOf(labelLow) === 0 || labelLow.indexOf(sp.textContent.trim().toLowerCase()) === 0)) { target = entries[i3]; break; }
    }
  }
  // Pass 3: contains (for Parliament: "Parlamento" matches any log entry with that word)
  if (!target) {
    for (var i4 = 0; i4 < entries.length; i4++) {
      var sp2 = entries[i4].querySelector('.studio-log-entry__agent');
      if (sp2 && sp2.textContent.trim().toLowerCase().indexOf(labelLow.slice(0,8)) >= 0) { target = entries[i4]; break; }
    }
  }
  if (target) {
    var logContainer = document.querySelector('.studio-log');
    if (logContainer) {
      var entryTop = target.offsetTop - logContainer.offsetTop;
      logContainer.scrollTo({top: entryTop - 8, behavior: 'smooth'});
    } else {
      target.scrollIntoView({behavior:'smooth', block:'start'});
    }
    target.style.outline = '2px solid var(--green)';
    setTimeout(function(){ target.style.outline = ''; }, 1800);
  }
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

  // Always generate the full Studio PDF with all agent outputs.
  // The canvas panel is already open for the HTML dashboard — PDF = complete structured report.

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
      // Headers (H1-H4)
      if (trimmed.slice(0,5) === '#### ') { closeAll(); out += '<h4>' + inlineFormat(trimmed.slice(5)) + '</h4>'; continue; }
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

  // ── Helper: detect if a markdown string has real body content (not just headings/blanks)
  function hasBodyContent(raw) {
    var NL3 = String.fromCharCode(10);
    var lines = raw.split(NL3);
    for (var bi = 0; bi < lines.length; bi++) {
      var t = lines[bi].trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t)) continue; // heading-only
      if (/^---+$/.test(t)) continue; // hr
      return true; // has real content
    }
    return false;
  }

  // ── Section HTML ──────────────────────────────────────────────────────────
  var sectionsHtml = activeNodes.map(function(n, idx) {
    var agentColor = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#0284c7'][idx % 7];
    var tokIn = n.tokensIn || 0; var tokOut = n.tokensOut || 0; var tokTotal = tokIn + tokOut;
    var tokBadge = tokTotal > 0
      ? '<span style="margin-left:auto;font-size:10px;color:#9ca3af;font-family:monospace;white-space:nowrap">&#x2B06;' + tokIn.toLocaleString() + ' &#x2B07;' + tokOut.toLocaleString() + ' tok</span>'
      : '';
    // Strip empty sub-sections: find heading lines that have no body content before the next heading
    var NL3 = String.fromCharCode(10);
    var rawLines = (n.output || '').split(NL3);
    var cleanedLines = [];
    var pendingHeadings = [];
    for (var si = 0; si < rawLines.length; si++) {
      var sl = rawLines[si].trim();
      if (/^#{1,6}\s/.test(sl) || /^---+$/.test(sl)) {
        pendingHeadings.push(rawLines[si]);
      } else if (sl !== '') {
        // Real content — flush pending headings then add this line
        for (var ph = 0; ph < pendingHeadings.length; ph++) { cleanedLines.push(pendingHeadings[ph]); }
        pendingHeadings = [];
        cleanedLines.push(rawLines[si]);
      } else {
        // Blank line — flush pending headings only if we already have content
        if (cleanedLines.length > 0) {
          for (var ph2 = 0; ph2 < pendingHeadings.length; ph2++) { cleanedLines.push(pendingHeadings[ph2]); }
          pendingHeadings = [];
          cleanedLines.push(rawLines[si]);
        }
      }
    }
    var cleanedOutput = cleanedLines.join(NL3);
    return '<div class="section">' +
      '<div class="agent-header" style="border-left-color:' + agentColor + '">' +
        '<span class="agent-icon">' + (n.icon||'&#9632;') + '</span>' +
        '<div style="flex:1"><div class="agent-name">' + esc(n.label||n.agent) + '</div>' +
        '<div class="agent-sub">' + esc(n.agent) + ' &nbsp;&#183;&nbsp; Step ' + (idx+1) + ' di ' + activeNodes.length + '</div></div>' +
        tokBadge +
      '</div>' +
      '<div class="section-body">' + mdToPdfHtml(cleanedOutput) + '</div>' +
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
    '.section-body h4{font-size:12px;font-weight:600;color:#6366f1;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.4px}' +
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

  // Generate PDF — injects print-safe CSS then uses html2canvas at 2.5x for crisp output.
  // Page breaks are avoided inside .section/.card/.priority-item by injecting break-inside:avoid.
  var pdfFileName = (studioState.task || 'NHA Studio Report').slice(0, 60).replace(/[^a-z0-9\s]/gi,'').trim().replace(/\s+/g,'-') + '.pdf';
  function doGeneratePdf() {
    var btn2 = document.getElementById('studioInlinePdfBtn');
    var dlBtn2 = document.querySelector('button[onclick="downloadStudioPDF()"]');
    function setBusy(b) {
      if (btn2) { btn2.disabled = b; btn2.textContent = b ? 'Generando PDF...' : '\u2913 PDF'; }
      if (dlBtn2) { dlBtn2.disabled = b; dlBtn2.textContent = b ? 'Generando PDF...' : '\u2913 Download PDF'; }
    }
    setBusy(true);

    // Inject page-break-safe CSS into the HTML before rendering
    var printCss = '<style>body{padding:20px!important;max-width:800px!important;margin:0 auto!important}' +
      '.section,.card,.priority-item,.source-item,.bar-row{break-inside:avoid;page-break-inside:avoid}' +
      '.header{break-after:avoid;page-break-after:avoid}' +
      'h1,h2,h3,h4{break-after:avoid;page-break-after:avoid}' +
      '@media print{body{background:#fff!important;color:#111!important}' +
      '.header{background:linear-gradient(135deg,#4f46e5,#06b6d4)!important;-webkit-print-color-adjust:exact}' +
      '.section{background:#f8f9fa!important;border:1px solid #e0e0e0!important}' +
      '.section-title{color:#4f46e5!important}}</style>';
    var pdfHtml = html.replace('</head>', printCss + '</head>');

    // Inject light-mode overrides for PDF — dark backgrounds become unreadable on paper
    var lightOverride = '<style>' +
      'body{background:#ffffff!important;color:#1a1a2e!important;padding:28px!important;max-width:760px!important;margin:0 auto!important}' +
      '.header{background:linear-gradient(135deg,#4f46e5 0%,#06b6d4 100%)!important;-webkit-print-color-adjust:exact!important;color-adjust:exact!important}' +
      '.header h1,.header p,.meta span{color:#fff!important}' +
      '.card,.section{background:#f4f6fb!important;border:1px solid #dde1ee!important}' +
      '.card h3,.section h3,.section-title,.card-label{color:#4f46e5!important}' +
      '.card p,.section p,ul li,ol li{color:#374151!important}' +
      '.priority-item{background:#eef0f8!important}' +
      '.priority-item h4{color:#1a1a2e!important}' +
      '.priority-item p{color:#374151!important}' +
      '.source-item{background:#eef0f8!important;border-left-color:#4f46e5!important}' +
      '.source-item h4{color:#1a1a2e!important}' +
      '.source-item p{color:#374151!important}' +
      '.bar-track{background:#e0e4ef!important}' +
      '.footer{color:#9ca3af!important}' +
      'a{color:#4f46e5!important}' +
      '.section,.card,.priority-item,.source-item,.bar-row{break-inside:avoid;page-break-inside:avoid}' +
      'h1,h2,h3,h4{break-after:avoid;page-break-after:avoid}' +
      '.header{break-after:avoid;page-break-after:avoid}' +
      '.section-body h4{font-size:12px;font-weight:600;color:#6366f1!important;margin:10px 0 4px;text-transform:uppercase;letter-spacing:.4px}' +
      '</style>';
    var pdfHtml2 = html.replace('</head>', lightOverride + '</head>');

    // Build hidden iframe at 794px (A4 width at 96dpi = 210mm)
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;height:1px;border:none;visibility:hidden';
    document.body.appendChild(iframe);
    var ifrDoc = iframe.contentDocument || iframe.contentWindow.document;
    ifrDoc.open(); ifrDoc.write(pdfHtml2); ifrDoc.close();
    iframe.onload = function() {
      var ifrBody = ifrDoc.body;
      var totalH = Math.max(ifrBody.scrollHeight, ifrBody.offsetHeight, ifrDoc.documentElement.scrollHeight);
      iframe.style.height = totalH + 'px';

      // Collect smart page-break candidates using offsetTop (document-relative, not viewport-relative).
      // We use offsetTop + offsetHeight of each .section element so breaks land after each agent section.
      var breakCandidates = [0];
      var sectionEls = ifrDoc.querySelectorAll('.section,.cover,.toc,.workflow-bar');
      for (var si2 = 0; si2 < sectionEls.length; si2++) {
        var el2 = sectionEls[si2];
        // Walk up to get absolute offsetTop within the iframe document
        var absTop = 0; var cur = el2;
        while (cur && cur !== ifrDoc.body) { absTop += cur.offsetTop; cur = cur.offsetParent; }
        breakCandidates.push(absTop); // start of section (new page begins here)
        breakCandidates.push(absTop + el2.offsetHeight); // end of section
      }
      breakCandidates.push(totalH);
      breakCandidates.sort(function(a,b){ return a-b; });
      // Deduplicate
      breakCandidates = breakCandidates.filter(function(v,i,a){ return i===0||v!==a[i-1]; });

      // Scale: 3x on HiDPI screens, minimum 2.5x for sharp text at A4
      var renderScale = Math.max(2.5, Math.min(3, window.devicePixelRatio * 1.5));
      window.html2canvas(ifrBody, {
        scale: renderScale,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        width: 794,
        windowWidth: 794,
        scrollX: 0,
        scrollY: 0,
        logging: false,
        imageTimeout: 15000,
        ignoreElements: function(el){ return el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT'; }
      }).then(function(canvas) {
        var pdf = new window.jspdf.jsPDF({orientation:'portrait', unit:'pt', format:'a4', compress:true});
        var pageW = pdf.internal.pageSize.getWidth();   // 595.28pt
        var pageH = pdf.internal.pageSize.getHeight();  // 841.89pt
        var margin = 28; // pt — ~10mm margins
        var usableW = pageW - margin * 2;
        var usableH = pageH - margin * 2;

        // px per rendered page: canvas.width / usableW gives canvas-px per pt;
        // usableH (pt) * that ratio = canvas px per A4 usable page height
        var pxPerPt = canvas.width / usableW;
        var maxSliceH = Math.floor(usableH * pxPerPt); // max canvas px per page

        // Convert DOM break candidates to canvas px coordinates
        // (DOM px * renderScale because html2canvas renders at renderScale)
        var canvasBreaks = breakCandidates.map(function(domPx){ return Math.round(domPx * renderScale); });

        // Smart page-break slicer: each slice ends at the nearest break candidate that fits within maxSliceH.
        // Falls back to hard-cut only when a single section is taller than one full page.
        var yCanvas = 0;
        var pageNum = 0;
        while (yCanvas < canvas.height) {
          if (pageNum > 0) pdf.addPage();
          var maxEnd = yCanvas + maxSliceH;
          // Find the largest break candidate <= maxEnd (that is also > yCanvas)
          var bestBreak = -1;
          for (var bi2 = 0; bi2 < canvasBreaks.length; bi2++) {
            var bp = canvasBreaks[bi2];
            if (bp > yCanvas && bp <= maxEnd) { bestBreak = bp; }
          }
          // If no break found (section taller than a page), hard-cut at maxEnd
          var sliceEnd = (bestBreak > yCanvas) ? bestBreak : Math.min(maxEnd, canvas.height);
          var thisSlice = sliceEnd - yCanvas;
          if (thisSlice <= 0) break; // safety guard

          var sliceCanvas = document.createElement('canvas');
          sliceCanvas.width = canvas.width;
          sliceCanvas.height = thisSlice;
          var ctx = sliceCanvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
          ctx.drawImage(canvas, 0, yCanvas, canvas.width, thisSlice, 0, 0, canvas.width, thisSlice);
          var sliceData = sliceCanvas.toDataURL('image/png');
          // Proportional height in pt: thisSlice / pxPerPt
          var sliceImgH = thisSlice / pxPerPt;
          pdf.addImage(sliceData, 'PNG', margin, margin, usableW, sliceImgH, '', 'FAST');
          yCanvas = sliceEnd;
          pageNum++;
        }
        pdf.save(pdfFileName);
        document.body.removeChild(iframe);
        setBusy(false);
      }).catch(function(e2) {
        document.body.removeChild(iframe);
        setBusy(false);
        alert('PDF error: ' + e2.message);
      });
    };
  }
  // Load jsPDF + html2canvas from CDN if not already loaded
  if (window.jspdf && window.html2canvas) {
    doGeneratePdf();
  } else {
    var loaded = 0;
    function onLibLoad() { loaded++; if (loaded >= 2) doGeneratePdf(); }
    if (!window.html2canvas) {
      var s1 = document.createElement('script');
      s1.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s1.onload = onLibLoad; document.head.appendChild(s1);
    } else { loaded++; }
    if (!window.jspdf) {
      var s2 = document.createElement('script');
      s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      s2.onload = onLibLoad; document.head.appendChild(s2);
    } else { loaded++; }
    if (loaded >= 2) doGeneratePdf();
  }
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
    '<button onclick="downloadStudioPDF()" title="Genera e scarica il report come PDF" style="display:inline-flex;align-items:center;gap:6px;padding:8px 18px;background:linear-gradient(135deg,#4f46e5,#2563eb);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.3px;box-shadow:0 2px 8px rgba(79,70,229,.35)">&#x2913; Download PDF</button>' +
    '<span style="font-size:11px;color:var(--dim)">Scarica il report completo come file PDF</span>' +
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
  var parlBlockEl = document.getElementById('studioParliamentBlock');
  if (parlBlockEl) parlBlockEl.style.display = 'none';
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
      return {icon: s.icon, agent: s.agent, label: s.label, reason: s.reason || '', status: 'waiting'};
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
      var NL = String.fromCharCode(10);
      if (stepResult.error) {
        studioSetNodeStatus(i, 'error');
        studioLog(node.label, node.icon, 'Error: ' + stepResult.error, 'error');
        // For live-data/tool agents (first steps), a failure is critical — stop
        // For specialist/synthesis agents, log the error in context and continue
        var isEarlyToolStep = (node.agent === 'EmailAgent' || node.agent === 'CalendarAgent' || node.agent === 'GitHubAgent' || node.agent === 'WebSearchAgent' || node.agent === 'BrowserAgent');
        if (isEarlyToolStep && i === 0) { break; }
        // Non-critical: inject error note into context so CanvasAgent can note the gap
        var errNote = '## ' + node.label + ':' + NL + '[Agent unavailable: ' + stepResult.error.slice(0, 120) + ']';
        context = context ? context + NL + NL + '---' + NL + errNote : errNote;
        studioState.nodes[i].output = errNote;
        continue; // proceed to next agent
      }
      studioSetNodeStatus(i, 'done');
      var realOutput = (stepResult.output && stepResult.output !== '(no output)') ? stepResult.output : null;
      studioState.nodes[i].output = realOutput || '';
      studioState.nodes[i].tokensIn = stepResult.tokensIn || 0;
      studioState.nodes[i].tokensOut = stepResult.tokensOut || 0;
      studioLog(node.label, node.icon, realOutput || (stepResult.canvas ? '[Canvas report generated]' : '(done)'), 'agent', true);
      // allCanvasData already updated inside runStudioStep streaming handler.
      // Keep _canvasFrameLoadedHtml in sync so openCanvasPanel knows what\x27s loaded.
      // Accumulate context: append each step's output so specialist agents see ALL previous data
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
        // Add Parliament node to pipeline visual
        var parlNodeIdx = studioState.nodes.length;
        studioState.nodes.push({icon:\x27&#x2656;\x27, agent:\x27Parliament\x27, label:\x27Parlamento\x27, status:\x27running\x27, output:\x27\x27, _rendered:false});
        renderStudioNodes();

        // ── Parliament visual block ──────────────────────────────────────
        // Track active R2 agent for visual block
        var parlActiveAgent = null;
        var parlDoneAgents = {};

        function renderParlBlock(phase, activeLabel, convergence) {
          var pb = document.getElementById(\x27studioParliamentBlock\x27);
          if (!pb) return;
          pb.style.display = \x27block\x27;
          if (convergence != null) {
            pb.style.position = \x27\x27; pb.style.top = \x27\x27; pb.style.zIndex = \x27\x27; pb.style.boxShadow = \x27\x27;
          } else {
            pb.style.position = \x27sticky\x27; pb.style.top = \x278px\x27; pb.style.zIndex = \x27200\x27;
            pb.style.boxShadow = \x270 4px 32px rgba(99,102,241,.35)\x27;
          }

          // ── OFFICE CARTOON ANIMATION ─────────────────────────────────────────
          // Each agent = a character at a desk doing visible work.
          // Documents fly between agents during R2. MASTER walks around in R1.
          var phaseColor = {r1:\x27#6366f1\x27,r2:\x27#22d3ee\x27,r3:\x27#f59e0b\x27,done:\x27#22c55e\x27}[phase]||\x27#6366f1\x27;
          var phaseLabel = {
            r1:\x27Round 1 \u2014 Ogni agente analizza il task in autonomia\x27,
            r2:\x27Round 2 \u2014 Gli agenti si scambiano le analisi e le raffinano\x27,
            r3:\x27Round 3 \u2014 HERALD media le posizioni divergenti\x27,
            done:\x27Deliberazione completata\x27
          }[phase]||\x27\x27;

          var n = proposals.length;
          var doneCount = Object.keys(parlDoneAgents).length;
          var progressPct = n > 0 ? Math.round(doneCount / n * 100) : 0;

          // ── Build one desk+character card per agent ───────────────────────
          // Character is SVG-drawn inline: head + body + arms + desk.
          // Active = character types (arms animate). Done = character leans back, checkmark.
          // R2 active = character holds document up and turns head.

          function buildChar(prop, isDone, isActive, isOrchestratorTarget) {
            var lbl = prop.label || prop.agent;
            var ico = prop.icon || String.fromCharCode(9632);
            // skin tones cycle through a palette for visual variety
            var skinColors = [\x27#fbbf24\x27,\x27#f97316\x27,\x27#a78bfa\x27,\x27#34d399\x27,\x27#60a5fa\x27,\x27#f472b6\x27];
            var skinIdx = Math.abs(lbl.charCodeAt(0)+lbl.charCodeAt(lbl.length-1)) % skinColors.length;
            var skin = skinColors[skinIdx];
            var deskColor = isDone ? \x27#1a3a1a\x27 : (isActive ? \x27#1a1a3e\x27 : \x27#1a1a2a\x27);
            var deskBorder = isDone ? \x27#22c55e\x27 : (isActive ? phaseColor : \x27#333360\x27);
            var shadow = isActive ? (\x270 0 18px \x27+phaseColor+\x2744\x27) : \x27none\x27;

            // Action text shown above character
            var actionStr = \x27\x27;
            if (phase===\x27r1\x27 && isActive) actionStr = \x27...analizza\x27;
            else if (phase===\x27r1\x27 && isDone) actionStr = \x27\u2714 bozza pronta\x27;
            else if (phase===\x27r2\x27 && isActive) actionStr = \x27...legge + raffina\x27;
            else if (phase===\x27r2\x27 && isDone) actionStr = \x27\u2714 raffinato\x27;
            else if (phase===\x27r3\x27 && isActive) actionStr = \x27...media\x27;
            else if (phase===\x27done\x27) actionStr = \x27\u2714 consenso\x27;

            // SVG character (80px wide, 70px tall)
            // Desk: rectangle at bottom. Chair back. Body. Head. Arms animated.
            var armAnim = (isActive && phase!==\x27done\x27) ? \x27class="prl-arm"\x27 : \x27\x27;
            var headAnim = (isActive && phase!==\x27done\x27) ? \x27class="prl-head"\x27 : \x27\x27;
            var glowStyle = isActive ? (\x27filter:drop-shadow(0 0 6px \x27+phaseColor+\x27)\x27) : \x27\x27;

            // Document held up during R2 cross-reading
            var docHtml = \x27\x27;
            if (phase===\x27r2\x27 && isActive) {
              docHtml = \x27<rect x="46" y="6" width="14" height="18" rx="2" fill="#0f0f1e" stroke="#22d3ee" stroke-width="1.5" class="prl-doc-hold"/>\x27+
                \x27<line x1="49" y1="11" x2="57" y2="11" stroke="#22d3ee" stroke-width="1" opacity=".7"/>\x27+
                \x27<line x1="49" y1="14" x2="57" y2="14" stroke="#22d3ee" stroke-width="1" opacity=".5"/>\x27+
                \x27<line x1="49" y1="17" x2="54" y2="17" stroke="#22d3ee" stroke-width="1" opacity=".4"/>\x27;
            }
            if (phase===\x27r3\x27 && isActive) {
              docHtml = \x27<rect x="46" y="6" width="14" height="18" rx="2" fill="#0f0f1e" stroke="#f59e0b" stroke-width="1.5" class="prl-doc-hold"/>\x27+
                \x27<line x1="49" y1="11" x2="57" y2="11" stroke="#f59e0b" stroke-width="1" opacity=".7"/>\x27+
                \x27<line x1="49" y1="14" x2="57" y2="14" stroke="#f59e0b" stroke-width="1" opacity=".5"/>\x27;
            }

            // Shirt colors — vibrant, professional palette
            var shirtColors = [\x27#4f46e5\x27,\x27#0891b2\x27,\x27#7c3aed\x27,\x27#059669\x27,\x27#dc2626\x27,\x27#d97706\x27];
            var shirt = shirtColors[skinIdx];
            // Hair colors — varied and realistic
            var hairColors = [\x27#1a1a1a\x27,\x27#4a3728\x27,\x27#c4a35a\x27,\x27#8b0000\x27,\x27#2c4a7c\x27,\x27#3d2b1f\x27];
            var hair = hairColors[skinIdx];
            var monitorGlow = isActive ? (\x27filter:drop-shadow(0 0 5px \x27+phaseColor+\x2780)\x27) : \x27\x27;

            var svgChar = \x27<svg viewBox="0 0 80 96" width="76" height="90" xmlns="http://www.w3.org/2000/svg" style="\x27+glowStyle+\x27;display:block;margin:0 auto">\x27+
              // ════ ISOMETRIC-STYLE DESK ════
              // Desk top — parallelogram for 3D feel (top face)
              \x27<path d="M4 55 L76 55 L76 63 L4 63 Z" fill="\x27+deskColor+\x27" stroke="\x27+deskBorder+\x27" stroke-width="1.2"/>\x27+
              // Desk front face (darker) — 3D depth
              \x27<path d="M4 63 L76 63 L76 70 L4 70 Z" fill="\x27+(isDone?\x27#0d2010\x27:(isActive?\x27#0c0c22\x27:\x27#0e0e1c\x27))+\x27"/>\x27+
              // Desk left side face
              \x27<path d="M4 55 L4 70 L4 70" fill="none"/>\x27+
              // Desk front edge highlight
              \x27<line x1="4" y1="63" x2="76" y2="63" stroke="\x27+deskBorder+\x2760" stroke-width=".8"/>\x27+
              // Desk legs — rounded, tapered
              \x27<path d="M10 70 C10 70 9 82 9 84 C9 86 11 87 13 87 C15 87 17 86 17 84 C17 82 16 70 16 70 Z" fill="#111128"/>\x27+
              \x27<path d="M63 70 C63 70 62 82 62 84 C62 86 64 87 66 87 C68 87 70 86 70 84 C70 82 69 70 69 70 Z" fill="#111128"/>\x27+
              // Desk shelf between legs
              \x27<rect x="17" y="79" width="46" height="3" rx="1.5" fill="#161626"/>\x27+
              // ════ MONITOR (sleek, thin-bezel) ════
              // Monitor shadow on desk
              \x27<ellipse cx="35" cy="56" rx="14" ry="2" fill="rgba(0,0,0,.4)"/>\x27+
              // Monitor stand base
              \x27<ellipse cx="35" cy="57" rx="7" ry="1.5" fill="#1a1a2e"/>\x27+
              // Monitor stand pole
              \x27<rect x="33" y="50" width="4" height="6" rx="1" fill="#1a1a2e"/>\x27+
              // Monitor outer bezel — shadow/depth
              \x27<rect x="17" y="26" width="36" height="25" rx="4" fill="#050510"/>\x27+
              // Monitor bezel
              \x27<rect x="18" y="27" width="34" height="23" rx="3" fill="#0d0d20" stroke="\x27+(isActive?phaseColor:\x27#252535\x27)+\x27" stroke-width="\x27+(isActive?\x272\x27:\x271\x27)+\x27" style="\x27+monitorGlow+\x27"/>\x27+
              // Screen glass — subtle gradient
              \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="#0a0a18"/>\x27+
              // Screen content
              (isActive ?
                // Active: glowing code/data on screen
                \x27<defs><linearGradient id="sg\x27+skinIdx+\x27" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="\x27+phaseColor+\x2722"/><stop offset="1" stop-color="\x27+phaseColor+\x2708"/></linearGradient></defs>\x27+
                \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="url(#sg\x27+skinIdx+\x27)"/>\x27+
                \x27<line x1="22" y1="32" x2="48" y2="32" stroke="\x27+phaseColor+\x27ee" stroke-width="1.2" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="35" x2="44" y2="35" stroke="\x27+phaseColor+\x27aa" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="38" x2="46" y2="38" stroke="\x27+phaseColor+\x2788" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="41" x2="40" y2="41" stroke="\x27+phaseColor+\x2766" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="44" x2="43" y2="44" stroke="\x27+phaseColor+\x2744" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<rect x="22" y="30" width="10" height="2.5" rx="1" fill="\x27+phaseColor+\x2733"/>\x27
                :
                // Idle: dim screen with faint lines
                \x27<line x1="22" y1="33" x2="46" y2="33" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="36" x2="42" y2="36" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="39" x2="44" y2="39" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27+
                \x27<line x1="22" y1="42" x2="38" y2="42" stroke="#1e1e30" stroke-width="1" stroke-linecap="round"/>\x27
              )+
              // Monitor camera dot
              \x27<circle cx="35" cy="28.2" r=".9" fill="\x27+(isActive?phaseColor:\x27#2a2a40\x27)+\x27"/>\x27+
              // ════ KEYBOARD (detailed, realistic) ════
              \x27<rect x="13" y="48" width="36" height="7" rx="2.5" fill="#0c0c1e" stroke="#202036" stroke-width="1"/>\x27+
              // Key rows
              \x27<rect x="14" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="18" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="22" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="26" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="30" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="34" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="38" y="49.5" width="3" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="15" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="21" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="27" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
              \x27<rect x="33" y="52.5" width="5" height="2" rx=".5" fill="#181830"/>\x27+
              // Spacebar
              \x27<rect x="19" y="55" width="24" height="1.8" rx=".9" fill="#181830"/>\x27+
              // ════ ERGONOMIC CHAIR ════
              // Chair base
              \x27<ellipse cx="34" cy="72" rx="12" ry="4" fill="#111124"/>\x27+
              // Chair gas lift
              \x27<rect x="32" y="65" width="4" height="8" rx="1" fill="#1a1a2c"/>\x27+
              // Chair seat
              \x27<path d="M22 60 Q22 56 34 56 Q46 56 46 60 L46 66 Q46 68 34 68 Q22 68 22 66 Z" fill="#1c1c2c" stroke="#2a2a3e" stroke-width="1"/>\x27+
              // Chair backrest
              \x27<path d="M24 44 Q23 38 34 37 Q45 38 44 44 L44 58 Q44 60 34 60 Q24 60 24 58 Z" fill="#191928" stroke="#2a2a3c" stroke-width="1"/>\x27+
              // Chair backrest cushion
              \x27<path d="M26 46 Q26 41 34 40 Q42 41 42 46 L42 57 Q42 58 34 58 Q26 58 26 57 Z" fill="#1e1e30"/>\x27+
              // Chair headrest
              \x27<path d="M28 37 Q28 33 34 33 Q40 33 40 37 L40 39 Q40 40 34 40 Q28 40 28 39 Z" fill="#191928" stroke="#2a2a3c" stroke-width="1"/>\x27+
              // Chair armrests
              \x27<path d="M22 55 L18 55 Q16 55 16 57 L16 60 Q16 62 18 62 L22 62 Q24 62 24 60 L24 55 Z" fill="#1c1c2c"/>\x27+
              \x27<path d="M46 55 L50 55 Q52 55 52 57 L52 60 Q52 62 50 62 L46 62 Q44 62 44 60 L44 55 Z" fill="#1c1c2c"/>\x27+
              // ════ TORSO / SHIRT ════
              // shirt back visible above chair
              \x27<path d="M27 58 Q27 54 34 53 Q41 54 41 58 L42 65 L26 65 Z" fill="\x27+shirt+\x27cc"/>\x27+
              // shirt body
              \x27<path d="M27 44 Q27 42 34 41 Q41 42 41 44 L42 58 L26 58 Z" fill="\x27+shirt+\x27"/>\x27+
              // shirt shading (left side)
              \x27<path d="M27 44 Q27 42 34 41 L34 58 L26 58 Z" fill="rgba(0,0,0,.12)"/>\x27+
              // collar / V-neck
              \x27<path d="M34 41 L31 46 L34 44.5 L37 46 Z" fill="\x27+skin+\x27ee"/>\x27+
              // shirt wrinkle detail
              \x27<line x1="34" y1="46" x2="34" y2="57" stroke="rgba(0,0,0,.08)" stroke-width="2" stroke-linecap="round"/>\x27+
              // ════ ARMS (typing position) ════
              \x27<g \x27+armAnim+\x27>\x27+
              // Left upper arm
              \x27<path d="M28 45 C24 47 22 50 21 53 C21 55 23 56 25 55 C27 54 27 52 28 49 Z" fill="\x27+shirt+\x27"/>\x27+
              // Left forearm
              \x27<path d="M21 53 C19 55 18 57 18 59 C18 61 20 62 22 61 C24 60 24 58 25 55 Z" fill="\x27+skin+\x27"/>\x27+
              // Left hand
              \x27<ellipse cx="19" cy="60" rx="4" ry="3" fill="\x27+skin+\x27" transform="rotate(-10 19 60)"/>\x27+
              // Right upper arm
              \x27<path d="M40 45 C44 47 46 50 47 53 C47 55 45 56 43 55 C41 54 41 52 40 49 Z" fill="\x27+shirt+\x27"/>\x27+
              // Right forearm
              \x27<path d="M47 53 C49 55 50 57 50 59 C50 61 48 62 46 61 C44 60 44 58 43 55 Z" fill="\x27+skin+\x27"/>\x27+
              // Right hand
              \x27<ellipse cx="49" cy="60" rx="4" ry="3" fill="\x27+skin+\x27" transform="rotate(10 49 60)"/>\x27+
              \x27</g>\x27+
              // ════ HEAD (smooth, expressive) ════
              \x27<g \x27+headAnim+\x27>\x27+
              // Neck with shadow
              \x27<path d="M30 40 L38 40 L38 43 Q38 45 34 45 Q30 45 30 43 Z" fill="\x27+skin+\x27"/>\x27+
              \x27<path d="M30 40 L34 40 L34 45 Q30 45 30 43 Z" fill="rgba(0,0,0,.08)"/>\x27+
              // Head — well-proportioned ellipse
              \x27<ellipse cx="34" cy="29" rx="11" ry="12.5" fill="\x27+skin+\x27"/>\x27+
              // Cheek blush (subtle)
              \x27<ellipse cx="26" cy="32" rx="3.5" ry="2" fill="\x27+skin+\x27" opacity=".6"/>\x27+
              \x27<ellipse cx="42" cy="32" rx="3.5" ry="2" fill="\x27+skin+\x27" opacity=".6"/>\x27+
              // Head shadow (right)
              \x27<ellipse cx="41" cy="29" rx="5" ry="11" fill="rgba(0,0,0,.06)"/>\x27+
              // Ears — detailed
              \x27<path d="M23 28 C21 28 20 30 20 31.5 C20 33 21 34.5 23 34.5 C24 34.5 24.5 33.5 24 31.5 C24.5 29.5 24 28 23 28" fill="\x27+skin+\x27"/>\x27+
              \x27<path d="M45 28 C47 28 48 30 48 31.5 C48 33 47 34.5 45 34.5 C44 34.5 43.5 33.5 44 31.5 C43.5 29.5 44 28 45 28" fill="\x27+skin+\x27"/>\x27+
              \x27<path d="M23.5 30 C22.5 30.5 22.5 32.5 23.5 33" stroke="\x27+skin+\x27" stroke-width="1" fill="none" opacity=".5"/>\x27+
              // Hair — styled, voluminous
              \x27<path d="M23 28 C22 22 24 16 34 15 C44 16 46 22 45 28 C44 22 42 18 34 17 C26 18 24 22 23 28" fill="\x27+hair+\x27"/>\x27+
              \x27<path d="M23 27 C22 24 23 19 26 17 C24 20 23 24 24 27" fill="\x27+hair+\x2788"/>\x27+
              // Hair highlight
              \x27<path d="M28 17 C30 15 33 15 36 16 C33 14 29 15 28 17" fill="rgba(255,255,255,.12)"/>\x27+
              // Eyebrows — expressive
              \x27<path d="M27 23 Q29.5 21.5 32 23" stroke="\x27+hair+\x27" stroke-width="1.6" fill="none" stroke-linecap="round"/>\x27+
              \x27<path d="M36 23 Q38.5 21.5 41 23" stroke="\x27+hair+\x27" stroke-width="1.6" fill="none" stroke-linecap="round"/>\x27+
              // Eyes — full detail: white + iris + pupil + highlight
              \x27<ellipse cx="30" cy="27.5" rx="3" ry="3.5" fill="#fff" stroke="\x27+skin+\x2740" stroke-width=".5"/>\x27+
              \x27<ellipse cx="38" cy="27.5" rx="3" ry="3.5" fill="#fff" stroke="\x27+skin+\x2740" stroke-width=".5"/>\x27+
              // Iris
              \x27<circle cx="30" cy="28" r="2.2" fill="#3d4a6b"/>\x27+
              \x27<circle cx="38" cy="28" r="2.2" fill="#3d4a6b"/>\x27+
              // Pupil
              \x27<circle cx="30" cy="28" r="1.3" fill="#0a0a14"/>\x27+
              \x27<circle cx="38" cy="28" r="1.3" fill="#0a0a14"/>\x27+
              // Eye shine
              \x27<circle cx="31" cy="27" r=".8" fill="rgba(255,255,255,.9)"/>\x27+
              \x27<circle cx="39" cy="27" r=".8" fill="rgba(255,255,255,.9)"/>\x27+
              \x27<circle cx="29.5" cy="29" r=".35" fill="rgba(255,255,255,.4)"/>\x27+
              // Lower eyelid line
              \x27<path d="M27 30 Q30 31.5 33 30" stroke="\x27+skin+\x27" stroke-width=".7" fill="none" opacity=".5"/>\x27+
              \x27<path d="M35 30 Q38 31.5 41 30" stroke="\x27+skin+\x27" stroke-width=".7" fill="none" opacity=".5"/>\x27+
              // Nose — soft curved
              \x27<path d="M33 31 Q33 33 34 33.5 Q35 34 35 33 Q36 33 36 31" stroke="\x27+skin+\x27" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".7"/>\x27+
              \x27<ellipse cx="31.5" cy="33.5" rx="1.2" ry=".7" fill="rgba(0,0,0,.08)"/>\x27+
              \x27<ellipse cx="36.5" cy="33.5" rx="1.2" ry=".7" fill="rgba(0,0,0,.08)"/>\x27+
              // Mouth — expressive
              (isDone ?
                // Big smile when done
                \x27<path d="M29 37 Q34 42 39 37" stroke="#8b4513" stroke-width="1.8" fill="none" stroke-linecap="round"/>\x27+
                \x27<path d="M29 37 Q34 41 39 37" stroke="rgba(255,255,255,.3)" stroke-width=".5" fill="none" stroke-linecap="round"/>\x27+
                // Teeth
                \x27<path d="M30 37.5 Q34 41 38 37.5 Q34 40 30 37.5" fill="#fff" opacity=".8"/>\x27
                :
                // Focused expression
                \x27<path d="M30.5 37 Q34 38.5 37.5 37" stroke="#8b4513" stroke-width="1.4" fill="none" stroke-linecap="round"/>\x27
              )+
              // Agent badge/pin on shirt
              \x27<circle cx="38.5" cy="48" r="5.5" fill="#0f0f1e" stroke="\x27+shirt+\x2780" stroke-width="1.2"/>\x27+
              \x27<circle cx="38.5" cy="48" r="4" fill="#161622"/>\x27+
              \x27<text x="38.5" y="51" text-anchor="middle" font-size="6">\x27+ico+\x27</text>\x27+
              \x27</g>\x27+
              // ════ DONE BADGE (top right corner, polished) ════
              (isDone ?
                \x27<circle cx="67" cy="9" r="10" fill="#0a2010"/>\x27+
                \x27<circle cx="67" cy="9" r="8" fill="#16a34a"/>\x27+
                \x27<circle cx="67" cy="9" r="6" fill="#22c55e"/>\x27+
                \x27<path d="M62.5 9 L65.5 12 L71.5 5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>\x27
                : \x27\x27)+
              docHtml+
              \x27</svg>\x27;

            return \x27<div class="prl-desk\x27+(isActive?\x27 prl-desk--active\x27:\x27\x27)+(isDone?\x27 prl-desk--done\x27:\x27\x27)+\x27" style="--dc:\x27+phaseColor+\x27;box-shadow:\x27+shadow+\x27">\x27+
              (actionStr ? \x27<div class="prl-action-bubble\x27+(isActive?\x27 prl-action-bubble--active\x27:\x27\x27)+\x27">\x27+actionStr+\x27</div>\x27 : \x27\x27)+
              svgChar+
              \x27<div class="prl-desk-name" style="color:\x27+(isDone?\x27#4ade80\x27:(isActive?phaseColor:\x27#6b7280\x27))+\x27">\x27+esc(lbl.slice(0,14))+\x27</div>\x27+
              \x27</div>\x27;
          }

          // ── MASTER ORCHESTRATOR walking animation ─────────────────────────
          // In R1: walks left-right between desks (CSS animation).
          // In R2: stands at the active agent's desk.
          // In R3: stands center with lightning bolt.
          var masterIcon = phase===\x27r3\x27 ? \x27\u26a1\x27 : (phase===\x27done\x27 ? \x27\u2714\x27 : \x27\u2666\x27);
          var masterColor2 = {r1:\x27#818cf8\x27,r2:\x27#818cf8\x27,r3:\x27#f59e0b\x27,done:\x27#22c55e\x27}[phase]||\x27#818cf8\x27;
          var masterAnim = (phase===\x27r1\x27) ? \x27prl-master-walk\x27 : (phase===\x27r2\x27 ? \x27prl-master-supervise\x27 : \x27\x27);
          var masterSvg = \x27<svg viewBox="0 0 60 90" width="56" height="86" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 0 12px \x27+masterColor2+\x27aa)">\x27+
            // ════ LEGS (walking when R1) ════
            // Left leg — trouser
            \x27<path d="M22 55 C21 63 19 72 18 77 C17 80 18 82 21 82 C23 82 24 80 24 77 C25 71 25 62 26 55 Z" fill="#1e1c4a" class="prl-master-leg-l"/>\x27+
            // Right leg — trouser
            \x27<path d="M28 55 C29 63 31 72 32 77 C33 80 32 82 29 82 C27 82 26 80 26 77 C25 71 25 62 24 55 Z" fill="#1e1c4a" class="prl-master-leg-r"/>\x27+
            // Left shoe — detailed
            \x27<path d="M16 79 C14 79 13 81 14 83 C15 85 18 85 21 84 C23 83 24 82 23 80 C22 79 19 79 16 79" fill="#0a0a14"/>\x27+
            \x27<path d="M16 79 C15 80 14 82 15 83" stroke="#1a1a2e" stroke-width=".8" fill="none"/>\x27+
            // Right shoe
            \x27<path d="M34 79 C36 79 37 81 36 83 C35 85 32 85 29 84 C27 83 26 82 27 80 C28 79 31 79 34 79" fill="#0a0a14"/>\x27+
            // Trouser crease
            \x27<line x1="23" y1="55" x2="21" y2="77" stroke="rgba(255,255,255,.08)" stroke-width="1" stroke-linecap="round"/>\x27+
            \x27<line x1="27" y1="55" x2="29" y2="77" stroke="rgba(255,255,255,.08)" stroke-width="1" stroke-linecap="round"/>\x27+
            // ════ TORSO — Premium dark suit ════
            // Suit jacket base
            \x27<path d="M13 32 C12 30 15 27 25 25 C35 27 38 30 37 32 L38 55 L12 55 Z" fill="#252450"/>\x27+
            // Left suit front panel
            \x27<path d="M13 32 C12 30 15 27 25 25 L25 55 L12 55 Z" fill="#1e1d44"/>\x27+
            // Right suit front panel (lighter)
            \x27<path d="M25 25 C35 27 38 30 37 32 L38 55 L25 55 Z" fill="#272660"/>\x27+
            // Suit lapels — left
            \x27<path d="M25 25 L19 33 L22 36 L25 29 Z" fill="#1a1940" stroke="#252450" stroke-width=".5"/>\x27+
            // Suit lapels — right
            \x27<path d="M25 25 L31 33 L28 36 L25 29 Z" fill="#1a1940" stroke="#252450" stroke-width=".5"/>\x27+
            // White shirt / tie visible between lapels
            \x27<path d="M25 29 L22 36 L25 34 L28 36 Z" fill="#f0f0fa"/>\x27+
            // Tie — authority color
            \x27<path d="M25 33 L24 44 L25 48 L26 44 Z" fill="\x27+masterColor2+\x27"/>\x27+
            \x27<path d="M24 44 L25 48 L26 44 L25 43 Z" fill="\x27+masterColor2+\x27cc"/>\x27+
            // Tie knot
            \x27<path d="M23.5 32 L26.5 32 L25 34 Z" fill="\x27+masterColor2+\x27"/>\x27+
            // Suit pocket square
            \x27<path d="M33 35 L36 33 L37 36 L34 37 Z" fill="\x27+masterColor2+\x2799"/>\x27+
            // Suit buttons
            \x27<circle cx="25" cy="42" r="1.2" fill="\x27+masterColor2+\x27aa"/>\x27+
            \x27<circle cx="25" cy="46" r="1.2" fill="\x27+masterColor2+\x27aa"/>\x27+
            // Suit lapel badge / NHA logo
            \x27<circle cx="20" cy="36" r="2.5" fill="#0d0d1e" stroke="\x27+masterColor2+\x2799" stroke-width="1"/>\x27+
            \x27<text x="20" y="39" text-anchor="middle" font-size="4" fill="\x27+masterColor2+\x27">N</text>\x27+
            // ════ ARMS ════
            \x27<g class="prl-master-arm-l">\x27+
            // Left upper arm
            \x27<path d="M13 34 C8 37 6 42 6 46 C6 49 9 50 11 49 C13 48 13 45 14 41 C15 38 14 35 13 34" fill="#252450"/>\x27+
            // Left forearm
            \x27<path d="M6 46 C4 48 4 51 5 53 C6 55 9 55 10 53 C11 51 10 48 10 46 Z" fill="#d4a97a"/>\x27+
            // Left hand
            \x27<ellipse cx="7" cy="54" rx="4.5" ry="3.5" fill="#d4a97a" transform="rotate(-15 7 54)"/>\x27+
            \x27</g>\x27+
            // Right arm — holds clipboard
            \x27<g class="prl-master-arm-r">\x27+
            // Right upper arm
            \x27<path d="M37 34 C42 37 44 41 44 45 C44 48 41 49 39 48 C37 47 37 44 37 40 C37 37 37 35 37 34" fill="#252450"/>\x27+
            // Right forearm
            \x27<path d="M44 44 C46 46 47 49 46 52 C45 54 42 54 41 52 C40 50 41 47 41 45 Z" fill="#d4a97a"/>\x27+
            // Right hand
            \x27<ellipse cx="45" cy="52" rx="4" ry="3" fill="#d4a97a" transform="rotate(15 45 52)"/>\x27+
            // Clipboard — premium design
            \x27<rect x="43" y="32" width="14" height="19" rx="2.5" fill="#1a1a2e" stroke="\x27+masterColor2+\x2799" stroke-width="1.5"/>\x27+
            // Clipboard clip
            \x27<rect x="47" y="30" width="6" height="5" rx="1.5" fill="\x27+masterColor2+\x27" stroke="\x27+masterColor2+\x27" stroke-width="1"/>\x27+
            \x27<rect x="48" y="31" width="4" height="3" rx="1" fill="#0f0f1e"/>\x27+
            // Clipboard lines
            \x27<line x1="46" y1="36" x2="54" y2="36" stroke="\x27+masterColor2+\x27cc" stroke-width="1" stroke-linecap="round"/>\x27+
            \x27<line x1="46" y1="39" x2="54" y2="39" stroke="\x27+masterColor2+\x27aa" stroke-width="1" stroke-linecap="round"/>\x27+
            \x27<line x1="46" y1="42" x2="54" y2="42" stroke="\x27+masterColor2+\x2788" stroke-width="1" stroke-linecap="round"/>\x27+
            \x27<line x1="46" y1="45" x2="50" y2="45" stroke="\x27+masterColor2+\x2766" stroke-width="1" stroke-linecap="round"/>\x27+
            // Data chart on clipboard
            \x27<rect x="46" y="37" width="3" height="2" rx=".5" fill="\x27+masterColor2+\x2744"/>\x27+
            \x27<rect x="50" y="36" width="3" height="3" rx=".5" fill="\x27+masterColor2+\x2766"/>\x27+
            \x27</g>\x27+
            // ════ HEAD — authoritative, confident ════
            // Neck
            \x27<path d="M22 25 L28 25 L28 29 Q28 31 25 31 Q22 31 22 29 Z" fill="#d4a97a"/>\x27+
            \x27<path d="M22 25 L25 25 L25 31 Q22 31 22 29 Z" fill="rgba(0,0,0,.1)"/>\x27+
            // Head shape
            \x27<ellipse cx="25" cy="15" rx="12" ry="13" fill="#d4a97a"/>\x27+
            // Jaw/chin
            \x27<path d="M14 15 C14 22 18 26 25 27 C32 26 36 22 36 15" fill="#d4a97a"/>\x27+
            // Head shading
            \x27<ellipse cx="32" cy="15" rx="6" ry="11" fill="rgba(0,0,0,.07)"/>\x27+
            // Ears
            \x27<path d="M13 13 C11 13 10 15 10 17 C10 19 11 20 13 20 C14 20 14.5 19 14 17 C14.5 15 14 13 13 13" fill="#d4a97a"/>\x27+
            \x27<path d="M37 13 C39 13 40 15 40 17 C40 19 39 20 37 20 C36 20 35.5 19 36 17 C35.5 15 36 13 37 13" fill="#d4a97a"/>\x27+
            \x27<path d="M13.5 15 C12.5 16 12.5 18 13.5 19" stroke="#c4935a" stroke-width="1" fill="none"/>\x27+
            // Hair — executive styled, neat
            \x27<path d="M13 14 C12 7 16 2 25 1 C34 2 38 7 37 14 C36 7 32 4 25 3 C18 4 14 7 13 14" fill="#1a0e08"/>\x27+
            // Side part
            \x27<path d="M22 3 C21 4 21 6 22 8" stroke="rgba(255,255,255,.15)" stroke-width="1.5" fill="none" stroke-linecap="round"/>\x27+
            // Hair sheen
            \x27<path d="M20 3 C22 1 27 1 30 2 C27 0 22 1 20 3" fill="rgba(255,255,255,.1)"/>\x27+
            // Eyebrows — thick, authoritative
            \x27<path d="M16.5 11 Q19 9.5 21.5 11" stroke="#1a0e08" stroke-width="1.8" fill="none" stroke-linecap="round"/>\x27+
            \x27<path d="M28.5 11 Q31 9.5 33.5 11" stroke="#1a0e08" stroke-width="1.8" fill="none" stroke-linecap="round"/>\x27+
            // Eyes — confident, forward-looking
            \x27<ellipse cx="19.5" cy="14.5" rx="3.2" ry="3.5" fill="#fff" stroke="#d4a97a" stroke-width=".4"/>\x27+
            \x27<ellipse cx="30.5" cy="14.5" rx="3.2" ry="3.5" fill="#fff" stroke="#d4a97a" stroke-width=".4"/>\x27+
            \x27<circle cx="19.5" cy="15" r="2.3" fill="#1e3a6e"/>\x27+
            \x27<circle cx="30.5" cy="15" r="2.3" fill="#1e3a6e"/>\x27+
            \x27<circle cx="19.5" cy="15" r="1.3" fill="#0a0a18"/>\x27+
            \x27<circle cx="30.5" cy="15" r="1.3" fill="#0a0a18"/>\x27+
            \x27<circle cx="20.5" cy="13.7" r=".9" fill="rgba(255,255,255,.95)"/>\x27+
            \x27<circle cx="31.5" cy="13.7" r=".9" fill="rgba(255,255,255,.95)"/>\x27+
            // Nose — subtle
            \x27<path d="M24 18 Q24 20 25 20.5 Q26 21 26 19.5" stroke="#c4935a" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".8"/>\x27+
            \x27<ellipse cx="22.5" cy="20.5" rx="1.3" ry=".8" fill="rgba(0,0,0,.1)"/>\x27+
            \x27<ellipse cx="27.5" cy="20.5" rx="1.3" ry=".8" fill="rgba(0,0,0,.1)"/>\x27+
            // Confident smile
            \x27<path d="M19.5 24 Q25 27.5 30.5 24" stroke="#8b4513" stroke-width="1.8" fill="none" stroke-linecap="round"/>\x27+
            \x27<path d="M20 24.5 Q25 27 30 24.5 Q25 26.5 20 24.5" fill="#fff" opacity=".7"/>\x27+
            // Crown / authority icon above head
            \x27<text x="25" y="-1" text-anchor="middle" font-size="11" style="filter:drop-shadow(0 0 4px \x27+masterColor2+\x27)">\x27+masterIcon+\x27</text>\x27+
            // Subtle glow ring around crown icon
            \x27<circle cx="25" cy="-2" r="8" fill="none" stroke="\x27+masterColor2+\x2730" stroke-width="1.5"/>\x27+
            \x27</svg>\x27;

          var masterLabel2 = {r1:\x27Orchestratore\x27,r2:\x27Coordina\x27,r3:\x27HERALD\x27,done:\x27Completato\x27}[phase]||\x27MASTER\x27;
          var masterHtml = \x27<div class="prl-master \x27+masterAnim+\x27">\x27+masterSvg+\x27<div class="prl-master-label" style="color:\x27+masterColor2+\x27">\x27+masterLabel2+\x27</div></div>\x27;

          // ── Flying document animation for R2 (agent-to-agent) ────────────
          // One flying doc per active cross-reading event, CSS keyframe arc.
          var flyingDocHtml = \x27\x27;
          if (phase===\x27r2\x27 && activeLabel) {
            var others2 = proposals.filter(function(x){return (x.label||x.agent)!==activeLabel;});
            flyingDocHtml = \x27<div class="prl-fly-container" aria-hidden="true">\x27;
            others2.forEach(function(other, oi) {
              var delay = (oi * 0.35).toFixed(2);
              flyingDocHtml += \x27<div class="prl-fly-doc" style="animation-delay:\x27+delay+\x27s;animation-duration:\x27+(1.5+oi*0.2).toFixed(1)+\x27s">\x27+
                // Document — dog-ear corner, realistic paper look
                \x27<svg viewBox="0 0 22 28" width="22" height="28">\x27+
                \x27<defs><filter id="dsf\x27+oi+\x27" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="#22d3ee" flood-opacity=".5"/></filter></defs>\x27+
                // Paper body
                \x27<path d="M2 1 L16 1 L21 6 L21 27 Q21 28 20 28 L2 28 Q1 28 1 27 L1 2 Q1 1 2 1" fill="#0c0c1e" stroke="#22d3ee" stroke-width="1.5" filter="url(#dsf\x27+oi+\x27)"/>\x27+
                // Dog-ear fold
                \x27<path d="M16 1 L16 6 L21 6" fill="none" stroke="#22d3ee" stroke-width="1.2"/>\x27+
                \x27<path d="M16 1 L21 6 L16 6 Z" fill="#0f0f28"/>\x27+
                // Header bar (colored)
                \x27<rect x="2" y="2" width="13" height="3" rx="1" fill="#22d3ee22"/>\x27+
                // Text lines
                \x27<line x1="3" y1="9" x2="19" y2="9" stroke="#22d3ee" stroke-width="1" opacity=".8" stroke-linecap="round"/>\x27+
                \x27<line x1="3" y1="12" x2="17" y2="12" stroke="#22d3ee" stroke-width="1" opacity=".6" stroke-linecap="round"/>\x27+
                \x27<line x1="3" y1="15" x2="19" y2="15" stroke="#22d3ee" stroke-width="1" opacity=".5" stroke-linecap="round"/>\x27+
                \x27<line x1="3" y1="18" x2="14" y2="18" stroke="#22d3ee" stroke-width="1" opacity=".4" stroke-linecap="round"/>\x27+
                // Chart bar (mini)
                \x27<rect x="3" y="21" width="3" height="5" rx=".5" fill="#22d3ee44"/>\x27+
                \x27<rect x="7" y="19" width="3" height="7" rx=".5" fill="#22d3ee66"/>\x27+
                \x27<rect x="11" y="22" width="3" height="4" rx=".5" fill="#22d3ee44"/>\x27+
                \x27<rect x="15" y="20" width="3" height="6" rx=".5" fill="#22d3ee55"/>\x27+
                \x27</svg></div>\x27;
            });
            flyingDocHtml += \x27</div>\x27;
          }

          // ── Assemble agent desks row ──────────────────────────────────────
          var desksHtml = proposals.map(function(prop) {
            var lbl = prop.label || prop.agent;
            return buildChar(prop, !!parlDoneAgents[lbl], lbl===activeLabel, false);
          }).join(\x27\x27);

          var convergenceHtml = convergence != null
            ? (\x27<div class="prl-conv-wrap"><div class="prl-conv-bar-outer"><div class="prl-conv-bar-inner" style="width:\x27+Math.min(convergence,100)+\x27%"></div></div>\x27+
               \x27<div class="prl-conv-text"><strong>\u2714 Convergenza \x27+convergence+\x27%</strong> &mdash; le analisi condividono il \x27+convergence+\x27% dei concetti chiave (Jaccard). HERALD ha sintetizzato il consenso finale.</div></div>\x27)
            : (\x27<div class="prl-progress"><div class="prl-progress__bar" style="width:\x27+progressPct+\x27%"></div></div>\x27);

          pb.innerHTML =
            \x27<div class="prl-wrap">\x27+
            \x27<div class="prl-header"><span class="prl-phase-chip" style="--pc:\x27+phaseColor+\x27">\x27+phaseLabel+\x27</span></div>\x27+
            \x27<div class="prl-office">\x27+
            \x27<div class="prl-office-floor"></div>\x27+
            \x27<div class="prl-desks-row">\x27+desksHtml+\x27</div>\x27+
            masterHtml+
            flyingDocHtml+
            \x27</div>\x27+
            convergenceHtml+
            \x27</div>\x27;

          // Force Safari compositing repaint
          void pb.offsetHeight;
          pb.style.transform = \x27translateZ(0)\x27;
          requestAnimationFrame(function(){
            pb.style.opacity = \x270.99\x27;
            requestAnimationFrame(function(){ pb.style.opacity = \x271\x27; });
          });
        }

        // Show initial R1 block and scroll into view
        renderParlBlock(\x27r1\x27, null, null);
        var pb0 = document.getElementById(\x27studioParliamentBlock\x27);
        if (pb0) {
          setTimeout(function(){
            pb0.scrollIntoView({behavior:\x27smooth\x27, block:\x27start\x27});
          }, 80);
        }

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
                    var r2StartM = dev.token.match(/^\\[Round 2: (.+?)\\]\\s*$/);
                    var r2LiveM = dev.token.match(/^\\[Round 2 (.+?): (\\d+) token\\]\\s*$/);
                    if (r2StartM) {
                      var r2Label = r2StartM[1];
                      parlActiveAgent = r2Label;
                      studioLog(r2Label, \x27&#x2656;\x27, \x27\x27, \x27agent\x27, false);
                      var delEnts2 = document.querySelectorAll(\x27.studio-log-entry\x27);
                      var delL2 = delEnts2[delEnts2.length - 1];
                      if (delL2) {
                        delL2.setAttribute(\x27data-r2-agent\x27, r2Label);
                        var delTb2 = delL2.querySelector(\x27.studio-log-entry__text\x27);
                        if (delTb2) delTb2.innerHTML = \x27<span style="color:var(--green);font-family:var(--mono);font-size:10px">&#x2656; Deliberando Round 2<span class="thinking-dots"><span></span><span></span><span></span></span></span>\x27;
                      }
                      renderParlBlock(\x27r2\x27, r2Label, null);
                      if (studioState.nodes[parlNodeIdx]) {
                        var otherLabels = proposals.filter(function(p){ return (p.label || p.agent) !== r2Label; }).map(function(p){ return p.label || p.agent; });
                        var readingStr = otherLabels.slice(0,2).join(\x27 + \x27) + (otherLabels.length > 2 ? \x27 +\x27 + (otherLabels.length-2) : \x27\x27);
                        studioState.nodes[parlNodeIdx].label = r2Label + \x27 \u21c4 \x27 + readingStr;
                        studioState.nodes[parlNodeIdx].status = \x27running\x27;
                        renderStudioNodes();
                      }
                    } else if (r2LiveM) {
                      var r2AgentName = r2LiveM[1];
                      var r2Toks = parseInt(r2LiveM[2], 10);
                      var delAllEnts = document.querySelectorAll(\x27[data-r2-agent]\x27);
                      var r2Entry = null;
                      for (var rei = delAllEnts.length - 1; rei >= 0; rei--) {
                        if (delAllEnts[rei].getAttribute(\x27data-r2-agent\x27) === r2AgentName) { r2Entry = delAllEnts[rei]; break; }
                      }
                      if (!r2Entry) { var delAllE = document.querySelectorAll(\x27.studio-log-entry\x27); r2Entry = delAllE[delAllE.length - 1]; }
                      if (r2Entry) {
                        var r2Tb = r2Entry.querySelector(\x27.studio-log-entry__text\x27);
                        if (r2Tb) r2Tb.innerHTML = \x27<span style="color:var(--green);font-family:var(--mono);font-size:10px">&#x2656; Deliberando Round 2 \u2014 \x27 + r2Toks + \x27 token<span class="thinking-dots"><span></span><span></span><span></span></span></span>\x27;
                      }
                      studioAddTokens(0, 20);
                    } else {
                      var delEntries = document.querySelectorAll(\x27.studio-log-entry\x27);
                      var delLast = delEntries[delEntries.length - 1];
                      if (delLast) { var delTb = delLast.querySelector(\x27.studio-log-entry__text\x27); if (delTb) delTb.textContent = dev.token.replace(new RegExp(\x27[\\r\\n]+\x27,\x27g\x27),\x27 \x27); }
                    }
                  } else if (dev.deliberation_r2) {
                    var r2d = dev.deliberation_r2;
                    studioLog(r2d.label || r2d.agent, \x27&#x2656;\x27, \x27[R2] \x27 + (r2d.output || \x27\x27), \x27agent\x27, true);
                    var ni2 = studioState.nodes.findIndex(function(x){return x.agent===r2d.agent;});
                    if (ni2 >= 0) { studioState.nodes[ni2].output = r2d.output; studioState.nodes[ni2].status = \x27done\x27; }
                    studioAddTokens(0, Math.ceil((r2d.output||'').length / 4));
                    // Mark this agent done in parliament block
                    parlDoneAgents[r2d.label || r2d.agent] = true;
                    parlActiveAgent = null;
                    renderParlBlock(\x27r2\x27, null, null);
                    renderStudioNodes();
                    context = r2d.output || context;
                  } else if (dev.deliberation_r3) {
                    renderParlBlock(\x27r3\x27, null, null);
                    studioLog(\x27HERALD\x27, \x27&#128295;\x27, \x27[Mediazione] \x27 + (dev.deliberation_r3.output || \x27\x27), \x27system\x27, true);
                    studioAddTokens(0, Math.ceil((dev.deliberation_r3.output||'').length / 4));
                    context = dev.deliberation_r3.output || context;
                  } else if (dev.deliberation_done) {
                    var r2Conv = Math.round((dev.r2_convergence || 0) * 100);
                    studioLog(\x27Parlamento\x27, \x27&#x2656;\x27, \x27Deliberazione completa — convergenza R2: \x27 + r2Conv + \x27%\x27, \x27system\x27);
                    if (dev.mediation) { context = dev.mediation; }
                    renderParlBlock(\x27done\x27, null, r2Conv);
                    if (studioState.nodes[parlNodeIdx]) {
                      studioState.nodes[parlNodeIdx].status = \x27done\x27;
                      studioState.nodes[parlNodeIdx].label = \x27Parlamento (\x27 + r2Conv + \x27%)\x27;
                      renderStudioNodes();
                    }
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
            var pb2 = document.getElementById(\x27studioParliamentBlock\x27); if (pb2) pb2.style.display = \x27none\x27;
          }
        }
      }
    }

    // Final result is the last step's output
    studioState.result = context;
    renderStudioResult();
    studioLog('Studio', '&#127881;', t('workflow_complete'), 'system');

    // If parliament was NOT active and a canvas was generated, auto-open it now
    // (parliament-off: old auto-open behaviour is fine since there's nothing else to watch).
    // If parliament WAS active, keep the canvas closed so the user sees the deliberation block.
    var parlWasActive = parliamentActive;
    if (!parlWasActive && studioState.canvas) {
      var cpFin = document.getElementById('canvasPanel');
      var cfFin = document.getElementById('canvasFrame');
      if (cpFin && cfFin) {
        cfFin.srcdoc = studioState.canvas;
        cpFin.classList.add('open');
        var ctFin = document.getElementById('canvasTitle');
        if (ctFin) ctFin.textContent = 'Studio Report';
      }
    }

    // Scroll to parliament block first (user sees deliberation), then to the result.
    setTimeout(function() {
      var parlFinal = document.getElementById('studioParliamentBlock');
      var resEl = document.getElementById('studioResult');
      var scrollEl = parlFinal && parlFinal.closest ? parlFinal.closest('.content') : null;
      function doScroll(el) {
        if (!el) return;
        if (scrollEl) {
          var top = el.offsetTop - 80;
          scrollEl.scrollTo({top: top, behavior: 'smooth'});
        } else {
          el.scrollIntoView({behavior: 'smooth', block: 'start'});
        }
      }
      if (parlFinal && parlFinal.style.display !== 'none' && parlFinal.innerHTML) {
        doScroll(parlFinal);
        setTimeout(function(){ doScroll(resEl); }, 2200);
      } else if (resEl) {
        doScroll(resEl);
      }
    }, 200);

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
    // Save parliament block HTML if present (static snapshot — animations not needed on restore)
    var parlEl = document.getElementById('studioParliamentBlock');
    var parlHtml = (parlEl && parlEl.style.display !== 'none') ? parlEl.innerHTML : null;
    sessions.unshift({
      id: Date.now(),
      task: task,
      nodes: nodes.map(function(n){return {label:n.label,icon:n.icon,agent:n.agent};}),
      result: result,
      canvas: studioState.canvas || null,
      parlHtml: parlHtml,
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
  studioState.canvas = s.canvas || null;
  studioState.running = false;
  var ta = document.getElementById('studioTaskInput');
  if (ta) ta.value = s.task;
  renderStudioNodes(); renderStudioLog(); renderStudioResult();
  // Restore parliament block if present
  var parlEl = document.getElementById('studioParliamentBlock');
  if (parlEl) {
    if (s.parlHtml) {
      parlEl.innerHTML = s.parlHtml;
      parlEl.style.display = 'block';
    } else {
      parlEl.style.display = 'none';
    }
  }
  // Restore canvas if present
  if (s.canvas) {
    var cf = document.getElementById('canvasFrame');
    var cp = document.getElementById('canvasPanel');
    if (cf) cf.srcdoc = s.canvas;
    if (cp) cp.classList.add('open');
    var ct = document.getElementById('canvasTitle');
    if (ct) ct.textContent = 'Studio Report';
    var scb = document.getElementById('studioCanvasBtn');
    if (scb) scb.style.display = '';
    // Also store in allCanvasData so canvas panel nav works
    var convId = activeConvId || 'studio';
    if (!allCanvasData[convId]) allCanvasData[convId] = {canvases:[], browsers:[]};
    allCanvasData[convId].canvases.push({html: s.canvas, title: s.task.slice(0,60), ts: s.ts});
    canvasIdx = allCanvasData[convId].canvases.length - 1;
    canvasMode = 'canvas';
  }
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
    var s = sessions[idx]; if (!s) return;
    var label = s.task ? s.task.slice(0, 60) : 'questa sessione';
    if (!confirm('Eliminare "' + label + '"?')) return;
    // If the deleted session is the one currently displayed, clear the view
    var isCurrentlyOpen = (studioState.task === s.task && studioState.nodes.length > 0 && !studioState.running);
    sessions.splice(idx, 1);
    localStorage.setItem('nha_studio_sessions', JSON.stringify(sessions));
    renderStudioSessionsBar();
    if (isCurrentlyOpen) { studioReset(); }
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
    var stepTokensIn = 0;
    var stepTokensOut = 0;
    // Inject attachment into first step only — pass PDF/image as dedicated fields,
    // NOT as raw base64 in context (would cause 100k+ token overflow for any real PDF).
    // Cap accumulated context to ~40KB to avoid token overflow — keep the most recent content
    var cappedContext = context && context.length > 120000 ? context.slice(-120000) : context;
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
          if (chunk.done) { resolve({output: output || '(no output)', canvas: canvasHtml, tokensIn: stepTokensIn, tokensOut: stepTokensOut}); return; }
          buf += decoder.decode(chunk.value, {stream: true});
          var lines = buf.split('\\n');
          buf = lines.pop();
          lines.forEach(function(line) {
            if (!line.startsWith('data: ')) return;
            var d = line.slice(6).trim();
            if (d === '[DONE]') { resolve({output: output || '(no output)', canvas: canvasHtml, tokensIn: stepTokensIn, tokensOut: stepTokensOut}); return; }
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
                // Store in allCanvasData so openCanvasPanel() finds it reliably
                // (studioState.canvas can be stale if session is restored from localStorage)
                var _cid = activeConvId || \x27_default\x27;
                if (!allCanvasData[_cid]) allCanvasData[_cid] = {canvases:[], browsers:[]};
                // Replace last studio canvas if it exists, otherwise push
                var _cd = allCanvasData[_cid];
                var _existIdx = _cd.canvases.findIndex(function(c){ return c.title === \x27Studio Report\x27; });
                var _citem = {html: ev.canvas, title: \x27Studio Report\x27, ts: new Date().toLocaleTimeString()};
                if (_existIdx >= 0) { _cd.canvases[_existIdx] = _citem; canvasIdx = _existIdx; }
                else { _cd.canvases.push(_citem); canvasIdx = _cd.canvases.length - 1; }
                canvasMode = \x27canvas\x27;
                // Pre-load the canvas HTML into the frame tracker — do NOT open the panel
                // (opening mid-run would hide the parliament animation block).
                _canvasFrameLoadedHtml = ev.canvas;
                var cf2 = document.getElementById(\x27canvasFrame\x27);
                if (cf2) cf2.srcdoc = canvasHtml;
                var scb = document.getElementById(\x27studioCanvasBtn\x27);
                if (scb) {
                  scb.style.display = \x27\x27;
                  scb.style.background = \x27var(--greendim)\x27;
                  scb.style.borderColor = \x27var(--green3)\x27;
                  scb.style.color = \x27var(--green)\x27;
                }
              }
              if (ev.usage) {
                var uIn = ev.usage.input||0; var uOut = ev.usage.output||0;
                stepTokensIn += uIn; stepTokensOut += uOut;
                studioAddTokens(uIn, uOut);
              } else if (ev.token && !isStatus) {
                var est = Math.ceil(ev.token.length/4);
                stepTokensOut += est; studioTokens.out += est; studioUpdateTokenBar();
              }
              if (ev.done) { resolve({output: output || '(no output)', canvas: canvasHtml, tokensIn: stepTokensIn, tokensOut: stepTokensOut}); return; }
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
              '<button id="studioInlinePdfBtn" onclick="downloadStudioPDF()" title="Genera e scarica il report come PDF" style="display:' + (studioState.result ? 'inline-flex' : 'none') + ';align-items:center;gap:5px;padding:8px 12px;background:linear-gradient(135deg,#4f46e5,#2563eb);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:0 2px 6px rgba(79,70,229,.35)">&#x2913; PDF</button>' +
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
        '<div id="studioParliamentBlock" style="display:none;margin-bottom:12px"></div>' +
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
        if (cf) { cf.srcdoc = stepResult.canvas; }
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
.studio-node__reason{position:relative;font-size:11px;color:var(--dim);cursor:pointer;line-height:1;padding:2px 3px;border-radius:4px;transition:color .15s}.studio-node__reason:hover{color:var(--green)}.studio-node__reason-tip{display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid #6366f1;border-radius:6px;padding:6px 9px;font-size:10px;color:#c7d2fe;white-space:normal;width:180px;line-height:1.4;z-index:999;pointer-events:none;text-transform:none;font-weight:400;letter-spacing:0;text-align:left;box-shadow:0 4px 20px rgba(0,0,0,.5)}.studio-node__reason.open .studio-node__reason-tip{display:block}.studio-node__status{font-size:8px;padding:2px 8px;border-radius:20px;font-weight:700;text-transform:uppercase;letter-spacing:.6px}
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
/* ── Workflow node animated character ── */
.studio-nodes{align-items:flex-end!important;min-height:190px!important}
.studio-node--active,.studio-node--done{min-width:118px!important;max-width:140px!important;gap:4px!important}
.studio-node__char{display:flex;align-items:center;justify-content:center;width:100%}
.studio-node__bubble{font-size:9px;padding:2px 7px;border-radius:20px;white-space:nowrap;text-align:center;margin:0 auto}
.studio-node__label--char{font-size:10px;text-align:center;max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;letter-spacing:.3px;color:#6366f1}
.studio-node--done .studio-node__label--char{color:#22c55e}
/* ── Parliament Office Cartoon ── */
.prl-wrap{background:#07070f;border:1.5px solid #6366f1;border-radius:14px;padding:14px 16px 12px;margin-bottom:16px;animation:stNodeIn .35s ease forwards;overflow:hidden}
#studioParliamentBlock[style*="sticky"] .prl-wrap{animation:stNodeIn .35s ease forwards,parlPulse 2.2s ease-in-out infinite}
@keyframes parlPulse{0%,100%{border-color:#6366f1;box-shadow:none}50%{border-color:#818cf8;box-shadow:0 0 20px rgba(99,102,241,.3)}}
.prl-header{display:flex;align-items:center;margin-bottom:10px}
.prl-phase-chip{font-size:10px;font-weight:800;font-family:var(--mono);letter-spacing:.3px;color:var(--pc,#6366f1);background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.35);border-radius:20px;padding:3px 12px;display:inline-block}
/* Office scene container */
.prl-office{position:relative;min-height:130px;display:flex;align-items:flex-end;padding-bottom:8px;overflow:hidden}
/* Floor — gradient wood planks effect */
.prl-office-floor{position:absolute;bottom:0;left:0;right:0;height:8px;background:linear-gradient(90deg,#1c1a2e,#26243e,#1e1c32,#28263c,#1c1a2e);border-radius:4px;box-shadow:0 -1px 0 rgba(255,255,255,.05)}
/* Desks row */
.prl-desks-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;position:relative;z-index:2;padding-bottom:8px}
/* Individual desk card */
.prl-desk{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 6px 4px;border-radius:12px;background:#0a0a18;border:1.5px solid #252535;transition:border-color .4s,background .4s,box-shadow .4s;position:relative;min-width:80px}
.prl-desk--active{background:#0c0c20;border-color:var(--dc,#6366f1);box-shadow:0 0 20px rgba(99,102,241,.2),0 0 40px rgba(99,102,241,.08)}
.prl-desk--done{border-color:#1e3a1e;background:#0a150a}
/* Action bubble above character */
.prl-action-bubble{font-size:9px;color:#6b7280;font-family:var(--mono);padding:2px 6px;border-radius:8px;background:#111;border:1px solid #2a2a38;min-height:16px;text-align:center;transition:all .3s}
.prl-action-bubble--active{color:var(--dc,#6366f1);border-color:var(--dc,#6366f1);background:rgba(99,102,241,.08);animation:parlBubblePop .4s ease}
@keyframes parlBubblePop{0%{transform:scale(.85);opacity:.5}100%{transform:scale(1);opacity:1}}
/* Character SVG animations */
@keyframes parlArmType{0%,100%{transform:rotate(-8deg) translateY(0)}50%{transform:rotate(8deg) translateY(2px)}}
@keyframes parlHeadNod{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(2px) rotate(4deg)}}
@keyframes parlDocBob{0%,100%{transform:translateY(0) rotate(-5deg)}50%{transform:translateY(-3px) rotate(5deg)}}
.prl-arm{transform-origin:50% 100%;animation:parlArmType .55s ease-in-out infinite}
.prl-head{transform-origin:50% 100%;animation:parlHeadNod .8s ease-in-out infinite}
.prl-doc-hold{transform-origin:center center;animation:parlDocBob .7s ease-in-out infinite}
/* Agent name label */
.prl-desk-name{font-size:9px;font-family:var(--mono);font-weight:700;letter-spacing:.3px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:68px}
/* MASTER ORCHESTRATOR */
.prl-master{position:absolute;bottom:8px;right:8px;display:flex;flex-direction:column;align-items:center;gap:1px;z-index:3;transition:right .8s cubic-bezier(.4,0,.2,1)}
.prl-master-label{font-size:8px;font-family:var(--mono);font-weight:700;letter-spacing:.4px;text-align:center;text-shadow:0 0 8px currentColor}
/* Walking animation — smooth left-right patrol */
@keyframes parlMasterWalk{0%{right:8px}25%{right:calc(100% - 70px)}50%{right:calc(100% - 70px)}75%{right:8px}100%{right:8px}}
/* Leg swing for natural walking gait */
@keyframes parlMasterLegL{0%,100%{transform:rotate(0deg)}25%{transform:rotate(25deg)}75%{transform:rotate(-20deg)}}
@keyframes parlMasterLegR{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-20deg)}75%{transform:rotate(25deg)}}
/* Arm swing (opposite to legs) */
@keyframes parlMasterArmSwing{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-18deg)}75%{transform:rotate(18deg)}}
/* Head bob while walking */
@keyframes parlMasterBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
.prl-master-walk{animation:parlMasterWalk 4s ease-in-out infinite}
.prl-master-walk .prl-master-leg-l{transform-origin:50% 0;animation:parlMasterLegL .5s ease-in-out infinite}
.prl-master-walk .prl-master-leg-r{transform-origin:50% 0;animation:parlMasterLegR .5s ease-in-out infinite}
.prl-master-walk .prl-master-arm-l{transform-origin:50% 0;animation:parlMasterArmSwing .5s ease-in-out infinite}
.prl-master-walk .prl-master-arm-r{transform-origin:50% 0;animation:parlMasterArmSwing .5s ease-in-out infinite reverse}
/* R2 supervise: gentle idle bob at active desk */
@keyframes parlMasterSupervise{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.prl-master-supervise{animation:parlMasterSupervise 2s ease-in-out infinite}
/* Flying documents: smooth parabolic arc between agents */
.prl-fly-container{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden;z-index:4}
@keyframes parlFlyDoc{0%{transform:translate(0,70px) scale(.6) rotate(-20deg);opacity:0}15%{opacity:1;transform:translate(8%,20px) scale(.9) rotate(-5deg)}40%{transform:translate(30%,-15px) scale(1.1) rotate(3deg);opacity:1}65%{transform:translate(60%,5px) scale(.95) rotate(8deg);opacity:.9}85%{opacity:.6}100%{transform:translate(90%,60px) scale(.6) rotate(15deg);opacity:0}}
.prl-fly-doc{position:absolute;top:15%;left:3%;animation:parlFlyDoc 1.6s cubic-bezier(.4,0,.2,1) infinite;opacity:0;filter:drop-shadow(0 4px 8px rgba(34,211,238,.4))}
/* Progress bar (during deliberation) */
.prl-progress{height:3px;background:#1a1a2e;border-radius:4px;margin-top:10px;overflow:hidden}
.prl-progress__bar{height:100%;background:linear-gradient(90deg,#6366f1,#22d3ee);border-radius:4px;transition:width .5s ease}
/* Convergence result */
.prl-conv-wrap{margin-top:10px;padding:8px 12px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.22);border-radius:8px}
.prl-conv-bar-outer{height:4px;background:#1a2e1a;border-radius:4px;overflow:hidden;margin-bottom:6px}
.prl-conv-bar-inner{height:100%;background:linear-gradient(90deg,#22c55e,#4ade80);border-radius:4px;transition:width .8s ease}
.prl-conv-text{font-size:9px;color:#86efac;line-height:1.55}
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
.md-body .md-h4{font-size:12px;font-weight:600;color:var(--dim);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.5px;line-height:1.3}
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

<div id="canvasPanel"><div class="cvs-header"><div style="display:flex;align-items:center;gap:8px"><button id="canvasTabC" onclick="canvasShowCanvas()" style="background:none;border:none;border-bottom:2px solid var(--green);color:var(--green);cursor:pointer;font-family:var(--mono);font-size:11px;padding:2px 6px">Canvas</button><button id="canvasTabB" onclick="canvasShowBrowser()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-family:var(--mono);font-size:11px;padding:2px 6px">Browser</button><span id="canvasTitle" style="font-family:var(--mono);color:var(--green);font-size:11px;margin-left:8px">Canvas</span></div><div style="display:flex;align-items:center;gap:4px"><span id="canvasNav" style="display:none;gap:4px"><button onclick="canvasPrev()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Previous">&#x25C0;</button><button onclick="canvasNext()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Next">&#x25B6;</button></span><button onclick="canvasDownloadHTML()" style="background:none;border:none;color:var(--green3);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Scarica Dashboard HTML">&#x2913; HTML</button><button onclick="canvasCopyText()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy text content">Copy</button><button onclick="canvasCopyImage()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;font-family:var(--mono)" title="Copy as image">IMG</button><button onclick="toggleCanvasSize()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Resize">&#x2922;</button><button onclick="closeCanvas()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px" title="Close">&times;</button></div></div><iframe id="canvasFrame" sandbox="allow-scripts" srcdoc=""></iframe></div>
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
