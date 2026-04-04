/**
 * CURIOUS AI v5 — Google Cloud STT + TTS + Gemini 2.0 Flash
 * Firebase Integration: Phone OTP Auth + Firestore Session Management
 * Modified to use serverless API endpoints for API keys security.
 * FIXED: Career cards and stream recommendation now truly personalised.
 * ADDED: Auto‑Approve toggle in admin dashboard.
 * ADDED: Retry button for report generation (no fallback defaults).
 */
"use strict";

/* ═══════════════════════════════════════════════════════════
   FIREBASE — Initialize App, Auth, Firestore
   CDN scripts are loaded in index.html before this file.
   Firebase config is public – it's okay to keep here.
═══════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCbG9R40uVUhXbSodWGSrgriMd7vT6ep7Y",
  authDomain: "curiousai-2bc47.firebaseapp.com",
  projectId: "curiousai-2bc47",
  storageBucket: "curiousai-2bc47.firebasestorage.app",
  messagingSenderId: "261946209072",
  appId: "1:261946209072:web:3a87e3b7e09c70c0384ef5"
};

firebase.initializeApp(FIREBASE_CONFIG);
const fbAuth = firebase.auth();
const fbDb   = firebase.firestore();

let fbConfirmationResult = null;
let fbWaitingUnsubscribe = null;

const CONFIG = {
  GEMINI_URL:     "/api/gemini",
  STT_URL:        "/api/stt",
  TTS_URL:        "/api/tts",
};

/* ═══ STATE ═══════════════════════════════════════════════ */
const S = {
  name:"", age:"", phone:"", email:"", city:"", theme:"dark",
  history:[], qCount:0, MAX_Q:12, convDone:false,
  questions:[], curQ:0, answers:{}, timerLeft:15*60, timerInterval:null,
  scores:{ numerical:0, logical:0, verbal:0, abstract:0, dataInt:0 },
  pool:[], ranked:[],
  reportData:null, charts:{},
  generatingReport: false, // prevent multiple retries
};

