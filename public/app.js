(function () {
  const socket = io();
  const CONSENT_KEY = 'safespace_consent_v1';

  function hasConsented() {
    try { return !!localStorage.getItem(CONSENT_KEY); } catch (e) { return false; }
  }
  function recordConsent() {
    try { localStorage.setItem(CONSENT_KEY, '1'); } catch (e) { /* private browsing etc. — non-fatal */ }
  }

  let state = {
    screen: 'home',
    role: null,
    sessionId: null,
    messages: [],
    rating: 0,
    reportOpen: false,
    crisisFlagged: false,
    startedAt: null,
    partnerTyping: false,
    queueCounts: { venter: 0, listener: 0, flexible: 0 },
    consentGiven: hasConsented(),
  };
  let tickInterval = null;
  let typingTimeout = null;
  let isTyping = false;

  socket.on('queue_counts', (counts) => {
    state.queueCounts = counts;
    if (state.screen === 'landing') render();
  });

  function render() {
    const app = document.getElementById('app');
    app.innerHTML = '';
    if (state.screen === 'home') app.appendChild(renderHome());
    else if (state.screen === 'landing') app.appendChild(renderLanding());
    else if (state.screen === 'waiting') app.appendChild(renderWaiting());
    else if (state.screen === 'chat') app.appendChild(renderChat());
    else if (state.screen === 'end') app.appendChild(renderEnd());
    if (state.reportOpen) {
      app.appendChild(renderReportModal());
      setupFocusTrap('report-modal', () => { state.reportOpen = false; render(); });
    }
    if (!state.consentGiven && state.screen !== 'home') {
      app.appendChild(renderConsentModal());
      setupFocusTrap('consent-modal', null); // required acknowledgment — no Escape/backdrop dismiss
    }
  }

  function setupFocusTrap(containerId, onEscape) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const focusables = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first.focus();
    container.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && onEscape) onEscape();
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    });
    return e;
  }

  const HOME_QUOTES = [
    "You don't have to have it figured out to be worth talking to.",
    'Being heard is its own kind of relief.',
    'Some days, showing up is the whole point.',
    'You are not a burden for needing to talk.',
    'Listening is a small thing that means a lot.',
    "It's okay to take up a few minutes of someone's night.",
    "The right words matter less than someone actually listening.",
    'You made it through today. That counts for something.',
    "Connection doesn't require a reason — just a moment.",
    'Two strangers, one honest conversation. That can be enough.',
  ];
  function pickHomeQuote() {
    return HOME_QUOTES[Math.floor(Math.random() * HOME_QUOTES.length)];
  }

  // ---------------- HOME ----------------
  function renderHome() {
    return el('div', { class: 'landing home' }, [
      el('div', { class: 'glow' }),
      el('div', { class: 'home-content' }, [
        el('h1', { text: 'safespace' }),
        el('p', { class: 'tagline', text: 'Anonymous peer support, one conversation at a time.' }),
        el('div', { class: 'mission' }, [
          el('h2', { text: 'Why we exist' }),
          el('p', { text: "Everyone has days they need to talk through, and not everyone has someone to call. safespace closes that gap: a place to say what's on your mind to a real person — no names, no history, no accounts." }),
          el('p', { text: "Vent when you need to get something off your chest, or listen when you have room to hold space for someone else. It's not therapy or a substitute for professional care — just somewhere to not feel alone with what you're carrying today." }),
        ]),
        el('blockquote', { class: 'home-quote', text: pickHomeQuote() }),
        el('button', { class: 'cta-btn', onclick: () => { state.screen = 'landing'; render(); }, text: 'Start a Conversation' }),
      ]),
      el('p', { class: 'footnote' }, [
        "If you're in crisis (US), call or text 988, or chat at ",
        el('a', { href: 'https://988lifeline.org/chat', target: '_blank', text: '988lifeline.org' }),
        ' — or text HOME to 741741 for the ',
        el('a', { href: 'https://www.crisistextline.org', target: '_blank', text: 'Crisis Text Line' }),
        '. Outside the US, find a local line at ',
        el('a', { href: 'https://findahelpline.com', target: '_blank', text: 'findahelpline.com' }),
        '.',
      ]),
      el('div', { class: 'footer-links' }, [
        el('a', { href: '/terms.html', target: '_blank', text: 'Terms & Privacy' }),
      ]),
    ]);
  }

  function renderQueueStatus() {
    const { venter, listener, flexible } = state.queueCounts;
    const total = venter + listener + flexible;
    if (total === 0) {
      return el('p', { class: 'queue-status' }, "No one's waiting right now — you'll likely be first in line.");
    }
    const parts = [];
    if (venter > 0) parts.push(el('span', {}, [el('span', { class: 'dot amber', 'aria-hidden': 'true' }), `${venter} waiting to vent`]));
    if (listener > 0) parts.push(el('span', {}, [el('span', { class: 'dot teal', 'aria-hidden': 'true' }), `${listener} waiting to listen`]));
    if (flexible > 0) parts.push(el('span', {}, [el('span', { class: 'dot flex', 'aria-hidden': 'true' }), `${flexible} open to either`]));
    const row = el('p', { class: 'queue-status' });
    parts.forEach((p, i) => {
      row.appendChild(p);
      if (i < parts.length - 1) row.appendChild(document.createTextNode('  ·  '));
    });
    return row;
  }

  // ---------------- LANDING ----------------
  function renderLanding() {
    return el('div', { class: 'landing' }, [
      el('div', { class: 'glow' }),
      el('div', { class: 'brand' }, [
        el('h1', { text: 'safespace' }),
        el('p', { text: "A place to talk to a stranger who's only there to listen — or to be that person for someone else. No names, no history, no accounts." }),
      ]),
      el('div', { class: 'choices', role: 'group', 'aria-label': 'Choose how you want to participate' }, [
        el('button', { class: 'choice vent', onclick: () => joinQueue('venter') }, [
          el('span', { class: 'tag', text: 'I want to' }),
          el('h2', { text: 'Vent' }),
          el('p', { text: 'Get something off your chest to someone who will just listen. No advice unless you ask for it.' }),
        ]),
        el('button', { class: 'choice listen', onclick: () => joinQueue('listener') }, [
          el('span', { class: 'tag', text: 'I want to' }),
          el('h2', { text: 'Listen' }),
          el('p', { text: "Be the calm presence for someone who needs to talk. You don't need answers — just attention." }),
        ]),
        el('button', { class: 'choice flex', onclick: () => joinQueue('flexible') }, [
          el('span', { class: 'tag', text: "I don't mind" }),
          el('h2', { text: 'Surprise Me' }),
          el('p', { text: "Skip the choice. You'll be matched instantly with whoever's here, as whichever role is needed." }),
        ]),
      ]),
      renderQueueStatus(),
      el('p', { class: 'footnote' }, [
        "This is a peer support space, not therapy or emergency care. If you're in crisis (US), call or text 988, or chat at ",
        el('a', { href: 'https://988lifeline.org/chat', target: '_blank', text: '988lifeline.org' }),
        ' — or text HOME to 741741 for the ',
        el('a', { href: 'https://www.crisistextline.org', target: '_blank', text: 'Crisis Text Line' }),
        '. Outside the US, find a local line at ',
        el('a', { href: 'https://findahelpline.com', target: '_blank', text: 'findahelpline.com' }),
        '.',
      ]),
      el('div', { class: 'footer-links' }, [
        el('a', { href: '/terms.html', target: '_blank', text: 'Terms & Privacy' }),
      ]),
    ]);
  }

  function joinQueue(role) {
    state.role = role;
    state.screen = 'waiting';
    render();
    socket.emit('join_queue', { role });
  }

  function cancelWait() {
    socket.emit('leave_queue');
    state.screen = 'landing';
    render();
  }

  function renderWaiting() {
    const pulseColor = state.role === 'venter' ? 'amber' : state.role === 'listener' ? 'teal' : 'flex';
    const message = state.role === 'venter'
      ? 'Looking for someone to listen…'
      : state.role === 'listener'
        ? 'Looking for someone who wants to talk…'
        : 'Looking for anyone to connect with…';
    return el('div', { class: 'waiting' }, [
      el('div', { class: 'pulse ' + pulseColor, 'aria-hidden': 'true' }),
      el('h3', { text: message }),
      el('p', { text: 'This can take a moment. Keep this tab open.' }),
      el('button', { class: 'cancel-btn', onclick: cancelWait, text: 'Cancel' }),
    ]);
  }

  // ---------------- CHAT ----------------
  socket.on('matched', ({ sessionId, role, myName, partnerName }) => {
    state.sessionId = sessionId;
    state.role = role;
    state.myName = myName;
    state.partnerName = partnerName;
    state.screen = 'chat';
    state.messages = [];
    state.crisisFlagged = false;
    state.startedAt = Date.now();
    state.partnerTyping = false;
    render();
    tickInterval = setInterval(() => {
      const t = document.getElementById('timer-display');
      if (t) t.textContent = formatElapsed();
    }, 1000);
  });

  socket.on('message', (msg) => {
    state.messages.push(msg);
    state.partnerTyping = false;
    renderMessagesOnly();
  });

  socket.on('partner_typing', () => {
    state.partnerTyping = true;
    renderMessagesOnly();
  });

  socket.on('partner_stopped_typing', () => {
    state.partnerTyping = false;
    renderMessagesOnly();
  });

  socket.on('crisis_resources', () => {
    state.crisisFlagged = true;
    renderMessagesOnly();
  });

  socket.on('rate_limited', () => {
    state.messages.push({ sender: 'system', text: "You're sending messages quickly — take a breath and try again in a moment." });
    renderMessagesOnly();
  });

  socket.on('session_ended', () => {
    clearInterval(tickInterval);
    state.screen = 'end';
    render();
  });

  socket.on('report_received', () => {
    state.reportOpen = false;
    render();
  });

  function formatElapsed() {
    const secs = Math.floor((Date.now() - state.startedAt) / 1000);
    const m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function renderChat() {
    const isVenter = state.role === 'venter';
    const container = el('div', { class: 'chat' });
    container.appendChild(el('div', { class: 'chat-top' }, [
      el('div', { class: 'chat-identity' }, [
        el('span', { class: 'role-pill ' + (isVenter ? 'venter-view' : 'listener-view'), text: isVenter ? 'Venting' : 'Listening' }),
        el('span', { class: 'you-are', text: 'as ' + (state.myName || '\u2026') }),
      ]),
      el('span', { class: 'timer', id: 'timer-display', text: formatElapsed() }),
      el('div', { class: 'chat-top-actions' }, [
        el('button', { class: 'icon-btn report', onclick: () => { state.reportOpen = true; render(); }, text: 'Report' }),
        el('button', { class: 'icon-btn', onclick: () => socket.emit('end_session', { sessionId: state.sessionId }), text: 'End' }),
      ]),
    ]));
    const msgWrap = el('div', { class: 'messages', id: 'messages-wrap', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation' });
    container.appendChild(msgWrap);
    renderMessageList(msgWrap);

    const textarea = el('textarea', { rows: '1', placeholder: 'Type a message…', id: 'composer-input', 'aria-label': 'Type a message' });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(textarea); }
    });
    textarea.addEventListener('input', handleTypingSignal);
    const sendBtn = el('button', { class: 'send-btn' + (isVenter ? '' : ' listener-mode'), text: 'Send', onclick: () => sendMessage(textarea) });
    container.appendChild(el('div', { class: 'composer ' + (isVenter ? 'venter-mode' : 'listener-mode') }, [textarea, sendBtn]));
    return container;
  }

  function handleTypingSignal() {
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing', { sessionId: state.sessionId });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTyping = false;
      socket.emit('stop_typing', { sessionId: state.sessionId });
    }, 1500);
  }

  function renderMessageList(wrap) {
    wrap.innerHTML = '';
    if (state.messages.length === 0) {
      wrap.appendChild(el('div', { class: 'msg system', text: `You're connected with ${state.partnerName || 'someone'}. Say hello whenever you're ready.` }));
    }
    state.messages.forEach((m) => {
      const mine = m.sender === state.role;
      wrap.appendChild(el('div', { class: 'msg ' + (mine ? 'mine' : 'theirs'), text: m.text }));
    });
    if (state.crisisFlagged) {
      wrap.appendChild(el('div', { class: 'crisis-banner' }, [
        el('strong', { text: 'You matter, and support is available. ' }),
        'If things feel like too much right now, you can reach the 988 Suicide & Crisis Lifeline by calling or texting 988 or chatting at 988lifeline.org, or the Crisis Text Line by texting HOME to 741741 — all are free and available 24/7.',
      ]));
    }
    if (state.partnerTyping) {
      wrap.appendChild(el('div', { class: 'typing-indicator' }, [
        `${state.partnerName || 'They'} is typing`,
        el('span', { class: 'typing-dots', 'aria-hidden': 'true' }, [
          el('span', {}), el('span', {}), el('span', {}),
        ]),
      ]));
    }
    wrap.scrollTop = wrap.scrollHeight;
  }

  function renderMessagesOnly() {
    const wrap = document.getElementById('messages-wrap');
    if (wrap) renderMessageList(wrap);
  }

  function sendMessage(textarea) {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    clearTimeout(typingTimeout);
    if (isTyping) {
      isTyping = false;
      socket.emit('stop_typing', { sessionId: state.sessionId });
    }
    socket.emit('send_message', { sessionId: state.sessionId, text });
  }

  // ---------------- END / RATING ----------------
  function renderEnd() {
    const isVenter = state.role === 'venter';
    const box = el('div', { class: 'end-screen' }, [
      el('h2', { text: 'Session ended' }),
      el('p', { text: isVenter ? `Thanks for sharing with ${state.partnerName || 'someone'}. How did it feel to be heard?` : `Thanks for showing up for ${state.partnerName || 'someone'} today.` }),
    ]);
    if (isVenter) {
      const starsWrap = el('div', { class: 'stars', role: 'group', 'aria-label': 'Rate your experience, 1 to 5 stars' });
      for (let i = 1; i <= 5; i++) {
        const s = el('button', {
          class: 'star' + (i <= state.rating ? ' filled' : ''),
          text: '★',
          'aria-label': `Rate ${i} out of 5 stars`,
          'aria-pressed': String(i <= state.rating),
        });
        s.addEventListener('click', () => { state.rating = i; render(); });
        starsWrap.appendChild(s);
      }
      box.appendChild(starsWrap);
    }
    box.appendChild(el('button', { class: 'again-btn', text: 'Start a new session', onclick: resetToLanding }));
    return box;
  }

  function resetToLanding() {
    state = { screen: 'landing', role: null, sessionId: null, messages: [], rating: 0, reportOpen: false, crisisFlagged: false, startedAt: null };
    render();
  }

  // ---------------- REPORT ----------------
  function renderReportModal() {
    let reason = 'harassment';
    let details = '';
    const overlay = el('div', { class: 'modal-overlay', id: 'report-modal', onclick: (e) => { if (e.target === overlay) { state.reportOpen = false; render(); } } });
    const select = el('select', { 'aria-label': 'Reason for report' });
    [['harassment', 'Harassment or abuse'], ['spam', 'Spam or off-topic'], ['safety', 'Safety concern about the other person'], ['other', 'Other']].forEach(([v, label]) => {
      select.appendChild(el('option', { value: v, text: label }));
    });
    select.addEventListener('change', (e) => { reason = e.target.value; });
    const textarea = el('textarea', { rows: '3', placeholder: 'Optional details…', 'aria-label': 'Additional details, optional' });
    textarea.addEventListener('input', (e) => { details = e.target.value; });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'report-title' }, [
      el('h3', { id: 'report-title', text: 'Report this session' }),
      el('p', { text: "Reports are anonymous. If you're in immediate danger, contact local emergency services." }),
      select,
      textarea,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn-ghost', text: 'Cancel', onclick: () => { state.reportOpen = false; render(); } }),
        el('button', {
          class: 'btn-danger', text: 'Submit report', onclick: () => {
            socket.emit('report', { sessionId: state.sessionId, reason, details });
          },
        }),
      ]),
    ]);
    overlay.appendChild(modal);
    return overlay;
  }

  // ---------------- CONSENT GATE ----------------
  function renderConsentModal() {
    const overlay = el('div', { class: 'modal-overlay', id: 'consent-modal' });
    const modal = el('div', { class: 'modal wide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'consent-title' }, [
      el('h3', { id: 'consent-title', text: 'Before you continue' }),
      el('p', { text: 'SafeSpace connects you with anonymous strangers for peer support conversations. It is not therapy, counseling, medical advice, or a crisis service, and the people you talk to are not verified professionals.' }),
      el('p', { text: "If you're in crisis, please contact 988 (call or text) or chat at 988lifeline.org right now, rather than waiting for a match." }),
      el('p', {}, [
        'You must be 18 or older to use this site. By continuing, you agree not to share identifying information, harass other users, or use this space for anything illegal, and you agree to our ',
        el('a', { href: '/terms.html', target: '_blank', text: 'Terms & Privacy Policy' }),
        '.',
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn-danger', text: 'I understand, continue', onclick: () => {
            recordConsent();
            state.consentGiven = true;
            render();
          },
        }),
      ]),
    ]);
    overlay.appendChild(modal);
    return overlay;
  }

  render();
})();
