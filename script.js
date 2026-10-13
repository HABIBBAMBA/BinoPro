/* ============================================================
   BinômagePro — script.js
   ------------------------------------------------------------
   Toute la logique de l'application (sans backend, sans base de
   données) :
     1. Utilitaires & notifications
     2. Stockage des photos (IndexedDB)
     3. Modèle de données & persistance (localStorage)
     4. Rendu de l'interface
     5. Gestion des participants (CRUD, photos, CSV, ajout rapide)
     6. Binômage aléatoire + animation de révélation
     7. Résultats, export CSV, impression
     8. Sauvegarde JSON / restauration / réinitialisation
     9. Initialisation
   ============================================================ */
'use strict';

/* ============================================================
   1. UTILITAIRES & NOTIFICATIONS
   ============================================================ */

/** Échappe le HTML pour éviter les injections de texte utilisateur. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Génère un identifiant unique simple. */
function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Mélange un tableau (Fisher-Yates) — ne modifie pas l'original. */
function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Petite temporisation asynchrone (utile pour les animations). */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Affiche une notification (toast) : success | error | info | warning. */
function showToast(message, type = 'info') {
  const icons = {
    success: 'bi-check-lg',
    error: 'bi-exclamation-octagon',
    info: 'bi-info-circle',
    warning: 'bi-exclamation-triangle'
  };
  const el = document.createElement('div');
  el.className = `toast toast-custom toast-${type}`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <div class="toast-body">
      <div class="t-icon"><i class="bi ${icons[type] || icons.info}"></i></div>
      <div>${escapeHtml(message)}</div>
    </div>`;
  document.getElementById('toastContainer').appendChild(el);
  const toast = new bootstrap.Toast(el, { delay: 3600 });
  toast.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

/* --- Fenêtre de confirmation réutilisable (renvoie une Promise) --- */
function askConfirm({ title, message, okLabel = 'Confirmer', danger = false, cancelLabel = 'Annuler' }) {
  return new Promise(resolve => {
    const modalEl = document.getElementById('confirmModal');
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    const iconEl = document.getElementById('confirmIcon');

    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').innerHTML = message;
    okBtn.innerHTML = `<i class="bi ${danger ? 'bi-trash3' : 'bi-check-lg'}"></i> ${escapeHtml(okLabel)}`;
    cancelBtn.textContent = cancelLabel;
    iconEl.className = 'confirm-icon' + (danger ? ' danger' : '');

    let answered = false;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

    okBtn.onclick = () => { answered = true; modal.hide(); resolve(true); };
    cancelBtn.onclick = () => { answered = true; modal.hide(); resolve(false); };
    modalEl.addEventListener('hidden.bs.modal', () => {
      okBtn.onclick = null;
      if (!answered) resolve(false);
    }, { once: true });

    modal.show();
  });
}

/* ============================================================
   2. STOCKAGE DES PHOTOS (IndexedDB)
   Les photos sont conservées dans IndexedDB afin d'éviter la
   limite de taille du localStorage (≈ 5 Mo).
   ============================================================ */
const PhotoStore = {
  DB_NAME: 'binomagepro_photos',
  STORE: 'photos',
  db: null,

  async init() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this.DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(this.STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('IndexedDB indisponible : les photos seront stockées dans le localStorage.', err);
      this.db = null;
    }
  },

  _tx(mode, action) {
    return new Promise(resolve => {
      if (!this.db) return resolve(null);
      try {
        const tx = this.db.transaction(this.STORE, mode);
        const store = tx.objectStore(this.STORE);
        const req = action(store);
        tx.oncomplete = () => resolve(req ? req.result : true);
        tx.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  },

  put(id, dataUrl) { return this._tx('readwrite', s => s.put(dataUrl, id)); },
  get(id) { return this._tx('readonly', s => s.get(id)); },
  del(id) { return this._tx('readwrite', s => s.delete(id)); },
  clear() { return this._tx('readwrite', s => s.clear()); }
};

/* ============================================================
   3. MODÈLE DE DONNÉES & PERSISTANCE
   ============================================================ */
const STORAGE_KEY = 'binomagepro_state_v1';
const PHOTO_MAX = 420; // taille max (px) des photos redimensionnées

/**
 * Structure des données :
 *  participants : { id, firstName, lastName, identifier, group, hasPhoto }
 *  pairs        : { id, sponsorId, godchildId }
 *  photoCache   : { [id]: dataUrl }  (mémoire + IndexedDB)
 */
const state = {
  sponsors: [],
  godchildren: [],
  pairs: [],
  settings: { allowMultiple: false },
  isDemo: false,
  demoIds: [],
  drawAt: null
};
let photoCache = {};
let isDrawing = false; // verrou anti-clics multiples pendant l'animation

/** Enregistre les données textuelles dans le localStorage. */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sponsors: state.sponsors,
      godchildren: state.godchildren,
      pairs: state.pairs,
      settings: state.settings,
      isDemo: state.isDemo,
      demoIds: state.demoIds || [],
      drawAt: state.drawAt
    }));
  } catch (err) {
    showToast('Espace de stockage insuffisant. Exportez une sauvegarde puis réinitialisez.', 'error');
  }
}

/** Charge les données depuis le localStorage, puis les photos depuis IndexedDB. */
async function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.sponsors = Array.isArray(data.sponsors) ? data.sponsors : [];
      state.godchildren = Array.isArray(data.godchildren) ? data.godchildren : [];
      state.pairs = Array.isArray(data.pairs) ? data.pairs : [];
      state.settings = Object.assign({ allowMultiple: false }, data.settings || {});
      state.isDemo = !!data.isDemo;
      state.demoIds = Array.isArray(data.demoIds) ? data.demoIds : [];
      state.drawAt = data.drawAt || null;
    }
  } catch (err) {
    console.warn('Données locales illisibles, réinitialisation.', err);
  }

  // Hydratation des photos
  for (const p of [...state.sponsors, ...state.godchildren]) {
    if (p.hasPhoto) {
      const img = await PhotoStore.get(p.id);
      if (img) photoCache[p.id] = img;
    }
  }
}

/* ============================================================
   3b. AVATARS DE DÉMONSTRATION (générés en SVG, sans réseau)
   ============================================================ */

/** Retourne un data-URI SVG avec les initiales du participant. */
function initialAvatar(initials, seed = '') {
  const palettes = [
    ['#2563EB', '#7C3AED'], ['#7C3AED', '#DB2777'], ['#0EA5E9', '#2563EB'],
    ['#12B76A', '#0EA5E9'], ['#F79009', '#EF4444'], ['#6366F1', '#2563EB']
  ];
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  const [c1, c2] = palettes[hash % palettes.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="200" height="200" fill="url(#g)"/>
    <text x="100" y="128" font-family="Inter,Arial" font-size="86" font-weight="700"
      fill="rgba(255,255,255,.94)" text-anchor="middle">${escapeHtml(String(initials || '?').toUpperCase())}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

/** URL d'affichage d'une photo (photo réelle ou avatar généré). */
function photoOf(participant) {
  return photoCache[participant.id] || initialAvatar(
    (participant.firstName || '?').charAt(0) + (participant.lastName || '').charAt(0),
    participant.id
  );
}

/** Redimensionne une image importée et la convertit en data-URL JPEG. */
function fileToPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('Le fichier sélectionné n\'est pas une image.'));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Impossible de lire le fichier.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image illisible ou format non supporté.'));
      img.onload = () => {
        const scale = Math.min(1, PHOTO_MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   4. RENDU DE L'INTERFACE
   ============================================================ */

const VIEWS = {
  dashboard: { title: 'Tableau de bord', subtitle: 'Vue d\'ensemble du binômage' },
  parrains: { title: 'Parrains', subtitle: 'Gestion des parrains' },
  filleuls: { title: 'Filleuls', subtitle: 'Gestion des filleuls' },
  binomage: { title: 'Binômage', subtitle: 'Préparation et lancement du tirage' },
  resultats: { title: 'Résultats', subtitle: 'Binômes, exports et impression' },
  donnees: { title: 'Données & sauvegarde', subtitle: 'Stockage local, export et restauration' }
};

/** Affiche une vue et masque les autres. */
function showView(name) {
  if (!VIEWS[name]) return;
  document.querySelectorAll('.view').forEach(v => v.classList.add('d-none'));
  document.getElementById('view-' + name).classList.remove('d-none');

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });

  document.getElementById('pageTitle').textContent = VIEWS[name].title;
  document.getElementById('pageSubtitle').textContent = VIEWS[name].subtitle;

  // Referme le menu mobile
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');

  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Rafraîchit toutes les vues. */
function renderAll() {
  renderDashboard();
  renderParticipants('sponsor');
  renderParticipants('godchild');
  renderDrawSummary();
  renderResults();
  renderStorageInfo();
  renderNavCounts();
}

function renderNavCounts() {
  document.getElementById('navCountSponsors').textContent = state.sponsors.length;
  document.getElementById('navCountGc').textContent = state.godchildren.length;
  document.getElementById('navCountPairs').textContent = state.pairs.length;
  const total = state.sponsors.length + state.godchildren.length;
  document.getElementById('topParticipants').textContent =
    total + (total > 1 ? ' participants' : ' participant');
  document.getElementById('sidebarStorage').textContent =
    'Stockage navigateur · ' + total + ' participant' + (total > 1 ? 's' : '');
}

/* ---------- Tableau de bord ---------- */
function renderDashboard() {
  const nS = state.sponsors.length;
  const nG = state.godchildren.length;
  const nP = state.pairs.length;

  // Statistiques
  setText('statSponsors', nS);
  setText('statGc', nG);
  setText('statPairs', nP);

  const matchedSponsors = new Set(state.pairs.map(p => p.sponsorId));
  const matchedGc = new Set(state.pairs.map(p => p.godchildId));
  const remaining = (nS - matchedSponsors.size) + (nG - matchedGc.size);
  setText('statRemaining', remaining);

  setText('statSponsorsHint', nS ? 'Prêts pour le tirage' : 'Aucun parrain enregistré');
  setText('statGcHint', nG ? 'Prêts pour le tirage' : 'Aucun filleul enregistré');
  setText('statPairsHint', nP ? 'Tirage du ' + formatDateTime(state.drawAt) : 'Tirage non effectué');
  setText('statRemainingHint', remaining ? 'Participants sans binôme' : 'Tous les participants sont attribués');

  // Progression
  const possible = Math.min(nS, nG);
  const pct = possible ? Math.round((nP / possible) * 100) : 0;
  document.getElementById('progressFill').style.width = Math.min(100, pct) + '%';
  setText('progressText', Math.min(100, pct) + ' %');
  setText('legendPaired', nP);
  setText('legendPending', remaining);

  // Message de disponibilité
  const readiness = document.getElementById('drawReadiness');
  let msg, icon = 'bi-info-circle';
  if (!nS && !nG) msg = 'Chargez des parrains et des filleuls pour démarrer.';
  else if (!nS) msg = 'Ajoutez au moins un parrain pour lancer le tirage.';
  else if (!nG) msg = 'Ajoutez au moins un filleul pour lancer le tirage.';
  else if (nG > nS) {
    msg = `Attention : ${nG} filleuls pour ${nS} parrains. Plusieurs filleuls pourront être attribués à un même parrain.`;
    icon = 'bi-exclamation-triangle';
  } else if (nS > nG) {
    msg = `${nS - nG} parrain(s) resteront sans filleul : c'est normal, le tirage est équitable.`;
  } else {
    msg = 'Les listes sont équilibrées : chaque parrain recevra un filleul.';
  }
  readiness.innerHTML = `<i class="bi ${icon}"></i><span>${escapeHtml(msg)}</span>`;

  // Derniers binômes
  const recent = document.getElementById('recentPairs');
  if (!state.pairs.length) {
    recent.innerHTML = `
      <div class="mini-alert"><i class="bi bi-stars"></i>
      <span>Aucun binôme pour le moment. Lancez un premier tirage pour les voir apparaître ici.</span></div>`;
    return;
  }
  recent.innerHTML = state.pairs.slice(-4).reverse().map((pair, i) => {
    const s = findParticipant(pair.sponsorId);
    const g = findParticipant(pair.godchildId);
    if (!s || !g) return '';
    return `
      <div class="recent-item">
        <div class="recent-num">#${String(state.pairs.length - i).padStart(3, '0')}</div>
        <div class="recent-photos">
          <img src="${photoOf(s)}" alt="">
          <img src="${photoOf(g)}" alt="">
        </div>
        <i class="bi bi-arrow-right recent-arrow"></i>
        <div class="recent-names">
          <strong>${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)} &amp; ${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</strong>
          <small>${escapeHtml(s.group || 'Sans filière')} → ${escapeHtml(g.group || 'Sans filière')}</small>
        </div>
      </div>`;
  }).join('');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { return '—'; }
}

