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
let currentBlob      = null;   // the raw Blob — kept in memory for download
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
   MANUAL SCROLL (wheel + touch drag)
   Works whether playing, paused, or in voice mode.
   User can nudge the text up/down at any time.
───────────────────────────────────────── */

// How many pixels to move per wheel tick / touch pixel
const SCROLL_SENSITIVITY = 1.2;
let touchStartY = 0;

function applyManualScroll(deltaPx) {
  if (voiceScrollActive) {
    // In voice mode, update the transform directly — same as highlightAt() does
    const container = document.getElementById('scroll-container');
    const maxScroll = scrollContent.offsetHeight - container.clientHeight;
    position = Math.max(0, Math.min(maxScroll, position + deltaPx));
    scrollContent.style.transform = `translateY(-${position}px)`;
    progressBar.style.width = maxScroll > 0
      ? Math.min((position / maxScroll) * 100, 100) + '%'
      : '0%';
  } else {
    // In normal mode, update position — rAF loop picks it up automatically
    const maxScroll =
      scrollContent.offsetHeight -
      scrollContent.parentElement.offsetHeight;
    position = Math.max(0, Math.min(maxScroll, position + deltaPx));
    scrollContent.style.transform = `translateY(-${position}px)`;
    progressBar.style.width = maxScroll > 0
      ? Math.min((position / maxScroll) * 100, 100) + '%'
      : '0%';
  }
}

// Mouse wheel / trackpad scroll
document.getElementById('camera-view').addEventListener('wheel', (e) => {
  e.preventDefault();
  applyManualScroll(e.deltaY * SCROLL_SENSITIVITY);
}, { passive: false });

