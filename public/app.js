const MARITAL = ['Single', 'Married', 'Divorced', 'Separated', 'Widowed'];
const RELIGIONS = ['Christian', 'Muslim', 'Hindu', 'Traditional', 'Other', 'None'];
const EDUCATION = ['No formal education', 'Primary', 'Secondary', 'Certificate / Vocational', 'Diploma', 'Degree'];
const HOUSE_SIZES = ['Bedsitter / Studio', '1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5+ bedrooms'];
const WORK_TYPES = { fulltime: 'Full-time', parttime: 'Part-time', either: 'Full-time or part-time' };

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');

const noFilters = () => ({ location: '', work_type: '', religion: '', education: '', min_age: '', max_age: '', good_conduct: '' });

const state = {
  me: null,
  tab: null,
  deck: [],
  deckIndex: 0, // which profile in the deck is on screen
  filters: noFilters(),
  jobScreen: null, // employer Jobs tab: null = list, 'new' = post form, number = that vacancy's applicants
  jobArea: '', // worker Jobs tab area filter
  images: {}, // uploads for the form currently on screen
  busy: false,
};

// ---------- helpers ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kidsText = (n) => (n ? plural(n, 'kid') : 'No kids');
const initials = (name) => esc(name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase());
const picture = (person) =>
  person.photo ? `<img src="${esc(person.photo)}" alt="" draggable="false">` : `<div class="initials">${initials(person.name)}</div>`;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// Shrinks uploads in the browser so photos stay small enough to store and send.
function resizeImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('That file could not be read as an image'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- form building ----------

const field = (label, control) => `<label class="field"><span>${label}</span>${control}</label>`;
const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
const select = (name, options, value, placeholder = 'Select…') =>
  `<select name="${name}" required>
    <option value="" disabled ${value ? '' : 'selected'}>${placeholder}</option>
    ${options.map(([v, label]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
  </select>`;
const same = (list) => list.map((v) => [v, v]);
const choices = (name, options, value) =>
  `<div class="choices">${options
    .map(([v, label]) => `<label><input type="radio" name="${name}" value="${v}" required ${v === value ? 'checked' : ''}><span>${label}</span></label>`)
    .join('')}</div>`;
const yesNo = (name, value) => choices(name, [['yes', 'Yes'], ['no', 'No']], value == null ? '' : value ? 'yes' : 'no');

const PASSWORD_RULE = 'At least 8 characters, with a mix of letters and numbers';
const passwordOk = (value) => value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);

const passwordInput = (attrs) => `
  <div class="pw">
    <input name="password" type="password" required ${attrs}>
    <button type="button" class="pw-toggle" data-action="toggle-password" aria-label="Show password" aria-pressed="false">Show</button>
  </div>`;

const accountFields = () => `
  <fieldset>
    <legend>Account</legend>
    ${field('Phone number', input('phone', '', 'type="tel" required autocomplete="tel" placeholder="e.g. 0712 345 678"'))}
    <div class="field">
      <label class="field-label" for="new-password">Password</label>
      ${passwordInput(`id="new-password" minlength="8" autocomplete="new-password" aria-describedby="pw-hint" data-pw-rule`)}
      <span class="hint" id="pw-hint">${PASSWORD_RULE}</span>
    </div>
  </fieldset>`;

const employerFields = (p = {}) => `
  <fieldset>
    <legend>About you</legend>
    ${field('Full name', input('name', p.name, 'required maxlength="80" autocomplete="name"'))}
    <div class="row">
      ${field('Age', input('age', p.age, 'type="number" required min="18" max="100" inputmode="numeric"'))}
      ${field('ID number', input('id_number', p.id_number, 'required maxlength="30"'))}
    </div>
    ${field('Religion', select('religion', same(RELIGIONS), p.religion))}
  </fieldset>
  <fieldset>
    <legend>Your household</legend>
    ${field('Location / area', input('location', p.location, 'required maxlength="80" placeholder="e.g. Kilimani, Nairobi"'))}
    <div class="row">
      ${field('Number of kids', input('num_kids', p.num_kids, 'type="number" required min="0" max="20" inputmode="numeric"'))}
      ${field('Size of house', select('house_size', same(HOUSE_SIZES), p.house_size))}
    </div>
  </fieldset>`;

const jobFields = (job = {}) => `
  <div class="job">
    <div class="job-head"><span>Previous job</span><button type="button" class="link small" data-action="remove-job">Remove</button></div>
    ${field('Where did you work?', input('job_place', job.place, 'required maxlength="100" placeholder="e.g. Family home in Karen"'))}
    ${field('Name of employer', input('job_employer_name', job.employer_name, 'required maxlength="80"'))}
    <div class="row">
      ${field('Employer phone', input('job_employer_phone', job.employer_phone, 'type="tel" required'))}
      ${field('People cared for (incl. kids)', input('job_people', job.people_cared_for, 'type="number" required min="1" max="50" inputmode="numeric"'))}
    </div>
  </div>`;

