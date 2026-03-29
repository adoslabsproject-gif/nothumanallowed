/**
 * nha voice — Voice-powered chat interface.
 *
 * Opens a local web page with a microphone button. Uses the browser's native
 * Web Speech API (SpeechRecognition) for speech-to-text — zero server-side
 * transcription needed. If the user has an OpenAI key, optionally uses Whisper
 * API for higher-accuracy transcription via MediaRecorder + server upload.
 *
 * Transcribed text is routed through the same /api/chat pipeline as nha chat.
 * Responses are spoken back via Web Speech Synthesis API in the browser.
 *
 * All tool definitions, parsing, and execution are in tool-executor.mjs (DRY).
 *
 * Zero npm dependencies — Node.js 22 native http module only.
 */

import http from 'http';
import { exec } from 'child_process';
import { loadConfig } from '../config.mjs';
import { callLLM } from '../services/llm.mjs';
import { VERSION } from '../constants.mjs';
import { info, ok, fail, warn, C, G, D, NC, BOLD } from '../ui.mjs';
import {
  parseActions,
  executeTool,
  buildSystemPrompt,
} from '../services/tool-executor.mjs';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3849;

const VOICE_PERSONA = `You are NHA Voice, a voice-powered personal operations assistant inside the NotHumanAllowed CLI. ` +
  `You help the user manage their emails, calendar, tasks, GitHub, Notion, and Slack through voice commands. ` +
  `Keep responses SHORT and SPOKEN-FRIENDLY — 2-3 sentences max. ` +
  `Avoid markdown formatting, bullet points, numbered lists. Use natural spoken language.`;

// ── Whisper transcription (OpenAI API) ──────────────────────────────────────