// Touch drag (mobile)
document.getElementById('camera-view').addEventListener('touchstart', (e) => {
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.getElementById('camera-view').addEventListener('touchmove', (e) => {
  e.preventDefault();
  const delta = (touchStartY - e.touches[0].clientY) * SCROLL_SENSITIVITY;
  touchStartY = e.touches[0].clientY;
  applyManualScroll(delta);
}, { passive: false });


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
   VOICE-PACED WORD HIGHLIGHTER

   Approach: volume detection, not speech recognition.
   - Web Audio AnalyserNode samples mic volume at 60fps.
   - Speaking  -> advance word highlight at a steady pace.
   - Silence   -> pause on the current word, wait.
   - No word matching, no SpeechRecognition, no lag.
   - Speed slider controls how fast words advance.
   - Scrolling via direct translateY (GPU, zero reflow).
───────────────────────────────────────── */

let voiceScrollActive = false;
let wordSpans         = [];
let wordIndex         = 0;
let voiceRafId        = null;
let audioCtx          = null;
let analyserNode      = null;
let micSource         = null;
let freqData          = null;
let wordStartTime     = 0;

// Volume threshold (0-255). Values below this = silence.
// 18 filters breath, keyboard, room hum without cutting off soft voices.
// Users can speak at normal volume — no need to project loudly.
const SILENCE_THRESHOLD = 18;

// How long to stay on each word while the user is speaking.
// Speed 1  = 400ms per word (very slow, matches deliberate speech)
// Speed 10 =  80ms per word (fast, matches rapid delivery)
function msPerWord() {
  return Math.round(400 - (speed - 1) * (320 / 9));
}


// ── Build word spans ─────────────────────
function buildWordSpans(text) {
  scrollContent.innerHTML = '';
  wordSpans = [];
  text.trim().split(/\s+/).forEach(raw => {
    const span = document.createElement('span');
    span.textContent = raw + ' ';
    span.className = 'word-span';
    scrollContent.appendChild(span);
    wordSpans.push(span);
  });
}


// ── Highlight word at index, scroll to it ─
function highlightAt(index) {
  if (index < 0 || index >= wordSpans.length) return;

  if (index > 0) {
    wordSpans[index - 1].classList.remove('word-current');
    wordSpans[index - 1].classList.add('word-spoken');
  }
  wordSpans[index].classList.remove('word-spoken');
  wordSpans[index].classList.add('word-current');

  // Scroll so word sits 38% down the container. Pure GPU transform.
  const container = document.getElementById('scroll-container');
  const target = Math.max(0, wordSpans[index].offsetTop - container.clientHeight * 0.30);
  scrollContent.style.transform = 'translateY(-' + target + 'px)';
  position = target;

  progressBar.style.width = ((index / wordSpans.length) * 100) + '%';
}


// ── Is the user currently speaking? ──────
function isSpeaking() {
  if (!analyserNode || !freqData) return false;
  analyserNode.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  return (sum / freqData.length) > SILENCE_THRESHOLD;
}


// ── The voice ticker (runs at 60fps via rAF) ─
// Each frame checks the mic.
// Speaking  + enough time elapsed -> advance word.
// Silence   -> hold current word, don't reset timer.
// This means the user can pause mid-sentence and resume exactly where they left off.
function voiceTick(timestamp) {
  if (!voiceScrollActive) return;

  if (isSpeaking() && wordIndex < wordSpans.length) {
    if (timestamp - wordStartTime >= msPerWord()) {
      highlightAt(wordIndex);
      wordIndex++;
      wordStartTime = timestamp;
    }
  }
  // When silent: don't reset wordStartTime.
  // When speaking resumes, elapsed picks up from where the timer was.

  voiceRafId = requestAnimationFrame(voiceTick);
}


// ── Reset voice highlight state ──────────
function resetKaraoke() {
  wordIndex     = 0;
  wordStartTime = 0;
  wordSpans.forEach(s => s.classList.remove('word-current', 'word-spoken'));
  scrollContent.style.transform = 'translateY(0)';
  position = 0;
  progressBar.style.width = '0%';
}


// ── Wire up Web Audio from the camera stream ─
// Taps the existing cameraStream audio track.
// No extra mic permission needed.
function setupAudio() {
  if (!cameraStream) return;
  try {
    audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    freqData     = new Uint8Array(analyserNode.frequencyBinCount);
    micSource    = audioCtx.createMediaStreamSource(cameraStream);
    micSource.connect(analyserNode);
    // NOT connected to destination — prevents mic echo in recording
  } catch (e) {
    console.warn('Web Audio setup failed:', e);
  }
}


// ── Tear down Web Audio ──────────────────
function teardownAudio() {
  try { if (micSource)    micSource.disconnect(); }    catch {}
  try { if (analyserNode) analyserNode.disconnect(); } catch {}
  try { if (audioCtx)     audioCtx.close(); }          catch {}
  micSource = analyserNode = audioCtx = freqData = null;
}


// ── Stop voice control cleanly ───────────
function stopVoiceControl() {
  cancelAnimationFrame(voiceRafId);
  voiceRafId = null;
  teardownAudio();
}


/* ─────────────────────────────────────────
   VOICE MODE TOGGLE
───────────────────────────────────────── */

function updateVoiceBtn() {
  if (!voiceToggleBtn) return;
  voiceToggleBtn.textContent = voiceScrollActive ? 'Voice: ON' : 'Voice: OFF';
  voiceToggleBtn.classList.toggle('voice-active', voiceScrollActive);
}

function enableVoiceMode() {
  voiceScrollActive = true;
  updateVoiceBtn();

  // Convert the plain text into individual word spans
  const text = scrollContent.textContent.trim();
  if (text) buildWordSpans(text);

  // Switch container to voice-mode CSS (overflow hidden, GPU scroll)
  document.getElementById('scroll-container').classList.add('voice-mode');

  // Disable manual play/pause — voice drives scrolling now
  pause();
  playPauseBtn.disabled = true;

  // Tap the mic via Web Audio (uses existing cameraStream, no new permission)
  setupAudio();

  // Start the ticker — kicks off at the next rAF frame
  wordIndex     = 0;
  wordStartTime = 0;
  voiceRafId = requestAnimationFrame(voiceTick);
}

function disableVoiceMode() {
  voiceScrollActive = false;
  updateVoiceBtn();

  stopVoiceControl();

  document.getElementById('scroll-container').classList.remove('voice-mode');

  // Restore plain text so the rAF scroll engine can take over again
  const plainText = wordSpans.map(s => s.textContent).join('').trim();
  scrollContent.innerHTML = '';
  scrollContent.textContent = plainText;
  wordSpans = [];
  wordIndex = 0;

  playPauseBtn.disabled = false;
  // Resume normal auto-scroll from current position
  play();
}

if (voiceToggleBtn) {
  voiceToggleBtn.addEventListener('click', () => {
    voiceScrollActive ? disableVoiceMode() : enableVoiceMode();
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
  // Store the blob itself in memory so it survives navigation and can be
  // downloaded on demand. We no longer auto-save — only save on Download click.
  currentBlob    = new Blob(recordedChunks, { type: mimeType });

  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(currentBlob);

  playbackVideo.src = currentBlobUrl;
  playbackQualityBadge.textContent = currentQuality;
  const sizeMB = (currentBlob.size / (1024 * 1024)).toFixed(1);
  const format = mimeType.includes('mp4') ? 'MP4' : 'WebM';
  playbackDuration.textContent = `${sizeMB} MB · ${format}`;

  // NOTE: we do NOT save here — only saved when user clicks Download
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
// ── Generate a filename for the current recording ──
function currentRecordingFilename() {
  const mimeType  = mediaRecorder ? mediaRecorder.mimeType : 'video/webm';
  const ext       = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return { filename: `teleprompter-${currentQuality}-${timestamp}.${ext}`, mimeType };
}

// ── Save the current recording to the in-memory store (idempotent) ──
// Safe to call multiple times — duplicate filenames are blocked inside saveRecordingToPage.
function saveCurrentRecording() {
  if (!currentBlob) return;
  const { filename, mimeType } = currentRecordingFilename();
  const sizeMB = (currentBlob.size / (1024 * 1024)).toFixed(1);
  saveRecordingToPage(currentBlob, currentQuality, sizeMB, mimeType, filename);
  return filename;
}

// ── Download the current recording to disk ──
function downloadRecording() {
  if (!currentBlobUrl || !currentBlob) return;
  const filename = saveCurrentRecording(); // also saves to recordings page
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
  // Discard this take — user explicitly wants to re-record
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  currentBlob       = null;
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
  currentBlob   = null;
  playbackVideo.src = '';
  navigateTo('home');
});

// "Back to home" — save recording to the store, then navigate
const homeBtn = document.getElementById('home-btn');
if (homeBtn) {
  homeBtn.addEventListener('click', () => {
    saveCurrentRecording();   // persists in recordings page
    navigateTo('home');
  });
}


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


/* ─────────────────────────────────────────
   HEADER / NAV / MODALS
───────────────────────────────────────── */

// ── Hamburger menu ───────────────────────
const hamburgerBtn = document.getElementById('hamburger-btn');
const mobileNav    = document.getElementById('mobile-nav');
if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    mobileNav.classList.toggle('open');
  });
}


// ── Premium modal ────────────────────────
const premiumBackdrop    = document.getElementById('premium-backdrop');
const premiumModal       = document.getElementById('premium-modal');
const premiumCloseBtn    = document.getElementById('premium-close-btn');
const premiumStartBtn    = document.getElementById('premium-start-trial-btn');
const premiumTrialActive = document.getElementById('premium-trial-active');
const premiumTrialMsg    = document.getElementById('premium-trial-msg');
const TRIAL_KEY          = 'promptflow_trial_start';

function openPremiumModal() {
  premiumBackdrop.classList.add('open');
  premiumModal.classList.add('open');
  document.body.style.overflow = 'hidden';
  updateTrialUI();
}

function closePremiumModal() {
  premiumBackdrop.classList.remove('open');
  premiumModal.classList.remove('open');
  document.body.style.overflow = '';
}

// Check trial status and update UI accordingly
function updateTrialUI() {
  const trialStart = localStorage.getItem(TRIAL_KEY);
  if (!trialStart) return;

  const elapsed     = Date.now() - parseInt(trialStart, 10);
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const remaining   = Math.ceil((threeDaysMs - elapsed) / (24 * 60 * 60 * 1000));

  if (elapsed < threeDaysMs) {
    // Trial still active
    premiumStartBtn.style.display    = 'none';
    premiumTrialActive.style.display = 'flex';
    premiumTrialMsg.textContent      =
      remaining === 1
        ? 'Trial active — 1 day remaining'
        : `Trial active — ${remaining} days remaining`;
  } else {
    // Trial expired
    premiumStartBtn.textContent      = 'Subscribe — $1.99 / month';
    premiumStartBtn.style.display    = 'block';
    premiumTrialActive.style.display = 'none';
  }
}

function isTrialActive() {
  const trialStart = localStorage.getItem(TRIAL_KEY);
  if (!trialStart) return false;
  const elapsed = Date.now() - parseInt(trialStart, 10);
  return elapsed < 3 * 24 * 60 * 60 * 1000;
}

premiumCloseBtn.addEventListener('click', closePremiumModal);
premiumBackdrop.addEventListener('click', closePremiumModal);

premiumStartBtn.addEventListener('click', () => {
  // Store trial start timestamp
  localStorage.setItem(TRIAL_KEY, Date.now().toString());
  updateTrialUI();
});

// Nav links that trigger premium modal
['nav-pricing', 'nav-pricing-mobile', 'footer-pricing-link'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', (e) => { e.preventDefault(); openPremiumModal(); });
});