const workerFields = (p = {}) => `
  <fieldset>
    <legend>About you</legend>
    <div class="field">
      <span class="field-label">Photo</span>
      <div class="upload">
        ${p.photo ? `<img src="${esc(p.photo)}" alt="" data-preview="photo">` : '<img alt="" data-preview="photo" hidden><div class="ph"></div>'}
        <input type="file" accept="image/*" data-image="photo" data-max="720" aria-label="Photo">
      </div>
    </div>
    ${field('Full name', input('name', p.name, 'required maxlength="80" autocomplete="name"'))}
    <div class="row">
      ${field('Age', input('age', p.age, 'type="number" required min="18" max="80" inputmode="numeric"'))}
      ${field('ID number', input('id_number', p.id_number, 'required maxlength="30"'))}
    </div>
    ${field('Location / area', input('location', p.location, 'required maxlength="80" placeholder="e.g. Kawangware, Nairobi"'))}
    <div class="row">
      ${field('Marital status', select('marital_status', same(MARITAL), p.marital_status))}
      ${field('Religion', select('religion', same(RELIGIONS), p.religion))}
    </div>
    <div class="field"><span class="field-label">Do you have any kids?</span>${yesNo('has_kids', p.has_kids)}</div>
    <div data-show-if="has_kids">
      ${field('How many kids?', input('num_kids', p.num_kids || '', 'type="number" min="1" max="20" inputmode="numeric"'))}
    </div>
  </fieldset>
  <fieldset>
    <legend>Work</legend>
    <div class="field"><span class="field-label">What kind of work are you looking for?</span>
      ${choices('work_type', [['fulltime', 'Full-time'], ['parttime', 'Part-time'], ['either', 'Either']], p.work_type)}
    </div>
    <div class="field">
      <span class="field-label">Where have you worked before? Add each previous job, or leave empty if this is your first.</span>
      <div id="jobs" style="display:flex;flex-direction:column;gap:12px">${(p.work_history ?? []).map(jobFields).join('')}</div>
      <button type="button" class="btn ghost sm" data-action="add-job">+ Add a previous job</button>
    </div>
  </fieldset>
  <fieldset>
    <legend>Background</legend>
    ${field('Highest education level', select('education', same(EDUCATION), p.education))}
    ${field('Schools, courses or training (optional)', `<textarea name="education_details" maxlength="300">${esc(p.education_details)}</textarea>`)}
    <div class="field"><span class="field-label">Do you have a certificate of good conduct?</span>${yesNo('good_conduct', p.good_conduct)}</div>
    <div class="field" data-show-if="good_conduct">
      <span class="field-label">Upload a photo of the certificate (optional)</span>
      <div class="upload doc">
        ${p.good_conduct_doc ? `<img src="${esc(p.good_conduct_doc)}" alt="" data-preview="good_conduct_doc">` : '<img alt="" data-preview="good_conduct_doc" hidden>'}
        <input type="file" accept="image/*" data-image="good_conduct_doc" data-max="1100" aria-label="Certificate of good conduct">
      </div>
    </div>
    ${field('Allergies or dietary restrictions (leave empty if none)', `<textarea name="allergies" maxlength="300">${esc(p.allergies)}</textarea>`)}
  </fieldset>`;

function readProfile(form, role) {
  const f = new FormData(form);
  const get = (name) => f.get(name) ?? '';
  if (role === 'employer') {
    return {
      name: get('name'), age: get('age'), id_number: get('id_number'), religion: get('religion'),
      location: get('location'), num_kids: get('num_kids'), house_size: get('house_size'),
    };
  }
  const jobValue = (job, name) => $(`[name="${name}"]`, job).value;
  return {
    name: get('name'), age: get('age'), id_number: get('id_number'), location: get('location'),
    marital_status: get('marital_status'), religion: get('religion'),
    has_kids: get('has_kids') === 'yes', num_kids: get('num_kids'),
    work_type: get('work_type'),
    work_history: [...form.querySelectorAll('.job')].map((job) => ({
      place: jobValue(job, 'job_place'),
      employer_name: jobValue(job, 'job_employer_name'),
      employer_phone: jobValue(job, 'job_employer_phone'),
      people_cared_for: jobValue(job, 'job_people'),
    })),
    education: get('education'), education_details: get('education_details'),
    good_conduct: get('good_conduct') === 'yes', good_conduct_doc: state.images.good_conduct_doc ?? null,
    allergies: get('allergies'),
    photo: state.images.photo ?? null,
  };
}

// Shows follow-up questions only when the matching yes/no question is answered "yes".
function syncConditionals(form) {
  form.querySelectorAll('[data-show-if]').forEach((el) => {
    const on = $(`[name="${el.dataset.showIf}"]:checked`, form)?.value === 'yes';
    el.hidden = !on;
    const control = $('input[type="number"]', el);
    if (control) control.required = on;
  });
}