/* ---------- Cartes participants (parrains / filleuls) ---------- */
function renderParticipants(role) {
  const isSponsor = role === 'sponsor';
  const list = isSponsor ? state.sponsors : state.godchildren;
  const search = (document.getElementById(isSponsor ? 'searchSponsors' : 'searchGc').value || '')
    .trim().toLowerCase();

  const filtered = list.filter(p =>
    !search ||
    `${p.firstName} ${p.lastName} ${p.identifier || ''} ${p.group || ''}`.toLowerCase().includes(search)
  );

  const grid = document.getElementById(isSponsor ? 'gridSponsors' : 'gridGc');
  const empty = document.getElementById(isSponsor ? 'emptySponsors' : 'emptyGc');

  if (!list.length) {
    grid.innerHTML = '';
    grid.classList.add('d-none');
    empty.classList.remove('d-none');
    return;
  }
  grid.classList.remove('d-none');
  empty.classList.add('d-none');

  if (!filtered.length) {
    grid.innerHTML = `<div class="mini-alert"><i class="bi bi-search"></i>
      <span>Aucun participant ne correspond à «&nbsp;${escapeHtml(search)}&nbsp;».</span></div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => `
    <article class="person-card">
      <div class="person-top">
        <img class="person-photo" src="${photoOf(p)}" alt="Photo de ${escapeHtml(p.firstName)}">
        <div class="person-ident">
          <h4 title="${escapeHtml(p.firstName + ' ' + p.lastName)}">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</h4>
          <div class="pid">${escapeHtml(p.identifier || 'Sans identifiant')}</div>
        </div>
      </div>
      <div class="badge-group ${p.group ? '' : 'none'}">
        <i class="bi bi-mortarboard"></i> ${escapeHtml(p.group || 'Filière non renseignée')}
      </div>
      <div class="person-actions">
        <button class="btn-ghost" data-action="edit" data-role="${role}" data-id="${p.id}">
          <i class="bi bi-pencil"></i> Modifier
        </button>
        <button class="btn-ghost danger" data-action="delete" data-role="${role}" data-id="${p.id}">
          <i class="bi bi-trash3"></i> Supprimer
        </button>
      </div>
    </article>`).join('');
}

/* ---------- Binômage : récapitulatif ---------- */
function renderDrawSummary() {
  const nS = state.sponsors.length;
  const nG = state.godchildren.length;
  const possible = Math.min(nS, nG);

  setText('recapSponsors', nS);
  setText('recapGc', nG);
  setText('recapPossible', possible);

  // Avertissement + option "plusieurs filleuls par parrain"
  const warn = document.getElementById('drawWarning');
  const multiWrap = document.getElementById('multiOptionWrap');
  const warnBox = document.getElementById('drawWarnBox');
  const multiWrapModal = document.getElementById('allowMultipleWrap');

  const needWarn = nG > nS && nS > 0;
  const warnText = needWarn
    ? `Il y a ${nG} filleuls pour ${nS} parrains. ${nG - nS} filleul(s) excédentaire(s) : souhaitez-vous autoriser plusieurs filleuls par parrain ?`
    : (nS > nG && nG > 0
      ? `${nS - nG} parrain(s) resteront sans filleul après le tirage.`
      : '');

  warn.classList.toggle('d-none', !warnText);
  if (warnText) warn.querySelector('span').textContent = warnText;
  warnBox.classList.toggle('d-none', !needWarn);
  if (needWarn) warnBox.querySelector('span').textContent =
    `${nG - nS} filleul(s) sans parrain si vous refusez l'attribution multiple.`;

  multiWrap.classList.toggle('d-none', !needWarn);
  multiWrapModal.classList.toggle('d-none', !needWarn);

  const cb1 = document.getElementById('allowMultipleCheck');
  const cb2 = document.getElementById('allowMultipleCheckModal');
  cb1.checked = !!state.settings.allowMultiple;
  cb2.checked = !!state.settings.allowMultiple;

  // Bouton "recommencer"
  document.getElementById('btnRestartDraw').classList.toggle('d-none', !state.pairs.length);

  // Participants non appariés
  const box = document.getElementById('unassignedList');
  const matchedS = new Set(state.pairs.map(p => p.sponsorId));
  const matchedG = new Set(state.pairs.map(p => p.godchildId));
  const restS = state.sponsors.filter(p => !matchedS.has(p.id));
  const restG = state.godchildren.filter(p => !matchedG.has(p.id));

  if (!restS.length && !restG.length) {
    box.innerHTML = `<div class="mini-alert"><i class="bi bi-check-circle"></i>
      <span>${state.pairs.length ? 'Tous les participants concernés sont appariés.' : 'Aucun participant enregistré pour le moment.'}</span></div>`;
    return;
  }
  box.innerHTML = [...restS.map(p => ({ p, tag: 'sponsor', label: 'Parrain' })),
  ...restG.map(p => ({ p, tag: 'godchild', label: 'Filleul' }))]
    .map(({ p, tag, label }) => `
      <div class="unassigned-item">
        <img src="${photoOf(p)}" alt="">
        <div>
          <strong>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</strong>
          <div class="muted" style="font-size:11.5px">${escapeHtml(p.group || 'Sans filière')}</div>
        </div>
        <span class="tag ${tag}">${label}</span>
      </div>`).join('');
}

/* ---------- Résultats ---------- */
function renderResults() {
  const grid = document.getElementById('gridResults');
  const tbody = document.getElementById('resultsTableBody');
  const empty = document.getElementById('emptyResults');
  const search = (document.getElementById('searchResults').value || '').trim().toLowerCase();
  const groupFilter = document.getElementById('filterGroup').value;

  setText('resultsCount', state.pairs.length);

  // Alimentation du filtre "filière"
  const groups = [...new Set([...state.sponsors, ...state.godchildren]
    .map(p => p.group).filter(Boolean))].sort();
  const select = document.getElementById('filterGroup');
  const current = select.value;
  select.innerHTML = '<option value="">Toutes les filières</option>' +
    groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  select.value = groups.includes(current) ? current : '';

  if (!state.pairs.length) {
    grid.innerHTML = '';
    grid.classList.add('d-none');
    empty.classList.remove('d-none');
    tbody.innerHTML = '<tr><td colspan="7" class="text-center muted py-4">Aucun binôme à afficher.</td></tr>';
    return;
  }
  grid.classList.remove('d-none');
  empty.classList.add('d-none');

  const rows = state.pairs.map((pair, index) => ({
    pair, index,
    s: findParticipant(pair.sponsorId),
    g: findParticipant(pair.godchildId)
  })).filter(r => r.s && r.g);

  const visible = rows.filter(({ s, g }) => {
    const matchSearch = !search ||
      `${s.firstName} ${s.lastName} ${g.firstName} ${g.lastName}`.toLowerCase().includes(search);
    const matchGroup = !groupFilter || s.group === groupFilter || g.group === groupFilter;
    return matchSearch && matchGroup;
  });

  // Cartes
  grid.innerHTML = visible.map(({ pair, index, s, g }) => {
    const extra = state.pairs.filter(p => p.sponsorId === pair.sponsorId && p.id !== pair.id);
    const extrasHtml = extra.map(p => {
      const gg = findParticipant(p.godchildId);
      return gg ? `
        <div class="mini-person">
          <img src="${photoOf(gg)}" alt="">
          <span>${escapeHtml(gg.firstName)} ${escapeHtml(gg.lastName)}</span>
          <span class="label">Filleul supplémentaire</span>
        </div>` : '';
    }).join('');

    return `
      <article class="pair-card">
        <div class="pair-head">
          <span class="pair-badge"><i class="bi bi-link-45deg"></i> BINÔME N° ${String(index + 1).padStart(3, '0')}</span>
          ${extra.length ? '<span class="pair-tag multi">Parrain polyvalent</span>' : ''}
        </div>
        <div class="pair-body">
          <div class="pair-person">
            <img src="${photoOf(s)}" alt="Photo du parrain">
            <span class="pair-role sponsor">Parrain</span>
            <strong>${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}</strong>
            <small>${escapeHtml(s.identifier || s.group || '')}</small>
          </div>
          <div class="pair-link"><i class="bi bi-arrow-right"></i></div>
          <div class="pair-person">
            <img src="${photoOf(g)}" alt="Photo du filleul">
            <span class="pair-role godchild">Filleul</span>
            <strong>${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</strong>
            <small>${escapeHtml(g.identifier || g.group || '')}</small>
          </div>
        </div>
        ${extrasHtml ? `<div class="pair-multi">${extrasHtml}</div>` : ''}
      </article>`;
  }).join('');

  // Tableau récapitulatif
  tbody.innerHTML = visible.map(({ index, s, g }) => `
    <tr>
      <td><strong>${String(index + 1).padStart(3, '0')}</strong></td>
      <td><div class="cell-person"><img src="${photoOf(s)}" alt="">${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}</div></td>
      <td>${escapeHtml(s.identifier || '—')}</td>
      <td>${escapeHtml(s.group || '—')}</td>
      <td><div class="cell-person"><img src="${photoOf(g)}" alt="">${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</div></td>
      <td>${escapeHtml(g.identifier || '—')}</td>
      <td>${escapeHtml(g.group || '—')}</td>
    </tr>`).join('');
}

/* ---------- Informations de stockage ---------- */
function renderStorageInfo() {
  const photos = Object.keys(photoCache).length;
  const weight = new Blob([JSON.stringify(state)]).size + photos * 22000;
  setText('storageParticipants', state.sponsors.length + state.godchildren.length);
  setText('storagePhotos', photos);
  setText('storagePairs', state.pairs.length);
  setText('storageWeight', weight > 1048576
    ? (weight / 1048576).toFixed(2) + ' Mo'
    : Math.max(1, Math.round(weight / 1024)) + ' Ko');
}

/* ============================================================
   5. GESTION DES PARTICIPANTS
   ============================================================ */

/** Retrouve un participant (parrain ou filleul) par son identifiant. */
function findParticipant(id) {
  return state.sponsors.find(p => p.id === id) || state.godchildren.find(p => p.id === id) || null;
}

function listByRole(role) {
  return role === 'sponsor' ? state.sponsors : state.godchildren;
}

/** Vérifie l'unicité du couple prénom + nom dans une liste. */
function isDuplicate(list, firstName, lastName, excludeId = null) {
  const key = (firstName + '|' + lastName).toLowerCase().trim();
  return list.some(p => p.id !== excludeId &&
    (p.firstName + '|' + p.lastName).toLowerCase().trim() === key);
}

/* ---------- Modale d'ajout / modification ---------- */
let pendingPhoto = null; // photo sélectionnée dans le formulaire

function openParticipantModal(role, participantId = null) {
  const modalEl = document.getElementById('participantModal');
  const form = document.getElementById('participantForm');
  form.reset();
  form.classList.remove('was-validated');
  document.querySelectorAll('#participantForm .custom-input').forEach(i => i.classList.remove('is-invalid'));

  document.getElementById('pRole').value = role;
  document.getElementById('pEditId').value = participantId || '';
  document.getElementById('participantModalTitle').textContent =
    (participantId ? 'Modifier' : 'Ajouter') + (role === 'sponsor' ? ' un parrain' : ' un filleul');

  pendingPhoto = null;
  const imgEl = document.getElementById('pPhotoImg');
  const placeholder = document.querySelector('#pPhotoPreview i');
  imgEl.classList.add('d-none');
  placeholder.classList.remove('d-none');
  document.getElementById('pPhotoRemove').classList.add('d-none');

  if (participantId) {
    const p = findParticipant(participantId);
    if (!p) return;
    document.getElementById('pFirstName').value = p.firstName;
    document.getElementById('pLastName').value = p.lastName;
    document.getElementById('pIdentifier').value = p.identifier || '';
    document.getElementById('pGroup').value = p.group || '';
    if (photoCache[p.id]) {
      pendingPhoto = photoCache[p.id];
      imgEl.src = pendingPhoto;
      imgEl.classList.remove('d-none');
      placeholder.classList.add('d-none');
      document.getElementById('pPhotoRemove').classList.remove('d-none');
    }
  }
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

/* Aperçu immédiat de la photo sélectionnée */
document.getElementById('pPhotoInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    pendingPhoto = await fileToPhoto(file);
    const imgEl = document.getElementById('pPhotoImg');
    imgEl.src = pendingPhoto;
    imgEl.classList.remove('d-none');
    document.querySelector('#pPhotoPreview i').classList.add('d-none');
    document.getElementById('pPhotoRemove').classList.remove('d-none');
    showToast('Photo importée. Elle sera enregistrée avec le participant.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('pPhotoRemove').addEventListener('click', () => {
  pendingPhoto = null;
  document.getElementById('pPhotoInput').value = '';
  document.getElementById('pPhotoImg').classList.add('d-none');
  document.querySelector('#pPhotoPreview i').classList.remove('d-none');
  document.getElementById('pPhotoRemove').classList.add('d-none');
});

/* Enregistrement du formulaire participant */
document.getElementById('participantForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const role = document.getElementById('pRole').value;
  const editId = document.getElementById('pEditId').value;
  const list = listByRole(role);

  const firstName = document.getElementById('pFirstName').value.trim();
  const lastName = document.getElementById('pLastName').value.trim();
  const identifier = document.getElementById('pIdentifier').value.trim();
  const group = document.getElementById('pGroup').value.trim();

  // Validation
  let valid = true;
  [['pFirstName', firstName], ['pLastName', lastName]].forEach(([id, value]) => {
    const input = document.getElementById(id);
    const ok = value.length > 0;
    input.classList.toggle('is-invalid', !ok);
    if (!ok) valid = false;
  });
  if (!valid) {
    showToast('Veuillez renseigner le prénom et le nom.', 'error');
    return;
  }
  if (isDuplicate(list, firstName, lastName, editId || null)) {
    showToast(`Un participant nommé « ${firstName} ${lastName} » existe déjà dans cette liste.`, 'error');
    return;
  }

  // Création ou mise à jour
  if (editId) {
    const p = findParticipant(editId);
    if (!p) return;
    p.firstName = firstName;
    p.lastName = lastName;
    p.identifier = identifier;
    p.group = group;
    if (pendingPhoto) {
      photoCache[p.id] = pendingPhoto;
      p.hasPhoto = true;
      await PhotoStore.put(p.id, pendingPhoto);
    } else if (p.hasPhoto) {
      delete photoCache[p.id];
      p.hasPhoto = false;
      await PhotoStore.del(p.id);
    }
    showToast('Participant mis à jour avec succès.', 'success');
  } else {
    const id = uid(role === 'sponsor' ? 'parrain' : 'filleul');
    const participant = { id, firstName, lastName, identifier, group, hasPhoto: !!pendingPhoto };
    list.push(participant);
    if (pendingPhoto) {
      photoCache[id] = pendingPhoto;
      await PhotoStore.put(id, pendingPhoto);
    }
    showToast(`${role === 'sponsor' ? 'Parrain' : 'Filleul'} ajouté avec succès.`, 'success');
  }

  saveState();
  renderAll();
  bootstrap.Modal.getInstance(document.getElementById('participantModal'))?.hide();
});

/* ---------- Suppression d'un participant ---------- */
async function deleteParticipant(role, id) {
  const list = listByRole(role);
  const p = list.find(x => x.id === id);
  if (!p) return;

  const confirmed = await askConfirm({
    title: 'Supprimer ce participant ?',
    message: `Le participant <b>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</b> sera définitivement retiré, ainsi que sa photo et ses binômes.`,
    okLabel: 'Supprimer',
    danger: true
  });
  if (!confirmed) return;

  const index = list.findIndex(x => x.id === id);
  list.splice(index, 1);
  if (p.hasPhoto) await PhotoStore.del(id);
  delete photoCache[id];

  // Retire les binômes concernés
  state.pairs = state.pairs.filter(pair => pair.sponsorId !== id && pair.godchildId !== id);

  saveState();
  renderAll();
  showToast('Participant supprimé.', 'success');
}

/* Délégation d'événements sur les cartes (modifier / supprimer) */
document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const { action, role, id } = btn.dataset;
  if (action === 'edit') openParticipantModal(role, id);
  if (action === 'delete') deleteParticipant(role, id);
});