// ── Sign-in modal ────────────────────────
const signinBackdrop  = document.getElementById('signin-backdrop');
const signinModal     = document.getElementById('signin-modal');
const signinCloseBtn  = document.getElementById('signin-close-btn');

function openSigninModal() {
  signinBackdrop.classList.add('open');
  signinModal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSigninModal() {
  signinBackdrop.classList.remove('open');
  signinModal.classList.remove('open');
  document.body.style.overflow = '';
}

signinCloseBtn.addEventListener('click', closeSigninModal);
signinBackdrop.addEventListener('click', closeSigninModal);

['signin-btn', 'signin-btn-mobile'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', openSigninModal);
});


// ── Voice button — gate behind premium ───
// Override the voice toggle to check trial first
const _origVoiceBtn = document.getElementById('voice-toggle-btn');
if (_origVoiceBtn) {
  // Remove previous listener by cloning
  const newVoiceBtn = _origVoiceBtn.cloneNode(true);
  _origVoiceBtn.parentNode.replaceChild(newVoiceBtn, _origVoiceBtn);

  newVoiceBtn.addEventListener('click', () => {
    if (!isTrialActive()) {
      // Not subscribed or trialled — show premium modal
      openPremiumModal();
      return;
    }
    // Trial active — toggle voice mode normally
    voiceScrollActive ? disableVoiceMode() : enableVoiceMode();
  });
}