function showError(form, message) {
  let box = $('.error', form);
  if (!box) {
    box = document.createElement('div');
    box.className = 'error';
    box.setAttribute('role', 'alert');
    $('button[type="submit"]', form).before(box);
  }
  box.textContent = message;
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------- signed-out screens ----------

function renderLanding() {
  app.innerHTML = `
    <section class="landing">
      <h1 class="logo">Home<span>Connect</span></h1>
      <div class="rule"></div>
      <p class="tagline">Where families and trusted domestic workers find each other.</p>
      <button class="btn" data-action="go" data-screen="employer">I'm looking to hire</button>
      <button class="btn ghost" data-action="go" data-screen="worker">I'm looking for work</button>
      <p class="muted small" style="margin-top:18px">Already have an account? <button class="link" data-action="go" data-screen="login">Log in</button></p>
    </section>`;
}

function renderAuth(screen) {
  state.images = {};
  const back = '<button class="link" data-action="go" data-screen="landing">← Back</button>';
  if (screen === 'login') {
    app.innerHTML = `
      <section class="page">
        ${back}
        <h2>Welcome back</h2>
        <p class="muted">Log in with your phone number.</p>
        <form id="login-form">
          ${field('Phone number', input('phone', '', 'type="tel" required autocomplete="tel"'))}
          <div class="field">
            <label class="field-label" for="login-password">Password</label>
            ${passwordInput('id="login-password" autocomplete="current-password"')}
          </div>
          <button class="btn" type="submit">Log in</button>
        </form>
      </section>`;
    return;
  }
  const employer = screen === 'employer';
  app.innerHTML = `
    <section class="page">
      ${back}
      <h2>${employer ? 'Create an employer account' : 'Create your worker profile'}</h2>
      <p class="muted">${
        employer
          ? 'Tell workers a little about your household.'
          : 'Employers will see this profile. Your ID number is never shown, and your phone number is only shared with employers you accept.'
      }</p>
      <form id="register-form" data-role="${screen}">
        ${employer ? employerFields() : workerFields()}
        ${accountFields()}
        <button class="btn" type="submit">Create account</button>
      </form>
    </section>`;
  syncConditionals($('#register-form'));
}

// ---------- signed-in shell ----------

// ---------- chat ----------
// Open between a matched employer and worker. New messages are fetched every few seconds
// while a chat is open, and unread counts are refreshed in the background.

const CHAT_POLL_MS = 4000;
const UNREAD_POLL_MS = 20000;
let chatTimer = null;
let unreadTimer = null;

const chatButton = (otherId, unread) =>
  `<button class="btn sm chat-btn" data-action="open-chat" data-id="${otherId}">Chat${unread ? ` <span class="count">${unread}</span>` : ''}</button>`;

const chatTime = (timestamp) =>
  new Date(`${timestamp.replace(' ', 'T')}Z`).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function stopChat() {
  clearInterval(chatTimer);
  chatTimer = null;
  state.chat = null;
}

// Puts a dot on the tab where matched chats live when there are unread messages.
async function refreshUnread() {
  if (!state.me) return;
  const tabId = state.me.role === 'employer' ? 'shortlist' : 'requests';
  try {
    const { total } = await api('GET', '/api/chats/unread');
    const tab = $(`.tabs [data-tab="${tabId}"]`);
    if (tab) tab.classList.toggle('unread', total > 0);
  } catch {
    // Network blips are fine; the next poll tries again.
  }
}

function appendMessages(messages) {
  const list = $('#messages');
  if (!list || !messages.length) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  $('.chat-empty', list)?.remove();
  list.insertAdjacentHTML(
    'beforeend',
    messages
      .filter((msg) => msg.id > state.chat.lastId)
      .map(
        (msg) => `<div class="bubble ${msg.mine ? 'mine' : 'theirs'}">
          <p>${esc(msg.body)}</p><time>${chatTime(msg.created_at)}</time>
        </div>`
      )
      .join('')
  );
  state.chat.lastId = Math.max(state.chat.lastId, ...messages.map((msg) => msg.id));
  if (nearBottom || messages.some((msg) => msg.mine)) list.scrollTop = list.scrollHeight;
}

async function openChat(otherId) {
  stopChat();
  state.chat = { otherId, lastId: 0 };
  const { other, messages } = await api('GET', `/api/chats/${otherId}`);
  $('#view').innerHTML = `
    <section class="chat">
      <header class="chat-head">
        <button class="round nav" data-action="close-chat" aria-label="Back">‹</button>
        <div class="avatar">${picture(other)}</div>
        <div class="grow">
          <h3>${esc(other.name)}</h3>
          <a class="small" href="tel:${esc(other.phone)}">${esc(other.phone)}</a>
        </div>
      </header>
      <div class="messages" id="messages" aria-live="polite">
        <p class="chat-empty muted small">No messages yet. Say hello to ${firstName(other.name)}!</p>
      </div>
      <form id="chat-form" class="composer">
        <textarea name="body" rows="1" maxlength="1000" required placeholder="Write a message…" aria-label="Message"></textarea>
        <button class="btn sm" type="submit">Send</button>
      </form>
    </section>`;
  appendMessages(messages);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  refreshUnread();
  chatTimer = setInterval(async () => {
    if (!state.chat || !$('#messages')) return stopChat();
    try {
      const { messages: fresh } = await api('GET', `/api/chats/${otherId}?after=${state.chat.lastId}`);
      appendMessages(fresh);
    } catch {
      // Try again on the next tick.
    }
  }, CHAT_POLL_MS);
  $('#chat-form textarea').focus();
}

function renderHome() {
  stopChat();
  clearInterval(unreadTimer);
  unreadTimer = setInterval(refreshUnread, UNREAD_POLL_MS);
  const tabs =
    state.me.role === 'employer'
      ? [['browse', 'Browse'], ['jobs', 'Jobs'], ['shortlist', 'Shortlist'], ['profile', 'Profile']]
      : [['jobs', 'Jobs'], ['requests', 'Requests'], ['profile', 'Profile']];
  if (!tabs.some(([id]) => id === state.tab)) state.tab = tabs[0][0];
  app.innerHTML = `
    <header class="bar">
      <div class="logo">Home<span>Connect</span></div>
      <button class="link small" data-action="logout">Log out</button>
    </header>
    <main id="view"></main>
    <nav class="tabs">
      ${tabs.map(([id, label]) => `<button data-action="tab" data-tab="${id}" class="${id === state.tab ? 'on' : ''}">${label}</button>`).join('')}
    </nav>`;
  views[state.tab]().catch((err) => toast(err.message));
  refreshUnread();
}

const emptyState = (title, text, extra = '') =>
  `<div class="empty"><div class="mark">◆</div><h2>${title}</h2><p class="muted">${text}</p>${extra}</div>`;

function workerChips(w) {
  return `<div class="chips">
    <span class="chip solid">${WORK_TYPES[w.work_type]}</span>
    <span class="chip">${esc(w.marital_status)}</span>
    <span class="chip">${esc(w.religion)}</span>
    <span class="chip">${kidsText(w.num_kids)}</span>
    <span class="chip ${w.good_conduct ? '' : 'off'}">${w.good_conduct ? '✓ Good conduct certificate' : 'No good conduct certificate'}</span>
  </div>`;
}

function workerDetails(w) {
  const jobs = w.work_history
    .map(
      (job) => `<div class="past">
        <strong>${esc(job.place)}</strong><br>
        Employer: ${esc(job.employer_name)}${job.employer_phone ? ` · <a href="tel:${esc(job.employer_phone)}">${esc(job.employer_phone)}</a>` : ''}<br>
        <span class="muted">Cared for ${plural(job.people_cared_for, 'person').replace('persons', 'people')}</span>
      </div>`
    )
    .join('');
  return `
    <dl>
      <dt>Education</dt><dd>${esc(w.education)}${w.education_details ? `<br><span class="muted">${esc(w.education_details)}</span>` : ''}</dd>
      <dt>Allergies / diet</dt><dd>${esc(w.allergies) || 'None'}</dd>
    </dl>
    <div class="subhead">Work experience</div>
    ${jobs || '<p class="muted small">No previous employment listed.</p>'}
    ${w.work_history.length && !w.phone ? '<p class="muted small">Previous employers\' phone numbers are shared once you match.</p>' : ''}
    ${w.good_conduct_doc ? `<div class="subhead">Certificate of good conduct</div><img class="docimg" src="${esc(w.good_conduct_doc)}" alt="Certificate of good conduct">` : ''}`;
}

// ---------- employer: browse ----------
// Swiping sideways moves between profiles without deciding anything.
// Swiping the photo up shortlists the worker; swiping it down rejects them.

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const deckCard = (w, position) => `
  <article class="card ${position}" ${
    position === 'top'
      ? 'tabindex="0" aria-label="Worker profile. Left and right arrow keys browse, up shortlists, down rejects."'
      : 'aria-hidden="true"'
  }>
    <div class="photo">
      ${picture(w)}
      <span class="stamp yes">Shortlist</span><span class="stamp no">Reject</span>
      ${position === 'top' ? `<span class="counter">${state.deckIndex + 1} / ${state.deck.length}</span>` : ''}
      <div class="who">
        <h3>${esc(w.name)} <small>${w.age}</small></h3>
        <div>${esc(w.location)}</div>
      </div>
    </div>
    <div class="body">${workerChips(w)}${workerDetails(w)}</div>
  </article>`;

function renderDeck() {
  const stage = $('#stage');
  if (!stage) return;
  if (!state.deck.length) {
    const filtered = activeFilters() > 0;
    stage.innerHTML = emptyState(
      'No more profiles',
      filtered ? 'Nobody else matches your filters. Try widening them.' : "You've seen everyone for now. New workers join regularly — check back soon.",
      '<button class="btn ghost sm" data-action="reload-deck">Refresh</button>'
    );
    return;
  }
  const last = state.deck.length - 1;
  state.deckIndex = Math.min(Math.max(state.deckIndex, 0), last);
  const i = state.deckIndex;
  const top = state.deck[i];
  const next = state.deck[i + 1] ?? state.deck[i - 1];
  stage.innerHTML = `
    <div class="deck">${next ? deckCard(next, 'next') : ''}${deckCard(top, 'top')}</div>
    <p class="swipe-hint">Swipe the photo <strong>up</strong> to shortlist, <strong>down</strong> to reject · swipe sideways to browse</p>
    <div class="actions">
      <div class="action"><button class="round nav" data-action="browse-step" data-step="-1" aria-label="Previous profile" ${i === 0 ? 'disabled' : ''}>‹</button>Back</div>
      <div class="action"><button class="round reject" data-action="decide" data-decision="reject" aria-label="Reject">✕</button>Reject</div>
      <div class="action"><button class="round accept" data-action="decide" data-decision="accept" aria-label="Shortlist">✓</button>Shortlist</div>
      <div class="action"><button class="round nav" data-action="browse-step" data-step="1" aria-label="Next profile" ${i === last ? 'disabled' : ''}>›</button>Next</div>
    </div>`;
  attachSwipe($('.card.top'));
}

function attachSwipe(card) {
  let start = null;
  let axis = null; // 'x' = browsing, 'y' = deciding, 'none' = let the details area scroll
  let dx = 0;
  let dy = 0;
  const reset = () => {
    card.style.transform = '';
    card.dataset.lean = '';
  };
  card.addEventListener('pointerdown', (e) => {
    if (state.busy || e.button > 0) return;
    start = { x: e.clientX, y: e.clientY, onPhoto: !!e.target.closest('.photo') };
    axis = null;
    dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!start) return;
    dx = e.clientX - start.x;
    dy = e.clientY - start.y;
    if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : start.onPhoto ? 'y' : 'none';
    if (axis === 'x') {
      card.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
    } else if (axis === 'y') {
      card.style.transform = `translateY(${dy}px)`;
      card.dataset.lean = dy < -40 ? 'accept' : dy > 40 ? 'reject' : '';
    }
  });
  const release = () => {
    if (!start) return;
    start = null;
    card.style.transition = '';
    if (axis === 'x' && Math.abs(dx) > 90) return browse(dx < 0 ? 1 : -1);
    if (axis === 'y' && Math.abs(dy) > 90) return decide(dy < 0 ? 'accept' : 'reject');
    reset();
  };
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);
}