/* ---------- Ajout rapide (plusieurs participants) ---------- */
function openMultiModal(role) {
  document.getElementById('multiForm').reset();
  document.getElementById('multiRole').value = role;
  document.getElementById('multiModalTitle').textContent =
    'Ajout rapide — ' + (role === 'sponsor' ? 'parrains' : 'filleuls');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('multiModal')).show();
}

document.getElementById('multiForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const role = document.getElementById('multiRole').value;
  const list = listByRole(role);
  const lines = document.getElementById('multiText').value
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (!lines.length) {
    showToast('Saisissez au moins une ligne.', 'error');
    return;
  }

  let added = 0, skipped = 0;
  for (const line of lines) {
    const parts = line.split(/[;|]/).map(x => x.trim());
    const nameParts = parts[0].split(/\s+/).filter(Boolean);
    if (nameParts.length < 2) { skipped++; continue; }
    const firstName = nameParts.shift();
    const lastName = nameParts.join(' ');
    const group = parts[1] || '';
    const identifier = parts[2] || '';

    if (isDuplicate(list, firstName, lastName)) { skipped++; continue; }

    list.push({ id: uid(role === 'sponsor' ? 'parrain' : 'filleul'), firstName, lastName, identifier, group, hasPhoto: false });
    added++;
  }

  saveState();
  renderAll();
  bootstrap.Modal.getInstance(document.getElementById('multiModal'))?.hide();

  if (added) showToast(`${added} participant(s) ajouté(s)${skipped ? `, ${skipped} ignoré(s)` : ''}.`, 'success');
  else showToast('Aucun participant valide à ajouter (format ou doublons).', 'error');
});

