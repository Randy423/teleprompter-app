/* ─────────────────────────────────────────
   DOM REFERENCES
───────────────────────────────────────── */

// Screens
const editorScreen   = document.getElementById('editor-screen');
const displayScreen  = document.getElementById('display-screen');
const playbackScreen = document.getElementById('playback-screen');

// Editor controls
const scriptInput        = document.getElementById('script-input');
const qualitySelect      = document.getElementById('quality-select');
const speedSlider        = document.getElementById('speed-slider');
const fontSlider         = document.getElementById('font-slider');
const opacityInitSlider  = document.getElementById('opacity-init-slider');
const speedVal           = document.getElementById('speed-val');
const fontVal            = document.getElementById('font-val');
const opacityInitVal     = document.getElementById('opacity-init-val');
const startBtn           = document.getElementById('start-btn');

// Display screen elements
const scrollContent  = document.getElementById('scroll-content');
const progressBar    = document.getElementById('progress-bar');
const cameraFeed     = document.getElementById('camera-feed');
const recBadge       = document.getElementById('rec-badge');
const recTimer       = document.getElementById('rec-timer');
const playPauseBtn   = document.getElementById('play-pause-btn');
const resetBtn       = document.getElementById('reset-btn');
const stopRecBtn     = document.getElementById('stop-rec-btn');
const editBtn        = document.getElementById('edit-btn');
const liveSpeed      = document.getElementById('live-speed');
const speedReadout   = document.getElementById('speed-readout');
const opacitySlider  = document.getElementById('opacity-slider');
const opacityReadout = document.getElementById('opacity-readout');
const voiceToggleBtn = document.getElementById('voice-toggle-btn');
const fontLiveSlider = document.getElementById('font-live-slider');
const fontLiveReadout= document.getElementById('font-live-readout');

// Playback screen elements
const playbackVideo        = document.getElementById('playback-video');
const playbackQualityBadge = document.getElementById('playback-quality-badge');
const playbackDuration     = document.getElementById('playback-duration');
const downloadBtn          = document.getElementById('download-btn');
const recordAgainBtn       = document.getElementById('record-again-btn');
const discardBtn           = document.getElementById('discard-btn');


/* ─────────────────────────────────────────
   STATE
───────────────────────────────────────── */
let isPlaying        = false;
let position         = 0;
let rafId            = null;
let speed            = 3;

let cameraStream     = null;
let mediaRecorder    = null;
let recordedChunks   = [];
let currentBlobUrl   = null;
let currentQuality   = '720p';

let recStartTime     = null;
let recTimerInterval = null;


/* ─────────────────────────────────────────
   SCREEN HELPER
───────────────────────────────────────── */
function showScreen(screen) {
  [editorScreen, displayScreen, playbackScreen].forEach(s =>
    s.classList.remove('active')
  );
  screen.classList.add('active');
}


/* ─────────────────────────────────────────
   SCROLL ENGINE  (used when voice OFF)
───────────────────────────────────────── */
function animate() {
  if (!isPlaying) return;

  position += speed * 0.5;
  scrollContent.style.transform = `translateY(-${position}px)`;

  const maxScroll =
    scrollContent.offsetHeight -
    scrollContent.parentElement.offsetHeight;

  progressBar.style.width = Math.min((position / maxScroll) * 100, 100) + '%';

  if (position >= maxScroll) { pause(); return; }

  rafId = requestAnimationFrame(animate);
}

function play() {
  isPlaying = true;
  playPauseBtn.textContent = 'Pause';
  rafId = requestAnimationFrame(animate);
}

function pause() {
  isPlaying = false;
  playPauseBtn.textContent = 'Play';
  cancelAnimationFrame(rafId);
}

function reset() {
  pause();
  position = 0;
  scrollContent.style.transform = 'translateY(0)';
  progressBar.style.width = '0%';
  // also reset karaoke pointer if active
  if (voiceScrollActive) resetKaraoke();
}