// Moves to the next (step 1) or previous (step -1) profile without recording a decision.
async function browse(step) {
  if (state.busy) return;
  const card = $('.card.top');
  const target = state.deckIndex + step;
  if (target < 0 || target >= state.deck.length) {
    if (card) card.style.transform = '';
    toast(target < 0 ? 'This is the first profile.' : "You've reached the last profile.");
    return;
  }
  state.busy = true;
  if (card) {
    card.style.opacity = '0';
    card.style.transform = `translateX(${step > 0 ? -120 : 120}%) rotate(${step > 0 ? -8 : 8}deg)`;
    await wait(220);
  }
  state.deckIndex = target;
  state.busy = false;
  renderDeck();
}

async function decide(decision) {
  const worker = state.deck[state.deckIndex];
  if (!worker || state.busy) return;
  state.busy = true;
  try {
    await api('POST', '/api/decisions', { worker_id: worker.id, decision });
    const card = $('.card.top');
    if (card) {
      card.dataset.lean = decision;
      card.style.opacity = '0';
      card.style.transform = `translateY(${decision === 'accept' ? -120 : 120}%)`;
    }
    // The profile leaves the deck; the index now points at the one that followed it.
    state.deck.splice(state.deckIndex, 1);
    toast(
      decision === 'accept'
        ? `${worker.name} added to your shortlist. They'll see your request.`
        : `${worker.name} rejected. You can bring rejected profiles back from your Profile tab.`
    );
    await wait(260);
  } catch (err) {
    toast(err.message);
  }
  state.busy = false;
  renderDeck();
}