/* ---------- Import CSV ---------- */
let csvRows = [];

function detectDelimiter(line) {
  const counts = { ';': (line.match(/;/g) || []).length, ',': (line.match(/,/g) || []).length, '\t': (line.match(/\t/g) || []).length };
  return Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b);
}

/** Découpe une ligne CSV en gérant les guillemets. */
function splitCsvLine(line, delimiter) {
  const out = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(current.trim()); current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  const rows = lines.map(line => splitCsvLine(line, delimiter));

  // Détection d'une ligne d'en-tête
  const first = rows[0].map(c => c.toLowerCase());
  const hasHeader = first.some(c => /pr[ée]nom|nom|identifiant|fili/i.test(c));
  const body = hasHeader ? rows.slice(1) : rows;

  let colFirst = 0, colLast = 1, colId = 2, colGroup = 3;
  if (hasHeader) {
    const find = (re) => first.findIndex(c => re.test(c));
    const f = find(/pr[ée]nom/);
    // « nom » sans correspondance avec « prénom »
    const l = first.findIndex(c => /nom/.test(c) && !/pr[ée]nom/.test(c));
    const i = find(/identifiant|code/), g = find(/fili|classe|promo/);
    colFirst = f >= 0 ? f : 0;
    colLast = l >= 0 ? l : 1;
    colId = i;      // -1 si la colonne est absente
    colGroup = g;   // -1 si la colonne est absente
  }

  const cell = (cols, index) => (index >= 0 ? (cols[index] || '').trim() : '');

  return body.map(cols => ({
    firstName: cell(cols, colFirst),
    lastName: cell(cols, colLast),
    identifier: cell(cols, colId),
    group: cell(cols, colGroup)
  })).filter(r => r.firstName && r.lastName);
}