async function transcribeWithWhisper(audioBase64, config) {
  const openaiKey = config.llm.openaiKey || (config.llm.provider === 'openai' ? config.llm.apiKey : '');
  if (!openaiKey) throw new Error('No OpenAI key for Whisper transcription');

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const boundary = '----NHAVoiceBoundary' + Date.now().toString(36);
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1\r\n`
  );

  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
    `Content-Type: audio/webm\r\n\r\n`
  );

  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, audioBuffer, footer]);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.text || '';
}

// ── Voice HTML page ─────────────────────────────────────────────────────────

function getVoiceHTML(port, useWhisper) {
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

.voice-app{display:flex;flex-direction:column;height:100vh;height:100dvh;max-width:640px;margin:0 auto;padding:16px}
.voice-header{text-align:center;padding:24px 0 16px}
.voice-header__title{font-size:20px;color:var(--green);font-weight:700;letter-spacing:2px}
.voice-header__sub{font-size:11px;color:var(--dim);margin-top:4px}

.voice-messages{flex:1;overflow-y:auto;padding:12px 0;-webkit-overflow-scrolling:touch}
.voice-msg{margin-bottom:14px;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.voice-msg--user .voice-msg__bubble{background:var(--bg3);border:1px solid var(--border2);border-radius:12px 12px 2px 12px;padding:12px 16px;max-width:85%;margin-left:auto;color:var(--bright)}
.voice-msg--assistant .voice-msg__bubble{background:var(--greendim);border:1px solid var(--green3);border-radius:12px 12px 12px 2px;padding:12px 16px;max-width:85%;color:var(--text);white-space:pre-wrap;word-wrap:break-word}
.voice-msg__label{font-size:10px;color:var(--dim);margin-bottom:3px}
.voice-msg--thinking{color:var(--dim);font-style:italic}

.voice-controls{display:flex;flex-direction:column;align-items:center;gap:16px;padding:20px 0;border-top:1px solid var(--border);flex-shrink:0}
.voice-mic{width:80px;height:80px;border-radius:50%;border:3px solid var(--green3);background:var(--bg2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;position:relative}
.voice-mic:hover{border-color:var(--green);background:var(--greendim)}
.voice-mic--recording{border-color:var(--red);background:rgba(255,23,68,0.15);animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,23,68,0.4)}50%{box-shadow:0 0 0 20px rgba(255,23,68,0)}}
.voice-mic__icon{font-size:32px;color:var(--green);transition:color .2s}
.voice-mic--recording .voice-mic__icon{color:var(--red)}
.voice-status{font-size:11px;color:var(--dim);min-height:16px}
.voice-mode{font-size:10px;color:var(--dim)}
.voice-mode__btn{background:none;border:1px solid var(--border2);color:var(--dim);padding:4px 10px;border-radius:12px;font-size:10px;font-family:var(--font);cursor:pointer;margin:0 4px}
.voice-mode__btn--active{border-color:var(--green3);color:var(--green)}

.voice-text-bar{display:flex;gap:8px;width:100%;max-width:500px}
.voice-text-bar input{flex:1;background:var(--bg2);color:var(--text);border:1px solid var(--border);padding:10px 14px;border-radius:var(--r);font-size:13px;font-family:var(--font);outline:none}
.voice-text-bar input:focus{border-color:var(--green3)}
.voice-text-bar button{background:var(--green3);color:var(--bg);padding:10px 18px;border-radius:var(--r);font-weight:700;font-size:12px;font-family:var(--font);cursor:pointer;border:none}

.toast{position:fixed;top:16px;right:16px;z-index:500;background:var(--bg3);border:1px solid var(--green);border-radius:8px;padding:12px 16px;max-width:300px;animation:slideIn .3s;font-size:12px;color:var(--text)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:none;opacity:1}}
`;

  const JS = `
var API = '';
var chatHistory = (function(){try{var s=localStorage.getItem('nha_voice_history');return s?JSON.parse(s):[];}catch(e){return [];}})();
function saveVoiceToStorage(){try{localStorage.setItem('nha_voice_history',JSON.stringify(chatHistory.slice(-20)));}catch(e){}}
var isRecording = false;
var recognition = null;
var mediaRecorder = null;
var audioChunks = [];
var useWhisper = ${useWhisper ? 'true' : 'false'};
var speechSynthEnabled = true;

function apiPost(p, b) {
  return fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then(function(r) { return r.ok ? r.json() : null })
    .catch(function() { return null });
}

function esc(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }

function initWebSpeech() {
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  var rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  rec.maxAlternatives = 1;

  rec.onresult = function(event) {
    var transcript = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    setStatus('Heard: ' + transcript.slice(0, 60) + (transcript.length > 60 ? '...' : ''));

    if (event.results[event.results.length - 1].isFinal) {
      stopRecording();
      if (transcript.trim()) {
        processMessage(transcript.trim());
      }
    }
  };

  rec.onerror = function(e) {
    setStatus('Speech error: ' + e.error);
    stopRecording();
  };

  rec.onend = function() {
    if (isRecording) stopRecording();
  };

  return rec;
}

function startWhisperRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

    mediaRecorder.ondataavailable = function(e) {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = function() {
      stream.getTracks().forEach(function(t) { t.stop(); });
      if (audioChunks.length === 0) return;

      var blob = new Blob(audioChunks, { type: 'audio/webm' });
      setStatus('Transcribing with Whisper...');

      var reader = new FileReader();
      reader.onloadend = function() {
        var base64 = reader.result.split(',')[1];
        apiPost('/api/voice/transcribe', { audio: base64 }).then(function(r) {
          if (r && r.text) {
            processMessage(r.text);
          } else {
            setStatus('Transcription failed: ' + (r && r.error || 'unknown error'));
          }
        });
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.start();
  }).catch(function(err) {
    setStatus('Microphone error: ' + err.message);
    stopRecording();
  });
}

function toggleRecording() {
  if (isRecording) { stopRecording(); } else { startRecording(); }
}

function startRecording() {
  isRecording = true;
  var mic = document.getElementById('mic');
  mic.classList.add('voice-mic--recording');
  setStatus('Listening...');

  if (useWhisper) {
    startWhisperRecording();
  } else {
    if (!recognition) recognition = initWebSpeech();
    if (recognition) {
      recognition.start();
    } else {
      setStatus('Speech Recognition not supported in this browser. Use Chrome.');
      stopRecording();
    }
  }
}

function stopRecording() {
  isRecording = false;
  var mic = document.getElementById('mic');
  mic.classList.remove('voice-mic--recording');

  if (useWhisper && mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else if (recognition) {
    try { recognition.stop(); } catch(e) {}
  }
}

function speak(text) {
  if (!speechSynthEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  var codeBlockRe = new RegExp('\\x60\\x60\\x60[\\\\s\\\\S]*?\\x60\\x60\\x60', 'g');
  var clean = text
    .replace(codeBlockRe, '')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '$1')
    .replace(/\\*([^*]+)\\*/g, '$1')
    .replace(/#+\\s/g, '')
    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')
    .replace(/\\n/g, '. ')
    .trim();

  if (!clean) return;

  var utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  var voices = window.speechSynthesis.getVoices();
  var preferred = voices.find(function(v) { return v.name.includes('Samantha') || v.name.includes('Google US English') || v.name.includes('Microsoft Zira'); });
  if (preferred) utterance.voice = preferred;

  window.speechSynthesis.speak(utterance);
}

function processMessage(text) {
  chatHistory.push({ role: 'user', content: text });
  saveVoiceToStorage();renderMessages();

  chatHistory.push({ role: 'assistant', content: 'Thinking...' });
  renderMessages();

  setStatus('Processing...');

  apiPost('/api/chat', { message: text, history: chatHistory.slice(0, -1) }).then(function(r) {
    chatHistory.pop();
    var response = '';
    if (r && r.response) {
      response = r.response;
      chatHistory.push({ role: 'assistant', content: response });
    } else if (r && r.error) {
      response = 'Error: ' + r.error;
      chatHistory.push({ role: 'assistant', content: response });
    } else {
      response = 'No response from server.';
      chatHistory.push({ role: 'assistant', content: response });
    }
    saveVoiceToStorage();renderMessages();
    setStatus('');
    speak(response);
  });
}

function renderMessages() {
  var el = document.getElementById('messages');
  if (!el) return;

  if (chatHistory.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:60px 16px;color:var(--dim)">' +
      '<div style="font-size:48px;margin-bottom:12px">&#127908;</div>' +
      '<div style="font-size:14px;color:var(--green);margin-bottom:8px">Voice Assistant Ready</div>' +
      '<div style="font-size:11px">Click the microphone or type below</div></div>';
    return;
  }

  var h = '';
  chatHistory.forEach(function(m) {
    var isThinking = m.content === 'Thinking...';
    h += '<div class="voice-msg voice-msg--' + esc(m.role) + (isThinking ? ' voice-msg--thinking' : '') + '">' +
      '<div class="voice-msg__label">' + esc(m.role === 'user' ? 'You' : 'NHA') + '</div>' +
      '<div class="voice-msg__bubble">' + esc(m.content) + '</div></div>';
  });

  el.innerHTML = h;
  el.scrollTop = el.scrollHeight;
}

function setStatus(text) {
  var el = document.getElementById('status');
  if (el) el.textContent = text;
}

function sendTextInput() {
  var inp = document.getElementById('textInput');
  if (!inp) return;
  var text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  processMessage(text);
}

function setMode(mode) {
  useWhisper = (mode === 'whisper');
  document.getElementById('modeWebSpeech').className = 'voice-mode__btn' + (!useWhisper ? ' voice-mode__btn--active' : '');
  document.getElementById('modeWhisper').className = 'voice-mode__btn' + (useWhisper ? ' voice-mode__btn--active' : '');
}

function toggleSpeech() {
  speechSynthEnabled = !speechSynthEnabled;
  var btn = document.getElementById('toggleSpeechBtn');
  if (btn) btn.textContent = speechSynthEnabled ? 'Speaker: ON' : 'Speaker: OFF';
}

document.addEventListener('keydown', function(e) {
  if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    toggleRecording();
  }
});

renderMessages();

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = function() { window.speechSynthesis.getVoices(); };
}
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<title>NHA Voice</title>
<style>${CSS}</style>
</head>
<body>

<div class="voice-app">
  <div class="voice-header">
    <div class="voice-header__title">NHA VOICE</div>
    <div class="voice-header__sub">Speak to your agents. Press Space or click the mic.</div>
  </div>

  <div class="voice-messages" id="messages"></div>

  <div class="voice-controls">
    <div class="voice-mode">
      <button class="voice-mode__btn voice-mode__btn--active" id="modeWebSpeech" onclick="setMode('web')">Browser Speech</button>
      <button class="voice-mode__btn" id="modeWhisper" onclick="setMode('whisper')">Whisper API</button>
      <button class="voice-mode__btn" id="toggleSpeechBtn" onclick="toggleSpeech()">Speaker: ON</button>
    </div>

    <button class="voice-mic" id="mic" onclick="toggleRecording()">
      <span class="voice-mic__icon">&#127908;</span>
    </button>

    <div class="voice-status" id="status"></div>

    <div class="voice-text-bar">
      <input type="text" id="textInput" placeholder="Or type here..." onkeydown="if(event.key==='Enter')sendTextInput()">
      <button onclick="sendTextInput()">Send</button>
    </div>
  </div>
</div>

<script>${JS}</script>
</body>
</html>`;
}

