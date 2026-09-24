(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    onlineCount: $('onlineCount'),
    remoteVideo: $('remoteVideo'),
    localVideo: $('localVideo'),
    overlay: $('overlay'),
    spinner: $('spinner'),
    statusTitle: $('statusTitle'),
    statusSub: $('statusSub'),
    camOffBadge: $('camOffBadge'),
    micBtn: $('micBtn'),
    camBtn: $('camBtn'),
    nextBtn: $('nextBtn'),
    nextLabel: $('nextLabel'),
    escHint: $('escHint'),
    stopBtn: $('stopBtn'),
    reportBtn: $('reportBtn'),
    typing: $('typing'),
    messages: $('messages'),
    chatForm: $('chatForm'),
    chatInput: $('chatInput'),
    sendBtn: $('sendBtn'),
    gate: $('gate'),
    consentBox: $('consentBox'),
    enterBtn: $('enterBtn'),
    toast: $('toast'),
  };

  const CONSENT_KEY = 'sudfa:consent';

  // idle → searching → connecting (matched, video not yet flowing) → connected,
  // or → failed (matched, but the network blocked the video; text chat still works)
  const PAIRED_PHASES = ['connecting', 'connected', 'failed'];
  const VIDEO_TIMEOUT_MS = 20000;
  let phase = 'idle';
  let banned = false;
  let localStream = null;
  let usingPlaceholder = false;
  let pc = null;
  let pendingCandidates = [];
  let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  let researchTimer = null;
  let videoTimer = null;
  let typingTimer = null;
  let sentTyping = false;
  let lastSent = 0;
  let toastTimer = null;

  const socket = io({ autoConnect: false });

  const configReady = fetch('/config')
    .then((r) => r.json())
    .then((cfg) => { if (cfg && cfg.iceServers) rtcConfig = { iceServers: cfg.iceServers }; })
    .catch(() => {});

  const isPaired = () => PAIRED_PHASES.includes(phase);

  // ── UI helpers ────────────────────────────────────

  function showToast(text, ms = 3200) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  function setOverlay(title, sub, { spinner = false, visible = true } = {}) {
    els.statusTitle.textContent = title;
    els.statusSub.textContent = sub || '';
    els.spinner.hidden = !spinner;
    els.overlay.classList.toggle('hidden', !visible);
  }

  function setPhase(next, overlayText) {
    phase = next;
    const active = phase !== 'idle';
    const paired = isPaired();

    els.nextLabel.textContent = active ? 'التالي' : 'ابدأ';
    els.escHint.hidden = !active;
    els.nextBtn.disabled = banned;
    els.stopBtn.disabled = !active;
    els.reportBtn.disabled = !paired;
    els.chatInput.disabled = !paired;
    els.sendBtn.disabled = !paired;
    if (!paired) els.typing.hidden = true;

    if (phase === 'idle') {
      setOverlay(...(overlayText || ['جاهز للقاء شخص جديد؟', 'اضغط «ابدأ» وسنوصلك بشخص عشوائي خلال ثوانٍ.']));
    } else if (phase === 'searching') {
      setOverlay(...(overlayText || ['جاري البحث عن شخص…', 'لحظات وسنجد لك أحداً للدردشة.']), { spinner: true });
    } else if (phase === 'connecting') {
      setOverlay('تم العثور على شخص!', 'جاري ربط الفيديو… يمكنك الكتابة له في الدردشة.', { spinner: true });
    } else if (phase === 'failed') {
      setOverlay('تعذّر ربط الفيديو', 'شبكة أحدكما تمنع الاتصال المباشر. يمكنكما الدردشة كتابياً، أو اضغط «التالي».');
    } else if (phase === 'connected') {
      setOverlay('', '', { visible: false });
    }
  }

  const emptyChat = $('emptyChat');

  function clearChat() {
    els.messages.replaceChildren(emptyChat);
  }

  function addMessage(text, who) {
    emptyChat.remove();
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.textContent = text;
    els.messages.appendChild(el);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  const addSystem = (text) => addMessage(text, 'system');

  function updateMediaButtons() {
    const audio = localStream ? localStream.getAudioTracks()[0] : null;
    const video = localStream ? localStream.getVideoTracks()[0] : null;
    els.micBtn.disabled = !audio;
    els.camBtn.disabled = !video;
    const micOff = !audio || !audio.enabled;
    const camOff = !video || !video.enabled;
    els.micBtn.setAttribute('aria-pressed', String(Boolean(audio) && micOff));
    els.camBtn.setAttribute('aria-pressed', String(Boolean(video) && camOff));
    els.micBtn.title = micOff ? 'تشغيل الميكروفون' : 'كتم الميكروفون';
    els.camBtn.title = camOff ? 'تشغيل الكاميرا' : 'إيقاف الكاميرا';
    els.camOffBadge.hidden = !(video && camOff);
  }

  // ── Media ─────────────────────────────────────────

  // Used when there is no camera (or permission is denied) so the user can still
  // be matched and text chat; the partner sees an animated placeholder.
  function placeholderStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const start = performance.now();
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      const g = ctx.createLinearGradient(0, 0, 640, 480);
      g.addColorStop(0, '#141821');
      g.addColorStop(1, '#1f2a44');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 640, 480);
      const r = 70 + Math.sin(t * 2) * 4;
      ctx.fillStyle = 'rgba(46,230,166,0.15)';
      ctx.beginPath(); ctx.arc(320, 210, r + 22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2ee6a6';
      ctx.beginPath(); ctx.arc(320, 185, 34, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(320, 265, 58, 38, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#8b93a7';
      ctx.font = '600 26px Cairo, Tahoma, sans-serif';
      ctx.textAlign = 'center';
      ctx.direction = 'rtl';
      ctx.fillText('الكاميرا غير متاحة', 320, 360);
    };
    draw();
    setInterval(draw, 1000 / 12);
    usingPlaceholder = true;
    return canvas.captureStream(12);
  }

  async function ensureMedia() {
    if (localStream) return;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      showToast('المتصفح لا يسمح بالكاميرا هنا (يلزم HTTPS أو localhost) — سيتم استخدام صورة بديلة', 5000);
      localStream = placeholderStream();
    } else {
      try {
        localStream = await md.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        try {
          localStream = await md.getUserMedia({ video: true });
          showToast('لم نتمكن من الوصول إلى الميكروفون — سيعمل الفيديو فقط', 4500);
        } catch {
          localStream = placeholderStream();
          showToast('تعذّر الوصول إلى الكاميرا — سيرى الطرف الآخر صورة بديلة', 4500);
        }
      }
    }
    els.localVideo.srcObject = localStream;
    // Mirror only a real camera; the placeholder has text that would read backwards.
    els.localVideo.classList.toggle('no-mirror', usingPlaceholder);
    updateMediaButtons();
  }

  // ── WebRTC ────────────────────────────────────────

  function closePeer() {
    clearTimeout(videoTimer);
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    pendingCandidates = [];
    els.remoteVideo.srcObject = null;
    els.remoteVideo.muted = false;
  }

  function videoConnected() {
    clearTimeout(videoTimer);
    if (phase === 'connecting' || phase === 'failed') setPhase('connected');
  }

  function videoFailed() {
    if (phase !== 'connecting') return;
    setPhase('failed');
    addSystem('تعذّر ربط الفيديو مع هذا الشخص. يمكنكما الدردشة كتابياً أو اضغط «التالي».');
  }

  // Logs whether the call went direct (host/srflx) or through the TURN relay.
  async function logRoute(peer) {
    try {
      const stats = await peer.getStats();
      for (const s of stats.values()) {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
          const local = stats.get(s.localCandidateId);
          console.info('[sudfa] video connected via', local && local.candidateType);
          return;
        }
      }
    } catch {}
  }

  function playRemote() {
    els.remoteVideo.play().catch(() => {
      // Autoplay with sound was blocked: play muted and let a tap enable sound.
      els.remoteVideo.muted = true;
      els.remoteVideo.play().catch(() => {});
      showToast('اضغط على الفيديو لتشغيل الصوت', 5000);
    });
  }

  function createPeer() {
    const peer = new RTCPeerConnection(rtcConfig);
    pc = peer;
    pendingCandidates = [];
    localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

    peer.onicecandidate = ({ candidate }) => {
      if (candidate && peer === pc) socket.emit('signal', { candidate });
    };
    peer.ontrack = (ev) => {
      if (peer !== pc) return;
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      if (els.remoteVideo.srcObject !== stream) {
        els.remoteVideo.srcObject = stream;
        playRemote();
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer !== pc) return;
      if (peer.connectionState === 'connected') {
        videoConnected();
        logRoute(peer);
      } else if (peer.connectionState === 'failed') {
        videoFailed();
      }
    };
    videoTimer = setTimeout(() => { if (peer === pc) videoFailed(); }, VIDEO_TIMEOUT_MS);
    return peer;
  }

  async function onMatched({ initiator }) {
    clearTimeout(researchTimer);
    closePeer();
    clearChat();
    setPhase('connecting');
    addSystem('أنت الآن تتحدث مع شخص غريب. قل مرحباً! 👋');

    const peer = createPeer();
    if (!initiator) return;
    try {
      const offer = await peer.createOffer();
      if (peer !== pc) return;
      await peer.setLocalDescription(offer);
      socket.emit('signal', { description: peer.localDescription });
    } catch (err) {
      console.warn('offer failed', err);
    }
  }

  async function onSignal({ description, candidate }) {
    const peer = pc;
    if (!peer) return;
    try {
      if (description) {
        await peer.setRemoteDescription(description);
        if (peer !== pc) return;
        if (description.type === 'offer') {
          const answer = await peer.createAnswer();
          if (peer !== pc) return;
          await peer.setLocalDescription(answer);
          socket.emit('signal', { description: peer.localDescription });
        }
        for (const c of pendingCandidates.splice(0)) {
          await peer.addIceCandidate(c).catch(() => {});
        }
      } else if (candidate) {
        if (peer.remoteDescription) await peer.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      }
    } catch (err) {
      console.warn('signal failed', err);
    }
  }

  els.remoteVideo.addEventListener('playing', videoConnected);
  els.remoteVideo.addEventListener('click', () => {
    if (els.remoteVideo.muted) {
      els.remoteVideo.muted = false;
      els.remoteVideo.play().catch(() => {});
    }
  });

  // ── Actions ───────────────────────────────────────

  async function start() {
    if (banned) return;
    els.nextBtn.disabled = true;
    await Promise.all([ensureMedia(), configReady]);
    els.nextBtn.disabled = false;
    if (!socket.connected) socket.connect();
    clearChat();
    setPhase('searching');
    socket.emit('find');
  }

  function next() {
    if (banned) return;
    if (phase === 'idle') { start(); return; }
    clearTimeout(researchTimer);
    stopTyping();
    closePeer();
    clearChat();
    setPhase('searching');
    socket.emit('next');
  }

  function stop() {
    clearTimeout(researchTimer);
    stopTyping();
    closePeer();
    socket.emit('stop');
    if (phase !== 'idle') addSystem('أوقفت الدردشة.');
    setPhase('idle');
  }

  function report() {
    if (!isPaired()) return;
    if (!confirm('هل تريد الإبلاغ عن هذا المستخدم والانتقال لشخص آخر؟')) return;
    stopTyping();
    closePeer();
    clearChat();
    setPhase('searching');
    socket.emit('report'); // server unpairs us and puts us back in the queue
    showToast('شكراً لك، تم إرسال البلاغ.');
  }

  function onPartnerLeft() {
    closePeer();
    addSystem('غادر الغريب المحادثة.');
    setPhase('searching', ['غادر الغريب', 'جاري البحث عن شخص جديد…']);
    clearTimeout(researchTimer);
    researchTimer = setTimeout(() => {
      if (phase === 'searching') socket.emit('find');
    }, 1200);
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    if (sentTyping) {
      sentTyping = false;
      socket.emit('typing', false);
    }
  }

  // ── Socket events ─────────────────────────────────

  socket.on('connect', () => {
    // Re-join the queue after a dropped connection.
    if (phase !== 'idle') {
      closePeer();
      setPhase('searching');
      socket.emit('find');
    }
  });
  socket.on('disconnect', () => {
    if (phase !== 'idle' && !banned) {
      closePeer();
      setPhase('searching', ['انقطع الاتصال بالخادم', 'جاري إعادة المحاولة…']);
    }
  });
  socket.on('online', (n) => { els.onlineCount.textContent = n; });
  // A match or leave can cross paths with the user pressing stop; the server has
  // already unpaired us by then, so these are safe to drop while idle.
  socket.on('matched', (data) => { if (phase !== 'idle') onMatched(data); });
  socket.on('signal', onSignal);
  socket.on('partner-left', () => { if (phase !== 'idle') onPartnerLeft(); });
  socket.on('chat', (text) => {
    els.typing.hidden = true;
    addMessage(text, 'them');
  });
  socket.on('typing', (isTyping) => {
    if (isPaired()) els.typing.hidden = !isTyping;
  });
  socket.on('banned', () => {
    banned = true;
    closePeer();
    setPhase('idle', ['تم إيقاف حسابك مؤقتاً', 'بسبب بلاغات متعددة من مستخدمين آخرين. حاول لاحقاً.']);
  });

  // ── DOM events ────────────────────────────────────

  els.nextBtn.addEventListener('click', next);
  els.stopBtn.addEventListener('click', stop);
  els.reportBtn.addEventListener('click', report);

  els.micBtn.addEventListener('click', () => {
    const track = localStream && localStream.getAudioTracks()[0];
    if (track) track.enabled = !track.enabled;
    updateMediaButtons();
  });
  els.camBtn.addEventListener('click', () => {
    const track = localStream && localStream.getVideoTracks()[0];
    if (track) track.enabled = !track.enabled;
    updateMediaButtons();
  });

  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text || !isPaired()) return;
    const now = Date.now();
    if (now - lastSent < 350) return;
    lastSent = now;
    socket.emit('chat', text);
    addMessage(text, 'me');
    els.chatInput.value = '';
    stopTyping();
  });

  els.chatInput.addEventListener('input', () => {
    if (!sentTyping) {
      sentTyping = true;
      socket.emit('typing', true);
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1500);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.gate.hidden && phase !== 'idle') {
      e.preventDefault();
      next();
    }
  });

  // ── Entry gate ────────────────────────────────────

  function enter() {
    try { localStorage.setItem(CONSENT_KEY, '1'); } catch {}
    els.gate.hidden = true;
    els.nextBtn.focus();
  }

  els.consentBox.addEventListener('change', () => {
    els.enterBtn.disabled = !els.consentBox.checked;
  });
  els.enterBtn.addEventListener('click', enter);

  let consented = false;
  try { consented = localStorage.getItem(CONSENT_KEY) === '1'; } catch {}
  if (consented) els.gate.hidden = true;

  updateMediaButtons();
  setPhase('idle');
  socket.connect(); // connect early so the online counter is live
})();