function openCsvModal(role) {
  document.getElementById('csvForm').reset();
  document.getElementById('csvRole').value = role;
  document.getElementById('csvPreviewWrap').classList.add('d-none');
  document.getElementById('csvModalTitle').textContent =
    'Importer une liste de ' + (role === 'sponsor' ? 'parrains' : 'filleuls');
  csvRows = [];
  bootstrap.Modal.getOrCreateInstance(document.getElementById('csvModal')).show();
}

document.getElementById('csvFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    csvRows = parseCsv(text);
    const wrap = document.getElementById('csvPreviewWrap');
    const body = document.getElementById('csvPreviewBody');

    if (!csvRows.length) {
      wrap.classList.remove('d-none');
      body.innerHTML = '<tr><td colspan="4" class="muted">Aucune ligne valide détectée.</td></tr>';
      document.getElementById('csvInfo').textContent = 'Vérifiez le format du fichier.';
      showToast('Aucune ligne exploitable dans ce fichier CSV.', 'error');
      return;
    }

    wrap.classList.remove('d-none');
    body.innerHTML = csvRows.slice(0, 5).map(r => `
      <tr>
        <td>${escapeHtml(r.firstName)}</td>
        <td>${escapeHtml(r.lastName)}</td>
        <td>${escapeHtml(r.identifier || '—')}</td>
        <td>${escapeHtml(r.group || '—')}</td>
      </tr>`).join('');
    document.getElementById('csvInfo').textContent =
      `${csvRows.length} participant(s) détecté(s). Les doublons seront ignorés automatiquement.`;
  } catch (err) {
    showToast('Impossible de lire ce fichier.', 'error');
  }
});