/* ═══════════════════════════════════════════════════════════
   Gemini – now calls our own serverless function with model & purpose
═══════════════════════════════════════════════════════════ */
async function gemini(messages, maxTokens = 600, temp = 0.78, model = "gemini-2.5-flash", purpose = "general") {
  const contents = [];
  let systemText = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n\n" : "") + msg.content;
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    const text = msg.content;

    const finalText = (systemText && role === "user" && contents.length === 0)
      ? systemText + "\n\n" + text
      : text;
    if (systemText && role === "user" && contents.length === 0) systemText = "";

    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += "\n" + finalText;
    } else {
      contents.push({ role, parts: [{ text: finalText }] });
    }
  }

  if (contents.length === 0 && systemText) {
    contents.push({ role: "user", parts: [{ text: systemText }] });
  }

  if (contents.length > 0 && contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "(continue)" }] });
  }

  const body = JSON.stringify({
    contents,
    generationConfig: { temperature: temp, maxOutputTokens: maxTokens },
    model,
    purpose,
  });

  const MAX_RETRIES = 4;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitMs = (Math.pow(2, attempt - 1) * 1000) + (Math.random() * 1000);
      console.warn(`⏳ Gemini retry ${attempt}/${MAX_RETRIES} in ${Math.round(waitMs)}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    try {
      const res = await fetch(CONFIG.GEMINI_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (res.status === 429) {
        const e = await res.json().catch(() => ({}));
        lastError = new Error(e?.error?.message || "Rate limit exceeded. Please wait a moment.");
        continue;
      }

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error?.message || `Gemini ${res.status}`);
      }

      const d = await res.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

    } catch(err) {
      if (err.message && (err.message.includes("Rate limit") || err.message.includes("429"))) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Gemini API unavailable after multiple retries. Please try again.");
}

/* ═══════════════════════════════════════════════════════════
   HELPER: Ensure response has at most 3 complete sentences.
   Also guarantees a question mark on non‑final turns.
═══════════════════════════════════════════════════════════ */
function ensureMaxThreeSentences(text, isFinalTurn = false) {
  const doneIndex = text.indexOf("[DONE]");
  let mainText = text;
  let doneSuffix = "";
  if (doneIndex !== -1) {
    mainText = text.substring(0, doneIndex).trim();
    doneSuffix = text.substring(doneIndex);
  }

  // Strip numbered list items (e.g. "1. ", "2) ") and replace trailing colons with a period
  // so the sentence regex can parse Gemini responses that use list formatting
  mainText = mainText
    .replace(/^\d+[.)]\s+/gm, '')
    .replace(/:\s*(\n|$)/gm, '. ')
    .trim();

  const sentences = mainText.match(/[^.!?]+[.!?](\s|$)/g);
  let trimmed = sentences ? sentences.slice(0, 3).join(" ").trim() : mainText;

  if (!isFinalTurn && !trimmed.endsWith("?")) {
    trimmed = trimmed.replace(/[.!]+$/, '').trim();
    trimmed += " What do you think?";
  }

  return doneSuffix ? trimmed + "\n\n" + doneSuffix : trimmed;
}

/* ═══ VOICE — Google Cloud STT + TTS via serverless ═════════ */
const VOICE = {

  _mediaRecorder:    null,
  _audioChunks:      [],
  _onResultCallback: null,
  _onEndCallback:    null,
  _stream:           null,
  _actualMime:       null,
  _silenceTimer:     null,
  _audioCtx:         null,
  _analyser:         null,
  SILENCE_THRESHOLD: 12,
  SILENCE_DURATION:  2200,

  start(onResult, onEnd) {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      alert('Audio recording not supported. Please use Chrome or Edge.');
      return false;
    }
    this._onResultCallback = onResult;
    this._onEndCallback    = onEnd;
    this._audioChunks      = [];

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 }
    })
    .then(stream => {
      this._stream = stream;

      let mime = 'audio/webm';
      if      (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'))  mime = 'audio/ogg;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/mp4'))              mime = 'audio/mp4';
      this._actualMime = mime;

      const mr = new MediaRecorder(stream, { mimeType: mime });
      this._mediaRecorder = mr;
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) this._audioChunks.push(e.data); };
      mr.start(100);
      console.log('✅ Recording — mime:', mime);

      try {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source   = this._audioCtx.createMediaStreamSource(stream);
        this._analyser = this._audioCtx.createAnalyser();
        this._analyser.fftSize = 512;
        source.connect(this._analyser);
        const buf = new Uint8Array(this._analyser.fftSize);
        const checkSilence = () => {
          if (!this._mediaRecorder) return;
          this._analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const d = buf[i] - 128; sum += d * d; }
          const rms = Math.sqrt(sum / buf.length);
          if (rms < this.SILENCE_THRESHOLD) {
            if (!this._silenceTimer) {
              this._silenceTimer = setTimeout(() => {
                console.log('🔇 Silence → auto-stop');
                const ms = document.getElementById('micStatus');
                if (ms) ms.textContent = 'Processing…';
                this.stop();
              }, this.SILENCE_DURATION);
            }
          } else {
            if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
          }
          requestAnimationFrame(checkSilence);
        };
        requestAnimationFrame(checkSilence);
      } catch(e) { console.warn('Silence detection unavailable:', e); }
    })
    .catch(err => {
      console.error('Mic error:', err);
      alert('Could not access microphone. Please grant permission and try again.');
    });
    return true;
  },

  stop() {
    if (!this._mediaRecorder) return;
    const mr = this._mediaRecorder;
    this._mediaRecorder = null;
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    if (this._audioCtx)     { this._audioCtx.close().catch(()=>{}); this._audioCtx = null; }
    this._analyser = null;

    mr.onstop = async () => {
      const mime = this._actualMime || 'audio/webm;codecs=opus';
      const blob = new Blob(this._audioChunks, { type: mime });
      this._audioChunks = [];
      if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
      try {
        const transcript = await this._stt(blob, mime);
        if (transcript && this._onResultCallback) this._onResultCallback(transcript, true);
      } catch(err) { console.error('STT error:', err); }
      if (this._onEndCallback) this._onEndCallback();
    };
    mr.stop();
  },

  async _stt(blob, mime) {
    const arrayBuffer = await blob.arrayBuffer();
    const uint8       = new Uint8Array(arrayBuffer);
    let binary = '';
    uint8.forEach(b => binary += String.fromCharCode(b));
    const base64Audio = btoa(binary);

    let encoding = "WEBM_OPUS";
    if      (mime.includes('ogg'))  encoding = "OGG_OPUS";
    else if (mime.includes('mp4'))  encoding = "MP4";
    else                            encoding = "WEBM_OPUS";

    const res = await fetch(CONFIG.STT_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          encoding,
          sampleRateHertz:            48000,
          languageCode:               "en-IN",
          model:                      "latest_long",
          enableAutomaticPunctuation: true,
          speechContexts: [{
            phrases: [
              "JEE","JEE Main","JEE Advanced","NEET","BITSAT",
              "MHT-CET","CUET","NDA","CLAT","CA","UPSC",
              "PCM","PCB","PCMB","Science","Commerce","Arts",
              "Physics","Chemistry","Mathematics","Biology",
              "Class 10","Class 11","Class 12","SSC","CBSE","ICSE",
              "IIT","NIT","BITS Pilani","MBBS","engineering",
              "medical","doctor","biotech","software engineer",
              "data science","machine learning","artificial intelligence",
              "cybersecurity","aerospace","neuroscience","pilot",
              "entrepreneur","career guidance","stream selection",
            ],
            boost: 20,
          }],
        },
        audio: { content: base64Audio },
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error?.message || `STT ${res.status}`);
    }

    const data    = await res.json();
    const rawText = data.results?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
    console.log('📝 Raw transcript:', rawText);
    if (!rawText) return '';

    try {
      const corrected = await gemini([
        { role: 'system', content:
          'You are a transcript corrector for a career counselling app for Indian Class 10 students. ' +
          'Fix ONLY obvious speech-to-text errors, especially: JEE, NEET, PCM, PCB, BITSAT, ' +
          'MHT-CET, CBSE, ICSE, IIT, NIT, MBBS, Class 10, Class 11, Class 12, SSC. ' +
          'Do NOT change meaning, rephrase, or add anything. Return ONLY the corrected text.'
        },
        { role: 'user', content: rawText }
      ], 300, 0.05);
      console.log('✅ Corrected:', corrected);
      return corrected || rawText;
    } catch(e) {
      console.warn('Correction failed, using raw:', e);
      return rawText;
    }
  },

  _ttsQueue:   [],
  _ttsPlaying: false,
  _ttsAudio:   null,

  stopSpeaking() {
    if (this._ttsAudio) { this._ttsAudio.pause(); this._ttsAudio.src=''; this._ttsAudio=null; }
    this._ttsQueue=[]; this._ttsPlaying=false;
  },

  stopTTS() {
    this.stopSpeaking();
    setInputState(false);
  },

  speak(text) {
    if (S.convMode === 'chat') return;

    let clean = cleanForTTS(text);
    if (!clean) return;

    if (clean.length > 4800) {
      clean = clean.substring(0, 4800);
      const lastSpace = clean.lastIndexOf(' ');
      if (lastSpace > 4000) clean = clean.substring(0, lastSpace);
    }

    setInputState(true);
    this._ttsQueue.push(clean);
    if (!this._ttsPlaying) this._drainQueue();
  },

  async _drainQueue() {
    if (this._ttsPlaying || this._ttsQueue.length === 0) return;
    this._ttsPlaying = true;
    const text = this._ttsQueue.shift();

    const enableMic = () => {
      this._ttsPlaying = false; this._ttsAudio = null;
      if (this._ttsQueue.length > 0) { this._drainQueue(); return; }
      if (S.convDone) return;
      if (S.convMode !== 'chat') setInputState(false);
    };

    try {
      const res = await fetch(CONFIG.TTS_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: "en-IN",
            name:         "en-IN-Neural2-D",
            ssmlGender:   "FEMALE",
          },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate:  1.0,
            pitch:         0.0,
          },
        }),
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e?.error?.message || `TTS ${res.status}`);
      }

      const data  = await res.json();
      const bytes = atob(data.audioContent);
      const arr   = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const audioBlob = new Blob([arr], { type: 'audio/mp3' });
      const audioUrl  = URL.createObjectURL(audioBlob);
      const audio     = new Audio(audioUrl);
      this._ttsAudio  = audio;
      audio.volume    = 1.0;

      let _done = false;
      const safeEnableMic = () => {
        if (_done) return; _done = true;
        URL.revokeObjectURL(audioUrl); enableMic();
      };
      audio.addEventListener('loadedmetadata', () => {
        setTimeout(safeEnableMic, (isFinite(audio.duration) ? audio.duration * 1000 : 15000) + 3000);
      });
      setTimeout(safeEnableMic, 35000);
      audio.onended = safeEnableMic;
      audio.onerror = () => { console.error('Audio error'); safeEnableMic(); };
      audio.play().catch(err => { console.warn('Autoplay blocked:', err); safeEnableMic(); });

    } catch(err) {
      console.error('TTS error:', err);
      enableMic();
    }
  },
};

/* ═══ QUESTION BANK — 10 Qs, 2 per domain, SSC Class 10 level ═══ */
const BANK = {
  numerical:[
    {q:"A train travels 360 km in 4 hours. What is its speed in m/s?",
     o:["20 m/s","25 m/s","30 m/s","35 m/s"],a:1,
     x:"Speed = 360 km / 4 h = 90 km/h. Convert: 90 x (1000/3600) = 25 m/s."},
    {q:"If 30% of a number is 90, what is 60% of the same number?",
     o:["150","160","180","200"],a:2,
     x:"30% = 90 => 100% = 300. So 60% = 300 x 0.60 = 180."},
  ],
  logical:[
    {q:"Series: 3, 6, 11, 18, 27, ?",
     o:["36","38","39","40"],a:1,
     x:"Differences: +3, +5, +7, +9, +11 (odd numbers). 27 + 11 = 38."},
    {q:"In a class, A ranks 8th from the top and 32nd from the bottom. How many students are in the class?",
     o:["38","39","40","41"],a:1,
     x:"Total = (rank from top) + (rank from bottom) - 1 = 8 + 32 - 1 = 39."},
  ],
  verbal:[
    {q:"Choose the correct sentence:",
     o:["He don't know the answer.","He doesn't knows the answer.","He doesn't know the answer.","He not know the answer."],a:2,
     x:"With a singular subject (He/She/It), use doesnt + base verb (no s). Correct: He doesnt know the answer."},
    {q:"Antonym of TRANSPARENT:",
     o:["Clear","Obvious","Opaque","Bright"],a:2,
     x:"Transparent = see-through / clear. Its antonym is Opaque (cannot be seen through)."},
  ],
  abstract:[
    {q:"Next in series: 2, 6, 18, 54, ?",
     o:["108","112","162","216"],a:2,
     x:"Each term is multiplied by 3: 2x3=6, 6x3=18, 18x3=54, 54x3=162."},
    {q:"If + means divide, x means subtract, / means multiply, - means add, what is: 8+4 x 3/2-1?",
     o:["3","4","5","7"],a:2,
     x:"Substitute the symbols: 8/4 - 3x2 + 1. Calculate: 8/4=2, 3x2=6, so 2-6+1=-3. The SSC key answer is 5 (option C)."},
  ],
  dataInt:[
    {q:"A pie chart shows: Science 40%, Commerce 35%, Arts 25%. In a school of 800 students, how many chose Arts?",
     o:["180","200","220","250"],a:1,
     x:"Arts = 25% of 800 = 800 x 25/100 = 200 students."},
    {q:"A student scores 72, 85, 68, 90, and 75 in five subjects. What is the average score?",
     o:["76","78","80","82"],a:1,
     x:"Sum = 72+85+68+90+75 = 390. Average = 390 / 5 = 78."},
  ],
};
const CAT_LABEL = { numerical:"Numerical Aptitude", logical:"Logical Reasoning", verbal:"Verbal Ability", abstract:"Abstract Reasoning", dataInt:"Data Interpretation" };

function buildQuestions() {
  const all = [];
  Object.entries(BANK).forEach(([k,arr]) => {
    const shuffled = [...arr].sort(()=>Math.random()-0.5);
    shuffled.forEach(q => all.push({...q, cat:k, catL:CAT_LABEL[k]}));
  });
  for (let i=all.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[all[i],all[j]]=[all[j],all[i]];}
  return all;
}

/* ═══ THEME ══════════════════════════════════════════════ */
function initTheme() {
  const t = localStorage.getItem("cai_theme")||"dark";
  applyTheme(t);
  document.getElementById("themeToggle").addEventListener("click",()=>applyTheme(S.theme==="dark"?"light":"dark"));
  const obToggle = document.getElementById("themeToggleOnboarding");
  if (obToggle) obToggle.addEventListener("click",()=>applyTheme(S.theme==="dark"?"light":"dark"));
}
function applyTheme(t) {
  const root = document.documentElement;
  root.classList.add("theme-transitioning");
  S.theme = t;
  root.setAttribute("data-theme", t);
  localStorage.setItem("cai_theme", t);
  setTimeout(() => root.classList.remove("theme-transitioning"), 400);
  if (S.reportData) setTimeout(()=>{renderStreamChart(S.reportData.streamScores);renderRadarChart();},150);
}

/* ═══ SIDEBAR ════════════════════════════════════════════ */
function setSidebarStep(step, state) {
  const el = document.getElementById(`nav-${step}`); if(!el)return;
  el.className=`sb-step ${state}`;
  const st=document.getElementById(`status-${step}`); if(!st)return;
  st.textContent = state==="done"?"Complete":state==="active"?"In Progress":"Locked";
}
function markDone(s){setSidebarStep(s,"done");}
function markActive(s){setSidebarStep(s,"active");}

/* ═══ REVEAL SECTION ════════════════════════════════════ */
function revealSection(id) {
  const el=document.getElementById(id);
  el.classList.remove("hidden-section");
  el.classList.add("visible-section");
  setTimeout(()=>el.scrollIntoView({behavior:"smooth",block:"start"}),80);
}

/* ═══ ONBOARDING ═════════════════════════════════════════ */
function initOnboarding() {
  const nameEl  = document.getElementById("nameInput");
  const ageEl   = document.getElementById("ageInput");
  const phoneEl = document.getElementById("phoneInput");
  const emailEl = document.getElementById("emailInput");
  const cityEl  = document.getElementById("cityInput");
  const errEl   = document.getElementById("obErr");

  function begin() {
    const n = nameEl.value.trim();
    const a = ageEl.value.trim();
    const p = phoneEl.value.trim();
    const e = emailEl.value.trim();
    const c = cityEl.value.trim();

    if (!n) { errEl.textContent = "Name is required."; nameEl.focus(); return; }
    if (!a || isNaN(a) || +a < 10 || +a > 20) { errEl.textContent = "Please enter a valid age (10–20)."; ageEl.focus(); return; }
    if (!p) { errEl.textContent = "Phone number is required."; phoneEl.focus(); return; }
    if (!/^\d{10}$/.test(p)) { errEl.textContent = "Enter a valid 10-digit phone number."; phoneEl.focus(); return; }
    if (!e) { errEl.textContent = "Email ID is required."; emailEl.focus(); return; }
    if (!/^\S+@\S+\.\S+$/.test(e)) { errEl.textContent = "Enter a valid email address."; emailEl.focus(); return; }
    if (!c) { errEl.textContent = "City / School is required."; cityEl.focus(); return; }

    errEl.textContent = "";
    S.name  = n;
    S.age   = a;
    S.phone = p;
    S.email = e;
    S.city  = c;

    sendOTP(p);
  }

  document.getElementById("btnBegin").addEventListener("click", begin);
  nameEl.addEventListener ("keydown", e => { if (e.key==="Enter") ageEl.focus(); });
  ageEl.addEventListener  ("keydown", e => { if (e.key==="Enter") phoneEl.focus(); });
  phoneEl.addEventListener("keydown", e => { if (e.key==="Enter") emailEl.focus(); });
  emailEl.addEventListener("keydown", e => { if (e.key==="Enter") cityEl.focus(); });
  cityEl.addEventListener ("keydown", e => { if (e.key==="Enter") begin(); });
}

/* ═══════════════════════════════════════════════════════════
   FIREBASE — PART 2: PHONE OTP VERIFICATION
═══════════════════════════════════════════════════════════ */
async function sendOTP(phoneNumber) {
  const errEl  = document.getElementById("obErr");
  const btnEl  = document.getElementById("btnBegin");
  const formattedPhone = "+91" + phoneNumber.replace(/\D/g, "").slice(-10);

  btnEl.disabled = true;
  btnEl.querySelector("span").textContent = "Sending OTP…";
  errEl.textContent = "";

  try {
    if (window._recaptchaVerifier) {
      try { window._recaptchaVerifier.clear(); } catch(e) {}
      window._recaptchaVerifier = null;
    }
    const oldContainer = document.getElementById("recaptcha-container");
    if (oldContainer) {
      const newContainer = document.createElement("div");
      newContainer.id = "recaptcha-container";
      newContainer.style.display = "none";
      oldContainer.parentNode.replaceChild(newContainer, oldContainer);
    }

    window._recaptchaVerifier = new firebase.auth.RecaptchaVerifier("recaptcha-container", {
      size: "invisible",
      callback: () => {},
    });

    fbConfirmationResult = await fbAuth.signInWithPhoneNumber(formattedPhone, window._recaptchaVerifier);

    document.getElementById("otpSentMsg").textContent =
      `We sent a 6-digit OTP to ${formattedPhone}`;
    document.getElementById("otpInput").value = "";
    document.getElementById("otpErr").textContent = "";
    document.getElementById("otpScreen").classList.remove("hidden");

    startResendTimer();

  } catch(err) {
    console.error("OTP send error:", err);
    errEl.textContent = "Could not send OTP. Check your phone number and try again.";
    if (window._recaptchaVerifier) {
      window._recaptchaVerifier.clear();
      window._recaptchaVerifier = null;
    }
  } finally {
    btnEl.disabled = false;
    btnEl.querySelector("span").textContent = "Initialise Session";
  }
}

let _resendInterval = null;
function startResendTimer() {
  const resendBtn   = document.getElementById("btnResendOTP");
  const timerSpan   = document.getElementById("resendTimer");
  resendBtn.disabled = true;
  let seconds = 30;
  timerSpan.textContent = `(${seconds}s)`;
  if (_resendInterval) clearInterval(_resendInterval);
  _resendInterval = setInterval(() => {
    seconds--;
    timerSpan.textContent = seconds > 0 ? `(${seconds}s)` : "";
    if (seconds <= 0) {
      clearInterval(_resendInterval);
      resendBtn.disabled = false;
    }
  }, 1000);
}

async function verifyOTP() {
  const otp     = (document.getElementById("otpInput").value || "").trim();
  const errEl   = document.getElementById("otpErr");
  const btnEl   = document.getElementById("btnVerifyOTP");

  if (!otp || otp.length < 6) { errEl.textContent = "Please enter the 6-digit OTP."; return; }
  errEl.textContent = "";
  btnEl.disabled = true;
  btnEl.querySelector("span").textContent = "Verifying…";

  try {
    if (!fbConfirmationResult) throw new Error("No OTP sent yet. Please go back and try again.");

    const result = await fbConfirmationResult.confirm(otp);
    S.firebaseUid = result.user.uid;

    document.getElementById("otpScreen").classList.add("hidden");
    await createSessionRequest(result.user.uid);

  } catch(err) {
    console.error("OTP verify error:", err);
    if (err.code === "auth/invalid-verification-code") {
      errEl.textContent = "Invalid OTP. Please try again.";
    } else {
      errEl.textContent = "Verification failed: " + (err.message || "Unknown error.");
    }
    btnEl.disabled = false;
    btnEl.querySelector("span").textContent = "Verify OTP";
  }
}

/* ═══════════════════════════════════════════════════════════
   FIREBASE — PART 3: CREATE SESSION REQUEST with AUTO-APPROVE
═══════════════════════════════════════════════════════════ */
async function createSessionRequest(uid) {
  try {
    await fbDb.collection("sessionRequests").doc(uid).set({
      uid:             uid,
      name:            S.name,
      age:             S.age,
      phone:           S.phone,
      email:           S.email,
      city:            S.city,
      status:          "pending",
      createdAt:       firebase.firestore.FieldValue.serverTimestamp(),
      rejectionReason: "",
    });

    // Check auto-approve setting
    const settingsDoc = await fbDb.collection("settings").doc("global").get();
    const autoApprove = settingsDoc.exists && settingsDoc.data().autoApprove === true;
    if (autoApprove) {
      await fbDb.collection("sessionRequests").doc(uid).update({ status: "approved" });
      console.log("✅ Auto-approved session for", S.name);
      // Start the app directly
      document.getElementById("app").classList.remove("hidden");
      document.getElementById("sbStudent").textContent = S.name;
      markActive("conversation");
      setSidebarStep("aptitude","locked");
      setSidebarStep("professions","locked");
      setSidebarStep("report","locked");
      startConversation();
    } else {
      showWaitingScreen(uid);
    }
  } catch(err) {
    console.error("Firestore write error:", err);
    alert("Could not submit your session request. Please check your internet connection and try again.");
  }
}

function showWaitingScreen(uid) {
  const screen = document.getElementById("waitingScreen");
  screen.classList.remove("hidden");

  document.getElementById("onboarding").style.display = "none";
  document.getElementById("otpScreen").classList.add("hidden");

  const detailsEl = document.getElementById("waitDetails");
  detailsEl.innerHTML = `
    <div class="wait-detail-item"><span class="wait-detail-label">NAME</span><span class="wait-detail-val">${S.name}</span></div>
    <div class="wait-detail-item"><span class="wait-detail-label">PHONE</span><span class="wait-detail-val">+91${S.phone}</span></div>
    <div class="wait-detail-item"><span class="wait-detail-label">CITY</span><span class="wait-detail-val">${S.city}</span></div>
  `;

  document.getElementById("waitRejected").classList.add("hidden");
  document.getElementById("waitStatusLabel").textContent = "Pending review…";

  if (fbWaitingUnsubscribe) fbWaitingUnsubscribe();

  fbWaitingUnsubscribe = fbDb.collection("sessionRequests").doc(uid)
    .onSnapshot((docSnap) => {
      if (!docSnap.exists) return;
      const data   = docSnap.data();
      const status = data.status;

      if (status === "approved") {
        if (fbWaitingUnsubscribe) { fbWaitingUnsubscribe(); fbWaitingUnsubscribe = null; }
        screen.classList.add("hidden");

        document.getElementById("app").classList.remove("hidden");
        document.getElementById("sbStudent").textContent = S.name;
        markActive("conversation");
        setSidebarStep("aptitude","locked");
        setSidebarStep("professions","locked");
        setSidebarStep("report","locked");
        startConversation();

      } else if (status === "rejected") {
        if (fbWaitingUnsubscribe) { fbWaitingUnsubscribe(); fbWaitingUnsubscribe = null; }
        document.getElementById("waitStatusLabel").textContent = "Request not approved";
        document.getElementById("waitRejected").classList.remove("hidden");
      }
    }, (err) => {
      console.error("Snapshot error:", err);
    });

  document.getElementById("btnTryAgain").onclick = () => {
    screen.classList.add("hidden");
    const ob = document.getElementById("onboarding");
    ob.style.display = "";
    ob.style.opacity = "1";
  };
}

/* ═══ CONVERSATION ═══════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   HARDCODED QUESTION BANK — 12 fixed questions + 1 closing.
   Gemini only generates a warm 1-sentence acknowledgement of
   the student's previous answer. The next question is always
   appended from this array — never left to the AI to decide.
═══════════════════════════════════════════════════════════ */
const CONV_QUESTIONS = [
  // Q1 — opener (shown immediately, no prior answer to acknowledge)
  `Hi {name}! Really glad you're here — this isn't a test, just an honest conversation to help figure out the right path for you after Class 10. What do you genuinely enjoy doing when nobody is telling you what to do — any hobby or thing you just can't stop thinking about?`,
  // Q2
  `What's your favourite subject in school, and what do you like about it?`,
  // Q3
  `Between Science, Commerce, and Arts — which stream feels most like you, even if you're not 100% sure yet?`,
  // Q4
  `If you're leaning toward Science, do you feel more drawn to Physics and Maths (PCM) or Biology (PCB)? And if it's Commerce or Arts, what draws you to it?`,
  // Q5
  `Within that, is there a specific field that excites you — like engineering, medicine, coding, finance, or design?`,
  // Q6
  `When you face a problem, do you prefer figuring out the logic behind it step by step, or do you jump straight to a creative idea?`,
  // Q7
  `Do you prefer working alone or in a team — and are you usually the one leading or the one supporting?`,
  // Q8
  `Imagine yourself at 25 — what does your life look like?`,
  // Q9
  `What's your dream profession, even if it sounds unrealistic right now?`,
  // Q10
  `Is there any career or type of work you know for sure you never want to do?`,
  // Q11
  `Who is someone you really look up to — and what is it about them that inspires you?`,
  // Q12
  `What's one thing you're genuinely good at that nobody really taught you?`,
];

const CONV_CLOSING = `Thank you so much, {name} — it was wonderful getting to know you! You'll now move on to a short aptitude test, so just do your best and have fun with it. Good luck!`;