// Nav listeners are handled in the PAGE NAVIGATION section below.


/* ─────────────────────────────────────────
   PAGE NAVIGATION
───────────────────────────────────────── */

const scriptsPage    = document.getElementById('scripts-page');
const recordingsPage = document.getElementById('recordings-page');

// All navigable pages
const pages = {
  home:       editorScreen,
  scripts:    scriptsPage,
  recordings: recordingsPage,
};

function navigateTo(page) {
  // Hide all screens
  [editorScreen, displayScreen, playbackScreen, scriptsPage, recordingsPage]
    .forEach(s => s && s.classList.remove('active'));

  const target = pages[page];
  if (target) target.classList.add('active');

  // Update nav active states
  document.querySelectorAll('.nav-link[data-page]').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });

  // Close mobile nav
  if (mobileNav) mobileNav.classList.remove('open');

  // Render page content
  if (page === 'scripts')    renderScriptsPage();
  if (page === 'recordings') renderRecordingsPage();

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Wire up all nav links
document.querySelectorAll('.nav-link[data-page]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const page = link.dataset.page;
    if (page === 'pricing') { openPremiumModal(); return; }
    navigateTo(page);
  });
});

// Logo / home link
document.getElementById('nav-home').addEventListener('click', (e) => {
  e.preventDefault();
  navigateTo('home');
});

// "New script" on scripts page → go to editor
document.getElementById('page-new-script-btn')
  .addEventListener('click', () => navigateTo('home'));

// "Go to editor" on recordings page
document.getElementById('page-goto-editor-btn')
  .addEventListener('click', () => navigateTo('home'));