/* ─────────────────────────────────────────
   SPEED — single source of truth
───────────────────────────────────────── */
function setSpeed(val) {
  speed = Math.min(10, Math.max(1, Math.round(val)));
  liveSpeed.value          = speed;
  speedSlider.value        = speed;
  speedReadout.textContent = speed;
  speedVal.textContent     = speed;
}

function setFontSize(val) {
  const size = Math.min(100, Math.max(20, Math.round(val)));
  document.documentElement.style.setProperty('--font-size', size + 'px');
  fontSlider.value         = size;
  fontLiveSlider.value     = size;
  fontVal.textContent      = size + 'px';
  fontLiveReadout.textContent = size + 'px';
}


/* ─────────────────────────────────────────
   KARAOKE / VOICE SCROLL  (fixed)
   Key design decisions:
   - Final results only advance the committed pointer
   - Interim results drive a speculative "preview" highlight
     without moving the real pointer — wrong guesses don't corrupt position
   - Fuzzy edit-distance matching handles misheard words
   - Recognition restarts without a gap using a flag instead of onend loop
───────────────────────────────────────── */

let voiceScrollActive  = false;
let recognition        = null;
let wordSpans          = [];
let wordPointer        = 0;       // committed position — only final results move this
let speculativeIdx     = -1;      // index of the current speculative (interim) highlight
let lastCommitted      = -1;      // last span index confirmed by a FINAL result


// ── Build word spans ─────────────────────
function buildWordSpans(text) {
  scrollContent.innerHTML = '';
  wordSpans = [];
  text.trim().split(/\s+/).forEach((raw, i) => {
    const span = document.createElement('span');
    span.textContent = raw + ' ';
    span.dataset.index = i;
    span.className = 'word-span';
    scrollContent.appendChild(span);
    wordSpans.push(span);
  });
}


// ── Normalise a word for comparison ─────
// Strips punctuation and lowercases.
function normalise(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}


// ── Levenshtein edit distance ────────────
// Returns the number of single-character edits needed to turn a into b.
// We use this to match "threw" → "through", "there" → "their", etc.
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}


// ── Fuzzy word match ─────────────────────
// Returns true if spoken word is close enough to the script word.
// Short words (≤4 chars) must match exactly — avoids "a" matching "I", etc.
// Longer words allow 1 edit — catches common mishearings.
function fuzzyMatch(spoken, script) {
  if (spoken === script) return true;
  if (spoken.length <= 4 || script.length <= 4) return false;
  return editDistance(spoken, script) <= 1;
}