async function loadDeck() {
  const query = new URLSearchParams(state.filters);
  state.deck = await api('GET', `/api/workers?${query}`);
  state.deckIndex = 0;
  renderDeck();
}

// ---------- job vacancies ----------

const postedOn = (timestamp) => new Date(`${timestamp.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const startsOn = (date) => new Date(`${date}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const firstName = (name) => esc(name.split(' ')[0]);

function jobFacts(job) {
  return `<div class="chips">
    <span class="chip solid">${WORK_TYPES[job.work_type]}</span>
    <span class="chip">${esc(job.location)}</span>
    ${job.salary ? `<span class="chip">${esc(job.salary)}</span>` : ''}
    ${job.start_date ? `<span class="chip">Starts ${startsOn(job.start_date)}</span>` : ''}
  </div>
  <div class="subhead">Duties</div><p class="prose">${esc(job.duties)}</p>
  ${job.requirements ? `<div class="subhead">Requirements</div><p class="prose">${esc(job.requirements)}</p>` : ''}`;
}

const jobForm = () => `
  <section class="page">
    <button class="link" data-action="job-screen">← Back to vacancies</button>
    <h2>Post a vacancy</h2>
    <p class="muted">Workers will see this along with your household details, then apply.</p>
    <form id="job-form">
      ${field('Job title', input('title', '', 'required maxlength="80" placeholder="e.g. Live-in nanny for two kids"'))}
      ${field('Location / area', input('location', state.me.profile.location, 'required maxlength="80"'))}
      <div class="field"><span class="field-label">Work type</span>
        ${choices('work_type', [['fulltime', 'Full-time'], ['parttime', 'Part-time'], ['either', 'Either']], '')}
      </div>
      <div class="row">
        ${field('Salary (optional)', input('salary', '', 'maxlength="60" placeholder="e.g. KES 15,000 / month"'))}
        ${field('Start date (optional)', input('start_date', '', 'type="date"'))}
      </div>
      ${field('Duties', '<textarea name="duties" required maxlength="1500" placeholder="Cooking, cleaning, school runs, caring for a toddler…"></textarea>')}
      ${field('Requirements (optional)', '<textarea name="requirements" maxlength="1000" placeholder="e.g. Good conduct certificate, experience with infants, non-smoker"></textarea>')}
      <button class="btn" type="submit">Post vacancy</button>
    </form>
  </section>`;

async function employerJobList() {
  const jobs = await api('GET', '/api/jobs/mine');
  const postButton = '<button class="btn sm" data-action="job-screen" data-screen="new">+ Post a vacancy</button>';
  $('#view').innerHTML = jobs.length
    ? `<div class="list">
        <div class="list-head"><h2>Your vacancies</h2>${postButton}</div>
        ${jobs
          .map(
            (job) => `<article class="item ${job.status === 'closed' ? 'closed' : ''}">
              <div class="item-head">
                <div class="grow"><h3>${esc(job.title)}</h3><div class="muted small">Posted ${postedOn(job.created_at)}</div></div>
                <span class="chip ${job.status === 'open' ? 'solid' : 'off'}">${job.status === 'open' ? 'Open' : 'Closed'}</span>
              </div>
              <p class="small" style="margin-top:10px">${plural(job.applicants, 'applicant')}${job.pending ? ` · <strong class="gold">${job.pending} awaiting your reply</strong>` : ''}</p>
              <div class="item-actions">
                <button class="btn plain sm" data-action="job-status" data-id="${job.id}" data-status="${job.status === 'open' ? 'closed' : 'open'}">${job.status === 'open' ? 'Close vacancy' : 'Reopen'}</button>
                <button class="btn sm" data-action="job-screen" data-screen="${job.id}">View applicants</button>
              </div>
            </article>`
          )
          .join('')}
      </div>`
    : emptyState('No vacancies yet', 'Post a vacancy and workers can apply to you directly, instead of you browsing.', postButton);
}

async function employerApplicants(jobId) {
  const { job, applicants } = await api('GET', `/api/jobs/${jobId}/applicants`);
  const badge = { pending: '<span class="chip">New</span>', accept: '<span class="chip solid">Accepted</span>', decline: '<span class="chip off">Declined</span>' };
  $('#view').innerHTML = `
    <div class="list">
      <button class="link" style="align-self:flex-start" data-action="job-screen">← Back to vacancies</button>
      <article class="item">
        <div class="item-head"><div class="grow"><h3>${esc(job.title)}</h3><div class="muted small">Posted ${postedOn(job.created_at)}</div></div>
        <span class="chip ${job.status === 'open' ? 'solid' : 'off'}">${job.status === 'open' ? 'Open' : 'Closed'}</span></div>
        <details><summary>Vacancy details</summary><div>${jobFacts(job)}</div></details>
      </article>
      <h2 style="margin-top:8px">Applicants</h2>
      ${
        applicants.length
          ? applicants
              .map(
                (w) => `<article class="item ${w.application === 'accept' ? 'matched' : ''}">
                  <div class="item-head">
                    <div class="avatar">${picture(w)}</div>
                    <div class="grow"><h3>${esc(w.name)}, ${w.age}</h3><div class="muted small">${esc(w.location)}</div></div>
                    ${badge[w.application]}
                  </div>
                  ${w.message ? `<p class="quote">“${esc(w.message)}”</p>` : ''}
                  ${w.phone ? `<div class="contact">Call ${firstName(w.name)}: <a href="tel:${esc(w.phone)}">${esc(w.phone)}</a></div>` : ''}
                  <details><summary>View full profile</summary><div>${workerChips(w)}${workerDetails(w)}</div></details>
                  ${
                    w.application === 'pending'
                      ? `<div class="item-actions">
                          <button class="btn plain sm" data-action="applicant" data-job="${job.id}" data-id="${w.id}" data-decision="decline">Decline</button>
                          <button class="btn sm" data-action="applicant" data-job="${job.id}" data-id="${w.id}" data-decision="accept">Accept</button>
                        </div>`
                      : ''
                  }
                </article>`
              )
              .join('')
          : '<p class="muted">No applications yet. Workers can see this vacancy in their Jobs tab.</p>'
      }
    </div>`;
}

function workerJobCard(job) {
  const e = job.employer;
  const status = {
    pending: `<div class="status-line"><span class="chip">Applied · waiting for reply</span>
      <button class="link small" data-action="withdraw" data-id="${job.id}">Withdraw</button></div>`,
    accept: `<div class="contact">You got the job offer! Call ${firstName(e.name)}: <a href="tel:${esc(e.phone)}">${esc(e.phone)}</a></div>`,
    decline: '<div class="status-line"><span class="chip off">Not selected this time</span></div>',
  }[job.application];
  return `<article class="item ${job.application === 'accept' ? 'matched' : ''}">
    <div class="item-head">
      <div class="grow"><h3>${esc(job.title)}</h3><div class="muted small">${esc(e.name)} · posted ${postedOn(job.created_at)}</div></div>
      ${job.status === 'closed' ? '<span class="chip off">Closed</span>' : ''}
    </div>
    <div style="margin-top:12px">${jobFacts(job)}</div>
    <div class="subhead">The household</div>
    <dl>
      <dt>Area</dt><dd>${esc(e.location)}</dd>
      <dt>Kids in the home</dt><dd>${e.num_kids || 'None'}</dd>
      <dt>House size</dt><dd>${esc(e.house_size)}</dd>
      <dt>Religion</dt><dd>${esc(e.religion)}</dd>
    </dl>
    ${
      status ??
      `<details class="apply">
        <summary class="btn sm">Apply for this job</summary>
        <form class="apply-form" data-job="${job.id}">
          ${field('Message to the employer (optional)', '<textarea name="message" maxlength="600" placeholder="Introduce yourself and why you suit this job"></textarea>')}
          <button class="btn sm" type="submit">Send application</button>
        </form>
      </details>`
    }
  </article>`;
}

async function workerJobList() {
  const jobs = await api('GET', `/api/jobs?${new URLSearchParams({ location: state.jobArea })}`);
  $('#view').innerHTML = `
    <div class="list">
      <h2>Job vacancies</h2>
      <p class="muted small">Apply to jobs posted by employers. Your phone number is only shared if they accept you.</p>
      <form id="job-filter"><input name="area" value="${esc(state.jobArea)}" placeholder="Filter by area" aria-label="Filter vacancies by area"></form>
      ${
        jobs.length
          ? jobs.map(workerJobCard).join('')
          : emptyState('No vacancies', state.jobArea ? 'No open vacancies in that area. Try another area.' : 'No open vacancies right now. Check back soon.')
      }
    </div>`;
}

const activeFilters = () => Object.values(state.filters).filter(Boolean).length;
const filterSummary = () => (activeFilters() ? `Filters · ${activeFilters()} active` : 'Filters');
const filterSelect = (name, label, options) =>
  `<select name="${name}" aria-label="${label}">
    ${options.map(([v, text]) => `<option value="${esc(v)}" ${v === state.filters[name] ? 'selected' : ''}>${esc(text)}</option>`).join('')}
  </select>`;

const views = {
  async browse() {
    const f = state.filters;
    $('#view').innerHTML = `
      <details class="filterbox">
        <summary><span id="filter-summary">${filterSummary()}</span></summary>
        <form class="filters" id="filter-form">
          <input name="location" value="${esc(f.location)}" placeholder="Area" aria-label="Filter by area">
          ${filterSelect('work_type', 'Filter by work type', [['', 'Any work type'], ['fulltime', 'Full-time'], ['parttime', 'Part-time']])}
          <input name="min_age" value="${esc(f.min_age)}" type="number" min="18" max="80" inputmode="numeric" placeholder="Min age" aria-label="Minimum age">
          <input name="max_age" value="${esc(f.max_age)}" type="number" min="18" max="80" inputmode="numeric" placeholder="Max age" aria-label="Maximum age">
          ${filterSelect('religion', 'Filter by religion', [['', 'Any religion'], ...same(RELIGIONS)])}
          ${filterSelect('education', 'Filter by minimum education', [['', 'Any education'], ...EDUCATION.slice(1).map((level) => [level, `${level} or higher`])])}
          ${filterSelect('good_conduct', 'Filter by certificate of good conduct', [
            ['', 'Good conduct certificate: any'],
            ['yes', 'Has good conduct certificate'],
            ['no', 'No good conduct certificate'],
          ])}
          <button type="button" class="link small" data-action="clear-filters">Clear all filters</button>
        </form>
      </details>
      <div id="stage" style="flex:1;display:flex;flex-direction:column"></div>`;
    await loadDeck();
  },

  jobs() {
    if (state.me.role === 'worker') return workerJobList();
    if (state.jobScreen === 'new') {
      $('#view').innerHTML = jobForm();
      return Promise.resolve();
    }
    return state.jobScreen ? employerApplicants(state.jobScreen) : employerJobList();
  },

  // ---------- employer: shortlist ----------

  async shortlist() {
    const [workers, unread] = await Promise.all([api('GET', '/api/shortlist'), api('GET', '/api/chats/unread')]);
    const badge = { pending: '<span class="chip">Awaiting reply</span>', accept: '<span class="chip solid">Matched</span>', decline: '<span class="chip off">Declined</span>' };
    $('#view').innerHTML = workers.length
      ? `<div class="list">
          <h2>Your shortlist</h2>
          <p class="muted small">Workers you accepted. Contact details appear once they accept you back.</p>
          ${workers
            .map(
              (w) => `<article class="item ${w.status === 'accept' ? 'matched' : ''}">
                <div class="item-head">
                  <div class="avatar">${picture(w)}</div>
                  <div class="grow"><h3>${esc(w.name)}, ${w.age}</h3><div class="muted small">${esc(w.location)}</div></div>
                  ${badge[w.status]}
                </div>
                ${w.phone ? `<div class="contact">Call ${esc(w.name.split(' ')[0])}: <a href="tel:${esc(w.phone)}">${esc(w.phone)}</a></div>` : ''}
                <details><summary>View full profile</summary><div>${workerChips(w)}${workerDetails(w)}</div></details>
                <div class="item-actions">
                  <button class="btn plain sm" data-action="remove-shortlist" data-id="${w.id}">Remove from shortlist</button>
                  ${w.status === 'accept' ? chatButton(w.id, unread.by[w.id]) : ''}
                </div>
              </article>`
            )
            .join('')}
        </div>`
      : emptyState('Your shortlist is empty', 'Accept a worker while browsing and they will appear here.');
  },

  // ---------- worker: requests ----------

  async requests() {
    const [employers, unread] = await Promise.all([api('GET', '/api/requests'), api('GET', '/api/chats/unread')]);
    $('#view').innerHTML = employers.length
      ? `<div class="list">
          <h2>Interested employers</h2>
          <p class="muted small">These employers would like to hire you. Accept to share phone numbers with each other.</p>
          ${employers
            .map(
              (e) => `<article class="item ${e.status === 'accept' ? 'matched' : ''}">
                <div class="item-head">
                  <div class="avatar"><div class="initials">${initials(e.name)}</div></div>
                  <div class="grow"><h3>${esc(e.name)}, ${e.age}</h3><div class="muted small">${esc(e.location)}</div></div>
                  ${e.status === 'accept' ? '<span class="chip solid">Matched</span>' : '<span class="chip">New</span>'}
                </div>
                <dl>
                  <dt>Kids in the home</dt><dd>${e.num_kids || 'None'}</dd>
                  <dt>House size</dt><dd>${esc(e.house_size)}</dd>
                  <dt>Religion</dt><dd>${esc(e.religion)}</dd>
                </dl>
                ${
                  e.status === 'accept'
                    ? `<div class="contact">Call ${esc(e.name.split(' ')[0])}: <a href="tel:${esc(e.phone)}">${esc(e.phone)}</a></div>
                      <div class="item-actions">${chatButton(e.id, unread.by[e.id])}</div>`
                    : `<div class="item-actions">
                        <button class="btn plain sm" data-action="respond" data-id="${e.id}" data-response="decline">Decline</button>
                        <button class="btn sm" data-action="respond" data-id="${e.id}" data-response="accept">Accept</button>
                      </div>`
                }
              </article>`
            )
            .join('')}
        </div>`
      : emptyState('No requests yet', 'When an employer accepts your profile, their request will appear here.');
  },

  // ---------- profile (both roles) ----------

  async profile() {
    const { role, profile, phone } = state.me;
    state.images = role === 'worker' ? { photo: profile.photo, good_conduct_doc: profile.good_conduct_doc } : {};
    $('#view').innerHTML = `
      <section class="page">
        <h2>Your profile</h2>
        <p class="muted">Signed in as ${esc(phone)} · ${role === 'employer' ? 'Employer' : 'Domestic worker'}</p>
        <form id="profile-form">
          ${role === 'employer' ? employerFields(profile) : workerFields(profile)}
          <button class="btn" type="submit">Save changes</button>
          ${role === 'employer' ? '<button class="btn plain" type="button" data-action="restore-rejected">Show rejected profiles again</button>' : ''}
        </form>
      </section>`;
    syncConditionals($('#profile-form'));
  },
};

// ---------- events ----------

const actions = {
  go: (el) => (el.dataset.screen === 'landing' ? renderLanding() : renderAuth(el.dataset.screen)),
  tab(el) {
    state.tab = el.dataset.tab;
    state.jobScreen = null;
    renderHome();
  },
  'job-screen'(el) {
    const screen = el.dataset.screen;
    state.jobScreen = screen === 'new' ? 'new' : screen ? Number(screen) : null;
    window.scrollTo(0, 0);
    return views.jobs();
  },
  async 'job-status'(el) {
    await api('PUT', `/api/jobs/${el.dataset.id}/status`, { status: el.dataset.status });
    toast(el.dataset.status === 'closed' ? 'Vacancy closed. Workers can no longer apply.' : 'Vacancy reopened.');
    await views.jobs();
  },
  async applicant(el) {
    await api('POST', `/api/jobs/${el.dataset.job}/applicants/${el.dataset.id}`, { decision: el.dataset.decision });
    toast(el.dataset.decision === 'accept' ? 'Applicant accepted. You can now call each other.' : 'Applicant declined.');
    await views.jobs();
  },
  async withdraw(el) {
    await api('DELETE', `/api/jobs/${el.dataset.id}/apply`);
    toast('Application withdrawn.');
    await views.jobs();
  },
  'open-chat': (el) => openChat(Number(el.dataset.id)),
  'close-chat'() {
    stopChat();
    return views[state.tab]();
  },
  async logout() {
    stopChat();
    clearInterval(unreadTimer);
    await api('POST', '/api/logout', {});
    Object.assign(state, { me: null, tab: null, deck: [], filters: noFilters() });
    renderLanding();
  },
  'clear-filters'() {
    state.filters = noFilters();
    return views.browse();
  },
  'toggle-password'(el) {
    const field = el.previousElementSibling;
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    el.textContent = show ? 'Hide' : 'Show';
    el.setAttribute('aria-pressed', String(show));
    el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  },
  'add-job': () => $('#jobs').insertAdjacentHTML('beforeend', jobFields()),
  'remove-job': (el) => el.closest('.job').remove(),
  decide: (el) => decide(el.dataset.decision),
  'browse-step': (el) => browse(Number(el.dataset.step)),
  'reload-deck': () => loadDeck(),
  async 'remove-shortlist'(el) {
    await api('DELETE', `/api/decisions/${el.dataset.id}`);
    await views.shortlist();
  },
  async 'restore-rejected'() {
    const { restored } = await api('DELETE', '/api/rejections');
    toast(restored ? `${plural(restored, 'profile')} returned to Browse.` : 'You have no rejected profiles.');
  },
  async respond(el) {
    await api('POST', `/api/requests/${el.dataset.id}`, { response: el.dataset.response });
    toast(el.dataset.response === 'accept' ? "It's a match! You can now call each other." : 'Request declined.');
    await views.requests();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) Promise.resolve(actions[el.dataset.action](el)).catch((err) => toast(err.message));
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-image]') && el.files[0]) {
    try {
      const data = await resizeImage(el.files[0], Number(el.dataset.max));
      state.images[el.dataset.image] = data;
      const preview = $(`[data-preview="${el.dataset.image}"]`);
      preview.src = data;
      preview.hidden = false;
      preview.nextElementSibling?.classList.contains('ph') && preview.nextElementSibling.remove();
    } catch (err) {
      el.value = '';
      toast(err.message);
    }
  } else if (el.form?.id === 'job-filter') {
    state.jobArea = el.value.trim();
    workerJobList().catch((err) => toast(err.message));
  } else if (el.form?.id === 'filter-form') {
    for (const name of Object.keys(state.filters)) state.filters[name] = el.form[name].value.trim();
    $('#filter-summary').textContent = filterSummary();
    loadDeck().catch((err) => toast(err.message));
  } else if (el.form) {
    syncConditionals(el.form);
  }
});