/* ─────────────────────────────────────────
   SCRIPTS PAGE RENDERER
───────────────────────────────────────── */
function renderScriptsPage() {
  const list  = document.getElementById('page-scripts-list');
  const empty = document.getElementById('page-scripts-empty');
  const scripts = loadScripts();

  list.innerHTML = '';

  if (scripts.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  scripts.forEach(script => {
    const card = document.createElement('div');
    card.className = 'page-script-card';

    const preview = script.text.length > 100
      ? script.text.slice(0, 100) + '…'
      : script.text;

    card.innerHTML = `
      <div class="page-script-body">
        <p class="page-script-name">${escapeHtml(script.name)}</p>
        <p class="page-script-preview">${escapeHtml(preview)}</p>
      </div>
      <span class="page-script-date">${script.savedAt}</span>
      <div class="page-script-actions">
        <button class="page-load-btn">Load</button>
        <button class="page-delete-btn">✕</button>
      </div>
    `;

    card.querySelector('.page-load-btn').addEventListener('click', () => {
      scriptInput.value = script.text;
      navigateTo('home');
      scriptInput.scrollTop = 0;
    });

    card.querySelector('.page-delete-btn').addEventListener('click', () => {
      if (confirm(`Delete "${script.name}"?`)) {
        deleteScript(script.id);
        renderScriptsPage();
      }
    });

    list.appendChild(card);
  });
}


/* ─────────────────────────────────────────
   RECORDINGS PAGE RENDERER
   Recordings are stored in sessionStorage
   as {name, blobUrl, quality, size, date}
   They persist within the tab session.
───────────────────────────────────────── */
// In-memory store for recordings (Blob objects can't be serialised to sessionStorage)
const recordingsStore = [];

function saveRecordingToPage(blob, quality, sizeMB, mimeType, filename) {
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const ts  = new Date().toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  // Avoid duplicate saves if user clicks Download multiple times
  const isDupe = recordingsStore.some(r => r.filename === filename);
  if (isDupe) return;

  recordingsStore.unshift({
    id:       Date.now(),
    name:     `Recording — ${ts}`,
    blob,
    quality,
    size:     sizeMB,
    ext,
    filename,
    date:     ts,
  });
  // Cap at 20 recordings to avoid excessive memory use
  if (recordingsStore.length > 20) recordingsStore.pop();
}

function renderRecordingsPage() {
  const list  = document.getElementById('page-recordings-list');
  const empty = document.getElementById('page-recordings-empty');

  list.innerHTML = '';

  if (recordingsStore.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  recordingsStore.forEach(rec => {
    const card = document.createElement('div');
    card.className = 'page-recording-card';

    card.innerHTML = `
      <div class="page-rec-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round">
          <circle cx="9" cy="9" r="7"/>
          <circle cx="9" cy="9" r="3" fill="#4ade80" stroke="none"/>
        </svg>
      </div>
      <div class="page-rec-body">
        <p class="page-rec-name">${escapeHtml(rec.name)}</p>
        <p class="page-rec-meta">${rec.quality} · ${rec.size} MB · ${rec.ext.toUpperCase()}</p>
      </div>
      <button class="page-rec-download">Download</button>
    `;

    card.querySelector('.page-rec-download').addEventListener('click', () => {
      // Create a fresh object URL from the stored Blob — always works
      const url = URL.createObjectURL(rec.blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = rec.filename || `${rec.name}.${rec.ext}`;
      a.click();
      // Revoke shortly after — browser has queued the download by then
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    list.appendChild(card);
  });
}

// Recordings are registered inside buildPlaybackScreen above.


/* ─────────────────────────────────────────
   AI SCRIPT ASSISTANT
   Uses the Anthropic API directly from
   the browser via fetch. Each tool builds
   a targeted prompt and streams the result
   into the result panel.
───────────────────────────────────────── */

// ── State ─────────────────────────────────
let currentAiTool   = null;   // which tool is open
let lastAiPrompt    = null;   // stored for regenerate
let aiAbortCtrl     = null;   // AbortController for in-flight requests

// ── DOM refs ──────────────────────────────
const aiPanel       = document.getElementById('ai-panel');
const aiResultArea  = document.getElementById('ai-result-area');
const aiResultText  = document.getElementById('ai-result-text');
const aiLoading     = document.getElementById('ai-loading');
const aiLoadingMsg  = document.getElementById('ai-loading-msg');
const aiError       = document.getElementById('ai-error');
const aiErrorMsg    = document.getElementById('ai-error-msg');
const aiUseBtn      = document.getElementById('ai-use-btn');
const aiRetryBtn    = document.getElementById('ai-retry-btn');
const aiDiscardBtn  = document.getElementById('ai-discard-btn');


// ── Option button toggle (single select per group) ──
document.querySelectorAll('.ai-option-btns').forEach(group => {
  group.addEventListener('click', e => {
    const btn = e.target.closest('.ai-opt-btn');
    if (!btn) return;
    group.querySelectorAll('.ai-opt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});


// ── Tool button click → open panel ────────
document.querySelectorAll('.ai-tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;

    // If clicking same tool again → close panel
    if (currentAiTool === tool && aiPanel.style.display !== 'none') {
      closeAiPanel();
      return;
    }

    // Gate: must have active trial
    if (!isTrialActive()) {
      openPremiumModal();
      return;
    }

    // Show panel and correct view
    openAiTool(tool);
  });
});


function openAiTool(tool) {
  currentAiTool = tool;

  // Update toolbar button active states
  document.querySelectorAll('.ai-tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });

  // Show panel
  aiPanel.style.display = 'flex';

  // Hide all views, show the right one
  document.querySelectorAll('.ai-tool-view').forEach(v => v.style.display = 'none');
  const view = document.getElementById(`ai-view-${tool}`);
  if (view) view.style.display = 'flex';
  view.style.flexDirection = 'column';
  view.style.gap = '10px';

  // Reset result/loading/error
  hideAiStates();

  // Scroll panel into view smoothly
  aiPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}


function closeAiPanel() {
  currentAiTool = null;
  aiPanel.style.display = 'none';
  document.querySelectorAll('.ai-tool-btn').forEach(b => b.classList.remove('active'));
  if (aiAbortCtrl) { aiAbortCtrl.abort(); aiAbortCtrl = null; }
}


function hideAiStates() {
  aiResultArea.style.display = 'none';
  aiLoading.style.display    = 'none';
  aiError.style.display      = 'none';
}


// ── Get the selected option value from a group ──
function getOption(groupName) {
  const btn = document.querySelector(
    `.ai-option-btns[data-group="${groupName}"] .ai-opt-btn.active`
  );
  return btn ? btn.dataset.val : null;
}


// ── Build prompts for each tool ────────────

function buildPrompt(tool) {
  const script = document.getElementById('script-input').value.trim();

  switch (tool) {

    case 'write': {
      const topic  = document.getElementById('ai-topic-input').value.trim();
      const length = getOption('write-length') || '60s';
      const tone   = getOption('write-tone')   || 'conversational';
      if (!topic) return { error: 'Please enter a topic first.' };
      const durations = { '30s':'approximately 30 seconds (75 words)', '60s':'approximately 60 seconds (150 words)', '2min':'approximately 2 minutes (300 words)', '5min':'approximately 5 minutes (750 words)' };
      return {
        prompt: `Write a teleprompter script about the following topic.

Topic: ${topic}
Target duration: ${durations[length] || '60 seconds'}
Tone: ${tone}

Requirements:
- Write in first person as if the speaker is presenting directly to camera
- Use short, clear sentences that are easy to read aloud
- No markdown, no bullet points, no headers — plain flowing prose only
- Do not include any stage directions or cues
- Start speaking immediately, no preamble like "Hello everyone"
- The script should feel natural when read aloud at a moderate pace

Write only the script text, nothing else.`,
        loadingMsg: 'Writing your script...'
      };
    }

    case 'bullets': {
      const bullets = document.getElementById('ai-bullets-input').value.trim();
      const tone    = getOption('bullets-tone') || 'conversational';
      if (!bullets) return { error: 'Please paste your bullet points first.' };
      return {
        prompt: `Convert the following bullet points into a smooth, natural teleprompter script.

Bullet points:
${bullets}

Tone: ${tone}

Requirements:
- Expand each bullet point into natural spoken sentences
- Create smooth transitions between points
- Write in first person as if presenting to camera
- Plain prose only — no bullet points, headers, or markdown
- Short sentences that are easy to read aloud
- Do not add information that is not in the bullet points

Write only the script text, nothing else.`,
        loadingMsg: 'Expanding your bullet points...'
      };
    }

    case 'shorten': {
      if (!script) return { error: 'Please write a script in the editor first.' };
      const length = getOption('shorten-length') || '60s';
      const durations = { '30s':'30 seconds (about 75 words)', '60s':'60 seconds (about 150 words)', '90s':'90 seconds (about 225 words)', '2min':'2 minutes (about 300 words)' };
      return {
        prompt: `Shorten the following teleprompter script to fit in ${durations[length] || '60 seconds'}.

Original script:
${script}

Requirements:
- Keep the core message and most important points
- Remove repetition, filler phrases, and less important details
- Maintain the same tone and voice as the original
- Keep sentences short and easy to read aloud
- Plain prose only, no markdown
- Do not add any new content

Write only the shortened script, nothing else.`,
        loadingMsg: 'Shortening your script...'
      };
    }

    case 'tone': {
      if (!script) return { error: 'Please write a script in the editor first.' };
      const tone = getOption('tone-style') || 'conversational';
      const toneInstructions = {
        formal:          'Professional and authoritative. Use complete sentences. Avoid contractions and slang.',
        casual:          'Relaxed and friendly. Use contractions. Feel like you\'re talking to a friend.',
        persuasive:      'Compelling and motivating. Use rhetorical questions, strong calls to action, and emotive language.',
        inspirational:   'Uplifting and energising. Use vivid language, metaphors, and an optimistic tone.',
        conversational:  'Natural and warm, as if speaking directly to one person. Relatable and genuine.'
      };
      return {
        prompt: `Rewrite the following teleprompter script in a ${tone} tone.

Tone style: ${toneInstructions[tone] || tone}

Original script:
${script}

Requirements:
- Preserve the meaning and key points of the original
- Apply the tone consistently throughout
- Keep sentences short and natural to read aloud
- Plain prose only, no markdown or formatting
- Do not add or remove key information

Write only the rewritten script, nothing else.`,
        loadingMsg: `Rewriting in a ${tone} tone...`
      };
    }

    case 'clarity': {
      if (!script) return { error: 'Please write a script in the editor first.' };
      return {
        prompt: `Rewrite the following teleprompter script for maximum speaking clarity.

Original script:
${script}

Requirements:
- Break long sentences into shorter ones (aim for 15 words max per sentence)
- Replace complex words with simpler spoken alternatives
- Remove tongue-twisters and words that are hard to say quickly
- Add natural pause points by ending sentences more frequently
- Remove overly formal constructions that sound unnatural when spoken
- Preserve the meaning, tone, and key points exactly
- Plain prose only, no markdown

Write only the rewritten script, nothing else.`,
        loadingMsg: 'Rewriting for speaking clarity...'
      };
    }

    default:
      return { error: 'Unknown tool.' };
  }
}


// ── Run the AI request ─────────────────────
async function runAi(tool) {
  const { prompt, loadingMsg, error } = buildPrompt(tool);

  if (error) {
    showAiError(error);
    return;
  }

  lastAiPrompt = { tool, prompt, loadingMsg };

  // Show loading
  hideAiStates();
  aiLoading.style.display   = 'flex';
  aiLoadingMsg.textContent  = loadingMsg;

  // Disable run button
  const runBtn = document.querySelector(`#ai-view-${tool} .ai-run-btn`);
  if (runBtn) runBtn.disabled = true;

  // Abort any previous request
  if (aiAbortCtrl) aiAbortCtrl.abort();
  aiAbortCtrl = new AbortController();

  try {
    const response = await fetch('http://localhost:3000/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: aiAbortCtrl.signal,
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `API error ${response.status}`);
    }

    // Extract text from response
   const text = data.choices[0].message.content.trim();

    // Show result
    hideAiStates();
    aiResultText.textContent   = text;
    aiResultArea.style.display = 'block';

  } catch (err) {
    if (err.name === 'AbortError') return;
    hideAiStates();
    showAiError(err.message || 'Something went wrong. Please try again.');
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}


function showAiError(msg) {
  hideAiStates();
  aiError.style.display = 'flex';
  aiErrorMsg.textContent = msg;
}


// ── Run buttons ───────────────────────────
document.querySelectorAll('.ai-run-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (currentAiTool) runAi(currentAiTool);
  });
});


// ── Result actions ────────────────────────

// Use — put result into the script textarea
aiUseBtn.addEventListener('click', () => {
  const text = aiResultText.textContent.trim();
  if (!text) return;
  document.getElementById('script-input').value = text;
  closeAiPanel();
  // Flash the textarea to confirm
  document.getElementById('script-input').style.borderColor = 'rgba(74,222,128,0.6)';
  setTimeout(() => {
    document.getElementById('script-input').style.borderColor = '';
  }, 800);
});

// Regenerate — rerun last prompt
aiRetryBtn.addEventListener('click', () => {
  if (lastAiPrompt) runAi(lastAiPrompt.tool);
});

// Discard — hide result, stay on same tool
aiDiscardBtn.addEventListener('click', () => {
  hideAiStates();
});
