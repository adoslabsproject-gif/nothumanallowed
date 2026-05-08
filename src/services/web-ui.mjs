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
var dash = {emails:[],events:[],tasks:[],plan:null,status:null,weather:null};
var dashLoaded = {emails:false,events:false,tasks:false,contacts:false,notes:false,drive:false,github:false,notion:false,slack:false,weather:false};
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
  // Close any open modal (e.g. calendar day detail) before switching view
  var modal=document.getElementById('agentModal');
  if(modal&&modal.classList.contains('modal-overlay--open')){closeModal();}
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
  if(ct){
    if(v==='chat'){ct.classList.add('content--chat')}else{ct.classList.remove('content--chat')}
    if(v==='webcraft'){ct.classList.add('content--webcraft')}else{ct.classList.remove('content--webcraft')}
  }
  closeSidebar();
  // Auto-close floating panels when leaving chat/studio
  if(v!=='chat'&&v!=='studio'){closeBrowserViewer();closeCanvas();}
  render();
}
function openSidebar() {
  document.getElementById('sidebar').classList.add('sidebar--open');
  document.getElementById('overlay').classList.add('sidebar__overlay--open');
  var mb = document.getElementById('mobileBurger'); if (mb) mb.style.display = 'none';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('sidebar--open');
  document.getElementById('overlay').classList.remove('sidebar__overlay--open');
  var mb = document.getElementById('mobileBurger'); if (mb) mb.style.display = '';
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
function loadWeather(){
  var savedLoc=localStorage.getItem('nha_weather_location');
  function fetchWeather(loc){
    apiGet('/api/weather?location='+encodeURIComponent(loc)).then(function(r){
      if(r&&r.tempC){dash.weather=r;dashLoaded.weather=true;if(currentView==='dashboard')render();}
      else{dashLoaded.weather=true;if(currentView==='dashboard')render();}
    }).catch(function(){dashLoaded.weather=true;if(currentView==='dashboard')render();});
  }
  function ipFallback(){
    fetch('https://ipapi.co/json/').then(function(r){return r.json();}).then(function(d){
      var city=d.city||'';
      if(city){localStorage.setItem('nha_weather_location',city);fetchWeather(city);}
      else{dashLoaded.weather=true;render();}
    }).catch(function(){dashLoaded.weather=true;render();});
  }
  // If location already known, use it directly
  if(savedLoc){fetchWeather(savedLoc);return;}
  // Try browser geolocation — pass lat,lng directly to wttr.in (no reverse geocoding needed)
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(function(pos){
      var latLng=pos.coords.latitude.toFixed(4)+','+pos.coords.longitude.toFixed(4);
      fetchWeather(latLng);
      // Also resolve city name for display — save for next time
      fetch('https://nominatim.openstreetmap.org/reverse?lat='+pos.coords.latitude+'&lon='+pos.coords.longitude+'&format=json&accept-language=en&zoom=10')
        .then(function(r){return r.json();}).then(function(d){
          // zoom=10 = city level — avoids resolving to suburbs/villages
          var city=d.address&&(d.address.city||d.address.town||d.address.county||'');
          if(city)localStorage.setItem('nha_weather_location',city);
        }).catch(function(){});
    },function(){ipFallback();},{timeout:6000,maximumAge:300000});
  } else {
    ipFallback();
  }
}

function loadDash(){
  // Load each API independently  -  render as each arrives (emails are slow)
  apiGet('/api/status').then(function(r){dash.status=r;render()});
  apiGet('/api/tasks').then(function(r){dash.tasks=(r&&r.tasks)||[];dashLoaded.tasks=true;updateBadges();render()});
  apiGet('/api/calendar').then(function(r){dash.events=(r&&r.events)||[];dashLoaded.events=true;updateBadges();render()});
  if(!dashLoaded.weather)loadWeather();
  return apiGet('/api/emails?page=0&pageSize=25').then(function(r){dash.emails=(r&&r.emails)||[];dash._emailHasMore=r&&r.hasMore;dashLoaded.emails=true;emailPage=0;updateBadges();render()});
}
function loadAgents(){return apiGet('/api/agents').then(function(r){agentsList=(r&&r.agents)||[]})}
function updateBadges(){
  var tb=document.getElementById('taskBadge'),cb=document.getElementById('calBadge');
  var ut=dash.tasks.filter(function(t){return t.status!=='done'}).length,uc=dash.events.length;
  if(tb){tb.textContent=ut;tb.style.display=ut>0?'':'none'}
  if(cb){cb.textContent=uc;cb.style.display=uc>0?'':'none'}
  updateEmailBadge();
}
function updateEmailBadge(){
  var eb=document.getElementById('emailBadge');
  if(!eb)return;
  // Try IMAP unread first; fall back to Google dash count
  apiGet('/api/imap/unread-count').then(function(r){
    var imapUnread=r.unread||0;
    var googleUnread=dash.emails?dash.emails.filter(function(e){return e.isUnread}).length:0;
    var total=imapUnread+googleUnread;
    eb.textContent=total;
    eb.style.display=total>0?'':'none';
  }).catch(function(){
    var ue=dash.emails?dash.emails.filter(function(e){return e.isUnread}).length:0;
    eb.textContent=ue;
    eb.style.display=ue>0?'':'none';
  });
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
    case 'webcraft':renderWebCraft(el);break;
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
  var weatherCard;
  if(dashLoaded.weather&&dash.weather){
    var wm=dash.weather;
    var wIcons={Sunny:'&#9728;',Clear:'&#9728;','Partly Cloudy':'&#9925;','Partly cloudy':'&#9925;',Cloudy:'&#9729;',Overcast:'&#9729;','Light rain':'&#127783;','Patchy light drizzle':'&#127783;','Moderate rain':'&#127783;','Heavy rain':'&#127783;',Rain:'&#127783;',Drizzle:'&#127783;',Snow:'&#10052;','Light snow':'&#10052;',Fog:'&#127787;',Mist:'&#127787;',Thunder:'&#9889;','Thundery outbreaks':'&#9889;'};
    var wIcon=wIcons[wm.desc]||'&#127781;';
    weatherCard='<div class="card" style="cursor:default"><div class="card__title" style="display:flex;align-items:center;justify-content:space-between">'+
      '<span>'+esc(wm.city)+(wm.country?', '+esc(wm.country.slice(0,2)):'')+'</span>'+
      '<span style="font-size:10px;color:var(--dim);cursor:pointer" onclick="nhaSetWeatherLocation()">&#9998; change</span>'+
      '</div>'+
      '<div class="card__value" style="font-size:28px">'+wIcon+' '+esc(wm.tempC)+'&#176;C</div>'+
      '<div class="card__sub">'+esc(wm.desc)+' &middot; feels '+esc(wm.feelsC)+'&#176;C &middot; &#128167;'+esc(wm.humidity)+'%</div>'+
    '</div>';
  } else {
    weatherCard='<div class="card" style="cursor:default"><div class="card__title" style="display:flex;align-items:center;justify-content:space-between"><span>Weather</span><span style="font-size:10px;color:var(--dim);cursor:pointer" onclick="nhaSetWeatherLocation()">&#9998; set location</span></div>'+
      '<div class="card__value" style="font-size:22px">--</div>'+
      '<div class="card__sub">'+(dashLoaded.weather?'No data':'Loading...')+'</div></div>';
  }
  var h='<div class="dash-grid">'+
    '<div class="card"><div class="card__title">Tasks</div><div class="card__value">'+pend+'</div><div class="card__sub">'+done+'/'+t.length+' done ('+pct+'%)</div></div>'+
    '<div class="card"><div class="card__title">Emails</div><div class="card__value">'+(dashLoaded.emails?e.length:'<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle"></span>')+'</div><div class="card__sub">'+(dashLoaded.emails?(e.length>0?esc(e[0].from):'Inbox zero'):'Loading...')+'</div></div>'+
    '<div class="card"><div class="card__title">Events</div><div class="card__value">'+ev.length+'</div><div class="card__sub">'+(ev.length>0?esc(ev[0].summary):'No events')+'</div></div>'+
    weatherCard+
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
  document.body.classList.add('canvas-open');
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
function closeCanvas(){var p=document.getElementById('canvasPanel');if(p)p.classList.remove('open');document.body.classList.remove('canvas-open');}
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
    fetch(API+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','x-nha-client':'web-ui'},body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(r){
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

  fetch(API+'/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json','x-nha-client':'web-ui'},body:JSON.stringify(payload),signal:chatAbortController.signal}).then(function(response){
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
              if(currentEvent==='done'){endStreaming();if(data.__sentinel_blocked){chatHistory.splice(streamIdx-1,2);var sentinelWarn=data.content||'Message blocked by SENTINEL.';var el=document.getElementById('chatMessages');if(el){var warn=document.createElement('div');warn.className='msg msg--assistant';warn.style.cssText='border-left:3px solid #ff9800;margin:8px 0;opacity:0.85';warn.innerHTML='<div class="msg__label">SENTINEL</div><div class="msg__bubble md-body" style="color:#ff9800">'+esc(sentinelWarn)+'</div>';el.appendChild(warn);el.scrollTop=el.scrollHeight;}renderMessages();return;}if(data.content){chatHistory[streamIdx].content=data.content.replace(/<think>[\\s\\S]*?<\\/think>/g,'').trim();}else{chatHistory[streamIdx].content=chatHistory[streamIdx].content.replace(/<think>[\\s\\S]*?<\\/think>/g,'').trim();}var ssf=data.screenshotFiles||[];for(var fi=0;fi<ssf.length;fi++){chatHistory[streamIdx].content+='\\n![Screenshot](/api/screenshots/'+ssf[fi]+')\\n';}if(data.inlineHtml){chatHistory[streamIdx].inlineHtml=data.inlineHtml;}var bt=data.browserThumbs||[];if(bt.length>0){var cd=getConvCanvasData();for(var bti=0;bti<bt.length;bti++){var exists=cd.browsers.some(function(b){return b.file===bt[bti].file;});if(!exists)cd.browsers.push({file:bt[bti].file,url:bt[bti].url,ts:new Date().toLocaleTimeString()});}browserIdx=cd.browsers.length-1;saveCanvasData();}renderMessages();loadConvList();if(activeConvId){setTimeout(function(){loadConv(activeConvId);},500);}}
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
// ═══════════════════════════════════════════════════════════════════════════
// EMAIL CLIENT — full 3-pane client (folders / message list / reading pane)
// Supports Google (existing) + IMAP custom accounts via dropdown
// ═══════════════════════════════════════════════════════════════════════════

var emailState = {
  accountId: null,      // 'google' | imap account id
  accountType: 'google',
  labelId: null,
  labelName: 'Inbox',
  search: '',
  offset: 0,
  limit: 50,
  messages: [],
  total: 0,
  activeMessageId: null,
  labels: [],
  accounts: [],
  composing: false,
  composeData: null,   // {to, subject, inReplyTo, references, replyType}
  quillEditor: null,
  googleUnreadCount: 0,
};

function renderEmails(el) {
  el.innerHTML =
    // Load Quill CSS once
    '<link rel="stylesheet" href="https://cdn.quilljs.com/1.3.7/quill.snow.css">' +
    '<div id="emailClientRoot" style="display:flex;height:calc(100vh - 120px);min-height:500px;gap:0;background:var(--bg2);border-radius:10px;border:1px solid var(--border);overflow:hidden">' +
      // Col 1: sidebar
      '<div id="emailSidebar" style="width:200px;min-width:160px;background:var(--bg3);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto"></div>' +
      // Col 2: message list
      '<div id="emailList" style="width:280px;min-width:220px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden">' +
        '<div id="emailListHeader" style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;flex-shrink:0">' +
          '<input id="emailSearch" type="text" placeholder="Search..." onkeydown="if(event.key===String.fromCharCode(13)){emailSearch()}" style="flex:1;padding:5px 10px;font-size:11px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:5px">' +
          '<button onclick="emailSearch()" style="padding:5px 8px;font-size:10px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:4px;cursor:pointer">Go</button>' +
        '</div>' +
        '<div id="emailListBody" style="flex:1;overflow-y:auto"></div>' +
        '<div id="emailListFooter" style="padding:6px 10px;border-top:1px solid var(--border);font-size:10px;color:var(--dim);display:flex;gap:8px;align-items:center;flex-shrink:0">' +
          '<span id="emailListCount"></span>' +
          '<button id="emailLoadMore" onclick="emailLoadMore()" style="display:none;padding:3px 10px;font-size:10px;background:var(--bg);color:var(--cyan);border:1px solid var(--cyan);border-radius:4px;cursor:pointer">Load more</button>' +
        '</div>' +
      '</div>' +
      // Col 3: reading pane / compose
      '<div id="emailPane" style="flex:1;display:flex;flex-direction:column;overflow:hidden"><div style="padding:40px;text-align:center;color:var(--dim);font-size:12px">Select a message</div></div>' +
    '</div>';

  // Load accounts then render sidebar
  emailLoadAccounts();
}

function emailLoadAccounts() {
  apiGet('/api/imap/accounts').then(function(r) {
    emailState.accounts = r.accounts || [];
    emailRenderSidebar();
    // Auto-select: prefer first IMAP account if no Google
    if (emailState.accountId === null) {
      if (emailState.accounts.length > 0) {
        emailSelectAccount(emailState.accounts[0].id, 'imap');
      } else if (dashLoaded.emails) {
        emailSelectAccount('google', 'google');
      }
    } else {
      emailRenderSidebar();
    }
  }).catch(function() {
    if (dashLoaded.emails) emailSelectAccount('google', 'google');
    else emailRenderSidebar();
  });
}

function emailRenderSidebar() {
  var sb = document.getElementById('emailSidebar');
  if (!sb) return;
  var h = '';

  // Account dropdown
  h += '<div style="padding:10px 10px 6px;border-bottom:1px solid var(--border)">';
  h += '<div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Account</div>';
  h += '<select id="emailAccountSelect" onchange="emailOnAccountChange(this.value)" style="width:100%;padding:5px 8px;font-size:11px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:4px">';
  if (dashLoaded.emails) {
    h += '<option value="google"' + (emailState.accountType === 'google' ? ' selected' : '') + '>Google (Gmail)</option>';
  }
  for (var i = 0; i < emailState.accounts.length; i++) {
    var a = emailState.accounts[i];
    h += '<option value="imap:' + esc(a.id) + '"' + (emailState.accountId === a.id ? ' selected' : '') + '>' + esc(a.display_name || a.email_address) + '</option>';
  }
  if (!dashLoaded.emails && emailState.accounts.length === 0) {
    h += '<option value="">No accounts — add in Settings</option>';
  }
  h += '</select></div>';

  // Compose button
  h += '<div style="padding:8px 10px;border-bottom:1px solid var(--border)">';
  h += '<button onclick="emailOpenCompose(null)" style="width:100%;padding:7px;background:var(--green3);color:var(--bg);border:none;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer">+ Compose</button>';
  h += '</div>';

  // Labels / folders
  h += '<div style="flex:1;overflow-y:auto;padding:6px 0">';
  if (emailState.accountType === 'google') {
    var googleFolders = [{id:'INBOX',name:'Inbox',icon:'&#9993;'},{id:'SENT',name:'Sent',icon:'&#8594;'},{id:'DRAFTS',name:'Drafts',icon:'&#128196;'},{id:'SPAM',name:'Spam',icon:'&#128737;'},{id:'TRASH',name:'Trash',icon:'&#128465;'}];
    for (var gi = 0; gi < googleFolders.length; gi++) {
      var gf = googleFolders[gi];
      var sel = emailState.labelId === gf.id;
      var gUnread = (gf.id === 'INBOX' && emailState.googleUnreadCount > 0)
        ? '<span style="margin-left:auto;background:var(--green3);color:var(--bg);border-radius:10px;padding:0 5px;font-size:9px;font-weight:700">' + emailState.googleUnreadCount + '</span>'
        : '';
      h += '<div onclick="emailSelectGoogleFolder(\\x27' + gf.id + '\\x27,\\x27' + gf.name + '\\x27)" style="padding:7px 14px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;' + (sel ? 'background:var(--green3);color:var(--bg);font-weight:700' : 'color:var(--fg)') + '">' + gf.icon + ' ' + esc(gf.name) + gUnread + '</div>';
    }
  } else {
    // IMAP labels
    h += '<div style="padding:4px 10px;display:flex;align-items:center;justify-content:space-between">';
    h += '<span style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:1px">Labels</span>';
    h += '<button onclick="emailShowNewLabel()" style="font-size:10px;background:none;border:none;color:var(--cyan);cursor:pointer">+</button>';
    h += '</div>';
    for (var li = 0; li < emailState.labels.length; li++) {
      var lbl = emailState.labels[li];
      var lsel = emailState.labelId === lbl.id;
      var lcolor = lbl.color || 'var(--dim)';
      var unread = lbl.unread_count > 0 ? '<span style="margin-left:auto;background:var(--green3);color:var(--bg);border-radius:10px;padding:0 5px;font-size:9px;font-weight:700">' + lbl.unread_count + '</span>' : '';
      h += '<div onclick="emailSelectLabel(\\x27' + lbl.id + '\\x27,\\x27' + esc(lbl.name) + '\\x27)" style="padding:6px 14px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;' + (lsel ? 'background:var(--green3);color:var(--bg);font-weight:700;border-radius:4px;margin:0 4px' : 'color:var(--fg)') + '">';
      h += '<span style="width:8px;height:8px;border-radius:50%;background:' + lcolor + ';flex-shrink:0;display:inline-block"></span>';
      h += esc(lbl.name);
      if (!lbl.is_system) h += '<span onclick="event.stopPropagation();emailEditLabel(\\x27' + lbl.id + '\\x27,\\x27' + esc(lbl.name) + '\\x27,\\x27' + (lbl.color||'') + '\\x27)" style="margin-left:auto;font-size:9px;color:var(--dim);cursor:pointer">&#9998;</span>';
      else h += unread;
      h += '</div>';
    }
  }
  h += '</div>';

  // Sync / settings shortcuts
  if (emailState.accountType === 'imap' && emailState.accountId) {
    h += '<div style="padding:8px 10px;border-top:1px solid var(--border)">';
    h += '<button onclick="emailSyncCurrent()" style="width:100%;padding:5px;background:var(--bg);color:var(--cyan);border:1px solid var(--cyan);border-radius:4px;font-size:10px;cursor:pointer">Sync now</button>';
    h += '</div>';
  }

  sb.innerHTML = h;
}

function emailOnAccountChange(val) {
  if (val === 'google') {
    emailSelectAccount('google', 'google');
  } else if (val.startsWith('imap:')) {
    emailSelectAccount(val.slice(5), 'imap');
  }
}

function emailSelectAccount(accountId, type) {
  emailState.accountId = accountId;
  emailState.accountType = type;
  emailState.labelId = null;
  emailState.labelName = 'Inbox';
  emailState.offset = 0;
  emailState.messages = [];
  emailState.activeMessageId = null;
  if (type !== 'google') emailState.googleUnreadCount = 0;
  if (type === 'imap') {
    apiGet('/api/imap/labels?accountId=' + accountId).then(function(r) {
      emailState.labels = r.labels || [];
      // Default to inbox system label
      var inbox = emailState.labels.find(function(l) { return l.system_type === 'inbox'; });
      if (inbox) { emailState.labelId = inbox.id; emailState.labelName = 'Inbox'; }
      emailRenderSidebar();
      emailLoadMessages();
    });
  } else {
    emailState.labels = [];
    emailState.labelId = 'INBOX';
    emailRenderSidebar();
    emailLoadGoogleMessages();
  }
}

function emailSelectLabel(labelId, labelName) {
  emailState.labelId = labelId;
  emailState.labelName = labelName;
  emailState.offset = 0;
  emailState.messages = [];
  emailState.activeMessageId = null;
  emailRenderSidebar();
  emailLoadMessages();
}

function emailSelectGoogleFolder(folderId, folderName) {
  emailState.labelId = folderId;
  emailState.labelName = folderName;
  emailState.offset = 0;
  emailState.messages = [];
  emailRenderSidebar();
  emailLoadGoogleMessages();
}

function emailSearch() {
  var inp = document.getElementById('emailSearch');
  emailState.search = inp ? inp.value.trim() : '';
  emailState.offset = 0;
  emailState.messages = [];
  if (emailState.accountType === 'imap') emailLoadMessages();
  else emailLoadGoogleMessages();
}

function emailLoadMessages() {
  var listBody = document.getElementById('emailListBody');
  if (listBody) listBody.innerHTML = '<div style="padding:20px;text-align:center"><div class="spinner"></div></div>';
  var qs = '/api/imap/messages?accountId=' + encodeURIComponent(emailState.accountId) +
    '&limit=' + emailState.limit + '&offset=' + emailState.offset;
  if (emailState.labelId) qs += '&labelId=' + encodeURIComponent(emailState.labelId);
  if (emailState.search) qs += '&search=' + encodeURIComponent(emailState.search);
  apiGet(qs).then(function(r) {
    if (emailState.offset === 0) emailState.messages = r.messages || [];
    else emailState.messages = emailState.messages.concat(r.messages || []);
    emailState.total = r.total || 0;
    emailRenderMessageList();
  }).catch(function(e) {
    if (listBody) listBody.innerHTML = '<div style="padding:20px;color:var(--red);font-size:12px">' + esc(e.message) + '</div>';
  });
}

function emailLoadGoogleMessages() {
  var listBody = document.getElementById('emailListBody');
  if (listBody) listBody.innerHTML = '<div style="padding:20px;text-align:center"><div class="spinner"></div></div>';
  // Use the server-side API endpoint — avoids Node.js module imports in browser context
  var filter = (emailState.labelId === 'INBOX' || !emailState.labelId) ? 'all' : emailState.labelId.toLowerCase();
  var qs = '/api/emails?filter=' + encodeURIComponent(filter) + '&page=0&pageSize=50';
  if (emailState.search) qs = '/api/emails?filter=' + encodeURIComponent(emailState.search) + '&page=0&pageSize=50';
  apiGet(qs).then(function(r) {
    emailState.messages = (r.emails || []).map(function(m) {
      return { id: m.id, subject: m.subject, from_name: m.from, from_address: m.from, internal_date: m.date, body_preview: m.snippet, is_read: !m.isUnread, is_starred: false, has_attachments: false, _google: true };
    });
    emailState.total = emailState.messages.length;
    if (emailState.labelId === 'INBOX' || !emailState.labelId) {
      emailState.googleUnreadCount = emailState.messages.filter(function(m) { return !m.is_read; }).length;
      emailRenderSidebar();
    }
    emailRenderMessageList();
  }).catch(function() {
    // Fallback to cached dash emails
    emailState.messages = (dash.emails || []).map(function(m) {
      return { id: m.id, subject: m.subject, from_name: m.from, from_address: m.from, internal_date: m.date, body_preview: m.snippet, is_read: !m.isUnread, is_starred: false, has_attachments: false, _google: true };
    });
    emailState.total = emailState.messages.length;
    emailState.googleUnreadCount = emailState.messages.filter(function(m) { return !m.is_read; }).length;
    emailRenderSidebar();
    emailRenderMessageList();
  });
}

function emailRenderMessageList() {
  var listBody = document.getElementById('emailListBody');
  var listCount = document.getElementById('emailListCount');
  var loadMoreBtn = document.getElementById('emailLoadMore');
  if (!listBody) return;
  if (listCount) listCount.textContent = emailState.total + ' messages';
  if (loadMoreBtn) loadMoreBtn.style.display = (emailState.messages.length < emailState.total && emailState.accountType === 'imap') ? 'inline-block' : 'none';
  if (!emailState.messages.length) {
    listBody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--dim);font-size:12px">No messages</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < emailState.messages.length; i++) {
    var m = emailState.messages[i];
    var active = m.id === emailState.activeMessageId;
    var unread = !m.is_read;
    var date = m.internal_date ? m.internal_date.slice(0, 10) : '';
    var from = esc(m.from_name || m.from_address || '');
    h += '<div onclick="emailOpenMessage(\\x27' + esc(m.id) + '\\x27)" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);' +
      (active ? 'background:var(--green3);' : 'background:' + (unread ? 'var(--bg2)' : 'var(--bg3)') + ';') +
      (unread ? 'border-left:3px solid var(--green);' : 'border-left:3px solid transparent;') + '">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:2px">' +
      '<span style="font-size:12px;font-weight:' + (unread ? '700' : '500') + ';color:' + (active ? 'var(--bg)' : 'var(--bright)') + ';max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + from + '</span>' +
      '<span style="font-size:10px;color:' + (active ? 'var(--bg)' : 'var(--dim)') + '">' + esc(date) + '</span>' +
      '</div>' +
      '<div style="font-size:11px;font-weight:' + (unread ? '600' : '400') + ';color:' + (active ? 'var(--bg)' : 'var(--text)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(m.subject || '(no subject)') + '</div>' +
      '<div style="font-size:10px;color:' + (active ? 'rgba(0,0,0,0.6)' : 'var(--dim)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">' + esc((m.body_preview || '').slice(0, 80)) + '</div>' +
      '</div>';
  }
  listBody.innerHTML = h;
}

function emailLoadMore() {
  emailState.offset += emailState.limit;
  emailLoadMessages();
}

function emailOpenMessage(id) {
  emailState.activeMessageId = id;
  emailRenderMessageList();
  var pane = document.getElementById('emailPane');
  if (!pane) return;
  pane.innerHTML = '<div style="padding:30px;text-align:center"><div class="spinner"></div></div>';

  if (emailState.accountType === 'google') {
    apiPost('/api/email/read', { messageId: id }).then(function(r) {
      var m = r.message || r;
      emailRenderReadingPane(pane, {
        id: id, subject: m.subject, from_address: m.from, from_name: m.from,
        to_addresses: m.to, internal_date: m.date,
        body_html: m.bodyHtml || null, body_text: m.body || m.snippet || '',
        attachments: [], labels: [], is_read: true, is_starred: false, _google: true,
      });
      apiPost('/api/email/mark-read', { messageId: id }).catch(function() {});
    });
  } else {
    apiGet('/api/imap/message?id=' + encodeURIComponent(id)).then(function(r) {
      emailRenderReadingPane(pane, r.message);
      // Update read state in local list
      var msg = emailState.messages.find(function(m) { return m.id === id; });
      if (msg && !msg.is_read) { msg.is_read = true; updateEmailBadge(); }
      emailRenderMessageList();
    }).catch(function(e) {
      pane.innerHTML = '<div style="padding:20px;color:var(--red);font-size:12px">' + esc(e.message) + '</div>';
    });
  }
}

function emailRenderReadingPane(pane, m) {
  if (!m) { pane.innerHTML = '<div style="padding:20px;color:var(--red);font-size:12px">Could not load message</div>'; return; }

  var toStr = '';
  try {
    var toArr = typeof m.to_addresses === 'string' ? JSON.parse(m.to_addresses) : (m.to_addresses || []);
    toStr = toArr.map(function(a) { return a.name ? a.name + ' <' + a.address + '>' : (a.address || a); }).join(', ');
  } catch(e) { toStr = m.to_addresses || ''; }

  var h = '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg3)">';
  h += '<div style="display:flex;gap:6px">';
  h += '<button onclick="emailOpenCompose({replyTo:\\x27' + esc(m.id) + '\\x27,type:\\x27reply\\x27,subject:\\x27Re: ' + esc(m.subject||'') + '\\x27,to:\\x27' + esc(m.from_address||'') + '\\x27,inReplyTo:\\x27' + esc(m.message_id||m.id) + '\\x27})" style="padding:5px 12px;font-size:11px;background:var(--green3);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:700">Reply</button>';
  h += '<button onclick="emailOpenCompose({replyTo:\\x27' + esc(m.id) + '\\x27,type:\\x27forward\\x27,subject:\\x27Fwd: ' + esc(m.subject||'') + '\\x27})" style="padding:5px 12px;font-size:11px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:4px;cursor:pointer">Forward</button>';
  if (!m._google) {
    h += '<button onclick="emailTrash(\\x27' + esc(m.id) + '\\x27)" style="padding:5px 10px;font-size:11px;background:var(--bg);color:var(--red);border:1px solid var(--border);border-radius:4px;cursor:pointer">&#128465;</button>';
    h += '<button onclick="emailToggleStar(\\x27' + esc(m.id) + '\\x27,' + (m.is_starred ? 'false' : 'true') + ')" style="padding:5px 10px;font-size:11px;background:var(--bg);color:var(--amber,#F59E0B);border:1px solid var(--border);border-radius:4px;cursor:pointer">' + (m.is_starred ? '&#9733;' : '&#9734;') + '</button>';
    // Label assign
    h += '<select onchange="emailAssignLabel(\\x27' + esc(m.id) + '\\x27,this.value);this.value=\\x27\\x27" style="font-size:10px;padding:4px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:4px"><option value="">+ Label</option>';
    for (var li = 0; li < emailState.labels.length; li++) {
      var lbl = emailState.labels[li];
      h += '<option value="' + esc(lbl.id) + '">' + esc(lbl.name) + '</option>';
    }
    h += '</select>';
  }
  h += '<button onclick="emailAskAgent(\\x27' + esc(m.id) + '\\x27)" style="padding:5px 10px;font-size:11px;background:var(--bg);color:var(--cyan);border:1px solid var(--cyan);border-radius:4px;cursor:pointer">Ask AI</button>';
  h += '</div></div>';

  // Header
  h += '<div style="padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0">';
  h += '<div style="font-size:15px;font-weight:700;color:var(--bright);margin-bottom:8px">' + esc(m.subject || '(no subject)') + '</div>';
  h += '<div style="font-size:11px;color:var(--dim)"><strong style="color:var(--text)">From:</strong> ' + esc((m.from_name && m.from_name !== m.from_address ? m.from_name + ' <' + m.from_address + '>' : m.from_address) || '') + '</div>';
  h += '<div style="font-size:11px;color:var(--dim)"><strong style="color:var(--text)">To:</strong> ' + esc(toStr) + '</div>';
  h += '<div style="font-size:11px;color:var(--dim)"><strong style="color:var(--text)">Date:</strong> ' + esc(m.internal_date || '') + '</div>';

  // Attachments
  if (m.attachments && m.attachments.length) {
    h += '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">';
    for (var ai = 0; ai < m.attachments.length; ai++) {
      var att = m.attachments[ai];
      var attUrl = '/api/imap/attachment?messageId=' + encodeURIComponent(m.id) + '&partId=' + encodeURIComponent(att.part_id || '') + '&accountId=' + encodeURIComponent(emailState.accountId);
      h += '<a href="' + attUrl + '" download="' + esc(att.filename || 'attachment') + '" style="font-size:10px;padding:4px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--cyan);text-decoration:none">&#128206; ' + esc(att.filename || 'attachment') + ' (' + Math.round((att.size_bytes||0)/1024) + 'KB)</a>';
    }
    h += '</div>';
  }
  h += '</div>';

  // Body
  h += '<div style="flex:1;overflow-y:auto;padding:16px">';
  if (m.body_html) {
    h += '<iframe id="emailBodyFrame" sandbox="allow-same-origin" style="width:100%;min-height:400px;border:none;background:#fff" srcdoc="' + m.body_html.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"></iframe>';
  } else {
    h += '<pre style="white-space:pre-wrap;word-wrap:break-word;font-size:13px;line-height:1.7;color:var(--text);font-family:inherit">' + esc(m.body_text || m.body_preview || '(empty)') + '</pre>';
  }
  h += '</div>';

  pane.innerHTML = '<div style="display:flex;flex-direction:column;height:100%">' + h + '</div>';
}

var EMAIL_TEMPLATES = [
  {
    id: 'promo_product',
    name: 'Promozione prodotto',
    subject: 'Scopri la nostra offerta su [PRODOTTO]',
    html: '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#1a1a2e;padding:32px 40px;text-align:center"><h1 style="color:#00ff9d;margin:0;font-size:26px;letter-spacing:-0.5px">[AZIENDA]</h1></td></tr><tr><td style="padding:40px;background:#ffffff"><h2 style="color:#1a1a2e;font-size:22px;margin:0 0 16px">[TITOLO OFFERTA]</h2><p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 24px">[DESCRIZIONE PRODOTTO/SERVIZIO]</p><p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 32px">[DETTAGLIO BENEFICI O SPECIFICHE]</p><table cellpadding="0" cellspacing="0"><tr><td style="background:#00ff9d;border-radius:6px;padding:14px 32px"><a href="[LINK_CTA]" style="color:#1a1a2e;font-weight:700;font-size:15px;text-decoration:none">[TESTO CTA]</a></td></tr></table></td></tr><tr><td style="padding:24px 40px;background:#f5f5f5;text-align:center"><p style="color:#888;font-size:12px;margin:0">[AZIENDA] &bull; [INDIRIZZO] &bull; <a href="mailto:[EMAIL]" style="color:#888">[EMAIL]</a></p><p style="color:#bbb;font-size:11px;margin:8px 0 0"><a href="[UNSUBSCRIBE_LINK]" style="color:#bbb">Disiscriviti</a></p></td></tr></table>',
  },
  {
    id: 'newsletter',
    name: 'Newsletter mensile',
    subject: '[AZIENDA] Newsletter — [MESE] [ANNO]',
    html: '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:28px 40px;border-bottom:3px solid #00ff9d"><h1 style="color:#ffffff;margin:0;font-size:22px">[AZIENDA]</h1><p style="color:#00ff9d;margin:6px 0 0;font-size:13px">Newsletter [MESE] [ANNO]</p></td></tr><tr><td style="padding:36px 40px;background:#ffffff"><h2 style="color:#1a1a2e;font-size:20px;margin:0 0 12px">[TITOLO PRINCIPALE]</h2><p style="color:#555;font-size:14px;line-height:1.8;margin:0 0 28px">[TESTO PRINCIPALE — racconta la novità principale del mese]</p><hr style="border:none;border-top:1px solid #eee;margin:0 0 28px"><h3 style="color:#1a1a2e;font-size:16px;margin:0 0 10px">[TITOLO SEZIONE 2]</h3><p style="color:#555;font-size:14px;line-height:1.8;margin:0 0 28px">[TESTO SEZIONE 2]</p><hr style="border:none;border-top:1px solid #eee;margin:0 0 28px"><h3 style="color:#1a1a2e;font-size:16px;margin:0 0 10px">[TITOLO SEZIONE 3]</h3><p style="color:#555;font-size:14px;line-height:1.8;margin:0 0 28px">[TESTO SEZIONE 3]</p><table cellpadding="0" cellspacing="0"><tr><td style="background:#1a1a2e;border-radius:6px;padding:12px 28px"><a href="[LINK]" style="color:#00ff9d;font-weight:700;font-size:14px;text-decoration:none">Leggi di più &rarr;</a></td></tr></table></td></tr><tr><td style="padding:20px 40px;background:#f9f9f9;text-align:center"><p style="color:#999;font-size:12px;margin:0">&copy; [ANNO] [AZIENDA] &bull; <a href="[UNSUBSCRIBE_LINK]" style="color:#999">Disiscriviti</a></p></td></tr></table>',
  },
  {
    id: 'follow_up',
    name: 'Follow-up commerciale',
    subject: 'Seguito alla nostra conversazione — [ARGOMENTO]',
    html: '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="padding:40px"><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 16px">Gentile [NOME],</p><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 16px">la contatto in seguito a [CONTESTO: fiera / chiamata / incontro del GIORNO].</p><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 16px">[CORPO PRINCIPALE: riassumi la proposta, il valore offerto, eventuali prossimi passi]</p><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 32px">[CHIUSURA: proposta di call / richiesta feedback / disponibilit&agrave; a incontro]</p><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 4px">Cordiali saluti,</p><p style="color:#1a1a2e;font-size:15px;font-weight:700;margin:0">[NOME MITTENTE]</p><p style="color:#888;font-size:13px;margin:4px 0 0">[RUOLO] &bull; [AZIENDA] &bull; [TELEFONO]</p></td></tr></table>',
  },
  {
    id: 'offerta',
    name: 'Invio offerta / preventivo',
    subject: 'Offerta [NUMERO] — [OGGETTO FORNITURA]',
    html: '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#1a1a2e;padding:24px 40px"><h1 style="color:#00ff9d;margin:0;font-size:20px">[AZIENDA]</h1><p style="color:#aaa;margin:4px 0 0;font-size:12px">Offerta n. [NUMERO] del [DATA]</p></td></tr><tr><td style="padding:36px 40px;background:#ffffff"><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 16px">Gentile [NOME],</p><p style="color:#333;font-size:15px;line-height:1.7;margin:0 0 24px">in risposta alla Vostra richiesta, siamo lieti di sottoporre la seguente offerta:</p><table width="100%" cellpadding="10" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px"><tr style="background:#f0f0f0"><th style="text-align:left;font-size:13px;color:#333;border-bottom:2px solid #ddd">Descrizione</th><th style="text-align:right;font-size:13px;color:#333;border-bottom:2px solid #ddd">Qt&agrave;</th><th style="text-align:right;font-size:13px;color:#333;border-bottom:2px solid #ddd">Prezzo unit.</th><th style="text-align:right;font-size:13px;color:#333;border-bottom:2px solid #ddd">Totale</th></tr><tr><td style="font-size:13px;color:#444;border-bottom:1px solid #eee">[ARTICOLO 1]</td><td style="text-align:right;font-size:13px;color:#444;border-bottom:1px solid #eee">[QT]</td><td style="text-align:right;font-size:13px;color:#444;border-bottom:1px solid #eee">&euro; [PREZZO]</td><td style="text-align:right;font-size:13px;color:#444;border-bottom:1px solid #eee">&euro; [TOT]</td></tr><tr><td style="font-size:13px;color:#444;border-bottom:1px solid #eee">[ARTICOLO 2]</td><td style="text-align:right;font-size:13px;color:#444;border-bottom:1px solid #eee">[QT]</td><td style="text-align:right;font-size:13px;color:#444;border-bottom:1px solid #eee">&euro; [PREZZO]</td><td style="text-align:right;font-size:13px;color:#444;border-bottom:1px solid #eee">&euro; [TOT]</td></tr><tr style="background:#f9f9f9"><td colspan="3" style="text-align:right;font-weight:700;font-size:14px;color:#1a1a2e;padding-top:12px">Totale IVA esclusa</td><td style="text-align:right;font-weight:700;font-size:14px;color:#1a1a2e;padding-top:12px">&euro; [TOTALE]</td></tr></table><p style="color:#555;font-size:13px;line-height:1.7;margin:0 0 8px"><strong>Condizioni di pagamento:</strong> [PAGAMENTO]</p><p style="color:#555;font-size:13px;line-height:1.7;margin:0 0 8px"><strong>Tempi di consegna:</strong> [CONSEGNA]</p><p style="color:#555;font-size:13px;line-height:1.7;margin:0 0 24px"><strong>Validit&agrave; offerta:</strong> [VALIDITA]</p><p style="color:#333;font-size:14px;line-height:1.7;margin:0 0 4px">Resto a disposizione per qualsiasi chiarimento.</p><p style="color:#333;font-size:14px;line-height:1.7;margin:0 0 4px">Cordiali saluti,</p><p style="color:#1a1a2e;font-size:14px;font-weight:700;margin:0">[NOME MITTENTE]</p><p style="color:#888;font-size:12px;margin:4px 0 0">[AZIENDA] &bull; [EMAIL] &bull; [TELEFONO]</p></td></tr></table>',
  },
  {
    id: 'evento',
    name: 'Invito evento / webinar',
    subject: 'Sei invitato: [NOME EVENTO] — [DATA]',
    html: '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:linear-gradient(135deg,#0f0f1a,#1a2a1a);padding:48px 40px;text-align:center"><h1 style="color:#00ff9d;margin:0 0 8px;font-size:28px;letter-spacing:-0.5px">[NOME EVENTO]</h1><p style="color:#aaffcc;margin:0;font-size:16px">[DATA] &bull; [ORA] &bull; [LUOGO / Online]</p></td></tr><tr><td style="padding:40px;background:#ffffff;text-align:center"><p style="color:#444;font-size:15px;line-height:1.8;max-width:460px;margin:0 auto 28px">[DESCRIZIONE EVENTO: di cosa si tratta, a chi &egrave; rivolto, perch&eacute; non perderselo]</p><p style="color:#555;font-size:14px;line-height:1.8;max-width:460px;margin:0 auto 32px">[AGENDA O PUNTI CHIAVE]</p><table cellpadding="0" cellspacing="0" style="margin:0 auto 32px"><tr><td style="background:#00ff9d;border-radius:8px;padding:14px 40px"><a href="[LINK_REGISTRAZIONE]" style="color:#0f0f1a;font-weight:700;font-size:15px;text-decoration:none">Registrati ora &rarr;</a></td></tr></table><p style="color:#999;font-size:12px;margin:0">Posti limitati &bull; Registrazione gratuita</p></td></tr><tr><td style="padding:20px 40px;background:#f5f5f5;text-align:center"><p style="color:#bbb;font-size:11px;margin:0">[AZIENDA] &bull; <a href="[UNSUBSCRIBE_LINK]" style="color:#bbb">Disiscriviti</a></p></td></tr></table>',
  },
  {
    id: 'ringraziamento',
    name: 'Ringraziamento cliente',
    subject: 'Grazie per la fiducia, [NOME]',
    html: '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="background:#0f0f1a;padding:32px 40px;text-align:center"><p style="color:#00ff9d;font-size:36px;margin:0">&#128591;</p><h1 style="color:#ffffff;font-size:22px;margin:8px 0 0">Grazie, [NOME]!</h1></td></tr><tr><td style="padding:40px;background:#ffffff"><p style="color:#333;font-size:15px;line-height:1.8;margin:0 0 16px">Volevamo ringraziarti personalmente per [MOTIVO: il tuo acquisto / la tua fiducia / anni di collaborazione].</p><p style="color:#333;font-size:15px;line-height:1.8;margin:0 0 16px">[MESSAGGIO PERSONALE: cosa significa per noi, cosa ci impegniamo a fare, cosa offriamo come segno di riconoscimento]</p><p style="color:#333;font-size:15px;line-height:1.8;margin:0 0 32px">[CHIUSURA: invito a restare in contatto, disponibilit&agrave;]</p><p style="color:#333;font-size:15px;margin:0 0 4px">Con stima,</p><p style="color:#1a1a2e;font-size:15px;font-weight:700;margin:0">[NOME MITTENTE]</p><p style="color:#888;font-size:13px;margin:4px 0 0">[RUOLO] &bull; [AZIENDA]</p></td></tr></table>',
  },
];

function emailLoadTemplate(idx) {
  var t = EMAIL_TEMPLATES[idx];
  if (!t) return;
  var subj = document.getElementById('compSubject');
  if (subj && !subj.value) subj.value = t.subject;
  if (emailState.quillEditor) {
    emailState.quillEditor.clipboard.dangerouslyPasteHTML(t.html);
  }
  var dd = document.getElementById('compTemplateDrop');
  if (dd) dd.style.display = 'none';
}

function emailToggleTemplates() {
  var dd = document.getElementById('compTemplateDrop');
  if (!dd) return;
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function emailOpenCompose(opts) {
  var pane = document.getElementById('emailPane');
  if (!pane) return;
  opts = opts || {};

  var h = '<div style="display:flex;flex-direction:column;height:100%;padding:14px;gap:8px">';
  h += '<div style="font-size:13px;font-weight:700;color:var(--bright);border-bottom:1px solid var(--border);padding-bottom:8px">Compose</div>';
  h += '<input id="compTo" type="text" placeholder="To" value="' + esc(opts.to || '') + '" style="padding:7px 10px;font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:5px">';
  h += '<input id="compCc" type="text" placeholder="Cc" style="padding:7px 10px;font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:5px">';
  h += '<input id="compSubject" type="text" placeholder="Subject" value="' + esc(opts.subject || '') + '" style="padding:7px 10px;font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:5px">';
  h += '<input type="hidden" id="compInReplyTo" value="' + esc(opts.inReplyTo || '') + '">';
  h += '<input type="hidden" id="compReplyToId" value="' + esc(opts.replyTo || '') + '">';
  // Template picker
  h += '<div style="position:relative">';
  h += '<button onclick="emailToggleTemplates()" style="padding:5px 12px;font-size:11px;background:var(--bg);color:var(--cyan);border:1px solid var(--cyan);border-radius:5px;cursor:pointer">&#128196; Template marketing</button>';
  h += '<div id="compTemplateDrop" style="display:none;position:absolute;top:100%;left:0;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:6px;min-width:240px;padding:4px 0;margin-top:4px;box-shadow:0 4px 16px rgba(0,0,0,0.3)">';
  for (var ti = 0; ti < EMAIL_TEMPLATES.length; ti++) {
    h += '<div class="tpl-item" onclick="emailLoadTemplate(' + ti + ')" style="padding:9px 16px;font-size:12px;cursor:pointer;color:var(--fg);border-bottom:1px solid var(--border)"><strong>' + esc(EMAIL_TEMPLATES[ti].name) + '</strong><div style="font-size:10px;color:var(--dim);margin-top:2px">' + esc(EMAIL_TEMPLATES[ti].subject.slice(0, 50)) + '</div></div>';
  }
  h += '</div></div>';
  // Quill editor container
  h += '<style>.ql-editor{color:#111!important;font-size:14px!important;line-height:1.6!important}.ql-editor p,.ql-editor li,.ql-editor h1,.ql-editor h2,.ql-editor h3{color:inherit}.ql-toolbar{background:#f5f5f5!important;border-radius:5px 5px 0 0!important}</style>';
  h += '<div id="quillContainer" style="flex:1;min-height:200px;background:#ffffff;border-radius:0 0 5px 5px;overflow:auto;display:flex;flex-direction:column"></div>';
  // Toolbar
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
  h += '<button onclick="emailSend()" style="padding:7px 18px;background:var(--green3);color:var(--bg);border:none;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer">Send</button>';
  h += '<button onclick="emailSaveDraft()" style="padding:7px 14px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:5px;font-size:12px;cursor:pointer">Save Draft</button>';
  h += '<button onclick="emailCloseCompose()" style="padding:7px 14px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:5px;font-size:12px;cursor:pointer">Discard</button>';
  h += '<div id="composeStatus" style="font-size:11px;color:var(--dim);align-self:center"></div>';
  h += '</div></div>';

  pane.innerHTML = h;
  emailState.composeData = opts;

  // Init Quill
  if (typeof Quill === 'undefined') {
    var script = document.createElement('script');
    script.src = 'https://cdn.quilljs.com/1.3.7/quill.min.js';
    script.onload = function() { emailInitQuill(opts); };
    document.head.appendChild(script);
  } else {
    emailInitQuill(opts);
  }
}

function emailInitQuill(opts) {
  emailState.quillEditor = new Quill('#quillContainer', {
    theme: 'snow',
    modules: { toolbar: [
      ['bold', 'italic', 'underline', 'strike'],
      [{ list: 'ordered' }, { list: 'bullet' }],
      ['link', 'blockquote', 'code-block'],
      [{ color: [] }, { background: [] }],
      ['clean'],
    ]},
    placeholder: 'Write your message...',
  });
  // Force default text color to black (editor bg is white, NHA theme vars would make text grey)
  emailState.quillEditor.format('color', '#111111');
  // Pre-fill for forward
  if (opts && opts.type === 'forward' && opts.body) {
    emailState.quillEditor.clipboard.dangerouslyPasteHTML('<br><br><hr><p>---------- Forwarded message ----------</p>' + (opts.body || ''));
  }
}

function emailSend() {
  var status = document.getElementById('composeStatus');
  var to = document.getElementById('compTo');
  var cc = document.getElementById('compCc');
  var subject = document.getElementById('compSubject');
  var inReplyTo = document.getElementById('compInReplyTo');
  if (!to || !to.value.trim()) { if (status) { status.textContent = 'Recipient required'; status.style.color = 'var(--red)'; } return; }

  var bodyHtml = '';
  var bodyText = '';
  if (emailState.quillEditor) {
    bodyHtml = emailState.quillEditor.root.innerHTML;
    bodyText = emailState.quillEditor.getText();
  }

  var accountId = emailState.accountType === 'imap' ? emailState.accountId : null;
  if (!accountId) {
    // Google send via existing tool
    if (status) { status.textContent = 'Sending via Google...'; status.style.color = 'var(--dim)'; }
    apiPost('/api/email/send', { to: to.value.trim(), subject: subject.value.trim(), body: bodyText }).then(function(r) {
      if (r.ok || r.id) { if (status) { status.textContent = 'Sent!'; status.style.color = 'var(--green)'; } setTimeout(emailCloseCompose, 800); }
      else { if (status) { status.textContent = r.error || 'Error'; status.style.color = 'var(--red)'; } }
    }).catch(function(e) { if (status) { status.textContent = e.message; status.style.color = 'var(--red)'; } });
    return;
  }

  if (status) { status.textContent = 'Sending...'; status.style.color = 'var(--dim)'; }
  apiPost('/api/imap/send', {
    accountId: accountId,
    to: to.value.trim(),
    cc: cc && cc.value.trim() ? cc.value.trim() : undefined,
    subject: subject.value.trim(),
    bodyHtml: bodyHtml,
    bodyText: bodyText,
    inReplyTo: inReplyTo && inReplyTo.value ? inReplyTo.value : undefined,
  }).then(function(r) {
    if (r.ok) {
      if (status) { status.textContent = 'Sent!'; status.style.color = 'var(--green)'; }
      setTimeout(function() {
        emailCloseCompose();
        // Reload current label to show the sent message if we are on Sent
        emailLoadMessages();
      }, 800);
    } else {
      if (status) { status.textContent = r.error || 'Error'; status.style.color = 'var(--red)'; }
    }
  }).catch(function(e) {
    if (status) { status.textContent = e.message; status.style.color = 'var(--red)'; }
  });
}

function emailSaveDraft() {
  var accountId = emailState.accountType === 'imap' ? emailState.accountId : null;
  if (!accountId) return;
  var to = document.getElementById('compTo');
  var subject = document.getElementById('compSubject');
  var bodyHtml = emailState.quillEditor ? emailState.quillEditor.root.innerHTML : '';
  apiPost('/api/imap/drafts/save', {
    accountId: accountId,
    to: to ? [{ address: to.value.trim() }] : [],
    subject: subject ? subject.value.trim() : '',
    body_html: bodyHtml,
  }).then(function() {
    var s = document.getElementById('composeStatus');
    if (s) { s.textContent = 'Draft saved'; s.style.color = 'var(--green)'; }
  });
}

function emailCloseCompose() {
  emailState.quillEditor = null;
  var pane = document.getElementById('emailPane');
  if (pane) pane.innerHTML = '<div style="padding:40px;text-align:center;color:var(--dim);font-size:12px">Select a message</div>';
}

function emailTrash(id) {
  if (!confirm('Move to trash? Email stays on the server — only removed from local view.')) return;
  apiPost('/api/imap/trash', { messageId: id }).then(function() {
    emailState.messages = emailState.messages.filter(function(m) { return m.id !== id; });
    emailRenderMessageList();
    var pane = document.getElementById('emailPane');
    if (pane) pane.innerHTML = '<div style="padding:40px;text-align:center;color:var(--dim);font-size:12px">Message moved to trash</div>';
    showToast('success', 'Trash', 'Moved to trash (server untouched)');
  });
}

function emailToggleStar(id, isStarred) {
  apiPost('/api/imap/mark-starred', { messageId: id, isStarred: isStarred }).then(function() {
    showToast('success', isStarred ? 'Starred' : 'Unstarred', '');
    emailOpenMessage(id);
  });
}

function emailAssignLabel(messageId, labelId) {
  if (!labelId) return;
  apiPost('/api/imap/labels/assign', { messageId: messageId, labelId: labelId }).then(function() {
    showToast('success', 'Label', 'Label assigned');
  });
}

function emailAskAgent(id) {
  switchView('chat');
  setTimeout(function() {
    var inp = document.getElementById('chatInput');
    if (inp) { inp.value = 'Analyze email ' + id + ' — extract key information, action items, and summarize.'; inp.focus(); }
  }, 200);
}

function emailSyncCurrent() {
  if (!emailState.accountId || emailState.accountType !== 'imap') return;
  apiPost('/api/imap/sync', { accountId: emailState.accountId }).then(function() {
    showToast('success', 'Sync', 'Sync started — messages will appear shortly');
    setTimeout(function() { emailLoadMessages(); updateEmailBadge(); }, 5000);
    setTimeout(function() { emailLoadMessages(); updateEmailBadge(); }, 15000);
  });
}

function emailShowNewLabel() {
  var name = prompt('New label name:');
  if (!name) return;
  var color = prompt('Color (hex, e.g. #3B82F6) or leave empty:', '');
  apiPost('/api/imap/labels/create', { accountId: emailState.accountId, name: name, color: color || null }).then(function(r) {
    if (r.ok) {
      apiGet('/api/imap/labels?accountId=' + emailState.accountId).then(function(r2) {
        emailState.labels = r2.labels || [];
        emailRenderSidebar();
      });
    }
  });
}

function emailEditLabel(id, name, color) {
  var newName = prompt('Label name:', name);
  if (newName === null) return;
  var newColor = prompt('Color (hex):', color);
  apiPost('/api/imap/labels/update', { id: id, name: newName, color: newColor || null }).then(function() {
    apiGet('/api/imap/labels?accountId=' + emailState.accountId).then(function(r) {
      emailState.labels = r.labels || [];
      emailRenderSidebar();
    });
  });
}

// Legacy compat for Google (existing code paths)
var openEmailId = null;
function openEmail(id) { emailOpenMessage(id); }
function replyToEmail(id) { emailOpenCompose({ replyTo: id }); }
function askAgentAboutEmail(id) { emailAskAgent(id); }
function markAllEmailsRead() {
  if (emailState.accountType === 'imap' && emailState.accountId) {
    apiPost('/api/imap/mark-all-read', { accountId: emailState.accountId, labelId: emailState.labelId || null }).then(function(r) {
      emailState.messages.forEach(function(m) { m.is_read = true; });
      emailRenderMessageList();
      showToast('success', 'All Read', 'Marked ' + (r.count || 0) + ' emails as read');
    });
  } else {
    apiPost('/api/email/mark-all-read', {}).then(function(r) {
      if (r && r.ok) { dash.emails.forEach(function(e) { e.isUnread = false; }); updateBadges(); showToast('success', 'All Read', 'Marked ' + (r.count || 0) + ' emails as read'); }
    });
  }
}

// ---- CALENDAR (monthly grid + day detail modal) ----
var calYear, calMonth;
var calEventsCache = {};
(function(){var d=new Date();calYear=d.getFullYear();calMonth=d.getMonth()})();

function calKey(y,m,d){return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0')}
function isToday(y,m,d){var t=new Date();return t.getFullYear()===y&&t.getMonth()===m&&t.getDate()===d}

function renderCalendar(el){
  // Guard: if Google not connected, show setup message — don't block on API call
  if(!settingsData.hasGoogle){
    el.innerHTML='<div style="max-width:400px;margin:60px auto;text-align:center;padding:32px;border:1px solid var(--border);border-radius:12px;background:var(--bg2)">' +
      '<div style="font-size:40px;margin-bottom:16px">&#128197;</div>' +
      '<div style="color:var(--bright);font-size:18px;font-weight:700;margin-bottom:8px">Calendar</div>' +
      '<div style="color:var(--dim);font-size:13px;margin-bottom:24px">Connect your Google account to view and manage calendar events.</div>' +
      '<button onclick="switchView(\\x27settings\\x27)" style="background:var(--green3);color:var(--bg);padding:10px 24px;border-radius:var(--r);font-weight:700;font-size:13px;cursor:pointer;border:none">Connect Google \u2192</button>' +
    '</div>';
    return;
  }
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

  el.innerHTML = '<div style="max-width:620px;margin:0 auto">' +
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
    settingsSection('responder', 'Telegram & Discord Bot', 'Auto-reply to Telegram and Discord messages.', [
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
    (settingsData.hasGoogle ? '<div style="color:var(--green);font-size:12px;margin-bottom:8px">&#9989; Connected</div>' : '') +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button onclick="connectGoogle()" style="background:var(--green3);color:var(--bg);padding:8px 20px;border-radius:var(--r);font-weight:700;font-size:12px;cursor:pointer;border:none">' + (settingsData.hasGoogle ? 'Reconnect Google' : 'Connect Google') + '</button>' +
    (settingsData.hasGoogle ? '<button onclick="disconnectGoogle()" style="background:var(--red3,#7f1d1d);color:#fca5a5;padding:8px 16px;border-radius:var(--r);font-weight:700;font-size:12px;cursor:pointer;border:1px solid var(--red,#ef4444)">Disconnect Google</button>' : '') +
    '</div>' +
    '<div id="googleStatus" style="margin-top:8px;font-size:10px;color:var(--dim)"></div>' +
    '</div>' +
    renderImapAccountsSettings() +
  '</div>';
  setTimeout(loadImapAccounts, 100);
}

function renderImapAccountsSettings() {
  return '<div class="card" id="imapAccountsCard" style="margin-top:16px">' +
    '<div class="card__title" style="display:flex;align-items:center;justify-content:space-between">' +
    '<span>Email Accounts (IMAP/SMTP)</span>' +
    '<button onclick="showAddImapAccount()" style="background:var(--green3);color:var(--bg);padding:5px 14px;border-radius:var(--r);font-weight:700;font-size:11px;cursor:pointer;border:none">+ Add Account</button>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--dim);margin-bottom:10px">IMAP is read-only — no emails are ever deleted or moved on the server.</div>' +
    '<div id="imapAccountsList">Loading...</div>' +
    '<div id="imapAccountForm" style="display:none;margin-top:14px;padding:14px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">' +
    '<div style="font-size:12px;font-weight:700;color:var(--green);margin-bottom:10px" id="imapFormTitle">Add IMAP Account</div>' +
    '<input type="hidden" id="imapEditId" value="">' +
    imapField('imapDisplayName','Display Name','e.g. Work Email') +
    imapField('imapEmail','Email Address','user@example.com') +
    imapField('imapFromName','From Name','e.g. John Smith') +
    imapField('imapImapHost','IMAP Server','e.g. imap.gmail.com') +
    imapField('imapImapPort','IMAP Port','993 (TLS) or 143') +
    imapField('imapSmtpHost','SMTP Server','e.g. smtp.gmail.com') +
    imapField('imapSmtpPort','SMTP Port','587 (STARTTLS) or 465 (SSL)') +
    imapField('imapUsername','Username','e.g. user@example.com') +
    imapFieldPassword() +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button onclick="saveImapAccount()" style="background:var(--green3);color:var(--bg);padding:7px 18px;border-radius:var(--r);font-weight:700;font-size:12px;cursor:pointer;border:none">Save</button>' +
    '<button onclick="document.getElementById(\\x27imapAccountForm\\x27).style.display=\\x27none\\x27" style="background:var(--bg);color:var(--dim);padding:7px 14px;border-radius:var(--r);font-size:12px;cursor:pointer;border:1px solid var(--border)">Cancel</button>' +
    '</div>' +
    '<div id="imapFormStatus" style="margin-top:8px;font-size:11px;color:var(--dim)"></div>' +
    '</div>' +
    '</div>';
}

function imapField(id, label, placeholder) {
  return '<div style="margin-bottom:8px">' +
    '<label style="display:block;font-size:10px;color:var(--dim);margin-bottom:3px">' + label + '</label>' +
    '<input id="' + id + '" type="text" placeholder="' + placeholder + '" style="width:100%;padding:7px 10px;font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:6px;box-sizing:border-box">' +
    '</div>';
}

function imapFieldPassword() {
  return '<div style="margin-bottom:8px">' +
    '<label style="display:block;font-size:10px;color:var(--dim);margin-bottom:3px">Password <span id="imapPwdPlaceholderNote" style="color:var(--amber,#F59E0B)">(leave empty to keep existing)</span></label>' +
    '<div style="display:flex;gap:6px;align-items:center">' +
    '<input id="imapPassword" type="password" placeholder="App password or IMAP password" style="flex:1;padding:7px 10px;font-size:12px;background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:6px">' +
    '<button type="button" onclick="imapTogglePwd()" style="padding:6px 10px;font-size:11px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:6px;cursor:pointer;white-space:nowrap" id="imapPwdToggle">Show</button>' +
    '</div>' +
    '</div>';
}

function imapTogglePwd() {
  var inp = document.getElementById('imapPassword');
  var btn = document.getElementById('imapPwdToggle');
  if (!inp) return;
  if (inp.type === 'password') { inp.type = 'text'; if (btn) btn.textContent = 'Hide'; }
  else { inp.type = 'password'; if (btn) btn.textContent = 'Show'; }
}

function loadImapAccounts() {
  apiGet('/api/imap/accounts').then(function(r) {
    var el = document.getElementById('imapAccountsList');
    if (!el) return;
    var accounts = r.accounts || [];
    if (!accounts.length) { el.innerHTML = '<div style="color:var(--dim);font-size:11px">No IMAP accounts configured yet.</div>'; return; }
    var h = '';
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      h += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;margin-bottom:6px;background:var(--bg3);border-radius:6px;border:1px solid var(--border)">' +
        '<div>' +
        '<div style="font-size:12px;font-weight:700;color:var(--bright)">' + esc(a.display_name) + '</div>' +
        '<div style="font-size:10px;color:var(--dim)">' + esc(a.email_address) + ' &middot; ' + esc(a.imap_host || '') + '</div>' +
        '<div style="font-size:10px;color:' + (a.sync_status === 'idle' ? 'var(--green)' : a.sync_status === 'syncing' ? 'var(--cyan)' : 'var(--red)') + '">' + esc(a.sync_status) + (a.last_sync_at ? ' &middot; last: ' + esc(a.last_sync_at.slice(0,16)) : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
        '<button onclick="imapSync(\\x27' + a.id + '\\x27)" style="padding:4px 10px;font-size:10px;background:var(--cyan3,#0e4f5e);color:var(--cyan);border:1px solid var(--cyan);border-radius:4px;cursor:pointer">Sync</button>' +
        '<button onclick="editImapAccount(\\x27' + a.id + '\\x27)" style="padding:4px 10px;font-size:10px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:4px;cursor:pointer">Edit</button>' +
        '<button onclick="deleteImapAccount(\\x27' + a.id + '\\x27)" style="padding:4px 10px;font-size:10px;background:var(--red3,#7f1d1d);color:#fca5a5;border:1px solid var(--red,#ef4444);border-radius:4px;cursor:pointer">Delete</button>' +
        '</div></div>';
    }
    el.innerHTML = h;
  }).catch(function() {
    var el = document.getElementById('imapAccountsList');
    if (el) el.innerHTML = '<div style="color:var(--dim);font-size:11px">Could not load accounts.</div>';
  });
}

function showAddImapAccount() {
  var form = document.getElementById('imapAccountForm');
  if (!form) return;
  var editId = document.getElementById('imapEditId');
  if (editId) editId.value = '';
  var title = document.getElementById('imapFormTitle');
  if (title) title.textContent = 'Add IMAP Account';
  var fieldDefaults = {
    imapDisplayName: '', imapEmail: '', imapFromName: '',
    imapImapHost: '', imapImapPort: '993',
    imapSmtpHost: '', imapSmtpPort: '587',
    imapUsername: '', imapPassword: ''
  };
  for (var key in fieldDefaults) {
    var el = document.getElementById(key);
    if (el) el.value = fieldDefaults[key];
  }
  var status = document.getElementById('imapFormStatus');
  if (status) status.textContent = '';
  // New account: hide "leave empty" note, require password
  var note = document.getElementById('imapPwdPlaceholderNote');
  if (note) note.style.display = 'none';
  // Reset show/hide toggle
  var pwdInp = document.getElementById('imapPassword');
  var pwdBtn = document.getElementById('imapPwdToggle');
  if (pwdInp) { pwdInp.type = 'password'; pwdInp.placeholder = 'App password or IMAP password'; }
  if (pwdBtn) pwdBtn.textContent = 'Show';
  form.style.display = 'block';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function editImapAccount(id) {
  apiGet('/api/imap/accounts').then(function(r) {
    var a = (r.accounts || []).find(function(x) { return x.id === id; });
    if (!a) return;
    document.getElementById('imapEditId').value = id;
    document.getElementById('imapFormTitle').textContent = 'Edit Account';
    document.getElementById('imapDisplayName').value = a.display_name || '';
    document.getElementById('imapEmail').value = a.email_address || '';
    document.getElementById('imapFromName').value = a.from_name || '';
    document.getElementById('imapImapHost').value = a.imap_host || '';
    document.getElementById('imapImapPort').value = a.imap_port || 993;
    document.getElementById('imapSmtpHost').value = a.smtp_host || '';
    document.getElementById('imapSmtpPort').value = a.smtp_port || 587;
    document.getElementById('imapUsername').value = a.username || '';
    document.getElementById('imapPassword').value = '';
    // Show "leave empty to keep" note and reset toggle
    var note = document.getElementById('imapPwdPlaceholderNote');
    if (note) note.style.display = 'inline';
    var pwdInp = document.getElementById('imapPassword');
    var pwdBtn = document.getElementById('imapPwdToggle');
    if (pwdInp) { pwdInp.type = 'password'; pwdInp.placeholder = 'Leave empty to keep existing'; }
    if (pwdBtn) pwdBtn.textContent = 'Show';
    var form2 = document.getElementById('imapAccountForm');
    var status2 = document.getElementById('imapFormStatus');
    if (status2) status2.textContent = '';
    if (form2) { form2.style.display = 'block'; form2.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
}

function saveImapAccount() {
  var id = document.getElementById('imapEditId').value;
  var data = {
    display_name:  document.getElementById('imapDisplayName').value.trim(),
    email_address: document.getElementById('imapEmail').value.trim(),
    from_name:     document.getElementById('imapFromName').value.trim(),
    imap_host:     document.getElementById('imapImapHost').value.trim(),
    imap_port:     parseInt(document.getElementById('imapImapPort').value || '993', 10),
    smtp_host:     document.getElementById('imapSmtpHost').value.trim(),
    smtp_port:     parseInt(document.getElementById('imapSmtpPort').value || '587', 10),
    username:      document.getElementById('imapUsername').value.trim(),
  };
  var pwd = document.getElementById('imapPassword').value;
  if (pwd) data.password = pwd;
  var status = document.getElementById('imapFormStatus');
  if (status) { status.textContent = 'Saving...'; status.style.color = 'var(--dim)'; }
  var url2 = id ? '/api/imap/accounts/update' : '/api/imap/accounts';
  if (id) data.id = id;
  apiPost(url2, data).then(function(r) {
    if (r.ok || r.id) {
      if (status) { status.textContent = 'Saved.'; status.style.color = 'var(--green)'; }
      document.getElementById('imapAccountForm').style.display = 'none';
      loadImapAccounts();
    } else {
      if (status) { status.textContent = r.error || 'Error'; status.style.color = 'var(--red)'; }
    }
  }).catch(function(e) {
    if (status) { status.textContent = e.message; status.style.color = 'var(--red)'; }
  });
}

function deleteImapAccount(id) {
  if (!confirm('Delete this email account? All synced emails will be removed locally.')) return;
  apiPost('/api/imap/accounts/delete', { id: id }).then(function() { loadImapAccounts(); });
}

function imapSync(accountId) {
  apiPost('/api/imap/sync', { accountId: accountId }).then(function() {
    showToast('success', 'Sync', 'Sync started in background');
    setTimeout(loadImapAccounts, 3000);
  }).catch(function(e) { showToast('error', 'Sync', e.message); });
}

function connectGoogle() {
  var s = document.getElementById('googleStatus');
  if (s) { s.textContent = 'Opening Google sign-in...'; s.style.color = 'var(--dim)'; }
  apiPost('/api/google/auth', {}).then(function(r) {
    if (r.url) {
      // Open OAuth URL in current browser — works on VMs and LAN
      window.open(r.url, '_blank');
      if (s) { s.textContent = 'Sign-in page opened. Complete the login then reload NHA.'; s.style.color = 'var(--green)'; }
    } else if (r.error) {
      if (s) { s.textContent = 'Error: ' + r.error; s.style.color = 'var(--red)'; }
    }
  }).catch(function(e) {
    if (s) { s.textContent = 'Error: ' + e.message; s.style.color = 'var(--red)'; }
  });
}
function disconnectGoogle() {
  var s = document.getElementById('googleStatus');
  if (s) s.textContent = 'Disconnecting...';
  apiPost('/api/google/revoke', {}).then(function() {
    if (s) { s.textContent = 'Google account disconnected.'; s.style.color = 'var(--dim)'; }
    setTimeout(function(){ location.reload(); }, 1200);
  }).catch(function() {
    // Fallback: delete token file via CLI hint
    if (s) { s.textContent = 'Run: nha google revoke'; s.style.color = 'var(--amber)'; }
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

    case 'npm-update':
      var upLog = document.getElementById('npmUpdateLog');
      if (upLog) {
        upLog.textContent += msg.line || '';
        upLog.scrollTop = upLog.scrollHeight;
      }
      if (msg.done) {
        var upStatus = document.getElementById('npmUpdateStatus');
        if (upStatus) upStatus.textContent = 'npm install complete — server restarting...';
        // Reload is handled by the independent poll in npmUpdate()
      }
      if (msg.error) {
        var upStatus2 = document.getElementById('npmUpdateStatus');
        if (upStatus2) { upStatus2.textContent = 'Update failed. See output above.'; upStatus2.style.color = 'var(--red)'; }
        var upBtn = document.getElementById('npmUpdateCloseBtn');
        if (upBtn) upBtn.style.display = 'inline-block';
      }
      break;
  }
}

function nhaSetWeatherLocation() {
  var current = localStorage.getItem('nha_weather_location') || '';
  var city = prompt('Enter your city for weather (e.g. "Rome", "Viterbo, Italy"):', current);
  if (city === null) return;
  city = city.trim();
  if (!city) { localStorage.removeItem('nha_weather_location'); dash.weather = null; dashLoaded.weather = false; render(); return; }
  localStorage.setItem('nha_weather_location', city);
  dash.weather = null; dashLoaded.weather = false;
  render();
  apiGet('/api/weather?location=' + encodeURIComponent(city)).then(function(r) {
    if (r && r.tempC) { dash.weather = r; dashLoaded.weather = true; render(); }
  }).catch(function() {});
}

function npmUpdate() {
  var existing = document.getElementById('npmUpdateModal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'npmUpdateModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML =
    '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:24px;width:540px;max-width:95vw;display:flex;flex-direction:column;gap:12px">' +
      '<div style="font-size:14px;font-weight:700;color:var(--fg)">&#8593; Updating NotHumanAllowed</div>' +
      '<div id="npmUpdateStatus" style="font-size:11px;color:var(--dim)">Installing latest version...</div>' +
      '<pre id="npmUpdateLog" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:10px;color:var(--green);max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin:0"></pre>' +
      '<div style="display:flex;justify-content:flex-end">' +
        '<button id="npmUpdateCloseBtn" onclick="document.getElementById(String.fromCharCode(110,112,109,85,112,100,97,116,101,77,111,100,97,108)).remove()" style="display:none;padding:6px 16px;background:var(--bg);color:var(--dim);border:1px solid var(--border);border-radius:5px;cursor:pointer;font-size:11px">Close</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);

  // Start update — fire and forget (server will exit after npm install)
  apiPost('/api/update-npm', {}).catch(function(){});

  // Independent reconnect poll — does NOT depend on WebSocket
  // Phase 1: wait for server to go down (up to 3 min)
  // Phase 2: wait for server to come back up, then reload
  var serverWasUp = true;
  var pollStart = Date.now();
  var MAX_WAIT = 180000; // 3 min total
  function pollDown() {
    if (Date.now() - pollStart > MAX_WAIT) {
      var st = document.getElementById('npmUpdateStatus');
      if (st) { st.textContent = 'Timeout — reload the page manually.'; st.style.color = 'var(--red)'; }
      var cb = document.getElementById('npmUpdateCloseBtn');
      if (cb) cb.style.display = 'inline-block';
      return;
    }
    fetch(window.location.origin + '/api/status', { cache: 'no-store' }).then(function() {
      setTimeout(pollDown, 1000); // still up, keep waiting
    }).catch(function() {
      // Server went down — now wait for it to come back
      var st = document.getElementById('npmUpdateStatus');
      if (st) st.textContent = 'Server restarting — reconnecting...';
      setTimeout(pollUp, 1500);
    });
  }
  function pollUp() {
    if (Date.now() - pollStart > MAX_WAIT) {
      var st = document.getElementById('npmUpdateStatus');
      if (st) { st.textContent = 'Server took too long — reload the page manually.'; st.style.color = 'var(--red)'; }
      var cb = document.getElementById('npmUpdateCloseBtn');
      if (cb) cb.style.display = 'inline-block';
      return;
    }
    fetch(window.location.origin + '/api/status', { cache: 'no-store' }).then(function() {
      // First response — wait 2s then confirm server is stable before reloading
      var st = document.getElementById('npmUpdateStatus');
      if (st) st.textContent = 'Server back — loading...';
      setTimeout(function() {
        fetch(window.location.origin + '/api/status', { cache: 'no-store' }).then(function() {
          if (st) st.textContent = 'Update complete! Reloading...';
          setTimeout(function() { window.location.reload(); }, 500);
        }).catch(function() {
          // Went back down, keep polling
          setTimeout(pollUp, 1500);
        });
      }, 2000);
    }).catch(function() {
      setTimeout(pollUp, 1500);
    });
  }
  // Start polling for server going down after a short delay
  setTimeout(pollDown, 5000);
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
    nav_webcraft:'WebCraft',
    wc_title:'WebCraft', wc_subtitle:'Generate enterprise-grade web projects — security headers A+, BEM CSS, PostgreSQL pool, Auth, GDPR cookie banner.',
    wc_project:'Project', wc_project_name:'Project name (e.g. MySaaS)', wc_desc:'Describe your project...',
    wc_blocks:'Included Blocks', wc_auth_fields:'Auth Fields', wc_add_field:'+ Add field',
    wc_required_hint:'Checked = Required | Edit label & type inline',
    wc_generate:'Generate Project', wc_generating:'Generating',
    wc_download:'Download Archive', wc_describe_first:'Please describe your project first.',
    wc_no_files:'Describe your project and click Generate',
    wc_examples_label:'Examples',
    wc_sandbox_start:'Launch Sandbox',
    wc_projects:'Projects',
    wc_no_projects:'No saved projects yet',
    wc_no_projects_hint:'Generate a project and it will be saved automatically',
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
    nav_webcraft:'WebCraft',
    wc_title:'WebCraft', wc_subtitle:'Genera progetti web enterprise — security headers A+, CSS BEM, PostgreSQL pool, Auth, cookie banner GDPR.',
    wc_project:'Progetto', wc_project_name:'Nome progetto (es. MioSaaS)', wc_desc:'Descrivi il tuo progetto...',
    wc_blocks:'Blocchi inclusi', wc_auth_fields:'Campi registrazione', wc_add_field:'+ Aggiungi campo',
    wc_required_hint:'Spuntato = Obbligatorio | Modifica etichetta e tipo inline',
    wc_generate:'Genera progetto', wc_generating:'Generazione in corso',
    wc_download:'Scarica archivio', wc_describe_first:'Descrivi prima il tuo progetto.',
    wc_no_files:'Descrivi il progetto e clicca Genera',
    wc_examples_label:'Esempi',
    wc_sandbox_start:'Avvia Sandbox',
    wc_projects:'Progetti',
    wc_no_projects:'Nessun progetto salvato',
    wc_no_projects_hint:'Genera un progetto e verr\u00e0 salvato automaticamente',
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
    nav_webcraft:'WebCraft',
    wc_title:'WebCraft', wc_subtitle:'Genera proyectos web empresariales — headers A+, CSS BEM, PostgreSQL pool, Auth, banner de cookies GDPR.',
    wc_project:'Proyecto', wc_project_name:'Nombre del proyecto (ej. MiSaaS)', wc_desc:'Describe tu proyecto...',
    wc_blocks:'Bloques incluidos', wc_auth_fields:'Campos de registro', wc_add_field:'+ A\u00f1adir campo',
    wc_required_hint:'Marcado = Obligatorio | Edita etiqueta y tipo inline',
    wc_generate:'Generar proyecto', wc_generating:'Generando',
    wc_download:'Descargar archivo', wc_describe_first:'Por favor describe tu proyecto primero.',
    wc_no_files:'Describe el proyecto y haz clic en Generar',
    wc_examples_label:'Ejemplos',
    wc_sandbox_start:'Iniciar Sandbox',
    wc_projects:'Proyectos',
    wc_no_projects:'No hay proyectos guardados',
    wc_no_projects_hint:'Genera un proyecto y se guardar\u00e1 autom\u00e1ticamente',
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
    nav_webcraft:'WebCraft',
    wc_title:'WebCraft', wc_subtitle:'G\u00e9n\u00e9rez des projets web entreprise — headers A+, CSS BEM, pool PostgreSQL, Auth, bandeau cookies RGPD.',
    wc_project:'Projet', wc_project_name:'Nom du projet (ex. MonSaaS)', wc_desc:'D\u00e9crivez votre projet...',
    wc_blocks:'Blocs inclus', wc_auth_fields:'Champs inscription', wc_add_field:'+ Ajouter un champ',
    wc_required_hint:'Coch\u00e9 = Obligatoire | Modifier \u00e9tiquette et type inline',
    wc_generate:'G\u00e9n\u00e9rer le projet', wc_generating:'G\u00e9n\u00e9ration en cours',
    wc_download:'T\u00e9l\u00e9charger archive', wc_describe_first:'Veuillez d\u00e9crire votre projet.',
    wc_no_files:'D\u00e9crivez le projet et cliquez sur G\u00e9n\u00e9rer',
    wc_examples_label:'Exemples',
    wc_sandbox_start:'Lancer Sandbox',
    wc_projects:'Projets',
    wc_no_projects:'Aucun projet sauvegard\u00e9',
    wc_no_projects_hint:'G\u00e9n\u00e9rez un projet et il sera sauvegard\u00e9 automatiquement',
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
    nav_webcraft:'WebCraft',
    wc_title:'WebCraft', wc_subtitle:'Enterprise-Web-Projekte generieren — Security-Headers A+, BEM CSS, PostgreSQL Pool, Auth, DSGVO Cookie-Banner.',
    wc_project:'Projekt', wc_project_name:'Projektname (z.B. MeinSaaS)', wc_desc:'Beschreibe dein Projekt...',
    wc_blocks:'Enthaltene Bl\u00f6cke', wc_auth_fields:'Registrierungsfelder', wc_add_field:'+ Feld hinzuf\u00fcgen',
    wc_required_hint:'Aktiviert = Pflichtfeld | Beschriftung und Typ inline bearbeiten',
    wc_generate:'Projekt generieren', wc_generating:'Generierung',
    wc_download:'Archiv herunterladen', wc_describe_first:'Bitte beschreibe zuerst dein Projekt.',
    wc_no_files:'Beschreibe das Projekt und klicke auf Generieren',
    wc_examples_label:'Beispiele',
    wc_sandbox_start:'Sandbox starten',
    wc_projects:'Projekte',
    wc_no_projects:'Keine gespeicherten Projekte',
    wc_no_projects_hint:'Generiere ein Projekt und es wird automatisch gespeichert',
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
        \x27<div class="sidebar__brand-name">NHA <span style="font-size:11px;font-weight:500;opacity:.7;letter-spacing:.5px">3rdArm</span></div>\x27+
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
      \x27<div class="nav-item\x27+(activeView===\x27webcraft\x27?\x27 nav-item--active\x27:\x27\x27)+\x27" data-view="webcraft" onclick="switchView(\\\x27webcraft\\\x27)">\x27+
        \x27<span class="nav-item__icon">&#128736;</span> \x27+t(\x27nav_webcraft\x27)+
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
    \x27<div style="padding:12px 16px;margin-top:auto;border-top:1px solid var(--border);font-size:10px;color:var(--dim)">nothumanallowed.com<span style="margin-left:6px;opacity:.5">v${VERSION}</span>\x27+
    (_updateInfo&&_updateInfo.updateAvailable?\x27<span onclick="npmUpdate()" style="margin-left:8px;background:#f59e0b;color:#000;border-radius:4px;padding:1px 6px;font-weight:700;cursor:pointer" title="Click to update to v\x27+(_updateInfo.latest||\x27\x27)+\x27">&#8593; Update v\x27+(_updateInfo.latest||\x27\x27)+\x27</span>\x27:\x27\x27)+
    \x27</div>\x27;
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
var parlActiveAgent = null;   // active agent label during parliament streaming
var parlDoneAgents = {};      // set of completed agent labels during parliament
var _parlPersistHtml = null;  // persists parliament block HTML across tab navigations
var _PARL_STAMP = '<!--nha-parl-v13.5.39-->';

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
    if (last.agent === agent) {
      last.text = text; last.type = type || last.type;
      // Streaming finished: remove data-rlen from the DOM entry so renderStudioLog re-renders it as markdown
      var logEl = document.getElementById('studioLog');
      if (logEl) {
        var entries = logEl.querySelectorAll('.studio-log-entry');
        var lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          var tb2 = lastEntry.querySelector('.studio-log-entry__text');
          if (tb2) tb2.removeAttribute(String.fromCharCode(100,97,116,97,45,114,108,101,110));
        }
      }
      renderStudioLog(); return;
    }
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
  // Idle agents still have lit screens (dim amber glow — standby mode)
  var accentColor = isActive ? \x27#6366f1\x27 : (isDone ? \x27#22c55e\x27 : \x27#3b3b6e\x27);
  var idleScreenColor = \x27#1e1b38\x27; // dim purple-blue for idle screens — lit but standby
  var deskBg = isDone ? \x27#1a3a1a\x27 : (isActive ? \x27#1a1a3e\x27 : \x27#181830\x27);
  var monGlow = isActive ? \x27filter:drop-shadow(0 0 4px #6366f1)\x27 : (isDone ? \x27filter:drop-shadow(0 0 3px #22c55e44)\x27 : \x27filter:drop-shadow(0 0 3px #3b3b6e66)\x27);
  var armCls = isActive ? \x27class="prl-arm"\x27 : \x27\x27;
  var headCls = isActive ? \x27class="prl-head"\x27 : \x27\x27;
  var glowStyle = isActive ? \x27filter:drop-shadow(0 0 5px #6366f1)\x27 : (isDone ? \x27filter:drop-shadow(0 0 4px #22c55e44)\x27 : \x27\x27);
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
    // Screen glass — idle=dim standby blue, done=dim green, active=lit
    \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="\x27+(isDone?\x27#0a1a0a\x27:(isActive?\x27#0a0a18\x27:\x27#0e0e22\x27))+\x27"/>\x27+
    (isActive ?
      \x27<defs><linearGradient id="wsg\x27+skinIdx+\x27" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366f122"/><stop offset="1" stop-color="#6366f108"/></linearGradient></defs>\x27+
      \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="url(#wsg\x27+skinIdx+\x27)"/>\x27+
      \x27<line x1="22" y1="32" x2="48" y2="32" stroke="#6366f1ee" stroke-width="1.2" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="35" x2="44" y2="35" stroke="#6366f1aa" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="38" x2="46" y2="38" stroke="#6366f188" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="41" x2="40" y2="41" stroke="#6366f166" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="44" x2="43" y2="44" stroke="#6366f144" stroke-width="1" stroke-linecap="round"/>\x27
      : isDone ?
      // Done: green screen with completed code
      \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="#0a1a0a88"/>\x27+
      \x27<line x1="22" y1="32" x2="44" y2="32" stroke="#22c55e99" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="35" x2="46" y2="35" stroke="#22c55e77" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="38" x2="40" y2="38" stroke="#22c55e55" stroke-width="1" stroke-linecap="round"/>\x27+
      \x27<line x1="22" y1="41" x2="43" y2="41" stroke="#22c55e44" stroke-width="1" stroke-linecap="round"/>\x27
      :
      // Idle: dim standby screen — agent is waiting, screen lit but quiet
      \x27<rect x="20" y="29" width="30" height="18" rx="2" fill="rgba(90,80,180,.35)"/>\x27+
      \x27<line x1="22" y1="33" x2="46" y2="33" stroke="#9090cc" stroke-width="1" stroke-linecap="round" opacity=".8"/>\x27+
      \x27<line x1="22" y1="36" x2="38" y2="36" stroke="#8080bb" stroke-width="1" stroke-linecap="round" opacity=".65"/>\x27+
      \x27<line x1="22" y1="39" x2="44" y2="39" stroke="#7070aa" stroke-width="1" stroke-linecap="round" opacity=".5"/>\x27+
      \x27<line x1="22" y1="42" x2="34" y2="42" stroke="#6060a0" stroke-width="1" stroke-linecap="round" opacity=".4"/>\x27+
      // Standby dot — blinking cursor
      \x27<circle cx="22" cy="45" r="1" fill="#6366f1" opacity=".6" class="prl-doc-hold"/>\x27
    )+
    \x27<circle cx="35" cy="28.2" r=".9" fill="\x27+(isActive?\x27#6366f1\x27:(isDone?\x27#22c55e\x27:\x27#4040a0\x27))+\x27"/>\x27+
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
    // Floating document icon when running (bobbing above desk)
    (isActive ?
      \x27<g class="prl-doc-hold" style="transform-origin:58px 10px">\x27+
      \x27<path d="M52 4 L66 4 L69 7 L69 22 L52 22 Z" fill="#0d0d20" stroke="#6366f1" stroke-width="1.5"/>\x27+
      \x27<path d="M66 4 L66 7 L69 7" fill="none" stroke="#6366f1" stroke-width="1"/>\x27+
      \x27<line x1="55" y1="10" x2="66" y2="10" stroke="#6366f1ee" stroke-width=".9" stroke-linecap="round"/>\x27+
      \x27<line x1="55" y1="13" x2="64" y2="13" stroke="#6366f1aa" stroke-width=".9" stroke-linecap="round"/>\x27+
      \x27<line x1="55" y1="16" x2="65" y2="16" stroke="#6366f188" stroke-width=".9" stroke-linecap="round"/>\x27+
      \x27</g>\x27
      : \x27\x27)+
    \x27</svg>\x27;
  return svg;
}

// ── Office room decorations — window, wall art, plants, lamp ──────────────────
// Used in both workflow and parliament office blocks.
function officeRoomDecor() {
  // SVG plant: pot + soil + stem + leaves (monstera-ish)
  var plantSvg = \x27<svg viewBox="0 0 20 36" width="20" height="36" xmlns="http://www.w3.org/2000/svg">\x27+
    // Pot
    \x27<path d="M4 27 L6 34 L14 34 L16 27 Z" fill="#2a1a0a" stroke="#3d2810" stroke-width=".8"/>\x27+
    // Pot rim
    \x27<rect x="3" y="25" width="14" height="3" rx="1.5" fill="#3d2810" stroke="#4d3215" stroke-width=".5"/>\x27+
    // Soil
    \x27<ellipse cx="10" cy="26.5" rx="6" ry="1.5" fill="#1a0f05"/>\x27+
    // Main stem
    \x27<path d="M10 25 C10 20 9 14 10 8" stroke="#1a4a10" stroke-width="1.2" fill="none" stroke-linecap="round"/>\x27+
    // Left leaf
    \x27<path d="M10 18 C6 14 3 15 4 19 C5 22 9 21 10 18" fill="#166534" opacity=".9"/>\x27+
    \x27<path d="M10 18 C7.5 16.5 6 17.5 7 19" stroke="#14532d" stroke-width=".5" fill="none"/>\x27+
    // Right leaf
    \x27<path d="M10 13 C14 9 17 10 16 14 C15 17 11 16 10 13" fill="#15803d" opacity=".9"/>\x27+
    \x27<path d="M10 13 C12.5 11.5 14 12.5 13 14" stroke="#14532d" stroke-width=".5" fill="none"/>\x27+
    // Top leaf
    \x27<path d="M10 8 C8 4 5 5 6 8 C7 11 10 10 10 8" fill="#166534" opacity=".85"/>\x27+
    \x27</svg>\x27;
  // Second plant (taller, cactus-ish)
  var plant2Svg = \x27<svg viewBox="0 0 20 36" width="20" height="36" xmlns="http://www.w3.org/2000/svg">\x27+
    // Pot
    \x27<path d="M4 27 L6 34 L14 34 L16 27 Z" fill="#2a1a0a" stroke="#3d2810" stroke-width=".8"/>\x27+
    \x27<rect x="3" y="25" width="14" height="3" rx="1.5" fill="#3d2810" stroke="#4d3215" stroke-width=".5"/>\x27+
    \x27<ellipse cx="10" cy="26.5" rx="6" ry="1.5" fill="#1a0f05"/>\x27+
    // Main trunk (cactus)
    \x27<path d="M9 25 L9 10 Q9 8 10 8 Q11 8 11 10 L11 25 Z" fill="#1a5c18" stroke="#145214" stroke-width=".5"/>\x27+
    // Left arm
    \x27<path d="M9 16 C5 16 4 14 4 12 Q4 10 6 10 L9 10" fill="#166534" stroke="#145214" stroke-width=".5"/>\x27+
    // Right arm
    \x27<path d="M11 19 C15 19 16 17 16 15 Q16 13 14 13 L11 13" fill="#15803d" stroke="#145214" stroke-width=".5"/>\x27+
    // Spines
    \x27<line x1="10" y1="20" x2="12" y2="19" stroke="#4ade80" stroke-width=".6" opacity=".4"/>\x27+
    \x27<line x1="10" y1="14" x2="8" y2="13" stroke="#4ade80" stroke-width=".6" opacity=".4"/>\x27+
    \x27</svg>\x27;
  return \x27<div class="prl-office-window"></div>\x27+
    \x27<div class="prl-office-window-light"></div>\x27+
    \x27<div class="prl-office-frame"></div>\x27+
    \x27<div class="prl-office-frame2"></div>\x27+
    \x27<div class="prl-office-poster"></div>\x27+
    \x27<div class="prl-office-lamp"></div>\x27+
    \x27<div class="prl-office-lamp2"></div>\x27+
    \x27<div class="prl-office-plant">\x27+plantSvg+\x27</div>\x27+
    \x27<div class="prl-office-plant2">\x27+plant2Svg+\x27</div>\x27;
}

// ── Isometric JRPG-style scene renderer ────────────────────────────────────
// Projects grid positions onto an isometric plane.
// iso(col, row) → {x, y} pixel coordinates in the scene container.
// Characters are positioned with position:absolute, scale by row for depth.
var ISO_TILE_W = 80;
var ISO_TILE_H = 40;
var ISO_ORIGIN_X = 500;
var ISO_ORIGIN_Y = 80;
function isoProject(col, row) {
  return {
    x: ISO_ORIGIN_X + (col - row) * (ISO_TILE_W / 2),
    y: ISO_ORIGIN_Y + (col + row) * (ISO_TILE_H / 2)
  };
}

// Full bright office scene — wide SVG background (1000x560)
function isoFloorSvg(cols, rows) {
  var W = 1000; var H = 560;
  var out = \x27<svg viewBox="0 0 \x27+W+\x27 \x27+H+\x27" width="\x27+W+\x27" height="\x27+H+\x27" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;pointer-events:none;z-index:0">\x27;

  // ── DEFS ────────────────────────────────────────────────────────────
  out += \x27<defs>\x27;
  out += \x27<filter id="bGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>\x27;
  out += \x27<radialGradient id="lampGlow" cx="50%" cy="20%" r="70%"><stop offset="0%" stop-color="rgba(255,248,200,.28)"/><stop offset="100%" stop-color="rgba(255,248,200,0)"/></radialGradient>\x27;
  out += \x27<linearGradient id="wallL" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#f8f6f0"/><stop offset="100%" stop-color="#ede9e0"/></linearGradient>\x27;
  out += \x27<linearGradient id="wallR" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#e8e4dc"/><stop offset="100%" stop-color="#ddd8ce"/></linearGradient>\x27;
  out += \x27</defs>\x27;

  // ── WALLS ────────────────────────────────────────────────────────────
  // Left wall (back-left)
  out += \x27<polygon points="0,200 500,40 500,280 0,440" fill="url(#wallL)"/>\x27;
  // Right wall (back-right)
  out += \x27<polygon points="500,40 1000,200 1000,440 500,280" fill="url(#wallR)"/>\x27;
  // Wall top ridge
  out += \x27<line x1="0" y1="200" x2="500" y2="40" stroke="#c8c0b0" stroke-width="2"/>\x27;
  out += \x27<line x1="500" y1="40" x2="1000" y2="200" stroke="#bbb0a0" stroke-width="2"/>\x27;
  out += \x27<line x1="500" y1="40" x2="500" y2="280" stroke="#c0b8a8" stroke-width="1.5"/>\x27;

  // ── WINDOWS on left wall — 3 evenly spaced ──────────────────────────
  // Helper: window at left-wall position (xL,yTop)→(xR,yTop-slope)
  // Left wall goes from (0,200)→(500,40), slope = -160/500 per x
  // Window 1
  out += \x27<polygon points="60,232 160,206 160,272 60,300" fill="#ceeaff" stroke="#90bcd8" stroke-width="1.5"/>\x27;
  out += \x27<polygon points="60,232 160,206 160,213 60,239" fill="#a8d8f8" opacity=".6"/>\x27;
  out += \x27<line x1="60" y1="266" x2="160" y2="239" stroke="#90bcd8" stroke-width="1"/>\x27;
  out += \x27<line x1="110" y1="219" x2="110" y2="286" stroke="#90bcd8" stroke-width="1"/>\x27;
  out += \x27<polygon points="60,232 160,206 160,272 60,300" fill="rgba(180,220,255,.1)"/>\x27;
  // Window 2
  out += \x27<polygon points="200,178 300,152 300,218 200,246" fill="#ceeaff" stroke="#90bcd8" stroke-width="1.5"/>\x27;
  out += \x27<polygon points="200,178 300,152 300,159 200,185" fill="#a8d8f8" opacity=".6"/>\x27;
  out += \x27<line x1="200" y1="212" x2="300" y2="185" stroke="#90bcd8" stroke-width="1"/>\x27;
  out += \x27<line x1="250" y1="165" x2="250" y2="232" stroke="#90bcd8" stroke-width="1"/>\x27;
  out += \x27<polygon points="200,178 300,152 300,218 200,246" fill="rgba(180,220,255,.1)"/>\x27;
  // Window 3
  out += \x27<polygon points="340,126 440,100 440,166 340,192" fill="#ceeaff" stroke="#90bcd8" stroke-width="1.5"/>\x27;
  out += \x27<polygon points="340,126 440,100 440,107 340,133" fill="#a8d8f8" opacity=".6"/>\x27;
  out += \x27<line x1="340" y1="159" x2="440" y2="133" stroke="#90bcd8" stroke-width="1"/>\x27;
  out += \x27<line x1="390" y1="113" x2="390" y2="179" stroke="#90bcd8" stroke-width="1"/>\x27;
  out += \x27<polygon points="340,126 440,100 440,166 340,192" fill="rgba(180,220,255,.1)"/>\x27;
  // Sun shafts
  out += \x27<polygon points="80,300 160,272 190,540 110,560" fill="rgba(255,248,200,.07)"/>\x27;
  out += \x27<polygon points="215,246 300,218 320,540 235,560" fill="rgba(255,248,200,.06)"/>\x27;
  out += \x27<polygon points="352,192 440,166 455,540 367,560" fill="rgba(255,248,200,.05)"/>\x27;

  // ── PAINTING on left wall (between W2 and W3) ────────────────────────
  out += \x27<polygon points="463,112 490,104 490,132 463,140" fill="#e8e2d8" stroke="#c0b090" stroke-width="1.5"/>\x27;
  out += \x27<polygon points="466,114 488,107 488,130 466,137" fill="#5080b0"/>\x27;
  out += \x27<polygon points="469,116 488,110 488,120 469,123" fill="#7aa0c8"/>\x27;
  out += \x27<ellipse cx="478" cy="120" rx="5" ry="4" fill="#fff" opacity=".35"/>\x27;

  // ── PLANT right wall corner ─────────────────────────────────────────
  out += \x27<ellipse cx="920" cy="360" rx="14" ry="7" fill="#2d5018" opacity=".6"/>\x27;
  out += \x27<rect x="912" y="348" width="14" height="14" rx="3" fill="#7a4a20"/>\x27;
  out += \x27<path d="M919 348 C912 328 900 312 905 300 C910 290 919 300 919 348" fill="#3a8020"/>\x27;
  out += \x27<path d="M919 348 C926 328 938 315 933 302 C928 292 919 303 919 348" fill="#4a9228"/>\x27;
  out += \x27<path d="M919 342 C908 332 900 322 902 312" stroke="#3a8020" stroke-width="2.5" fill="none" stroke-linecap="round"/>\x27;
  out += \x27<path d="M919 336 C930 326 938 318 936 306" stroke="#4a9228" stroke-width="2.5" fill="none" stroke-linecap="round"/>\x27;

  // ── CHANDELIER ────────────────────────────────────────────────────────
  out += \x27<line x1="500" y1="0" x2="500" y2="30" stroke="#aaa" stroke-width="3"/>\x27;
  out += \x27<ellipse cx="500" cy="30" rx="38" ry="11" fill="#d8c870" stroke="#b8a850" stroke-width="2"/>\x27;
  out += \x27<ellipse cx="500" cy="36" rx="30" ry="8" fill="#ece090"/>\x27;
  out += \x27<line x1="478" y1="36" x2="478" y2="46" stroke="#aaa" stroke-width="1.2"/>\x27;
  out += \x27<line x1="500" y1="36" x2="500" y2="42" stroke="#aaa" stroke-width="1.2"/>\x27;
  out += \x27<line x1="522" y1="36" x2="522" y2="46" stroke="#aaa" stroke-width="1.2"/>\x27;
  out += \x27<circle cx="478" cy="50" r="8" fill="#fffbe0" filter="url(#bGlow)"/>\x27;
  out += \x27<circle cx="500" cy="46" r="10" fill="#fffbe0" filter="url(#bGlow)"/>\x27;
  out += \x27<circle cx="522" cy="50" r="8" fill="#fffbe0" filter="url(#bGlow)"/>\x27;
  // Light glow on scene
  out += \x27<ellipse cx="500" cy="320" rx="360" ry="220" fill="url(#lampGlow)"/>\x27;

  // ── PARQUET FLOOR ──────────────────────────────────────────────────────
  var plankCols = [\x27#c8924a\x27,\x27#b8823c\x27,\x27#d4a055\x27,\x27#be9248\x27,\x27#a87838\x27];
  for (var r2 = 0; r2 < rows; r2++) {
    for (var c2 = 0; c2 < cols; c2++) {
      var pp = isoProject(c2, r2);
      var ptx = pp.x; var pty = pp.y + 120;
      var pFill = plankCols[(r2*3+c2) % plankCols.length];
      var ppts = ptx+\x27,\x27+pty+\x27 \x27+(ptx+ISO_TILE_W/2)+\x27,\x27+(pty+ISO_TILE_H/2)+\x27 \x27+ptx+\x27,\x27+(pty+ISO_TILE_H)+\x27 \x27+(ptx-ISO_TILE_W/2)+\x27,\x27+(pty+ISO_TILE_H/2);
      out += \x27<polygon points="\x27+ppts+\x27" fill="\x27+pFill+\x27" stroke="#906820" stroke-width=".8"/>\x27;
      // long grain line along the plank
      out += \x27<line x1="\x27+(ptx-ISO_TILE_W/2+5)+\x27" y1="\x27+(pty+ISO_TILE_H/2)+\x27" x2="\x27+(ptx+ISO_TILE_W/2-5)+\x27" y2="\x27+(pty+ISO_TILE_H/2)+\x27" stroke="rgba(0,0,0,.08)" stroke-width=".6"/>\x27;
    }
  }
  out += \x27<ellipse cx="500" cy="380" rx="120" ry="40" fill="rgba(255,248,200,.1)"/>\x27;

  out += \x27</svg>\x27;
  return out;
}

// Isometric desk — proper 3D look: flat top surface + two visible faces + monitor + keyboard
function isoDeskSvg(x, y, accentColor) {
  var ac = accentColor || \x27#888\x27;
  var isDone = ac === \x27#22c55e\x27;
  var isActive = ac === \x27#6366f1\x27;
  var screenFill = isDone ? \x27#0a2010\x27 : (isActive ? \x27#0d102a\x27 : \x27#111828\x27);
  var screenGlow = isDone ? \x27#22c55e\x27 : (isActive ? \x27#818cf8\x27 : \x27#4466aa\x27);
  // Desk is 90x56 viewBox — wide enough to look like a real desk
  return \x27<svg viewBox="0 0 90 56" width="90" height="56" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:\x27+(x-45)+\x27px;top:\x27+(y+4)+\x27px;z-index:\x27+(Math.round(y))+\x27;pointer-events:none">\x27+
    // ── DESK LEGS (4 corners, visible as small rectangles) ──
    \x27<rect x="14" y="42" width="5" height="10" rx="1" fill="#8a5c20"/>\x27+
    \x27<rect x="56" y="47" width="5" height="8" rx="1" fill="#8a5c20"/>\x27+
    \x27<rect x="70" y="40" width="5" height="8" rx="1" fill="#7a4e18"/>\x27+
    \x27<rect x="28" y="36" width="5" height="8" rx="1" fill="#7a4e18"/>\x27+
    // ── DESK TOP SURFACE (iso diamond) ──
    \x27<polygon points="45,4 78,21 45,38 12,21" fill="#d4a448" stroke="#b88830" stroke-width="1.2"/>\x27+
    // wood grain on top
    \x27<line x1="28" y1="21" x2="62" y2="12" stroke="rgba(0,0,0,.09)" stroke-width=".9"/>\x27+
    \x27<line x1="24" y1="26" x2="58" y2="17" stroke="rgba(0,0,0,.07)" stroke-width=".9"/>\x27+
    \x27<line x1="32" y1="17" x2="66" y2="8" stroke="rgba(0,0,0,.06)" stroke-width=".7"/>\x27+
    // shine
    \x27<polygon points="45,4 78,21 74,23 45,8 16,23 12,21" fill="rgba(255,255,255,.12)"/>\x27+
    // ── RIGHT FACE ──
    \x27<polygon points="78,21 78,36 45,53 45,38" fill="#a87028" stroke="#906018" stroke-width=".8"/>\x27+
    // ── LEFT FACE ──
    \x27<polygon points="12,21 45,38 45,53 12,36" fill="#c08838" stroke="#a07028" stroke-width=".8"/>\x27+
    // ── MONITOR — proper isometric screen ──
    // Stand
    \x27<polygon points="54,14 62,18 62,22 54,18" fill="#555" stroke="#333" stroke-width=".6"/>\x27+
    // Screen back
    \x27<polygon points="54,4 72,12 72,24 54,16" fill="#2a2a3a" stroke="#222" stroke-width=".8"/>\x27+
    // Screen front (bezel)
    \x27<polygon points="55,5 71,13 71,23 55,15" fill="#1a1a28"/>\x27+
    // Screen content
    \x27<polygon points="57,7 69,13 69,21 57,15" fill="\x27+screenFill+\x27"/>\x27+
    \x27<line x1="58" y1="10" x2="68" y2="14" stroke="\x27+screenGlow+\x27" stroke-width="1" opacity=".9"/>\x27+
    \x27<line x1="58" y1="13" x2="67" y2="17" stroke="\x27+screenGlow+\x27" stroke-width=".9" opacity=".6"/>\x27+
    \x27<line x1="58" y1="16" x2="66" y2="19" stroke="\x27+screenGlow+\x27" stroke-width=".8" opacity=".4"/>\x27+
    // ── KEYBOARD ──
    \x27<polygon points="24,25 44,32 40,36 20,29" fill="#ddd" stroke="#bbb" stroke-width=".6"/>\x27+
    \x27<line x1="24" y1="28" x2="44" y2="34" stroke="#aaa" stroke-width=".5"/>\x27+
    \x27<line x1="28" y1="26" x2="28" y2="30" stroke="#aaa" stroke-width=".4"/>\x27+
    \x27<line x1="33" y1="28" x2="33" y2="32" stroke="#aaa" stroke-width=".4"/>\x27+
    \x27<line x1="38" y1="30" x2="38" y2="34" stroke="#aaa" stroke-width=".4"/>\x27+
    // ── PAPERS on desk ──
    \x27<polygon points="14,24 28,29 25,34 11,29" fill="#f8f6ee" stroke="#ddd" stroke-width=".6" transform="rotate(-6 20 29)"/>\x27+
    \x27<polygon points="15,23 29,28 26,33 12,28" fill="#fff" stroke="#eee" stroke-width=".5" transform="rotate(-3 21 28)"/>\x27+
    \x27</svg>\x27;
}
// Isometric JRPG sprite character — top-down 3/4 perspective, Pokemon-style
// Agent emojis — rotate through professional/diverse set
var AGENT_EMOJIS = [
  String.fromCodePoint(0x1F9D1,0x200D,0x1F4BB), // person at laptop
  String.fromCodePoint(0x1F469,0x200D,0x1F4BC), // woman office worker
  String.fromCodePoint(0x1F468,0x200D,0x1F4BC), // man office worker
  String.fromCodePoint(0x1F9D1,0x200D,0x1F52C), // scientist
  String.fromCodePoint(0x1F469,0x200D,0x1F4BB), // woman technologist
  String.fromCodePoint(0x1F468,0x200D,0x1F4BB), // man technologist
  String.fromCodePoint(0x1F9D1,0x200D,0x1F3A8), // artist
  String.fromCodePoint(0x1F9D1,0x200D,0x2696,0xFE0F), // judge
];

function isoCharSvg(opts) {
  var isActive = opts.isActive;
  var isDone = opts.isDone;
  var scale = opts.scale || 1;
  var accentColor = opts.accentColor || \x27#6366f1\x27;
  var idx = opts.emojiIdx || 0;
  var emoji = AGENT_EMOJIS[idx % AGENT_EMOJIS.length];
  var sz = Math.round(52 * scale);
  var glowColor = isActive ? accentColor : (isDone ? \x27#22c55e\x27 : \x27transparent\x27);
  var glowFilter = (isActive || isDone) ? (\x27filter:drop-shadow(0 0 8px \x27+glowColor+\x27aa)\x27) : \x27\x27;
  var badgeHtml = isDone
    ? \x27<div style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;background:#22c55e;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;box-shadow:0 0 6px #22c55e88">&#10003;</div>\x27
    : (isActive
        ? \x27<div style="position:absolute;top:-4px;right:-4px;width:14px;height:14px;background:\x27+accentColor+\x27;border-radius:50%;animation:statusPulse 1s ease-in-out infinite;box-shadow:0 0 8px \x27+accentColor+\x27"></div>\x27
        : \x27\x27);
  var ringStyle = isActive
    ? (\x27outline:2.5px solid \x27+accentColor+\x27;box-shadow:0 0 16px \x27+accentColor+\x27AA\x27)
    : (isDone ? \x27outline:2px solid rgba(0,0,0,.2)\x27 : \x27outline:none\x27);
  var animClass = isActive ? \x27 prl-head\x27 : \x27\x27;
  return \x27<div class="iso-char-wrap\x27+animClass+\x27" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:\x27+sz+\x27px;height:\x27+sz+\x27px;border-radius:50%;background:rgba(255,255,255,.15);\x27+ringStyle+\x27;\x27+glowFilter+\x27;transition:all .3s">\x27+
    \x27<span style="font-size:\x27+Math.round(36*scale)+\x27px;line-height:1;user-select:none">\x27+emoji+\x27</span>\x27+
    badgeHtml+
    \x27</div>\x27;
}
// Orchestrator — emoji-based, crowned
function isoOrchSvg(hasActive, doneRatio) {
  void doneRatio;
  var orchEmoji = String.fromCodePoint(0x1F9D1, 0x200D, 0x1F4BC); // person in suit
  var animClass = hasActive ? \x27 prl-head\x27 : \x27\x27;
  var glowFilter = hasActive ? \x27filter:drop-shadow(0 0 12px #818cf8AA)\x27 : \x27filter:drop-shadow(0 0 6px rgba(0,0,0,.25))\x27;
  var crown = String.fromCodePoint(0x1F451); // crown emoji above
  return \x27<div class="iso-orch-wrap\x27+animClass+\x27" style="display:inline-flex;flex-direction:column;align-items:center;gap:0">\x27+
    \x27<span style="font-size:18px;line-height:1;display:block;text-align:center">\x27+crown+\x27</span>\x27+
    \x27<span style="font-size:52px;line-height:1;user-select:none;display:block;\x27+glowFilter+\x27">\x27+orchEmoji+\x27</span>\x27+
    \x27</div>\x27;
}

// Skin/shirt/hair palette per agent label
function agentPalette(lbl) {
  var skins = [\x27#fbbf24\x27,\x27#f97316\x27,\x27#e8c99a\x27,\x27#c8a97a\x27,\x27#d4a97a\x27,\x27#f5c07a\x27];
  var shirts = [\x27#4f46e5\x27,\x27#0891b2\x27,\x27#7c3aed\x27,\x27#059669\x27,\x27#dc2626\x27,\x27#d97706\x27];
  var hairs = [\x27#1a0e08\x27,\x27#4a3728\x27,\x27#c4a35a\x27,\x27#8b0000\x27,\x27#2c4a7c\x27,\x27#3d2b1f\x27];
  var i = Math.abs((lbl.charCodeAt(0)||65) + (lbl.charCodeAt(lbl.length-1)||90)) % 6;
  return {skin: skins[i], shirt: shirts[i], hair: hairs[i]};
}

var TOOL_EMOJI_MAP = {
  websearch: String.fromCodePoint(0x1F50D),
  search: String.fromCodePoint(0x1F50D),
  browser: String.fromCodePoint(0x1F310),
  email: String.fromCodePoint(0x1F4E7),
  gmail: String.fromCodePoint(0x1F4E7),
  calendar: String.fromCodePoint(0x1F4C5),
  github: String.fromCodePoint(0x1F431),
  notion: String.fromCodePoint(0x1F4D3),
  slack: String.fromCodePoint(0x1F4AC),
  data: String.fromCodePoint(0x1F4CA),
  analyst: String.fromCodePoint(0x1F4CA),
  writer: String.fromCodePoint(0x270F,0xFE0F),
  summary: String.fromCodePoint(0x1F4CB),
  research: String.fromCodePoint(0x1F52C),
  canvas: String.fromCodePoint(0x1F3A8),
  security: String.fromCodePoint(0x1F6E1,0xFE0F),
  devops: String.fromCodePoint(0x2699,0xFE0F),
  code: String.fromCodePoint(0x1F4BB),
  file: String.fromCodePoint(0x1F4C2),
  drive: String.fromCodePoint(0x1F4BE),
  maps: String.fromCodePoint(0x1F5FA,0xFE0F),
  voice: String.fromCodePoint(0x1F3A4),
  pdf: String.fromCodePoint(0x1F4DC),
  document: String.fromCodePoint(0x1F4DC),
  task: String.fromCodePoint(0x2705),
  contacts: String.fromCodePoint(0x1F4F1),
  reminder: String.fromCodePoint(0x23F0),
  news: String.fromCodePoint(0x1F4F0),
  image: String.fromCodePoint(0x1F5BC,0xFE0F),
  video: String.fromCodePoint(0x1F3AC),
  music: String.fromCodePoint(0x1F3B5),
  translate: String.fromCodePoint(0x1F30D),
  math: String.fromCodePoint(0x1F9EE),
  sql: String.fromCodePoint(0x1F5C4,0xFE0F),
  api: String.fromCodePoint(0x1F517),
  test: String.fromCodePoint(0x1F9EA),
  monitor: String.fromCodePoint(0x1F4F6),
  _default: String.fromCodePoint(0x1F527)
};

function getNodeEmoji(n) {
  var lbl = (n.label || n.agent || '').toLowerCase();
  var icon = n.icon || '';
  var keys = Object.keys(TOOL_EMOJI_MAP);
  for (var ki = 0; ki < keys.length; ki++) {
    if (keys[ki] !== '_default' && lbl.indexOf(keys[ki]) >= 0) return TOOL_EMOJI_MAP[keys[ki]];
  }
  if (icon && icon.length > 0 && icon.charCodeAt(0) > 127) return icon;
  return TOOL_EMOJI_MAP._default;
}

function renderStudioNodes() {
  var el = document.getElementById('studioNodes');
  if (!el) return;
  if (!studioState.nodes.length) {
    el.innerHTML = '<div class="studio-canvas__empty"><div class="studio-canvas__empty-icon">&#9881;</div><div>Describe a task and click Run</div></div>';
    return;
  }

  var nodes = studioState.nodes;
  var hasActive = nodes.some(function(n){ return n.status === \x27running\x27; });
  var doneCount = nodes.filter(function(n){ return n.status === \x27done\x27; }).length;
  var totalCount = nodes.length;

  var phaseLabel2 = hasActive
    ? (\x27Workflow in esecuzione \u2014 \x27+doneCount+\x27/\x27+totalCount)
    : (doneCount===totalCount && totalCount>0 ? \x27Workflow completato\x27 : \x27Workflow pianificato\x27);
  var phaseColor2 = hasActive ? \x27#6366f1\x27 : (doneCount===totalCount && totalCount>0 ? \x27#1f2937\x27 : \x27#6b7280\x27);

  // ── CSS Grid layout: 100% width, responsive ──────────────────────────────
  var totalStations = totalCount + 1; // +1 for orchestrator
  var cols = totalStations <= 2 ? totalStations : (totalStations <= 4 ? 2 : (totalStations <= 6 ? 3 : 4));
  var gridTpl = \x27repeat(\x27+cols+\x27,1fr)\x27;

  var bigPlant = String.fromCodePoint(0x1FAB4);
  var plantEmoji = String.fromCodePoint(0x1F331);

  // Find the index of the currently active node (for orchestrator positioning)
  var activeNodeIdx = -1;
  nodes.forEach(function(n, i) { if (n.status === \x27running\x27) activeNodeIdx = i; });

  function buildStation2(label, toolEmoji, isOrch, isActive, isDone, isErr, emojiIdx, nodeIdx) {
    var accentColor = isOrch ? \x27#818cf8\x27 : (isActive ? \x27#6366f1\x27 : (isDone ? \x27#374151\x27 : (isErr ? \x27#ef4444\x27 : \x27#9ca3af\x27)));
    var nameBg = isDone ? \x27rgba(0,0,0,.1)\x27 : (isActive ? \x27#ede9fe\x27 : (isOrch ? \x27#e0e7ff\x27 : \x27rgba(255,255,255,.85)\x27));
    var nameColor = isDone ? \x27#111827\x27 : (isActive ? \x27#4f46e5\x27 : (isOrch ? \x27#4338ca\x27 : (isErr ? \x27#dc2626\x27 : \x27#374151\x27)));
    var monScreen = isOrch
      ? \x27<span style="font-size:11px">&#128269;</span>\x27
      : (isDone ? \x27<span style="color:#111827;font-size:13px">&#10003;</span>\x27
         : (isActive ? \x27<span class="iso-monitor-blink"></span>\x27
            : \x27<span style="font-size:8px;opacity:.35;color:#818cf8">&#9632;</span>\x27));
    // Bubble: for agents, leave text empty so JS streaming fills it live; show "✓ fatto" when done
    var bubbleText = isOrch
      ? (hasActive ? (\x27Assegno step \x27+(doneCount+1)+\x27/\x27+totalCount) : (doneCount===totalCount&&totalCount>0 ? \x27\u2714 Fatto!\x27 : \x27In attesa\x27))
      : (isDone ? \x27\u2714 fatto\x27 : (isErr ? \x27\u2715 errore\x27 : (isActive ? \x27\x27 : \x27\x27)));
    var bubbleBg = isOrch ? \x27rgba(255,255,255,.95)\x27 : (isActive ? \x27#ffffff\x27 : (isDone ? \x27rgba(0,0,0,.08)\x27 : \x27rgba(239,68,68,.12)\x27));
    var bubbleColor = isActive ? \x27#000000\x27 : (isOrch ? \x27#111827\x27 : (isDone ? \x27#374151\x27 : \x27#6b7280\x27));
    var bubbleFontWeight = isActive ? \x27700\x27 : \x27500\x27;
    var glowBox = isActive ? (\x270 0 0 3px \x27+accentColor+\x2744,0 8px 24px \x27+accentColor+\x2733\x27) : (isDone ? (\x270 0 0 2px rgba(0,0,0,.25)\x27) : \x27none\x27);
    // Orchestrator char: no CSS walk animation — JS moves it via inline transform toward the active agent column
    var charIdAttr = isOrch ? \x27 id="wfOrchChar"\x27 : \x27\x27;
    var charHtml = \x27<div class="iso-char-mover"\x27+charIdAttr+\x27>\x27+isoCharSvg({emojiIdx: isOrch ? 99 : emojiIdx, isActive: isActive, isDone: isDone, scale: 1.1, accentColor: accentColor})+\x27</div>\x27;
    var clickAttr = isOrch ? \x27\x27 : (\x27data-agent-label="\x27+esc(label)+\x27" onclick="studioScrollToAgent(this.getAttribute(String.fromCharCode(100,97,116,97,45,97,103,101,110,116,45,108,97,98,101,108)))"\x27);
    // Flying doc emoji when active
    // 3 paper sheets flying up from above the monitor — staggered animation via nth-child
    var flyDoc = isActive ? \x27<div class="iso-fly-doc"><span>\x27+String.fromCodePoint(0x1F4C4)+\x27</span><span>\x27+String.fromCodePoint(0x1F4C3)+\x27</span><span>\x27+String.fromCodePoint(0x1F4C4)+\x27</span></div>\x27 : \x27\x27;
    // Bubble id: orchestrator gets wfOrchBubble, agents get isobubble_IDX
    var bubbleId = isOrch ? \x27wfOrchBubble\x27 : (\x27isobubble_\x27+nodeIdx);
    var bubbleVisible = (bubbleText || isOrch || isActive) ? \x27visible\x27 : \x27hidden\x27;
    return \x27<div class="iso-station" \x27+clickAttr+\x27 data-station-idx="\x27+(isOrch?-1:nodeIdx)+\x27" style="box-shadow:\x27+glowBox+\x27;border-color:\x27+accentColor+\x27;transition:box-shadow .4s">\x27+
      flyDoc+
      \x27<div class="iso-bubble\x27+(isActive?\x27 iso-bubble--active\x27:\x27\x27)+\x27" id="\x27+bubbleId+\x27" style="border-color:\x27+accentColor+\x27;color:\x27+bubbleColor+\x27;font-weight:\x27+bubbleFontWeight+\x27;background:\x27+bubbleBg+\x27;visibility:\x27+bubbleVisible+\x27">\x27+esc(bubbleText)+\x27</div>\x27+
      \x27<div class="iso-tool-badge">\x27+toolEmoji+\x27</div>\x27+
      charHtml+
      \x27<div class="iso-desk" style="width:85%;border-top-color:\x27+accentColor+\x2733"></div>\x27+
      \x27<div class="iso-monitor" style="border-color:\x27+accentColor+\x2777"><div class="iso-monitor-screen">\x27+monScreen+\x27</div></div>\x27+
      \x27<div class="iso-name" style="color:\x27+nameColor+\x27;background:\x27+nameBg+\x27">\x27+(isOrch?\x27\u2666\xA0\x27:\x27\x27)+esc(label)+\x27</div>\x27+
      \x27</div>\x27;
  }

  var stationsHtml = \x27\x27;
  var orchDone2 = !hasActive && doneCount===totalCount && totalCount>0;
  stationsHtml += buildStation2(\x27Orchestratore\x27, String.fromCodePoint(0x1F4CB), true, hasActive, orchDone2, false, 99, -1);
  nodes.forEach(function(n, idx) {
    stationsHtml += buildStation2(
      n.label || n.agent,
      getNodeEmoji(n),
      false,
      n.status===\x27running\x27,
      n.status===\x27done\x27,
      n.status===\x27error\x27,
      idx,
      idx
    );
  });

  // Floor SVG
  var FW = 1000; var FH = 600;
  var wallH = Math.round(FH * 0.30);
  var floorSvg = \x27<svg viewBox="0 0 \x27+FW+\x27 \x27+FH+\x27" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none">\x27;
  floorSvg += \x27<defs>\x27;
  floorSvg += \x27<filter id="bGlow2" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>\x27;
  floorSvg += \x27<linearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#faf7f2"/><stop offset="1" stop-color="#ede8e0"/></linearGradient>\x27;
  floorSvg += \x27</defs>\x27;
  floorSvg += \x27<rect x="0" y="0" width="\x27+FW+\x27" height="\x27+wallH+\x27" fill="url(#wallGrad)"/>\x27;
  floorSvg += \x27<rect x="0" y="\x27+(wallH-5)+\x27" width="\x27+FW+\x27" height="7" fill="#d4c4a8" rx="2"/>\x27;
  var plankColors2 = [\x27#c8a06a\x27,\x27#bf9860\x27,\x27#d4aa72\x27,\x27#ba9458\x27,\x27#caa86e\x27];
  var pH = 32; var pW = 120;
  for (var fy = wallH; fy < FH+pH; fy += pH) {
    var ro2 = (Math.floor((fy-wallH)/pH) % 2) * (pW/2);
    for (var fx = -pW+ro2; fx < FW+pW; fx += pW) {
      var pc2 = plankColors2[Math.abs(Math.round(fx/pW+fy/pH*1.3)) % plankColors2.length];
      floorSvg += \x27<rect x="\x27+Math.round(fx)+\x27" y="\x27+fy+\x27" width="\x27+(pW-2)+\x27" height="\x27+(pH-2)+\x27" fill="\x27+pc2+\x27" rx="2"/>\x27;
      floorSvg += \x27<line x1="\x27+Math.round(fx+pW*0.4)+\x27" y1="\x27+fy+\x27" x2="\x27+Math.round(fx+pW*0.4)+\x27" y2="\x27+(fy+pH-2)+\x27" stroke="rgba(0,0,0,.04)" stroke-width="1.5"/>\x27;
    }
  }
  function svgWindow(wx, wy, ww, wh) {
    var r = \x27<rect x="\x27+wx+\x27" y="\x27+wy+\x27" width="\x27+ww+\x27" height="\x27+wh+\x27" rx="4" fill="#c8e6f8" stroke="#a8cce0" stroke-width="3"/>\x27;
    r += \x27<rect x="\x27+wx+\x27" y="\x27+wy+\x27" width="\x27+ww+\x27" height="\x27+wh+\x27" rx="4" fill="rgba(255,255,255,.2)"/>\x27;
    r += \x27<line x1="\x27+(wx+ww/2)+\x27" y1="\x27+wy+\x27" x2="\x27+(wx+ww/2)+\x27" y2="\x27+(wy+wh)+\x27" stroke="#a8cce0" stroke-width="2"/>\x27;
    r += \x27<line x1="\x27+wx+\x27" y1="\x27+(wy+wh/2)+\x27" x2="\x27+(wx+ww)+\x27" y2="\x27+(wy+wh/2)+\x27" stroke="#a8cce0" stroke-width="2"/>\x27;
    return r;
  }
  floorSvg += svgWindow(40, 20, 100, 80);
  floorSvg += svgWindow(180, 20, 100, 80);
  floorSvg += svgWindow(FW-200, 20, 120, 80);
  floorSvg += \x27<rect x="\x27+(FW/2-35)+\x27" y="0" width="70" height="\x27+wallH+\x27" fill="#c8a87a" stroke="#a07848" stroke-width="2"/>\x27;
  floorSvg += \x27<rect x="\x27+(FW/2-25)+\x27" y="8" width="50" height="36" rx="4" fill="rgba(255,255,255,.18)"/>\x27;
  floorSvg += \x27<circle cx="\x27+(FW/2+22)+\x27" cy="\x27+(wallH/2)+\x27" r="5" fill="#8a6028"/>\x27;
  floorSvg += \x27<line x1="\x27+(FW/2)+\x27" y1="0" x2="\x27+(FW/2)+\x27" y2="30" stroke="#bbb" stroke-width="3"/>\x27;
  floorSvg += \x27<ellipse cx="\x27+(FW/2)+\x27" cy="38" rx="50" ry="14" fill="#e8d960" stroke="#c8b030" stroke-width="2"/>\x27;
  floorSvg += \x27<circle cx="\x27+(FW/2-28)+\x27" cy="46" r="8" fill="#fffde0" filter="url(#bGlow2)"/>\x27;
  floorSvg += \x27<circle cx="\x27+(FW/2)+\x27" cy="50" r="8" fill="#fffde0" filter="url(#bGlow2)"/>\x27;
  floorSvg += \x27<circle cx="\x27+(FW/2+28)+\x27" cy="46" r="8" fill="#fffde0" filter="url(#bGlow2)"/>\x27;
  floorSvg += \x27<polygon points="\x27+(FW/2-60)+\x27,60 \x27+(FW/2+60)+\x27,60 \x27+(FW/2+160)+\x27,\x27+FH+\x27 \x27+(FW/2-160)+\x27,\x27+FH+\x27" fill="rgba(255,252,200,.06)"/>\x27;
  floorSvg += \x27</svg>\x27;

  var decoHtml =
    \x27<div style="position:absolute;bottom:10px;left:12px;font-size:40px;line-height:1;filter:drop-shadow(0 3px 6px rgba(0,0,0,.25));z-index:5">\x27+bigPlant+\x27</div>\x27+
    \x27<div style="position:absolute;bottom:10px;right:12px;font-size:40px;line-height:1;filter:drop-shadow(0 3px 6px rgba(0,0,0,.25));z-index:5">\x27+bigPlant+\x27</div>\x27+
    \x27<div style="position:absolute;top:12px;left:310px;font-size:24px;line-height:1;z-index:5">\x27+plantEmoji+\x27</div>\x27+
    \x27<div style="position:absolute;top:12px;right:230px;font-size:24px;line-height:1;z-index:5">\x27+plantEmoji+\x27</div>\x27;

  el.innerHTML =
    \x27<div class="prl-wrap" style="border-color:\x27+phaseColor2+\x2744;padding-bottom:8px">\x27+
    \x27<div class="prl-header"><span class="prl-phase-chip" style="--pc:\x27+phaseColor2+\x27">\x27+phaseLabel2+\x27</span></div>\x27+
    \x27<div class="iso-scene" style="position:relative">\x27+
    floorSvg+
    decoHtml+
    \x27<div style="position:relative;z-index:10;display:grid;grid-template-columns:\x27+gridTpl+\x27;gap:0;padding:12px 16px;box-sizing:border-box;align-items:end;min-height:440px">\x27+
    \x27<div style="grid-column:1/-1;height:calc(30% - 12px)"></div>\x27+
    stationsHtml+
    \x27</div>\x27+
    \x27</div>\x27+
    \x27</div>\x27;

  // Move orchestrator character toward the active agent column.
  // Grid: col 0 = orchestrator, col 1..N = agents. Each column is 1fr.
  // We measure the pixel offset between the orchestrator station and the active agent station.
  if (activeNodeIdx >= 0) {
    requestAnimationFrame(function() {
      var orchChar = document.getElementById(\x27wfOrchChar\x27);
      var orchStation = document.querySelector(\x27[data-station-idx="-1"]\x27);
      var activeStation = document.querySelector(\x27[data-station-idx="\x27+activeNodeIdx+\x27"]\x27);
      if (orchChar && orchStation && activeStation) {
        var orchRect = orchStation.getBoundingClientRect();
        var activeRect = activeStation.getBoundingClientRect();
        var delta = (activeRect.left + activeRect.width/2) - (orchRect.left + orchRect.width/2);
        var shift = Math.round(delta * 0.62);
        orchChar.style.transition = \x27transform 1.2s cubic-bezier(.4,0,.2,1)\x27;
        orchChar.style.transform = \x27translateX(\x27+shift+\x27px)\x27;
        orchChar.setAttribute(\x27data-last-shift\x27, String(shift));
        // Also update orch bubble to show what it is assigning
        var orchBubble = document.getElementById(\x27wfOrchBubble\x27);
        if (orchBubble) {
          var activeNode = studioState.nodes[activeNodeIdx];
          orchBubble.style.visibility = \x27visible\x27;
          orchBubble.textContent = \x27Assegno a \x27+(activeNode ? (activeNode.label || activeNode.agent) : \x27agente\x27);
        }
      }
    });
  } else {
    // No active agent: reset orchestrator to home position
    requestAnimationFrame(function() {
      var orchChar = document.getElementById(\x27wfOrchChar\x27);
      if (orchChar) {
        orchChar.style.transition = \x27transform 0.8s cubic-bezier(.4,0,.2,1)\x27;
        orchChar.style.transform = \x27translateX(0)\x27;
      }
    });
  }
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
  var existingEntries = el.querySelectorAll('.studio-log-entry');
  studioState.log.forEach(function(e, i) {
    var isStreaming = false;
    if (existingEntries[i]) {
      var tb = existingEntries[i].querySelector('.studio-log-entry__text');
      if (tb && tb.getAttribute(String.fromCharCode(100,97,116,97,45,114,108,101,110)) !== null) {
        isStreaming = true;
      }
    }
    if (isStreaming) return; // leave streaming entry DOM untouched
    var cls = 'studio-log-entry' + (e.type === 'system' ? ' studio-log-entry--system' : e.type === 'error' ? ' studio-log-entry--error' : '');
    var html = '<div class="' + cls + '">' +
      '<div class="studio-log-entry__header">' +
        '<span class="studio-log-entry__icon">' + e.icon + '</span>' +
        '<span class="studio-log-entry__agent">' + esc(e.agent) + '</span>' +
        '<span class="studio-log-entry__time">' + esc(e.time) + '</span>' +
      '</div>' +
      '<div class="studio-log-entry__text md-body">' + renderMd(e.text) + '</div>' +
    '</div>';
    if (existingEntries[i]) {
      existingEntries[i].outerHTML = html;
    } else {
      var div = document.createElement('div');
      div.innerHTML = html;
      el.appendChild(div.firstChild);
    }
    // refresh reference after replacement
    existingEntries = el.querySelectorAll('.studio-log-entry');
  });
  // remove extra entries (shouldn't happen but be safe)
  while (el.querySelectorAll('.studio-log-entry').length > studioState.log.length) {
    el.removeChild(el.lastChild);
  }
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

  // ── Charts / Canvas section (from CanvasAgent HTML) ──────────────────────
  (studioState.canvas ? (
    '<div class="section" style="page-break-before:always">' +
      '<div class="agent-header"><span class="agent-icon">&#128202;</span>' +
        '<div><div class="agent-name">Grafici e Dashboard</div>' +
        '<div class="agent-sub">CANVAS AGENT &nbsp;&#183;&nbsp; Visualizzazioni dati</div></div>' +
      '</div>' +
      '<div id="nha-canvas-charts" style="width:100%;overflow:hidden">' +
        studioState.canvas
          .replace(new RegExp('<script[^>]*>[\\s\\S]*?<\\/script>', 'gi'), '')
          .replace(new RegExp('<html[^>]*>|<\\/html>|<head[\\s\\S]*?<\\/head>|<body[^>]*>|<\\/body>', 'gi'), '') +
      '</div>' +
    '</div>'
  ) : '') +

  // ── Footer ───────────────────────────────────────────────────────────────
  '<div class="footer-bar">' +
    '<span class="footer-left">NHA Studio &nbsp;&#183;&nbsp; nothumanallowed.com</span>' +
    '<span class="footer-right">' + today + ' ' + nowTime +
      (totalTokensIn > 0 ? ' &nbsp;&#183;&nbsp; ' + totalTokensIn.toLocaleString() + ' token in / ' + totalTokensOut.toLocaleString() + ' out' : '') +
    '</span>' +
  '</div>' +

  // ── Canvas-to-image script: converts <canvas> → <img> before printing ────
  // This runs inside the iframe, ensuring charts are visible in the PDF.
  '<script>' +
    'window.addEventListener("load", function() {' +
      // Give Chart.js time to render all charts
      'setTimeout(function() {' +
        'function freezeCanvases() {' +
          'var canvases = document.querySelectorAll("canvas");' +
          'canvases.forEach(function(cv) {' +
            'try {' +
              'var img = document.createElement("img");' +
              'img.src = cv.toDataURL("image/png");' +
              'img.style.cssText = cv.style.cssText || "";' +
              'img.style.maxWidth = "100%";' +
              'img.style.display = "block";' +
              'img.style.margin = "0 auto";' +
              'if (cv.parentNode) cv.parentNode.replaceChild(img, cv);' +
            '} catch(e) {}' +
          '});' +
        '}' +
        'window.addEventListener("beforeprint", freezeCanvases);' +
      '}, 1200);' +
    '});' +
  '<\/script>' +

  '</body></html>';

  // ── Generate PDF via hidden in-page iframe ─────────────────────────────────
  // Uses a hidden iframe instead of window.open() to avoid popup blockers.
  // The iframe loads the full report HTML (with Chart.js), waits for charts to
  // render, then calls contentWindow.print() — browser handles all page breaks
  // via the @media print block already in NHA_CSS (break-inside:avoid, etc.)
  // User gets the native "Save as PDF" dialog from the browser print dialog.
  function doGeneratePdf() {
    var btn2 = document.getElementById('studioInlinePdfBtn');
    var dlBtn2 = document.querySelector('button[onclick="downloadStudioPDF()"]');
    function setBusy(b) {
      if (btn2) { btn2.disabled = b; btn2.textContent = b ? 'Generando PDF...' : '\u2913 PDF'; }
      if (dlBtn2) { dlBtn2.disabled = b; dlBtn2.textContent = b ? 'Generando PDF...' : '\u2913 Download PDF'; }
    }
    setBusy(true);

    // Remove any previous print iframe
    var oldIframe = document.getElementById('nhaPrintFrame');
    if (oldIframe) oldIframe.remove();

    var iframe = document.createElement('iframe');
    iframe.id = 'nhaPrintFrame';
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:900px;height:700px;border:none;opacity:0;pointer-events:none';

    // Set up onload BEFORE appending — avoids WebKit race condition
    iframe.onload = function() {
      // Wait for Chart.js to initialize all charts and freezeCanvases to run (needs ~2s)
      var waitMs = studioState.canvas ? 2500 : 800;
      setTimeout(function() {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch(e2) {
          // Cross-origin fallback should not happen since we write the content
        }
        setBusy(false);
        // Remove iframe after print dialog closes (delayed to allow Safari)
        setTimeout(function(){ try { iframe.remove(); } catch(e3){} }, 8000);
      }, 800);
    };

    document.body.appendChild(iframe);

    // Write HTML into iframe document
    try {
      iframe.contentDocument.open();
      iframe.contentDocument.write(html);
      iframe.contentDocument.close();
    } catch(e4) {
      // If contentDocument write fails (very rare), fall back to srcdoc
      iframe.srcdoc = html;
    }

    // Safety fallback: if onload never fires (e.g. Safari blank srcdoc), force after 3s
    setTimeout(function() { setBusy(false); }, 5000);
  }
  doGeneratePdf();
}

// ── Studio Export: CSV ────────────────────────────────────────────────────────
function extractMarkdownTables(md) {
  var NL = String.fromCharCode(10);
  var lines = md.split(NL);
  var tables = [];
  var current = null;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (l.charAt(0) === '|' && l.lastIndexOf('|') > 0) {
      if (/^\|[\s\-|:]+\|$/.test(l)) { continue; } // separator
      var cells = l.split('|').slice(1,-1).map(function(c){ return c.trim(); });
      if (!current) { current = { headers: cells, rows: [] }; }
      else { current.rows.push(cells); }
    } else {
      if (current && current.rows.length > 0) { tables.push(current); }
      current = null;
    }
  }
  if (current && current.rows.length > 0) tables.push(current);
  return tables;
}

function tableToCsvString(table) {
  var NL = String.fromCharCode(10);
  function escCell(v) {
    if (v === undefined || v === null) return '';
    var s = String(v).replace(new RegExp('"', 'g'), '""');
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf(NL) >= 0) return '"' + s + '"';
    return s;
  }
  var rows = [table.headers].concat(table.rows);
  return rows.map(function(r){ return r.map(escCell).join(','); }).join(NL);
}

function downloadStudioCSV() {
  var nodes = (studioState.nodes || []).filter(function(n){ return n.output && n.output !== '(no output)'; });
  var allTables = [];
  nodes.forEach(function(n) {
    var tbls = extractMarkdownTables(n.output || '');
    tbls.forEach(function(t, i){ allTables.push({ agent: (n.label||n.agent), idx: i+1, table: t }); });
  });
  // Also check synthesis result
  if (studioState.result) {
    var tbls2 = extractMarkdownTables(studioState.result);
    tbls2.forEach(function(t, i){ allTables.push({ agent: 'Synthesis', idx: i+1, table: t }); });
  }
  if (allTables.length === 0) { alert('Nessuna tabella trovata nel report. Chiedi agli agenti di produrre dati in formato tabella Markdown.'); return; }
  var NL = String.fromCharCode(10);
  var csvParts = allTables.map(function(entry) {
    return '# ' + entry.agent + (allTables.length > 1 ? ' — Tabella ' + entry.idx : '') + NL + tableToCsvString(entry.table);
  });
  var csv = csvParts.join(NL + NL);
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var fname = (studioState.task || 'NHA-Studio').slice(0,50).replace(/[^a-z0-9\s]/gi,'').trim().replace(/\s+/g,'-') + '.csv';
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
}

// ── Studio Export: Excel (XLSX via SheetJS) ───────────────────────────────────
var _xlsxLoaded = false;
var _xlsxLoading = false;

function loadXLSX(cb) {
  if (_xlsxLoaded && window.XLSX) { cb(); return; }
  if (_xlsxLoading) { setTimeout(function(){ loadXLSX(cb); }, 200); return; }
  _xlsxLoading = true;
  var s = document.createElement('script');
  s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  s.onload = function() { _xlsxLoaded = true; _xlsxLoading = false; cb(); };
  s.onerror = function() { _xlsxLoading = false; alert('Errore caricamento SheetJS. Controlla la connessione.'); };
  document.head.appendChild(s);
}

function downloadStudioXLSX() {
  loadXLSX(function() { _doGenerateXLSX(); });
}

function _doGenerateXLSX() {
  var XLSX = window.XLSX;
  if (!XLSX) { alert('SheetJS non disponibile.'); return; }

  var nodes = (studioState.nodes || []).filter(function(n){ return n.output && n.output !== '(no output)' && n.agent !== 'CanvasAgent'; });
  var task = studioState.task || 'NHA Studio Report';
  var today = new Date();
  var dateStr = today.toLocaleDateString('it-IT');
  var wb = XLSX.utils.book_new();

  // ── ACCENT COLORS per agente ──────────────────────────────────────────────
  var AGENT_COLORS = ['4F46E5','0891B2','059669','D97706','DC2626','7C3AED','0284C7','BE185D','0D9488','CA8A04'];

  // ── Helper: cell style fabbrica ──────────────────────────────────────────
  function headerStyle(hexFg) {
    return {
      font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11, name: 'Calibri' },
      fill: { patternType: 'solid', fgColor: { rgb: hexFg || '4F46E5' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: {
        top:    { style: 'thin', color: { rgb: 'CCCCCC' } },
        bottom: { style: 'thin', color: { rgb: 'CCCCCC' } },
        left:   { style: 'thin', color: { rgb: 'CCCCCC' } },
        right:  { style: 'thin', color: { rgb: 'CCCCCC' } }
      }
    };
  }
  function dataStyle(even) {
    return {
      font: { sz: 10, name: 'Calibri' },
      fill: even ? { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } } : { patternType: 'none' },
      alignment: { vertical: 'center', wrapText: true },
      border: {
        top:    { style: 'hair', color: { rgb: 'E5E7EB' } },
        bottom: { style: 'hair', color: { rgb: 'E5E7EB' } },
        left:   { style: 'hair', color: { rgb: 'E5E7EB' } },
        right:  { style: 'hair', color: { rgb: 'E5E7EB' } }
      }
    };
  }
  function titleStyle(hex) {
    return {
      font: { bold: true, sz: 14, name: 'Calibri', color: { rgb: hex || '4F46E5' } },
      fill: { patternType: 'solid', fgColor: { rgb: 'F8F9FC' } },
      alignment: { horizontal: 'left', vertical: 'center' }
    };
  }
  function metaStyle() {
    return { font: { sz: 10, italic: true, color: { rgb: '6B7280' }, name: 'Calibri' } };
  }

  // ── Helper: parse numeric value ───────────────────────────────────────────
  function parseNum(v) {
    var s = String(v).replace(/[€$£%,\s]/g,'').trim();
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // ── Helper: aggiunge un foglio tabella da markdown ────────────────────────
  function addTableSheet(sheetName, agentLabel, tables, colorHex) {
    var ws = {};
    var maxCol = 0;
    var rowNum = 0;

    // Title row
    ws['A' + (rowNum+1)] = { v: agentLabel, t: 's', s: titleStyle(colorHex) };
    rowNum++;
    // Meta row
    ws['A' + (rowNum+1)] = { v: 'Generato da NHA Studio il ' + dateStr, t: 's', s: metaStyle() };
    ws['B' + (rowNum+1)] = { v: 'Task: ' + task.slice(0,80), t: 's', s: metaStyle() };
    rowNum++;
    rowNum++; // blank

    tables.forEach(function(table, ti) {
      if (tables.length > 1) {
        ws['A' + (rowNum+1)] = { v: 'Tabella ' + (ti+1), t: 's', s: { font: { bold: true, sz: 11, name: 'Calibri', color: { rgb: colorHex } } } };
        rowNum++;
      }
      // Detect numeric columns
      var isNumericCol = table.headers.map(function(_, ci) {
        return table.rows.every(function(r){ return r[ci] === undefined || r[ci] === '' || parseNum(r[ci]) !== null; });
      });
      // Header row
      var colCount = table.headers.length;
      table.headers.forEach(function(h, ci) {
        var col = String.fromCharCode(65 + ci);
        ws[col + (rowNum+1)] = { v: h, t: 's', s: headerStyle(colorHex) };
        if (ci > maxCol) maxCol = ci;
      });
      rowNum++;
      // Data rows
      table.rows.forEach(function(row, ri) {
        row.forEach(function(cell, ci) {
          var col = String.fromCharCode(65 + ci);
          var num = isNumericCol[ci] ? parseNum(cell) : null;
          var addr = col + (rowNum+1);
          if (num !== null && cell !== '') {
            ws[addr] = { v: num, t: 'n', z: num % 1 !== 0 ? '#,##0.00' : '#,##0', s: dataStyle(ri % 2 === 0) };
          } else {
            ws[addr] = { v: cell || '', t: 's', s: dataStyle(ri % 2 === 0) };
          }
        });
        rowNum++;
      });
      rowNum++; // blank between tables
    });

    // Set sheet range
    var lastCol = String.fromCharCode(65 + maxCol);
    ws['!ref'] = 'A1:' + lastCol + (rowNum + 1);

    // Column widths (auto-estimate from content)
    var colWidths = [];
    for (var ci = 0; ci <= maxCol; ci++) {
      var maxW = 12;
      tables.forEach(function(table) {
        if (table.headers[ci]) maxW = Math.max(maxW, table.headers[ci].length + 2);
        table.rows.forEach(function(r){ if (r[ci]) maxW = Math.max(maxW, Math.min(String(r[ci]).length + 2, 50)); });
      });
      colWidths.push({ wch: maxW });
    }
    ws['!cols'] = colWidths;

    // Row heights
    var rowH = [];
    for (var ri2 = 0; ri2 < rowNum; ri2++) rowH.push({ hpt: ri2 < 3 ? 22 : 18 });
    ws['!rows'] = rowH;

    // Freeze top rows (title + meta + header row of first table)
    ws['!freeze'] = { xSplit: 0, ySplit: 4, topLeftCell: 'A5' };

    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0,31));
  }

  // ── Foglio INDICE ─────────────────────────────────────────────────────────
  var wsIdx = {};
  wsIdx['A1'] = { v: 'NHA Studio Report', t: 's', s: titleStyle('4F46E5') };
  wsIdx['A2'] = { v: task, t: 's', s: { font: { sz: 12, name: 'Calibri', bold: true } } };
  wsIdx['A3'] = { v: 'Generato il ' + dateStr + ' con NHA Studio', t: 's', s: metaStyle() };
  wsIdx['A5'] = { v: 'Agente', t: 's', s: headerStyle('4F46E5') };
  wsIdx['B5'] = { v: 'Tabelle', t: 's', s: headerStyle('4F46E5') };
  wsIdx['C5'] = { v: 'Token In', t: 's', s: headerStyle('4F46E5') };
  wsIdx['D5'] = { v: 'Token Out', t: 's', s: headerStyle('4F46E5') };
  var idxRow = 5;
  var hasAnyTable = false;
  nodes.forEach(function(n, ni) {
    var tables = extractMarkdownTables(n.output || '');
    if (tables.length > 0) hasAnyTable = true;
    idxRow++;
    var co = AGENT_COLORS[ni % AGENT_COLORS.length];
    wsIdx['A' + idxRow] = { v: (n.label||n.agent), t: 's', s: dataStyle(ni % 2 === 0) };
    wsIdx['B' + idxRow] = { v: tables.length, t: 'n', s: dataStyle(ni % 2 === 0) };
    wsIdx['C' + idxRow] = { v: n.tokensIn || 0, t: 'n', z: '#,##0', s: dataStyle(ni % 2 === 0) };
    wsIdx['D' + idxRow] = { v: n.tokensOut || 0, t: 'n', z: '#,##0', s: dataStyle(ni % 2 === 0) };
  });
  wsIdx['!ref'] = 'A1:D' + (idxRow + 1);
  wsIdx['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsIdx, 'Indice');

  // ── Un foglio per ogni agente con tabelle ─────────────────────────────────
  var sheetCount = 0;
  nodes.forEach(function(n, ni) {
    var tables = extractMarkdownTables(n.output || '');
    if (tables.length === 0) return;
    var colorHex = AGENT_COLORS[ni % AGENT_COLORS.length];
    var sheetName = (n.label || n.agent).slice(0,28);
    addTableSheet(sheetName, n.label || n.agent, tables, colorHex);
    sheetCount++;
  });

  // ── Foglio Risultato Finale (testo libero come tabella a singola colonna) ──
  if (studioState.result) {
    var synTables = extractMarkdownTables(studioState.result);
    if (synTables.length > 0) {
      addTableSheet('Sintesi', 'Sintesi Finale', synTables, '059669');
      sheetCount++;
    } else {
      // Export free text as single-column sheet with line-by-line rows
      var wsText = {};
      wsText['A1'] = { v: 'Sintesi Finale', t: 's', s: titleStyle('059669') };
      wsText['A2'] = { v: task.slice(0,80), t: 's', s: metaStyle() };
      var NL5 = String.fromCharCode(10);
      var lines = (studioState.result || '').split(NL5);
      lines.forEach(function(line, li) {
        wsText['A' + (li+4)] = { v: line.replace(new RegExp('[*_#]','g'), '').replace(new RegExp(String.fromCharCode(96),'g'), ''), t: 's', s: dataStyle(li % 2 === 0) };
      });
      wsText['!ref'] = 'A1:A' + (lines.length + 4);
      wsText['!cols'] = [{ wch: 90 }];
      XLSX.utils.book_append_sheet(wb, wsText, 'Sintesi');
    }
  }

  if (sheetCount === 0 && !studioState.result) {
    alert('Nessuna tabella trovata. Chiedi agli agenti di produrre dati in formato tabella Markdown per generare Excel.');
    return;
  }

  var fname = task.slice(0,50).replace(/[^a-z0-9\s]/gi,'').trim().replace(/\s+/g,'-') + '-NHAStudio.xlsx';
  XLSX.writeFile(wb, fname, { bookType: 'xlsx', type: 'binary', cellStyles: true });
}

function renderStudioResult() {
  var el = document.getElementById('studioResult');
  if (!el) return;
  if (!studioState.result) {
    el.style.display = 'none';
    var _xb = document.getElementById('studioInlineXlsxBtn'); if (_xb) _xb.style.display = 'none';
    var _cb = document.getElementById('studioInlineCsvBtn'); if (_cb) _cb.style.display = 'none';
    var _pb = document.getElementById('studioInlinePdfBtn'); if (_pb) _pb.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  var hasCanvas = !!(studioState.canvas);
  var body = hasCanvas
    ? '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="color:var(--dim);font-size:13px">&#10003; ' + t('canvas_generated') + '</span><button onclick="openCanvasPanel()" style="padding:6px 14px;background:var(--greendim);border:1px solid var(--green3);border-radius:8px;color:var(--green);font-size:12px;cursor:pointer;font-weight:700">&#x25A3; ' + t('canvas_open') + '</button></div>'
    : '<div class="md-body">' + renderMd(studioState.result) + '</div>';
  var tokLine = (studioTokens && (studioTokens.in > 0 || studioTokens.out > 0))
    ? '<div style="margin-top:8px;font-size:11px;color:var(--dim);font-family:var(--mono)">&#x2B06; ' + (studioTokens.in||0).toLocaleString() + ' token in &nbsp;&#x2B07; ' + (studioTokens.out||0).toLocaleString() + ' token out &nbsp;&#x2022;&nbsp; <strong style="color:var(--green)">' + ((studioTokens.in||0)+(studioTokens.out||0)).toLocaleString() + '</strong> totale</div>'
    : '';
  var dlBtn = '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<button onclick="downloadStudioPDF()" title="Report completo come PDF" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:linear-gradient(135deg,#4f46e5,#2563eb);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(79,70,229,.35)">&#x2913; PDF</button>' +
    '<button onclick="downloadStudioXLSX()" title="Esporta tabelle come Excel professionale (SheetJS)" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:linear-gradient(135deg,#059669,#047857);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(5,150,105,.35)">&#x1f4ca; Excel</button>' +
    '<button onclick="downloadStudioCSV()" title="Esporta tabelle come CSV" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:linear-gradient(135deg,#0891b2,#0369a1);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(8,145,178,.35)">&#x1f4cb; CSV</button>' +
    '</div>';
  el.innerHTML = '<div class="studio-result__title">&#10003; ' + t('workflow_complete') + '</div>' + body + tokLine + dlBtn;
  // Show/hide inline export buttons in the prompt bar
  var inlinePdfBtn = document.getElementById('studioInlinePdfBtn');
  if (inlinePdfBtn) inlinePdfBtn.style.display = 'inline-flex';
  var inlineXlsxBtn = document.getElementById('studioInlineXlsxBtn');
  if (inlineXlsxBtn) inlineXlsxBtn.style.display = 'inline-flex';
  var inlineCsvBtn = document.getElementById('studioInlineCsvBtn');
  if (inlineCsvBtn) inlineCsvBtn.style.display = 'inline-flex';
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
  parlActiveAgent = null;
  parlDoneAgents = {};
  _parlPersistHtml = null; // clear persisted parliament for fresh run
  var parlBlockEl = document.getElementById('studioParliamentBlock');
  if (parlBlockEl) { parlBlockEl.innerHTML = ''; parlBlockEl.style.display = 'none'; }
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
        nudge.innerHTML = \x27&#x1f4bc; <span><strong>Suggerimento:</strong> questo workflow ha \x27 + specialistAgents.length + \x27 agenti specialisti — attiva il <strong>Consiglio</strong> per un confronto critico tra le loro analisi.</span><button onclick="document.getElementById(\\\x27studioParliamentMode\\\x27).checked=true;studioState.parliamentMode=true;this.parentNode.remove()" style="margin-left:auto;background:#6366f1;border:none;border-radius:6px;color:#fff;padding:4px 10px;cursor:pointer;font-size:10px;white-space:nowrap">Attiva &#x1f4bc;</button>\x27;
        var tokenBar = document.getElementById(\x27studioTokenBar\x27);
        if (tokenBar && tokenBar.parentNode) tokenBar.parentNode.insertBefore(nudge, tokenBar.parentNode.firstChild);
      }
    }

    // Step 2: execute each step via SSE
    var context = '';
    for (var i = 0; i < studioState.nodes.length; i++) {
      var node = studioState.nodes[i];
      studioSetNodeStatus(i, 'running');
      studioLog(node.label, node.icon, t('starting_agent') || 'Elaborazione in corso...', 'agent');

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
    if (parliamentActive && studioState.nodes.length >= 1 && studioState.running) {
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
        studioLog(\x27Consiglio\x27, \x27&#x1f4bc;\x27, \x27Avvio Consiglio — gli agenti si riuniscono per confrontare e raffinare i risultati...\x27, \x27system\x27);
        // Add Consiglio node to pipeline visual
        var parlNodeIdx = studioState.nodes.length;
        studioState.nodes.push({icon:\x27&#x1f4bc;\x27, agent:\x27Consiglio\x27, label:\x27Consiglio\x27, status:\x27running\x27, output:\x27\x27, _rendered:false});
        renderStudioNodes();

        // ── Parliament visual block ──────────────────────────────────────
        // Track active R2 agent for visual block (module-level vars)
        parlActiveAgent = null;
        parlDoneAgents = {};

        // ── Parliament boardroom: first call builds DOM, subsequent calls only update state ──
        var parlBlockBuilt = false;

        function renderParlBlock(phase, activeLabel, convergence) {
          var pb = document.getElementById(\x27studioParliamentBlock\x27);
          if (!pb) return;
          pb.style.display = \x27block\x27;

          var phaseColor = {r1:\x27#6366f1\x27,r2:\x27#22d3ee\x27,r3:\x27#f59e0b\x27,done:\x27#22c55e\x27}[phase]||\x27#6366f1\x27;
          var phaseLabel = {
            r1:\x27Consiglio \u2014 Analisi individuale\x27,
            r2:\x27Consiglio \u2014 Confronto e raffinamento\x27,
            r3:\x27Consiglio \u2014 Sintesi finale HERALD\x27,
            done:\x27Consiglio concluso \u2014 consenso raggiunto\x27
          }[phase]||\x27\x27;
          var n = proposals.length;
          var doneCount = Object.keys(parlDoneAgents).length;
          var progressPct = n > 0 ? Math.round(doneCount / n * 100) : 0;

          // ─────────────────────────────────────────────────────────────────────
          // BOARDROOM 3D — first call builds the full DOM structure.
          // Subsequent calls ONLY update agent states (no innerHTML overwrite).
          // ─────────────────────────────────────────────────────────────────────

          if (!parlBlockBuilt || !pb.innerHTML.trim()) {
            parlBlockBuilt = true;

            // ── FREE agent builder — no box, just floating emoji+name ─────────
            function buildSeat(prop, seatIdx) {
              var lbl = prop.label || prop.agent;
              var safeLbl = lbl.replace(new RegExp('[^a-zA-Z0-9_-]','g'),\x27_\x27);
              var emojiIdx = Math.abs(lbl.charCodeAt(0)+(lbl.charCodeAt(lbl.length-1)||0)) % AGENT_EMOJIS.length;
              var agentEmoji = AGENT_EMOJIS[emojiIdx];
              void seatIdx;
              return \x27<div class="br-seat" id="brseat_\x27+safeLbl+\x27" data-lbl="\x27+esc(lbl)+\x27">\x27+
                \x27<div class="br-bubble" id="brbubble_\x27+safeLbl+\x27" style="display:none"></div>\x27+
                \x27<div class="br-char" id="brchar_\x27+safeLbl+\x27">\x27+agentEmoji+\x27</div>\x27+
                \x27<div class="br-seat-name" id="brname_\x27+safeLbl+\x27">\x27+esc(lbl)+\x27</div>\x27+
                \x27</div>\x27;
            }

            var topSeats = [];
            var botSeats = [];
            proposals.forEach(function(prop, si) {
              if (si % 2 === 0) topSeats.push(prop); else botSeats.push(prop);
            });
            var topHtml = topSeats.map(buildSeat).join(\x27\x27);
            var botHtml = botSeats.map(buildSeat).join(\x27\x27);

            // Orchestrator head — free floating, no box
            var orchEmoji2 = String.fromCodePoint(0x1F9D1,0x200D,0x1F4BC);
            var crownEm = String.fromCodePoint(0x1F451);
            var orchHeadHtml = \x27<div class="br-orch" id="brOrch">\x27+
              \x27<div class="br-orch-speech" id="brOrchSpeech" style="display:none"></div>\x27+
              \x27<div class="br-orch-inner">\x27+
              \x27<span class="br-orch-crown">\x27+crownEm+\x27</span>\x27+
              \x27<span class="br-orch-emoji" id="brOrchEmoji">\x27+orchEmoji2+\x27</span>\x27+
              \x27</div>\x27+
              \x27<div class="br-orch-label">Orchestratore</div>\x27+
              \x27</div>\x27;

            // ── Conference table SVG — rich walnut with real objects ────────────
            var tblSvg = \x27<svg viewBox="0 0 1000 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:50%;left:0;width:100%;height:140px;transform:translateY(-50%);z-index:1;pointer-events:none">\x27+
              \x27<defs>\x27+
              \x27<linearGradient id="tblGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b4423"/><stop offset="0.4" stop-color="#4a2e12"/><stop offset="1" stop-color="#2e1a08"/></linearGradient>\x27+
              \x27<linearGradient id="tblSheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(255,255,255,0)"/><stop offset="0.3" stop-color="rgba(255,255,255,.04)"/><stop offset="0.7" stop-color="rgba(255,255,255,.06)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></linearGradient>\x27+
              \x27</defs>\x27+
              // Shadow
              \x27<rect x="6" y="10" width="988" height="178" rx="22" fill="rgba(0,0,0,.28)"/>\x27+
              // Table body
              \x27<rect x="0" y="2" width="1000" height="178" rx="20" fill="url(#tblGrad)"/>\x27+
              // Wood grain lines
              \x27<line x1="0" y1="48" x2="1000" y2="48" stroke="rgba(0,0,0,.07)" stroke-width="2"/>\x27+
              \x27<line x1="0" y1="96" x2="1000" y2="96" stroke="rgba(0,0,0,.09)" stroke-width="2.5"/>\x27+
              \x27<line x1="0" y1="144" x2="1000" y2="144" stroke="rgba(0,0,0,.07)" stroke-width="2"/>\x27+
              // Sheen
              \x27<rect x="0" y="2" width="1000" height="178" rx="20" fill="url(#tblSheen)"/>\x27+
              // Top edge highlight
              \x27<rect x="0" y="2" width="1000" height="6" rx="4" fill="rgba(255,255,255,.1)"/>\x27+
              // NHA monogram
              \x27<text x="500" y="118" text-anchor="middle" font-family="system-ui" font-size="58" font-weight="900" fill="rgba(160,140,255,.09)" letter-spacing="10">NHA</text>\x27+
              // Laptop 1
              \x27<rect x="155" y="55" width="68" height="46" rx="5" fill="#1a1a2e" stroke="#4a4a8a" stroke-width="2"/>\x27+
              \x27<rect x="160" y="59" width="58" height="34" rx="3" fill="#0d0d1a"/>\x27+
              \x27<rect x="162" y="61" width="54" height="30" rx="2" fill="#1e3a5f"/>\x27+
              \x27<rect x="148" y="101" width="82" height="5" rx="2" fill="#333"/>\x27+
              // Laptop 2
              \x27<rect x="770" y="55" width="68" height="46" rx="5" fill="#1a1a2e" stroke="#4a4a8a" stroke-width="2"/>\x27+
              \x27<rect x="775" y="59" width="58" height="34" rx="3" fill="#0d0d1a"/>\x27+
              \x27<rect x="777" y="61" width="54" height="30" rx="2" fill="#1e3a5f"/>\x27+
              \x27<rect x="763" y="101" width="82" height="5" rx="2" fill="#333"/>\x27+
              // Telephone with handset (center-left)
              \x27<rect x="360" y="62" width="52" height="38" rx="4" fill="#2a2a2a" stroke="#555" stroke-width="1.5"/>\x27+
              \x27<ellipse cx="366" cy="72" rx="6" ry="8" fill="#1a1a1a" stroke="#888" stroke-width="1"/>\x27+
              \x27<ellipse cx="406" cy="72" rx="6" ry="8" fill="#1a1a1a" stroke="#888" stroke-width="1"/>\x27+
              \x27<line x1="366" y1="72" x2="406" y2="72" stroke="#666" stroke-width="3" stroke-linecap="round"/>\x27+
              \x27<rect x="372" y="76" width="40" height="18" rx="2" fill="#333"/>\x27+
              // Coffee cup 1
              \x27<rect x="570" y="68" width="28" height="28" rx="4" fill="#f5f0e8" stroke="#c8b08a" stroke-width="1.5"/>\x27+
              \x27<rect x="575" y="73" width="18" height="15" rx="2" fill="#6b3a1f" opacity=".8"/>\x27+
              \x27<path d="M598 78 Q608 83 598 88" stroke="#c8b08a" stroke-width="2" fill="none"/>\x27+
              // Mini plant on table
              \x27<rect x="470" y="72" width="14" height="16" rx="2" fill="#8B6914"/>\x27+
              \x27<ellipse cx="477" cy="68" rx="10" ry="12" fill="#2d6a2d"/>\x27+
              \x27<ellipse cx="470" cy="65" rx="7" ry="9" fill="#3a8a3a"/>\x27+
              \x27<ellipse cx="484" cy="65" rx="7" ry="9" fill="#2d7a2d"/>\x27+
              \x27</svg>\x27;

            // ── Background SVG — enhanced room with art, detailed door, windows ─
            var bgSvg = \x27<svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none">\x27+
              \x27<defs>\x27+
              \x27<filter id="brGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>\x27+
              \x27<filter id="brShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,.2)"/></filter>\x27+
              \x27<linearGradient id="brWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5f0e8"/><stop offset="1" stop-color="#e8e0d0"/></linearGradient>\x27+
              \x27<linearGradient id="winGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8dff8"/><stop offset="1" stop-color="#d8f0ff"/></linearGradient>\x27+
              \x27<linearGradient id="doorGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a0724a"/><stop offset="0.5" stop-color="#c8905c"/><stop offset="1" stop-color="#a0724a"/></linearGradient>\x27+
              \x27</defs>\x27+
              // Wall
              \x27<rect x="0" y="0" width="1000" height="215" fill="url(#brWall)"/>\x27+
              // Crown molding
              \x27<rect x="0" y="0" width="1000" height="8" fill="#d8cfc0"/>\x27+
              \x27<rect x="0" y="8" width="1000" height="4" fill="#e8e0d0"/>\x27+
              // Baseboard
              \x27<rect x="0" y="206" width="1000" height="9" fill="#c8b898" rx="1"/>\x27+
              \x27<rect x="0" y="210" width="1000" height="3" fill="#b0a080"/>\x27+
              // Parquet floor
              function() {
                var s3 = \x27\x27;
                var pC = [\x27#c8a06a\x27,\x27#bf9860\x27,\x27#d4aa72\x27,\x27#ba9458\x27,\x27#caa86e\x27];
                var pH3 = 32; var pW3 = 120;
                for (var fy3 = 215; fy3 < 600+pH3; fy3 += pH3) {
                  var ro4 = (Math.floor((fy3-215)/pH3) % 2) * (pW3/2);
                  for (var fx3 = -pW3+ro4; fx3 < 1000+pW3; fx3 += pW3) {
                    var pc4 = pC[Math.abs(Math.round(fx3/pW3+fy3/pH3*1.3)) % pC.length];
                    s3 += \x27<rect x="\x27+Math.round(fx3)+\x27" y="\x27+fy3+\x27" width="\x27+(pW3-2)+\x27" height="\x27+(pH3-2)+\x27" fill="\x27+pc4+\x27" rx="2"/>\x27;
                    s3 += \x27<line x1="\x27+Math.round(fx3+pW3*.4)+\x27" y1="\x27+fy3+\x27" x2="\x27+Math.round(fx3+pW3*.4)+\x27" y2="\x27+(fy3+pH3-2)+\x27" stroke="rgba(0,0,0,.04)" stroke-width="1.5"/>\x27;
                  }
                }
                return s3;
              }()+
              // Window LEFT — thick frame, venetian blinds effect
              \x27<rect x="28" y="18" width="126" height="96" rx="3" fill="#4a6080" stroke="#2a3a50" stroke-width="4"/>\x27+
              \x27<rect x="34" y="24" width="114" height="84" rx="2" fill="url(#winGrad)"/>\x27+
              \x27<rect x="34" y="24" width="114" height="84" rx="2" fill="rgba(255,255,255,.12)"/>\x27+
              \x27<line x1="91" y1="24" x2="91" y2="108" stroke="#3a5070" stroke-width="3"/>\x27+
              \x27<line x1="34" y1="66" x2="148" y2="66" stroke="#3a5070" stroke-width="3"/>\x27+
              // window sill
              \x27<rect x="22" y="114" width="138" height="8" rx="2" fill="#c8b898"/>\x27+
              // Window RIGHT
              \x27<rect x="846" y="18" width="126" height="96" rx="3" fill="#4a6080" stroke="#2a3a50" stroke-width="4"/>\x27+
              \x27<rect x="852" y="24" width="114" height="84" rx="2" fill="url(#winGrad)"/>\x27+
              \x27<rect x="852" y="24" width="114" height="84" rx="2" fill="rgba(255,255,255,.12)"/>\x27+
              \x27<line x1="909" y1="24" x2="909" y2="108" stroke="#3a5070" stroke-width="3"/>\x27+
              \x27<line x1="852" y1="66" x2="966" y2="66" stroke="#3a5070" stroke-width="3"/>\x27+
              \x27<rect x="840" y="114" width="138" height="8" rx="2" fill="#c8b898"/>\x27+
              // Door CENTER — detailed with panels and handle
              \x27<rect x="455" y="0" width="90" height="215" fill="url(#doorGrad)" stroke="#7a5030" stroke-width="3"/>\x27+
              // Door panels
              \x27<rect x="463" y="10" width="74" height="55" rx="3" fill="rgba(0,0,0,.08)" stroke="rgba(0,0,0,.15)" stroke-width="1.5"/>\x27+
              \x27<rect x="463" y="72" width="74" height="55" rx="3" fill="rgba(0,0,0,.08)" stroke="rgba(0,0,0,.15)" stroke-width="1.5"/>\x27+
              \x27<rect x="463" y="134" width="74" height="55" rx="3" fill="rgba(0,0,0,.06)" stroke="rgba(0,0,0,.12)" stroke-width="1.5"/>\x27+
              // Door handle
              \x27<circle cx="533" cy="118" r="7" fill="#c8a040" stroke="#a07828" stroke-width="2"/>\x27+
              \x27<rect x="530" y="118" width="14" height="4" rx="2" fill="#c8a040" stroke="#a07828" stroke-width="1"/>\x27+
              // Door frame
              \x27<rect x="451" y="0" width="5" height="215" fill="#7a5030"/>\x27+
              \x27<rect x="544" y="0" width="5" height="215" fill="#7a5030"/>\x27+
              // Painting LEFT — abstract NHA art
              \x27<rect x="190" y="18" width="100" height="76" rx="3" fill="#f8f4ee" stroke="#8a7050" stroke-width="4" filter="url(#brShadow)"/>\x27+
              \x27<rect x="196" y="24" width="88" height="64" rx="1" fill="#1a1060"/>\x27+
              \x27<circle cx="240" cy="56" r="22" fill="#6366f1" opacity=".7"/>\x27+
              \x27<circle cx="240" cy="56" r="14" fill="#818cf8" opacity=".8"/>\x27+
              \x27<circle cx="240" cy="56" r="6" fill="#c7d2fe"/>\x27+
              \x27<text x="240" y="60" text-anchor="middle" font-size="10" font-weight="900" fill="white" font-family="system-ui">NHA</text>\x27+
              // Painting RIGHT — landscape
              \x27<rect x="710" y="18" width="110" height="76" rx="3" fill="#f8f4ee" stroke="#8a7050" stroke-width="4" filter="url(#brShadow)"/>\x27+
              \x27<rect x="716" y="24" width="98" height="64" rx="1" fill="#87CEEB"/>\x27+
              \x27<ellipse cx="765" cy="65" rx="48" ry="20" fill="#228B22"/>\x27+
              \x27<circle cx="748" cy="52" rx="14" ry="14" fill="#ffed4a" opacity=".9"/>\x27+
              \x27<ellipse cx="730" cy="62" rx="12" ry="16" fill="#1a5c1a"/>\x27+
              \x27<ellipse cx="780" cy="60" rx="10" ry="14" fill="#2a7a2a"/>\x27+
              // Chandelier
              \x27<line x1="500" y1="0" x2="500" y2="28" stroke="#aaa" stroke-width="4"/>\x27+
              \x27<ellipse cx="500" cy="36" rx="52" ry="14" fill="#f0d830" stroke="#c8a820" stroke-width="3"/>\x27+
              \x27<ellipse cx="500" cy="36" rx="45" ry="10" fill="#ffe850" opacity=".5"/>\x27+
              \x27<circle cx="470" cy="47" r="9" fill="#fffce0" filter="url(#brGlow)"/>\x27+
              \x27<circle cx="500" cy="50" r="9" fill="#fffce0" filter="url(#brGlow)"/>\x27+
              \x27<circle cx="530" cy="47" r="9" fill="#fffce0" filter="url(#brGlow)"/>\x27+
              \x27<circle cx="455" cy="40" r="6" fill="#ffe060" filter="url(#brGlow)"/>\x27+
              \x27<circle cx="545" cy="40" r="6" fill="#ffe060" filter="url(#brGlow)"/>\x27+
              \x27<polygon points="448,62 552,62 680,600 320,600" fill="rgba(255,252,180,.07)"/>\x27+
              // Cross-agent conversation lines overlay placeholder (updated dynamically)
              \x27<g id="brConvLines"></g>\x27+
              \x27</svg>\x27;

            var headerHtml = \x27<div class="br-header">\x27+
              \x27<span class="br-phase-chip" id="brPhaseChip"></span>\x27+
              \x27<div class="br-progress-wrap" id="brProgressWrap"><div class="br-progress-bar" id="brProgressBar"></div></div>\x27+
              \x27</div>\x27;

            var convergeHtml = \x27<div class="br-convergence" id="brConvergence" style="display:none"></div>\x27;

            pb.innerHTML =
              \x27<div class="br-wrap">\x27+
              headerHtml+
              \x27<div class="br-room">\x27+
              bgSvg+
              // Decorative plants at corners
              \x27<div style="position:absolute;bottom:8px;left:10px;font-size:44px;z-index:5;filter:drop-shadow(0 3px 8px rgba(0,0,0,.3))">\x27+String.fromCodePoint(0x1FAB4)+\x27</div>\x27+
              \x27<div style="position:absolute;bottom:8px;right:10px;font-size:44px;z-index:5;filter:drop-shadow(0 3px 8px rgba(0,0,0,.3))">\x27+String.fromCodePoint(0x1FAB4)+\x27</div>\x27+
              // Small plants on window sills
              \x27<div style="position:absolute;top:112px;left:58px;font-size:20px;z-index:5">\x27+String.fromCodePoint(0x1F331)+\x27</div>\x27+
              \x27<div style="position:absolute;top:112px;right:58px;font-size:20px;z-index:5">\x27+String.fromCodePoint(0x1F331)+\x27</div>\x27+
              // Cross-agent communication SVG overlay (dynamic, updated per call)
              \x27<svg id="brCommSvg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:20;overflow:visible"></svg>\x27+
              \x27<div style="position:relative;z-index:10;display:flex;flex-direction:column;justify-content:center;min-height:480px;padding:20px 16px;gap:0;box-sizing:border-box">\x27+
              \x27<div class="br-seats-row">\x27+topHtml+\x27</div>\x27+
              \x27<div style="position:relative;display:flex;align-items:center;width:100%;min-height:160px">\x27+
              orchHeadHtml+
              \x27<div style="position:relative;flex:1;min-height:140px">\x27+tblSvg+\x27</div>\x27+
              \x27</div>\x27+
              \x27<div class="br-seats-row">\x27+botHtml+\x27</div>\x27+
              \x27</div>\x27+
              \x27</div>\x27+
              convergeHtml+
              \x27</div>\x27;
          }

          // ── Update state (runs every call, including initial build) ──────────

          // Phase chip
          var chipEl = document.getElementById(\x27brPhaseChip\x27);
          if (chipEl) { chipEl.textContent = phaseLabel; chipEl.style.setProperty(\x27--pc\x27, phaseColor); }

          // Progress bar
          var pbBar = document.getElementById(\x27brProgressBar\x27);
          if (pbBar) pbBar.style.width = progressPct + \x27%\x27;
          var pbWrap = document.getElementById(\x27brProgressWrap\x27);
          if (pbWrap) pbWrap.style.display = convergence != null ? \x27none\x27 : \x27\x27;

          // Convergence
          var convEl = document.getElementById(\x27brConvergence\x27);
          if (convEl && convergence != null) {
            convEl.style.display = \x27block\x27;
            convEl.innerHTML = \x27<div class="br-conv-bar-outer"><div class="br-conv-bar-inner" style="width:\x27+Math.min(convergence,100)+\x27%"></div></div>\x27+
              \x27<div class="br-conv-text"><strong>\u2714 Convergenza: \x27+convergence+\x27%</strong> \u2014 Il Consiglio ha raggiunto il consenso. HERALD ha sintetizzato il risultato finale.</div>\x27;
          }

          // Orchestrator speech bubble
          var orchSpeech = document.getElementById(\x27brOrchSpeech\x27);
          if (orchSpeech) {
            var orchSpeeches = {
              r1: [\x27Analisi in corso...\x27,\x27Ogni team al lavoro\x27,\x27Raccolta dati\x27,\x27Prima bozza...\x27],
              r2: [\x27Confronto in corso\x27,\x27Cross-review...\x27,\x27Raffinamento\x27,\x27Scambio idee\x27],
              r3: [\x27Sintesi finale\x27,\x27Convergenza...\x27,\x27Accordo in vista\x27],
              done: [\x27Consiglio concluso\x27,\x27Consenso raggiunto\x27,\x27Report pronto\x27]
            };
            var spArr = orchSpeeches[phase] || orchSpeeches.r1;
            if (phase === \x27done\x27) {
              orchSpeech.style.display = \x27none\x27;
            } else {
              orchSpeech.style.display = \x27\x27;
              // Rotate through phrases based on progress
              orchSpeech.textContent = spArr[doneCount % spArr.length];
              orchSpeech.style.borderColor = \x27#374151\x27;
              orchSpeech.style.color = \x27#000000\x27;
              orchSpeech.style.fontWeight = \x27700\x27;
            }
          }

          // Orchestrator animation class
          var orchEl = document.getElementById(\x27brOrch\x27);
          if (orchEl) {
            orchEl.className = \x27br-orch\x27 + (phase===\x27done\x27 ? \x27 br-orch--done\x27 : \x27 br-orch--active\x27);
            orchEl.style.setProperty(\x27--oc\x27, phaseColor);
          }

          // ── Update each agent seat state ────────────────────────────────────
          proposals.forEach(function(prop) {
            var lbl = prop.label || prop.agent;
            var safeLbl = lbl.replace(/[^a-zA-Z0-9_-]/g,\x27_\x27);
            var seatEl = document.getElementById(\x27brseat_\x27+safeLbl);
            var bubbleEl = document.getElementById(\x27brbubble_\x27+safeLbl);
            var nameEl = document.getElementById(\x27brname_\x27+safeLbl);
            var charEl = document.getElementById(\x27brchar_\x27+safeLbl);
            var isDone = !!parlDoneAgents[lbl];
            var isActive = lbl === activeLabel;

            if (seatEl) {
              seatEl.className = \x27br-seat\x27 +
                (isActive ? \x27 br-seat--active\x27 : \x27\x27) +
                (isDone ? \x27 br-seat--done\x27 : \x27\x27);
              seatEl.style.setProperty(\x27--sc\x27, phaseColor);
            }
            // Character animation: bob when active
            if (charEl) {
              charEl.style.animation = isActive ? \x27brCharBob .8s ease-in-out infinite\x27 : \x27\x27;
              charEl.style.filter = isActive
                ? (\x27drop-shadow(0 0 12px \x27+phaseColor+\x27)\x27)
                : (isDone ? \x27none\x27 : \x27grayscale(.4)\x27);
            }
            if (bubbleEl) {
              var actionStr2 = \x27\x27;
              if (phase===\x27r1\x27 && isActive) actionStr2 = \x27...analizza\x27;
              else if (phase===\x27r1\x27 && isDone) actionStr2 = \x27\u2714 bozza pronta\x27;
              else if (phase===\x27r2\x27 && isActive) actionStr2 = \x27...legge proposte\x27;
              else if (phase===\x27r2\x27 && isDone) actionStr2 = \x27\u2714 raffinato\x27;
              else if (phase===\x27r3\x27 && isActive) actionStr2 = \x27...media\x27;
              else if (phase===\x27done\x27) actionStr2 = \x27\u2714 consenso\x27;
              else if (!isActive && !isDone && phase===\x27r2\x27) actionStr2 = \x27legge...\x27;
              else if (!isActive && !isDone) actionStr2 = \x27in attesa\x27;
              bubbleEl.textContent = actionStr2;
              bubbleEl.style.display = actionStr2 ? \x27\x27 : \x27none\x27;
              bubbleEl.style.borderColor = isActive ? phaseColor : (isDone ? \x27rgba(0,0,0,.25)\x27 : \x27rgba(0,0,0,.15)\x27);
              bubbleEl.style.color = isActive ? \x27#000000\x27 : (isDone ? \x27#111827\x27 : \x27#6b7280\x27);
              bubbleEl.style.background = isActive ? \x27rgba(255,255,255,.95)\x27 : \x27rgba(255,255,255,.82)\x27;
              bubbleEl.style.fontWeight = isActive ? \x27700\x27 : \x27500\x27;
            }
            if (nameEl) {
              nameEl.style.color = isDone ? \x27#111827\x27 : (isActive ? \x27#000000\x27 : \x27#374151\x27);
              nameEl.style.fontWeight = isActive ? \x27800\x27 : \x27600\x27;
            }
          });

          // ── Cross-agent communication lines (R2/R3 only) ────────────────────
          // In R2: show lines from active agent to all done agents (cross-reading)
          // In R1/done: show orch→active line only
          var commSvg = document.getElementById(\x27brCommSvg\x27);
          var brRoom2 = commSvg ? commSvg.closest(\x27.br-room\x27) : null;
          if (commSvg && brRoom2) {
            commSvg.innerHTML = \x27\x27;
            var roomRect2 = brRoom2.getBoundingClientRect();
            var ns = \x27http://www.w3.org/2000/svg\x27;

            function addCommLine(fromEl, toEl, color, dash, width, opacity, anim) {
              if (!fromEl || !toEl) return;
              var fr = fromEl.getBoundingClientRect();
              var tr = toEl.getBoundingClientRect();
              var lx1 = Math.round(fr.left + fr.width/2 - roomRect2.left);
              var ly1 = Math.round(fr.top + fr.height/2 - roomRect2.top);
              var lx2 = Math.round(tr.left + tr.width/2 - roomRect2.left);
              var ly2 = Math.round(tr.top + tr.height/2 - roomRect2.top);
              // Bezier curve for elegance
              var mx = (lx1+lx2)/2; var my = Math.min(ly1,ly2) - 30;
              var path = document.createElementNS(ns, \x27path\x27);
              path.setAttribute(\x27d\x27, \x27M\x27+lx1+\x27,\x27+ly1+\x27 Q\x27+mx+\x27,\x27+my+\x27 \x27+lx2+\x27,\x27+ly2);
              path.setAttribute(\x27stroke\x27, color);
              path.setAttribute(\x27stroke-width\x27, String(width||2));
              path.setAttribute(\x27stroke-dasharray\x27, dash||\x27\x27);
              path.setAttribute(\x27fill\x27, \x27none\x27);
              path.setAttribute(\x27opacity\x27, String(opacity||.6));
              if (anim) path.style.animation = anim;
              // Arrow marker at end
              var mk = document.createElementNS(ns, \x27marker\x27);
              var mkId = \x27arr\x27+Math.random().toString(36).slice(2,6);
              mk.setAttribute(\x27id\x27, mkId);
              mk.setAttribute(\x27markerWidth\x27,\x278\x27);mk.setAttribute(\x27markerHeight\x27,\x276\x27);
              mk.setAttribute(\x27refX\x27,\x278\x27);mk.setAttribute(\x27refY\x27,\x273\x27);
              mk.setAttribute(\x27orient\x27,\x27auto\x27);
              var poly = document.createElementNS(ns,\x27polygon\x27);
              poly.setAttribute(\x27points\x27,\x270 0, 8 3, 0 6\x27);
              poly.setAttribute(\x27fill\x27, color);
              mk.appendChild(poly);
              var defs2 = document.createElementNS(ns,\x27defs\x27);
              defs2.appendChild(mk);
              commSvg.appendChild(defs2);
              path.setAttribute(\x27marker-end\x27,\x27url(#\x27+mkId+\x27)\x27);
              commSvg.appendChild(path);
              // Floating emoji dot on path midpoint
              var dot = document.createElementNS(ns, \x27text\x27);
              dot.setAttribute(\x27x\x27, String(Math.round(mx)));
              dot.setAttribute(\x27y\x27, String(Math.round(my-8)));
              dot.setAttribute(\x27text-anchor\x27, \x27middle\x27);
              dot.setAttribute(\x27font-size\x27, \x2714\x27);
              dot.textContent = phase===\x27r2\x27 ? String.fromCodePoint(0x1F4AC) : (phase===\x27r3\x27 ? String.fromCodePoint(0x1F91D) : String.fromCodePoint(0x1F4E8));
              dot.style.animation = \x27brDotFloat 1.5s ease-in-out infinite\x27;
              commSvg.appendChild(dot);
            }

            var orchEl2 = document.getElementById(\x27brOrch\x27);
            if (phase === \x27done\x27) {
              // All done: show web of solid connections between all agents
              proposals.forEach(function(pa, ia) {
                proposals.forEach(function(pb2, ib2) {
                  if (ib2 <= ia) return;
                  var ea = document.getElementById(\x27brseat_\x27+pa.label.replace(/[^a-zA-Z0-9_-]/g,\x27_\x27));
                  var eb = document.getElementById(\x27brseat_\x27+pb2.label.replace(/[^a-zA-Z0-9_-]/g,\x27_\x27));
                  addCommLine(ea, eb, \x27#111827\x27, \x274 3\x27, 2, 0.9, \x27\x27);
                });
              });
            } else if (activeLabel) {
              var aLblSafe2 = activeLabel.replace(/[^a-zA-Z0-9_-]/g,\x27_\x27);
              var activeSeatEl2 = document.getElementById(\x27brseat_\x27+aLblSafe2);
              // Orch → active agent: thick black dashed animated line
              addCommLine(orchEl2, activeSeatEl2, \x27#111827\x27, \x276 4\x27, 3, 1, \x27brDashFlow 1s linear infinite\x27);
              // R2/R3: done agents → active agent: dark grey dashed
              if (phase === \x27r2\x27 || phase === \x27r3\x27) {
                proposals.forEach(function(pp2) {
                  var doneL = pp2.label || pp2.agent;
                  if (doneL === activeLabel) return;
                  if (!parlDoneAgents[doneL]) return;
                  var doneSeat = document.getElementById(\x27brseat_\x27+doneL.replace(/[^a-zA-Z0-9_-]/g,\x27_\x27));
                  addCommLine(doneSeat, activeSeatEl2, \x27#374151\x27, \x275 3\x27, 2.5, 1, \x27brDashFlow 1.4s linear infinite\x27);
                });
              }
            }
          }

          // Persist across tab navigations
          if (pb.innerHTML && pb.innerHTML.length < 60000) { _parlPersistHtml = _PARL_STAMP + pb.innerHTML; }

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
                      studioLog(r2Label, \x27&#x1f4bc;\x27, \x27\x27, \x27agent\x27, false);
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
                      // Mirror live token to the active agent boardroom bubble
                      if (parlActiveAgent) {
                        var brSafe2 = parlActiveAgent.replace(new RegExp(\x27[^a-zA-Z0-9_-]\x27,\x27g\x27),\x27_\x27);
                        var brLiveBubble = document.getElementById(\x27brbubble_\x27+brSafe2);
                        if (brLiveBubble) {
                          var rawTok = dev.token.replace(new RegExp(\x27[\\r\\n]+\x27,\x27g\x27),\x27 \x27);
                          var safeTok = rawTok.replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                          var truncTok = rawTok.length > 60 ? rawTok.slice(-60) : rawTok;
                          var safeTrunc = truncTok.replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                          brLiveBubble.style.display = \x27\x27;
                          brLiveBubble.innerHTML = safeTrunc + \x27<span style="display:inline-block;width:2px;height:8px;background:var(--green);margin-left:1px;vertical-align:text-bottom;animation:streamBlink .7s step-end infinite">&#8203;</span>\x27;
                          brLiveBubble.style.borderColor = \x27#6366f1\x27;
                          brLiveBubble.style.color = \x27#a5b4fc\x27;
                        }
                      }
                    }
                  } else if (dev.deliberation_r2) {
                    var r2d = dev.deliberation_r2;
                    studioLog(r2d.label || r2d.agent, \x27&#x1f4bc;\x27, \x27[Consiglio R2] \x27 + (r2d.output || \x27\x27), \x27agent\x27, true);
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
                    var r3label = dev.deliberation_r3.converged ? \x27[Sintesi Consiglio] \x27 : \x27[Mediazione] \x27;
                    studioLog(\x27HERALD\x27, \x27&#128295;\x27, r3label + (dev.deliberation_r3.output || \x27\x27), \x27system\x27, true);
                    studioAddTokens(0, Math.ceil((dev.deliberation_r3.output||'').length / 4));
                    context = dev.deliberation_r3.output || context;
                  } else if (dev.deliberation_done) {
                    var r2Conv = Math.round((dev.r2_convergence || 0) * 100);
                    studioLog(\x27Consiglio\x27, \x27&#x1f4bc;\x27, \x27Consiglio concluso — convergenza R2: \x27 + r2Conv + \x27%\x27, \x27system\x27);
                    if (dev.mediation) { context = dev.mediation; }
                    renderParlBlock(\x27done\x27, null, r2Conv);
                    if (studioState.nodes[parlNodeIdx]) {
                      studioState.nodes[parlNodeIdx].status = \x27done\x27;
                      studioState.nodes[parlNodeIdx].label = \x27Consiglio (\x27 + r2Conv + \x27%)\x27;
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
            studioLog(\x27Consiglio\x27, \x27&#x1f4bc;\x27, \x27Consiglio non disponibile: \x27 + (e3.message || String(e3)), \x27error\x27);
            // Do NOT hide the parliament block if it already has content — user is watching it
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
        _parlPersistHtml = _PARL_STAMP + parlFinal.innerHTML; // persist so tab nav doesn't lose it
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
    // Save parliament as compact node list — NOT raw HTML (too large, gets truncated)
    var parlEl = document.getElementById('studioParliamentBlock');
    var hasParl = parlEl && parlEl.style.display !== 'none' && parlEl.innerHTML.length > 200;
    // Derive parliament nodes from workflow nodes (exclude Canvas/tool-only agents)
    var parlNodes = hasParl ? nodes
      .filter(function(n){ return n.agent !== 'CanvasAgent' && n.agent !== 'GitHubAgent' && n.agent !== 'EmailAgent' && n.agent !== 'CalendarAgent'; })
      .map(function(n){ return {label:n.label,agent:n.agent,icon:n.icon}; })
      : null;
    // Extract r2Conv from the Consiglio node label e.g. "Consiglio (72%)"
    var r2Conv = 0;
    if (hasParl) {
      var parlNode = nodes.find(function(n){ return n.agent === 'Consiglio'; });
      if (parlNode && parlNode.label) {
        var cm = parlNode.label.match(/\((\d+)%\)/);
        if (cm) r2Conv = parseInt(cm[1], 10);
      }
    }
    sessions.unshift({
      id: Date.now(),
      task: task,
      nodes: nodes.map(function(n){return {label:n.label,icon:n.icon,agent:n.agent,output:n.output||''};}),
      result: result,
      canvas: studioState.canvas || null,
      parlNodes: parlNodes,
      parlR2Conv: r2Conv,
      log: log.map(function(e){return {agent:e.agent,icon:e.icon,text:e.text,type:e.type,time:e.time};}),
      ts: new Date().toLocaleString()
    });
    sessions = sessions.slice(0, 10); // keep last 10 (save space)
    try {
      localStorage.setItem('nha_studio_sessions', JSON.stringify(sessions));
    } catch(qe) {
      // Quota exceeded: save without canvas/parlHtml
      sessions[0].canvas = null; sessions[0].parlHtml = null;
      try { localStorage.setItem('nha_studio_sessions', JSON.stringify(sessions)); } catch(e2) {}
    }
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
  el.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<span style="font-size:11px;font-weight:700;color:#f8fafc;text-transform:uppercase;letter-spacing:.8px">' + t('recent_sessions') + '</span>' +
      '<span style="font-size:10px;color:#94a3b8">' + sessions.length + ' saved</span>' +
    '</div>' +
    '<div style="max-height:240px;overflow-y:auto;padding-right:2px;display:flex;flex-direction:column;gap:6px">' +
    sessions.map(function(s,i) {
      return '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 12px">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:7px">' +
          '<span style="font-size:11px;color:#f1f5f9;font-weight:600;line-height:1.4;flex:1">' + esc(s.task.slice(0,65)) + (s.task.length>65?'...':'') + '</span>' +
          '<button onclick="deleteStudioSession('+i+')" style="flex-shrink:0;font-size:14px;line-height:1;background:none;border:none;color:#64748b;cursor:pointer;padding:0 2px" title="Delete">&times;</button>' +
        '</div>' +
        '<div style="font-size:10px;color:#64748b;margin-bottom:8px">' + esc(s.ts) + '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<button onclick="restoreStudioSession('+i+')" style="font-size:10px;font-weight:600;padding:4px 10px;background:#0ea5e9;border:none;border-radius:5px;color:#fff;cursor:pointer">Restore</button>' +
          '<button onclick="importStudioToChat('+i+')" style="font-size:10px;font-weight:600;padding:4px 10px;background:#334155;border:1px solid #475569;border-radius:5px;color:#cbd5e1;cursor:pointer">Send to Chat</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
}

// Renders the parliament boardroom in "done" state from a compact node list.
// Used by restoreStudioSession — independent of the runStudio closure.
function renderParlBlockStatic(parlNodes, r2Conv) {
  var pb = document.getElementById('studioParliamentBlock');
  if (!pb || !parlNodes || parlNodes.length < 1) return;
  pb.style.display = 'block';

  var proposals2 = parlNodes;
  var crownEm = String.fromCodePoint(0x1F451);
  var orchEmoji2 = String.fromCodePoint(0x1F9D1,0x200D,0x1F4BC);

  function buildSeat2(prop) {
    var lbl = prop.label || prop.agent;
    var safeLbl = lbl.replace(/[^a-zA-Z0-9_-]/g,'_');
    var emojiIdx = Math.abs(lbl.charCodeAt(0)+(lbl.charCodeAt(lbl.length-1)||0)) % AGENT_EMOJIS.length;
    var agentEmoji = AGENT_EMOJIS[emojiIdx];
    return '<div class="br-seat" id="brseat_'+safeLbl+'" data-lbl="'+esc(lbl)+'">' +
      '<div class="br-char" style="font-size:40px;filter:none">'+agentEmoji+'</div>' +
      '<div class="br-seat-name">'+esc(lbl)+'</div>' +
      '</div>';
  }

  var topSeats2 = []; var botSeats2 = [];
  proposals2.forEach(function(p,i){ if(i%2===0) topSeats2.push(p); else botSeats2.push(p); });

  var tblSvg2 = '<svg viewBox="0 0 1000 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:50%;left:0;width:100%;height:140px;transform:translateY(-50%);z-index:1;pointer-events:none">' +
    '<defs><linearGradient id="tblGrad2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b4423"/><stop offset="0.4" stop-color="#4a2e12"/><stop offset="1" stop-color="#2e1a08"/></linearGradient></defs>' +
    '<rect x="6" y="10" width="988" height="178" rx="22" fill="rgba(0,0,0,.28)"/>' +
    '<rect x="0" y="2" width="1000" height="178" rx="20" fill="url(#tblGrad2)"/>' +
    '<text x="500" y="118" text-anchor="middle" font-family="system-ui" font-size="58" font-weight="900" fill="rgba(160,140,255,.09)" letter-spacing="10">NHA</text>' +
    '</svg>';

  var bgSvg2 = '<svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none">' +
    '<defs>' +
    '<linearGradient id="brWall2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5f0e8"/><stop offset="1" stop-color="#e8e0d0"/></linearGradient>' +
    '<linearGradient id="winGrad2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8dff8"/><stop offset="1" stop-color="#d8f0ff"/></linearGradient>' +
    '<linearGradient id="doorGrad2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a0724a"/><stop offset="0.5" stop-color="#c8905c"/><stop offset="1" stop-color="#a0724a"/></linearGradient>' +
    '</defs>' +
    '<rect x="0" y="0" width="1000" height="215" fill="url(#brWall2)"/>' +
    '<rect x="0" y="0" width="1000" height="8" fill="#d8cfc0"/>' +
    '<rect x="0" y="206" width="1000" height="9" fill="#c8b898" rx="1"/>' +
    (function(){ var s=''; var pC=['#c8a06a','#bf9860','#d4aa72','#ba9458','#caa86e']; for(var fy=215;fy<600+32;fy+=32){var ro=(Math.floor((fy-215)/32)%2)*60; for(var fx=-120+ro;fx<1000+120;fx+=120){var pc=pC[Math.abs(Math.round(fx/120+fy/32*1.3))%pC.length]; s+='<rect x="'+Math.round(fx)+'" y="'+fy+'" width="118" height="30" fill="'+pc+'" rx="2"/>';}} return s; }()) +
    '<rect x="28" y="18" width="126" height="96" rx="3" fill="#4a6080" stroke="#2a3a50" stroke-width="4"/>' +
    '<rect x="34" y="24" width="114" height="84" rx="2" fill="url(#winGrad2)"/>' +
    '<rect x="846" y="18" width="126" height="96" rx="3" fill="#4a6080" stroke="#2a3a50" stroke-width="4"/>' +
    '<rect x="852" y="24" width="114" height="84" rx="2" fill="url(#winGrad2)"/>' +
    '<rect x="455" y="0" width="90" height="215" fill="url(#doorGrad2)" stroke="#7a5030" stroke-width="3"/>' +
    '<line x1="500" y1="0" x2="500" y2="28" stroke="#aaa" stroke-width="4"/>' +
    '<ellipse cx="500" cy="36" rx="52" ry="14" fill="#f0d830" stroke="#c8a820" stroke-width="3"/>' +
    '<circle cx="470" cy="47" r="9" fill="#fffce0"/><circle cx="500" cy="50" r="9" fill="#fffce0"/><circle cx="530" cy="47" r="9" fill="#fffce0"/>' +
    '</svg>';

  var convPct = r2Conv || 0;
  pb.innerHTML =
    '<div class="br-wrap">' +
    '<div class="br-header"><span class="br-phase-chip" style="--pc:#22c55e">Consiglio concluso — convergenza ' + convPct + '%</span></div>' +
    '<div class="br-room">' +
    bgSvg2 +
    '<div style="position:absolute;bottom:8px;left:10px;font-size:44px;z-index:5">' + String.fromCodePoint(0x1FAB4) + '</div>' +
    '<div style="position:absolute;bottom:8px;right:10px;font-size:44px;z-index:5">' + String.fromCodePoint(0x1FAB4) + '</div>' +
    '<div style="position:relative;z-index:10;display:flex;flex-direction:column;justify-content:center;min-height:480px;padding:20px 16px;gap:0;box-sizing:border-box">' +
    '<div class="br-seats-row">' + topSeats2.map(buildSeat2).join('') + '</div>' +
    '<div style="position:relative;display:flex;align-items:center;width:100%;min-height:160px">' +
    '<div class="br-orch" id="brOrch"><div class="br-orch-inner"><span class="br-orch-crown">' + crownEm + '</span><span class="br-orch-emoji">' + orchEmoji2 + '</span></div><div class="br-orch-label">Orchestratore</div></div>' +
    '<div style="position:relative;flex:1;min-height:140px">' + tblSvg2 + '</div>' +
    '</div>' +
    '<div class="br-seats-row">' + botSeats2.map(buildSeat2).join('') + '</div>' +
    '</div>' +
    '</div>' +
    '<div class="br-convergence" style="display:block">Consenso raggiunto — convergenza R2: <strong>' + convPct + '%</strong></div>' +
    '</div>';
}

function restoreStudioSession(idx) {
  var sessions = loadStudioSessions();
  var s = sessions[idx]; if (!s) return;
  studioState.task = s.task;
  studioState.nodes = s.nodes.map(function(n){return {icon:n.icon,agent:n.agent,label:n.label,output:n.output||'',status:'done'};});
  studioState.log = s.log;
  studioState.result = s.result;
  studioState.canvas = s.canvas || null;
  studioState.running = false;
  var ta = document.getElementById('studioTaskInput');
  if (ta) ta.value = s.task;
  renderStudioNodes(); renderStudioLog(); renderStudioResult();
  // Restore parliament block — rebuild from compact parlNodes (not raw HTML)
  var parlEl = document.getElementById('studioParliamentBlock');
  if (parlEl) {
    var parlNodes = s.parlNodes || null;
    // Legacy: old sessions might have parlHtml instead — ignore it (it was truncated)
    if (parlNodes && parlNodes.length >= 2) {
      renderParlBlockStatic(parlNodes, s.parlR2Conv || 0);
      setTimeout(function() {
        if (parlEl) parlEl.scrollIntoView({behavior: 'smooth', block: 'start'});
      }, 150);
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
                      // Strip surrounding brackets for display
                      var stLabel = st.replace(new RegExp(\x27^\\\\[\x27), \x27\x27).replace(new RegExp(\x27\\\\]\\\\s*$\x27), \x27\x27).trim();
                      // Special chip for Searching
                      var srchM = st.match(new RegExp(\x27^\\\\[Searching:\\\\s*"([^"]+)"\\\\]\\\\s*$\x27));
                      if (srchM) {
                        var qEsc = srchM[1].replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                        tb.innerHTML = \x27<span class="iso-status-chip"><span class="iso-status-dot"></span>&#128269; <span style="color:var(--dim)">Cercando</span> <strong style="color:#a5b4fc">\x27+qEsc+\x27</strong></span>\x27;
                      } else {
                        var stEsc = stLabel.replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                        tb.innerHTML = \x27<span class="iso-status-chip"><span class="iso-status-dot"></span>\x27+stEsc+\x27</span>\x27;
                      }
                    } else {
                      // Word-by-word streaming: APPEND new chars, never overwrite
                      var renderedLen = parseInt(tb.getAttribute(String.fromCharCode(100,97,116,97,45,114,108,101,110)) || \x270\x27, 10);
                      if (renderedLen === 0) {
                        // First token: set up container + cursor
                        tb.innerHTML = \x27\x27;
                        tb.setAttribute(String.fromCharCode(100,97,116,97,45,114,108,101,110), \x270\x27);
                        var streamSpan = document.createElement(\x27span\x27);
                        streamSpan.id = \x27streamText_\x27 + idx;
                        streamSpan.style.cssText = \x27font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:var(--font)\x27;
                        tb.appendChild(streamSpan);
                        var cursorEl = document.createElement(\x27span\x27);
                        cursorEl.id = \x27streamCursor_\x27 + idx;
                        cursorEl.style.cssText = \x27display:inline-block;width:2px;height:13px;background:var(--green);margin-left:1px;vertical-align:text-bottom;animation:streamBlink .7s step-end infinite\x27;
                        tb.appendChild(cursorEl);
                      }
                      // Append only newly arrived chars
                      var newChars = output.slice(renderedLen);
                      if (newChars.length > 0) {
                        var stEl = document.getElementById(\x27streamText_\x27 + idx);
                        if (stEl) { stEl.appendChild(document.createTextNode(newChars)); }
                        tb.setAttribute(String.fromCharCode(100,97,116,97,45,114,108,101,110), String(output.length));
                        // Keep studioState.log in sync so renderStudioLog() final call has current text
                        var logLen = studioState.log.length;
                        if (logLen > 0) { studioState.log[logLen - 1].text = output; }
                      }
                      // Update iso thought bubble of the active agent
                      var isoB = document.getElementById(\x27isobubble_\x27+idx);
                      if (isoB) {
                        // Show last ~6 complete words from the streaming output
                        var wfClean = output.replace(new RegExp(\x27[\\r\\n]+\x27, \x27g\x27), \x27 \x27).trim();
                        var wfWords = wfClean.split(\x27 \x27).filter(function(w){return w.length>0;});
                        var wfSnippet = wfWords.slice(-6).join(\x27 \x27);
                        if (wfSnippet.length > 52) wfSnippet = wfSnippet.slice(-52);
                        var wfSafe = wfSnippet.replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                        isoB.className = \x27iso-bubble iso-bubble--active\x27;
                        isoB.style.visibility = \x27visible\x27;
                        isoB.style.color = \x27#000000\x27;
                        isoB.style.fontWeight = \x27700\x27;
                        isoB.style.background = \x27#ffffff\x27;
                        isoB.innerHTML = wfSafe + \x27<span style="display:inline-block;width:2px;height:8px;background:#1d4ed8;margin-left:1px;vertical-align:text-bottom;animation:streamBlink .7s step-end infinite">&#8203;</span>\x27;
                      }
                      // Update orchestrator bubble: show which agent it assigned and move the char
                      var orchB = document.getElementById(\x27wfOrchBubble\x27);
                      if (orchB) {
                        var activeNode2 = studioState.nodes[idx];
                        orchB.style.visibility = \x27visible\x27;
                        orchB.textContent = \x27Assegno a \x27+(activeNode2 ? (activeNode2.label || activeNode2.agent) : \x27agente\x27);
                      }
                      // Move orchestrator char toward active agent column (live, every token)
                      var orchCharEl = document.getElementById(\x27wfOrchChar\x27);
                      var orchStEl = document.querySelector(\x27[data-station-idx="-1"]\x27);
                      var actStEl = document.querySelector(\x27[data-station-idx="\x27+idx+\x27"]\x27);
                      if (orchCharEl && orchStEl && actStEl) {
                        var orchR = orchStEl.getBoundingClientRect();
                        var actR = actStEl.getBoundingClientRect();
                        var dlt = (actR.left + actR.width/2) - (orchR.left + orchR.width/2);
                        var shft = Math.round(dlt * 0.62);
                        // Only update if shift changed by more than 4px (avoid jitter)
                        var lastShft = parseFloat(orchCharEl.getAttribute(\x27data-last-shift\x27) || \x270\x27);
                        if (Math.abs(shft - lastShft) > 4) {
                          orchCharEl.style.transition = \x27transform 1.2s cubic-bezier(.4,0,.2,1)\x27;
                          orchCharEl.style.transform = \x27translateX(\x27+shft+\x27px)\x27;
                          orchCharEl.setAttribute(\x27data-last-shift\x27, String(shft));
                        }
                      }
                      // Update boardroom seat bubble if parliament is active
                      if (parlActiveAgent) {
                        var brSafeLbl = parlActiveAgent.replace(new RegExp(\x27[^a-zA-Z0-9_-]\x27,\x27g\x27),\x27_\x27);
                        var brBubbleEl = document.getElementById(\x27brbubble_\x27+brSafeLbl);
                        if (brBubbleEl) {
                          var brRaw = output.length > 48 ? output.slice(-48) : output;
                          var brSafe = brRaw.replace(/&/g,\x27&amp;\x27).replace(/</g,\x27&lt;\x27).replace(/>/g,\x27&gt;\x27);
                          brBubbleEl.style.display = \x27\x27;
                          brBubbleEl.innerHTML = brSafe + \x27<span style="display:inline-block;width:2px;height:8px;background:var(--green);margin-left:1px;vertical-align:text-bottom;animation:streamBlink .7s step-end infinite">&#8203;</span>\x27;
                        }
                      }
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
                // Backend sends accurate usage at end: add input, replace out estimate with real value
                var uIn = ev.usage.input||0; var uOut = ev.usage.output||0;
                // Correct output: remove per-token estimate already added, replace with real count
                var outDiff = uOut - stepTokensOut;
                studioTokens.out = Math.max(0, studioTokens.out + outDiff);
                stepTokensIn += uIn; stepTokensOut = uOut;
                studioTokens.in += uIn;
                studioUpdateTokenBar();
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
  // Persist parliament block across tab navigations
  var existingParl = document.getElementById('studioParliamentBlock');
  if (existingParl && existingParl.innerHTML.trim()) {
    _parlPersistHtml = _PARL_STAMP + existingParl.innerHTML;
  }

  var examplesHtml = STUDIO_EXAMPLES.map(function(ex) {
    return '<button class="studio-example-btn" onclick="document.getElementById(\\'studioTaskInput\\').value=' + JSON.stringify(ex) + '">' + esc(ex.slice(0, 52)) + (ex.length > 52 ? '...' : '') + '</button>';
  }).join('');

  // Agent catalog
  var STUDIO_AGENTS = [
    {icon:'&#127860;',name:'TravelAgent',desc:'Restaurants, hotels & bookings (browser automation)'},
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
    {icon:'&#128190;',name:'CodeExecutorAgent',desc:'Run Python/JS/TS code in sandbox'},
    {icon:'&#128193;',name:'FileReaderAgent',desc:'Read local files & directories'},
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
    '<div style="display:flex;gap:16px;align-items:flex-start" id="studioMainRow">' +
      '<div style="flex:1;min-width:0">' +
        '<button class="studio-sidebar-toggle" onclick="(function(){var sb=document.getElementById(\\x27studioSidebar\\x27);sb.classList.toggle(\\x27studio-sidebar--open\\x27)})()" title="Tools &amp; Agents">&#128295; Tools &amp; Agents</button>' +

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
              '<button id="studioInlinePdfBtn" onclick="downloadStudioPDF()" title="Download PDF" style="display:' + (studioState.result ? 'inline-flex' : 'none') + ';align-items:center;gap:5px;padding:8px 12px;background:linear-gradient(135deg,#4f46e5,#2563eb);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:0 2px 6px rgba(79,70,229,.35)">&#x2913; PDF</button>' +
              '<button id="studioInlineXlsxBtn" onclick="downloadStudioXLSX()" title="Export Excel" style="display:' + (studioState.result ? 'inline-flex' : 'none') + ';align-items:center;gap:5px;padding:8px 12px;background:linear-gradient(135deg,#059669,#047857);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:0 2px 6px rgba(5,150,105,.35)">&#x1f4ca; Excel</button>' +
              '<button id="studioInlineCsvBtn" onclick="downloadStudioCSV()" title="Export CSV" style="display:' + (studioState.result ? 'inline-flex' : 'none') + ';align-items:center;gap:5px;padding:8px 10px;background:linear-gradient(135deg,#0891b2,#0369a1);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:0 2px 6px rgba(8,145,178,.35)">CSV</button>' +
              '<button onclick="studioReset()" title="' + t('reset') + '" style="padding:8px 12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--dim);cursor:pointer;font-size:16px;line-height:1" ' + (studioState.running ? 'disabled' : '') + '>&#8635;</button>' +
            '</div>' +
          '</div>' +
          '<label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer;user-select:none">' +
            '<input type="checkbox" id="studioParliamentMode" style="width:15px;height:15px;accent-color:var(--green3)" ' + (studioState.parliamentMode ? \x27checked\x27 : \x27\x27) + ' onchange="studioState.parliamentMode=this.checked">' +
            '<span style="font-size:12px;color:var(--dim)">&#x1f4bc; <strong style="color:var(--green)">Consiglio</strong> — gli agenti si confrontano dopo aver lavorato in autonomia (2x token)</span>' +
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
      '</div>' +

      // ── AGENT SIDEBAR ──
      '<div id="studioSidebar" class="studio-sidebar">' +
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
        '<div id="studioSessionsBar" style="display:none;border:1px solid #334155;border-radius:10px;padding:12px 14px;background:#0f172a"></div>' +
      '</div>' +
    '</div>';

  renderStudioNodes();
  renderStudioLog();
  renderStudioResult();
  renderStudioSessionsBar();
  // Restore token bar (preserve counts across re-renders)
  studioUpdateTokenBar();
  // Restore pipeline from state
  renderBuilderPipeline();
  // Restore parliament block if it was visible before tab navigation
  // Version stamp check: discard stale HTML from older versions
  if (_parlPersistHtml && _parlPersistHtml.indexOf(_PARL_STAMP) === 0) {
    var parlRestoreEl = document.getElementById('studioParliamentBlock');
    if (parlRestoreEl) {
      parlRestoreEl.innerHTML = _parlPersistHtml.slice(_PARL_STAMP.length);
      parlRestoreEl.style.display = 'block';
    }
  } else {
    _parlPersistHtml = null;
  }
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
  // Pre-load config so hasGoogle/hasMicrosoft are available immediately in any view
  apiGet('/api/config').then(function(r){ settingsData = r || {}; settingsLoaded = true; }).catch(function(){});
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
  // Version update check — once at boot, non-blocking
  setTimeout(function(){
    fetch(API+\x27/api/version/check\x27).then(function(r){return r.json();}).then(function(d){
      _updateInfo=d;
      if(d.updateAvailable){renderSidebar();}
    }).catch(function(){});
  },5000);
}
init();

// ---- WEBCRAFT ----
var wcState = {
  description: '',
  authFields: [{name:'firstName',label:'First name',type:'text',required:true},{name:'lastName',label:'Last name',type:'text',required:true},{name:'email',label:'Email',type:'email',required:true},{name:'password',label:'Password',type:'password',required:true}],
  blocks: {auth:true, cookieBanner:true, securityMiddleware:true, emailVerification:true},
  generatedFiles: [],   // [{name, content, lang}]
  activeFile: 0,
  running: false,
  projectName: '',
  rightTab: 'files',    // 'files' | 'preview'
  sandbox: {
    running: false,
    port: null,
    dir: null,
    logs: [],
    error: null
  },
  lastGenStats: null,
  repairing: false,
  repairTotal: 0,
  repairDone: 0,
  repairCurrent: ''
};
var wcRightTab = 'files';
var wcMainTab = 'new';     // 'new' | 'projects'
var wcProjectsList = [];   // cached list from server
var wcSandboxExpanded = {};  // { phaseKey: true/false }
// Agent chat state
var wcChat = [];           // [{role:'user'|'agent', text, tools:[]}]
var wcChatRunning = false;
var wcChatAttachments = []; // [{name, mimeType, base64, size}]
var _wcAutoFixAttempts = 0;
var _wcAutoFixTimer = null;
var _wcPlanPending = null;   // null | { plan: string, message: string } — plan mode waiting for approval
var _wcDiffQueue = [];       // [{file, before, after}] diffs from last agent run
var _wcGrepOpen = false;     // grep panel visible
var _wcGrepQuery = '';
var _updateInfo = null;  // {current, latest, updateAvailable} — fetched once at boot
var _wcGrepResults = [];
// (overlay pill removed — inline progress bar used instead)
var _wcGenAbortCtrl = null;        // AbortController for generation stop
var _wcSyntaxResults = [];   // [{file, ok, error}]
var _wcSnapshots = [];       // [{ts, fileCount}]
var _wcLastFilePlan = [];    // saved for manual repair trigger
var _wcLastSysPreamble = '';
var _wcTokIn = 0;            // global token counters (accumulate across generation + repair)
var _wcTokOut = 0;
var _wcGenOverlayState = { fi: 0, total: 0, name: '' };
var _wcGenStartTime = 0;
var _wcTimerInterval = null;

function wcGenElapsed() {
  var s = Math.floor((Date.now() - _wcGenStartTime) / 1000);
  var m = Math.floor(s / 60); s = s % 60;
  return (m > 0 ? m + 'm ' : '') + s + 's';
}

function wcStartGenTimer() {
  if (_wcTimerInterval) clearInterval(_wcTimerInterval);
  _wcTimerInterval = setInterval(function() {
    if (!wcState.running && !wcState.repairing) { clearInterval(_wcTimerInterval); _wcTimerInterval = null; return; }
    // Always update time in-place — never re-render the whole component
    wcUpdateGenOverlay(_wcGenOverlayState.fi, _wcGenOverlayState.total, _wcGenOverlayState.name);
    var repairTime = document.getElementById('wcRepairTime');
    if (repairTime) repairTime.textContent = wcGenElapsed();
  }, 1000);
}

function wcUpdateGenOverlay(fi2, total, name) {
  _wcGenOverlayState = { fi: fi2, total: total, name: name };
  var pct = total > 0 ? Math.round((fi2 / total) * 100) : 0;
  var counterEl = document.getElementById('wcGenCounter');
  var barEl     = document.getElementById('wcGenBar');
  var nameEl    = document.getElementById('wcGenFileName');
  var timeEl    = document.getElementById('wcGenTime');
  if (counterEl) counterEl.textContent = fi2 + ' / ' + total;
  if (barEl)     barEl.style.width = pct + '%';
  if (nameEl)    nameEl.textContent = name ? name.split(',')[0].trim() : '';
  if (timeEl)    timeEl.textContent = wcGenElapsed();
}

// Skills state
var wcSkills = [];          // [{name, content, type}] type: 'skill'|'memory'|'provider'
var wcSkillModal = null;    // null | {mode:'edit'|'new', idx:number|null, name, content, type, generating}
var _wcSkillsLoaded = false;

// Default 3 files always present in every project
var WC_DEFAULT_FILES = [
  { name: 'memory.md',  type: 'memory',   content: '' },
  { name: 'liara.md',   type: 'provider', content: '' },
  { name: 'skills.md',  type: 'skill',    content: '' }
];

function wcEsc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}

function renderWebCraft(el) {
  // File sidebar — replaces horizontal tabs
  var _activeFile = wcState.generatedFiles[wcState.activeFile];

  function wcFileSizeLabel(content) {
    if (!content) return '0 B';
    var bytes = new TextEncoder().encode(content).length;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    return (bytes/(1024*1024)).toFixed(2) + ' MB';
  }

  var fileSidebarHtml = wcState.generatedFiles.length > 0
    ? '<div style="width:190px;flex-shrink:0;border-left:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column">' +
        '<div style="padding:8px 10px;border-bottom:1px solid var(--border);font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;flex-shrink:0">'+wcState.generatedFiles.length+' file</div>' +
        wcState.generatedFiles.map(function(f,i){
          var active = i === wcState.activeFile;
          var hasErr = !!f._error || !!f._syntaxError;
          var isPending = !!f._pending;
          var lines = isPending ? 0 : (f.content || '').split(String.fromCharCode(10)).length;
          var sizeLabel = isPending ? '...' : wcFileSizeLabel(f.content || '');
          var nameColor = hasErr ? '#f87171' : isPending ? '#4b5563' : active ? 'var(--text)' : 'var(--dim)';
          var bg = active ? 'var(--bg3)' : 'transparent';
          var borderLeft = hasErr ? '2px solid #f87171' : active ? '2px solid var(--green3)' : '2px solid transparent';
          var icon = isPending ? '&#8987;' : hasErr ? '&#9888;' : wcFileIcon(f.name);
          return '<button id="wcTab'+i+'" onclick="wcSetFile('+i+')" style="width:100%;text-align:left;padding:7px 10px 7px 10px;background:'+bg+';border:none;border-left:'+borderLeft+';cursor:pointer;display:flex;flex-direction:column;gap:2px;flex-shrink:0">' +
            '<span style="display:flex;align-items:center;gap:5px">' +
              '<span style="font-size:12px;flex-shrink:0">'+icon+'</span>' +
              '<span style="font-size:11px;font-family:var(--mono);color:'+nameColor+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="'+wcEsc(f.name)+'">'+wcEsc(f.name.split('/').pop())+'</span>' +
            '</span>' +
            (f.name.includes('/') ? '<span style="font-size:9px;color:#4b5563;font-family:var(--mono);padding-left:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+wcEsc(f.name.split('/').slice(0,-1).join('/'))+'</span>' : '') +
            (!isPending ? '<span style="font-size:9px;color:#4b5563;font-family:var(--mono);padding-left:17px">'+lines+' righe &nbsp;&#183;&nbsp; '+sizeLabel+'</span>' : '') +
          '</button>';
        }).join('') +
      '</div>'
    : '';

  var codeHtml = wcState.generatedFiles.length > 0 && _activeFile
    ? '<div style="flex:1;display:flex;flex-direction:row;min-height:0;overflow:hidden">' +
        '<div id="wcCodeWrap" style="flex:1;overflow:auto;background:var(--bg3)">' +
          '<div style="padding:8px 14px;border-bottom:1px solid var(--border2);font-size:10px;color:var(--dim);font-family:var(--mono);display:flex;align-items:center;gap:8px;background:var(--bg2)">' +
            '<span style="font-size:13px">'+wcFileIcon(_activeFile.name)+'</span>' +
            '<span style="color:var(--text)">'+wcEsc(_activeFile.name)+'</span>' +
            (!_activeFile._pending && !_activeFile._error ? '<span style="margin-left:auto;color:#4b5563">'+(_activeFile.content||'').split(String.fromCharCode(10)).length+' righe &nbsp;&#183;&nbsp; '+wcFileSizeLabel(_activeFile.content||'')+'</span>' : '') +
          '</div>' +
          (_activeFile._error ? '<div style="padding:8px 14px;background:rgba(239,68,68,0.12);border-bottom:1px solid rgba(239,68,68,0.3);font-size:11px;color:#f87171;display:flex;align-items:center;gap:6px">&#9888; Generazione fallita — chiedi al modello di rigenerare questo file</div>' :
           _activeFile._syntaxError ? '<div style="padding:8px 14px;background:rgba(234,179,8,0.1);border-bottom:1px solid rgba(234,179,8,0.3);font-size:11px;color:#facc15;display:flex;align-items:center;gap:6px">&#9888; Syntax error: '+wcEsc(_activeFile._syntaxError)+'</div>' : '') +
          (_activeFile._pending ? '<div id="wcLivePending" style="display:flex;align-items:center;justify-content:center;height:120px;color:var(--dim);font-size:12px;gap:8px">&#8987; In generazione...</div>' :
          '<pre id="wcLiveCode" style="margin:0;padding:14px 16px;font-size:11px;line-height:1.6;color:'+(_activeFile._error?'#f87171':_activeFile._syntaxError?'#fde68a':'var(--text)')+';font-family:var(--mono);white-space:pre-wrap;word-break:break-all">'+wcEsc(_activeFile.content)+'</pre>') +
        '</div>' +
        fileSidebarHtml +
      '</div>'
    : '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px;flex-direction:column;gap:8px">' +
        '<span style="font-size:36px;opacity:.25">&#128736;</span>' +
        '<span>'+t('wc_no_files')+'</span>' +
      '</div>';

  function wcFileIcon(name) {
    var ext = name.split('.').pop().toLowerCase();
    var icons = { js:'&#128196;', ts:'&#128196;', css:'&#127912;', html:'&#127760;', json:'&#123;', md:'&#128209;', sql:'&#128450;', env:'&#128272;', conf:'&#9881;', lock:'&#128274;' };
    return icons[ext] || '&#128196;';
  }

  var authFieldsHtml = wcState.authFields.map(function(f,i){
    return '<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg3);border-radius:6px;margin-bottom:4px;overflow:hidden">' +
      '<input value="'+wcEsc(f.label)+'" onchange="wcUpdateField('+i+',this.value)" style="flex:1;min-width:0;background:transparent;border:none;color:var(--text);font-size:11px;font-family:var(--mono);width:0" />' +
      '<select onchange="wcUpdateFieldType('+i+',this.value)" style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--dim);font-size:10px;padding:2px 2px;width:68px;flex-shrink:0">' +
        ['text','email','password','tel','date','number'].map(function(t){return '<option value="'+t+'"'+(f.type===t?' selected':'')+'>'+t+'</option>'}).join('') +
      '</select>' +
      '<input type="checkbox"'+(f.required?' checked':'')+' onchange="wcToggleRequired('+i+',this.checked)" title="Required" style="accent-color:var(--green3)">' +
      '<button onclick="wcRemoveField('+i+')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:13px;line-height:1;padding:0 2px">&times;</button>' +
    '</div>';
  }).join('');

  // Example prompts — clicking fills project name + description
  var wcExamples = [
    {name:'MySaaS', desc:'SaaS product landing page. Hero: large headline, subheadline, two CTA buttons (Start free trial / Watch demo), animated gradient background. Features section: 3-column grid with icon, title, description for 6 features (real-time sync, team collaboration, analytics dashboard, API access, role-based permissions, 99.9% uptime SLA). Pricing section: 3 cards (Free: 1 user, 5 projects, community support; Pro $29/mo: 10 users, unlimited projects, priority support, API access; Enterprise: custom pricing, SSO, SLA, dedicated support) with highlighted recommended card. Testimonials: 3 customer quotes with avatar placeholder, name, company, star rating. FAQ accordion: 5 questions. Footer: links, social icons, copyright. Nav: logo, links (Features, Pricing, Docs, Blog), Login and Start Free CTA buttons. Sticky nav on scroll. Smooth scroll between sections.'},
    {name:'MyShop', desc:'E-commerce storefront homepage. Nav: logo, search bar (full-width on mobile), cart icon with item count badge, account icon, hamburger menu on mobile. Hero: full-width banner with promotional message, discount badge, Shop Now CTA. Category strip: 6 category cards with icon and label (Electronics, Clothing, Home, Sports, Books, Beauty). Featured products grid: 8 product cards each with product image placeholder, product name, star rating (1-5), review count, original price with strikethrough, sale price, Add to Cart button, wishlist heart icon. Promo banner: full-width colored banner with coupon code. Newsletter signup: email input with Subscribe button. Footer: 4-column layout (Company, Customer Service, Categories, Contact info). Fully responsive 2-col on tablet, 1-col on mobile.'},
    {name:'MyBlog', desc:'Blog and content platform homepage. Nav: logo, category links (Tech, Design, Business, Life), search icon, Subscribe CTA. Hero: large featured article card with cover image placeholder, category badge, title, excerpt (2 lines), author avatar, author name, date, read time, Read More link. Article grid: 6 cards in 3-column layout, each with cover image, category tag, title, excerpt, author, date. Sidebar (on desktop): Recent posts list (5 items with thumbnail, title, date), Popular tags cloud (10 tags as pill buttons), Newsletter signup widget (email + Subscribe). Pagination: numbered page links. Author bio section at bottom: avatar, name, bio paragraph, social links. Footer: minimal with links and copyright.'},
    {name:'MyPortfolio', desc:'Developer portfolio homepage. Nav: name/logo left, links right (Work, Skills, About, Contact), dark/light mode toggle button, nav hides on scroll down and shows on scroll up. Hero: centered layout, large name heading, animated typewriter role subtitle cycling through 3 roles (e.g. Full-Stack Developer / UI Engineer / Open Source Contributor), short bio paragraph, two CTA buttons (View my work / Download CV), animated floating code snippet decoration. Work section: 6 project cards in 2-column masonry-style grid, each with project screenshot placeholder, project name, tech stack tags (3-4 pills), description (2 lines), GitHub icon link and Live Demo link. Skills section: grouped by category (Frontend, Backend, Tools) with skill name and filled bar (percentage). About section: split layout, left photo placeholder, right: bio paragraph, timeline of 3 career milestones (year, title, company, description). Contact section: centered form (name, email, subject, message textarea, Send Message button), response time note. All sections with smooth scroll entrance animations using Intersection Observer.'},
    {name:'MyRestaurant', desc:'Restaurant website homepage. Nav: logo center, links left (Menu, Story, Reservations, Gallery, Contact), phone number right, fixed transparent becoming solid white on scroll. Hero: full-viewport background image placeholder with dark overlay, restaurant name in serif font, tagline, two buttons (Reserve a Table / View Menu). About strip: 3 horizontal icon+stat items (e.g. Est. 2010 / 50 Tables / 4.9 Stars). Menu preview section: tabbed navigation (Starters, Mains, Desserts, Drinks), each tab shows 6 menu items in 2-column grid with dish name, description (1 line), allergen icons, price. CTA reservation banner: colored background, heading, inline form (date picker, time select, party size select, name, phone, Book Now button). Gallery grid: 9 square image placeholders in 3x3 mosaic layout with hover zoom effect. Chef section: photo placeholder left, name, title, bio paragraph, signature right. Testimonials: horizontal scroll of 5 review cards (stars, quote, reviewer name, date). Footer: address, opening hours table (Mon-Sun), social links, Google Maps embed placeholder.'},
    {name:'MyJobBoard', desc:'Job board homepage. Nav: logo, links (Browse Jobs, Companies, Salary Guide, Blog), Post a Job CTA button (green), Sign In link. Hero: centered search widget (keyword input + location input + category select + Search Jobs button), popular searches as clickable tags below (e.g. React Developer, Data Analyst, UX Designer). Stats strip: 4 counters (Active Jobs, Companies Hiring, Candidates, Jobs Filled This Month). Featured jobs list: 8 job cards in vertical list, each with company logo placeholder, job title, company name, location (with icon), job type badge (Full-time/Remote/Contract), salary range, posted X days ago, bookmark icon, Quick Apply button. Filter sidebar (desktop): checkboxes for Job Type, Experience Level, Salary Range slider, Location radius, Remote only toggle. Top companies section: 6 company cards in 3-col grid with logo, name, industry, open positions count, View Jobs link. Category cards: 8 icons+labels for job categories. Newsletter: email input with Get Job Alerts button. Footer: 5-column layout (Job Seekers, Employers, Resources, Company, Social).'}
  ];
  var wcExHtml = '<div style="margin-bottom:12px;flex-shrink:0"><div style="font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">'+t('wc_examples_label')+'</div><div style="display:flex;gap:6px;flex-wrap:wrap">' +
    wcExamples.map(function(ex,i){
      return '<button onclick="wcPickExample('+i+')" style="padding:4px 10px;border-radius:14px;border:1px solid var(--border2);background:var(--bg3);color:var(--dim);font-size:11px;cursor:pointer;white-space:nowrap">'+wcEsc(ex.name)+'</button>';
    }).join('') +
  '</div></div>';

  var headerHtml =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-shrink:0">' +
      '<div>' +
        '<h2 style="font-size:15px;color:var(--green);margin-bottom:2px">&#128736; '+t('wc_title')+'</h2>' +
        '<p style="font-size:11px;color:var(--dim);line-height:1.5">'+t('wc_subtitle')+'</p>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0">' +
        '<button onclick="wcMainTabNew()" style="padding:5px 14px;border-radius:6px;border:1px solid var(--border2);background:'+(wcMainTab==='new'?'var(--green3)':'var(--bg3)')+';color:'+(wcMainTab==='new'?'var(--bg)':'var(--dim)')+';font-size:11px;font-weight:600;cursor:pointer">+ Nuovo</button>' +
        '<button onclick="wcMainTabProjects()" style="padding:5px 14px;border-radius:6px;border:1px solid var(--border2);background:'+(wcMainTab==='projects'?'var(--green3)':'var(--bg3)')+';color:'+(wcMainTab==='projects'?'var(--bg)':'var(--dim)')+';font-size:11px;font-weight:600;cursor:pointer">&#128193; '+t('wc_projects')+'</button>' +
      '</div>' +
    '</div>';

  var editorHtml =
    '<div style="display:flex;flex-direction:column;height:100%">' +
    wcExHtml +
    '<div style="display:flex;gap:14px;align-items:flex-start;flex:1;min-height:0">' +
      '<div style="width:260px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;height:100%">' +
        '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px">' +
          '<div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">'+t('wc_blocks')+'</div>' +
          ['auth','cookieBanner','securityMiddleware','emailVerification'].map(function(b){
            var labels = {auth:'Auth (register/login/JWT)',cookieBanner:'GDPR Cookie Banner',securityMiddleware:'Security Middleware',emailVerification:'Email Verification'};
            var icons  = {auth:'&#128274;',cookieBanner:'&#127850;',securityMiddleware:'&#128737;',emailVerification:'&#9993;'};
            return '<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:11px;color:var(--text)">' +
              '<input type="checkbox"'+(wcState.blocks[b]?' checked':'')+' onchange="wcState.blocks['+JSON.stringify(b)+']=this.checked" style="accent-color:var(--green3);width:14px;height:14px">' +
              '<span>'+icons[b]+'</span><span>'+labels[b]+'</span>' +
            '</label>';
          }).join('') +
        '</div>' +
        '<div id="wcAuthFieldsPanel" style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;'+(wcState.blocks.auth?'':'display:none')+'">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
            '<div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px">'+t('wc_auth_fields')+'</div>' +
            '<button onclick="wcAddField()" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;color:var(--green);cursor:pointer">'+t('wc_add_field')+'</button>' +
          '</div>' +
          '<div id="wcFieldsList">'+authFieldsHtml+'</div>' +
          '<div style="font-size:9px;color:var(--dim);margin-top:4px">'+t('wc_required_hint')+'</div>' +
        '</div>' +
        wcSkillsPanelHtml() +
        wcSnapshotsPanelHtml() +
        (wcState.running ?
          '<div style="width:100%;padding:11px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--dim);font-size:12px;text-align:center">&#9203; '+t('wc_generating')+'...</div>'
        : '') +
        (wcState.repairing ?
          '<div style="width:100%;padding:10px 12px;background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.4);border-radius:8px;display:flex;flex-direction:column;gap:4px">' +
            '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#facc15;font-weight:600">&#128295; Correzione automatica in corso...</div>' +
            '<div style="font-size:10px;color:var(--dim)">'+wcState.repairDone+' / '+wcState.repairTotal+' file</div>' +
            (wcState.repairCurrent ? '<div style="font-size:10px;color:#fde68a;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+wcEsc(wcState.repairCurrent)+'</div>' : '') +
          '</div>'
        : '') +
        (wcState.generatedFiles.length > 0 && !wcState.running ?
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button onclick="wcDownloadZip()" style="flex:1;padding:9px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:11px;font-weight:600;cursor:pointer">&#8681; ZIP</button>' +
            '<button onclick="wcRunSyntaxCheck()" title="Controlla errori sintassi JS" style="padding:9px 10px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--dim);font-size:11px;cursor:pointer" title="Syntax check">&#9989;</button>' +
            '<button onclick="wcToggleGrep()" title="Cerca nel codice" style="padding:9px 10px;background:'+(_wcGrepOpen?'var(--greendim)':'var(--bg3)')+';border:1px solid '+(_wcGrepOpen?'var(--green3)':'var(--border2)')+';border-radius:8px;color:'+(_wcGrepOpen?'var(--green)':'var(--dim)')+';font-size:11px;cursor:pointer">&#128269;</button>' +
            '<button onclick="wcManualSnapshot()" title="Salva snapshot" style="padding:9px 10px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--dim);font-size:11px;cursor:pointer">&#128190;</button>' +
          '</div>' +
          (wcState.generatedFiles.some(function(f){ return f._error || f._syntaxError; }) && !wcState.repairing ?
            '<button onclick="wcTriggerRepair()" style="width:100%;padding:9px;background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.5);border-radius:8px;color:#facc15;font-size:11px;font-weight:600;cursor:pointer">&#128295; Correggi tutti i file rossi</button>'
          : '') +
          '<button onclick="wcStartSandbox()" id="wcSandboxBtn" style="width:100%;padding:10px;background:var(--bg3);border:1px solid var(--green3);border-radius:8px;color:var(--green);font-size:12px;font-weight:600;cursor:pointer">&#9654; '+t('wc_sandbox_start')+'</button>' +
          (wcState.lastGenStats ? '<div style="padding:6px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;font-size:10px;color:var(--dim);font-family:var(--mono);display:flex;flex-wrap:wrap;gap:6px">' +
            '<span>&#9201; '+(wcState.lastGenStats.seconds >= 60 ? Math.floor(wcState.lastGenStats.seconds/60)+'m '+(wcState.lastGenStats.seconds%60)+'s' : wcState.lastGenStats.seconds+'s')+'</span>' +
            '<span>&#8679; '+wcState.lastGenStats.tokIn.toLocaleString()+' tok in</span>' +
            '<span>&#8681; '+wcState.lastGenStats.tokOut.toLocaleString()+' tok out</span>' +
            '<span>&#128196; '+wcState.lastGenStats.files+' file</span>' +
          '</div>' : '')
        : '') +
      '</div>' +
      '<div data-wc-files style="position:relative;flex:1;min-width:0;background:var(--bg2);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;height:100%;overflow:hidden">' +
        // ── Tab bar: File / Sandbox ───────────────────────────────────────────
        '<div style="display:flex;border-bottom:1px solid var(--border);flex-shrink:0">' +
          '<button onclick="wcTabFiles()" style="padding:8px 16px;background:'+(wcRightTab==='preview'?'transparent':'var(--bg3)')+';border:none;border-right:1px solid var(--border);color:'+(wcRightTab==='preview'?'var(--dim)':'var(--text)')+';font-size:11px;font-weight:600;cursor:pointer">&#128196; File</button>' +
          '<button onclick="wcTabPreview()" style="padding:8px 16px;background:'+(wcRightTab==='preview'?'var(--bg3)':'transparent')+';border:none;color:'+(wcRightTab==='preview'?'var(--text)':'var(--dim)')+';font-size:11px;font-weight:600;cursor:pointer">&#127760; Sandbox</button>' +
        '</div>' +
        // ── Generation progress bar (inline, above code area) ─────────────────
        (wcState.repairing ?
          '<div id="wcRepairBar" style="flex-shrink:0;background:rgba(20,16,0,0.96);border-bottom:2px solid rgba(234,179,8,0.6);padding:6px 14px;display:flex;flex-direction:column;gap:3px">'
            +'<div style="display:flex;align-items:center;gap:8px">'
              +'<span style="font-size:13px;animation:wcRobotBob .9s ease-in-out infinite;flex-shrink:0">&#128295;</span>'
              +'<span style="font-size:10px;font-weight:700;color:#facc15;flex-shrink:0">Auto-fix</span>'
              +'<span style="font-size:10px;color:#fde68a;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" id="wcRepairFile">'+wcEsc(wcState.repairCurrent || '')+'</span>'
              +'<span style="font-size:10px;color:var(--dim);flex-shrink:0" id="wcRepairCounter">'+wcState.repairDone+' / '+wcState.repairTotal+'</span>'
              +'<span style="display:flex;gap:3px">'+[0,1,2].map(function(_,idx){ return '<span style="width:4px;height:4px;border-radius:50%;background:#facc15;animation:wcDot 1.1s ease-in-out infinite '+(idx*0.18)+'s"></span>'; }).join('')+'</span>'
              +'<button onclick="wcStopRepair()" style="padding:2px 8px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:4px;color:#f87171;font-size:10px;font-weight:700;cursor:pointer;flex-shrink:0">&#9632; Stop</button>'
            +'</div>'
            +'<div style="height:2px;background:rgba(255,255,255,0.07);border-radius:1px;overflow:hidden">'
              +'<div id="wcRepairProg" style="height:100%;width:'+(wcState.repairTotal>0?Math.round((wcState.repairDone/wcState.repairTotal)*100):0)+'%;background:#facc15;border-radius:1px;transition:width .3s ease"></div>'
            +'</div>'
          +'</div>'
        : wcState.running ?
          '<div id="wcGenOverlay" style="flex-shrink:0;background:rgba(0,14,0,0.96);border-bottom:2px solid var(--green3);padding:6px 14px;display:flex;flex-direction:column;gap:3px">'
            +'<div style="display:flex;align-items:center;gap:8px">'
              +'<span style="font-size:13px;animation:wcRobotBob .9s ease-in-out infinite;flex-shrink:0">&#129302;</span>'
              +'<span style="font-size:10px;font-weight:700;color:var(--green);flex-shrink:0">Generazione</span>'
              +'<span id="wcGenFileName" style="font-size:10px;color:var(--dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">'+wcEsc((_wcGenOverlayState.name||'').split(',')[0].trim())+'</span>'
              +'<span id="wcGenCounter" style="font-size:10px;color:var(--dim);flex-shrink:0">'+_wcGenOverlayState.fi+' / '+_wcGenOverlayState.total+'</span>'
              +'<span id="wcGenTime" style="font-size:10px;color:var(--dim);flex-shrink:0">'+wcGenElapsed()+'</span>'
              +'<span style="display:flex;gap:3px">'+[0,1,2].map(function(_,idx){ return '<span style="width:4px;height:4px;border-radius:50%;background:var(--green);animation:wcDot 1.1s ease-in-out infinite '+(idx*0.18)+'s"></span>'; }).join('')+'</span>'
            +'</div>'
            +'<div style="height:2px;background:rgba(255,255,255,0.07);border-radius:1px;overflow:hidden">'
              +'<div id="wcGenBar" style="height:100%;width:'+Math.round((_wcGenOverlayState.fi/_wcGenOverlayState.total||0)*100)+'%;background:var(--green);border-radius:1px;transition:width .3s ease"></div>'
            +'</div>'
          +'</div>'
        : '') +
        (wcRightTab === 'preview' ? wcSandboxPanelHtml() : codeHtml) +
      '</div>' +
    '</div>' +
    '</div>';

  // Preserve textarea value across re-renders (re-render destroys DOM)
  var _wcChatInputEl = document.getElementById('wcChatInput');
  var _wcChatInputVal = _wcChatInputEl ? _wcChatInputEl.value : '';

  el.innerHTML =
    '<div style="display:flex;flex-direction:column;height:100%;min-height:0;padding:0 4px">' +
      headerHtml +
      '<div style="flex:1;min-height:0;overflow:hidden">' +
        (wcMainTab === 'projects' ? wcProjectsPanelHtml() : editorHtml) +
      '</div>' +
      (wcMainTab !== 'projects' ? wcPlanBannerHtml() : '') +
      (wcMainTab !== 'projects' ? wcGrepPanelHtml() : '') +
      (wcMainTab !== 'projects' ? wcDiffPanelHtml() : '') +
      wcChatPanelHtml() +
    '</div>' +
    wcSkillModalHtml();

  // Restore textarea value after DOM rebuild
  if (_wcChatInputVal) {
    var _wcChatInputNew = document.getElementById('wcChatInput');
    if (_wcChatInputNew) _wcChatInputNew.value = _wcChatInputVal;
  }
}

function wcPickExample(i) {
  var wcExamplesData = [
    {name:'MySaaS', desc:'SaaS product landing page. Hero: large headline, subheadline, two CTA buttons (Start free trial / Watch demo), animated gradient background. Features section: 3-column grid with icon, title, description for 6 features (real-time sync, team collaboration, analytics dashboard, API access, role-based permissions, 99.9% uptime SLA). Pricing section: 3 cards (Free: 1 user, 5 projects, community support; Pro $29/mo: 10 users, unlimited projects, priority support, API access; Enterprise: custom pricing, SSO, SLA, dedicated support) with highlighted recommended card. Testimonials: 3 customer quotes with avatar placeholder, name, company, star rating. FAQ accordion: 5 questions. Footer: links, social icons, copyright. Nav: logo, links (Features, Pricing, Docs, Blog), Login and Start Free CTA buttons. Sticky nav on scroll. Smooth scroll between sections.'},
    {name:'MyShop', desc:'E-commerce storefront homepage. Nav: logo, search bar (full-width on mobile), cart icon with item count badge, account icon, hamburger menu on mobile. Hero: full-width banner with promotional message, discount badge, Shop Now CTA. Category strip: 6 category cards with icon and label (Electronics, Clothing, Home, Sports, Books, Beauty). Featured products grid: 8 product cards each with product image placeholder, product name, star rating (1-5), review count, original price with strikethrough, sale price, Add to Cart button, wishlist heart icon. Promo banner: full-width colored banner with coupon code. Newsletter signup: email input with Subscribe button. Footer: 4-column layout (Company, Customer Service, Categories, Contact info). Fully responsive 2-col on tablet, 1-col on mobile.'},
    {name:'MyBlog', desc:'Blog and content platform homepage. Nav: logo, category links (Tech, Design, Business, Life), search icon, Subscribe CTA. Hero: large featured article card with cover image placeholder, category badge, title, excerpt (2 lines), author avatar, author name, date, read time, Read More link. Article grid: 6 cards in 3-column layout, each with cover image, category tag, title, excerpt, author, date. Sidebar (on desktop): Recent posts list (5 items with thumbnail, title, date), Popular tags cloud (10 tags as pill buttons), Newsletter signup widget (email + Subscribe). Pagination: numbered page links. Author bio section at bottom: avatar, name, bio paragraph, social links. Footer: minimal with links and copyright.'},
    {name:'MyPortfolio', desc:'Developer portfolio homepage. Nav: name/logo left, links right (Work, Skills, About, Contact), dark/light mode toggle button, nav hides on scroll down and shows on scroll up. Hero: centered layout, large name heading, animated typewriter role subtitle cycling through 3 roles (e.g. Full-Stack Developer / UI Engineer / Open Source Contributor), short bio paragraph, two CTA buttons (View my work / Download CV), animated floating code snippet decoration. Work section: 6 project cards in 2-column masonry-style grid, each with project screenshot placeholder, project name, tech stack tags (3-4 pills), description (2 lines), GitHub icon link and Live Demo link. Skills section: grouped by category (Frontend, Backend, Tools) with skill name and filled bar (percentage). About section: split layout, left photo placeholder, right: bio paragraph, timeline of 3 career milestones (year, title, company, description). Contact section: centered form (name, email, subject, message textarea, Send Message button), response time note. All sections with smooth scroll entrance animations using Intersection Observer.'},
    {name:'MyRestaurant', desc:'Restaurant website homepage. Nav: logo center, links left (Menu, Story, Reservations, Gallery, Contact), phone number right, fixed transparent becoming solid white on scroll. Hero: full-viewport background image placeholder with dark overlay, restaurant name in serif font, tagline, two buttons (Reserve a Table / View Menu). About strip: 3 horizontal icon+stat items (e.g. Est. 2010 / 50 Tables / 4.9 Stars). Menu preview section: tabbed navigation (Starters, Mains, Desserts, Drinks), each tab shows 6 menu items in 2-column grid with dish name, description (1 line), allergen icons, price. CTA reservation banner: colored background, heading, inline form (date picker, time select, party size select, name, phone, Book Now button). Gallery grid: 9 square image placeholders in 3x3 mosaic layout with hover zoom effect. Chef section: photo placeholder left, name, title, bio paragraph, signature right. Testimonials: horizontal scroll of 5 review cards (stars, quote, reviewer name, date). Footer: address, opening hours table (Mon-Sun), social links, Google Maps embed placeholder.'},
    {name:'MyJobBoard', desc:'Job board homepage. Nav: logo, links (Browse Jobs, Companies, Salary Guide, Blog), Post a Job CTA button (green), Sign In link. Hero: centered search widget (keyword input + location input + category select + Search Jobs button), popular searches as clickable tags below (e.g. React Developer, Data Analyst, UX Designer). Stats strip: 4 counters (Active Jobs, Companies Hiring, Candidates, Jobs Filled This Month). Featured jobs list: 8 job cards in vertical list, each with company logo placeholder, job title, company name, location (with icon), job type badge (Full-time/Remote/Contract), salary range, posted X days ago, bookmark icon, Quick Apply button. Filter sidebar (desktop): checkboxes for Job Type, Experience Level, Salary Range slider, Location radius, Remote only toggle. Top companies section: 6 company cards in 3-col grid with logo, name, industry, open positions count, View Jobs link. Category cards: 8 icons+labels for job categories. Newsletter: email input with Get Job Alerts button. Footer: 5-column layout (Job Seekers, Employers, Resources, Company, Social).'}
  ];
  var ex = wcExamplesData[i];
  if (!ex) return;
  wcState.projectName = ex.name;
  wcState.description = ex.desc;
  renderWebCraft(document.getElementById('content'));
  // After re-render, populate the chat textarea and project name input with example values
  var chatEl = document.getElementById('wcChatInput');
  if (chatEl) chatEl.value = ex.desc;
  var nameEl = document.getElementById('wcProjectName');
  if (nameEl) nameEl.value = ex.name;
  if (chatEl) chatEl.focus();
}
function wcTabFiles() { wcRightTab = 'files'; renderWebCraft(document.getElementById('content')); }
function wcTabPreview() { wcRightTab = 'preview'; renderWebCraft(document.getElementById('content')); }
function wcOpenSandbox() { if (wcState.sandbox.port) window.open('http://127.0.0.1:' + wcState.sandbox.port, '_blank'); }

// ── WebCraft Context Files (Skills / Memory / Provider) ───────────────────────

function wcFileTypeIcon(type) {
  return type === 'memory' ? '&#129504;' : type === 'provider' ? '&#129302;' : type === 'log' ? '&#128196;' : '&#128203;';
}
function wcFileTypeBadge(type) {
  var colors = { memory: '#7c5cbf', provider: '#2a7fff', skill: '#1a7a4a', log: '#555' };
  var labels = { memory: 'memory', provider: 'provider', skill: 'skill', log: 'log' };
  return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' + (colors[type]||'#444') + ';color:#fff;margin-left:4px;flex-shrink:0">' + (labels[type]||type) + '</span>';
}

function wcSkillsPanelHtml() {
  var hasProj = wcState.projectName && wcState.generatedFiles.length > 0;
  // Load context files from server on first render if project active
  if (hasProj && !_wcSkillsLoaded) {
    _wcSkillsLoaded = true;
    fetch(API + '/api/studio/webcraft/skills/' + encodeURIComponent(wcState.projectName))
      .then(function(r){ return r.json(); })
      .then(function(d){
        wcSkills = d.skills || [];
        // Ensure the 3 default files always exist client-side
        WC_DEFAULT_FILES.forEach(function(def) {
          var exists = wcSkills.some(function(s){ return s.name === def.name; });
          if (!exists) wcSkills.unshift({ name: def.name, type: def.type, content: def.content });
        });
        renderWebCraft(document.getElementById('content'));
      })
      .catch(function(){});
  }
  // Can add new skill only (memory + provider are singletons already in defaults)
  var rows = wcSkills.map(function(s, si) {
    var isSingleton = s.type === 'memory' || s.type === 'provider';
    var isLog = s.type === 'log';
    var isEmpty = !s.content || s.content.trim() === '';
    return '<div style="display:flex;align-items:center;gap:4px;padding:5px 0;border-bottom:1px solid var(--border)">' +
      '<span style="font-size:13px;flex-shrink:0">' + wcFileTypeIcon(s.type) + '</span>' +
      '<span style="font-size:11px;color:'+(isLog?'var(--dim)':'var(--text)')+';flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+wcEsc(s.name)+'">' + wcEsc(s.name) + '</span>' +
      wcFileTypeBadge(s.type) +
      (!isLog && isEmpty ? '<span title="Vuoto" style="font-size:9px;color:#e09020;flex-shrink:0">&#9888;</span>' : '') +
      '<button onclick="wcOpenSkill('+si+')" title="'+(isLog?'Visualizza log':'Modifica')+'" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:12px;padding:2px 4px;flex-shrink:0">'+(isLog?'&#128065;':'&#9998;')+'</button>' +
      (!isSingleton && !isLog ? '<button onclick="wcClearSkill('+si+')" title="Svuota" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;padding:2px 4px;flex-shrink:0">&#128465;</button>' : '') +
      (isLog ? '<button onclick="wcDeleteSkill('+si+')" title="Elimina log" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;padding:2px 4px;flex-shrink:0">&#128465;</button>' : '') +
    '</div>';
  }).join('');
  return '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px">&#128218; Contesto AI</div>' +
      (hasProj ? '<button onclick="wcNewSkill()" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;color:var(--green);cursor:pointer">+ Skill</button>' : '') +
    '</div>' +
    (wcSkills.length > 0
      ? '<div style="max-height:160px;overflow-y:auto">' + rows + '</div>'
      : (hasProj
          ? '<div style="font-size:10px;color:var(--dim);font-style:italic">Caricamento...</div>'
          : '<div style="font-size:10px;color:var(--dim);font-style:italic">Genera un progetto per attivare i file di contesto.</div>'
        )
    ) +
  '</div>';
}

function wcSkillModalHtml() {
  if (!wcSkillModal) return '';
  var m = wcSkillModal;
  // Log files: read-only viewer
  if (m.mode === 'view') {
    return '<div onclick="wcCloseSkillModal(event)" style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center">' +
      '<div onclick="event.stopPropagation()" style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;width:680px;max-width:96vw;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">' +
        '<div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:14px">&#128196;</span>' +
          '<span style="font-size:13px;font-weight:700;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+wcEsc(m.name)+'</span>' +
          '<span style="font-size:10px;background:#333;color:#aaa;padding:2px 8px;border-radius:10px">log</span>' +
          '<button onclick="wcCloseSkillModal()" style="background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;line-height:1;margin-left:4px">&times;</button>' +
        '</div>' +
        '<div style="flex:1;overflow:auto;padding:14px 18px">' +
          '<pre style="margin:0;font-size:11px;line-height:1.7;color:var(--text);font-family:var(--mono);white-space:pre-wrap;word-break:break-all">'+wcEsc(m.content || '')+'</pre>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  var isNew = m.mode === 'new';
  var charCount = (m.content || '').length;
  // Length guidance per type
  var maxChars = m.type === 'skill' ? 6000 : 4000;
  var warnLen = charCount > maxChars;
  var typeHints = {
    skill: 'Istruzioni tecniche, snippet, pattern di codice specifici per una funzione (es. Stripe, email, auth). Puoi avere quante skill vuoi. Max consigliato: ~6000 caratteri.',
    memory: 'Note persistenti sul progetto: decisioni architetturali, preferenze, contesto generale. Solo UN file. Max consigliato: ~4000 caratteri.',
    provider: 'Istruzioni specifiche per il modello AI usato (Liara/Qwen3, Claude, GPT-4...). Es. tono, formato risposte, vincoli. Solo UN file. Max consigliato: ~4000 caratteri.'
  };
  var hint = typeHints[m.type] || '';
  var typeOptions = ['skill', 'memory', 'provider'].map(function(t) {
    var hasSingleton = (t === 'memory' || t === 'provider') && wcSkills.some(function(s){ return s.type === t && (m.mode !== 'edit' || wcSkills.indexOf(s) !== m.idx); });
    return '<option value="'+t+'"'+(m.type===t?' selected':'')+(hasSingleton?' disabled':'')+'>'+t+(hasSingleton?' (esiste già)':'')+'</option>';
  }).join('');
  // Suggested name based on type
  var namePlaceholder = m.type === 'memory' ? 'memory.md' : m.type === 'provider' ? 'liara.md' : 'nome-skill.md';
  return '<div onclick="wcCloseSkillModal(event)" style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center">' +
    '<div onclick="event.stopPropagation()" style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;width:600px;max-width:96vw;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">' +
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">' +
        '<span style="font-size:14px;font-weight:700;color:var(--text);flex:1">' + wcFileTypeIcon(m.type) + ' ' + (isNew ? 'Nuovo file di contesto' : 'Modifica ' + wcEsc(m.name)) + '</span>' +
        '<button onclick="wcCloseSkillModal()" style="background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;line-height:1">&times;</button>' +
      '</div>' +
      '<div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px;flex:1;overflow-y:auto">' +
        (isNew ? (
          '<div style="display:flex;gap:10px">' +
            '<div style="flex:1">' +
              '<div style="font-size:10px;color:var(--dim);margin-bottom:4px">TIPO</div>' +
              '<select id="wcSkillType" onchange="wcSkillTypeChange(this.value)" style="width:100%;padding:7px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border2);background:var(--bg3);color:var(--text)">' + typeOptions + '</select>' +
            '</div>' +
            '<div style="flex:2">' +
              '<div style="font-size:10px;color:var(--dim);margin-bottom:4px">NOME FILE</div>' +
              '<input id="wcSkillName" value="'+wcEsc(m.name||'')+'" placeholder="'+namePlaceholder+'" style="width:100%;padding:7px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);box-sizing:border-box;font-family:var(--mono)">' +
            '</div>' +
          '</div>'
        ) : (
          '<div style="font-size:11px;color:var(--dim);background:var(--bg3);padding:7px 10px;border-radius:6px">File: <code style="color:var(--text)">'+wcEsc(m.name)+'</code> '+wcFileTypeBadge(m.type)+'</div>'
        )) +
        '<div style="background:var(--bg3);border-radius:8px;padding:9px 11px;font-size:10px;color:var(--dim);line-height:1.5">' +
          '&#128161; ' + wcEsc(hint) +
        '</div>' +
        '<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px">' +
          '<div style="font-size:10px;color:var(--dim);margin-bottom:6px">&#129302; GENERA CON AI</div>' +
          '<div style="display:flex;gap:8px">' +
            '<textarea id="wcSkillAiDesc" rows="2" placeholder="Descrivi cosa deve contenere questo file... (es. Istruzioni per integrare Stripe con Express, pattern webhook)" style="flex:1;padding:7px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border2);background:var(--bg2);color:var(--text);resize:none;font-family:inherit"></textarea>' +
            '<button onclick="wcGenerateSkill()" '+(m.generating?'disabled':'')+' style="padding:8px 12px;background:var(--green3);border:none;border-radius:6px;color:var(--bg);font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;align-self:flex-end">'+(m.generating?'&#9203; ...':'&#9654; Genera')+'</button>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div style="font-size:10px;color:var(--dim);margin-bottom:4px;display:flex;justify-content:space-between">' +
            '<span>CONTENUTO (markdown)</span>' +
            '<span style="color:'+(warnLen?'#e05050':'var(--dim)')+'">'+charCount+' car.'+(warnLen?' &#9888; Troppo lungo, potrebbe ridurre la qualita del contesto':'')+'</span>' +
          '</div>' +
          '<textarea id="wcSkillContent" rows="14" oninput="wcSkillContentChange(this.value)" placeholder="# Titolo'+String.fromCharCode(10)+'Scrivi le istruzioni in Markdown..." style="width:100%;padding:8px 10px;font-size:11px;border-radius:6px;border:1px solid '+(warnLen?'#e05050':'var(--border2)')+';background:var(--bg3);color:var(--text);resize:vertical;box-sizing:border-box;font-family:var(--mono);line-height:1.6">'+wcEsc(m.content||'')+'</textarea>' +
        '</div>' +
      '</div>' +
      '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">' +
        '<button onclick="wcCloseSkillModal()" style="padding:8px 16px;background:var(--bg3);border:1px solid var(--border2);border-radius:7px;color:var(--dim);font-size:12px;cursor:pointer">Annulla</button>' +
        '<button onclick="wcSaveSkill()" style="padding:8px 18px;background:var(--green3);border:none;border-radius:7px;color:var(--bg);font-size:12px;font-weight:700;cursor:pointer">&#10003; Salva</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function wcSkillTypeChange(newType) {
  if (!wcSkillModal) return;
  wcSkillModal.type = newType;
  // Auto-fill name for singletons
  if (newType === 'memory') wcSkillModal.name = 'memory.md';
  else if (newType === 'provider') wcSkillModal.name = 'liara.md';
  else wcSkillModal.name = '';
  renderWebCraft(document.getElementById('content'));
}

function wcSkillContentChange(val) {
  if (!wcSkillModal) return;
  wcSkillModal.content = val;
  // Re-render only the char counter without full re-render
  var maxChars = wcSkillModal.type === 'skill' ? 6000 : 4000;
  var warnLen = val.length > maxChars;
  var el = document.querySelector('#wcSkillContent');
  if (el) el.style.borderColor = warnLen ? '#e05050' : 'var(--border2)';
}

function wcNewSkill() {
  wcSkillModal = { mode: 'new', idx: null, name: '', content: '', type: 'skill', generating: false };
  renderWebCraft(document.getElementById('content'));
}

function wcOpenSkill(si) {
  var s = wcSkills[si];
  if (!s) return;
  var mode = (s.type === 'log') ? 'view' : 'edit';
  wcSkillModal = { mode: mode, idx: si, name: s.name, content: s.content, type: s.type || 'skill', generating: false };
  renderWebCraft(document.getElementById('content'));
}

function wcCloseSkillModal(e) {
  if (e && e.target !== e.currentTarget) return;
  wcSkillModal = null;
  renderWebCraft(document.getElementById('content'));
}

async function wcClearSkill(si) {
  var s = wcSkills[si];
  if (!s) return;
  if (!confirm('Svuotare il file "' + s.name + '"? Il file rimane ma il contenuto viene cancellato.')) return;
  wcSkills[si].content = '';
  await wcPersistSkills();
  renderWebCraft(document.getElementById('content'));
}

async function wcGenerateSkill() {
  var descEl = document.getElementById('wcSkillAiDesc');
  var nameEl = document.getElementById('wcSkillName');
  var typeEl = document.getElementById('wcSkillType');
  var desc = (descEl ? descEl.value : '').trim();
  if (!desc) { alert('Descrivi prima cosa deve contenere il file.'); return; }
  wcSkillModal.generating = true;
  if (nameEl) wcSkillModal.name = nameEl.value;
  if (typeEl) wcSkillModal.type = typeEl.value;
  renderWebCraft(document.getElementById('content'));
  var systemByType = {
    skill: 'Sei un esperto di sviluppo web fullstack. Genera un file Markdown "skill" per il WebCraft Agent di NotHumanAllowed. Deve contenere istruzioni, pattern di codice, best practice e snippet pronti all uso come contesto persistente. Scrivi SOLO il contenuto Markdown, niente altro.',
    memory: 'Sei un assistente tecnico. Genera un file Markdown "memory" per il WebCraft Agent. Deve riassumere decisioni architetturali, preferenze dello sviluppatore e contesto generale del progetto. Scrivi SOLO il Markdown.',
    provider: 'Sei un esperto di prompt engineering. Genera un file Markdown con istruzioni specifiche per calibrare il comportamento del modello AI (tono, formato risposte, vincoli, preferenze). Scrivi SOLO il Markdown.'
  };
  try {
    var r = await fetch(API + '/api/studio/webcraft', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        system: systemByType[wcSkillModal.type] || systemByType.skill,
        user: 'Progetto: ' + wcState.projectName + String.fromCharCode(10) + 'Stack: Express.js, PostgreSQL, JWT auth' + String.fromCharCode(10) + String.fromCharCode(10) + desc,
        max_tokens: 2048
      })
    });
    if (r.ok) {
      var d = await r.json();
      wcSkillModal.content = d.text || '';
      wcSkillModal.generating = false;
      // Auto-suggest name if empty
      if (!wcSkillModal.name && desc.length > 0) {
        if (wcSkillModal.type === 'memory') wcSkillModal.name = 'memory.md';
        else if (wcSkillModal.type === 'provider') wcSkillModal.name = 'liara.md';
        else wcSkillModal.name = desc.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) + '.md';
      }
    }
  } catch(e) {}
  wcSkillModal.generating = false;
  renderWebCraft(document.getElementById('content'));
}

async function wcSaveSkill() {
  var nameEl = document.getElementById('wcSkillName');
  var contentEl = document.getElementById('wcSkillContent');
  var typeEl = document.getElementById('wcSkillType');
  var name = (nameEl ? nameEl.value : wcSkillModal.name).trim();
  var content = contentEl ? contentEl.value : (wcSkillModal.content || '');
  var type = (typeEl ? typeEl.value : wcSkillModal.type) || 'skill';
  if (!name) { alert('Inserisci un nome per il file.'); return; }
  if (!name.endsWith('.md')) name = name + '.md';
  // Enforce singleton: only one memory, one provider
  if ((type === 'memory' || type === 'provider') && wcSkillModal.mode === 'new') {
    var existing = wcSkills.findIndex(function(s){ return s.type === type; });
    if (existing >= 0) { alert('Esiste gia un file di tipo "' + type + '". Modificalo direttamente.'); return; }
  }
  var skill = { name: name, content: content, type: type };
  if (wcSkillModal.mode === 'edit' && wcSkillModal.idx !== null) {
    wcSkills[wcSkillModal.idx] = skill;
  } else {
    wcSkills.push(skill);
  }
  wcSkillModal = null;
  await wcPersistSkills();
  renderWebCraft(document.getElementById('content'));
}

async function wcDeleteSkill(si) {
  var s = wcSkills[si];
  if (!s) return;
  if (!confirm('Eliminare "' + s.name + '"?')) return;
  // Delete the file on disk via the delete-skill endpoint
  try {
    await fetch(API + '/api/studio/webcraft/skills/' + encodeURIComponent(wcState.projectName) + '/delete', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: s.name })
    });
  } catch(_) {}
  wcSkills.splice(si, 1);
  renderWebCraft(document.getElementById('content'));
}

async function wcPersistSkills() {
  if (!wcState.projectName) return;
  try {
    await fetch(API + '/api/studio/webcraft/skills/' + encodeURIComponent(wcState.projectName), {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ skills: wcSkills })
    });
  } catch(_) {}
}

// ── WebCraft Agent Chat Panel ─────────────────────────────────────────────
function wcChatPanelHtml() {
  var hasProject = wcState.projectName && wcState.generatedFiles.length > 0;
  var placeholder = hasProject
    ? 'Parla con il tuo agente: chiedi correzioni, migliorie, nuove funzionalit\u00e0...'
    : 'Descrivi il progetto da creare, poi premi Genera...';

  // Chat messages
  var messagesHtml = '';
  if (wcChat.length === 0 && hasProject) {
    messagesHtml = '<div style="font-size:11px;color:var(--dim);padding:8px 12px;font-style:italic">&#129302; Pronto! Dimmi cosa vuoi modificare o migliorare nel progetto.</div>';
  }
  for (var mi = 0; mi < wcChat.length; mi++) {
    var msg = wcChat[mi];
    if (msg.role === 'user') {
      messagesHtml += '<div style="display:flex;justify-content:flex-end;margin:4px 12px">' +
        '<div style="background:var(--green3);color:var(--bg);padding:6px 12px;border-radius:10px 10px 2px 10px;font-size:11px;max-width:70%;line-height:1.5">'+wcEsc(msg.text)+'</div>' +
      '</div>';
      if (msg.attachments && msg.attachments.length) {
        messagesHtml += '<div style="display:flex;justify-content:flex-end;margin:2px 12px;gap:4px">' +
          msg.attachments.map(function(a){ return '<span style="background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:2px 7px;font-size:10px;color:var(--dim)">&#128206; '+wcEsc(a.name)+'</span>'; }).join('') +
        '</div>';
      }
    } else if (msg.role === 'system') {
      // System messages: compact notices (snapshot, syntax check, error with fix button)
      var isSandboxErr = (msg.text || '').indexOf('Errore sandbox') !== -1;
      var borderColor = isSandboxErr ? '#ef4444' : 'var(--border2)';
      var textColor = isSandboxErr ? '#fca5a5' : 'var(--dim)';
      messagesHtml += '<div style="margin:4px 12px;padding:6px 10px;background:var(--bg3);border-left:2px solid '+borderColor+';border-radius:4px;font-size:10px;color:'+textColor+';display:flex;align-items:center;gap:8px">' +
        '<span style="flex:1">' + (msg.text||'') + '</span>' +
        (isSandboxErr ? '<button onclick="wcFixSandboxError()" style="flex-shrink:0;padding:4px 10px;background:#7f1d1d;border:1px solid #ef4444;border-radius:5px;color:#fca5a5;font-size:10px;font-weight:700;cursor:pointer">&#129302; Correggi</button>' : '') +
      '</div>';
      if (msg.syntaxErrors && msg.syntaxErrors.length) {
        messagesHtml += '<div style="margin:2px 12px">' + msg.syntaxErrors.map(function(e2){
          return '<div style="font-size:10px;font-family:var(--mono);color:#f87171;padding:2px 0">&#10005; ' + wcEsc(e2.file) + ': ' + wcEsc(e2.error) + '</div>';
        }).join('') + '</div>';
      }
    } else {
      var diffBlocks = '';
      var toolBadges = (msg.tools || []).map(function(tool){
        var isOk = tool.result === 'ok';
        var isParseErr = tool.op === 'parse_error';
        var icon = isParseErr ? '&#10067;' : (tool.op === 'edit' ? '&#9998;' : (tool.op === 'write' ? '&#10133;' : '&#128065;'));
        var color = isOk ? 'var(--green)' : 'var(--red)';
        var label = isParseErr ? ('JSON err: ' + wcEsc(tool.result)) : wcEsc(tool.path);
        var title = isOk ? tool.op + ': ' + tool.path : (tool.result || '');
        // Build inline diff block for successful edits/writes — always visible, no collapse
        if (isOk && (tool.op === 'edit' || tool.op === 'write') && (tool.oldSnippet || tool.newSnippet)) {
          var oldLines = tool.oldSnippet ? tool.oldSnippet.split(String.fromCharCode(10)).map(function(l){ return '<div style="background:#3f0f0f;color:#fca5a5;font-family:var(--mono);font-size:9px;padding:1px 8px;white-space:pre-wrap;word-break:break-all">- '+wcEsc(l)+'</div>'; }).join('') : '';
          var newLines = tool.newSnippet ? tool.newSnippet.split(String.fromCharCode(10)).map(function(l){ return '<div style="background:#0f2f0f;color:#86efac;font-family:var(--mono);font-size:9px;padding:1px 8px;white-space:pre-wrap;word-break:break-all">+ '+wcEsc(l)+'</div>'; }).join('') : '';
          diffBlocks += '<div style="margin:4px 0;border:1px solid rgba(255,255,255,0.1);border-radius:5px;overflow:hidden">' +
            '<div style="padding:3px 8px;font-size:9px;font-family:var(--mono);color:var(--dim);background:rgba(255,255,255,0.04);display:flex;align-items:center;gap:4px">' +
              '<span style="color:var(--green)">&#9998;</span> '+wcEsc(tool.path) +
            '</div>' +
            oldLines + newLines +
          '</div>';
        }
        return '<span title="'+wcEsc(title)+'" style="display:inline-flex;align-items:center;gap:3px;background:var(--bg3);border:1px solid '+(isOk?'var(--green3)':'var(--red)')+';border-radius:4px;padding:2px 6px;font-size:9px;font-family:var(--mono);color:'+color+'">' +
          icon + ' ' + label + '</span>';
      }).join(' ');
      var agentText = wcEsc(msg.text.replace(new RegExp('<tool>[\\s\\S]*?<\\/tool>', 'g'), '').trim());
      messagesHtml += '<div style="margin:6px 12px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;background:var(--bg3);overflow:hidden">' +
        '<div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03)">' +
          '<span style="font-size:13px">&#129302;</span>' +
          '<span style="font-size:10px;font-weight:700;color:var(--green)">WebCraft Agent</span>' +
        '</div>' +
        '<div style="padding:8px 10px;font-size:11px;color:var(--text);line-height:1.6;white-space:pre-wrap">'+agentText+'</div>' +
        (diffBlocks ? '<div style="padding:4px 8px 6px;border-top:1px solid rgba(255,255,255,0.06)">'+diffBlocks+'</div>' : '') +
        (toolBadges ? '<div style="display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px;border-top:1px solid rgba(255,255,255,0.06)">'+toolBadges+'</div>' : '') +
      '</div>';
    }
  }
  if (wcChatRunning) {
    messagesHtml +=
      '<div id="wcAgentLiveBubble" style="margin:6px 12px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;background:var(--bg3);overflow:hidden;animation:wcBubbleIn .25s cubic-bezier(.22,1,.36,1)">' +
        '<div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03)">' +
          '<span style="font-size:13px;animation:wcRobotBob .9s ease-in-out infinite">&#129302;</span>' +
          '<span style="font-size:10px;font-weight:700;color:var(--green)">WebCraft Agent</span>' +
          '<span style="margin-left:auto;display:flex;gap:3px;align-items:center">' +
            '<span style="width:5px;height:5px;border-radius:50%;background:var(--green);opacity:.9;animation:wcDot 1.1s ease-in-out infinite 0s"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:var(--green);opacity:.9;animation:wcDot 1.1s ease-in-out infinite .18s"></span>' +
            '<span style="width:5px;height:5px;border-radius:50%;background:var(--green);opacity:.9;animation:wcDot 1.1s ease-in-out infinite .36s"></span>' +
          '</span>' +
        '</div>' +
        '<div id="wcAgentLiveText" style="padding:8px 10px;font-size:11px;color:var(--text);line-height:1.6;white-space:pre-wrap;min-height:24px">' +
          '<span style="display:inline-block;width:2px;height:11px;background:var(--green);vertical-align:text-bottom;animation:streamBlink .7s step-end infinite;margin-left:1px">&#8203;</span>' +
        '</div>' +
      '</div>';
  }

  // Attachments preview
  var attachPreview = '';
  if (wcChatAttachments.length > 0) {
    attachPreview = '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 12px 0">' +
      wcChatAttachments.map(function(a, ai){
        return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:5px;padding:3px 8px;font-size:10px;color:var(--text)">' +
          '&#128206; '+wcEsc(a.name)+' <button onclick="wcRemoveAttachment('+ai+')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;line-height:1;padding:0">&times;</button>' +
        '</span>';
      }).join('') +
    '</div>';
  }

  var sendBtnLabel = wcState.running ? '&#9203;' : (hasProject ? '&#9654;' : '&#9654; Genera');
  var inputDisabled = wcChatRunning || wcState.running;

  // Project name row — shown only when no project yet
  var projNameRow = !hasProject
    ? '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px 0">' +
        '<span style="font-size:10px;color:var(--dim);white-space:nowrap">Nome progetto:</span>' +
        '<input id="wcProjectName" placeholder="MioProgetto" value="'+wcEsc(wcState.projectName)+'" oninput="wcState.projectName=this.value" style="flex:1;padding:4px 8px;font-size:11px;border-radius:5px;border:1px solid var(--border2);background:var(--bg3);color:var(--text)">' +
      '</div>'
    : '<div style="padding:4px 12px 0;font-size:10px;color:var(--dim)">&#128196; <strong style="color:var(--green)">'+wcEsc(wcState.projectName)+'</strong> &mdash; scrivi per modificare o migliorare il progetto</div>';

  return '<div style="border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0;display:flex;flex-direction:column;min-height:220px">' +
    // Messages
    '<div id="wcChatMessages" style="max-height:240px;overflow-y:auto;padding:6px 0">' +
      messagesHtml +
    '</div>' +
    // Attachments
    attachPreview +
    // Project name (only pre-generation)
    projNameRow +
    // Input row
    '<div style="display:flex;align-items:flex-end;gap:8px;padding:8px 12px">' +
      '<label style="cursor:pointer;color:var(--dim);font-size:16px;flex-shrink:0;padding-bottom:2px" title="Allega immagine o PDF">' +
        '&#128206;' +
        '<input type="file" id="wcFileInput" multiple accept="image/*,.pdf" style="display:none" onchange="wcHandleFileAttach(this)">' +
      '</label>' +
      '<textarea id="wcChatInput" rows="4" placeholder="'+placeholder+'" '+(inputDisabled?'disabled':'')+' style="flex:1;padding:8px 10px;font-size:12px;border-radius:8px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);resize:vertical;min-height:80px;line-height:1.5;font-family:inherit" onkeydown="wcChatKeydown(event)"></textarea>' +
      '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">' +
        '<button onclick="wcChatSend()" '+(inputDisabled?'disabled':'')+' style="padding:8px 14px;background:var(--green3);border:none;border-radius:8px;color:var(--bg);font-size:13px;font-weight:700;cursor:pointer;height:38px;white-space:nowrap">'+sendBtnLabel+'</button>' +
        (inputDisabled ? '<button onclick="wcStopAll()" style="padding:5px 10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);border-radius:7px;color:#f87171;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">&#9632; Stop</button>' : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

function wcChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); wcChatSend(); }
}

function wcStopAll() {
  if (_wcGenAbortCtrl) { _wcGenAbortCtrl.abort(); _wcGenAbortCtrl = null; }
  wcState.running = false;
  wcChatRunning = false;
  wcChat.push({ role: 'system', text: '&#9632; Generazione interrotta.' });
  renderWebCraft(document.getElementById('content'));
}

// wcOverlayMinimize/Restore removed — overlay replaced with inline progress bar

function wcRemoveAttachment(ai) {
  wcChatAttachments.splice(ai, 1);
  renderWebCraft(document.getElementById('content'));
}

function wcHandleFileAttach(input) {
  var files = Array.from(input.files || []);
  files.forEach(function(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result;
      var base64 = dataUrl.split(',')[1];
      wcChatAttachments.push({ name: file.name, mimeType: file.type, base64: base64, size: file.size });
      renderWebCraft(document.getElementById('content'));
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
}

async function wcChatSend() {
  var inputEl = document.getElementById('wcChatInput');
  var msg = (inputEl ? inputEl.value : '').trim();
  var hasProject = wcState.projectName && wcState.generatedFiles.length > 0;

  // If no project yet, use as description and generate
  if (!hasProject) {
    if (!msg || msg.length < 5) { alert(t('wc_describe_first')); return; }
    var projNameEl = document.getElementById('wcProjectName');
    if (projNameEl && projNameEl.value.trim()) wcState.projectName = projNameEl.value.trim();
    if (!wcState.projectName) wcState.projectName = 'MyProject';
    wcState.description = msg;
    if (inputEl) inputEl.value = '';
    wcGenerate();
    return;
  }

  if (!msg && wcChatAttachments.length === 0) return;
  if (wcChatRunning || wcState.running) return;
  if (inputEl) inputEl.value = '';

  // Plan mode: if message starts with "/plan " or contains "plan:" keyword, ask agent for plan first
  var planMode = msg.toLowerCase().startsWith('/plan ') || msg.toLowerCase().startsWith('piano: ');
  if (planMode) {
    var planMsg = msg.replace(new RegExp('^/plan[ ]*', 'i'),'').replace(new RegExp('^piano:[ ]*', 'i'),'');
    wcChat.push({ role: 'user', text: msg });
    renderWebCraft(document.getElementById('content'));
    // Ask agent to produce only a plan, no edits
    await wcExecuteAgentCall(
      '[MODALITA PIANO] Descrivi in dettaglio cosa modificheresti per: "' + planMsg + '". ' +
      'Elenca i file che toccheresti e cosa faresti in ciascuno. NON applicare nessuna modifica ancora. ' +
      'Rispondi con il piano in bullet list.',
      false, planMsg
    );
    return;
  }

  var attachCopy = wcChatAttachments.slice();
  wcChatAttachments = [];
  wcChat.push({ role: 'user', text: msg, attachments: attachCopy });
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();

  // Auto-snapshot before first agent call in a session
  if (_wcAutoFixAttempts === 0 && wcChat.filter(function(c){ return c.role==='user'; }).length === 1) {
    wcTakeSnapshot().then(function(ts) {
      if (ts) wcChat.push({ role: 'system', text: '&#128190; Snapshot automatico salvato (' + ts.slice(0,16).replace('T',' ') + ')' });
      renderWebCraft(document.getElementById('content'));
    });
  }

  await wcExecuteAgentCall(msg, false, null, attachCopy);
}

// Core agent call — separated so plan mode and normal mode share the same SSE pipeline
async function wcExecuteAgentCall(message, isPlanExec, planOrigMsg, attachments) {
  if (wcChatRunning) return;
  wcChatRunning = true;
  renderWebCraft(document.getElementById('content'));

  // Track file state BEFORE edits for diff
  var filesBefore = {};
  wcState.generatedFiles.forEach(function(f) { filesBefore[f.name] = f.content; });
  _wcDiffQueue = [];

  try {
    var r = await fetch(API + '/api/studio/webcraft/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: wcState.projectName,
        message: message,
        attachments: (attachments || []).map(function(a){ return { name: a.name, mimeType: a.mimeType, base64: a.base64 }; })
      })
    });

    if (!r.ok) {
      var errData = await r.json().catch(function(){ return {}; });
      wcChat.push({ role: 'agent', text: 'Errore: ' + (errData.error || r.status), tools: [] });
      wcChatRunning = false;
      renderWebCraft(document.getElementById('content'));
      return;
    }

    var agentMsg = { role: 'agent', text: '', tools: [] };
    wcChat.push(agentMsg);

    var reader2 = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    var anyEdits = false;
    while (true) {
      var res = await reader2.read();
      if (res.done) break;
      buf += dec.decode(res.value, { stream: true });
      var parts = buf.split(String.fromCharCode(10)+String.fromCharCode(10));
      buf = parts.pop();
      for (var pi2 = 0; pi2 < parts.length; pi2++) {
        var line = parts[pi2].replace(/^data: /, '').trim();
        if (!line) continue;
        try {
          var ev = JSON.parse(line);
          if (ev.type === 'text') {
            agentMsg.text += ev.token;
            // Inject token directly into live bubble (no re-render)
            var liveEl = document.getElementById('wcAgentLiveText');
            if (liveEl) {
              var cursor = '<span style="display:inline-block;width:2px;height:11px;background:var(--green);vertical-align:text-bottom;animation:streamBlink .7s step-end infinite;margin-left:1px">&#8203;</span>';
              liveEl.innerHTML = wcEsc(agentMsg.text) + cursor;
            }
            wcScrollChatToBottom();
          } else if (ev.type === 'tool') {
            agentMsg.tools.push({ op: ev.op, path: ev.path, result: ev.result, oldSnippet: ev.oldSnippet || '', newSnippet: ev.newSnippet || '' });
            if ((ev.op === 'edit' || ev.op === 'write') && ev.result === 'ok') {
              anyEdits = true;
              wcChat[wcChat.length-1] = agentMsg;
              renderWebCraft(document.getElementById('content'));
            }
          } else if (ev.type === 'done') {
            // Plan mode: detect if response is a plan (no tool edits), show approval banner
            if (planOrigMsg && !anyEdits) {
              _wcPlanPending = { plan: agentMsg.text, originalMessage: planOrigMsg };
            }
            wcChatRunning = false;
            if (ev.changed) {
              // Build diffs before reloading
              var changedFiles = (agentMsg.tools || []).filter(function(t2){ return t2.op === 'edit' || t2.op === 'write'; }).map(function(t2){ return t2.path; });
              await wcReloadProjectFiles();
              // Build diffs from before/after
              changedFiles.forEach(function(fname) {
                var after = wcState.generatedFiles.find(function(f){ return f.name === fname; });
                if (after) _wcDiffQueue.push({ file: fname, before: filesBefore[fname] || '', after: after.content });
              });
              // Auto syntax-check after edits
              if (changedFiles.some(function(f){ return f.endsWith('.js') || f.endsWith('.mjs'); })) {
                setTimeout(wcRunSyntaxCheck, 500);
              }
            }
            // Persist chat
            fetch(API + '/api/studio/webcraft/projects/chat/save', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ projectName: wcState.projectName, chat: wcChat })
            }).catch(function(){});
          } else if (ev.type === 'restart_sandbox') {
            wcStartSandbox();
          } else if (ev.type === 'error') {
            agentMsg.text += String.fromCharCode(10) + 'Errore: ' + ev.msg;
            wcChatRunning = false;
          }
        } catch(_) {}
      }
    }
  } catch(e) {
    wcChat.push({ role: 'agent', text: 'Errore di rete: ' + e.message, tools: [] });
  }

  wcChatRunning = false;
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();
}

function wcScrollChatToBottom() {
  var el2 = document.getElementById('wcChatMessages');
  if (el2) el2.scrollTop = el2.scrollHeight;
}

async function wcReloadProjectFiles() {
  if (!wcState.projectName) return;
  try {
    var r = await fetch(API + '/api/studio/webcraft/projects/load/' + encodeURIComponent(wcState.projectName));
    if (!r.ok) return;
    var d = await r.json();
    wcState.generatedFiles = d.files || [];
    renderWebCraft(document.getElementById('content'));
  } catch(_) {}
}

// Auto-fix: poll autofix-queue every 3s while sandbox running
function wcStartAutoFixPoller() {
  if (_wcAutoFixTimer) return;
  _wcAutoFixTimer = setInterval(function() {
    if (!wcState.sandbox.running && !wcState.sandbox.port) { wcStopAutoFixPoller(); return; }
    fetch(API + '/api/studio/webcraft/agent/autofix-queue').then(function(r){ return r.json(); }).then(function(d){
      var items = d.items || [];
      items.forEach(function(item) {
        if (item.type === 'module_not_found' && _wcAutoFixAttempts < 3) {
          _wcAutoFixAttempts++;
          wcTriggerAutoFix(item.module);
        } else if (item.type === 'crash_error' && _wcAutoFixAttempts < 3) {
          _wcAutoFixAttempts++;
          wcTriggerCrashFix(item.error);
        }
      });
    }).catch(function(){});
  }, 3000);
}

function wcStopAutoFixPoller() {
  if (_wcAutoFixTimer) { clearInterval(_wcAutoFixTimer); _wcAutoFixTimer = null; }
}

async function wcTriggerAutoFix(missingModule) {
  if (wcChatRunning) {
    var waited = 0;
    await new Promise(function(resolve) {
      var t = setInterval(function() { waited += 500; if (!wcChatRunning || waited >= 30000) { clearInterval(t); resolve(); } }, 500);
    });
    if (wcChatRunning) return;
  }
  var fixMsg = 'AUTO-FIX: Cannot find module ' + missingModule + String.fromCharCode(10) + 'Analizza tutti i file del progetto e correggi il require/import per questo modulo. Se il modulo non esiste, rimuovi il require e implementa la funzionalita con moduli disponibili o Node.js built-in.';
  wcChat.push({ role: 'user', text: '\uD83E\uDD16 Auto-fix modulo mancante: ' + missingModule });
  wcChatRunning = true;
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();

  try {
    var r = await fetch(API + '/api/studio/webcraft/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: wcState.projectName, message: fixMsg, autofix: true })
    });
    if (!r.ok) { wcChatRunning = false; renderWebCraft(document.getElementById('content')); return; }

    var agentMsg = { role: 'agent', text: '', tools: [] };
    wcChat.push(agentMsg);
    var reader3 = r.body.getReader();
    var dec2 = new TextDecoder();
    var buf2 = '';
    while (true) {
      var res2 = await reader3.read();
      if (res2.done) break;
      buf2 += dec2.decode(res2.value, { stream: true });
      var parts2 = buf2.split(String.fromCharCode(10)+String.fromCharCode(10));
      buf2 = parts2.pop();
      for (var pi3 = 0; pi3 < parts2.length; pi3++) {
        var line2 = parts2[pi3].replace(/^data: /, '').trim();
        if (!line2) continue;
        try {
          var ev2 = JSON.parse(line2);
          if (ev2.type === 'text') { agentMsg.text += ev2.token; }
          else if (ev2.type === 'tool') { agentMsg.tools.push({ op: ev2.op, path: ev2.path, result: ev2.result, oldSnippet: ev2.oldSnippet || '', newSnippet: ev2.newSnippet || '' }); }
          else if (ev2.type === 'done') { wcChatRunning = false; if (ev2.changed) { wcReloadProjectFiles(); } }
          else if (ev2.type === 'restart_sandbox') { wcStartSandbox(); }
          else if (ev2.type === 'error') { agentMsg.text += String.fromCharCode(10)+'Errore: '+ev2.msg; wcChatRunning = false; }
        } catch(_) {}
      }
    }
  } catch(_) {}

  wcChatRunning = false;
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();
}
async function wcTriggerCrashFix(errorMsg) {
  if (wcChatRunning) {
    // Wait up to 30s for current agent to finish, then retry
    var waited = 0;
    await new Promise(function(resolve) {
      var t = setInterval(function() { waited += 500; if (!wcChatRunning || waited >= 30000) { clearInterval(t); resolve(); } }, 500);
    });
    if (wcChatRunning) return;
  }
  var attemptNum = _wcAutoFixAttempts;
  var fixMsg = 'CRASH FIX RICHIESTO (tentativo ' + attemptNum + '/3).' + String.fromCharCode(10) + 'ERRORE:' + String.fromCharCode(10) + errorMsg + String.fromCharCode(10) + String.fromCharCode(10) + 'REGOLE OBBLIGATORIE:' + String.fromCharCode(10) + '1. Leggi i file coinvolti nello stack trace con view_file' + String.fromCharCode(10) + '2. Individua la riga esatta del problema' + String.fromCharCode(10) + '3. Usa edit_file per patch chirurgiche. SE edit_file fallisce con "old_string non trovato", usa SUBITO write_file per riscrivere il file intero correttamente' + String.fromCharCode(10) + '4. NON spiegare - MODIFICA i file. Se non usi edit_file o write_file il problema non viene risolto' + String.fromCharCode(10) + (attemptNum > 1 ? '5. ATTENZIONE: tentativi precedenti sono falliti. Usa write_file per riscrivere completamente i file problematici invece di patch parziali.' : '5. Dopo la modifica il sandbox si riavvia automaticamente');
  wcChat.push({ role: 'user', text: '\uD83E\uDD16 Auto-fix crash: ' + errorMsg });
  wcChatRunning = true;
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();

  try {
    var r = await fetch(API + '/api/studio/webcraft/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: wcState.projectName, message: fixMsg, autofix: true })
    });
    if (!r.ok) { wcChatRunning = false; renderWebCraft(document.getElementById('content')); return; }

    var agentMsg = { role: 'agent', text: '', tools: [] };
    wcChat.push(agentMsg);
    var reader4 = r.body.getReader();
    var dec4 = new TextDecoder();
    var buf4 = '';
    while (true) {
      var res4 = await reader4.read();
      if (res4.done) break;
      buf4 += dec4.decode(res4.value, { stream: true });
      var parts4 = buf4.split(String.fromCharCode(10)+String.fromCharCode(10));
      buf4 = parts4.pop();
      for (var pi4 = 0; pi4 < parts4.length; pi4++) {
        var line4 = parts4[pi4].replace(/^data: /, '').trim();
        if (!line4) continue;
        try {
          var ev4 = JSON.parse(line4);
          if (ev4.type === 'text') { agentMsg.text += ev4.token; }
          else if (ev4.type === 'tool') { agentMsg.tools.push({ op: ev4.op, path: ev4.path, result: ev4.result, oldSnippet: ev4.oldSnippet || '', newSnippet: ev4.newSnippet || '' }); }
          else if (ev4.type === 'done') { wcChatRunning = false; if (ev4.changed) { wcReloadProjectFiles(); } if (agentMsg.tools.length > 0) { setTimeout(function(){ wcStartSandbox(); }, 500); } }
          else if (ev4.type === 'restart_sandbox') { wcStartSandbox(); }
          else if (ev4.type === 'error') { agentMsg.text += String.fromCharCode(10)+'Errore: '+ev4.msg; wcChatRunning = false; }
        } catch(_) {}
      }
    }
  } catch(_) {}

  wcChatRunning = false;
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();
}

var _wcPhaseKeys = ['files','shims','pkg','env','deps','install','start'];
function wcTogglePhase(idx) { var k = _wcPhaseKeys[idx]; if (k) { wcSandboxExpanded[k] = !wcSandboxExpanded[k]; renderWebCraft(document.getElementById('content')); } }

function wcMainTabNew() { wcMainTab = 'new'; renderWebCraft(document.getElementById('content')); }
function wcMainTabProjects() {
  wcMainTab = 'projects';
  renderWebCraft(document.getElementById('content'));
  // Load projects list from server
  fetch(API + '/api/studio/webcraft/projects').then(function(r){ return r.json(); }).then(function(d){
    wcProjectsList = d.projects || [];
    renderWebCraft(document.getElementById('content'));
  }).catch(function(){});
}

function wcProjectsPanelHtml() {
  if (!wcProjectsList.length) {
    return '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;padding:40px;color:var(--dim)">' +
      '<div style="font-size:32px">&#128193;</div>' +
      '<div style="font-size:13px">'+t('wc_no_projects')+'</div>' +
      '<div style="font-size:11px">'+t('wc_no_projects_hint')+'</div>' +
    '</div>';
  }
  return '<div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px 0">' +
    wcProjectsList.map(function(p, pi){
      var date = p.createdAt ? new Date(p.createdAt).toLocaleString() : '';
      return '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:2px">'+wcEsc(p.name)+'</div>' +
          '<div style="font-size:10px;color:var(--dim);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+wcEsc(p.description||'')+'</div>' +
          '<div style="display:flex;gap:10px;font-size:10px;color:var(--dim)">' +
            '<span>&#128196; '+p.fileCount+' file</span>' +
            '<span>&#128197; '+date+'</span>' +
            '<span style="font-family:var(--mono);font-size:9px">'+wcEsc(p.dir||'')+'</span>' +
          '</div>' +
        '</div>' +
        '<button onclick="wcLoadProject('+pi+')" style="padding:6px 14px;background:var(--green3);border:none;border-radius:6px;color:var(--bg);font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0">&#8599; Apri</button>' +
        '<button onclick="wcDeleteProject('+pi+')" style="padding:6px 10px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--red);font-size:11px;cursor:pointer;flex-shrink:0">&#128465;</button>' +
      '</div>';
    }).join('') +
  '</div>';
}

async function wcLoadProject(pi) {
  var p = wcProjectsList[pi];
  if (!p) return;
  var r = await fetch(API + '/api/studio/webcraft/projects/load/' + encodeURIComponent(p.name));
  if (!r.ok) return;
  var d = await r.json();
  wcState.projectName = d.projectName || p.name;
  wcState.description = d.description || '';
  wcState.generatedFiles = d.files || [];
  wcState.activeFile = 0;
  wcMainTab = 'new';
  wcRightTab = 'files';
  // Load persisted chat history
  try {
    var cr = await fetch(API + '/api/studio/webcraft/projects/chat/load/' + encodeURIComponent(wcState.projectName));
    if (cr.ok) { var cd = await cr.json(); wcChat = cd.chat || []; }
  } catch(_) { wcChat = []; }
  // Load skills for this project
  _wcSkillsLoaded = false;
  wcSkills = [];
  try {
    var sr = await fetch(API + '/api/studio/webcraft/skills/' + encodeURIComponent(wcState.projectName));
    if (sr.ok) { var sd = await sr.json(); wcSkills = sd.skills || []; _wcSkillsLoaded = true; }
  } catch(_) {}
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();
}

async function wcDeleteProject(pi) {
  var p = wcProjectsList[pi];
  if (!p) return;
  if (!confirm('Eliminare: ' + p.name + ' - ' + p.dir + ' ?')) return;
  await fetch(API + '/api/studio/webcraft/projects/' + encodeURIComponent(p.name), {method:'DELETE'});
  wcProjectsList.splice(pi, 1);
  // If the deleted project was the currently open one, reset all state
  if (wcState.projectName === p.name) {
    wcState.projectName = '';
    wcState.generatedFiles = [];
    wcState.activeFile = 0;
    wcState.description = '';
    wcChat = [];
  }
  renderWebCraft(document.getElementById('content'));
}
function wcUpdateField(i, val) { wcState.authFields[i].label = val; }
function wcUpdateFieldType(i, t) { wcState.authFields[i].type = t; }
function wcToggleRequired(i, v) { wcState.authFields[i].required = v; }
function wcRemoveField(i) { wcState.authFields.splice(i,1); renderWebCraft(document.getElementById('content')); }
function wcAddField() {
  wcState.authFields.push({name:'field'+wcState.authFields.length,label:'New field',type:'text',required:false});
  renderWebCraft(document.getElementById('content'));
}
function wcSetFile(i) {
  wcState.activeFile = i;
  renderWebCraft(document.getElementById('content'));
  // Scroll active tab into view after render
  var tab = document.getElementById('wcTab' + i);
  if (tab) tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

// ── WebCraft: Diff Viewer ─────────────────────────────────────────────────────
function wcDiffLines(before, after) {
  var NL = String.fromCharCode(10);
  var bLines = (before || '').split(NL);
  var aLines = (after  || '').split(NL);
  var html = '';
  var maxLen = Math.max(bLines.length, aLines.length);
  var bi = 0, ai = 0;
  while (bi < bLines.length || ai < aLines.length) {
    var bL = bLines[bi], aL = aLines[ai];
    if (bL === aL) {
      html += '<div style="font-family:var(--mono);font-size:10px;padding:1px 8px;color:var(--dim);white-space:pre-wrap">&nbsp;' + wcEsc(bL||'') + '</div>';
      bi++; ai++;
    } else if (bi >= bLines.length) {
      html += '<div style="font-family:var(--mono);font-size:10px;padding:1px 8px;background:#0a3a1a;color:#4ade80;white-space:pre-wrap">+' + wcEsc(aL||'') + '</div>';
      ai++;
    } else if (ai >= aLines.length) {
      html += '<div style="font-family:var(--mono);font-size:10px;padding:1px 8px;background:#3a0a0a;color:#f87171;white-space:pre-wrap">-' + wcEsc(bL||'') + '</div>';
      bi++;
    } else {
      html += '<div style="font-family:var(--mono);font-size:10px;padding:1px 8px;background:#3a0a0a;color:#f87171;white-space:pre-wrap">-' + wcEsc(bL||'') + '</div>';
      html += '<div style="font-family:var(--mono);font-size:10px;padding:1px 8px;background:#0a3a1a;color:#4ade80;white-space:pre-wrap">+' + wcEsc(aL||'') + '</div>';
      bi++; ai++;
    }
    if (bi > maxLen + 50 && ai > maxLen + 50) break; // safety
  }
  return html;
}

function wcDiffPanelHtml() {
  if (_wcDiffQueue.length === 0) return '';
  var items = _wcDiffQueue.map(function(d, di) {
    var addedLines = (d.after||'').split(String.fromCharCode(10)).length - (d.before||'').split(String.fromCharCode(10)).length;
    var sign = addedLines >= 0 ? '+' : '';
    return '<details open style="border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg3)">' +
      '<summary style="padding:7px 10px;cursor:pointer;font-size:11px;font-family:var(--mono);color:var(--text);list-style:none;display:flex;align-items:center;gap:8px">' +
        '<span style="color:var(--green);font-size:10px">&#9650;</span>' +
        '<span style="flex:1">' + wcEsc(d.file) + '</span>' +
        '<span style="color:' + (addedLines >= 0 ? '#4ade80' : '#f87171') + ';font-size:10px">' + sign + addedLines + ' linee</span>' +
      '</summary>' +
      '<div style="max-height:200px;overflow-y:auto;border-top:1px solid var(--border)">' + wcDiffLines(d.before, d.after) + '</div>' +
    '</details>';
  }).join('');
  return '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:8px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
      '<div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px">&#128268; Diff — ' + _wcDiffQueue.length + ' file modificati</div>' +
      '<button onclick="wcClearDiff()" style="font-size:10px;background:none;border:none;color:var(--dim);cursor:pointer">&#10005; Chiudi</button>' +
    '</div>' +
    items +
  '</div>';
}

// ── WebCraft: Snapshot / Rollback ─────────────────────────────────────────────
async function wcManualSnapshot() {
  var ts = await wcTakeSnapshot();
  if (ts) {
    wcChat.push({ role: 'system', text: '&#128190; Snapshot salvato (' + ts.slice(0,16).replace('T',' ') + ')' });
    await wcLoadSnapshots();
    renderWebCraft(document.getElementById('content'));
  }
}

async function wcTakeSnapshot() {
  if (!wcState.projectName) return null;
  try {
    var r = await fetch(API + '/api/studio/webcraft/snapshot', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectName: wcState.projectName })
    });
    if (r.ok) { var d = await r.json(); return d.snapshot; }
  } catch(_) {}
  return null;
}

async function wcLoadSnapshots() {
  if (!wcState.projectName) return;
  try {
    var r = await fetch(API + '/api/studio/webcraft/snapshots/' + encodeURIComponent(wcState.projectName));
    if (r.ok) { var d = await r.json(); _wcSnapshots = d.snapshots || []; renderWebCraft(document.getElementById('content')); }
  } catch(_) {}
}

async function wcRestoreSnapshot(ts) {
  if (!confirm('Ripristinare lo snapshot del ' + ts.replace('T',' ').replace(/-/g,':').slice(0,16) + '? I file attuali verranno sovrascritti.')) return;
  try {
    var r = await fetch(API + '/api/studio/webcraft/restore', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectName: wcState.projectName, ts: ts })
    });
    if (r.ok) {
      wcChat.push({ role: 'agent', text: 'Snapshot ripristinato (' + ts + '). Ricarico i file...' });
      await wcReloadProjectFiles();
    }
  } catch(_) {}
}

function wcSnapshotsPanelHtml() {
  if (_wcSnapshots.length === 0) return '';
  return '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px">' +
    '<div style="font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">&#128190; Snapshot</div>' +
    _wcSnapshots.slice(0,5).map(function(s) {
      var label = s.ts.replace('T',' ').replace(/-/g,':').slice(0,16);
      return '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:10px">' +
        '<span style="flex:1;color:var(--dim);font-family:var(--mono)">' + label + '</span>' +
        '<span style="color:var(--dim)">' + s.fileCount + 'f</span>' +
        '<button onclick="wcRestoreSnapshot(' + JSON.stringify(s.ts) + ')" style="padding:2px 8px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;color:var(--dim);font-size:10px;cursor:pointer">&#8635;</button>' +
      '</div>';
    }).join('') +
  '</div>';
}

// ── WebCraft: Syntax Check ────────────────────────────────────────────────────
async function wcRunSyntaxCheck() {
  if (!wcState.projectName) return;
  try {
    var r = await fetch(API + '/api/studio/webcraft/syntax-check', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectName: wcState.projectName })
    });
    if (r.ok) {
      var d = await r.json();
      _wcSyntaxResults = d.results || [];
      var errors = _wcSyntaxResults.filter(function(x){ return !x.ok; });
      if (errors.length > 0) {
        wcChat.push({ role: 'system', text: '&#9888; Syntax check: ' + errors.length + ' errore/i trovato/i. Clicca "Fix" per correggere automaticamente.', syntaxErrors: errors });
      } else {
        wcChat.push({ role: 'system', text: '&#10003; Syntax check: tutti i file JS sono validi.' });
      }
      renderWebCraft(document.getElementById('content'));
      wcScrollChatToBottom();
    }
  } catch(_) {}
}

// ── WebCraft: Grep / Search ───────────────────────────────────────────────────
async function wcRunGrep() {
  var el = document.getElementById('wcGrepInput');
  var q = el ? el.value.trim() : _wcGrepQuery;
  if (!q || !wcState.projectName) return;
  _wcGrepQuery = q;
  try {
    var r = await fetch(API + '/api/studio/webcraft/grep', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectName: wcState.projectName, query: q })
    });
    if (r.ok) { var d = await r.json(); _wcGrepResults = d.matches || []; renderWebCraft(document.getElementById('content')); }
  } catch(_) {}
}

function wcGrepPanelHtml() {
  if (!_wcGrepOpen) return '';
  var resultsHtml = _wcGrepResults.length > 0
    ? _wcGrepResults.map(function(m) {
        return '<div style="padding:4px 8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="wcJumpToFile(' + JSON.stringify(m.file) + ')">' +
          '<span style="font-size:10px;color:var(--green);font-family:var(--mono)">' + wcEsc(m.file) + ':' + m.lineNum + '</span>' +
          '<pre style="margin:2px 0 0;font-size:10px;color:var(--text);white-space:pre-wrap;overflow:hidden;max-height:30px">' + wcEsc(m.line) + '</pre>' +
        '</div>';
      }).join('')
    : '<div style="font-size:11px;color:var(--dim);padding:8px">Nessun risultato.</div>';
  return '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:8px">' +
    '<div style="display:flex;gap:6px;margin-bottom:8px">' +
      '<input id="wcGrepInput" value="'+wcEsc(_wcGrepQuery)+'" placeholder="Cerca nel codice..." onkeydown="wcGrepKeydown(event)" style="flex:1;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);font-family:var(--mono)">' +
      '<button onclick="wcRunGrep()" style="padding:6px 12px;background:var(--green3);border:none;border-radius:6px;color:var(--bg);font-size:11px;font-weight:700;cursor:pointer">&#128269;</button>' +
      '<button onclick="wcCloseGrep()" style="padding:6px 8px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--dim);cursor:pointer">&times;</button>' +
    '</div>' +
    (_wcGrepResults.length > 0 ? '<div style="font-size:9px;color:var(--dim);margin-bottom:4px">' + _wcGrepResults.length + ' risultati</div>' : '') +
    '<div style="max-height:200px;overflow-y:auto">' + resultsHtml + '</div>' +
  '</div>';
}

function wcClearDiff() { _wcDiffQueue = []; renderWebCraft(document.getElementById('content')); }
function wcCloseGrep() { _wcGrepOpen = false; renderWebCraft(document.getElementById('content')); }
function wcGrepKeydown(e) { if (e.key === 'Enter') wcRunGrep(); }

function wcJumpToFile(fname) {
  var idx = wcState.generatedFiles.findIndex(function(f){ return f.name === fname; });
  if (idx >= 0) { wcState.activeFile = idx; wcRightTab = 'files'; renderWebCraft(document.getElementById('content')); }
}

function wcToggleGrep() { _wcGrepOpen = !_wcGrepOpen; renderWebCraft(document.getElementById('content')); }

// ── WebCraft: Plan Mode ───────────────────────────────────────────────────────
function wcPlanBannerHtml() {
  if (!_wcPlanPending) return '';
  return '<div style="background:#1a2a1a;border:1px solid var(--green3);border-radius:10px;padding:14px;margin-bottom:8px">' +
    '<div style="font-size:11px;font-weight:700;color:var(--green);margin-bottom:8px">&#128204; Piano proposto — approva per eseguire</div>' +
    '<pre style="font-size:11px;color:var(--text);white-space:pre-wrap;margin:0 0 10px;max-height:120px;overflow-y:auto;font-family:var(--mono)">' + wcEsc(_wcPlanPending.plan) + '</pre>' +
    '<div style="display:flex;gap:8px">' +
      '<button onclick="wcApprovePlan()" style="padding:7px 18px;background:var(--green3);border:none;border-radius:7px;color:var(--bg);font-size:12px;font-weight:700;cursor:pointer">&#10003; Esegui</button>' +
      '<button onclick="wcRejectPlan()" style="padding:7px 14px;background:none;border:1px solid var(--border2);border-radius:7px;color:var(--dim);font-size:12px;cursor:pointer">&#10005; Annulla</button>' +
    '</div>' +
  '</div>';
}

async function wcApprovePlan() {
  if (!_wcPlanPending) return;
  var msg = _wcPlanPending.originalMessage;
  _wcPlanPending = null;
  await wcExecuteAgentCall(msg + String.fromCharCode(10) + '[Piano approvato — procedi con le modifiche]', false);
}

function wcRejectPlan() {
  wcChat.push({ role: 'agent', text: 'Piano annullato. Dimmi se vuoi modificare la richiesta.' });
  _wcPlanPending = null;
  renderWebCraft(document.getElementById('content'));
  wcScrollChatToBottom();
}

async function wcGenerate() {
  if (wcState.running) return;
  var desc = wcState.description;
  var projName = wcState.projectName || 'myproject';
  if (!desc || desc.length < 5) { alert(t('wc_describe_first')); return; }
  wcState.description = desc;
  wcState.projectName = projName;
  wcState.running = true;
  wcState.generatedFiles = [];
  wcState.activeFile = 0;
  _wcGenAbortCtrl = new AbortController();
  renderWebCraft(document.getElementById('content'));

  // Security rules always injected
  var SECURITY_RULES = [
    'ALWAYS use security headers via Express/helmet server-side only. NEVER add X-Frame-Options, Strict-Transport-Security, frame-ancestors, or Content-Security-Policy as HTML meta http-equiv tags — the app runs inside an HTTP iframe sandbox and these meta tags will break resource loading. Only allowed HTML security meta: viewport, charset, X-UA-Compatible, Permissions-Policy.',
    'NEVER put secrets, API keys, or DB credentials in frontend code. Only in .env server-side.',
    'ALWAYS use prepared statements / parameterized queries. NEVER string-concatenate SQL.',
    'ALWAYS hash passwords with bcrypt (cost factor 12+). NEVER store plain passwords.',
    'ALWAYS validate and sanitize all user inputs server-side.',
    'ALWAYS use httpOnly, secure, sameSite=Strict cookies for session tokens.',
    'ALWAYS rate-limit auth endpoints (max 5 attempts / 15min per IP).',
    'CSS MUST follow BEM naming: block__element--modifier. No inline styles except dynamic values.',
    'PostgreSQL: use pg.Pool (max:10, idleTimeoutMillis:30000). Export singleton. Always use parameterized queries.',
    'JWT: access token 15min, refresh token 7 days with rotation. Store refresh in httpOnly cookie.',
  ].join(String.fromCharCode(10));

  var authFieldsDef = wcState.authFields.map(function(f){ return f.label+' ('+f.type+(f.required?', required':'')+')'; }).join(', ');
  var blocksEnabled = Object.keys(wcState.blocks).filter(function(b){ return wcState.blocks[b]; }).join(', ');

  // File plan — always this structure
  var filePlan = [
    { name: 'package.json',          lang: 'json',       prompt: 'Generate package.json for an Express/PostgreSQL project named "'+projName+'". Dependencies: express, pg, bcryptjs, jsonwebtoken, nodemailer, helmet, express-rate-limit, cors, dotenv, express-validator, ioredis. DevDependencies: nodemon. Scripts: start, dev.' },
    { name: '.env.example',          lang: 'bash',       prompt: 'Generate .env.example with all required env vars: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, JWT_SECRET, JWT_REFRESH_SECRET, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SENDGRID_API_KEY (commented as optional fallback), REDIS_URL (default redis://localhost:6379, works with Dragonfly too), PORT, NODE_ENV, CORS_ORIGIN, BASE_URL. Add helpful comments for each. Note that REDIS_URL is optional — app falls back to in-memory LRU if Redis unavailable.' },
    { name: 'server/db.js',          lang: 'javascript', prompt: 'Generate server/db.js: pg.Pool singleton (max:10, idleTimeoutMillis:30000, connectionTimeoutMillis:2000). Circuit breaker: if DB fails 5+ times in 60s, open circuit (throw immediately) for 30s, then half-open (try one query). Export pool, query(text, params) with circuit breaker, transaction(callback) helper (BEGIN/COMMIT/ROLLBACK). Graceful shutdown on SIGTERM/SIGINT.' },
    { name: 'server/middleware/security.js', lang: 'javascript', prompt: 'Generate server/middleware/security.js: detect sandbox via isSandbox = !process.env.NODE_ENV || process.env.NODE_ENV === "development". Use helmet CSP: defaultSrc self, scriptSrc self unsafe-inline, styleSrc self unsafe-inline, imgSrc self data:, connectSrc self, objectSrc none. frameAncestors: if isSandbox use ["self", "http://127.0.0.1:*", "http://localhost:*"] else ["none"]. NO X-Frame-Options DENY (conflicts with frameAncestors). NO HSTS in sandbox (HTTP only). Referrer-Policy strict-origin-when-cross-origin. Add express-rate-limit for general routes (100/15min) and strict limiter for auth (5/15min). Export { applySecurityMiddleware, authLimiter }.' },
    { name: 'server/middleware/validate.js', lang: 'javascript', prompt: 'Generate server/middleware/validate.js using express-validator. Export handleValidationErrors middleware. Export auth field validators: registerValidator (fields: '+authFieldsDef+'), loginValidator (email + password).' },
    { name: 'server/services/email.js', lang: 'javascript', prompt: 'Generate server/services/email.js: Nodemailer transporter using SMTP from env. Function sendVerificationEmail(to, token, baseUrl): sends HTML email with verification link. Function sendPasswordResetEmail(to, token, baseUrl). Add SendGrid fallback (commented out, predisposed with transporter swap). Never expose credentials.' },
    { name: 'server/routes/auth.js',  lang: 'javascript', prompt: 'Generate server/routes/auth.js: POST /register (validate fields: '+authFieldsDef+', check duplicate email, bcrypt hash password cost 12, insert user, send verification email, return 201), POST /login (validate, check email verified, compare bcrypt, issue JWT access 15min + refresh 7d httpOnly cookie), POST /logout (clear refresh cookie), POST /refresh-token (validate refresh from httpOnly cookie, rotate token), GET /verify-email/:token (mark email verified). Use parameterized queries only. Import authLimiter EXACTLY like this: const { authLimiter } = require("../middleware/security"); — do NOT create or import from ../middleware/rateLimiter (that file does not exist). Apply authLimiter to register and login.' },
    { name: 'server/routes/api.js',   lang: 'javascript', prompt: 'Generate server/routes/api.js: Express router with a verifyToken middleware (validates JWT Bearer). GET /api/me returns authenticated user profile (no password hash). GET /api/health returns {status: ok, timestamp}. Structure ready for adding more routes.' },
    { name: 'server/index.js',        lang: 'javascript', prompt: 'Generate server/index.js: Express app entry point. Apply applySecurityMiddleware first. Then apply sentinelMiddleware (import from ./middleware/sentinel.js). Use CORS with env CORS_ORIGIN. Parse JSON body (limit 10kb). Mount /api/auth to auth.js, /api to api.js. CRITICAL: serve static files using the ABSOLUTE path computed with path.join and __dirname — specifically path.join(__dirname, double-dot, public) so it resolves correctly regardless of cwd. After mounting all API routes and before the 404 handler, add a SPA catch-all: app.get with wildcard star that calls res.sendFile with path.join(__dirname, double-dot, public, index.html). This ensures GET / and any unmatched frontend route returns index.html instead of a 404 JSON error. 404 handler and global error handler (never leak stack traces in production). Start on PORT from env.' },
    { name: 'db/migrations/001_init.sql', lang: 'sql',   prompt: 'Generate PostgreSQL migration 001_init.sql: CREATE TABLE users with id UUID default gen_random_uuid(), fields for '+authFieldsDef+', email_verified BOOLEAN default false, verification_token VARCHAR, reset_token VARCHAR, reset_token_expires TIMESTAMPTZ, refresh_token_hash VARCHAR, created_at TIMESTAMPTZ default now(), updated_at TIMESTAMPTZ default now(). CREATE INDEX on email. CREATE TABLE refresh_tokens (id, user_id FK, token_hash, expires_at, created_at). Add updated_at trigger function.' },
    { name: 'public/css/base.css',    lang: 'css',       prompt: 'Generate public/css/base.css: CSS custom properties (color palette, spacing scale, font scale, border-radius, shadows, transitions). CSS reset (*, box-sizing). Base typography (Inter or system-ui). Utility classes using BEM where applicable. Dark/light mode via prefers-color-scheme.' },
    { name: 'public/css/components.css', lang: 'css',    prompt: 'Generate public/css/components.css following STRICT BEM (block__element--modifier). Components: .btn (--primary, --secondary, --danger, --ghost), .form (form__field, form__label, form__input, form__error, form__hint), .card (card__header, card__body, card__footer), .nav (nav__brand, nav__links, nav__link--active), .alert (--success, --error, --warning, --info), .spinner, .badge, .modal (modal__overlay, modal__content, modal__header, modal__body, modal__footer). Fully accessible (focus states, aria).' },
    { name: 'public/css/pages.css',   lang: 'css',       prompt: 'Generate public/css/pages.css: page-level layout classes using BEM. .page-auth (centered card layout for login/register), .page-dashboard (sidebar + content grid), .page-landing (hero section, features grid, pricing cards). Responsive at 768px and 480px breakpoints.' },
    { name: 'public/js/main.js',      lang: 'javascript', prompt: 'Generate public/js/main.js: vanilla JS, no dependencies. authAPI object with methods register(data), login(data), logout(), refreshToken(), getMe(). Cookie banner controller: reads localStorage consent, shows banner if not set, sets consent by category (necessary/analytics/marketing). Form handlers for register and login pages. Global error display utility. Export nothing (IIFE).' },
    { name: 'public/index.html',      lang: 'html',       prompt: 'Generate public/index.html for "'+projName+'": '+desc+'. Full HTML5. IMPORTANT: do NOT add X-Frame-Options, Strict-Transport-Security, or frame-ancestors meta tags — the app runs in an iframe sandbox on HTTP localhost and these will break it. Only add: X-UA-Compatible IE=edge, viewport, charset, Permissions-Policy (geolocation=(), microphone=(), camera=()). Include base.css, components.css, pages.css. GDPR cookie banner HTML (class .cookie-banner, .cookie-banner__text, .cookie-banner__actions, .cookie-banner__btn--accept, .cookie-banner__btn--reject). Navigation. Hero section. Include main.js at end of body. Semantic HTML, ARIA roles, lang attribute.' },
    { name: 'public/login.html',      lang: 'html',       prompt: 'Generate public/login.html: login page for "'+projName+'". Form with email + password fields using .form BEM classes. Link to register.html. Error display area. Include same CSS files. ARIA labels, autocomplete attributes. Do NOT add X-Frame-Options or Strict-Transport-Security meta tags.' },
    { name: 'public/register.html',   lang: 'html',       prompt: 'Generate public/register.html: registration page for "'+projName+'". Form fields: '+authFieldsDef+'. Use .form BEM classes. Client-side validation hints. Link to login.html. Error/success display. Include same CSS files. ARIA labels, autocomplete attributes. Do NOT add X-Frame-Options or Strict-Transport-Security meta tags.' },
    { name: 'server/middleware/sentinel.js', lang: 'javascript', prompt: 'Generate server/middleware/sentinel.js: a lightweight WAF middleware for Express. Check request for: SQL injection patterns (UNION SELECT, DROP TABLE, etc.), XSS patterns (<script, javascript:, onerror=), path traversal (../), oversized payloads (>100KB body). Rate limit by IP using an in-memory sliding window (fallback when Redis unavailable). Log blocked requests with IP, method, path, reason to stderr. Export sentinelMiddleware(req, res, next).' },
    { name: 'server/services/cache.js',     lang: 'javascript', prompt: 'Generate server/services/cache.js: Redis/Dragonfly client using ioredis. Connect to REDIS_URL from env. Export: get(key), set(key, value, ttlSeconds), del(key), exists(key). Add circuit breaker pattern: if Redis fails 3+ times in 30s, switch to in-memory LRU fallback (Map with max 1000 entries, LRU eviction). Reconnect Redis in background every 60s. Log circuit state changes. This makes the app resilient when Redis is down.' },
    { name: 'README.md',              lang: 'markdown',   prompt: 'Generate README.md for "'+projName+'": project description, tech stack (Express, PostgreSQL with circuit breaker, Redis/Dragonfly with LRU fallback, JWT auth, Nodemailer SMTP + SendGrid fallback, Sentinel WAF, BEM CSS), folder structure, setup instructions (clone, npm install, copy .env.example to .env, run migrations with psql, optional: start Redis/Dragonfly, npm run dev), environment variables table (including REDIS_URL), API endpoints table, security notes, email configuration guide.' },
    { name: 'nginx.conf',             lang: 'nginx',      prompt: 'Generate a production-ready nginx.conf for "'+projName+'" running as an Express app on localhost:3000. Include: HTTPS with TLS 1.2/1.3 only, strong cipher suites, HSTS (max-age=31536000; includeSubDomains; preload), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy (geolocation=(), microphone=(), camera=()), Content-Security-Policy (default-src self, script-src self, style-src self unsafe-inline, img-src self data:, connect-src self, frame-src none, object-src none), rate limiting (limit_req_zone 10r/s burst 20), gzip compression, proxy_pass to http://127.0.0.1:3000 with correct headers (X-Real-IP, X-Forwarded-For, X-Forwarded-Proto), static files served directly from public/ with long cache headers, Certbot/ACME path. Use server_name example.com with a TODO comment. Security rating: A+ on securityheaders.com.' },
  ];

  // Filter by selected blocks
  if (!wcState.blocks.auth) {
    filePlan = filePlan.filter(function(f){ return !['server/routes/auth.js','public/login.html','public/register.html','server/middleware/validate.js'].includes(f.name); });
  }
  if (!wcState.blocks.cookieBanner) {
    // keep index.html but note no cookie banner
  }
  if (!wcState.blocks.emailVerification) {
    // mark in prompt
    filePlan = filePlan.map(function(f){ return f.name === 'server/services/email.js' ? Object.assign({},f,{prompt:f.prompt+' (Skip email verification — not enabled)'}) : f; });
  }

  var _nl = String.fromCharCode(10);
  var sysPreamble = 'You are an expert full-stack engineer generating production-quality code.' + _nl + _nl + 'SECURITY RULES (non-negotiable):' + _nl + SECURITY_RULES + _nl + _nl + 'JSON FILES RULES (non-negotiable):' + _nl + '- NEVER add spaces inside JSON keys or string values that are identifiers (package names, field names).' + _nl + '- package.json "name" must be lowercase with no spaces. All dependency names must match exactly the npm package name (no spaces, no leading/trailing spaces).' + _nl + '- NEVER duplicate dependency entries. Each package name appears exactly once.' + _nl + '- "devDependencies" key has NO trailing space. All JSON keys are exact.' + _nl + _nl + 'Project: ' + projName + _nl + 'Description: ' + desc + _nl + 'Enabled blocks: ' + blocksEnabled + _nl + _nl + 'Generate ONLY the file content requested. No explanations, no markdown code fences, no comments like "here is the file". Output raw file content only.';
  _wcLastFilePlan = filePlan;
  _wcLastSysPreamble = sysPreamble;

  _wcGenStartTime = Date.now();
  _wcTokIn = 0; _wcTokOut = 0;  // reset global counters for this generation run

  // CSS files that need two-pass generation (too long for one call)
  var WC_CSS_SPLIT = {
    'public/css/base.css': [
      'PART 1 of 2. Generate the FIRST HALF of public/css/base.css. Include: (1) all CSS custom properties / design tokens (colors, spacing, font sizes, shadows, radii, transitions, z-index scale, dark/light mode via prefers-color-scheme data-theme), (2) CSS reset (*, box-sizing, margin, padding), (3) base typography (body, h1-h6, p, a, code, pre, blockquote), (4) utility classes (flex, grid helpers, spacing, text alignment, visibility, truncation). End the file at a natural boundary (closing brace). Do NOT generate components. Output raw CSS only.',
      'PART 2 of 2. Continue (do NOT repeat) public/css/base.css from where part 1 ended. Generate: (5) layout helpers (.container, .grid, .col-*, .stack, .cluster, .sidebar-layout), (6) responsive breakpoint utilities (768px, 480px), (7) animation keyframes (@keyframes fadeIn, slideUp, pulse, spin), (8) scrollbar styling, (9) selection styles, (10) print styles. Output raw CSS only, starting directly from where part 1 ended — no repetition.'
    ],
    'public/css/components.css': [
      'PART 1 of 2. Generate the FIRST HALF of public/css/components.css using strict BEM. Include components: (1) .btn (--primary, --secondary, --danger, --ghost, --sm, --lg, disabled state, loading state with spinner), (2) .form (.form__group, .form__label, .form__input, .form__textarea, .form__select, .form__error, .form__hint, .form__input--invalid, focus states), (3) .card (.card__header, .card__body, .card__footer, .card--interactive hover/active), (4) .badge (--success, --error, --warning, --info, --neutral), (5) .alert (--success, --error, --warning, --info with icon space). Output raw CSS only.',
      'PART 2 of 2. Continue (do NOT repeat) public/css/components.css from where part 1 ended. Include components: (6) .nav (.nav__brand, .nav__links, .nav__link, .nav__link--active, .nav__toggle mobile hamburger, .nav--sticky), (7) .modal (.modal__overlay, .modal__content, .modal__header, .modal__body, .modal__footer, open/close transition), (8) .spinner (sizes: sm/md/lg, colors), (9) .dropdown (.dropdown__menu, .dropdown__item, open state), (10) .avatar (.avatar--sm/md/lg, .avatar--initials), (11) .progress (.progress__bar, animated fill), (12) .table (.table__head, .table__row, .table__cell, striped, hover). Output raw CSS only, starting directly from where part 1 ended.'
    ]
  };

  // Helper: strip markdown fences from LLM output
  function wcStripFences(content) {
    var _nl2 = String.fromCharCode(10);
    var _fence = String.fromCharCode(96,96,96);
    var lines = content.split(_nl2);
    if (lines.length > 0 && lines[0].indexOf(_fence) === 0) lines.shift();
    if (lines.length > 0 && lines[lines.length-1].trim() === _fence) lines.pop();
    return lines.join(_nl2).trim();
  }

  // Helper: generate one file (with two-pass split for large CSS files)
  // onLiveUpdate(partialContent) is called on each token for live display
  async function wcGenOneFile(fp, signal, onLiveUpdate) {
    var _nl2 = String.fromCharCode(10);
    var splitPrompts = WC_CSS_SPLIT[fp.name];
    if (splitPrompts) {
      // Two-pass generation: streaming on first pass only
      var part1 = await wcCallLLM(sysPreamble, splitPrompts[0] + _nl2 + _nl2 + 'File: ' + fp.name, signal, fp.lang, 8192, onLiveUpdate, fp.name);
      part1 = wcStripFences(part1);
      if (signal && signal.aborted) return part1;
      var part2 = await wcCallLLM(sysPreamble, splitPrompts[1] + _nl2 + _nl2 + 'File: ' + fp.name, signal, fp.lang, 8192, function(p2) { if (onLiveUpdate) onLiveUpdate(part1 + _nl2 + _nl2 + p2); }, fp.name);
      part2 = wcStripFences(part2);
      return part1 + _nl2 + _nl2 + part2;
    }
    var content = await wcCallLLM(sysPreamble, fp.prompt + _nl2 + _nl2 + 'File to generate: ' + fp.name, signal, fp.lang, undefined, onLiveUpdate, fp.name);
    content = wcStripFences(content);
    // Detect model confusion: if output looks like a conversational reply instead of code, retry once
    var firstLine = content.trim().split(_nl2)[0] || '';
    var confusionPhrases = ['I notice', 'Could you please', 'I need to know', 'I don', 'To help you', 'Please clarify', 'I apologize', 'Unfortunately', 'As an AI'];
    var isConfused = confusionPhrases.some(function(p) { return firstLine.indexOf(p) === 0; });
    if (isConfused && !(signal && signal.aborted)) {
      var retryPrompt = 'IMPORTANT: Output ONLY the raw file content for ' + fp.name + '. No explanations, no questions, no markdown. Just the code.' + _nl2 + _nl2 + fp.prompt;
      content = await wcCallLLM(sysPreamble, retryPrompt + _nl2 + _nl2 + 'File to generate: ' + fp.name, signal, fp.lang, undefined, onLiveUpdate, fp.name);
      content = wcStripFences(content);
    }
    // Post-process: fix LLM streaming artifacts (spaces inserted inside keywords/identifiers)
    if (fp.lang === 'javascript' || fp.lang === 'typescript') {
      // Fix spaces inside JS/TS keywords that LLMs sometimes split during streaming
      var jsKeywords = ['const', 'let', 'var', 'function', 'return', 'require', 'import', 'export',
        'class', 'extends', 'async', 'await', 'throw', 'catch', 'finally', 'typeof', 'instanceof',
        'switch', 'default', 'continue', 'debugger', 'delete', 'module', 'exports', 'process'];
      jsKeywords.forEach(function(kw) {
        // Match keyword split across 1-3 chars with a space e.g. "con st", "re quire", "ex port"
        for (var split = 1; split < kw.length - 1; split++) {
          var broken = kw.slice(0, split) + ' ' + kw.slice(split);
          // Only replace when at word boundary (start of line or after space/punctuation)
          content = content.split(broken).join(kw);
        }
      });
      // Fix spaces inside common identifiers like "error Handler", "api Routes", "sec urityMiddleware"
      // Pattern: camelCase word split by a space before an uppercase letter
      content = content.replace(new RegExp('([a-z]) ([A-Z][a-z])', 'g'), '$1$2');
      // Fix "r equire" style splits in middle of word before a space+letter
      content = content.replace(new RegExp('\\b([a-z]{1,4}) ([a-z]{2,})', 'g'), function(m, a, b) {
        var joined = a + b;
        if (jsKeywords.indexOf(joined) !== -1) return joined;
        return m; // don't join random words
      });
      // Fix backslash-n literal artifacts from LLM
      var bsn = String.fromCharCode(92) + ' n';
      content = content.split(bsn).join('');
      var bsn2 = String.fromCharCode(92) + 'n';
      content = content.split(bsn2).join('');
    }
    // Post-process package.json: fix spaces in keys/names, duplicates
    if (fp.name === 'package.json' && fp.lang === 'json') {
      try {
        var pkg = JSON.parse(content);
        if (typeof pkg.name === 'string') pkg.name = pkg.name.trim().toLowerCase().replace(/\s+/g, '-');
        ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].forEach(function(section) {
          if (!pkg[section] || typeof pkg[section] !== 'object') return;
          var clean = {};
          Object.keys(pkg[section]).forEach(function(k) {
            var cleanKey = k.trim();
            if (cleanKey && !clean[cleanKey]) clean[cleanKey] = pkg[section][k];
          });
          pkg[section] = clean;
        });
        content = JSON.stringify(pkg, null, 2);
      } catch(_) {}
    }
    return content;
  }

  wcStartGenTimer();

  // Pre-populate generatedFiles in order so tabs appear immediately
  filePlan.forEach(function(fp) {
    wcState.generatedFiles.push({ name: fp.name, content: '', lang: fp.lang, _pending: true });
  });
  wcState.activeFile = 0;
  renderWebCraft(document.getElementById('content'));

  // Live update: write token directly into DOM — zero re-render, zero flicker
  var _wcLiveDomTimers = {};
  function wcLiveUpdateFile(fpName, fpLang, partialContent) {
    // Always update state
    var fileIdx = -1;
    for (var li = 0; li < wcState.generatedFiles.length; li++) {
      if (wcState.generatedFiles[li].name === fpName) {
        wcState.generatedFiles[li].content = partialContent;
        wcState.generatedFiles[li]._pending = false;
        fileIdx = li;
        break;
      }
    }
    // If this file is the active one, update the <pre> directly (throttled 80ms)
    if (fileIdx !== wcState.activeFile) return;
    if (_wcLiveDomTimers[fpName]) return;
    _wcLiveDomTimers[fpName] = setTimeout(function() {
      delete _wcLiveDomTimers[fpName];
      // Replace pending placeholder with live <pre> if needed
      var pending = document.getElementById('wcLivePending');
      var pre = document.getElementById('wcLiveCode');
      var wrap = document.getElementById('wcCodeWrap');
      if (pending && wrap) {
        // First token: swap placeholder for <pre>
        var newPre = document.createElement('pre');
        newPre.id = 'wcLiveCode';
        newPre.style.cssText = 'margin:0;padding:14px 16px;font-size:11px;line-height:1.6;color:var(--text);font-family:var(--mono);white-space:pre-wrap;word-break:break-all';
        newPre.textContent = partialContent;
        pending.parentNode.replaceChild(newPre, pending);
        return;
      }
      if (pre) {
        pre.textContent = partialContent;
        // Auto-scroll to bottom so user sees latest tokens
        var codeWrap = document.getElementById('wcCodeWrap');
        if (codeWrap) codeWrap.scrollTop = codeWrap.scrollHeight;
      }
    }, 80);
  }

  // Generate sequentially — one file at a time so every file streams visibly
  // and the progress bar increments file by file
  var doneCount = 0;
  wcUpdateGenOverlay(0, filePlan.length, '');
  for (var si = 0; si < filePlan.length; si++) {
    if (_wcGenAbortCtrl && _wcGenAbortCtrl.signal.aborted) break;
    var fp = filePlan[si];

    // Switch viewer to this file and show its name in the bar
    var fileIdx = wcState.generatedFiles.findIndex(function(f){ return f.name === fp.name; });
    if (fileIdx >= 0) wcState.activeFile = fileIdx;
    wcUpdateGenOverlay(doneCount, filePlan.length, fp.name);

    var liveCallback = (function(fpCap) {
      return function(partial) { wcLiveUpdateFile(fpCap.name, fpCap.lang, partial); };
    }(fp));

    try {
      var genContent = await wcGenOneFile(fp, _wcGenAbortCtrl ? _wcGenAbortCtrl.signal : null, liveCallback);
      for (var gi = 0; gi < wcState.generatedFiles.length; gi++) {
        if (wcState.generatedFiles[gi].name === fp.name) {
          wcState.generatedFiles[gi] = { name: fp.name, content: genContent, lang: fp.lang };
          break;
        }
      }
    } catch(genErr) {
      if (genErr && genErr.name === 'AbortError') break;
      for (var gi2 = 0; gi2 < wcState.generatedFiles.length; gi2++) {
        if (wcState.generatedFiles[gi2].name === fp.name) {
          wcState.generatedFiles[gi2] = { name: fp.name, content: '// Error generating this file: ' + (genErr && genErr.message || 'unknown error'), lang: fp.lang || '', _error: true };
          break;
        }
      }
    }

    doneCount++;
    wcUpdateGenOverlay(doneCount, filePlan.length, si + 1 < filePlan.length ? filePlan[si + 1].name : '');
  }

  if (_wcTimerInterval) { clearInterval(_wcTimerInterval); _wcTimerInterval = null; }

  wcState.running = false;
  _wcGenAbortCtrl = null;

  // Auto-save
  try {
    await fetch(API + '/api/studio/webcraft/projects/save', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectName: wcState.projectName, description: wcState.description, files: wcState.generatedFiles })
    });
  } catch(_) {}

  // Post-generation syntax scan — mark truncated/broken files before repair
  wcState.generatedFiles.forEach(function(f) {
    if (f._error || f._pending || !f.content) return;
    var chk = wcSyntaxCheck(f.content, f.lang || '');
    if (!chk.ok) f._syntaxError = chk.reason;
  });

  renderWebCraft(document.getElementById('content'));

  // Auto-repair: run immediately after generation completes
  await wcAutoRepair(filePlan, sysPreamble);

  // Update stats AFTER repair so token counts include repair calls
  wcState.lastGenStats = { tokIn: _wcTokIn, tokOut: _wcTokOut, seconds: Math.floor((Date.now() - _wcGenStartTime) / 1000), files: wcState.generatedFiles.length };
  renderWebCraft(document.getElementById('content'));
}

// ── Auto-repair pass — fixes _error and _syntaxError files ────────────────
// Called automatically after generation and available as manual button
var _wcRepairRunning = false;
var _wcRepairAbortCtrl = null;
function wcStopRepair() {
  if (_wcRepairAbortCtrl) { _wcRepairAbortCtrl.abort(); _wcRepairAbortCtrl = null; }
}
async function wcAutoRepair(filePlan, sysPreamble) {
  if (_wcRepairRunning) return;
  // Collect broken files: LLM errors + syntax errors
  var toFix = wcState.generatedFiles.filter(function(f){ return f._error || f._syntaxError; });
  if (toFix.length === 0) return;

  _wcRepairAbortCtrl = new AbortController();
  _wcRepairRunning = true;
  wcState.repairing = true;
  wcState.repairTotal = toFix.length;
  wcState.repairDone = 0;
  renderWebCraft(document.getElementById('content'));

  // Build a map name→plan for prompt lookup
  var planMap = {};
  if (filePlan) filePlan.forEach(function(fp){ planMap[fp.name] = fp; });

  var _nl3 = String.fromCharCode(10);
  // Use compact system prompt for repair to avoid exceeding Liara context window
  var sysBase = 'You are an expert full-stack engineer. Output ONLY the complete corrected file content. No explanations, no markdown fences, no preamble. Raw file content only.';

  for (var ri = 0; ri < toFix.length; ri++) {
    if (_wcRepairAbortCtrl && _wcRepairAbortCtrl.signal.aborted) break;
    var broken = toFix[ri];
    var plan = planMap[broken.name];
    wcState.repairDone = ri;
    wcState.repairCurrent = broken.name;
    wcUpdateRepairOverlay();

    // Switch active file to the one being repaired so tokens appear in the viewer
    var repairFileIdx = wcState.generatedFiles.findIndex(function(f){ return f.name === broken.name; });
    if (repairFileIdx >= 0) wcState.activeFile = repairFileIdx;

    // "Destruction" animation: fade the existing code out in the <pre>
    (function animateWipe() {
      var pre = document.getElementById('wcLiveCode');
      if (!pre) return;
      var txt = pre.textContent;
      var len = txt.length;
      if (len === 0) return;
      var step = Math.max(1, Math.floor(len / 18));
      var remaining = len;
      var wipeInterval = setInterval(function() {
        remaining = Math.max(0, remaining - step);
        pre.style.opacity = String(remaining / len);
        pre.textContent = txt.slice(0, remaining);
        if (remaining <= 0) { clearInterval(wipeInterval); pre.style.opacity = '1'; pre.textContent = ''; }
      }, 40);
    }());

    await new Promise(function(resolve){ setTimeout(resolve, 800); });
    try {
      var fixSys = sysBase + _nl3 + 'You are fixing a broken or truncated file. Output ONLY the complete corrected file. No fences, no explanations.';
      var fixUser;
      if (broken._error) {
        // LLM failed entirely — regenerate from original prompt
        fixUser = plan
          ? plan.prompt + _nl3 + _nl3 + 'File to generate: ' + broken.name
          : 'Regenerate the file: ' + broken.name;
      } else {
        // Syntax error — pass existing content + error for targeted fix
        fixUser = 'File: ' + broken.name + _nl3 +
          'Error: ' + (broken._syntaxError || 'truncated/incomplete') + _nl3 + _nl3 +
          'Current broken content (last 800 chars shown if long):' + _nl3 +
          (broken.content.length > 800 ? broken.content.slice(0, 400) + _nl3 + '...' + _nl3 + broken.content.slice(-400) : broken.content) + _nl3 + _nl3 +
          'Output the COMPLETE corrected file from the beginning.';
      }
      // Stream repair tokens directly into the <pre>
      var repairAccum = '';
      var repairLang2 = broken.lang || (plan && plan.lang) || 'text';
      var fixed = await wcCallLLM(fixSys, fixUser, _wcRepairAbortCtrl ? _wcRepairAbortCtrl.signal : null, repairLang2, 8192, function(tok) {
        repairAccum += tok;
        var pre2 = document.getElementById('wcLiveCode');
        if (pre2) { pre2.textContent = repairAccum; pre2.style.opacity = '1'; var cw = document.getElementById('wcCodeWrap'); if(cw) cw.scrollTop = cw.scrollHeight; }
      });
      var _fence3 = String.fromCharCode(96,96,96);
      var fixLines = fixed.split(_nl3);
      if (fixLines.length > 0 && fixLines[0].indexOf(_fence3) === 0) fixLines.shift();
      if (fixLines.length > 0 && fixLines[fixLines.length-1].trim() === _fence3) fixLines.pop();
      fixed = fixLines.join(_nl3).trim();
      var check2 = wcSyntaxCheck(fixed, repairLang2);
      for (var gi3 = 0; gi3 < wcState.generatedFiles.length; gi3++) {
        if (wcState.generatedFiles[gi3].name === broken.name) {
          wcState.generatedFiles[gi3] = { name: broken.name, content: fixed, lang: repairLang2 };
          if (!check2.ok) wcState.generatedFiles[gi3]._syntaxError = check2.reason;
          break;
        }
      }
    } catch(e) { /* keep as broken */ }

    wcState.repairDone = ri + 1;
    wcUpdateRepairOverlay();
  }

  _wcRepairRunning = false;
  _wcRepairAbortCtrl = null;
  wcState.repairing = false;
  wcState.repairTotal = 0;
  wcState.repairDone = 0;
  wcState.repairCurrent = '';

  // Save after repair
  try {
    await fetch(API + '/api/studio/webcraft/projects/save', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectName: wcState.projectName, description: wcState.description, files: wcState.generatedFiles })
    });
  } catch(_) {}

  renderWebCraft(document.getElementById('content'));
}

// Manual trigger for repair — called from "Correggi tutti" button
function wcUpdateRepairOverlay() {
  var counter = document.getElementById('wcRepairCounter');
  var fileEl  = document.getElementById('wcRepairFile');
  var prog    = document.getElementById('wcRepairProg');
  if (counter) counter.textContent = wcState.repairDone + ' / ' + wcState.repairTotal;
  if (fileEl)  fileEl.textContent  = wcState.repairCurrent;
  if (prog)    prog.style.width = (wcState.repairTotal > 0 ? Math.round((wcState.repairDone / wcState.repairTotal) * 100) : 0) + '%';
}

function wcTriggerRepair() {
  if (_wcRepairRunning) return;
  wcAutoRepair(_wcLastFilePlan, _wcLastSysPreamble);
}

// Quick structural check — returns {ok, reason} without calling the LLM
// Reads only structure (braces, tags) — does NOT add content to any context
function wcSyntaxCheck(content, lang) {
  if (!content || content.length < 20) return { ok: false, reason: 'empty' };
  var trimmed = content.trimEnd();

  if (lang === 'css' || lang === 'scss') {
    // Strip comments and strings to avoid false brace counts
    var stripped = trimmed
      .replace(new RegExp('/[*][\\s\\S]*?[*]/', 'g'), '')
      .replace(new RegExp('"[^"]*"', 'g'), '""')
      .replace(new RegExp("['][^']*[']", 'g'), "''");
    var open = 0, close = 0;
    for (var i = 0; i < stripped.length; i++) {
      if (stripped[i] === '{') open++;
      else if (stripped[i] === '}') close++;
    }
    if (open !== close) return { ok: false, reason: 'unbalanced braces (' + open + ' open, ' + close + ' close)' };
    if (open === 0) return { ok: false, reason: 'no CSS rules found' };
    return { ok: true };
  }

  if (lang === 'javascript') {
    // Use Function constructor as a zero-overhead parse check (no eval, just syntax)
    try { new Function(content); return { ok: true }; }
    catch(e) { return { ok: false, reason: e.message.split(String.fromCharCode(10))[0] }; }
  }

  if (lang === 'html') {
    var lower = trimmed.toLowerCase();
    if (lower.indexOf('</html>') === -1 && lower.indexOf('</body>') === -1)
      return { ok: false, reason: 'missing </html> or </body>' };
    // DOMParser check for well-formedness
    try {
      var doc = new DOMParser().parseFromString(trimmed, 'text/html');
      var pe = doc.querySelector('parseerror');
      if (pe) return { ok: false, reason: pe.textContent.slice(0, 80) };
    } catch(_) {}
    return { ok: true };
  }

  if (lang === 'json') {
    try { JSON.parse(trimmed); return { ok: true }; }
    catch(e) { return { ok: false, reason: e.message }; }
  }

  // For markdown, nginx.conf, sql, bash — just check not truncated mid-line
  var last = trimmed[trimmed.length - 1];
  if (last === undefined) return { ok: false, reason: 'empty' };
  return { ok: true };
}

// Returns true if content looks truncated (unbalanced braces or ends mid-rule)
function wcIsTruncated(content, lang) {
  if (!content || content.length < 100) return false;
  var check = wcSyntaxCheck(content, lang);
  if (!check.ok) return true;
  // Also check raw ending for langs not fully covered above
  var trimmed = content.trimEnd();
  if (lang === 'javascript') {
    var last = trimmed[trimmed.length - 1];
    return last !== '}' && last !== ';' && last !== ')';
  }
  return false;
}

async function wcCallLLMRaw(sys, user, signal, maxTok, onToken) {
  // Streaming path: use SSE endpoint so tokens appear live in the file editor
  if (onToken) {
    var streamOpts = {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({system: sys, user: user, max_tokens: maxTok || 16384})
    };
    if (signal) streamOpts.signal = signal;
    for (var sa = 0; sa < 3; sa++) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      var sr = await fetch(API + '/api/studio/webcraft/stream', streamOpts);
      if (!sr.ok) {
        if (sr.status < 500 || sa === 2) throw new Error('LLM stream error ' + sr.status);
        await new Promise(function(resolve) { setTimeout(resolve, 2000); });
        continue;
      }
      var sreader = sr.body.getReader();
      var sdec = new TextDecoder();
      var sbuf = '';
      var fullText = '';
      while (true) {
        var sres = await sreader.read();
        if (sres.done) break;
        sbuf += sdec.decode(sres.value, {stream: true});
        var sparts = sbuf.split(String.fromCharCode(10) + String.fromCharCode(10));
        sbuf = sparts.pop();
        for (var si = 0; si < sparts.length; si++) {
          var sline = sparts[si].replace(/^data: /, '').trim();
          if (!sline) continue;
          try {
            var sev = JSON.parse(sline);
            if (sev.type === 'token') {
              fullText += sev.token;
              onToken(fullText);
            } else if (sev.type === 'done') {
              if (sev.usage) {
                _wcTokIn  += (sev.usage.prompt_tokens || 0);
                _wcTokOut += (sev.usage.completion_tokens || 0);
              }
            } else if (sev.type === 'error') {
              throw new Error(sev.message || 'Stream error');
            }
          } catch(_) {}
        }
      }
      return fullText;
    }
  }

  // Non-streaming fallback (used by repair and continuation passes)
  var fetchOpts = {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({system: sys, user: user, max_tokens: maxTok || 16384})
  };
  if (signal) fetchOpts.signal = signal;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    var r = await fetch(API + '/api/studio/webcraft', fetchOpts);
    if (r.ok) {
      var d = await r.json();
      if (d && d.usage) {
        _wcTokIn  += (d.usage.prompt_tokens || d.usage.input_tokens || 0);
        _wcTokOut += (d.usage.completion_tokens || d.usage.output_tokens || 0);
      } else if (d && d.text) {
        _wcTokIn  += Math.round((sys.length + user.length) / 4);
        _wcTokOut += Math.round((d.text || '').length / 4);
      }
      return (d && (d.text || d.content || d.result)) || '';
    }
    if (r.status < 500 || attempt === 2) {
      var errBody = '';
      try { var errText = await r.text(); try { errBody = JSON.parse(errText).error || errText; } catch(_) { errBody = errText; } } catch(_) {}
      console.warn('[WebCraft] LLM ' + r.status + ' attempt=' + attempt + ':', errBody.slice(0, 300));
      throw new Error('LLM error ' + r.status + (errBody ? ': ' + errBody.slice(0, 120) : ''));
    }
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
  }
}

async function wcCallLLM(sys, user, signal, lang, maxTok, onToken, fileName) {
  var content = await wcCallLLMRaw(sys, user, signal, maxTok, onToken);
  // Continuation loop: if response is truncated, ask model to continue (no streaming for continuations)
  var maxContinuations = 2;
  for (var ci = 0; ci < maxContinuations; ci++) {
    if (!wcIsTruncated(content, lang || 'text')) break;
    if (signal && signal.aborted) break;
    var _nlc = String.fromCharCode(10);
    var continuePrompt = (fileName ? 'File: ' + fileName + _nlc + _nlc : '') +
      'You were generating this file and ran out of tokens. The file is INCOMPLETE.' + _nlc +
      'Continue EXACTLY from where you stopped. Output ONLY the remaining code — do NOT repeat anything already written, do NOT explain, do NOT use markdown fences.' + _nlc + _nlc +
      'The file so far ends with (last 600 chars):' + _nlc + content.slice(-600);
    var continuation = await wcCallLLMRaw(sys, continuePrompt, signal, maxTok);
    if (!continuation || continuation.trim().length < 5) break;
    content = content + _nlc + continuation;
    if (onToken) onToken(content);
  }
  return content;
}

function wcSandboxPanelHtml() {
  var sb = wcState.sandbox;
  if (!wcState.generatedFiles.length) {
    return '<div style="display:flex;align-items:center;justify-content:center;flex:1;color:var(--dim);font-size:13px">Genera prima il progetto</div>';
  }

  // Server ready — show iframe with top bar
  if (sb.port && !sb.running) {
    return '<div style="display:flex;flex-direction:column;flex:1;min-height:0">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg3)">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;flex-shrink:0"></span>' +
        '<span style="font-size:11px;color:var(--text);font-family:var(--mono);font-weight:600">http://127.0.0.1:'+sb.port+'</span>' +
        '<span style="font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">'+wcEsc(sb.dir||'')+'</span>' +
        '<button onclick="wcStopSandbox()" style="padding:3px 10px;background:transparent;border:1px solid var(--border2);border-radius:5px;color:var(--dim);font-size:11px;cursor:pointer;flex-shrink:0">&#9632; Ferma</button>' +
        '<button onclick="wcOpenSandbox()" style="padding:3px 12px;background:var(--green3);border:none;border-radius:5px;color:var(--bg);font-size:11px;cursor:pointer;font-weight:700;flex-shrink:0">&#8599; Apri nel browser</button>' +
      '</div>' +
      '<iframe src="http://127.0.0.1:'+sb.port+'" style="flex:1;border:none;width:100%;background:#fff" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe>' +
    '</div>';
  }

  // Pre-launch info panel
  if (!sb.running && !sb.port && !sb.logs.length) {
    return '<div style="display:flex;flex-direction:column;flex:1;min-height:0;padding:20px">' +
      '<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:16px;max-width:480px">' +
        '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:12px">&#9654; Cosa succede quando avvii la sandbox:</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;font-size:11px;color:var(--dim)">' +
          '<div style="display:flex;gap:8px;align-items:flex-start"><span style="color:var(--green);flex-shrink:0">1.</span><span>I file vengono scritti in <span style="font-family:var(--mono);color:var(--green)">~/.nha/webcraft/'+wcEsc(wcState.projectName||'project')+'</span></span></div>' +
          '<div style="display:flex;gap:8px;align-items:flex-start"><span style="color:var(--green);flex-shrink:0">2.</span><span>npm install delle dipendenze (solo in quella cartella)</span></div>' +
          '<div style="display:flex;gap:8px;align-items:flex-start"><span style="color:var(--green);flex-shrink:0">3.</span><span>Il server Express parte su una porta locale casuale</span></div>' +
          '<div style="display:flex;gap:8px;align-items:flex-start"><span style="color:var(--green);flex-shrink:0">4.</span><span>DB in-memory (no PostgreSQL richiesto) — i dati si azzerano al riavvio</span></div>' +
        '</div>' +
        '<div style="margin-top:12px;padding:8px 10px;background:var(--amberdim);border:1px solid var(--amber3);border-radius:6px;font-size:10px;color:var(--amber)">&#9888; Solo locale — nessun dato esce dal tuo dispositivo</div>' +
      '</div>' +
    '</div>';
  }

  // Running — show structured phases log
  var phases = [
    { key: 'files',   label: 'Scrittura file',         icon: '&#128196;' },
    { key: 'shims',   label: 'Shim iniettati',          icon: '&#128295;' },
    { key: 'pkg',     label: 'package.json',            icon: '&#128230;' },
    { key: 'env',     label: '.env sandbox',            icon: '&#9881;'   },
    { key: 'deps',    label: 'Dipendenze',              icon: '&#128230;' },
    { key: 'install', label: 'npm install',             icon: '&#9203;'   },
    { key: 'start',   label: 'Avvio server',            icon: '&#9654;'   },
  ];
  var logs = sb.logs;
  // Classify each log line into a phase
  function phaseOf(l) {
    if (!l) return 'start';
    if (l.indexOf('Scrittura') !== -1 || l.indexOf('file...') !== -1 || l[0] === ' ' && l.indexOf('.') !== -1 && l.indexOf('✓') !== -1) return 'files';
    if (l.indexOf('Shim') !== -1 || l.indexOf('shim') !== -1 || l.indexOf('DB shim') !== -1) return 'shims';
    if (l.indexOf('package.json') !== -1) return 'pkg';
    if (l.indexOf('.env') !== -1) return 'env';
    if (l.indexOf('Dipendenze') !== -1 || l.indexOf('Percorso:') !== -1 || (l.indexOf('•') !== -1 && l.indexOf('@') !== -1)) return 'deps';
    if (l.indexOf('npm install') !== -1 || l.indexOf('added') !== -1 || l.indexOf('packages') !== -1 || l.indexOf('npm error') !== -1 || l.indexOf('audit') !== -1 || l.indexOf('funding') !== -1 || l.indexOf('vulnerability') !== -1) return 'install';
    return 'start';
  }
  var byPhase = {};
  logs.forEach(function(l){ var p = phaseOf(l); if (!byPhase[p]) byPhase[p] = []; byPhase[p].push(l); });

  // Check if a phase is done (next phase has lines)
  var phaseKeys = phases.map(function(p){ return p.key; });
  function phaseStatus(pk) {
    var idx = phaseKeys.indexOf(pk);
    if (!byPhase[pk] || !byPhase[pk].length) return 'pending';
    // Done if next phase has started or if error
    for (var i = idx+1; i < phaseKeys.length; i++) {
      if (byPhase[phaseKeys[i]] && byPhase[phaseKeys[i]].length) return 'done';
    }
    if (sb.error) return 'error';
    return 'active';
  }

  var statusColor = { done:'var(--green)', active:'var(--amber)', pending:'var(--dim)', error:'var(--red)' };
  var statusIcon  = { done:'&#10003;', active:'&#9203;', pending:'&#9675;', error:'&#10060;' };

  var phasesHtml = phases.map(function(ph, phi){
    var st = phaseStatus(ph.key);
    var lines = byPhase[ph.key] || [];
    var clean = lines.filter(function(l){ return l.indexOf('npm fund') === -1 && l.indexOf('run ') === -1 && l.indexOf('npm audit') === -1; });
    var isOpen = !!wcSandboxExpanded[ph.key];
    var hasContent = clean.length > 0;

    // Summary line (always visible)
    var summary = '';
    if (ph.key === 'files') {
      var cnt = clean.filter(function(l){ return l.indexOf('✓') !== -1; }).length;
      summary = cnt ? cnt + ' file scritti' : '';
    } else if (ph.key === 'deps') {
      var dcnt = clean.filter(function(l){ return l.indexOf('•') !== -1; }).length;
      summary = dcnt ? dcnt + ' dipendenze' : '';
    } else if (clean.length > 0) {
      var last = clean.filter(function(l){ return l.trim(); }).slice(-1)[0] || '';
      summary = wcEsc(last.trim().slice(0, 60));
    }

    // Expanded detail — all lines
    var expandedHtml = '';
    if (isOpen && hasContent) {
      expandedHtml = '<div style="margin-top:6px;padding:8px;background:var(--bg);border-radius:6px;max-height:180px;overflow-y:auto">' +
        clean.map(function(l){
          var col = l.indexOf('❌') !== -1 || l.indexOf('Error') !== -1 ? 'var(--red)' : l.indexOf('✓') !== -1 || l.indexOf('✅') !== -1 ? 'var(--green)' : 'var(--dim)';
          return '<div style="font-size:10px;font-family:var(--mono);color:'+col+';line-height:1.6;white-space:pre-wrap;word-break:break-all">'+wcEsc(l)+'</div>';
        }).join('') +
      '</div>';
    }

    var clickable = hasContent && st !== 'pending';
    return '<div style="border-bottom:1px solid var(--border)">' +
      '<div onclick="'+(clickable?'wcTogglePhase('+phi+')':'')+'" style="display:flex;gap:10px;align-items:center;padding:9px 12px;cursor:'+(clickable?'pointer':'default')+'">' +
        '<span style="font-size:13px;flex-shrink:0">'+ph.icon+'</span>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:11px;font-weight:600;color:'+(st==='pending'?'var(--dim)':'var(--text)')+'">'+ph.label+'</div>' +
          (summary && !isOpen ? '<div style="font-size:10px;color:var(--dim);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+summary+'</div>' : '') +
        '</div>' +
        (clickable ? '<span style="font-size:10px;color:var(--dim);flex-shrink:0">'+(isOpen?'&#9650;':'&#9660;')+'</span>' : '') +
        '<span style="font-size:13px;color:'+statusColor[st]+';flex-shrink:0;margin-left:4px">'+statusIcon[st]+'</span>' +
      '</div>' +
      (isOpen ? '<div style="padding:0 12px 10px">' + expandedHtml + '</div>' : '') +
    '</div>';
  }).join('');

  return '<div style="display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto">' +
    phasesHtml +
    (sb.error ?
      '<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:0;font-size:11px;font-family:var(--mono);color:var(--red);white-space:pre-wrap;word-break:break-all">&#10060; '+wcEsc(sb.error)+'</div>' +
        '<button onclick="wcFixSandboxError()" style="flex-shrink:0;padding:6px 14px;background:#7f1d1d;border:1px solid #ef4444;border-radius:6px;color:#fca5a5;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">&#129302; Correggi</button>' +
      '</div>'
    : '') +
  '</div>';
}

async function wcStartSandbox() {
  if (wcState.sandbox.running) return;
  wcState.sandbox = { running: true, port: null, dir: null, logs: [], error: null };
  wcState.rightTab = 'preview';
  wcRightTab = 'preview';
  _wcSkillsLoaded = false;   // force skill panel reload after sandbox completes
  renderWebCraft(document.getElementById('content'));

  try {
    var r = await fetch(API + '/api/studio/webcraft/sandbox/start', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        projectName: wcState.projectName || 'webcraft-sandbox',
        files: wcState.generatedFiles.filter(function(f){ return !f._error && !f._pending; })
      })
    });
    if (!r.ok || !r.body) throw new Error('Sandbox error ' + r.status);
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, {stream: true});
      var _dbl = String.fromCharCode(10)+String.fromCharCode(10);
      var parts = buf.split(_dbl);
      buf = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i].trim();
        if (!line.startsWith('data:')) continue;
        try {
          var evt = JSON.parse(line.slice(5).trim());
          if (evt.type === 'log') {
            wcState.sandbox.logs.push(evt.msg);
            // Live update logs only (avoid full re-render on every line)
            var logsEl = document.getElementById('wcSbLogs');
            if (logsEl) {
              var d = document.createElement('div');
              d.textContent = evt.msg;
              logsEl.appendChild(d);
              logsEl.scrollTop = logsEl.scrollHeight;
            } else {
              renderWebCraft(document.getElementById('content'));
            }
          } else if (evt.type === 'ready') {
            wcState.sandbox.running = false;
            wcState.sandbox.port = evt.port;
            wcState.sandbox.dir = evt.dir;
            // Reset counter only after stable uptime (5s), not immediately on first ready
            // This prevents infinite loop: crash → fix → restart → crash → reset → crash → ...
            setTimeout(function() { _wcAutoFixAttempts = 0; }, 5000);
            wcStartAutoFixPoller();
            // Reload skills so newly written log file appears in the panel
            _wcSkillsLoaded = false;
            renderWebCraft(document.getElementById('content'));
          } else if (evt.type === 'error') {
            wcState.sandbox.running = false;
            wcState.sandbox.error = evt.msg;
            // Reload skills so error log appears in the panel
            _wcSkillsLoaded = false;
            renderWebCraft(document.getElementById('content'));
            // Auto-fix: try to detect MODULE_NOT_FOUND in crash message and fix it
            var errMsg = evt.msg || '';
            var modMatch = errMsg.match(new RegExp("Cannot find module '([^']+)'")) ||
                           errMsg.match(new RegExp('Cannot find module "([^"]+)"'));
            if (modMatch && _wcAutoFixAttempts < 3) {
              _wcAutoFixAttempts++;
              wcTriggerAutoFix(modMatch[1]);
            } else if (errMsg && !modMatch && _wcAutoFixAttempts < 3) {
              _wcAutoFixAttempts++;
              wcTriggerCrashFix(errMsg);
            }
          }
        } catch(_) {}
      }
    }
  } catch(e) {
    wcState.sandbox.running = false;
    wcState.sandbox.error = e.message;
    renderWebCraft(document.getElementById('content'));
  }
}

async function wcStopSandbox() {
  await fetch(API + '/api/studio/webcraft/sandbox', {method:'DELETE'});
  wcState.sandbox = { running: false, port: null, dir: null, logs: [], error: null };
  wcStopAutoFixPoller();
  renderWebCraft(document.getElementById('content'));
}

// "Correggi" button — sends full sandbox error to the agent for repair
async function wcFixSandboxError() {
  var errText = wcState.sandbox.error || 'Errore sconosciuto avviando il server sandbox';
  // Put error in chat input so user can see it, then fire agent
  var fixMsg = 'ERRORE SANDBOX — il server Node.js non si avvia. Analizza tutti i file del progetto, trova la causa e correggi.' +
    String.fromCharCode(10) + String.fromCharCode(10) +
    'STACKTRACE COMPLETO:' + String.fromCharCode(10) + errText;
  // Push as user message so it appears in chat
  wcChat.push({ role: 'user', text: '\uD83E\uDD16 Correggi errore sandbox' });
  wcScrollChatToBottom();
  wcChatRunning = true;
  renderWebCraft(document.getElementById('content'));

  try {
    var r = await fetch(API + '/api/studio/webcraft/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: wcState.projectName, message: fixMsg, autofix: true })
    });
    if (!r.ok) { wcChatRunning = false; renderWebCraft(document.getElementById('content')); return; }
    var agentMsg = { role: 'agent', text: '', tools: [] };
    wcChat.push(agentMsg);
    var reader4 = r.body.getReader();
    var dec4 = new TextDecoder();
    var buf4 = '';
    while (true) {
      var res4 = await reader4.read();
      if (res4.done) break;
      buf4 += dec4.decode(res4.value, { stream: true });
      var parts4 = buf4.split(String.fromCharCode(10) + String.fromCharCode(10));
      buf4 = parts4.pop();
      for (var pi4 = 0; pi4 < parts4.length; pi4++) {
        var line4 = parts4[pi4].replace(/^data: /, '').trim();
        if (!line4) continue;
        try {
          var ev4 = JSON.parse(line4);
          if (ev4.type === 'text') { agentMsg.text += ev4.token; renderWebCraft(document.getElementById('content')); wcScrollChatToBottom(); }
          else if (ev4.type === 'tool') { agentMsg.tools.push({ op: ev4.op, path: ev4.path, result: ev4.result, oldSnippet: ev4.oldSnippet || '', newSnippet: ev4.newSnippet || '' }); renderWebCraft(document.getElementById('content')); }
          else if (ev4.type === 'done') {
            wcChatRunning = false;
            if (ev4.changed) {
              // Files changed — syntax check then offer to restart
              wcChat.push({ role: 'system', text: '&#9989; Fix applicato. Clicca &#9654; Avvia Sandbox per ritentare.' });
            }
            renderWebCraft(document.getElementById('content'));
            wcScrollChatToBottom();
          } else if (ev4.type === 'restart_sandbox') {
            wcState.sandbox = { running: false, port: null, dir: null, logs: [], error: null };
            setTimeout(function(){ wcStartSandbox(); }, 800);
          }
        } catch(_) {}
      }
    }
  } catch(e2) {
    wcChatRunning = false;
    wcChat.push({ role: 'system', text: '&#10060; Errore chiamata agente: ' + e2.message });
    renderWebCraft(document.getElementById('content'));
  }
}

var _wcLastDownload = 0;
function wcDownloadZip() {
  if (!wcState.generatedFiles.length) return;
  var now = Date.now();
  if (now - _wcLastDownload < 30000) {
    var wait = Math.ceil((30000 - (now - _wcLastDownload)) / 1000);
    alert('Attendi ' + wait + 's prima di scaricare di nuovo.');
    return;
  }
  _wcLastDownload = now;
  // Build a real ZIP file (PKZIP format, stored/no compression) — zero dependencies
  var enc = new TextEncoder();
  var parts = [];
  var centralDir = [];
  var offset = 0;
  wcState.generatedFiles.forEach(function(f) {
    var namBytes = enc.encode(f.name);
    var dataBytes = enc.encode(f.content);
    // Local file header
    var lfh = new Uint8Array(30 + namBytes.length);
    var lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true);  // version needed
    lv.setUint16(6, 0, true);   // flags
    lv.setUint16(8, 0, true);   // compression: stored
    lv.setUint16(10, 0, true);  // mod time
    lv.setUint16(12, 0, true);  // mod date
    var crc = wcCrc32(dataBytes);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, namBytes.length, true);
    lv.setUint16(28, 0, true);
    lfh.set(namBytes, 30);
    // Central directory entry
    var cde = new Uint8Array(46 + namBytes.length);
    var cv = new DataView(cde.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true);  // version made by
    cv.setUint16(6, 20, true);  // version needed
    cv.setUint16(8, 0, true);   // flags
    cv.setUint16(10, 0, true);  // compression
    cv.setUint16(12, 0, true);  // mod time
    cv.setUint16(14, 0, true);  // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, namBytes.length, true);
    cv.setUint16(30, 0, true);  // extra
    cv.setUint16(32, 0, true);  // comment
    cv.setUint16(34, 0, true);  // disk start
    cv.setUint16(36, 0, true);  // internal attr
    cv.setUint32(38, 0, true);  // external attr
    cv.setUint32(42, offset, true); // local header offset
    cde.set(namBytes, 46);
    parts.push(lfh, dataBytes);
    centralDir.push(cde);
    offset += lfh.length + dataBytes.length;
  });
  var cdSize = centralDir.reduce(function(s,c){return s+c.length;},0);
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centralDir.length, true);
  ev.setUint16(10, centralDir.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  var all = parts.concat(centralDir).concat([eocd]);
  var total = all.reduce(function(s,b){return s+b.length;},0);
  var out = new Uint8Array(total);
  var pos = 0;
  all.forEach(function(b){out.set(b,pos);pos+=b.length;});
  var blob = new Blob([out], {type:'application/zip'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (wcState.projectName || 'project') + '-webcraft.zip';
  a.click();
  URL.revokeObjectURL(a.href);
}
function wcCrc32(buf) {
  var table = wcCrc32.t;
  if (!table) {
    table = new Uint32Array(256);
    for (var i=0;i<256;i++){var c=i;for(var k=0;k<8;k++)c=c&1?(0xEDB88320^(c>>>1)):(c>>>1);table[i]=c;}
    wcCrc32.t = table;
  }
  var crc = 0xFFFFFFFF;
  for (var j=0;j<buf.length;j++) crc = table[(crc^buf[j])&0xFF]^(crc>>>8);
  return (crc^0xFFFFFFFF)>>>0;
}
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
.content--webcraft{overflow:hidden;display:flex;flex-direction:column}

/* Mobile burger button */
#mobileBurger{display:block}
.sidebar--open~* #mobileBurger,.sidebar--open+* #mobileBurger{opacity:0;pointer-events:none}
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
@media(max-width:600px){#canvasPanel{top:0;right:0;left:0;width:100%;max-width:100%;height:100dvh;max-height:100dvh;border-radius:0;border-left:none;border-right:none}}
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
.studio-sidebar{display:flex;flex-direction:column;gap:12px;width:220px;flex-shrink:0;position:sticky;top:16px;align-self:flex-start}
.studio-sidebar-toggle{display:none}
@media(max-width:600px){
  #studioMainRow{flex-direction:column}
  .studio-sidebar{position:fixed;top:0;right:0;bottom:0;width:260px;max-width:85vw;background:var(--bg2);border-left:1px solid var(--border);z-index:500;padding:16px 12px;overflow-y:auto;transform:translateX(110%);transition:transform .3s cubic-bezier(.4,0,.2,1);box-shadow:-4px 0 24px rgba(0,0,0,.4);flex-shrink:0}
  .studio-sidebar--open{transform:translateX(0)}
  .studio-sidebar-toggle{display:flex;align-items:center;gap:6px;margin-bottom:12px;padding:8px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--cyan);font-size:12px;font-weight:600;cursor:pointer;width:100%;justify-content:center}
  .studio-header p{display:none}
  .studio-input-row{flex-direction:column}
  .studio-input-row textarea{min-height:72px;font-size:13px}
}
.studio-input-row{display:flex;gap:8px;margin-bottom:16px;align-items:flex-start}
.studio-input-row textarea{flex:1;resize:vertical;min-height:90px;max-height:200px;padding:10px 14px;font-size:13px;border-radius:var(--r);border:1px solid var(--border2);line-height:1.5}
.studio-input-row textarea:focus{border-color:var(--green3)}
.studio-run-btn{background:var(--green3);color:var(--bg);padding:0 16px;border-radius:var(--r);font-weight:600;font-size:12px;white-space:nowrap;align-self:stretch;min-width:80px;letter-spacing:.2px}
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
/* ── Workflow scene (office layout, replaces cramped pill nodes) ── */
.studio-canvas{background:none!important;border:none!important;padding:0!important;margin-bottom:0!important}
#studioNodes .prl-office{border-radius:10px;border:1px solid rgba(99,102,241,.25);margin-bottom:16px;min-height:200px;padding:16px 12px 12px;position:relative;overflow:hidden}
.wf-office{display:block}
.wf-desks-row{display:flex;align-items:flex-end;justify-content:center;gap:6px;flex-wrap:wrap;padding-bottom:10px}
.wf-desk{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;transition:opacity .2s}
.wf-desk:hover{opacity:.85}
.wf-desk--active{filter:drop-shadow(0 0 8px #6366f188)}
.wf-desk--done{filter:drop-shadow(0 0 6px #22c55e55)}
.wf-desk--err{filter:drop-shadow(0 0 6px #ef444455)}
.wf-desk-name{font-size:9px;font-weight:600;text-align:center;max-width:88px;word-break:break-word;line-height:1.3;padding:0 2px;margin-top:2px}
.wf-master{position:absolute;bottom:20px;right:16px}
/* Orchestrator speech bubble — sbraita */
.wf-sbraita-bubble{position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:#1a0a0a;border:1.5px solid #ef4444;color:#fca5a5;font-family:var(--mono);font-size:9px;font-weight:800;padding:3px 8px;border-radius:8px;white-space:nowrap;letter-spacing:.5px;animation:sbraitaPop .4s ease-in-out infinite alternate;pointer-events:none;z-index:4}
.wf-sbraita-bubble::after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#ef4444}
@keyframes sbraitaPop{0%{transform:translateX(-50%) scale(1) rotate(-2deg)}100%{transform:translateX(-50%) scale(1.06) rotate(2deg)}}
/* ── Parliament Boardroom — bright office, same palette as workflow scene ── */
.br-wrap{background:var(--bg2);border:1.5px solid var(--border);border-radius:14px;padding:12px 14px;margin-bottom:16px;animation:stNodeIn .35s ease forwards;overflow:hidden;width:100%;box-sizing:border-box}
.br-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.br-phase-chip{font-size:10px;font-weight:800;font-family:var(--mono);letter-spacing:.3px;color:var(--pc,#6366f1);background:rgba(99,102,241,.1);border:1px solid var(--pc,rgba(99,102,241,.35));border-radius:20px;padding:3px 12px;display:inline-block;transition:color .4s,border-color .4s}
.br-progress-wrap{flex:1;height:3px;background:var(--border);border-radius:4px;overflow:hidden;min-width:60px}
.br-progress-bar{height:100%;background:linear-gradient(90deg,#6366f1,#22d3ee);border-radius:4px;transition:width .5s ease;width:0%}
/* Boardroom scene — bgSvg covers background */
.br-room{position:relative;width:100%;min-height:480px;overflow:hidden;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.18)}
/* Seats rows above/below table */
.br-seats-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;justify-content:space-around}
/* Agent seat — FREE (no box, just emoji + name floating) */
.br-seat{display:flex;flex-direction:column;align-items:center;gap:2px;transition:transform .35s;padding:4px 6px;border-radius:10px;background:transparent;border:none;box-shadow:none;min-width:56px;cursor:default}
.br-seat--active{transform:scale(1.14) translateY(-5px)}
.br-seat--done{opacity:.88}
/* Emoji character */
.br-char{font-size:40px;line-height:1;user-select:none;transition:filter .4s}
@keyframes brCharBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
/* Orchestrator head — large, no box */
.br-orch{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 10px;flex-shrink:0;position:relative}
.br-orch-inner{display:flex;flex-direction:column;align-items:center;gap:0;position:relative}
.br-orch-crown{font-size:22px;line-height:1;display:block;text-align:center;animation:brCrownFloat 2s ease-in-out infinite}
@keyframes brCrownFloat{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-3px) rotate(4deg)}}
.br-orch-emoji{font-size:54px;line-height:1;display:block;filter:drop-shadow(0 0 16px #818cf8AA);transition:filter .3s}
.br-orch--active .br-orch-emoji{animation:brOrchWalk 1.4s ease-in-out infinite alternate;filter:drop-shadow(0 0 20px #6366f1CC)}
@keyframes brOrchWalk{0%{transform:translateX(0) scale(1)}100%{transform:translateX(14px) scale(1.07)}}
.br-orch--done .br-orch-emoji{animation:orchBounce .7s ease forwards}
.br-orch-speech{font-size:10px;font-weight:800;font-family:var(--mono);padding:4px 10px;border:2px solid #374151;border-radius:10px;background:#ffffff;color:#000000;white-space:nowrap;animation:brSpeechPop .7s ease-in-out infinite alternate;pointer-events:none;margin-bottom:4px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
@keyframes brSpeechPop{0%{transform:scale(1) rotate(-1deg)}100%{transform:scale(1.06) rotate(1deg)}}
.br-orch-label{font-size:9px;font-family:var(--mono);font-weight:800;color:#000000;background:rgba(255,255,255,.92);border-radius:6px;padding:2px 8px;margin-top:2px}
/* Bubble above agent */
.br-bubble{font-size:9px;font-family:var(--mono);font-weight:700;padding:4px 9px;border-radius:10px 10px 10px 2px;border:1.5px solid #374151;background:#ffffff;color:#000000;line-height:1.4;word-break:break-word;max-width:120px;white-space:normal;box-shadow:0 2px 8px rgba(0,0,0,.12);margin-bottom:3px}
/* Agent name pill */
.br-seat-name{font-size:9px;font-family:var(--mono);font-weight:600;color:#374151;text-align:center;white-space:normal;word-break:break-word;max-width:100px;line-height:1.3;margin-top:1px;background:rgba(255,255,255,.75);border-radius:4px;padding:1px 4px;transition:color .3s,font-weight .2s;backdrop-filter:blur(2px)}
.br-seat--active .br-seat-name{color:#000000;font-weight:800}
.br-seat--done .br-seat-name{color:#111827}
@keyframes brDotFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
/* Convergence */
.br-convergence{margin-top:10px;padding:8px 12px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2);border-radius:8px}
.br-conv-bar-outer{height:4px;background:rgba(99,102,241,.15);border-radius:4px;overflow:hidden;margin-bottom:6px}
.br-conv-bar-inner{height:100%;background:linear-gradient(90deg,#6366f1,#818cf8);border-radius:4px;transition:width .8s ease}
.br-conv-text{font-size:9px;color:#86efac;line-height:1.55}
@keyframes brDashFlow{0%{stroke-dashoffset:20}100%{stroke-dashoffset:0}}
/* Keep old prl-* classes for workflow (not touched) */
.prl-wrap{background:#0b0918;border:1.5px solid #6366f1;border-radius:14px;padding:14px 16px 12px;margin-bottom:16px;animation:stNodeIn .35s ease forwards;overflow:hidden}
@keyframes parlPulse{0%,100%{border-color:#6366f1;box-shadow:none}50%{border-color:#818cf8;box-shadow:0 0 20px rgba(99,102,241,.3)}}
.prl-header{display:flex;align-items:center;margin-bottom:10px}
.prl-phase-chip{font-size:10px;font-weight:800;font-family:var(--mono);letter-spacing:.3px;color:var(--pc,#6366f1);background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.35);border-radius:20px;padding:3px 12px;display:inline-block}
/* ── Office room — bright, lit, full scene ── */
.prl-office{position:relative;min-height:160px;display:flex;align-items:flex-end;padding:0 0 14px 0;overflow:hidden;border-radius:10px;
  background:linear-gradient(180deg,#1a1440 0%,#221a52 40%,#2a2060 70%,#1e1a42 100%)}
/* Back wall — ambient light from ceiling + panel lines */
.prl-office::before{content:"";position:absolute;inset:0;background:
  radial-gradient(ellipse 80% 60% at 50% 0%,rgba(180,160,255,.18) 0%,transparent 70%),
  repeating-linear-gradient(90deg,transparent,transparent 79px,rgba(255,255,255,.04) 80px);pointer-events:none;z-index:0}
/* Floor — warm parquet with shine */
.prl-office-floor{position:absolute;bottom:0;left:0;right:0;height:16px;
  background:repeating-linear-gradient(90deg,#2a1c10 0px,#3d2a18 40px,#2c1e12 41px,#2a1c10 80px);
  border-top:2px solid rgba(180,120,60,.3);box-shadow:0 -1px 0 rgba(255,200,100,.08),inset 0 2px 4px rgba(255,180,80,.06);z-index:1}
/* THREE centered windows — sky blue with sunlight */
.prl-office-window{position:absolute;top:4px;left:50%;transform:translateX(-50%);width:120px;height:52px;display:flex;gap:4px;z-index:1;pointer-events:none}
.prl-office-window::before,.prl-office-window::after{content:"";flex:1;background:linear-gradient(180deg,#7ecfff 0%,#a8e4ff 40%,#c8f0ff 100%);border:1.5px solid #4a8fbb;border-radius:3px;
  box-shadow:inset 0 0 8px rgba(255,255,255,.4),0 0 16px rgba(100,200,255,.25);position:relative}
/* Center divider of each window pane */
/* Sunlight shafts from windows */
.prl-office-window-light{position:absolute;top:0;left:50%;transform:translateX(-50%);width:200px;height:100%;
  background:linear-gradient(175deg,rgba(200,240,255,.12) 0%,rgba(180,220,255,.06) 30%,transparent 60%);pointer-events:none;z-index:1}
/* Chandelier hanging from ceiling — center */
.prl-office-lamp{position:absolute;top:0;left:50%;transform:translateX(-50%);width:4px;height:18px;background:rgba(255,220,150,.3);z-index:3}
.prl-office-lamp::before{content:"";position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:32px;height:14px;border-radius:50%;background:radial-gradient(ellipse,rgba(255,220,100,.5) 0%,rgba(255,180,50,.2) 60%,transparent 100%);box-shadow:0 0 30px rgba(255,200,80,.5),0 0 60px rgba(255,200,80,.2),0 0 100px rgba(255,200,80,.08)}
.prl-office-lamp::after{content:"";position:absolute;bottom:-2px;left:50%;transform:translateX(-50%);width:20px;height:10px;background:radial-gradient(ellipse,rgba(255,220,150,.8) 0%,rgba(255,200,100,.4) 50%,transparent 100%);border-radius:50%;filter:blur(3px)}
/* Standing lamp (floor lamp) — right side */
.prl-office-lamp2{position:absolute;bottom:14px;right:28px;width:3px;height:44px;background:linear-gradient(180deg,#4a4060 0%,#3a3050 100%);border-radius:2px;z-index:2}
.prl-office-lamp2::before{content:"";position:absolute;top:-6px;left:50%;transform:translateX(-50%);width:18px;height:10px;background:linear-gradient(135deg,#4a4060,#6a6080);border-radius:3px 3px 0 0;box-shadow:0 -4px 20px rgba(255,220,150,.4),0 -2px 40px rgba(255,200,80,.2)}
.prl-office-lamp2::after{content:"";position:absolute;top:-3px;left:50%;transform:translateX(-50%);width:22px;height:16px;background:radial-gradient(ellipse,rgba(255,220,120,.6) 0%,rgba(255,200,80,.2) 60%,transparent 100%);border-radius:50%;filter:blur(4px)}
/* Wall art frames — left+center+right */
.prl-office-frame{position:absolute;top:6px;right:8px;width:30px;height:22px;border:2px solid rgba(180,160,255,.4);border-radius:2px;background:linear-gradient(135deg,#2a1060,#103060);box-shadow:0 2px 6px rgba(0,0,0,.4),inset 0 0 6px rgba(150,100,255,.15);z-index:1;overflow:hidden}
.prl-office-frame::before{content:"";position:absolute;inset:2px;border-radius:1px;background:linear-gradient(135deg,#3a1a6e 0%,#0a2060 50%,#1a3a20 100%)}
.prl-office-frame::after{content:"";position:absolute;top:4px;left:50%;transform:translateX(-50%);width:60%;height:1px;background:rgba(255,255,255,.2)}
/* Second frame */
.prl-office-frame2{position:absolute;top:6px;right:46px;width:22px;height:16px;border:2px solid rgba(180,160,255,.35);border-radius:2px;background:linear-gradient(135deg,#1a1030,#0a2030);box-shadow:0 2px 4px rgba(0,0,0,.3);z-index:1}
.prl-office-frame2::before{content:"";position:absolute;inset:2px;background:linear-gradient(45deg,#2e1060,#102040);border-radius:1px}
/* Poster left — inspirational */
.prl-office-poster{position:absolute;top:6px;left:8px;width:28px;height:20px;border:1.5px solid rgba(100,200,255,.3);border-radius:2px;background:linear-gradient(135deg,#0a1840,#0a3040);box-shadow:0 2px 4px rgba(0,0,0,.3);z-index:1}
.prl-office-poster::before{content:"";position:absolute;inset:2px;background:linear-gradient(180deg,#0a2060 0%,#103050 40%,#0a1040 100%);border-radius:1px}
.prl-office-poster::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(100,200,255,.05) 3px);border-radius:1px}
/* Plant left — larger, luminous */
.prl-office-plant{position:absolute;bottom:14px;left:4px;width:22px;height:42px;z-index:2;pointer-events:none}
/* Plant right */
.prl-office-plant2{position:absolute;bottom:14px;right:8px;width:22px;height:42px;z-index:2;pointer-events:none}
/* ── OFFICE SCENE ── */
.iso-scene{background:#f0ede6;cursor:default;max-width:100%;overflow-x:auto;box-shadow:0 4px 24px rgba(0,0,0,.18);border-radius:12px;overflow:hidden}
.iso-station{display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;transition:filter .2s,transform .2s;padding:8px 4px;border-radius:12px;border:1.5px solid transparent;position:relative}
.iso-station:hover{filter:brightness(1.06);transform:translateY(-2px)}
.iso-char-mover{position:relative;transition:transform 0.9s cubic-bezier(.4,0,.2,1)}
.iso-char-mover.iso-orch-done{animation:orchBounce .7s ease forwards}
@keyframes orchBounce{0%{transform:scale(1)}40%{transform:scale(1.18) translateY(-6px)}100%{transform:scale(1)}}
/* Fly-doc: multiple sheets flying from monitor upward */
.iso-fly-doc{position:absolute;top:2px;left:50%;font-size:14px;pointer-events:none;z-index:25}
.iso-fly-doc span{position:absolute;display:block;animation:flySheet 1.4s ease-in-out infinite}
.iso-fly-doc span:nth-child(1){animation-delay:0s;left:-10px}
.iso-fly-doc span:nth-child(2){animation-delay:.45s;left:2px}
.iso-fly-doc span:nth-child(3){animation-delay:.9s;left:12px}
@keyframes flySheet{0%{transform:translateY(0) rotate(-8deg);opacity:0}15%{opacity:1}60%{transform:translateY(-38px) rotate(14deg);opacity:.9}100%{transform:translateY(-58px) rotate(-5deg);opacity:0}}
.iso-desk{width:90%;height:16px;background:linear-gradient(180deg,#d4a448 0%,#b8832a 100%);border-radius:4px 4px 2px 2px;box-shadow:0 4px 0 #8a5e18,0 6px 10px rgba(0,0,0,.3);border-top:2px solid #e8c060;position:relative;margin-top:4px}
.iso-desk::after{content:'';position:absolute;bottom:-4px;left:8px;right:8px;height:4px;background:#7a5010;border-radius:0 0 3px 3px}
.iso-monitor{width:56px;height:40px;background:#12101e;border:2px solid #3a3070;border-radius:5px;display:flex;align-items:center;justify-content:center;position:relative;margin-bottom:-2px}
.iso-monitor::after{content:'';position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);width:10px;height:5px;background:#252436;border-radius:0 0 3px 3px}
.iso-monitor-screen{width:44px;height:28px;background:rgba(60,40,160,.35);border-radius:2px;display:flex;align-items:center;justify-content:center}
.iso-monitor-blink{width:7px;height:7px;border-radius:50%;background:#6366f1;animation:monBlink .9s ease-in-out infinite;margin-right:6px}
@keyframes monBlink{0%,100%{opacity:1;box-shadow:0 0 8px #6366f1}50%{opacity:.25;box-shadow:none}}
.iso-tool-badge{font-size:22px;line-height:1;filter:drop-shadow(0 2px 5px rgba(0,0,0,.35));user-select:none;margin-bottom:1px}
/* Animated status chip for [bracket tokens] */
.iso-status-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:20px;padding:3px 10px;font-size:11px;font-family:var(--mono);color:#818cf8;animation:statusPulse 2s ease-in-out infinite}
@keyframes statusPulse{0%,100%{opacity:.7;border-color:rgba(99,102,241,.3)}50%{opacity:1;border-color:rgba(99,102,241,.7);box-shadow:0 0 8px rgba(99,102,241,.3)}}
.iso-status-dot{width:6px;height:6px;border-radius:50%;background:#6366f1;animation:dotBounce 1s ease-in-out infinite}
.iso-agent{transition:filter .3s}
.iso-agent:hover{filter:brightness(1.1) saturate(1.2)}
.iso-char-wrap{transition:transform .2s,box-shadow .3s}
.iso-char-wrap.prl-head{animation:isoCharBob 1.2s ease-in-out infinite}
@keyframes isoCharBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.iso-orch-wrap{transition:transform .2s}
.iso-orch-wrap.prl-head{animation:isoCharBob 1.4s ease-in-out infinite}
/* Thought bubble / speech bubble above character */
.iso-bubble{font-size:9px;font-family:var(--mono);padding:3px 9px;border-radius:12px;border:1px solid #ccc;background:rgba(255,255,255,.9);color:#6b7280;white-space:normal;word-break:break-word;max-width:160px;line-height:1.4;transition:all .25s;pointer-events:none;backdrop-filter:blur(6px);text-align:center}
.iso-bubble--active{background:#ffffff;border-color:#1d4ed8;color:#000000;animation:isoBubblePop .35s ease;white-space:normal;max-width:160px;word-break:break-word;line-height:1.35}
.iso-bubble--orch{font-size:9px;padding:3px 9px;border-radius:12px;border-color:#374151;color:#111827;background:rgba(255,255,255,.92)}
@keyframes isoBubblePop{0%{transform:scale(.8) translateY(4px);opacity:.4}100%{transform:scale(1) translateY(0);opacity:1}}
.iso-name{font-size:10px;font-family:var(--mono);font-weight:700;letter-spacing:.3px;text-align:center;max-width:160px;white-space:normal;word-break:break-word;line-height:1.3;background:rgba(255,255,255,.85);border-radius:6px;padding:2px 6px;pointer-events:none;backdrop-filter:blur(4px)}
/* Desks row — kept for boardroom compat */
.prl-desks-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;position:relative;z-index:2;padding-bottom:8px}
.prl-desk{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 6px 4px;border-radius:12px;background:#1a1535;border:1.5px solid #3a3060;transition:border-color .4s,background .4s,box-shadow .4s;position:relative;min-width:80px;box-shadow:0 2px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06)}
.prl-desk--active{background:#1e1a45;border-color:var(--dc,#6366f1);box-shadow:0 0 20px rgba(99,102,241,.3),0 0 40px rgba(99,102,241,.1),inset 0 1px 0 rgba(150,130,255,.15)}
.prl-desk--done{border-color:#2a4a2a;background:#162516}
.prl-action-bubble{font-size:9px;color:#6b7280;font-family:var(--mono);padding:2px 6px;border-radius:8px;background:#111;border:1px solid #2a2a38;min-height:16px;text-align:center;white-space:normal;word-break:break-word;max-width:88px;line-height:1.3;transition:all .3s}
.prl-action-bubble--active{color:#000000;font-weight:700;border-color:#374151;background:#ffffff;animation:parlBubblePop .4s ease}
@keyframes parlBubblePop{0%{transform:scale(.85);opacity:.5}100%{transform:scale(1);opacity:1}}
@keyframes streamBlink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes wcBubbleIn{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes wcRobotBob{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-5px) rotate(-4deg)}}
@keyframes wcDot{0%,80%,100%{opacity:.25;transform:scale(.7)}40%{opacity:1;transform:scale(1.2)}}
@keyframes wcBarPulse{0%,100%{opacity:1}50%{opacity:.65}}
/* Character SVG animations */
@keyframes parlArmType{0%,100%{transform:rotate(-8deg) translateY(0)}50%{transform:rotate(8deg) translateY(2px)}}
@keyframes parlHeadNod{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(2px) rotate(4deg)}}
@keyframes parlDocBob{0%,100%{transform:translateY(0) rotate(-5deg)}50%{transform:translateY(-3px) rotate(5deg)}}
.prl-arm{transform-origin:50% 100%;animation:parlArmType .55s ease-in-out infinite}
.prl-head{transform-origin:50% 100%;animation:parlHeadNod .8s ease-in-out infinite}
.prl-doc-hold{transform-origin:center center;animation:parlDocBob .7s ease-in-out infinite}
/* Agent name label */
.prl-desk-name{font-size:9px;font-family:var(--mono);font-weight:700;letter-spacing:.3px;text-align:center;white-space:normal;word-break:break-word;max-width:88px;line-height:1.3}
/* MASTER ORCHESTRATOR */
.prl-master{position:absolute;bottom:8px;right:8px;display:flex;flex-direction:column;align-items:center;gap:1px;z-index:3;transition:right .8s cubic-bezier(.4,0,.2,1)}
.prl-master-label{font-size:8px;font-family:var(--mono);font-weight:700;letter-spacing:.4px;text-align:center;text-shadow:0 0 8px currentColor}
/* Walking animation — smooth left-right patrol */
/* Executive walk: slow measured patrol left↔right */
@keyframes parlMasterWalk{0%{right:8px;transform:scaleX(1)}35%{right:calc(100% - 70px);transform:scaleX(1)}40%{right:calc(100% - 70px);transform:scaleX(-1)}75%{right:8px;transform:scaleX(-1)}80%{right:8px;transform:scaleX(1)}100%{right:8px;transform:scaleX(1)}}
/* Legs: slow dignified stride */
@keyframes parlMasterLegL{0%,100%{transform:rotate(0deg)}25%{transform:rotate(18deg)}75%{transform:rotate(-14deg)}}
@keyframes parlMasterLegR{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-14deg)}75%{transform:rotate(18deg)}}
/* Arms: clipboard-holding executive swing — tight, not flailing */
@keyframes parlMasterArmL{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-12deg)}}
@keyframes parlMasterArmR{0%,100%{transform:rotate(0deg)}50%{transform:rotate(8deg)}}
/* Clipboard bob while walking — authority gesture */
@keyframes parlMasterClipboard{0%,100%{transform:rotate(0deg) translateY(0)}30%{transform:rotate(-6deg) translateY(-1px)}70%{transform:rotate(4deg) translateY(1px)}}
/* Whole body: subtle sway of a confident executive */
@keyframes parlMasterBodySway{0%,100%{transform:translateY(0) rotate(0deg)}25%{transform:translateY(-2px) rotate(.6deg)}75%{transform:translateY(-1px) rotate(-.5deg)}}
.prl-master-walk{animation:parlMasterWalk 16s cubic-bezier(.45,0,.55,1) infinite}
.prl-master-walk .prl-master-leg-l{transform-origin:50% 0;animation:parlMasterLegL 1.8s ease-in-out infinite}
.prl-master-walk .prl-master-leg-r{transform-origin:50% 0;animation:parlMasterLegR 1.8s ease-in-out infinite}
.prl-master-walk .prl-master-arm-l{transform-origin:50% 0;animation:parlMasterArmL 2.2s ease-in-out infinite}
.prl-master-walk .prl-master-arm-r{transform-origin:50% 0;animation:parlMasterArmR 2.2s ease-in-out infinite}
/* R2 supervise: executive pacing — short back-and-forth at the active desk */
@keyframes parlMasterSupervise{0%{right:8px}30%{right:28px}60%{right:10px}80%{right:24px}100%{right:8px}}
.prl-master-supervise{animation:parlMasterSupervise 8s ease-in-out infinite}
.prl-master-supervise .prl-master-leg-l{transform-origin:50% 0;animation:parlMasterLegL 1.8s ease-in-out infinite}
.prl-master-supervise .prl-master-leg-r{transform-origin:50% 0;animation:parlMasterLegR 1.8s ease-in-out infinite}
.prl-master-supervise .prl-master-arm-l{transform-origin:50% 0;animation:parlMasterArmL 2.2s ease-in-out infinite}
.prl-master-supervise .prl-master-arm-r{transform-origin:50% 0;animation:parlMasterArmR 2.2s ease-in-out infinite}
/* Done: standing still — no walk animation */
.prl-master-done{animation:none}
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
.studio-log-entry{margin-bottom:10px;padding:14px 16px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);min-height:80px}
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
.studio-tools-panel{width:100%;border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--bg2);max-height:calc(100vh - 200px);overflow-y:auto}
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

  <button onclick="openSidebar()" style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:100;background:var(--bg2);border:1px solid var(--green3);border-radius:24px;color:var(--green);font-size:13px;font-weight:700;padding:8px 20px;cursor:pointer;line-height:1;box-shadow:0 2px 12px rgba(0,0,0,.5);letter-spacing:.3px" id="mobileBurger">&#9776; Menu</button>

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