// Turns the password hint gold with a tick once the rule is met.
document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-pw-rule]')) return;
  const ok = passwordOk(e.target.value);
  const hint = $('#pw-hint');
  hint.classList.toggle('ok', ok);
  hint.textContent = ok ? `✓ ${PASSWORD_RULE}` : PASSWORD_RULE;
  e.target.setCustomValidity(ok || !e.target.value ? '' : PASSWORD_RULE);
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'filter-form' || form.id === 'job-filter') return document.activeElement.blur(); // blur fires the change handler
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    if (form.id === 'login-form') {
      state.me = await api('POST', '/api/login', { phone: form.phone.value, password: form.password.value });
      renderHome();
    } else if (form.id === 'register-form') {
      const role = form.dataset.role;
      if (role === 'worker' && !state.images.photo) throw new Error('Please add a photo of yourself');
      state.me = await api('POST', '/api/register', {
        role,
        phone: form.phone.value,
        password: form.password.value,
        profile: readProfile(form, role),
      });
      renderHome();
      toast('Welcome to HomeConnect!');
    } else if (form.id === 'chat-form') {
      const text = form.body.value.trim();
      if (!text) return;
      const message = await api('POST', `/api/chats/${state.chat.otherId}`, { body: text });
      form.body.value = '';
      appendMessages([message]);
      form.body.focus();
    } else if (form.id === 'job-form') {
      const f = new FormData(form);
      await api('POST', '/api/jobs', Object.fromEntries(['title', 'location', 'work_type', 'salary', 'start_date', 'duties', 'requirements'].map((k) => [k, f.get(k) ?? ''])));
      state.jobScreen = null;
      await views.jobs();
      toast('Vacancy posted. Workers can now apply.');
    } else if (form.classList.contains('apply-form')) {
      await api('POST', `/api/jobs/${form.dataset.job}/apply`, { message: form.message.value });
      toast('Application sent!');
      await views.jobs();
    } else if (form.id === 'profile-form') {
      state.me = await api('PUT', '/api/profile', readProfile(form, state.me.role));
      toast('Profile saved.');
    }
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  // Enter sends a chat message; Shift+Enter starts a new line.
  if (e.target.matches?.('#chat-form textarea') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
    return;
  }
  if (!e.target.matches?.('.card.top')) return;
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  const decision = { ArrowUp: 'accept', ArrowDown: 'reject' }[e.key];
  if (!step && !decision) return;
  e.preventDefault();
  if (step) browse(step);
  else decide(decision);
});

// ---------- start ----------

api('GET', '/api/me')
  .then((me) => {
    state.me = me;
    renderHome();
  })
  .catch(renderLanding);