// ── Highlight a span ────────────────────
// mode: 'speculative' = interim green glow (no pointer move)
//       'committed'   = final confirmed match (dims previous words)
function highlightSpan(index, mode) {
  if (index < 0 || index >= wordSpans.length) return;
  const span = wordSpans[index];

  if (mode === 'committed') {
    // Dim all words up to this index
    for (let i = lastCommitted + 1; i < index; i++) {
      wordSpans[i].classList.remove('word-current', 'word-speculative');
      wordSpans[i].classList.add('word-spoken');
    }
    span.classList.remove('word-speculative', 'word-spoken');
    span.classList.add('word-current');
    lastCommitted = index;

    // Instant scroll for committed words — 'smooth' causes lag on fast speech
    span.scrollIntoView({ behavior: 'instant', block: 'center' });
    progressBar.style.width = ((index / wordSpans.length) * 100) + '%';

  } else {
    // Clear previous speculative highlight
    if (speculativeIdx >= 0 && speculativeIdx !== index) {
      wordSpans[speculativeIdx].classList.remove('word-speculative');
    }
    span.classList.add('word-speculative');
    speculativeIdx = index;

    // Smooth scroll for speculative — feels natural while speaking
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}


// ── Reset karaoke state ──────────────────
function resetKaraoke() {
  wordPointer   = 0;
  speculativeIdx = -1;
  lastCommitted  = -1;
  wordSpans.forEach(s =>
    s.classList.remove('word-current', 'word-spoken', 'word-speculative')
  );
  progressBar.style.width = '0%';
  if (wordSpans[0]) wordSpans[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}


// ── Find the best matching script word index ─
// Scans forward from startIdx up to WINDOW words.
// Returns the index of the best match or -1 if none found.
// Using a tighter window (2) prevents jumping ahead on mismatches.
function findMatch(spokenWord, startIdx) {
  const WINDOW = 2;
  for (let offset = 0; offset < WINDOW; offset++) {
    const idx = startIdx + offset;
    if (idx >= wordSpans.length) break;
    if (fuzzyMatch(spokenWord, normalise(wordSpans[idx].textContent))) {
      return idx;
    }
  }
  return -1;
}


// ── Process a single batch of spoken words ──
// isFinal: true  → advance committed pointer, highlight definitively
// isFinal: false → speculative highlight only, don't move pointer
function processWords(spokenText, isFinal) {
  if (!voiceScrollActive || wordPointer >= wordSpans.length) return;

  const words = spokenText.trim().split(/\s+/).map(normalise).filter(Boolean);
  if (words.length === 0) return;

  if (isFinal) {
    // Walk through each spoken word and advance the committed pointer
    words.forEach(spoken => {
      if (wordPointer >= wordSpans.length) return;
      const matchIdx = findMatch(spoken, wordPointer);
      if (matchIdx !== -1) {
        highlightSpan(matchIdx, 'committed');
        wordPointer = matchIdx + 1;
      }
    });

  } else {
    // Interim: just speculatively highlight the LAST spoken word
    // (the last word is the most recently spoken, therefore most relevant)
    const lastSpoken = words[words.length - 1];
    const matchIdx = findMatch(lastSpoken, wordPointer);
    if (matchIdx !== -1) {
      highlightSpan(matchIdx, 'speculative');
    }
  }
}


// ── SpeechRecognition setup ──────────────
function startVoiceControl() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert('Voice control requires Chrome or Edge.\nIt is not supported in this browser.');
    voiceScrollActive = false;
    updateVoiceBtn();
    return;
  }

  function createRecognition() {
    const r = new SR();
    r.continuous      = true;
    r.interimResults  = true;
    r.lang            = 'en-US';
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result     = event.results[i];
        const transcript = result[0].transcript;
        const isFinal    = result.isFinal;
        // Only process each result once — use resultIndex to avoid reprocessing
        processWords(transcript, isFinal);
      }
    };

    r.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('SpeechRecognition error:', event.error);
    };

    // When recognition ends naturally (e.g. browser timeout after silence),
    // restart it immediately WITHOUT creating a new object — avoids the gap
    // that caused words to be missed in the old restart approach.
    r.onend = () => {
      if (!voiceScrollActive) return;
      try { r.start(); } catch {}
    };

    return r;
  }

  recognition = createRecognition();
  recognition.start();
}


// ── Stop recognition ─────────────────────
function stopVoiceControl() {
  if (recognition) {
    recognition.onend = null;  // prevent auto-restart
    recognition.abort();       // abort() is faster and cleaner than stop()
    recognition = null;
  }
}





// ── Toggle voice mode ────────────────────
function updateVoiceBtn() {
  if (voiceToggleBtn) {
    voiceToggleBtn.textContent = voiceScrollActive
      ? 'Voice: ON'
      : 'Voice: OFF';
    voiceToggleBtn.classList.toggle('voice-active', voiceScrollActive);
  }
}

function enableVoiceMode() {
  voiceScrollActive = true;
  updateVoiceBtn();

  // Switch scroll-content from plain text to word spans
  const currentText = scrollContent.textContent.trim();
  if (currentText) buildWordSpans(currentText);

  // voice-mode class switches overflow so scrollIntoView works
  document.getElementById('scroll-container').classList.add('voice-mode');

  // Disable the rAF scroll — voice drives position instead
  pause();
  playPauseBtn.disabled = true;

  startVoiceControl();
}