document.getElementById('csvForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const role = document.getElementById('csvRole').value;
  const list = listByRole(role);

  if (!csvRows.length) {
    showToast('Sélectionnez d\'abord un fichier CSV valide.', 'error');
    return;
  }

  let added = 0, skipped = 0;
  for (const row of csvRows) {
    if (isDuplicate(list, row.firstName, row.lastName)) { skipped++; continue; }
    list.push({
      id: uid(role === 'sponsor' ? 'parrain' : 'filleul'),
      firstName: row.firstName,
      lastName: row.lastName,
      identifier: row.identifier,
      group: row.group,
      hasPhoto: false
    });
    added++;
  }

  saveState();
  renderAll();
  bootstrap.Modal.getInstance(document.getElementById('csvModal'))?.hide();
  showToast(`${added} participant(s) importé(s)${skipped ? `, ${skipped} doublon(s) ignoré(s)` : ''}.`, 'success');
});

/* ============================================================
   6. BINÔMAGE ALÉATOIRE
   ============================================================ */

/**
 * Calcule les associations UNE SEULE FOIS.
 * L'animation ne fait que révéler ce résultat.
 */
function computeDraw() {
  const sponsors = shuffle(state.sponsors);
  const godchildren = shuffle(state.godchildren);
  const allowMultiple = state.settings.allowMultiple && godchildren.length > sponsors.length;
  const pairs = [];

  if (allowMultiple) {
    // Répartition en tourniquet : tous les filleuls sont attribués
    godchildren.forEach((g, i) => {
      pairs.push({ id: uid('binome'), sponsorId: sponsors[i % sponsors.length].id, godchildId: g.id });
    });
  } else {
    // Une seule association par parrain
    const count = Math.min(sponsors.length, godchildren.length);
    for (let i = 0; i < count; i++) {
      pairs.push({ id: uid('binome'), sponsorId: sponsors[i].id, godchildId: godchildren[i].id });
    }
  }
  return pairs;
}

/** Ouvre la fenêtre de confirmation avant le tirage. */
function openDrawModal() {
  const nS = state.sponsors.length;
  const nG = state.godchildren.length;

  if (!nS || !nG) {
    showToast('Il faut au moins un parrain ET un filleul pour lancer le tirage.', 'error');
    showView(nS ? 'filleuls' : 'parrains');
    return;
  }

  const summary = document.getElementById('drawSummaryText');
  summary.innerHTML = `
    <div><i class="bi bi-person-badge"></i> Parrains : <b>${nS}</b></div>
    <div><i class="bi bi-person-heart"></i> Filleuls : <b>${nG}</b></div>
    <div><i class="bi bi-people"></i> Binômes possibles : <b>${Math.min(nS, nG)}</b></div>
    ${state.pairs.length ? `<div><i class="bi bi-arrow-repeat"></i> Un tirage existe déjà : il sera <b>remplacé</b>.</div>` : ''}`;

  renderDrawSummary();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('drawModal')).show();
}