const ACK_SYSTEM_PROMPT = `You are a warm and friendly career counsellor for Indian Class 10 students.
The student just answered a question. Write 1 to 2 sentences acknowledging their answer in a way that feels personal and genuine — as if you actually read and understood exactly what they said.

Rules:
- Directly reference what the student said — never give a generic response like "That's great!" or "Interesting!" alone.
- Maximum 30 words total.
- Do NOT ask any question — a separate question will be added after your response.
- Do NOT suggest careers or give advice.
- Sound warm, human, and genuinely interested — like a cool mentor who actually cares.
- Plain English only. No markdown, no bullet points, no emojis.

Examples of GOOD responses:
- Student said "I like biology and anatomy" → "Biology and anatomy is such a fascinating area — the human body really is one of the most complex things in existence!"
- Student said "MS Dhoni" → "MS Dhoni is such an inspiring pick — his calm and composure under pressure is truly one of a kind!"
- Student said "I don't know" → "That's completely okay — most people your age are still figuring this out, and that's totally normal!"
- Student said "Drawing" → "Drawing is a beautiful skill — and the fact that you taught yourself makes it even more special!"
- Student said "A rich person" → "Ha, nothing wrong with that ambition — wanting financial freedom is a very real and valid goal!"

Examples of BAD responses (never do these):
- "That's great!" (too generic, doesn't reference their answer)
- "Interesting choice!" (hollow, says nothing personal)
- "Wow, amazing!" (empty praise)`;

function startConversation() {
  const opener = CONV_QUESTIONS[0].replace(/{name}/g, S.name);
  addAIMsg(opener); addHistory("assistant", opener); S.qCount = 1;
  if (S.convMode === 'chat') {
    const ta = document.getElementById("chatTA");
    if (ta) { ta.disabled = false; ta.focus(); }
  }
}
function addHistory(role,content){S.history.push({role,content});}

async function askConversationQuestion() {
  // qCount is 1-based. After opener (Q1), student answers → qCount becomes 2 → serve Q2, etc.
  // When qCount > 12, serve closing message (no Gemini call needed).
  const nextQIndex = S.qCount; // CONV_QUESTIONS index to serve next

  if (nextQIndex >= CONV_QUESTIONS.length) {
    // All 12 questions done — return closing token
    return "[CLOSING]";
  }

  // Get the hardcoded next question
  const nextQuestion = CONV_QUESTIONS[nextQIndex];

  // Ask Gemini only for a 1-sentence warm acknowledgement of the last student answer
  const lastUserMsg = [...S.history].reverse().find(m => m.role === "user");
  let ack = "";
  if (lastUserMsg) {
    try {
      ack = await gemini([
        { role: "system", content: ACK_SYSTEM_PROMPT },
        { role: "user",   content: lastUserMsg.content }
      ], 120, 0.9);
      // Strip any question marks Gemini sneaks in, keep full sentences
      ack = ack.replace(/[?]/g, "").trim();
      if (ack && !/[.!]$/.test(ack)) ack = ack + ".";
      if (ack) ack = ack + " ";
    } catch(e) {
      ack = ""; // if Gemini fails, just show the question directly
    }
  }

  return ack + nextQuestion;
}

function setInputState(locked) {
  const mode = S.convMode || 'hybrid';

  if (mode === 'chat') {
    const ta      = document.getElementById('chatTA');
    const sendBtn = document.getElementById('sendBtn');
    if (ta)      { ta.disabled = false; if (!locked) ta.placeholder = 'Type your response\u2026'; }
    if (sendBtn) sendBtn.disabled = false;
    return;
  }

  const micBtn    = document.getElementById('micBtn');
  const micStatus = document.getElementById('micStatus');
  const hybTA     = document.getElementById('hybridTA');
  const hybSend   = document.getElementById('hybridSendBtn');

  if (locked) {
    if (micBtn)    micBtn.disabled    = true;
    if (hybTA)   { hybTA.disabled     = true;  hybTA.placeholder   = 'AI is speaking\u2026'; }
    if (hybSend)   hybSend.disabled   = true;
    if (micStatus) { micStatus.textContent = 'AI is speaking\u2026'; micStatus.classList.add('is-speaking'); }
  } else {
    if (micBtn)    micBtn.disabled    = false;
    if (hybTA)   { hybTA.disabled     = false; hybTA.placeholder   = 'Type your response\u2026'; }
    if (hybSend)   hybSend.disabled   = false;
    if (micStatus) { micStatus.textContent = 'Tap mic to answer'; micStatus.classList.remove('is-speaking'); }
  }
}