function disableVoiceMode() {
  voiceScrollActive = false;
  updateVoiceBtn();
  stopVoiceControl();

  document.getElementById('scroll-container').classList.remove('voice-mode');

  // Restore plain text so rAF scroll works normally
  const plainText = wordSpans.map(s => s.textContent).join('').trim();
  scrollContent.innerHTML = '';
  scrollContent.textContent = plainText;
  wordSpans = [];
  lastHighlighted = null;
  wordPointer = 0;

  playPauseBtn.disabled = false;
  // Resume auto-scroll from where we left off
  play();
}

if (voiceToggleBtn) {
  voiceToggleBtn.addEventListener('click', () => {
    if (voiceScrollActive) {
      disableVoiceMode();
    } else {
      enableVoiceMode();
    }
  });
}


/* ─────────────────────────────────────────
   CAMERA
───────────────────────────────────────── */
const qualityMap = {
  '480p':  { width: 854,  height: 480  },
  '720p':  { width: 1280, height: 720  },
  '1080p': { width: 1920, height: 1080 },
};

async function startCamera(quality = '720p') {
  const res = qualityMap[quality] || qualityMap['720p'];

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:      { ideal: res.width  },
        height:     { ideal: res.height },
        frameRate:  { ideal: 30 },
        facingMode: 'user',
      },
      audio: true,
    });
    cameraFeed.srcObject = cameraStream;

  } catch (err) {
    handleCameraError(err);
    throw err;
  }
}

function handleCameraError(err) {
  let msg = 'Camera error: ' + err.message;
  if (err.name === 'NotAllowedError') {
    msg = 'Camera permission was denied.\nPlease allow camera access in your browser settings and try again.';
  } else if (err.name === 'NotFoundError') {
    msg = 'No camera was found on this device.';
  } else if (err.name === 'NotReadableError') {
    msg = 'Your camera is already in use by another application.';
  }
  alert(msg);
  showScreen(editorScreen);
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
  cameraFeed.srcObject = null;
}


/* ─────────────────────────────────────────
   RECORDING ENGINE
───────────────────────────────────────── */
function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function startRecording() {
  if (!cameraStream) return;
  recordedChunks = [];

  const mimeType = getSupportedMimeType();
  const options  = mimeType ? { mimeType } : {};

  try {
    mediaRecorder = new MediaRecorder(cameraStream, options);
  } catch (err) {
    alert('Recording is not supported in this browser.\n' + err.message);
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };

  mediaRecorder.onstop = () => {
    stopRecTimer();
    buildPlaybackScreen();
  };

  mediaRecorder.start(250);
  startRecTimer();
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
}

function buildPlaybackScreen() {
  const mimeType = mediaRecorder.mimeType || 'video/webm';
  const blob     = new Blob(recordedChunks, { type: mimeType });

  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(blob);

  playbackVideo.src = currentBlobUrl;
  playbackQualityBadge.textContent = currentQuality;
  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
  const format = mimeType.includes('mp4') ? 'MP4' : 'WebM';
  playbackDuration.textContent = `${sizeMB} MB · ${format}`;

  stopCamera();
  showScreen(playbackScreen);
}


/* ─────────────────────────────────────────
   RECORDING TIMER
───────────────────────────────────────── */
function startRecTimer() {
  recStartTime = Date.now();
  recBadge.classList.add('active');
  recTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    recTimer.textContent = `REC ${mm}:${ss}`;
  }, 1000);
}

function stopRecTimer() {
  clearInterval(recTimerInterval);
  recTimerInterval = null;
  recBadge.classList.remove('active');
  recTimer.textContent = 'REC 00:00';
}