/** Séquence complète : calcul + animation + célébration. */
async function runDrawAnimation() {
  if (isDrawing) return;          // anti-clics multiples
  isDrawing = true;

  const startButtons = [
    document.getElementById('btnStartDraw'),
    document.getElementById('btnStartDraw2'),
    document.getElementById('topDrawBtn'),
    document.getElementById('btnConfirmDraw')
  ];
  startButtons.forEach(b => { if (b) b.disabled = true; });

  // 1. Le résultat est calculé immédiatement (l'animation ne fait que le révéler)
  const pairs = computeDraw();
  state.pairs = pairs;
  state.drawAt = new Date().toISOString();
  saveState();

  // 2. Animation
  const animModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('animModal'));
  const stage = document.getElementById('animStage');
  const reveal = document.getElementById('animReveal');
  const footer = document.getElementById('animFooter');

  stage.classList.remove('d-none');
  reveal.classList.add('d-none');
  reveal.innerHTML = '';
  footer.classList.add('d-none');
  animModal.show();

  // Phase 1 : défilement des photos
  const allParticipants = shuffle([...state.sponsors, ...state.godchildren]);
  const slotImg = document.getElementById('animSlotImg');
  const slotName = document.getElementById('animSlotName');
  const status = document.getElementById('animStatus');
  const progressFill = document.getElementById('animProgressFill');
  const progressText = document.getElementById('animProgressText');

  status.textContent = 'Tirage en cours…';
  const totalSteps = 26;
  for (let step = 0; step < totalSteps; step++) {
    const p = allParticipants[step % allParticipants.length];
    slotImg.src = photoOf(p);
    slotName.textContent = `${p.firstName} ${p.lastName}`;
    progressFill.style.width = Math.round(((step + 1) / totalSteps) * 60) + '%';
    progressText.textContent = 'Mélange des listes…';
    // Ralentissement progressif pour l'effet "machine à sous"
    await wait(45 + step * 6);
  }

  // Phase 2 : révélation progressive des binômes
  status.textContent = 'Révélation des binômes';
  progressText.textContent = 'Association des parrains et des filleuls…';
  reveal.classList.remove('d-none');

  for (let i = 0; i < pairs.length; i++) {
    const s = findParticipant(pairs[i].sponsorId);
    const g = findParticipant(pairs[i].godchildId);
    if (!s || !g) continue;

    const card = document.createElement('div');
    card.className = 'reveal-card';
    card.style.animationDelay = '0ms';
    card.innerHTML = `
      <div class="num">#${String(i + 1).padStart(3, '0')}</div>
      <div class="reveal-photos">
        <img src="${photoOf(s)}" alt=""><img src="${photoOf(g)}" alt="">
      </div>
      <div class="reveal-text">
        <strong>${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}</strong>
        <small>↔ ${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</small>
      </div>`;
    reveal.appendChild(card);
    progressFill.style.width = (60 + Math.round(((i + 1) / Math.max(1, pairs.length)) * 40)) + '%';
    await wait(230);
  }

  // Phase 3 : célébration discrète
  progressFill.style.width = '100%';
  progressText.textContent = `${pairs.length} binôme(s) constitué(s) !`;
  status.textContent = 'Binômage terminé 🎉';
  launchConfetti();
  footer.classList.remove('d-none');

  renderAll();
  startButtons.forEach(b => { if (b) b.disabled = false; });
  isDrawing = false;
}

/* ---------- Confettis (canvas léger) ---------- */
function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const colors = ['#2563EB', '#7C3AED', '#12B76A', '#F79009', '#FFFFFF'];
  const particles = Array.from({ length: 90 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    w: 5 + Math.random() * 7,
    h: 8 + Math.random() * 9,
    color: colors[Math.floor(Math.random() * colors.length)],
    vy: 1.6 + Math.random() * 2.6,
    vx: -1.2 + Math.random() * 2.4,
    rot: Math.random() * Math.PI,
    vr: -0.09 + Math.random() * 0.18
  }));

  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (p.y > canvas.height + 30) { p.y = -20; p.x = Math.random() * canvas.width; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = elapsed > 2600 ? Math.max(0, 1 - (elapsed - 2600) / 1200) : 1;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (elapsed < 3900) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
}

/* ============================================================
   7. RÉSULTATS — EXPORT CSV & IMPRESSION
   ============================================================ */

function exportResultsCsv() {
  if (!state.pairs.length) {
    showToast('Aucun binôme à exporter.', 'warning');
    return;
  }
  const sep = ';';
  const rows = [[
    'Binôme', 'Prénom parrain', 'Nom parrain', 'Identifiant parrain', 'Filière parrain',
    'Prénom filleul', 'Nom filleul', 'Identifiant filleul', 'Filière filleul'
  ]];

  state.pairs.forEach((pair, i) => {
    const s = findParticipant(pair.sponsorId);
    const g = findParticipant(pair.godchildId);
    if (!s || !g) return;
    rows.push([
      'Binôme n° ' + String(i + 1).padStart(3, '0'),
      s.firstName, s.lastName, s.identifier || '', s.group || '',
      g.firstName, g.lastName, g.identifier || '', g.group || ''
    ]);
  });

  // Participants non appariés
  const matchedS = new Set(state.pairs.map(p => p.sponsorId));
  const matchedG = new Set(state.pairs.map(p => p.godchildId));
  state.sponsors.filter(p => !matchedS.has(p.id)).forEach(p => {
    rows.push(['Non apparié', p.firstName, p.lastName, p.identifier || '', p.group || '', '', '', '', '']);
  });
  state.godchildren.filter(p => !matchedG.has(p.id)).forEach(p => {
    rows.push(['Non apparié', '', '', '', '', p.firstName, p.lastName, p.identifier || '', p.group || '']);
  });

  const csv = '\uFEFF' + rows.map(r =>
    r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(sep)
  ).join('\r\n');

  downloadFile(csv, 'binomage-resultats.csv', 'text/csv;charset=utf-8');
  showToast('Export CSV généré avec succès.', 'success');
}

/** Télécharge un contenu texte sous forme de fichier. */
function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ============================================================
   8. SAUVEGARDE JSON / RESTAURATION / RÉINITIALISATION
   ============================================================ */

async function exportBackup() {
  const photos = {};
  for (const p of [...state.sponsors, ...state.godchildren]) {
    const img = await PhotoStore.get(p.id);
    if (img) photos[p.id] = img;
  }
  const backup = {
    app: 'BinômagePro',
    version: 1,
    exportedAt: new Date().toISOString(),
    sponsors: state.sponsors,
    godchildren: state.godchildren,
    pairs: state.pairs,
    settings: state.settings,
    photos
  };
  downloadFile(JSON.stringify(backup, null, 2), 'binomagepro-sauvegarde.json', 'application/json');
  showToast('Sauvegarde exportée. Conservez précieusement ce fichier.', 'success');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.sponsors) || !Array.isArray(data.godchildren)) {
      throw new Error('Format de sauvegarde invalide.');
    }

    const confirmed = await askConfirm({
      title: 'Restaurer cette sauvegarde ?',
      message: 'Les données actuelles de ce navigateur seront <b>remplacées</b> par celles du fichier.',
      okLabel: 'Restaurer'
    });
    if (!confirmed) return;

    await PhotoStore.clear();
    photoCache = {};

    state.sponsors = data.sponsors.map(p => ({ ...p, id: p.id || uid('parrain'), hasPhoto: !!data.photos?.[p.id] }));
    state.godchildren = data.godchildren.map(p => ({ ...p, id: p.id || uid('filleul'), hasPhoto: !!data.photos?.[p.id] }));
    state.pairs = Array.isArray(data.pairs) ? data.pairs : [];
    state.settings = Object.assign({ allowMultiple: false }, data.settings || {});
    state.isDemo = false;
    state.drawAt = data.exportedAt || null;

    for (const [id, img] of Object.entries(data.photos || {})) {
      photoCache[id] = img;
      await PhotoStore.put(id, img);
    }

    saveState();
    renderAll();
    showToast('Sauvegarde restaurée avec succès.', 'success');
  } catch (err) {
    showToast('Fichier illisible : ' + err.message, 'error');
  }
}