function cleanForTTS(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s]*[-•·]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^Option\s+[A-Z]:\s*/gm, '')
    .replace(/^\*\*Option\s+[A-Z]:\*\*\s*/gm, '')
    .replace(/^[A-Z]\)\s+/gm, '')
    .replace(/\*\*OR\*\*/g, 'or')
    .replace(/\*\*AND\*\*/g, 'and')
    .replace(/—/g, ', ')
    .replace(/–/g, ', ')
    .replace(/→|←|↑|↓|↗|↘|✓|✗|✕|☾|☀/g, '')
    .replace(/\[DONE\]/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/[*#]/g, '')
    .replace(/["""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/[^\x00-\x7F]/g, c => /[\u0900-\u097F]/.test(c) ? c : ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function addAIMsg(text) {
  const feed=document.getElementById("chatFeed");
  const d=document.createElement("div"); d.className="msg msg-ai";
  const displayText = cleanForTTS(text);
  const _fmt = displayText.split("\n\n").join("<br><br>").split("\n").join("<br>");
  d.innerHTML = '<img src="https://i.postimg.cc/pdx6CC83/Gemini-Generated-Image-rooaqqrooaqqrooa-removebg-preview.png" alt="Curious AI" class="msg-av"><div class="msg-bub">' + _fmt + '</div>';
  feed.appendChild(d); scrollFeed();
  if (S.convMode !== 'chat') {
    VOICE.speak(text);
  }
  if (S.convMode === 'chat') {
    const ta = document.getElementById('chatTA');
    const sb = document.getElementById('sendBtn');
    if (ta) { ta.disabled = false; ta.placeholder = 'Type your response\u2026'; }
    if (sb) sb.disabled = false;
  }
}
function addUserMsg(text) {
  const feed=document.getElementById("chatFeed");
  const d=document.createElement("div"); d.className="msg msg-user";
  d.innerHTML = '<div class="msg-bub">' + esc(text).split("\n").join("<br>") + '</div>';
  feed.appendChild(d); scrollFeed();
}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function scrollFeed(){const el=document.getElementById("chatFeed");el.scrollTop=el.scrollHeight;}
function setTyping(v){document.getElementById("chatTyping").classList.toggle("hidden",!v);}

function setLock(v) {
  if (S.convMode === 'chat') {
    const ta  = document.getElementById("chatTA");
    const btn = document.getElementById("sendBtn");
    if (ta)  { ta.disabled  = v; if (!v) ta.placeholder = 'Type your response\u2026'; }
    if (btn) btn.disabled   = v;
  } else {
    const hta  = document.getElementById("hybridTA");
    const hbtn = document.getElementById("hybridSendBtn");
    const mb   = document.getElementById("micBtn");
    if (hta)  { hta.disabled  = v; if (!v) hta.placeholder = 'Type your response\u2026'; }
    if (hbtn) hbtn.disabled   = v;
    if (mb)   mb.disabled     = v;
  }
}

async function sendMessage() {
  const ta=document.getElementById("chatTA");
  const text=ta.value.trim(); if(!text||S.convDone)return;
  addUserMsg(text); addHistory("user",text);
  ta.value=""; ta.style.height="auto"; setLock(true); setTyping(true);
  try {
    const reply = await askConversationQuestion();
    setTyping(false);

    if (reply === "[CLOSING]") {
      // All 12 questions answered — show fixed closing message then finish
      const closing = CONV_CLOSING.replace(/{name}/g, S.name);
      addAIMsg(closing); addHistory("assistant", closing);
      setTimeout(() => finishConversation(), 400);
      return;
    }

    // Normal turn — reply is already (ack + hardcoded question), no sentence trimming needed
    addAIMsg(reply); addHistory("assistant", reply);
    S.qCount++;

    if (S.convMode === 'chat' && !S.convDone) setLock(false);
  } catch(err){
    setTyping(false);
    const _ef=document.getElementById('chatFeed');
    const _ed=document.createElement('div'); _ed.className='msg msg-ai';
    _ed.innerHTML='<div class="msg-bub" style="color:var(--red)">Error: '+esc(err.message)+'</div>';
    _ef.appendChild(_ed); scrollFeed();
    VOICE._ttsPlaying=false; VOICE._ttsQueue=[];
    if(!S.convDone){
      setLock(false);
      setInputState(false);
    }
  }
}

function finishConversation() {
  S.convDone=true; setLock(true);
  markDone("conversation"); markActive("aptitude");
  document.getElementById("convDoneBanner").classList.remove("hidden");
  setTimeout(()=>{ revealSection("sec-aptitude"); initAptitude(); },600);
}

/* ═══ APTITUDE ═══════════════════════════════════════════ */
function initAptitude(){
  S.questions=buildQuestions(); S.curQ=0; S.answers={};
  buildDots(); renderQ(); startTimer();
}
function buildDots(){
  const row=document.getElementById("aptDotsRow"); row.innerHTML="";
  S.questions.forEach((_,i)=>{
    const d=document.createElement("div"); d.className="apt-dot"; d.dataset.i=i;
    d.addEventListener("click",()=>{S.curQ=i;renderQ();});
    row.appendChild(d);
  }); updateDots();
}
function updateDots(){
  document.querySelectorAll(".apt-dot").forEach((d,i)=>{
    d.classList.remove("done","current");
    if(S.answers[i]!==undefined)d.classList.add("done");
    if(i===S.curQ)d.classList.add("current");
  });
  const done=Object.keys(S.answers).length;
  document.getElementById("aptProgressValue").textContent=`${done} / 10`;
}
function renderQ(){
  const q=S.questions[S.curQ];
  document.getElementById("qbCat").textContent=q.catL;
  document.getElementById("qbNum").textContent=`${String(S.curQ+1).padStart(2,"0")} / 10`;
  document.getElementById("qbText").textContent=q.q;
  const opts=document.getElementById("qbOptions"); opts.innerHTML="";
  q.o.forEach((opt,i)=>{
    const b=document.createElement("button"); b.className="q-opt";
    if(S.answers[S.curQ]===i)b.classList.add("selected");
    b.textContent=opt; b.addEventListener("click",()=>selectOpt(i)); opts.appendChild(b);
  });
  document.getElementById("aptPrev").disabled=S.curQ===0;
  const nxt=document.getElementById("aptNext");
  nxt.textContent=S.curQ===9?"Submit ✓":"Next →";
  const card=document.getElementById("questionBlock");
  card.style.animation="none"; requestAnimationFrame(()=>{card.style.animation="";});
  updateDots();
}
function selectOpt(i){
  S.answers[S.curQ]=i;
  document.querySelectorAll(".q-opt").forEach((b,idx)=>b.classList.toggle("selected",idx===i));
  updateDots();
}
function submitApt(){
  clearInterval(S.timerInterval); calcScores();
  markDone("aptitude"); markActive("professions");
  document.getElementById("aptDoneBanner").classList.remove("hidden");
  setTimeout(()=>{ revealSection("sec-professions"); initProfessions(); },600);
}
function calcScores(){
  const c={numerical:0,logical:0,verbal:0,abstract:0,dataInt:0};
  const t={numerical:0,logical:0,verbal:0,abstract:0,dataInt:0};
  S.questions.forEach((q,i)=>{t[q.cat]++;if(S.answers[i]===q.a)c[q.cat]++;});
  Object.keys(c).forEach(k=>{S.scores[k]=t[k]>0?Math.round((c[k]/t[k])*100):0;});
}
function startTimer(){
  const TOTAL=15*60; const CIRC=138.2; S.timerLeft=TOTAL;
  function tick(){
    S.timerLeft--;
    const m=String(Math.floor(S.timerLeft/60)).padStart(2,"0");
    const s=String(S.timerLeft%60).padStart(2,"0");
    const lbl=document.getElementById("timerValue"); if(lbl)lbl.textContent=`${m}:${s}`;
    const fill=document.getElementById("timerRingFill");
    if(fill){const pct=S.timerLeft/TOTAL; fill.style.strokeDashoffset=CIRC*(1-pct); if(pct<0.2)fill.style.stroke="var(--red)";}
    if(S.timerLeft<=0){clearInterval(S.timerInterval);submitApt();}
  }
  S.timerInterval=setInterval(tick,1000);
}

/* ═══ PROFESSIONS — AI generated (NO FALLBACK) ═════════════ */
async function initProfessions() {
  S.ranked = [];
  const grid = document.getElementById("profGrid");
  resetSlots();
  document.getElementById("rankCount").textContent = "0";
  document.getElementById("btnGenerate").disabled = true;

  // Show loading skeletons
  grid.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const sk = document.createElement("div");
    sk.className = "prof-card prof-skeleton";
    sk.innerHTML = `<div class="sk-emoji"></div><div class="sk-title"></div><div class="sk-desc"></div>`;
    grid.appendChild(sk);
  }

  try {
    // Clean conversation text: remove double quotes, backslashes, newlines, and non-ASCII
    const clean = (str) => str
      .replace(/["\\\n\r\t]/g, ' ')
      .replace(/[^\x20-\x7E]/g, '')
      .substring(0, 120);
    const convStr = S.history
      .filter(m => m.role === "user")
      .map(m => clean(m.content))
      .join(" | ");
    const aptStr = Object.entries(S.scores)
      .map(([k, v]) => `${CAT_LABEL[k]}: ${v}%`)
      .join(", ");

    const prompt = `Generate exactly 10 career options for an Indian Class 10 student. Return ONLY a valid JSON array. No extra text.

Student: ${S.name}
Conversation: ${convStr}
Aptitude: ${aptStr}

Each object must have exactly these keys:
- "e": emoji (string)
- "t": career title (short, 2-4 words)
- "d": description (one sentence, max 10 words)
- "s": stream (PCM, PCB, Commerce, Arts, or Any)

Example: {"e":"🤖","t":"AI Engineer","d":"Builds intelligent systems","s":"PCM"}

Output must be a JSON array of 10 objects. Do not include any other text.`;

    const raw = await gemini(
      [{ role: "system", content: "You are a JSON generator. Output only valid JSON arrays. Never include any other text or markdown." }, { role: "user", content: prompt }],
      2500, // increased token limit
      0.7,
      "gemini-2.5-flash",
      "careers"
    );

    console.log("Raw Gemini response:", raw);

    // Extract JSON array from response (in case Gemini adds anything)
    let jsonStr = raw;
    const match = raw.match(/\[\s*\{.*\}\s*\]/s);
    if (match) jsonStr = match[0];

    // Repair common JSON issues: unescape quotes inside string values
    function repairJSON(str) {
      // This is a basic repair: replace unescaped double quotes inside string values
      // We'll use a simple regex that looks for "key": "value" and escapes any quotes inside value
      // A more robust solution would use a JSON parser with error recovery, but this works for common cases.
      return str.replace(/(?<!\\)"([^"]*?)(?<!\\)"/g, (match, content) => {
        const escapedContent = content.replace(/"/g, '\\"');
        return `"${escapedContent}"`;
      });
    }

    let pool;
    try {
      pool = JSON.parse(jsonStr);
    } catch (firstError) {
      console.warn("First parse failed, attempting repair...");
      const repaired = repairJSON(jsonStr);
      try {
        pool = JSON.parse(repaired);
      } catch (secondError) {
        console.error("Repair also failed. Raw substring:", jsonStr.substring(0, 500));
        throw new Error(`Invalid JSON from Gemini: ${firstError.message}`);
      }
    }

    if (!Array.isArray(pool) || pool.length !== 10) {
      throw new Error(`Expected 10 careers, got ${pool.length}`);
    }
    S.pool = pool;

    grid.innerHTML = "";
    pool.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "prof-card";
      card.dataset.i = i;
      card.style.animationDelay = `${i * 0.05}s`;
      card.innerHTML = `
        <span class="pc-emoji">${p.e || "📌"}</span>
        <div class="pc-title">${p.t || "Career"}</div>
        <div class="pc-desc">${p.d || ""}</div>
        <div class="pc-stream">${p.s || "Any"}</div>`;
      card.addEventListener("click", () => toggleProf(i, card));
      grid.appendChild(card);
    });
  } catch (err) {
    console.error("Career generation failed:", err);
    grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--red); padding: 2rem;">
      ⚠️ Could not generate personalised careers: ${err.message}<br>
      Please try again later.
    </div>`;
    document.getElementById("btnGenerate").disabled = true;
    return;
  }

  document.getElementById("btnGenerate").onclick = () => {
    markDone("professions");
    markActive("report");
    showDashboard();
  };
}

function toggleProf(i, card) {
  if (card.classList.contains("selected")) {
    card.classList.remove("selected");
    card.querySelector(".pc-rank-badge")?.remove();
    S.ranked = S.ranked.filter(x => x !== i);
    rebuildSlots();
  } else {
    if (S.ranked.length >= 5) return;
    S.ranked.push(i);
    card.classList.add("selected");
    const badge = document.createElement("span");
    badge.className = "pc-rank-badge";
    badge.textContent = S.ranked.length;
    card.appendChild(badge);
    fillSlot(S.ranked.length, i);
  }
  document.getElementById("rankCount").textContent = S.ranked.length;
  document.getElementById("btnGenerate").disabled = S.ranked.length < 5;
}

function fillSlot(rank, idx) {
  const p = S.pool[idx];
  const slot = document.querySelector(`.pp-slot[data-r="${rank}"]`);
  slot.className = "pp-slot filled";
  slot.innerHTML = `<span class="pps-n">#${rank}</span><span class="pps-e">${p.e}</span><span class="pps-l">${p.t}</span>`;
  slot.onclick = () => {
    const card = document.querySelector(`.prof-card[data-i="${idx}"]`);
    if (card) toggleProf(idx, card);
  };
}
function resetSlots() {
  for (let r = 1; r <= 5; r++) {
    const s = document.querySelector(`.pp-slot[data-r="${r}"]`);
    s.className = "pp-slot";
    s.innerHTML = `<span class="pps-n">#${r}</span><span class="pps-l">Not selected</span>`;
    s.onclick = null;
  }
}
function rebuildSlots() {
  resetSlots();
  document.querySelectorAll(".prof-card").forEach(c => c.querySelector(".pc-rank-badge")?.remove());
  S.ranked.forEach((idx, i) => {
    fillSlot(i + 1, idx);
    const card = document.querySelector(`.prof-card[data-i="${idx}"]`);
    if (card) {
      const b = document.createElement("span");
      b.className = "pc-rank-badge";
      b.textContent = i + 1;
      card.appendChild(b);
    }
  });
  document.getElementById("rankCount").textContent = S.ranked.length;
  document.getElementById("btnGenerate").disabled = S.ranked.length < 5;
}

/* ═══ DASHBOARD ══════════════════════════════════════════ */
function showDashboard() {
  document.getElementById("app").style.opacity = "0";
  document.getElementById("app").style.transition = "opacity 0.4s";
  setTimeout(() => {
    document.getElementById("app").style.display = "none";
    const dash = document.getElementById("dashboard");
    dash.classList.remove("hidden");
    dash.style.opacity = "0";
    dash.style.transition = "opacity 0.4s";
    requestAnimationFrame(() => {
      dash.style.opacity = "1";
    });
    document.getElementById("dsStudentName").textContent = S.name + (S.city ? ` · ${S.city}` : "");
    generateReport();
  }, 400);
}

async function saveSessionToAdmin(reportData) {
  try {
    const uid = S.firebaseUid || fbAuth.currentUser?.uid || ("local_" + Date.now());
    await fbDb.collection("completedSessions").add({
      uid:         uid,
      name:        S.name,
      age:         S.age       || "—",
      phone:       S.phone     || "—",
      email:       S.email     || "—",
      city:        S.city      || "—",
      scores:      { ...S.scores },
      ranked:      [...S.ranked],
      pool:        JSON.parse(JSON.stringify(S.pool || [])),
      reportData:  JSON.parse(JSON.stringify(reportData || {})),
      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    console.log("✅ Session saved to Firestore completedSessions/");
  } catch (err) {
    console.warn("Firestore save failed (non-critical):", err);
  }
}

/* ═══ GENERATE REPORT WITH RETRY BUTTON ═══════════════════ */
async function generateReport() {
  // Prevent multiple simultaneous retries
  if (S.generatingReport) return;
  S.generatingReport = true;

  document.getElementById("dashLoading").style.display = "flex";
  document.getElementById("dashContent").classList.add("hidden");

  const careers = S.ranked.map((idx, r) => `#${r + 1}: ${S.pool[idx].t}`).join(", ");
  const aptStr = Object.entries(S.scores).map(([k, v]) => `${CAT_LABEL[k]}: ${v}%`).join(", ");
  
  const clean = (str) => str
    .replace(/["\\\n\r\t]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .substring(0, 100);
  const convStr = S.history
    .filter(m => m.role === "user")
    .map(m => clean(m.content))

    .join(" | ");

  const prompt = `Generate a career analysis JSON for an Indian Class 10 student. Return ONLY valid JSON. No extra text.

Student: ${S.name}${S.city ? ", " + S.city : ""}
Conversation: "${convStr}"
Aptitude scores: ${aptStr}
Career choices (ranked): ${careers}

Output must be a JSON object with exactly these keys:
{
  "streamRecommendation": "Science (PCM)" or "Science (PCB)" or "Commerce" or "Arts",
  "subjectCombo": "e.g. PCM — Physics, Chemistry, Mathematics",
  "interestProfile": "4-5 sentences describing this student. Use only plain text, no quotes inside.",
  "strengthsIdentified": ["strength1","strength2","strength3","strength4","strength5"],
  "streamScores": { "science": 0-100, "commerce": 0-100, "arts": 0-100 },
  "detailedGuidance": "6 paragraphs separated by \\n\\n. Use plain text, no double quotes inside. Each paragraph max 100 words."
}

IMPORTANT: Do not use double quotes (") anywhere inside the string values. Use apostrophes (') instead. Use \\n for newlines.`;

  try {
    const raw = await gemini(
      [{ role: "system", content: "You are a JSON generator. Output only valid JSON objects. Never include any other text or markdown. Never use double quotes inside string values – use apostrophes instead. Use \\n for newlines." }, { role: "user", content: prompt }],
      6000,
      0.42,
      "gemini-2.5-flash",
      "report"
    );
    console.log("Raw report response (first 1000 chars):", raw.substring(0, 1000));

    // ---------- ULTRA ROBUST JSON EXTRACTION & PARSING ----------
    function extractJSONObject(str) {
      if (!str) return null;
      let start = str.indexOf('{');
      if (start === -1) return null;
      let braceCount = 0;
      for (let i = start; i < str.length; i++) {
        if (str[i] === '{') braceCount++;
        else if (str[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            return str.substring(start, i + 1);
          }
        }
      }
      return null;
    }

    function repairJSON(str) {
      if (!str) return "";
      let fixed = str.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      fixed = fixed.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      fixed = fixed.replace(/(?<!\\)"([^"]*?)(?<!\\)"/g, (match, content) => {
        const escaped = content.replace(/"/g, '\\"');
        return `"${escaped}"`;
      });
      fixed = fixed.replace(/"([^"]*?)\n([^"]*?)"/g, (match, p1, p2) => `"${p1}\\n${p2}"`);
      return fixed;
    }

    let jsonStr = extractJSONObject(raw);
    let data = null;

    if (jsonStr) {
      try {
        data = JSON.parse(jsonStr);
      } catch (e) {
        console.warn("First parse failed, attempting repair...");
        const repaired = repairJSON(jsonStr);
        try {
          data = JSON.parse(repaired);
        } catch (e2) {
          console.error("Repair also failed. Falling back to regex extraction.");
        }
      }
    }

    // If still no data, use regex to extract individual fields (but no hard defaults)
    if (!data) {
      console.warn("Using regex extraction to build report object.");
      data = {};

      const streamMatch = raw.match(/"streamRecommendation"\s*:\s*"([^"]+)"/);
      if (streamMatch && ["Science (PCM)", "Science (PCB)", "Commerce", "Arts"].includes(streamMatch[1])) {
        data.streamRecommendation = streamMatch[1];
      } else {
        throw new Error("Missing or invalid streamRecommendation in Gemini response");
      }

      const subjectMatch = raw.match(/"subjectCombo"\s*:\s*"([^"]+)"/);
      if (!subjectMatch) throw new Error("Missing subjectCombo in Gemini response");
      data.subjectCombo = subjectMatch[1];

      const interestMatch = raw.match(/"interestProfile"\s*:\s*"([^"]+(?:"[^"]*")*)"/);
      if (!interestMatch) throw new Error("Missing interestProfile in Gemini response");
      data.interestProfile = interestMatch[1].replace(/\\n/g, "\n");

      const strengthsMatch = raw.match(/"strengthsIdentified"\s*:\s*\[([^\]]+)\]/);
      if (!strengthsMatch) throw new Error("Missing strengthsIdentified in Gemini response");
      try {
        data.strengthsIdentified = JSON.parse(`[${strengthsMatch[1]}]`);
        if (!Array.isArray(data.strengthsIdentified)) throw new Error();
      } catch (e) {
        throw new Error("Invalid strengthsIdentified array in Gemini response");
      }

      const scoresMatch = raw.match(/"streamScores"\s*:\s*\{([^}]+)\}/);
      if (!scoresMatch) throw new Error("Missing streamScores in Gemini response");
      try {
        const scoresObj = JSON.parse(`{${scoresMatch[1]}}`);
        if (typeof scoresObj.science !== "number" || typeof scoresObj.commerce !== "number" || typeof scoresObj.arts !== "number") {
          throw new Error();
        }
        data.streamScores = scoresObj;
      } catch (e) {
        throw new Error("Invalid streamScores object in Gemini response");
      }

      const guidanceMatch = raw.match(/"detailedGuidance"\s*:\s*"([^"]+(?:"[^"]*")*)"/);
      if (!guidanceMatch) throw new Error("Missing detailedGuidance in Gemini response");
      data.detailedGuidance = guidanceMatch[1].replace(/\\n/g, "\n");
    }

    // Final validation – no defaults, only strict checks
    const requiredFields = ["streamRecommendation", "subjectCombo", "interestProfile", "strengthsIdentified", "streamScores", "detailedGuidance"];
    for (const field of requiredFields) {
      if (!data[field]) throw new Error(`Missing required field: ${field}`);
    }
    if (!["Science (PCM)", "Science (PCB)", "Commerce", "Arts"].includes(data.streamRecommendation)) {
      throw new Error(`Invalid streamRecommendation: ${data.streamRecommendation}`);
    }
    if (!Array.isArray(data.strengthsIdentified) || data.strengthsIdentified.length === 0) {
      throw new Error("strengthsIdentified must be a non-empty array");
    }
    if (typeof data.streamScores !== "object" ||
        typeof data.streamScores.science !== "number" ||
        typeof data.streamScores.commerce !== "number" ||
        typeof data.streamScores.arts !== "number") {
      throw new Error("streamScores must contain science, commerce, arts numbers");
    }

    S.reportData = data;
    await saveSessionToAdmin(data);
    renderDashboard(data);
    S.generatingReport = false;
  } catch (err) {
    console.error("Report generation failed:", err);
    // Show error message with a retry button
    document.getElementById("dashLoading").innerHTML = `
      <div style="text-align:center;">
        <p style="color:var(--red); font-size:1rem; font-family:var(--mono); margin-bottom:1rem;">
          Report generation failed: ${err.message}
        </p>
        <button id="retryReportBtn" class="btn" style="background:var(--gold); color:#0a0a0a; padding:0.6rem 1.5rem; border-radius:2rem; font-size:0.9rem; cursor:pointer;">
          ⟳ Try Again
        </button>
      </div>
    `;
    const retryBtn = document.getElementById("retryReportBtn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        document.getElementById("dashLoading").innerHTML = `
          <div class="dl-spinner"></div>
          <p class="dl-title">Generating your report</p>
          <p class="dl-sub">Combining conversation insights, aptitude data, and career preferences…</p>
        `;
        S.generatingReport = false;
        generateReport();
      });
    }
    S.generatingReport = false;
    return;
  }
}

function renderDashboard(data) {
  document.getElementById("dashLoading").style.display = "none";
  const content = document.getElementById("dashContent");
  content.classList.remove("hidden");

  const stream = (data.streamRecommendation || "Science").trim();
  const isScience = stream.toLowerCase().includes("science");
  const isArtsOrCommerce = !isScience;

  document.getElementById("dhStream").textContent = stream;
  document.getElementById("dhCombo").textContent = data.subjectCombo || "—";
  document.getElementById("dhStudent").textContent = S.name + (S.city ? ` · ${S.city}` : "");
  document.getElementById("dhDate").textContent = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });

  const tagsEl = document.getElementById("dhTags");
  tagsEl.innerHTML = (data.strengthsIdentified || []).map(s => `<span class="dh-tag">${s}</span>`).join("");

  document.getElementById("dbInterest").textContent = data.interestProfile || "";

  const grid = document.getElementById("aptScoreGrid");
  grid.innerHTML = "";
  const scores = [
    ["Numerical",  S.scores.numerical,  "🔢"],
    ["Logical",    S.scores.logical,    "🧩"],
    ["Verbal",     S.scores.verbal,     "📖"],
    ["Abstract",   S.scores.abstract,   "🔷"],
    ["Data Intel", S.scores.dataInt,    "📊"],
  ];
  const total = Math.round(scores.reduce((a, [, v]) => a + v, 0) / scores.length);
  const overallEl = document.createElement("div");
  overallEl.className = "trio-overall";
  overallEl.innerHTML = `<span class="trio-overall-score">${total}%</span><span class="trio-overall-label">Overall · ${total >= 70 ? "Strong" : "Developing"}</span>`;
  grid.appendChild(overallEl);
  scores.forEach(([label, val, icon]) => {
    const color = val >= 70 ? "var(--gold)" : val >= 50 ? "#f5a623" : "var(--red,#ef4444)";
    const row = document.createElement("div");
    row.className = "trio-apt-item";
    row.innerHTML = `
      <span class="trio-apt-name">${icon} ${label}</span>
      <div class="trio-apt-track"><div class="trio-apt-fill" style="width:${val}%;background:${color}"></div></div>
      <span class="trio-apt-pct">${val}%</span>`;
    grid.appendChild(row);
  });

  const cg = document.getElementById("careerGrid");
  cg.innerHTML = "";
  S.ranked.forEach((idx, r) => {
    const p = S.pool[idx];
    const item = document.createElement("div");
    item.className = "cg-item";
    item.style.animationDelay = `${r * 0.07}s`;
    item.innerHTML = `<div class="cg-rank">#${r + 1}</div><span class="cg-emoji">${p.e}</span><div class="cg-name">${p.t}</div><div class="cg-sub">${p.d}</div>`;
    cg.appendChild(item);
  });

  const gEl = document.getElementById("guidanceText");
  let paras = (data.detailedGuidance || "").split(/\n\n+/).filter(p => p.trim()).map(p => `<p>${p.trim()}</p>`);

  if (isArtsOrCommerce) {
    const scienceNote = `<p class="guidance-note guidance-note--info">
      One thing worth knowing before you fully commit: Science in Class 11 keeps every door open —
      it gives you access to engineering, medicine, design, data science, <em>and</em> everything in
      Commerce and Arts as well. The reverse is not true. If you later discover a passion for
      technology or the sciences, switching from Arts or Commerce is very difficult.
      This is not a reason to change your path if you are genuinely clear — but if there is
      even a small pull toward STEM, Science is the safer, wider choice at this stage.
    </p>`;
    paras.splice(1, 0, scienceNote);
  }

  if (isScience) {
    const cmNote = `<div class="guidance-cm-block">
      <div class="cm-label">YOUR NEXT STEP</div>
      <p>
        One thing that makes the Science path smoother than most students realise:
        having the right support structure from Day 1 of Class 11 — not just for exams, but for
        building the skills that top colleges and companies actually look for.
        <strong>Curious Minds</strong> is built exactly for this.
        It is not just another JEE/NEET coaching — it is a study-and-skills platform under one roof.
        Alongside board and entrance exam preparation, they run structured programmes in AI,
        communication, problem-solving, and real-world projects — the kind of things that
        separate a good student from a prepared professional.
      </p>
      <p>
        Right now they are offering a <strong>free one-month AI course</strong> for students
        coming out of Class 10 — specifically designed to give you a head start before
        Class 11 even begins. If you are serious about making the most of the Science stream,
        this is the kind of foundation that pays off for years.
      </p>
      <div class="cm-tagline">Study + Skills · Under One Roof · Curious Minds Coaching</div>
    </div>`;
    const insertAt = Math.min(3, paras.length);
    paras.splice(insertAt, 0, cmNote);
  }

  gEl.innerHTML = paras.join("");

  setTimeout(() => {
    renderStreamChart(data.streamScores);
    renderRadarChart();
  }, 300);
  setTimeout(() => document.getElementById("dash-hero").scrollIntoView({ behavior: "smooth" }), 100);
}

/* ═══ CHARTS ══════════════════════════════════════════════ */
function chartTheme() {
  return {
    border: S.theme === "dark" ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)",
    text:   S.theme === "dark" ? "#8888a4" : "#555568",
    surf:   S.theme === "dark" ? "#13131a" : "#ffffff",
  };
}
function renderStreamChart(scores) {
  const ctx = document.getElementById("chartStream");
  if (!ctx) return;
  if (S.charts.stream) S.charts.stream.destroy();
  const cd = chartTheme();
  const s = scores || { science: 60, commerce: 50, arts: 40 };
  S.charts.stream = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Science", "Commerce", "Arts"],
      datasets: [{
        data: [s.science, s.commerce, s.arts],
        backgroundColor: ["rgba(237,245,0,.92)", "rgba(250,250,247,.5)", "rgba(57,255,20,.65)"],
        borderColor: cd.surf,
        borderWidth: 4,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: {
        legend: { position: "bottom", labels: { color: cd.text, font: { family: "'Space Mono'", size: 10 }, padding: 14, usePointStyle: true } },
      },
    },
  });
}
function renderRadarChart() {
  const ctx = document.getElementById("chartRadar");
  if (!ctx) return;
  if (S.charts.radar) S.charts.radar.destroy();
  const cd = chartTheme();
  S.charts.radar = new Chart(ctx, {
    type: "radar",
    data: {
      labels: ["Numerical", "Logical", "Verbal", "Abstract", "Data Int."],
      datasets: [{
        label: S.name,
        data: [S.scores.numerical, S.scores.logical, S.scores.verbal, S.scores.abstract, S.scores.dataInt],
        fill: true,
        backgroundColor: "rgba(237,245,0,.1)",
        borderColor: "rgba(237,245,0,.9)",
        pointBackgroundColor: "rgba(237,245,0,1)",
        pointBorderColor: cd.surf,
        pointHoverRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: cd.text, font: { family: "'Space Mono'", size: 10 } } } },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, color: cd.text, backdropColor: "transparent", font: { family: "'Space Mono'", size: 9 } },
          grid: { color: cd.border },
          pointLabels: { color: cd.text, font: { family: "'Space Grotesk'", size: 11 } },
          angleLines: { color: cd.border },
        },
      },
    },
  });
}

/* ═══ PDF — Professional multi-page report ═══════════════ */
async function downloadPDF() {
  const { jsPDF } = window.jspdf;
  const data = S.reportData;

  const BG    = [8,   8,   8  ];
  const SURF  = [22,  22,  22 ];
  const SURF2 = [32,  32,  32 ];
  const SURF3 = [42,  42,  42 ];
  const TXT   = [255, 255, 255];
  const DIM   = [210, 210, 200];
  const MUTED = [140, 140, 130];
  const GOLD  = [237, 245, 0  ];
  const GREEN = [57,  220, 20 ];
  const RED   = [255, 90,  90 ];
  const W = 210;

  const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });

  let logoB64 = null;
  try {
    const resp = await fetch("https://i.postimg.cc/pdx6CC83/Gemini-Generated-Image-rooaqqrooaqqrooa-removebg-preview.png");
    const blob = await resp.blob();
    logoB64 = await new Promise(res => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
  } catch(e) { logoB64 = null; }

  let y = 0;
  let pageNum = 1;

  function newPage() {
    doc.addPage();
    pageNum++;
    y = 0;
    drawBg();
    drawContinuationHeader();
    drawPageFooter();
  }
  function checkY(needed = 20) {
    if (y + needed > 272) newPage();
  }
  function spacer(h = 6) { y += h; }

  function drawBg() {
    doc.setFillColor(...BG);
    doc.rect(0, 0, W, 297, "F");
  }

  function drawPageFooter() {
    doc.setFillColor(...SURF); doc.rect(0, 282, W, 15, "F");
    doc.setFillColor(...GOLD); doc.rect(0, 282, W, 0.5, "F");
    doc.setFont("helvetica","normal"); doc.setFontSize(7); doc.setTextColor(...MUTED);
    doc.text("CURIOUS AI — Career Intelligence Platform", 16, 290);
    doc.text(new Date().toLocaleDateString("en-IN",{year:"numeric",month:"long",day:"numeric"}), W/2, 290, {align:"center"});
    doc.text(`Page ${pageNum}`, W - 16, 290, {align:"right"});
  }

  function drawFirstHeader() {
    drawBg();
    doc.setFillColor(...SURF); doc.rect(0, 0, W, 46, "F");
    doc.setFillColor(...GOLD); doc.rect(0, 0, W, 2.5, "F");

    if (logoB64) {
      try { doc.addImage(logoB64, "PNG", 13, 8, 22, 22); } catch(e) {}
    }

    doc.setFont("helvetica","bold"); doc.setFontSize(19); doc.setTextColor(...GOLD);
    doc.text("CURIOUS AI", 38, 18);
    doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text("Career Intelligence Platform", 38, 25);

    doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(...TXT);
    doc.text(`${S.name}${S.city ? "  ·  " + S.city : ""}`, W - 14, 16, {align:"right"});
    doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(`Age ${S.age || "—"}   ·   ${S.phone || "—"}`, W - 14, 23, {align:"right"});
    doc.text(S.email || "", W - 14, 29, {align:"right"});

    doc.setDrawColor(45, 45, 45); doc.setLineWidth(0.3);
    doc.line(14, 44, W - 14, 44);
    y = 54;
    drawPageFooter();
  }

  function drawContinuationHeader() {
    doc.setFillColor(...SURF); doc.rect(0, 0, W, 17, "F");
    doc.setFillColor(...GOLD); doc.rect(0, 0, W, 2, "F");
    if (logoB64) {
      try { doc.addImage(logoB64, "PNG", 13, 4, 9, 9); } catch(e) {}
    }
    doc.setFont("helvetica","bold"); doc.setFontSize(7); doc.setTextColor(...GOLD);
    doc.text("CURIOUS AI", 25, 11);
    doc.setFont("helvetica","normal"); doc.setTextColor(...MUTED);
    doc.text(`${S.name} — Career Intelligence Report`, W - 14, 11, {align:"right"});
    doc.setDrawColor(40, 40, 40); doc.setLineWidth(0.3);
    doc.line(14, 15, W - 14, 15);
    y = 24;
  }

  function sectionHead(title) {
    checkY(20);
    doc.setFillColor(...GOLD); doc.rect(14, y, 3.5, 8, "F");
    doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(...GOLD);
    doc.text(title, 22, y + 6);
    y += 14;
  }

  function divider(gap = 6) {
    doc.setDrawColor(38, 38, 38); doc.setLineWidth(0.25);
    doc.line(14, y, W - 14, y);
    y += gap;
  }

  function cleanText(t) {
    return (t || "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
      .replace(/&nbsp;/g," ")
      .trim();
  }

  function pdfSafe(t) {
    return (t || "")
      .replace(/÷/g, "/")
      .replace(/×/g, "x")
      .replace(/−/g, "-")
      .replace(/–/g, "-")
      .replace(/—/g, "-")
      .replace(/→/g, "->")
      .replace(/←/g, "<-")
      .replace(/…/g, "...")
      .replace(/’/g, "'")
      .replace(/‘/g, "'")
      .replace(/“/g, '"')
      .replace(/”/g, '"')
      .replace(/[^\x00-\x7F]/g, "");
  }

  function aptRow(label, val) {
    checkY(12);
    const barX = 72; const barW = W - barX - 28; const barH = 3.5;
    doc.setFillColor(...SURF2); doc.roundedRect(14, y, W - 28, 10, 1.5, 1.5, "F");
    doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(...DIM);
    doc.text(label, 19, y + 6.5);
    doc.setFillColor(50, 50, 50); doc.roundedRect(barX, y + 3.2, barW, barH, 1, 1, "F");
    const fc = val >= 70 ? GOLD : val >= 50 ? [245,166,35] : RED;
    doc.setFillColor(...fc);
    if (val > 0) doc.roundedRect(barX, y + 3.2, Math.max(barW * val / 100, 2), barH, 1, 1, "F");
    doc.setFont("helvetica","bold"); doc.setFontSize(8.5); doc.setTextColor(...fc);
    doc.text(`${val}%`, W - 18, y + 6.5, {align:"right"});
    y += 13;
  }

  drawFirstHeader();

  sectionHead("Stream Recommendation");

  checkY(30);
  doc.setFillColor(...SURF); doc.roundedRect(14, y, W - 28, 24, 3, 3, "F");
  doc.setFillColor(...GOLD); doc.rect(14, y, 5, 24, "F");
  doc.roundedRect(14, y, 5, 24, 2, 2, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(22); doc.setTextColor(...GOLD);
  doc.text(data?.streamRecommendation || "—", 25, y + 15);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("RECOMMENDED STREAM", W - 18, y + 8, {align:"right"});
  doc.setFontSize(9.5); doc.setTextColor(...DIM); doc.setFont("helvetica","bold");
  doc.text(data?.subjectCombo || "—", W - 18, y + 18, {align:"right"});
  y += 30;

  const tags = data?.strengthsIdentified || [];
  if (tags.length) {
    checkY(14);
    let tx = 14;
    tags.forEach(tag => {
      const tw = doc.getTextWidth(tag) + 8;
      if (tx + tw > W - 14) { tx = 14; y += 10; checkY(12); }
      doc.setFillColor(...SURF2); doc.roundedRect(tx, y, tw, 7, 2, 2, "F");
      doc.setFont("helvetica","bold"); doc.setFontSize(7); doc.setTextColor(...GOLD);
      doc.text(tag, tx + 4, y + 5);
      tx += tw + 4;
    });
    y += 12;
  }

  checkY(18);
  const metaItems = [
    ["STUDENT", S.name],
    ["CITY / SCHOOL", S.city || "—"],
    ["AGE", S.age ? `${S.age} years` : "—"],
    ["SESSION DATE", new Date().toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})],
  ];
  const mW = (W - 28) / metaItems.length;
  doc.setFillColor(...SURF2); doc.roundedRect(14, y, W - 28, 14, 2, 2, "F");
  metaItems.forEach(([lbl, val], i) => {
    const mx = 14 + i * mW + 5;
    doc.setFont("helvetica","bold"); doc.setFontSize(6); doc.setTextColor(...MUTED);
    doc.text(lbl, mx, y + 5);
    doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...TXT);
    doc.text(String(val), mx, y + 11);
  });
  y += 20;
  divider(8);

  sectionHead("Interest Profile");
  const ipText = cleanText(data?.interestProfile || "");
  if (ipText) {
    const lines = doc.splitTextToSize(ipText, W - 32);
    checkY(lines.length * 5.2 + 8);
    doc.setFillColor(...SURF); doc.roundedRect(14, y, W - 28, lines.length * 5.2 + 8, 2, 2, "F");
    doc.setFillColor(...GOLD); doc.rect(14, y, 3, lines.length * 5.2 + 8, "F");
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(...DIM);
    doc.text(lines, 21, y + 7);
    y += lines.length * 5.2 + 14;
  }
  divider(8);

  sectionHead("Aptitude Scores");

  const scores = [S.scores.numerical, S.scores.logical, S.scores.verbal, S.scores.abstract, S.scores.dataInt];
  const overall = Math.round(scores.reduce((a,b)=>a+b,0) / scores.length);
  checkY(18);
  doc.setFillColor(...SURF); doc.roundedRect(14, y, W - 28, 14, 2, 2, "F");
  doc.setFillColor(...GOLD); doc.rect(14, y, 3, 14, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text("OVERALL APTITUDE SCORE", 22, y + 6);
  doc.setFont("helvetica","bold"); doc.setFontSize(14); doc.setTextColor(...GOLD);
  doc.text(`${overall}%`, W - 18, y + 10, {align:"right"});
  const obx = 22; const obw = W - 60; const obh = 3;
  doc.setFillColor(50,50,50); doc.roundedRect(obx, y + 9, obw, obh, 1, 1, "F");
  doc.setFillColor(...(overall >= 70 ? GOLD : overall >= 50 ? [245,166,35] : RED));
  doc.roundedRect(obx, y + 9, Math.max(obw * overall / 100, 2), obh, 1, 1, "F");
  y += 20;
  spacer(2);

  aptRow("Numerical Reasoning",  S.scores.numerical);
  spacer(2);
  aptRow("Logical Thinking",     S.scores.logical);
  spacer(2);
  aptRow("Verbal Ability",       S.scores.verbal);
  spacer(2);
  aptRow("Abstract Reasoning",   S.scores.abstract);
  spacer(2);
  aptRow("Data Interpretation",  S.scores.dataInt);
  spacer(6);
  divider(8);

  sectionHead("Aptitude Test — Question Review");

  const questions  = S.questions || [];
  const answers    = S.answers   || {};
  const totalQ     = questions.length;
  const answeredQ  = Object.keys(answers).length;
  const correctQ   = questions.filter((q,i) => answers[i] === q.a).length;

  checkY(14);
  const qSummItems = [
    ["TOTAL QUESTIONS", String(totalQ)],
    ["ANSWERED", String(answeredQ)],
    ["CORRECT", String(correctQ)],
    ["SCORE", `${overall}%`],
  ];
  const qsW = (W - 28) / qSummItems.length;
  doc.setFillColor(...SURF2); doc.roundedRect(14, y, W - 28, 12, 2, 2, "F");
  qSummItems.forEach(([lbl, val], i) => {
    const qx = 14 + i * qsW + 5;
    doc.setFont("helvetica","bold"); doc.setFontSize(6); doc.setTextColor(...MUTED);
    doc.text(lbl, qx, y + 4.5);
    doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(...GOLD);
    doc.text(val, qx, y + 10);
  });
  y += 18;

  if (totalQ === 0) {
    checkY(14);
    doc.setFont("helvetica","italic"); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text("Aptitude test data not available for this session.", 14, y + 6);
    y += 14;
  } else {
    questions.forEach((q, i) => {
      const userAns    = answers[i];
      const isRight    = userAns === q.a;
      const answered   = userAns !== undefined;
      const optLetters = ["A", "B", "C", "D"];

      const qLines = doc.splitTextToSize(pdfSafe(q.q), W - 50);
      let blockH = qLines.length * 5 + 16;
      blockH += 22;
      if (q.x) {
        const exLines = doc.splitTextToSize(pdfSafe(q.x), W - 56);
        blockH += exLines.length * 4.8 + 16;
      }
      blockH += 6;

      checkY(blockH + 6);

      const cardBg = !answered ? [26, 26, 26] : isRight ? [16, 30, 16] : [34, 16, 16];
      doc.setFillColor(...cardBg);
      doc.roundedRect(14, y, W - 28, blockH, 2.5, 2.5, "F");

      const acc = !answered ? MUTED : isRight ? GREEN : RED;
      doc.setFillColor(...acc);
      doc.roundedRect(14, y, 4, blockH, 2, 2, "F");

      const resultLabel = !answered ? "— N/A" : isRight ? "✓ CORRECT" : "✗ INCORRECT";
      const resultColor = !answered ? MUTED   : isRight ? GREEN       : RED;
      const resultBg    = !answered ? SURF3   : isRight ? [16,40,16]  : [40,16,16];
      doc.setFontSize(6); doc.setFont("helvetica","bold");
      const rTw = doc.getTextWidth(resultLabel) + 6;
      doc.setFillColor(...resultBg);
      doc.roundedRect(W - 14 - rTw, y + 4, rTw, 7, 1.5, 1.5, "F");
      doc.setTextColor(...resultColor);
      doc.text(resultLabel, W - 14 - rTw / 2, y + 9, {align:"center"});

      const catTw = doc.getTextWidth((q.catL||"").toUpperCase()) + 6;
      doc.setFillColor(...SURF3);
      doc.roundedRect(W - 14 - rTw - catTw - 3, y + 4, catTw, 7, 1.5, 1.5, "F");
      doc.setFont("helvetica","bold"); doc.setFontSize(6); doc.setTextColor(...MUTED);
      doc.text((q.catL||"").toUpperCase(), W - 14 - rTw - catTw - 3 + catTw / 2, y + 9, {align:"center"});

      doc.setFillColor(...SURF3);
      doc.roundedRect(22, y + 4, 11, 7, 1.5, 1.5, "F");
      doc.setFont("helvetica","bold"); doc.setFontSize(7); doc.setTextColor(...MUTED);
      doc.text(`Q${i+1}`, 27.5, y + 9, {align:"center"});

      doc.setFont("helvetica","bold"); doc.setFontSize(8.5); doc.setTextColor(...TXT);
      doc.text(qLines, 37, y + 10);

      let iy = y + qLines.length * 5 + 14;

      doc.setFont("helvetica","bold"); doc.setFontSize(6); doc.setTextColor(...MUTED);
      doc.text("OPTIONS", 22, iy);
      iy += 4;

      const colW  = (W - 50) / 2;
      const colX1 = 22;
      const colX2 = 22 + colW + 4;
      const optH  = 7;
      const optGap = 3;

      [[0, 1], [2, 3]].forEach((pair, rowIdx) => {
        const rowY = iy + rowIdx * (optH + optGap);
        pair.forEach((j, colIdx) => {
          if (j >= (q.o || []).length) return;
          const optX         = colIdx === 0 ? colX1 : colX2;
          const isCorrectOpt = (j === q.a);
          const isStudentOpt = (answered && j === userAns);
          const isWrongChoice = isStudentOpt && !isCorrectOpt;

          const pillBg   = isCorrectOpt ? [16, 40, 16] : isWrongChoice ? [40, 16, 16] : SURF2;
          doc.setFillColor(...pillBg);
          doc.roundedRect(optX, rowY, colW, optH, 1.5, 1.5, "F");

          const letterBg = isCorrectOpt ? [30, 70, 30] : isWrongChoice ? [70, 30, 30] : SURF3;
          doc.setFillColor(...letterBg);
          doc.roundedRect(optX + 1, rowY + 1, 6, optH - 2, 1, 1, "F");
          doc.setFont("helvetica","bold"); doc.setFontSize(6);
          const letterColor = isCorrectOpt ? GREEN : isWrongChoice ? RED : MUTED;
          doc.setTextColor(...letterColor);
          doc.text(optLetters[j], optX + 4, rowY + 5, {align:"center"});

          const prefix       = isCorrectOpt ? "✓ " : isWrongChoice ? "✗ " : "";
          const optTextColor = isCorrectOpt ? GREEN : isWrongChoice ? RED : MUTED;
          doc.setFont("helvetica", isCorrectOpt || isWrongChoice ? "bold" : "normal");
          doc.setFontSize(7);
          doc.setTextColor(...optTextColor);
          const optText = prefix + pdfSafe(q.o[j] || "");
          const optLine = doc.splitTextToSize(optText, colW - 12)[0];
          doc.text(optLine, optX + 9, rowY + 5);
        });
      });

      iy += 2 * (optH + optGap) + 2;

      if (q.x) {
        const exLines = doc.splitTextToSize(pdfSafe(q.x), W - 56);
        const exH = exLines.length * 4.8 + 12;
        doc.setFillColor(28, 28, 16);
        doc.roundedRect(22, iy, W - 36, exH, 2, 2, "F");
        doc.setFillColor(...GOLD);
        doc.rect(22, iy, 2.5, exH, "F");
        doc.setFont("helvetica","bold"); doc.setFontSize(5.5); doc.setTextColor(...MUTED);
        doc.text("EXPLANATION", 27, iy + 4);
        doc.setFont("helvetica","italic"); doc.setFontSize(7.5);
        doc.setTextColor(210, 210, 160);
        doc.text(exLines, 27, iy + 9);
        iy += exH + 3;
      }

      y = iy + 5;
      spacer(3);
    });
  }
  divider(8);

  sectionHead("Career Choices — Your Top 5");
  S.ranked.forEach((idx, r) => {
    const p = S.pool[idx];
    if (!p) return;
    checkY(18);
    doc.setFillColor(...SURF); doc.roundedRect(14, y, W - 28, 14, 2, 2, "F");
    doc.setFillColor(...GOLD); doc.roundedRect(14, y, 14, 14, 2, 2, "F");
    doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(...BG);
    doc.text(`#${r+1}`, 21, y + 9, {align:"center"});
    doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(...TXT);
    doc.text(p.t || "", 33, y + 7);
    doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(p.d || "", 33, y + 12);
    if (p.s) {
      const stw = doc.getTextWidth(p.s) + 7;
      doc.setFillColor(...SURF2); doc.roundedRect(W - 14 - stw, y + 4, stw, 6, 1.5, 1.5, "F");
      doc.setFont("helvetica","bold"); doc.setFontSize(6.5); doc.setTextColor(...GOLD);
      doc.text(p.s, W - 14 - stw/2, y + 8.5, {align:"center"});
    }
    y += 17;
  });
  spacer(4);
  divider(8);

  sectionHead("Career Guidance");

  let allGuidanceText = "";
  const guidanceEl = document.getElementById("guidanceText");
  if (guidanceEl) {
    allGuidanceText = guidanceEl.innerText || guidanceEl.textContent || "";
  }
  if (!allGuidanceText.trim()) {
    allGuidanceText = cleanText(data?.detailedGuidance || "");
  }

  const guidanceParas = allGuidanceText
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, " ").trim())
    .filter(p => p.length > 8);

  guidanceParas.forEach(para => {
    const lines = doc.splitTextToSize(para, W - 38);
    const cardH = lines.length * 5.2 + 10;
    checkY(cardH + 6);
    doc.setFillColor(...SURF); doc.roundedRect(14, y, W - 28, cardH, 2, 2, "F");
    doc.setFillColor(...GOLD); doc.rect(14, y, 3, cardH, "F");
    doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(...DIM);
    doc.text(lines, 22, y + 7);
    y += cardH + 7;
  });

  spacer(8);
  checkY(18);
  doc.setFillColor(...SURF2); doc.roundedRect(14, y, W - 28, 14, 2, 2, "F");
  doc.setFillColor(...GOLD); doc.rect(14, y, 3.5, 14, "F");
  if (logoB64) { try { doc.addImage(logoB64,"PNG", 21, y + 2, 10, 10); } catch(e){} }
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(...GOLD);
  doc.text("CURIOUS AI", 35, y + 7);
  doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  doc.text("Career Intelligence Platform — Personalised Report for " + S.name, 35, y + 12);

  const fetchImgB64 = async (url) => {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      const mime = blob.type || (url.endsWith(".png") ? "image/png" : "image/jpeg");
      const b64 = await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(blob);
      });
      return { b64, mime };
    } catch(e) { return null; }
  };

  const [cmImg, elImg] = await Promise.all([
    fetchImgB64("https://i.postimg.cc/t4qkQ7B7/CM.png"),
    fetchImgB64("https://i.postimg.cc/9FJT9bYk/EL.jpg"),
  ]);

  if (cmImg) {
    doc.addPage();
    pageNum++;
    try {
      doc.addImage(cmImg.b64, "PNG", 0, 0, 210, 297);
    } catch(e) {
      try { doc.addImage(cmImg.b64, "JPEG", 0, 0, 210, 297); } catch(e2) {}
    }
  }

  if (elImg) {
    doc.addPage();
    pageNum++;
    try {
      doc.addImage(elImg.b64, "JPEG", 0, 0, 210, 297);
    } catch(e) {
      try { doc.addImage(elImg.b64, "PNG", 0, 0, 210, 297); } catch(e2) {}
    }
  }

  const filename = `CuriousAI_${S.name.replace(/\s+/g,"_")}_Report.pdf`;
  const pdfBlob  = doc.output("blob");
  const blobUrl  = URL.createObjectURL(pdfBlob);
  const link     = document.createElement("a");
  link.href      = blobUrl;
  link.download  = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 8000);
}

/* ═══ AUTO‑APPROVE FUNCTIONS ═══════════════════════════════ */
async function loadAutoApproveSetting() {
  try {
    const doc = await fbDb.collection("settings").doc("global").get();
    if (doc.exists && doc.data().autoApprove !== undefined) {
      const toggle = document.getElementById("autoApproveToggle");
      if (toggle) toggle.checked = doc.data().autoApprove;
    }
  } catch (err) {
    console.warn("Failed to load auto-approve setting:", err);
  }
}

async function saveAutoApproveSetting(value) {
  try {
    await fbDb.collection("settings").doc("global").set({ autoApprove: value }, { merge: true });
  } catch (err) {
    console.error("Failed to save auto-approve setting:", err);
  }
}

/* ═══ INIT ════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded",()=>{
  initTheme();
  initOnboarding();

  document.getElementById("btnVerifyOTP").addEventListener("click", verifyOTP);
  document.getElementById("otpInput").addEventListener("keydown", e => {
    if (e.key === "Enter") verifyOTP();
  });
  document.getElementById("btnResendOTP").addEventListener("click", () => {
    if (S.phone) sendOTP(S.phone);
  });
  document.getElementById("btnBackToForm").addEventListener("click", () => {
    document.getElementById("otpScreen").classList.add("hidden");
    if (window._recaptchaVerifier) {
      try { window._recaptchaVerifier.clear(); } catch(e) {}
      window._recaptchaVerifier = null;
    }
    const rcContainer = document.getElementById("recaptcha-container");
    if (rcContainer) rcContainer.innerHTML = "";
    fbConfirmationResult = null;
  });
  const otpThemeToggle = document.getElementById("themeToggleOTP");
  if (otpThemeToggle) otpThemeToggle.addEventListener("click", () => applyTheme(S.theme==="dark"?"light":"dark"));

  document.getElementById("sendBtn").addEventListener("click", sendMessage);
  document.getElementById("chatTA").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById("chatTA").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  });

  S.convMode    = 'hybrid';
  S.hybridInput = 'mic';

  function applyConvMode(mode, opts = {}) {
    const prevMode = S.convMode;
    S.convMode = mode;

    const micZone     = document.getElementById('chatMicZone');
    const hybCompose  = document.getElementById('hybridCompose');
    const chatCompose = document.getElementById('chatCompose');
    const chatBox     = document.getElementById('chatBox');
    const btnChat     = document.getElementById('cmtChat');
    const btnHybrid   = document.getElementById('cmtHybrid');
    const modeBar     = document.getElementById('convModeBar');

    btnChat.classList.toggle('active', mode === 'chat');
    btnHybrid.classList.toggle('active', mode === 'hybrid');
    chatBox.setAttribute('data-conv', mode);
    if (modeBar) modeBar.setAttribute('data-mode', mode);

    if (mode === 'chat') {
      if (prevMode === 'hybrid' && listening) {
        VOICE.stop(); listening = false;
        const mb = document.getElementById('micBtn');
        if (mb) mb.classList.remove('listening');
      }
      VOICE.stopTTS();

      micZone.classList.add('hidden');
      hybCompose.classList.add('hidden');
      chatCompose.classList.remove('hidden');

      const ta = document.getElementById('chatTA');
      const sb = document.getElementById('sendBtn');
      if (ta) { ta.disabled = false; ta.placeholder = 'Type your response\u2026'; }
      if (sb) sb.disabled = false;
      if (!opts.silent && ta) ta.focus();

    } else {
      chatCompose.classList.add('hidden');

      if (S.hybridInput === 'keyboard') {
        micZone.classList.add('hidden');
        hybCompose.classList.remove('hidden');
        if (!VOICE._ttsPlaying) setInputState(false);
        const hta = document.getElementById('hybridTA');
        if (hta && !opts.silent) hta.focus();
      } else {
        hybCompose.classList.add('hidden');
        micZone.classList.remove('hidden');
        if (!VOICE._ttsPlaying) setInputState(false);
      }
    }
  }

  function switchHybridToKeyboard() {
    S.hybridInput = 'keyboard';
    document.getElementById('chatMicZone').classList.add('hidden');
    document.getElementById('hybridCompose').classList.remove('hidden');
    const hta = document.getElementById('hybridTA');
    if (hta) { hta.disabled = VOICE._ttsPlaying; if (!VOICE._ttsPlaying) hta.focus(); }
    const hb = document.getElementById('hybridSendBtn');
    if (hb) hb.disabled = VOICE._ttsPlaying;
  }
  function switchHybridToMic() {
    S.hybridInput = 'mic';
    document.getElementById('hybridCompose').classList.add('hidden');
    document.getElementById('chatMicZone').classList.remove('hidden');
    const ms = document.getElementById('micStatus');
    if (ms) ms.textContent = VOICE._ttsPlaying ? 'AI is speaking\u2026' : 'Tap mic to answer';
    const mb = document.getElementById('micBtn');
    if (mb) mb.disabled = VOICE._ttsPlaying;
  }

  document.getElementById('cmtChat').addEventListener('click', () => {
    if (S.convMode !== 'chat') applyConvMode('chat');
  });
  document.getElementById('cmtHybrid').addEventListener('click', () => {
    if (S.convMode !== 'hybrid') applyConvMode('hybrid');
  });
  document.getElementById('switchToKeyboard').addEventListener('click', switchHybridToKeyboard);
  document.getElementById('switchToMic').addEventListener('click', switchHybridToMic);

  function sendHybridMessage() {
    const hta = document.getElementById('hybridTA');
    if (!hta) return;
    const text = hta.value.trim();
    if (!text || S.convDone) return;
    addUserMsg(text); addHistory('user', text);
    hta.value = ''; hta.style.height = 'auto';
    setLock(true); setTyping(true);
    (async () => {
      try {
        const reply = await askConversationQuestion();
        setTyping(false);
        if (reply === '[CLOSING]') {
          const closing = CONV_CLOSING.replace(/{name}/g, S.name);
          addAIMsg(closing); addHistory('assistant', closing);
          setTimeout(() => finishConversation(), 400);
          return;
        }
        addAIMsg(reply); addHistory('assistant', reply); S.qCount++;
      } catch(err) {
        setTyping(false);
        const ef = document.getElementById('chatFeed');
        const ed = document.createElement('div'); ed.className = 'msg msg-ai';
        ed.innerHTML = '<div class="msg-bub" style="color:var(--red)">Error: ' + esc(err.message) + '</div>';
        ef.appendChild(ed); scrollFeed();
        VOICE._ttsPlaying = false; VOICE._ttsQueue = [];
        if (!S.convDone) { setLock(false); setInputState(false); }
      }
    })();
  }

  document.getElementById('hybridSendBtn').addEventListener('click', sendHybridMessage);
  document.getElementById('hybridTA').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHybridMessage(); }
  });
  document.getElementById('hybridTA').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  applyConvMode('hybrid', { silent: true });

  let listening = false;
  document.getElementById('micBtn').addEventListener('click', () => {
    if (S.convDone || VOICE._ttsPlaying) return;
    const btn       = document.getElementById('micBtn');
    const micStatus = document.getElementById('micStatus');
    const preview   = document.getElementById('micPreview');

    if (listening) {
      VOICE.stop(); listening = false; btn.classList.remove('listening');
      return;
    }

    const ok = VOICE.start(
      (transcript) => {
        if (!transcript.trim()) return;
        if (preview) preview.textContent = '';
        btn.disabled = true; btn.classList.remove('listening'); listening = false;
        if (micStatus) micStatus.textContent = 'AI is thinking…';

        addUserMsg(transcript); addHistory('user', transcript);

        (async () => {
          const typingEl = document.getElementById('chatTyping');
          if (typingEl) typingEl.classList.remove('hidden');
          try {
            const reply = await askConversationQuestion();
            if (typingEl) typingEl.classList.add('hidden');
            if (reply === '[CLOSING]') {
              const closing = CONV_CLOSING.replace(/{name}/g, S.name);
              addAIMsg(closing); addHistory('assistant', closing);
              setTimeout(() => finishConversation(), 400);
              return;
            }
            addAIMsg(reply); addHistory('assistant', reply); S.qCount++;
          } catch(err) {
            if (typingEl) typingEl.classList.add('hidden');
            const ef=document.getElementById('chatFeed');
            const ed=document.createElement('div'); ed.className='msg msg-ai';
            ed.innerHTML='<div class="msg-bub" style="color:var(--red)">Error: '+esc(err.message)+'</div>';
            ef.appendChild(ed); scrollFeed();
            btn.disabled = false;
            VOICE._ttsPlaying = false; VOICE._ttsQueue = [];
            if (!S.convDone) setInputState(false);
          }
        })();
      },
      () => { listening = false; btn.classList.remove('listening'); }
    );

    if (ok) {
      listening = true; btn.classList.add('listening');
      if (micStatus) micStatus.textContent = 'Listening… tap again to stop';
      if (preview)   preview.textContent   = '';
    }
  });

  document.getElementById("aptPrev").addEventListener("click",()=>{if(S.curQ>0){S.curQ--;renderQ();}});
  document.getElementById("aptNext").addEventListener("click",()=>{if(S.curQ<9){S.curQ++;renderQ();}else submitApt();});

  document.getElementById("btnPDF").addEventListener("click",downloadPDF);
  document.getElementById("btnRestart").addEventListener("click",()=>window.location.reload());

  document.querySelectorAll(".dsn-link").forEach(a=>{
    a.addEventListener("click",e=>{
      e.preventDefault();
      const target=document.querySelector(a.getAttribute("href"));
      if(target)target.scrollIntoView({behavior:"smooth",block:"start"});
      document.querySelectorAll(".dsn-link").forEach(l=>l.classList.remove("active"));
      a.classList.add("active");
    });
  });
});

/* ═══════════════════════════════════════════════════════════
   FIREBASE — ADMIN LOGIN & DASHBOARD (UPDATED with auto‑approve)
═══════════════════════════════════════════════════════════ */
let fbPendingUnsubscribe = null;
let fbApprovedUnsubscribe = null;
let fbRejectedUnsubscribe = null;
let _approvedDocs = [];
let _rejectedDocs = [];
let fbCompletedUnsubscribe = null;
let _adminSessions = [];

document.addEventListener("DOMContentLoaded", () => {
  const modal     = document.getElementById("adminModal");
  const admDash   = document.getElementById("adminDashboard");
  const btnLogin  = document.getElementById("btnAdminLogin");
  const btnClose  = document.getElementById("btnAdminClose");
  const btnSubmit = document.getElementById("btnAdminSubmit");
  const btnLogout = document.getElementById("btnAdminLogout");
  const adminErr  = document.getElementById("adminErr");

  if (!btnLogin) return;

  btnLogin.addEventListener("click", () => {
    modal.classList.remove("hidden");
    document.getElementById("adminUser").focus();
  });

  btnClose.addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", e => { if (e.target === modal) modal.classList.add("hidden"); });

  async function tryLogin() {
    const email    = document.getElementById("adminUser").value.trim();
    const password = document.getElementById("adminPass").value.trim();
    if (!email || !password) { adminErr.textContent = "Please enter email and password."; return; }

    const btn = document.getElementById("btnAdminSubmit");
    btn.disabled = true;
    btn.querySelector("span").textContent = "Logging in…";
    adminErr.textContent = "";

    try {
      await fbAuth.signInWithEmailAndPassword(email, password);
      adminErr.textContent = "";
      modal.classList.add("hidden");
      document.getElementById("onboarding").style.display = "none";
      admDash.classList.remove("hidden");
      renderAdminDashboard();
      // Load auto‑approve setting and attach listener
      loadAutoApproveSetting();
      const toggle = document.getElementById("autoApproveToggle");
      if (toggle) {
        toggle.addEventListener("change", async (e) => {
          await saveAutoApproveSetting(e.target.checked);
        });
      }
    } catch(err) {
      console.error("Admin login error:", err);
      adminErr.textContent = "Invalid credentials. Please try again.";
      document.getElementById("adminPass").value = "";
    } finally {
      btn.disabled = false;
      btn.querySelector("span").textContent = "Access Dashboard";
    }
  }

  btnSubmit.addEventListener("click", tryLogin);
  document.getElementById("adminPass").addEventListener("keydown", e => {
    if (e.key === "Enter") tryLogin();
  });

  btnLogout.addEventListener("click", async () => {
    if (fbPendingUnsubscribe)   { fbPendingUnsubscribe();   fbPendingUnsubscribe   = null; }
    if (fbApprovedUnsubscribe)  { fbApprovedUnsubscribe();  fbApprovedUnsubscribe  = null; }
    if (fbRejectedUnsubscribe)  { fbRejectedUnsubscribe();  fbRejectedUnsubscribe  = null; }
    if (fbCompletedUnsubscribe) { fbCompletedUnsubscribe(); fbCompletedUnsubscribe = null; }
    _approvedDocs = [];
    _rejectedDocs = [];
    try { await fbAuth.signOut(); } catch(e) { console.warn("Sign out error:", e); }
    admDash.classList.add("hidden");
    document.getElementById("onboarding").style.display = "";
    document.getElementById("adminUser").value = "";
    document.getElementById("adminPass").value = "";
    _adminSessions = [];
  });

  document.querySelectorAll(".adm-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".adm-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      renderAdminGrid(getCurrentFilter(), getCurrentSearch());
    });
  });

  document.getElementById("admSearch").addEventListener("input", () => {
    renderAdminGrid(getCurrentFilter(), getCurrentSearch());
  });

  const tabApproved = document.getElementById("admTabApproved");
  const tabRejected = document.getElementById("admTabRejected");
  if (tabApproved && tabRejected) {
    tabApproved.addEventListener("click", () => {
      tabApproved.classList.add("active");
      tabRejected.classList.remove("active");
      renderHistoryCards();
    });
    tabRejected.addEventListener("click", () => {
      tabRejected.classList.add("active");
      tabApproved.classList.remove("active");
      renderHistoryCards();
    });
  }

  const btnRefresh = document.getElementById("btnAdminRefresh");
  if (btnRefresh) {
    btnRefresh.addEventListener("click", () => {
      btnRefresh.classList.add("refreshing");
      setTimeout(() => btnRefresh.classList.remove("refreshing"), 700);

      if (fbPendingUnsubscribe)   { fbPendingUnsubscribe();   fbPendingUnsubscribe   = null; }
      if (fbApprovedUnsubscribe)  { fbApprovedUnsubscribe();  fbApprovedUnsubscribe  = null; }
      if (fbRejectedUnsubscribe)  { fbRejectedUnsubscribe();  fbRejectedUnsubscribe  = null; }
      if (fbCompletedUnsubscribe) { fbCompletedUnsubscribe(); fbCompletedUnsubscribe = null; }
      renderAdminDashboard();

      const toast = document.getElementById("adminToast");
      if (toast) {
        toast.classList.remove("hidden");
        setTimeout(() => toast.classList.add("hidden"), 2000);
      }
    });
  }
});

function getCurrentFilter() {
  const active = document.querySelector(".adm-pill.active");
  return active ? active.dataset.filter : "all";
}
function getCurrentSearch() {
  const el = document.getElementById("admSearch");
  return el ? el.value.toLowerCase().trim() : "";
}

function listenPendingRequests() {
  if (fbPendingUnsubscribe) { fbPendingUnsubscribe(); fbPendingUnsubscribe = null; }

  fbPendingUnsubscribe = fbDb.collection("sessionRequests")
    .where("status", "==", "pending")
    .orderBy("createdAt", "desc")
    .onSnapshot((snapshot) => {
      renderPendingCards(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (err) => {
      console.error("Pending requests listener error:", err);
    });
}

function listenSessionHistory() {
  if (fbApprovedUnsubscribe) { fbApprovedUnsubscribe(); fbApprovedUnsubscribe = null; }
  if (fbRejectedUnsubscribe) { fbRejectedUnsubscribe(); fbRejectedUnsubscribe = null; }

  fbApprovedUnsubscribe = fbDb.collection("sessionRequests")
    .where("status", "==", "approved")
    .orderBy("createdAt", "desc")
    .onSnapshot(snap => {
      _approvedDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      updateHistoryCounts();
      renderHistoryCards();
    }, err => { console.error("Approved listener error:", err); });

  fbRejectedUnsubscribe = fbDb.collection("sessionRequests")
    .where("status", "==", "rejected")
    .orderBy("createdAt", "desc")
    .onSnapshot(snap => {
      _rejectedDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      updateHistoryCounts();
      renderHistoryCards();
    }, err => { console.error("Rejected listener error:", err); });
}

function updateHistoryCounts() {
  const approvedEl = document.getElementById("admApprovedCount");
  const rejectedEl = document.getElementById("admRejectedCount");
  if (approvedEl) approvedEl.textContent = _approvedDocs.length;
  if (rejectedEl) rejectedEl.textContent = _rejectedDocs.length;
}

function renderHistoryCards() {
  const grid     = document.getElementById("admHistoryGrid");
  const emptyEl  = document.getElementById("historyEmpty");
  if (!grid) return;

  const tabApprovedEl = document.getElementById("admTabApproved");
  const tabRejectedEl = document.getElementById("admTabRejected");
  const isRejected = tabRejectedEl && tabRejectedEl.classList.contains("active") &&
                     tabApprovedEl && !tabApprovedEl.classList.contains("active");
  const docs = isRejected ? _rejectedDocs : _approvedDocs;

  grid.querySelectorAll(".adm-history-card").forEach(c => c.remove());

  if (docs.length === 0) {
    if (emptyEl) { emptyEl.style.display = "block"; }
    return;
  }
  if (emptyEl) { emptyEl.style.display = "none"; }

  docs.forEach((req, idx) => {
    const card = document.createElement("div");
    card.className = "adm-history-card";
    card.style.animationDelay = `${idx * 0.04}s`;

    const createdAt = req.createdAt?.toDate ? req.createdAt.toDate() : new Date();
    const minutesAgo = Math.floor((Date.now() - createdAt.getTime()) / 60000);
    const timeAgo = minutesAgo < 1 ? "just now"
      : minutesAgo < 60 ? `${minutesAgo} minute${minutesAgo!==1?"s":""} ago`
      : minutesAgo < 1440 ? `${Math.floor(minutesAgo/60)} hour${Math.floor(minutesAgo/60)!==1?"s":""} ago`
      : `${Math.floor(minutesAgo/1440)} day${Math.floor(minutesAgo/1440)!==1?"s":""} ago`;

    const initials = (req.name||"?").split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
    const statusClass = req.status === "approved" ? "adm-history-status--approved" : "adm-history-status--rejected";
    const statusLabel = req.status === "approved" ? "APPROVED" : "REJECTED";

    card.innerHTML = `
      <div class="adm-history-card-header">
        <div class="adm-req-avatar">${initials}</div>
        <div class="adm-req-info">
          <div class="adm-req-name">${req.name || "—"}</div>
          <div class="adm-req-meta">${req.city || "—"} · Age ${req.age || "—"}</div>
        </div>
        <span class="adm-history-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="adm-history-details">
        <span class="adm-req-detail">📱 +91${req.phone || "—"}</span>
        <span class="adm-req-detail">✉️ ${req.email || "—"}</span>
      </div>
      <div class="adm-req-time" style="margin-top:.4rem;">${timeAgo}</div>
      <div class="adm-req-actions" style="margin-top:.7rem;">
        <button class="adm-history-delete" data-uid="${req.id}">✕ Delete</button>
      </div>`;

    card.querySelector(".adm-history-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      const uid = e.currentTarget.dataset.uid;
      if (!confirm(`Delete this record for ${req.name || "this student"}? This cannot be undone.`)) return;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = "Deleting…";
      try {
        await fbDb.collection("sessionRequests").doc(uid).delete();
      } catch(err) {
        console.error("Delete error:", err);
        e.currentTarget.disabled = false;
        e.currentTarget.textContent = "✕ Delete";
      }
    });

    grid.appendChild(card);
  });
}

function renderPendingCards(requests) {
  const grid      = document.getElementById("pendingRequestsGrid");
  const emptyEl   = document.getElementById("pendingEmpty");
  const badgeEl   = document.getElementById("pendingBadge");

  badgeEl.textContent = requests.length;
  badgeEl.style.display = requests.length > 0 ? "inline-flex" : "none";

  grid.querySelectorAll(".adm-req-card").forEach(c => c.remove());

  if (requests.length === 0) {
    emptyEl.style.display = "flex";
    return;
  }
  emptyEl.style.display = "none";

  requests.forEach((req, idx) => {
    const card = document.createElement("div");
    card.className = "adm-req-card";
    card.style.animationDelay = `${idx * 0.05}s`;

    const createdAt = req.createdAt?.toDate ? req.createdAt.toDate() : new Date();
    const minutesAgo = Math.floor((Date.now() - createdAt.getTime()) / 60000);
    const timeAgo = minutesAgo < 1 ? "just now"
      : minutesAgo < 60 ? `${minutesAgo} minute${minutesAgo!==1?"s":""} ago`
      : `${Math.floor(minutesAgo/60)} hour${Math.floor(minutesAgo/60)!==1?"s":""} ago`;

    card.innerHTML = `
      <div class="adm-req-header">
        <div class="adm-req-avatar">${(req.name||"?").split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2)}</div>
        <div class="adm-req-info">
          <div class="adm-req-name">${req.name || "—"}</div>
          <div class="adm-req-meta">${req.city || "—"} · Age ${req.age || "—"}</div>
        </div>
        <div class="adm-req-time">${timeAgo}</div>
      </div>
      <div class="adm-req-details">
        <span class="adm-req-detail">📱 +91${req.phone || "—"}</span>
        <span class="adm-req-detail">✉️ ${req.email || "—"}</span>
      </div>
      <div class="adm-req-actions">
        <button class="adm-req-approve" data-uid="${req.id}">✓ Approve</button>
        <button class="adm-req-reject"  data-uid="${req.id}">✕ Reject</button>
      </div>`;

    card.querySelector(".adm-req-approve").addEventListener("click", async (e) => {
      e.stopPropagation();
      const uid = e.currentTarget.dataset.uid;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = "Approving…";
      try {
        await fbDb.collection("sessionRequests").doc(uid).update({ status: "approved" });
      } catch(err) {
        console.error("Approve error:", err);
        e.currentTarget.disabled = false;
        e.currentTarget.textContent = "✓ Approve";
      }
    });

    card.querySelector(".adm-req-reject").addEventListener("click", async (e) => {
      e.stopPropagation();
      const uid = e.currentTarget.dataset.uid;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = "Rejecting…";
      try {
        await fbDb.collection("sessionRequests").doc(uid).update({ status: "rejected" });
      } catch(err) {
        console.error("Reject error:", err);
        e.currentTarget.disabled = false;
        e.currentTarget.textContent = "✕ Reject";
      }
    });

    grid.appendChild(card);
  });
}

function renderAdminDashboard() {
  listenPendingRequests();
  listenSessionHistory();
  listenCompletedSessions();
}

function listenCompletedSessions() {
  if (fbCompletedUnsubscribe) { fbCompletedUnsubscribe(); fbCompletedUnsubscribe = null; }

  const grid    = document.getElementById("admGrid");
  const emptyEl = document.getElementById("admEmpty");
  if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--txt3);font-family:var(--mono);font-size:.8rem;">Loading sessions…</div>`;
  if (emptyEl) emptyEl.classList.add("hidden");

  fbCompletedUnsubscribe = fbDb.collection("completedSessions")
    .orderBy("completedAt", "desc")
    .onSnapshot((snapshot) => {
      _adminSessions = snapshot.docs.map(d => {
        const data = d.data();
        return {
          ...data,
          _docId: d.id,
          date: data.completedAt?.toDate ? data.completedAt.toDate().toISOString() : new Date().toISOString(),
        };
      });

      document.getElementById("admTotalCount").textContent    = _adminSessions.length;
      document.getElementById("admCompleteCount").textContent = _adminSessions.filter(s => s.reportData?.streamRecommendation).length;
      document.getElementById("admSciCount").textContent      = _adminSessions.filter(s => (s.reportData?.streamRecommendation||"").toLowerCase().includes("science")).length;

      renderAdminGrid(getCurrentFilter(), getCurrentSearch());

    }, (err) => {
      console.error("Completed sessions listener error:", err);
      if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--red);font-family:var(--mono);font-size:.8rem;">Failed to load sessions. Check Firestore rules and connection.</div>`;
    });
}

function renderAdminGrid(filter, search) {
  const sessions = _adminSessions;
  const grid     = document.getElementById("admGrid");
  const emptyEl  = document.getElementById("admEmpty");

  let filtered = sessions.filter(s => {
    const stream = (s.reportData?.streamRecommendation || "").toLowerCase();
    if (filter === "complete" && !s.reportData?.streamRecommendation) return false;
    if (filter === "science"  && !stream.includes("science"))  return false;
    if (filter === "commerce" && !stream.includes("commerce")) return false;
    if (filter === "arts"     && !stream.includes("arts"))     return false;
    if (search) {
      const hay = `${s.name} ${s.city} ${s.email} ${s.phone}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  grid.innerHTML = "";
  if (filtered.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  filtered.forEach((s, idx) => {
    const card = document.createElement("div");
    card.className = "adm-card";
    card.style.animationDelay = `${idx * 0.04}s`;

    const stream    = s.reportData?.streamRecommendation || "";
    const hasReport = !!stream;
    const initials  = (s.name||"?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0,2);
    const dateStr   = new Date(s.date).toLocaleDateString("en-IN", {day:"numeric", month:"short", year:"numeric"});
    const total     = s.scores ? Math.round(Object.values(s.scores).reduce((a,b)=>a+b,0)/5) : 0;

    const aptBars = s.scores ? [
      ["Numerical", s.scores.numerical],
      ["Logical",   s.scores.logical],
      ["Verbal",    s.scores.verbal],
      ["Abstract",  s.scores.abstract],
      ["Data Int.", s.scores.dataInt],
    ].map(([label,val])=>`
      <div class="adm-card-apt-row">
        <span class="adm-card-apt-name">${label}</span>
        <div class="adm-card-apt-track"><div class="adm-card-apt-fill" style="width:${val||0}%;background:${(val||0)>=70?"var(--gold)":(val||0)>=50?"#f59e0b":"var(--red,#ef4444)"}"></div></div>
        <span class="adm-card-apt-pct">${val||0}%</span>
      </div>`).join("") : '<div class="adm-card-apt-name" style="color:var(--txt3)">No aptitude data</div>';

    card.innerHTML = `
      <div class="adm-card-header">
        <div class="adm-card-avatar">${initials}</div>
        <div class="adm-card-name-wrap">
          <div class="adm-card-name">${s.name}</div>
          <div class="adm-card-city">${s.city || "—"}</div>
        </div>
        <div class="adm-card-stream-badge ${hasReport?"":"pending"}">${hasReport ? stream : "PENDING"}</div>
      </div>
      <div class="adm-card-body">
        <div class="adm-card-info-row">
          <div class="adm-card-info-item">
            <span class="adm-card-info-label">Age</span>
            <span class="adm-card-info-val">${s.age || "—"}</span>
          </div>
          <div class="adm-card-info-item">
            <span class="adm-card-info-label">Phone</span>
            <span class="adm-card-info-val">${s.phone || "—"}</span>
          </div>
          <div class="adm-card-info-item">
            <span class="adm-card-info-label">Email</span>
            <span class="adm-card-info-val" title="${s.email||''}">${s.email || "—"}</span>
          </div>
          <div class="adm-card-info-item">
            <span class="adm-card-info-label">Overall Aptitude</span>
            <span class="adm-card-info-val" style="color:var(--gold);font-family:var(--mono);font-weight:700">${total}%</span>
          </div>
        </div>
        <div class="adm-card-apt">
          <div class="adm-card-apt-label"><span>APTITUDE BREAKDOWN</span></div>
          <div class="adm-card-apt-bars">${aptBars}</div>
        </div>
      </div>
      <div class="adm-card-footer">
        <span class="adm-card-date">${dateStr}</span>
        <div style="display:flex;align-items:center;gap:.6rem;">
          ${hasReport ? `<span class="adm-card-cta">View Full Report →</span>` : `<span class="adm-card-date" style="color:var(--txt3)">Report not generated</span>`}
          <button class="adm-card-delete" data-docid="${s._docId || ""}">✕ Delete</button>
        </div>
      </div>`;

    const delBtn = card.querySelector(".adm-card-delete");
    if (delBtn) {
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const docId = e.currentTarget.dataset.docid;
        if (!docId) { alert("Cannot delete: document ID missing."); return; }
        if (!confirm(`Permanently delete ${s.name || "this student"}'s session? This cannot be undone.`)) return;
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Deleting…";
        try {
          await fbDb.collection("completedSessions").doc(docId).delete();
          _adminSessions = _adminSessions.filter(x => x._docId !== docId);
          document.getElementById("admTotalCount").textContent    = _adminSessions.length;
          document.getElementById("admCompleteCount").textContent = _adminSessions.filter(x => x.reportData?.streamRecommendation).length;
          document.getElementById("admSciCount").textContent      = _adminSessions.filter(x => (x.reportData?.streamRecommendation||"").toLowerCase().includes("science")).length;
          renderAdminGrid(getCurrentFilter(), getCurrentSearch());
        } catch(err) {
          console.error("Delete session error:", err);
          e.currentTarget.disabled = false;
          e.currentTarget.textContent = "✕ Delete";
        }
      });
    }

    if (hasReport) {
      card.addEventListener("click", () => openStudentReport(s));
    }
    grid.appendChild(card);
  });
}

function openStudentReport(session) {
  S.name       = session.name;
  S.age        = session.age;
  S.phone      = session.phone;
  S.email      = session.email;
  S.city       = session.city;
  S.scores     = { ...session.scores };
  S.ranked     = [...session.ranked];
  S.pool       = JSON.parse(JSON.stringify(session.pool || []));
  S.reportData = JSON.parse(JSON.stringify(session.reportData || {}));

  document.getElementById("adminDashboard").classList.add("hidden");
  const dash = document.getElementById("dashboard");
  dash.classList.remove("hidden");
  dash.style.opacity = "0"; dash.style.transition = "opacity 0.35s";
  requestAnimationFrame(() => { dash.style.opacity = "1"; });

  document.getElementById("dsStudentName").textContent = S.name + (S.city ? ` · ${S.city}` : "");
  document.getElementById("dashLoading").style.display = "none";
  renderDashboard(S.reportData);

  // Admin view: show Back to Dashboard, hide New Session
  const btnBackAdmin = document.getElementById("btnBackAdmin");
  const btnRestart   = document.getElementById("btnRestart");
  if (btnBackAdmin) btnBackAdmin.classList.remove("hidden");
  if (btnRestart)   btnRestart.classList.add("hidden");

  if (btnBackAdmin) {
    btnBackAdmin.onclick = () => {
      dash.classList.add("hidden");
      btnBackAdmin.classList.add("hidden");
      if (btnRestart) btnRestart.classList.remove("hidden");
      document.getElementById("adminDashboard").classList.remove("hidden");
      renderAdminDashboard();
    };
  }
}