/* ─────────────────────────────────────────
   DOWNLOAD HELPER
───────────────────────────────────────── */
function downloadRecording() {
  if (!currentBlobUrl) return;
  const mimeType  = mediaRecorder ? mediaRecorder.mimeType : 'video/webm';
  const ext       = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `teleprompter-${currentQuality}-${timestamp}.${ext}`;
  const a    = document.createElement('a');
  a.href     = currentBlobUrl;
  a.download = filename;
  a.click();
}


/* ─────────────────────────────────────────
   BUTTON LISTENERS — EDITOR
───────────────────────────────────────── */
startBtn.addEventListener('click', async () => {
  const text = scriptInput.value.trim();
  if (!text) {
    alert('Please enter a script before starting.');
    return;
  }

  currentQuality = qualitySelect.value;

  // Always start with plain text; voice mode will convert to spans if enabled
  scrollContent.textContent = text;

  showScreen(displayScreen);

  try {
    await startCamera(currentQuality);
  } catch {
    return;
  }

  reset();
  play();
  startRecording();
  setFontSize(fontSlider.value);
});


/* ─────────────────────────────────────────
   BUTTON LISTENERS — DISPLAY
───────────────────────────────────────── */
playPauseBtn.addEventListener('click', () => {
  isPlaying ? pause() : play();
});

resetBtn.addEventListener('click', reset);

stopRecBtn.addEventListener('click', () => {
  pause();
  if (voiceScrollActive) stopVoiceControl();
  stopRecording();
});

editBtn.addEventListener('click', () => {
  pause();
  stopRecTimer();
  if (voiceScrollActive) {
    voiceScrollActive = false;
    stopVoiceControl();
    updateVoiceBtn();
    playPauseBtn.disabled = false;
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }

  stopCamera();
  showScreen(editorScreen);
});


/* ─────────────────────────────────────────
   BUTTON LISTENERS — PLAYBACK
───────────────────────────────────────── */
downloadBtn.addEventListener('click', downloadRecording);

recordAgainBtn.addEventListener('click', async () => {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  playbackVideo.src = '';
  showScreen(displayScreen);

  try {
    await startCamera(currentQuality);
  } catch {
    return;
  }

  reset();
  play();
  startRecording();
});

discardBtn.addEventListener('click', () => {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  playbackVideo.src = '';
  showScreen(editorScreen);
});


/* ─────────────────────────────────────────
   SLIDER LISTENERS — EDITOR
───────────────────────────────────────── */
speedSlider.addEventListener('input', () => {
  setSpeed(parseFloat(speedSlider.value));
});

fontSlider.addEventListener('input', () => {
  setFontSize(parseFloat(fontSlider.value));
});

opacityInitSlider.addEventListener('input', () => {
  const pct = opacityInitSlider.value;
  document.documentElement.style.setProperty('--text-opacity', pct / 100);
  opacityInitVal.textContent = pct + '%';
  opacitySlider.value = pct;
  opacityReadout.textContent = pct + '%';
});


/* ─────────────────────────────────────────
   SLIDER LISTENERS — DISPLAY
───────────────────────────────────────── */
liveSpeed.addEventListener('input', () => {
  setSpeed(parseFloat(liveSpeed.value));
});

opacitySlider.addEventListener('input', () => {
  const pct = opacitySlider.value;
  document.documentElement.style.setProperty('--text-opacity', pct / 100);
  opacityReadout.textContent = pct + '%';
  opacityInitSlider.value = pct;
  opacityInitVal.textContent = pct + '%';
});

fontLiveSlider.addEventListener('input', () => {
  setFontSize(parseFloat(fontLiveSlider.value));
});


/* ─────────────────────────────────────────
   KEYBOARD SHORTCUTS
───────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (!displayScreen.classList.contains('active')) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (!voiceScrollActive) isPlaying ? pause() : play();
      break;
    case 'ArrowUp':
      e.preventDefault();
      setSpeed(speed + 1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setSpeed(speed - 1);
      break;
    case 'r':
    case 'R':
      reset();
      break;
    case 'Escape':
      editBtn.click();
      break;
  }
});


/* ─────────────────────────────────────────
   INIT
───────────────────────────────────────── */
(function init() {
  speedVal.textContent       = speedSlider.value;
  fontVal.textContent        = fontSlider.value + 'px';
  opacityInitVal.textContent = opacityInitSlider.value + '%';
  document.documentElement.style.setProperty('--font-size', fontSlider.value + 'px');
  document.documentElement.style.setProperty('--text-opacity', opacityInitSlider.value / 100);
})();