/** Retire les exemples enregistrés par les anciennes versions sans toucher aux données réelles. */
async function purgeLegacyDemoData() {
  const demoIds = new Set(state.demoIds || []);
  if (!state.isDemo && demoIds.size === 0) return;

  const demoParticipants = [...state.sponsors, ...state.godchildren].filter(p => demoIds.has(p.id));
  for (const participant of demoParticipants) {
    if (participant.hasPhoto) await PhotoStore.del(participant.id);
    delete photoCache[participant.id];
  }
  state.sponsors = state.sponsors.filter(p => !demoIds.has(p.id));
  state.godchildren = state.godchildren.filter(p => !demoIds.has(p.id));
  state.pairs = state.pairs.filter(pair => !demoIds.has(pair.sponsorId) && !demoIds.has(pair.godchildId));
  state.demoIds = [];
  state.isDemo = false;
  saveState();
}

/** Réinitialisation complète du stockage local. */
async function resetAllData() {
  const confirmed = await askConfirm({
    title: 'Réinitialiser toutes les données ?',
    message: 'Cette action est <b>définitive</b> : participants, photos et résultats seront supprimés de ce navigateur.<br>Pensez à exporter une sauvegarde avant de continuer.',
    okLabel: 'Tout supprimer',
    danger: true
  });
  if (!confirmed) return;

  await PhotoStore.clear();
  localStorage.removeItem(STORAGE_KEY);
  photoCache = {};
  state.sponsors = [];
  state.godchildren = [];
  state.pairs = [];
  state.settings = { allowMultiple: false };
  state.isDemo = false;
  state.demoIds = [];
  state.drawAt = null;

  saveState();
  renderAll();
  showToast('Toutes les données ont été réinitialisées.', 'success');
}

/* ============================================================
   9b. INITIALISATION & ÉVÉNEMENTS
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  await PhotoStore.init();
  await loadState();
  await purgeLegacyDemoData();

  /* --- Navigation --- */
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  /* --- Menu mobile --- */
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarBackdrop').classList.add('show');
  });
  document.getElementById('sidebarBackdrop').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('show');
  });

  /* --- Boutons participants --- */
  document.getElementById('btnAddSponsor').addEventListener('click', () => openParticipantModal('sponsor'));
  document.getElementById('btnAddSponsorEmpty').addEventListener('click', () => openParticipantModal('sponsor'));
  document.getElementById('btnAddGc').addEventListener('click', () => openParticipantModal('godchild'));
  document.getElementById('btnAddGcEmpty').addEventListener('click', () => openParticipantModal('godchild'));
  document.getElementById('btnMultiSponsor').addEventListener('click', () => openMultiModal('sponsor'));
  document.getElementById('btnMultiGc').addEventListener('click', () => openMultiModal('godchild'));
  document.getElementById('btnImportSponsor').addEventListener('click', () => openCsvModal('sponsor'));
  document.getElementById('btnImportGc').addEventListener('click', () => openCsvModal('godchild'));

  /* --- Recherche en direct --- */
  document.getElementById('searchSponsors').addEventListener('input', () => renderParticipants('sponsor'));
  document.getElementById('searchGc').addEventListener('input', () => renderParticipants('godchild'));
  document.getElementById('searchResults').addEventListener('input', renderResults);
  document.getElementById('filterGroup').addEventListener('change', renderResults);

  /* --- Binômage --- */
  ['btnStartDraw', 'btnStartDraw2', 'btnStartDraw3', 'topDrawBtn'].forEach(id => {
    document.getElementById(id).addEventListener('click', openDrawModal);
  });
  document.getElementById('btnConfirmDraw').addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('drawModal'))?.hide();
    setTimeout(runDrawAnimation, 320);
  });
  document.getElementById('btnRestartDraw').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Recommencer le tirage ?',
      message: 'Les binômes actuels seront remplacés par un nouveau tirage aléatoire.',
      okLabel: 'Recommencer'
    });
    if (ok) openDrawModal();
  });
  document.getElementById('btnAnimGoResults').addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('animModal'))?.hide();
    showView('resultats');
  });

  // Synchronisation des deux cases "plusieurs filleuls par parrain"
  const syncMulti = (source, target) => {
    document.getElementById(source).addEventListener('change', (e) => {
      state.settings.allowMultiple = e.target.checked;
      document.getElementById(target).checked = e.target.checked;
      saveState();
    });
  };
  syncMulti('allowMultipleCheck', 'allowMultipleCheckModal');
  syncMulti('allowMultipleCheckModal', 'allowMultipleCheck');

  /* --- Résultats --- */
  document.getElementById('btnExportCsv').addEventListener('click', exportResultsCsv);
  document.getElementById('btnPrint').addEventListener('click', () => {
    if (!state.pairs.length) {
      showToast('Aucun binôme à imprimer.', 'warning');
      return;
    }
    window.print();
  });

  /* --- Données & sauvegarde --- */
  document.getElementById('btnExportJson').addEventListener('click', exportBackup);
  document.getElementById('btnImportJson').addEventListener('click', () =>
    document.getElementById('jsonFileInput').click());
  document.getElementById('jsonFileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btnResetData').addEventListener('click', resetAllData);

  startHeroPhotoCarousel();
  renderAll();
});

function startHeroPhotoCarousel() {
  const heroCard = document.querySelector('.hero-card');
  const carousel = document.querySelector('.hero-photo-carousel');
  if (!heroCard || !carousel) return;

  const photos = [...carousel.querySelectorAll('.hero-photo')];
  if (photos.length < 2) return;

  let currentIndex = 0;

  const render = (index) => {
    const photo = photos[index];
    if (!photo) return;

    const imageUrl = photo.getAttribute('src');
    heroCard.style.backgroundImage = `linear-gradient(120deg, rgba(16, 24, 40, .82), rgba(44, 39, 98, .7)), url('${imageUrl}')`;
    heroCard.style.backgroundSize = 'cover';
    heroCard.style.backgroundPosition = 'center';
    heroCard.style.backgroundRepeat = 'no-repeat';
  };

  render(currentIndex);
  setInterval(() => {
    currentIndex = (currentIndex + 1) % photos.length;
    render(currentIndex);
  }, 2800);
}