// ── HTTP Helpers ──────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 10_485_760; // 10 MB (audio can be large)
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${url}`, () => {});
}

// ── Server ───────────────────────────────────────────────────────────────

export async function cmdVoice(args) {
  let port = DEFAULT_PORT;
  let noBrowser = false;
  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10) || DEFAULT_PORT;
    } else if (arg === '--no-browser') {
      noBrowser = true;
    }
  }

  const config = loadConfig();

  if (!config.llm.apiKey) {
    fail('No API key configured. Run: nha config set key YOUR_KEY');
    process.exit(1);
  }

  const hasOpenAIKey = !!(config.llm.openaiKey || (config.llm.provider === 'openai' && config.llm.apiKey));

  const chatSystemPrompt = buildSystemPrompt('NHA Voice', VOICE_PERSONA, config);

  const htmlPage = getVoiceHTML(port, hasOpenAIKey);

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        sendHTML(res, htmlPage);
        return;
      }

      if (method === 'POST' && pathname === '/api/chat') {
        const body = await parseBody(req);
        if (!body.message) {
          sendJSON(res, 400, { error: 'message required' });
          return;
        }

        const history = body.history || [];
        const parts = [];
        for (const turn of history) {
          const prefix = turn.role === 'user' ? '[User]' : '[Assistant]';
          parts.push(`${prefix} ${turn.content}`);
        }
        parts.push(`[User] ${body.message}`);
        const userMessage = parts.join('\n\n');

        try {
          const response = await callLLM(config, chatSystemPrompt, userMessage);
          const { textParts, actions } = parseActions(response);
          const textResponse = textParts.join('\n\n');

          const toolResults = [];
          for (const { action, params } of actions) {
            try {
              const result = await executeTool(action, params, config);
              toolResults.push({ action, result: String(result) });
            } catch (e) {
              toolResults.push({ action, result: `Error: ${e.message}` });
            }
          }

          let fullResponse;
          if (toolResults.length > 0) {
            const toolContext = toolResults.map(t => `[${t.action} result]: ${t.result}`).join('\n\n');
            const followUp = `The user asked: "${body.message}"\n\nTool results:\n\n${toolContext}\n\nRespond conversationally based on these results. Keep it SHORT (2-3 sentences) since this will be spoken aloud.`;
            try {
              fullResponse = await callLLM(config, chatSystemPrompt, followUp);
            } catch {
              fullResponse = toolResults.map(t => `${t.result}`).join('. ');
            }
          } else {
            fullResponse = textResponse;
          }

          sendJSON(res, 200, { response: fullResponse, toolResults, actions });
        } catch (e) {
          sendJSON(res, 200, { response: null, error: e.message });
        }
        return;
      }

      if (method === 'POST' && pathname === '/api/voice/transcribe') {
        const body = await parseBody(req);
        if (!body.audio) {
          sendJSON(res, 400, { error: 'audio (base64) required' });
          return;
        }

        try {
          const text = await transcribeWithWhisper(body.audio, config);
          sendJSON(res, 200, { text });
        } catch (e) {
          sendJSON(res, 200, { text: null, error: e.message });
        }
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      sendJSON(res, 404, { error: 'Not found' });
    } catch (err) {
      try { sendJSON(res, 500, { error: 'Internal server error' }); } catch {}
    }
  }

  const server = http.createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fail(`Port ${port} is already in use. Try: nha voice --port=${port + 1}`);
      process.exit(1);
    }
    fail(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const localUrl = `http://127.0.0.1:${port}`;

    console.log('');
    console.log(`  ${BOLD}${C}NHA Voice${NC}`);
    console.log(`  ${D}Voice-powered personal operations assistant${NC}`);
    console.log('');
    console.log(`  ${G}Local:${NC}              ${localUrl}`);
    console.log(`  ${D}Provider:${NC}           ${config.llm.provider || 'not set'}`);
    console.log(`  ${D}Whisper available:${NC}  ${hasOpenAIKey ? G + 'yes' + NC : D + 'no (set openai-key for Whisper)' + NC}`);
    console.log(`  ${D}Speech mode:${NC}        Browser Web Speech API (default)`);
    console.log('');
    console.log(`  ${D}Press Space to toggle mic, or click the microphone button.${NC}`);
    console.log(`  ${D}Responses are spoken aloud via Speech Synthesis.${NC}`);
    console.log(`  ${D}Press Ctrl+C to stop${NC}`);
    console.log('');

    if (!noBrowser) {
      openBrowser(localUrl);
    }
  });

  const shutdown = () => {
    console.log(`\n  ${D}Shutting down...${NC}`);
    server.close(() => {
      console.log(`  ${D}Voice server stopped.${NC}\n`);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