/* ─────────────────────────────────────────
   SAVED SCRIPTS  (localStorage)
───────────────────────────────────────── */
const STORAGE_KEY = 'teleprompter_scripts';

const savedScriptsBtn  = document.getElementById('saved-scripts-btn');
const scriptsPanel     = document.getElementById('scripts-panel');
const closePanelBtn    = document.getElementById('close-panel-btn');
const panelBackdrop    = document.getElementById('panel-backdrop');
const scriptsList      = document.getElementById('scripts-list');
const scriptsEmpty     = document.getElementById('scripts-empty');
const saveScriptBtn    = document.getElementById('save-script-btn');
const scriptNameInput  = document.getElementById('script-name-input');

function loadScripts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function persistScripts(scripts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
}

function saveScript(text, name) {
  if (!text.trim()) {
    alert('There is no script to save. Please write something first.');
    return;
  }
  const finalName = name.trim() ||
    text.trim().split(/\s+/).slice(0, 5).join(' ') + '…';

  const scripts = loadScripts();
  scripts.unshift({
    id:      Date.now(),
    name:    finalName,
    text:    text.trim(),
    savedAt: new Date().toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric'
    }),
  });
  persistScripts(scripts);
  renderScriptsList();

  saveScriptBtn.textContent = 'Saved!';
  saveScriptBtn.classList.add('saved');
  setTimeout(() => {
    saveScriptBtn.textContent = 'Save script';
    saveScriptBtn.classList.remove('saved');
  }, 1800);
  scriptNameInput.value = '';
}

function deleteScript(id) {
  persistScripts(loadScripts().filter(s => s.id !== id));
  renderScriptsList();
}

function loadScript(text) {
  scriptInput.value = text;
  closePanel();
  scriptInput.scrollTop = 0;
}

function renderScriptsList() {
  const scripts = loadScripts();
  scriptsList.innerHTML = '';

  if (scripts.length === 0) {
    scriptsEmpty.classList.add('visible');
    return;
  }
  scriptsEmpty.classList.remove('visible');

  scripts.forEach(script => {
    const card = document.createElement('div');
    card.className = 'script-card';
    const preview = script.text.length > 80
      ? script.text.slice(0, 80) + '…'
      : script.text;

    card.innerHTML = `
      <div class="script-card-body">
        <div class="script-card-name">${escapeHtml(script.name)}</div>
        <div class="script-card-preview">${escapeHtml(preview)}</div>
      </div>
      <span class="script-card-date">${script.savedAt}</span>
      <div class="script-card-actions">
        <button class="script-load-btn" data-id="${script.id}">Load</button>
        <button class="script-delete-btn" data-id="${script.id}" title="Delete">✕</button>
      </div>
    `;

    card.querySelector('.script-load-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      loadScript(script.text);
    });
    card.querySelector('.script-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${script.name}"?`)) deleteScript(script.id);
    });
    card.addEventListener('click', () => loadScript(script.text));
    scriptsList.appendChild(card);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openPanel() {
  renderScriptsList();
  scriptsPanel.classList.add('open');
  panelBackdrop.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closePanel() {
  scriptsPanel.classList.remove('open');
  panelBackdrop.classList.remove('visible');
  document.body.style.overflow = '';
}

savedScriptsBtn.addEventListener('click', openPanel);
closePanelBtn.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);
saveScriptBtn.addEventListener('click', () => saveScript(scriptInput.value, scriptNameInput.value));
scriptInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveScript(scriptInput.value, scriptNameInput.value);
  }
});