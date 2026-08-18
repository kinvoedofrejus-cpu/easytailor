/* ===== Stockage ===== */
const DB = {
  get(key, fallback){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e){ return fallback; }
  },
  // Renvoie true si l'enregistrement a réussi, false sinon (ex: stockage plein).
  // Ne lève plus d'exception silencieuse : avant, une erreur ici arrêtait le
  // script en plein milieu (fermeture de modale, rafraîchissement de la liste...),
  // ce qui donnait l'impression que "ça s'enregistre" alors que rien n'était sauvegardé.
  set(key, value){
    try{ localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch(e){ console.error('DB.set a échoué pour', key, e); return false; }
  }
};

const KEYS = { clientes:'cd_clientes', commandes:'cd_commandes', catalogue:'cd_catalogue', apprentis:'cd_apprentis', parametres:'cd_parametres', licence:'cd_licence', compteurEnregistrement:'cd_compteur_enregistrement' };

// Numéro d'enregistrement attribué automatiquement à chaque nouvel apprenti/stagiaire
// (ex: "2026-0001"), une fois pour toutes à la création de la fiche. Basé sur un
// compteur qui ne fait qu'augmenter (jamais réutilisé, même après suppression d'une
// fiche), pour que le numéro reste unique et corresponde à un vrai registre.
function prochainNumeroEnregistrement(){
  const n = (DB.get(KEYS.compteurEnregistrement, 0) || 0) + 1;
  DB.set(KEYS.compteurEnregistrement, n);
  return `${new Date().getFullYear()}-${String(n).padStart(4,'0')}`;
}

/* ==================== LICENCE ====================
   Système de clé d'activation hors ligne (aucun serveur). Une clé a la forme
   EZT-<TYPE>-<EXPIRATION>-<SIGNATURE> où TYPE ∈ {M,A,I,P} (mois / année /
   illimité / personnalisé) et EXPIRATION est une date AAAAMMJJ (99991231 pour
   illimité). La SIGNATURE est un hash dérivé d'un secret partagé avec l'outil
   de génération (license-generator.html, à garder en interne, non livré aux
   clients) : impossible de fabriquer une clé valide sans lui. */
const LICENCE_SECRET = 'EZTailor-KINVOS-2026-Cle-Secrete-Ne-Pas-Diffuser';

async function licenceSha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function licenceSignature(type, exp){
  const hex = await licenceSha256Hex(`${type}|${exp}|${LICENCE_SECRET}`);
  return hex.slice(0, 10).toUpperCase();
}
function licenceParseKey(raw){
  const clean = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  const parts = clean.split('-');
  if(parts.length !== 4 || parts[0] !== 'EZT') return null;
  const [, type, exp, sig] = parts;
  if(!['M','A','I','P'].includes(type)) return null;
  if(!/^\d{8}$/.test(exp)) return null;
  if(!/^[0-9A-F]{10}$/.test(sig)) return null;
  return { type, exp, sig, clean };
}
async function licenceVerify(raw){
  const parsed = licenceParseKey(raw);
  if(!parsed) return { valid:false, reason:'format' };
  const attendue = await licenceSignature(parsed.type, parsed.exp);
  if(attendue !== parsed.sig) return { valid:false, reason:'signature' };
  if(parsed.exp !== '99991231'){
    const y = +parsed.exp.slice(0,4), m = +parsed.exp.slice(4,6) - 1, d = +parsed.exp.slice(6,8);
    const expDate = new Date(y, m, d, 23, 59, 59);
    if(Date.now() > expDate.getTime()) return { valid:false, reason:'expired', type:parsed.type, exp:parsed.exp };
  }
  return { valid:true, type:parsed.type, exp:parsed.exp, key:parsed.clean };
}
function licenceLabel(type){
  return { M:'Licence mensuelle', A:'Licence annuelle', I:'Licence illimitée', P:'Licence personnalisée' }[type] || 'Licence';
}
function licenceExpLabel(exp){
  if(exp === '99991231') return 'Illimitée';
  return `${exp.slice(6,8)}/${exp.slice(4,6)}/${exp.slice(0,4)}`;
}
function licenceOverlay(){ return document.getElementById('license-lock'); }
function licenceShowLock(message){
  const overlay = licenceOverlay();
  if(!overlay) return;
  overlay.classList.add('open');
  overlay.innerHTML = `
    <div class="license-box">
      <img src="icons/icon-192.png" alt="EasyTailor" class="license-logo">
      <h2>Licence requise</h2>
      <p class="license-msg">${message || "Entrez votre clé d'activation pour utiliser EasyTailor."}</p>
      <input type="text" id="license-input" placeholder="EZT-X-XXXXXXXX-XXXXXXXXXX" autocapitalize="characters" autocomplete="off" spellcheck="false">
      <div id="license-error" class="license-error"></div>
      <button type="button" id="license-submit" class="btn btn-primary btn-block">Activer</button>
      <p class="license-footer">Contactez KINVOS pour obtenir une clé d'activation.</p>
    </div>
  `;
  const submit = document.getElementById('license-submit');
  const input = document.getElementById('license-input');
  submit.addEventListener('click', licenceHandleSubmit);
  input.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') licenceHandleSubmit(); });
  input.focus();
}
async function licenceHandleSubmit(){
  const input = document.getElementById('license-input');
  const errEl = document.getElementById('license-error');
  const btn = document.getElementById('license-submit');
  const raw = input.value.trim();
  errEl.textContent = '';
  if(!raw){ errEl.textContent = 'Entrez une clé.'; return; }
  btn.disabled = true; btn.textContent = 'Vérification...';
  const result = await licenceVerify(raw);
  btn.disabled = false; btn.textContent = 'Activer';
  if(!result.valid){
    errEl.textContent = result.reason === 'expired' ? 'Cette clé a expiré.' : "Clé invalide. Vérifiez et réessayez.";
    return;
  }
  DB.set(KEYS.licence, { key: result.key, type: result.type, exp: result.exp });
  location.reload();
}
async function licenceCheckOnBoot(){
  const stored = DB.get(KEYS.licence, null);
  if(!stored || !stored.key){ licenceShowLock(); return; }
  const result = await licenceVerify(stored.key);
  if(!result.valid){
    licenceShowLock(result.reason === 'expired' ? 'Votre licence a expiré. Entrez une nouvelle clé pour continuer.' : 'Licence invalide. Entrez une clé valide.');
    return;
  }
  const overlay = licenceOverlay();
  if(overlay){ overlay.classList.remove('open'); overlay.innerHTML = ''; }
}
licenceCheckOnBoot();

/* ===== Stockage des photos ET vidéos du catalogue (IndexedDB) =====
   Le localStorage est limité (quelques Mo) : avec 180+ modèles illustrés,
   on sature vite, et les vidéos sont encore plus volumineuses. Photos et
   vidéos sont donc stockées à part, dans IndexedDB (deux magasins distincts
   de la même base), qui supporte des volumes bien plus importants. Le
   catalogue en localStorage ne garde que les infos texte + des indicateurs
   hasPhoto / hasVideo. */
const MediaDB = (() => {
  const DB_NAME = 'easytailor-photos'; // nom conservé pour ne pas perdre les photos déjà stockées
  const VERSION = 2;
  let dbPromise = null;
  function open(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject)=>{
      if(!('indexedDB' in window)){ reject(new Error('IndexedDB indisponible')); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
        if(!db.objectStoreNames.contains('videos')) db.createObjectStore('videos');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function makeStore(storeName){
    async function get(id){
      try{
        const db = await open();
        return await new Promise((resolve, reject)=>{
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      }catch(e){ return null; }
    }
    async function getMany(ids){
      const out = {};
      if(!ids.length) return out;
      try{
        const db = await open();
        await new Promise((resolve)=>{
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          let remaining = ids.length;
          ids.forEach(id=>{
            const req = store.get(id);
            req.onsuccess = () => { if(req.result) out[id] = req.result; if(--remaining===0) resolve(); };
            req.onerror = () => { if(--remaining===0) resolve(); };
          });
        });
      }catch(e){ /* IndexedDB indisponible : on renvoie ce qu'on a pu lire */ }
      return out;
    }
    async function set(id, value){
      try{
        const db = await open();
        return await new Promise((resolve, reject)=>{
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).put(value, id);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      }catch(e){ console.error(`${storeName}.set a échoué pour`, id, e); return false; }
    }
    async function del(id){
      try{
        const db = await open();
        return await new Promise((resolve, reject)=>{
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).delete(id);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      }catch(e){ return false; }
    }
    return { get, getMany, set, delete: del };
  }
  return { makeStore };
})();
const PhotoStore = MediaDB.makeStore('photos');
const VideoStore = MediaDB.makeStore('videos');

/* ===== Champs de mesures (couture Dame) ===== */
const CHAMPS_MESURES_FEMME = [
  {k:'hauteurPince', l:'Hauteur Pince'},
  {k:'longTaille', l:'Long Taille'},
  {k:'longCorsage', l:'Long Corsage'},
  {k:'longGenoux', l:'Long Genoux'},
  {k:'robe', l:'Robe'},
  {k:'dos', l:'Dos'},
  {k:'carDos', l:'Car Dos'},
  {k:'tailleDos', l:'Taille Dos'},
  {k:'longManche', l:'Long Manche'},
  {k:'tourManche', l:'Tour Manche'},
  {k:'carrureDevant', l:'Carrure Devant'},
  {k:'ecarSein', l:'Ecar Sein'},
  {k:'tourPoitrine', l:'Tour Poitrine'},
  {k:'tourTaille', l:'Tour Taille'},
  {k:'tourBassin', l:'Tour Bassin'},
  {k:'longGenou', l:'Long Genou'},
  {k:'jupe', l:'Jupe'},
  {k:'ceinture', l:'Ceinture'},
  {k:'cuisse', l:'Cuisse'},
  {k:'bas', l:'Bas'},
];
const CHAMPS_MESURES_HOMME = [
  {k:'tourCou', l:'Tour de Cou'},
  {k:'carrure', l:'Carrure'},
  {k:'tourPoitrine', l:'Tour Poitrine'},
  {k:'tourTaille', l:'Tour Taille'},
  {k:'tourBassin', l:'Tour Bassin'},
  {k:'longManche', l:'Long Manche'},
  {k:'tourBras', l:'Tour Bras'},
  {k:'longVeteent', l:'Long. Boubou / Veste'},
  {k:'longPantalon', l:'Long. Pantalon'},
  {k:'tourCuisse', l:'Tour Cuisse'},
  {k:'tourGenou', l:'Tour Genou'},
  {k:'tourMollet', l:'Tour Mollet'},
];
function champsMesuresPour(sexe){ return sexe==='homme' ? CHAMPS_MESURES_HOMME : CHAMPS_MESURES_FEMME; }

/* ===== Catalogue : vide par défaut, uniquement les ajouts utilisateur (photo/vidéo + numéro) ===== */
function seedCatalogue(){
  return [];
}
function ensureSeed(){
  if(!localStorage.getItem(KEYS.catalogue)) DB.set(KEYS.catalogue, seedCatalogue());
  if(!localStorage.getItem(KEYS.clientes)) DB.set(KEYS.clientes, []);
  if(!localStorage.getItem(KEYS.commandes)) DB.set(KEYS.commandes, []);
  if(!localStorage.getItem(KEYS.apprentis)) DB.set(KEYS.apprentis, []);
  if(!localStorage.getItem(KEYS.parametres)) DB.set(KEYS.parametres, {
    pays:'RÉPUBLIQUE DU BÉNIN', nomAtelier:'EasyTailor', raisonSociale:'', sousTitreAtelier:'Atelier de formation et de perfectionnement en couture',
    slogan:'', logo:null, adresse:'', ville:'', commune:'', departement:'', telephone:'',
    nomResponsable:'', ageResponsable:'', professionResponsable:'Maîtresse Couturière', titreResponsable:'La Patronne',
    joursFormation:'Lundi à Vendredi', horairesFormation:'8h - 17h',
    fraisApprentissageDefaut:180000, nombreTranchesDefaut:4, fraisInscriptionDefaut:10000, fraisFournituresDefaut:5000, fraisUniformeDefaut:7000, fraisDossierDefaut:30000,
  });
}
ensureSeed();

/* ===== Apprentis : constantes ===== */
const MOTIFS_APPRENTI = [
  {k:'apprenti', l:'Apprenti(e)'},
  {k:'stagiaire', l:'Stagiaire'},
];
const motifLabel = (k) => (MOTIFS_APPRENTI.find(m=>m.k===k)||{}).l || k;

const TYPE_FRAIS = [
  {k:'inscription', l:"Frais d'inscription"},
  {k:'dossier', l:'Frais de dossier'},
  {k:'apprentissage', l:"Frais d'apprentissage"},
  {k:'uniforme', l:'Uniforme'},
  {k:'fournitures', l:'Fournitures'},
  {k:'autre', l:'Autre'},
];
const typeFraisLabel = (k) => (TYPE_FRAIS.find(t=>t.k===k)||{}).l || k;

/* ===== État ===== */
let state = { view:'dashboard', searchQuery:'', editId:null };

/* ===== Utilitaires ===== */
const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const fmtFCFA = (n) => (Number(n)||0).toLocaleString('fr-FR') + ' FCFA';
const fmtDate = (iso) => { if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric'}); };
const initials = (nom) => (nom||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
const todayISO = () => new Date().toISOString().slice(0,10);
const calcAge = (dateISO) => {
  if(!dateISO) return '';
  const d = new Date(dateISO), t = new Date();
  let age = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if(m < 0 || (m===0 && t.getDate() < d.getDate())) age--;
  return age >= 0 ? age : '';
};

const STATUTS = [
  {k:'nouvelle', l:'Nouveau'},
  {k:'en_cours', l:'En cours'},
  {k:'essayage', l:'Essayage'},
  {k:'prete', l:'Prête'},
  {k:'livree', l:'Livré'},
];
const statutLabel = (k) => (STATUTS.find(s=>s.k===k)||{}).l || k;

/* ---------- Statut de commande : rangée de boutons qui se verrouille ====
   Le statut n'est plus un champ du formulaire : il s'affiche, une fois la
   commande enregistrée, sous forme de boutons (Nouveau, En cours, Essayage,
   Prête, Livré). On ne peut avancer que d'une étape à la fois — cliquer sur
   un bouton fait passer la commande à ce statut et le verrouille aussitôt :
   impossible de revenir en arrière ou de re-choisir une étape déjà passée.
   Une fois "Livré" atteint, la commande est entièrement verrouillée. */
function commandeStatusBarHtml(c){
  if(c.statut === 'livree'){
    return `<div class="status-bar status-bar-locked"><span class="status-chip status-livree">🔒 Livrée — verrouillée</span></div>`;
  }
  const currentIdx = STATUTS.findIndex(s=>s.k===c.statut);
  return `<div class="status-bar" data-commande-id="${c.id}">
    ${STATUTS.map((s,i)=>{
      const done = i <= currentIdx;
      const clickable = i === currentIdx + 1;
      const cls = ['status-btn'];
      if(done) cls.push('done');
      if(i===currentIdx) cls.push('current');
      if(clickable) cls.push('clickable');
      return `<button type="button" class="${cls.join(' ')}" data-statut="${s.k}" ${clickable?'':'disabled'}>${s.l}</button>`;
    }).join('')}
  </div>`;
}
// Fait avancer une commande d'une étape (jamais en arrière, jamais deux étapes
// d'un coup) ; renvoie false sans rien changer si l'étape demandée n'est pas
// la suivante ou si la commande est déjà verrouillée (livrée).
function commandeAvancerStatut(commandeId, statutCible){
  const list = DB.get(KEYS.commandes, []);
  const i = list.findIndex(c=>c.id===commandeId);
  if(i<0) return false;
  const c = list[i];
  if(c.statut === 'livree') return false;
  const currentIdx = STATUTS.findIndex(s=>s.k===c.statut);
  const cibleIdx = STATUTS.findIndex(s=>s.k===statutCible);
  if(cibleIdx !== currentIdx + 1) return false;
  list[i] = { ...c, statut: statutCible };
  DB.set(KEYS.commandes, list);
  return true;
}
// Branche les clics sur les boutons de statut trouvés dans `container` ;
// `onChanged` est rappelée (pour tout re-rendre) après un changement accepté.
function wireCommandeStatusBars(container, onChanged){
  container.querySelectorAll('.status-bar[data-commande-id] .status-btn.clickable').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const bar = btn.closest('.status-bar');
      if(commandeAvancerStatut(bar.dataset.commandeId, btn.dataset.statut)) onChanged();
    });
  });
}

/* ===== Silhouette catalogue (illustration par défaut tant qu'aucune photo/vidéo n'est chargée) =====
   Le catalogue n'a plus de catégorie ni de nom : un seul pictogramme générique
   (cintre) suffit, le numéro du modèle est affiché à côté. */
function silhouette(){
  return `<svg viewBox="0 0 80 100" width="64" height="80"><path d="M40 30c0-7-6-13-13-13M40 30c0 7 6 13 13 13M40 30v8M14 48h52l-8 34H22l-8-34zM40 46c-16 0-30 6-30 14v6h60v-6c0-8-14-14-30-14z" fill="none" stroke="#1B3A63" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/* ===== Rendu principal ===== */
const root = document.getElementById('view-root');

function render(){
  libererVideoDetail();
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===state.view));
  if(state.view==='dashboard') renderDashboard();
  else if(state.view==='clientes') renderClientes();
  else if(state.view==='commandes') renderCommandes();
  else if(state.view==='catalogue') renderCatalogue();
  else if(state.view==='apprentis') renderApprentis();
  else if(state.view==='parametres') renderParametres();
}

/* ---------- Dashboard ---------- */
function sparkline(color){
  // Petite courbe décorative façon "tendance", cohérente avec la couleur de la carte.
  return `<svg class="stat-wave" width="100%" height="20" viewBox="0 0 100 20" preserveAspectRatio="none">
    <path d="M0 15 Q 12 4, 24 12 T 48 8 T 72 14 T 100 5" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`;
}

function renderDashboard(){
  const clientes = DB.get(KEYS.clientes, []);
  const commandes = DB.get(KEYS.commandes, []);
  const catalogue = DB.get(KEYS.catalogue, []);
  const parametres = DB.get(KEYS.parametres, {});
  const today = todayISO();

  const enCours = commandes.filter(c => c.statut !== 'livree');
  const enRetard = enCours.filter(c => c.dateLivraisonPrevue && c.dateLivraisonPrevue < today);
  const revenu = commandes.filter(c=>c.statut==='livree').reduce((s,c)=>s+(Number(c.prix)||0),0);
  const dansSeptJours = (()=>{ const d=new Date(); d.setDate(d.getDate()+7); return d.toISOString().slice(0,10); })();
  const prochaines = enCours
    .filter(c=>c.dateLivraisonPrevue && c.dateLivraisonPrevue <= dansSeptJours)
    .sort((a,b)=>a.dateLivraisonPrevue.localeCompare(b.dateLivraisonPrevue))
    .slice(0,8);
  const pretes = commandes
    .filter(c=>c.statut==='prete')
    .sort((a,b)=>(a.dateLivraisonPrevue||'').localeCompare(b.dateLivraisonPrevue||''))
    .slice(0,8);

  root.innerHTML = `
    <div class="hero-banner">
      <div class="hero-icon">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z"/></svg>
      </div>
      <p class="hero-eyebrow">Bienvenue,</p>
      <h2 class="hero-title">${escapeHtml(parametres.nomAtelier || 'EasyTailor')} !</h2>
      <p class="hero-sub">Gérez votre atelier avec simplicité et élégance.</p>
      <button class="hero-cta" id="btn-hero-cta">
        <span class="hero-cta-plus">+</span> Nouvelle cliente
      </button>
    </div>

    <div class="quick-head">
      <h2 class="section-title" style="margin:0;">Aperçu de l'atelier</h2>
      <span class="period-chip">📅 Depuis le début</span>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon" style="background:linear-gradient(155deg,#4C7BFF,#2F55E8);"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v2h16v-2c0-2.8-3.6-5-8-5z"/></svg></div>
        <div class="num">${clientes.length}</div>
        <div class="label">Clientes</div>
        ${sparkline('#4C7BFF')}
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:linear-gradient(155deg,#3ECF8E,#1E9E63);"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v2H4V4zm2 4h12l-1 12H7L6 8zm3 2v8h1v-8H9zm3 0v8h1v-8h-1zm3 0v8h1v-8h-1z"/></svg></div>
        <div class="num">${enCours.length}</div>
        <div class="label">Commandes en cours</div>
        ${sparkline('#1E9E63')}
      </div>
      <div class="stat-card ${enRetard.length?'alert':''}">
        <div class="stat-icon" style="background:linear-gradient(155deg,#FB7185,#EF4444);"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 1 21h22L12 2zm0 6 6.5 11h-13L12 8zm-1 4v3h2v-3h-2zm0 4v2h2v-2h-2z"/></svg></div>
        <div class="num">${enRetard.length}</div>
        <div class="label">En retard</div>
        ${sparkline('#EF4444')}
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:linear-gradient(155deg,#FFB648,#F17C0E);"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.6 15.2v1.3h-1.4v-1.3c-1.6-.2-2.9-1-3-2.7h1.7c.1.8.6 1.3 1.7 1.3.9 0 1.6-.4 1.6-1.2 0-.7-.5-1-1.9-1.4-1.7-.4-3-1-3-2.7 0-1.3 1-2.2 2.5-2.4V6.5h1.4v1.4c1.4.2 2.4 1 2.6 2.4H13c-.1-.7-.6-1.1-1.4-1.1-.8 0-1.4.4-1.4 1s.6.9 1.8 1.2c1.9.5 3.1 1.1 3.1 2.9 0 1.4-1 2.4-2.5 2.6z"/></svg></div>
        <div class="num">${fmtFCFA(revenu).replace(' FCFA','')}</div>
        <div class="label">Revenu livré (FCFA)</div>
        ${sparkline('#F17C0E')}
      </div>
    </div>

    <div class="quick-head">
      <h2 class="section-title" style="margin:0;">Activités récentes</h2>
    </div>
    <div class="dash-block">
      <h3>Livraisons proches (7 jours)</h3>
      ${prochaines.length ? prochaines.map(c=>{
        const cl = clientes.find(x=>x.id===c.clientId);
        const late = c.dateLivraisonPrevue < today;
        return `<div class="list-row" data-open-commande="${c.id}">
          <div class="avatar">${initials(cl?cl.nom:'?')}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(cl?cl.nom:'Cliente inconnue')}</div>
            <div class="row-sub">${escapeHtml(c.modele||'—')}</div>
          </div>
          <div class="row-side">
            <span class="status-chip ${late?'status-retard':'status-'+c.statut}">${late?'Retard':statutLabel(c.statut)}</span><br>
            <span style="font-size:.7rem;color:#8791C4;">${fmtDate(c.dateLivraisonPrevue)}</span>
          </div>
          <span class="row-chevron">›</span>
        </div>`;
      }).join('') : '<p class="empty-note">Aucune livraison programmée dans les 7 prochains jours.</p>'}
    </div>

    <div class="dash-block">
      <h3>Prêtes à livrer</h3>
      ${pretes.length ? pretes.map(c=>{
        const cl = clientes.find(x=>x.id===c.clientId);
        return `<div class="list-row" data-open-commande="${c.id}">
          <div class="avatar">${initials(cl?cl.nom:'?')}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(cl?cl.nom:'Cliente inconnue')}</div>
            <div class="row-sub">${escapeHtml(c.modele||'—')}</div>
          </div>
          <div class="row-side">
            <span class="status-chip status-prete">Prête</span><br>
            <span style="font-size:.7rem;color:#8791C4;">${c.dateLivraisonPrevue?fmtDate(c.dateLivraisonPrevue):''}</span>
          </div>
          <span class="row-chevron">›</span>
        </div>`;
      }).join('') : '<p class="empty-note">Aucune commande prête à livrer pour le moment.</p>'}
    </div>

    <div class="dash-block">
      <h3>Dernières clientes</h3>
      ${clientes.length ? clientes.slice().reverse().slice(0,4).map(cl=>`
        <div class="list-row" data-open-cliente="${cl.id}">
          <div class="avatar">${initials(cl.nom)}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(cl.nom)}</div>
            <div class="row-sub">${escapeHtml(cl.telephone||'')}</div>
          </div>
          <span class="row-chevron">›</span>
        </div>`).join('') : '<p class="empty-note">Ajoutez votre première cliente depuis l\'onglet Clientes.</p>'}
    </div>
    <p style="text-align:center;color:#A6AEDB;font-size:0.74rem;margin-top:10px;">Logiciel 100% hors-ligne — vos données restent uniquement sur cet appareil.</p>
  `;

  root.querySelectorAll('[data-goto]').forEach(el=>el.addEventListener('click', ()=>{
    state.view = el.dataset.goto;
    render();
  }));
  document.getElementById('btn-hero-cta').addEventListener('click', ()=>openClienteForm());
  root.querySelectorAll('[data-open-cliente]').forEach(el=>el.addEventListener('click', ()=>openClienteDetail(el.dataset.openCliente)));
  root.querySelectorAll('[data-open-commande]').forEach(el=>el.addEventListener('click', ()=>openCommandeDetail(el.dataset.openCommande)));
}

/* ---------- Clientes ---------- */
function renderClientes(){
  const clientes = DB.get(KEYS.clientes, []);
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = q ? clientes.filter(c => (c.nom||'').toLowerCase().includes(q) || (c.telephone||'').includes(q)) : clientes;

  root.innerHTML = `
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;">Clientes</h2>
      <button class="btn btn-primary" id="btn-add-cliente">+ Cliente</button>
    </div>
    <div class="search-bar">
      <svg width="16" height="16" viewBox="0 0 24 24"><path d="M10 3a7 7 0 1 0 4.32 12.53l5.08 5.08 1.41-1.41-5.08-5.08A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" fill="#a89a89"/></svg>
      <input type="text" id="search-input" placeholder="Rechercher une cliente..." value="${escapeAttr(state.searchQuery)}">
    </div>
    <div class="dash-block" style="padding-top:4px;">
      ${filtered.length ? filtered.slice().reverse().map(cl=>`
        <div class="list-row" data-open-cliente="${cl.id}">
          <div class="avatar">${initials(cl.nom)}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(cl.nom)}</div>
            <div class="row-sub">${escapeHtml(cl.telephone||'Pas de téléphone')}</div>
          </div>
        </div>`).join('') : `<p class="empty-note">${q?'Aucune cliente trouvée.':'Aucune cliente pour le moment.'}</p>`}
    </div>
  `;
  document.getElementById('btn-add-cliente').addEventListener('click', ()=>openClienteForm());
  document.getElementById('search-input').addEventListener('input', (e)=>{ state.searchQuery = e.target.value; renderClientes(); });
  root.querySelectorAll('[data-open-cliente]').forEach(el=>el.addEventListener('click', ()=>openClienteDetail(el.dataset.openCliente)));
}

function openClienteForm(id){
  const clientes = DB.get(KEYS.clientes, []);
  const existing = id ? clientes.find(c=>c.id===id) : null;
  const m = existing ? existing.mesures||{} : {};
  const sexeInit = existing?.sexe || 'femme';

  const renderChamps = (sexe) => champsMesuresPour(sexe).map(f=>`
    <div class="form-group"><label>${f.l}</label><input type="number" step="0.5" name="m_${f.k}" value="${escapeAttr(m[f.k]||'')}"></div>
  `).join('');

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${existing?'Modifier la cliente':'Nouvelle cliente'}</div>
    <form id="form-cliente">
      <div class="form-group"><label>Nom complet</label><input type="text" name="nom" required value="${escapeAttr(existing?.nom||'')}"></div>
      <div class="form-group"><label>Téléphone</label><input type="tel" name="telephone" value="${escapeAttr(existing?.telephone||'')}"></div>
      <div class="form-group"><label>Adresse</label><input type="text" name="adresse" value="${escapeAttr(existing?.adresse||'')}"></div>

      <div class="form-group">
        <label>Sexe</label>
        <div class="segmented" id="segmented-sexe">
          <button type="button" class="seg-btn ${sexeInit==='femme'?'active':''}" data-sexe="femme">Femme</button>
          <button type="button" class="seg-btn ${sexeInit==='homme'?'active':''}" data-sexe="homme">Homme</button>
        </div>
        <input type="hidden" name="sexe" id="input-sexe" value="${sexeInit}">
      </div>

      <div class="form-section-label">Mesures (cm)</div>
      <div class="form-grid" id="mesures-grid">
        ${renderChamps(sexeInit)}
      </div>

      <div class="form-group"><label>Notes</label><textarea name="notes" rows="2">${escapeHtml(existing?.notes||'')}</textarea></div>

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btn-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('#segmented-sexe .seg-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#segmented-sexe .seg-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('input-sexe').value = btn.dataset.sexe;
      document.getElementById('mesures-grid').innerHTML = renderChamps(btn.dataset.sexe);
    });
  });
  document.getElementById('form-cliente').addEventListener('submit', (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const sexe = fd.get('sexe');
    const mesures = {};
    champsMesuresPour(sexe).forEach(f => { const v = fd.get('m_'+f.k); if(v) mesures[f.k] = Number(v); });
    const data = {
      id: existing ? existing.id : uid(),
      nom: fd.get('nom').trim(),
      telephone: fd.get('telephone').trim(),
      adresse: fd.get('adresse').trim(),
      sexe,
      mesures,
      notes: fd.get('notes').trim(),
      dateCreation: existing ? existing.dateCreation : todayISO(),
    };
    const list = DB.get(KEYS.clientes, []);
    if(existing){ const i=list.findIndex(c=>c.id===existing.id); list[i]=data; }
    else list.push(data);
    DB.set(KEYS.clientes, list);
    closeModal();
    state.view='clientes';
    render();
  });
}

function openClienteDetail(id){
  const clientes = DB.get(KEYS.clientes, []);
  const cl = clientes.find(c=>c.id===id);
  if(!cl) return;
  const commandes = DB.get(KEYS.commandes, []).filter(c=>c.clientId===id);
  const m = cl.mesures || {};
  const champsSexe = champsMesuresPour(cl.sexe);
  const mesuresRenseignees = champsSexe.filter(f=>m[f.k]);

  root.innerHTML = `
    <button class="link-back" id="btn-back">‹ Retour</button>
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;">${escapeHtml(cl.nom)}</h2>
      <button class="btn btn-outline" id="btn-edit-cliente">Modifier</button>
    </div>
    <div class="dash-block">
      <h3>Coordonnées</h3>
      <p style="margin:2px 0;">${escapeHtml(cl.telephone||'Pas de téléphone')}</p>
      <p style="margin:2px 0;color:#8a7f71;">${escapeHtml(cl.adresse||'Pas d\'adresse')}</p>
      <span class="status-chip" style="background:var(--ivoire-soft);color:var(--bordeaux);margin-top:6px;display:inline-block;">${cl.sexe==='homme'?'Homme':'Femme'}</span>
      ${cl.notes?`<p style="margin-top:8px;font-style:italic;color:#8a7f71;">${escapeHtml(cl.notes)}</p>`:''}
    </div>

    <div class="dash-block">
      <h3>Mesures</h3>
      ${mesuresRenseignees.length ? `<div class="measure-grid">
        ${mesuresRenseignees.map(f=>`<div class="measure-item"><div class="mv">${m[f.k]} cm</div><div class="ml">${f.l}</div></div>`).join('')}
      </div>` : '<p class="empty-note">Aucune mesure enregistrée. Modifiez la fiche pour les ajouter.</p>'}
    </div>

    <div class="dash-block">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="border:none;padding:0;margin:0;">Commandes</h3>
        <button class="btn btn-ghost" id="btn-new-commande-cliente" style="padding:6px 12px;font-size:.8rem;">+ Commande</button>
      </div>
      ${commandes.length ? commandes.slice().reverse().map(c=>`
        <div class="commande-card">
          <div class="list-row" data-open-commande="${c.id}" style="border-bottom:none;padding:0 0 8px;">
            <div class="row-main">
              <div class="row-title">${escapeHtml(c.modele||'Sans modèle')}</div>
              <div class="row-sub">Livraison prévue : ${fmtDate(c.dateLivraisonPrevue)}</div>
            </div>
          </div>
          ${commandeStatusBarHtml(c)}
        </div>`).join('') : '<p class="empty-note">Aucune commande pour cette cliente.</p>'}
    </div>

    <button class="btn btn-danger" id="btn-del-cliente">Supprimer cette cliente</button>
  `;

  document.getElementById('btn-back').addEventListener('click', ()=>{ state.view='clientes'; render(); });
  document.getElementById('btn-edit-cliente').addEventListener('click', ()=>openClienteForm(id));
  document.getElementById('btn-new-commande-cliente').addEventListener('click', ()=>openCommandeForm(null, id));
  root.querySelectorAll('[data-open-commande]').forEach(el=>el.addEventListener('click', ()=>openCommandeDetail(el.dataset.openCommande)));
  document.getElementById('btn-del-cliente').addEventListener('click', ()=>{
    if(!confirm('Supprimer définitivement cette cliente ?')) return;
    DB.set(KEYS.clientes, DB.get(KEYS.clientes,[]).filter(c=>c.id!==id));
    state.view='clientes'; render();
  });
  wireCommandeStatusBars(root, ()=>openClienteDetail(id));
}

/* ---------- Commandes ---------- */
function renderCommandes(){
  const commandes = DB.get(KEYS.commandes, []);
  const clientes = DB.get(KEYS.clientes, []);
  const today = todayISO();

  root.innerHTML = `
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;">Commandes</h2>
      <button class="btn btn-primary" id="btn-add-commande">+ Commande</button>
    </div>
    <div class="dash-block" style="padding-top:4px;">
      ${commandes.length ? commandes.slice().reverse().map(c=>{
        const cl = clientes.find(x=>x.id===c.clientId);
        const late = c.statut!=='livree' && c.dateLivraisonPrevue && c.dateLivraisonPrevue < today;
        return `<div class="commande-card">
          <div class="list-row" data-open-commande="${c.id}" style="border-bottom:none;padding:0 0 8px;">
            <div class="avatar">${initials(cl?cl.nom:'?')}</div>
            <div class="row-main">
              <div class="row-title">${escapeHtml(cl?cl.nom:'Cliente supprimée')}</div>
              <div class="row-sub">${escapeHtml(c.modele||'—')} · ${fmtFCFA(c.prix)}</div>
            </div>
            ${late?'<div class="row-side"><span class="status-chip status-retard">Retard</span></div>':''}
          </div>
          ${commandeStatusBarHtml(c)}
        </div>`;
      }).join('') : '<p class="empty-note">Aucune commande enregistrée.</p>'}
    </div>
  `;
  document.getElementById('btn-add-commande').addEventListener('click', ()=>openCommandeForm());
  root.querySelectorAll('[data-open-commande]').forEach(el=>el.addEventListener('click', ()=>openCommandeDetail(el.dataset.openCommande)));
  wireCommandeStatusBars(root, renderCommandes);
}

function openCommandeForm(id, presetClientId){
  const commandes = DB.get(KEYS.commandes, []);
  const clientes = DB.get(KEYS.clientes, []);
  const existing = id ? commandes.find(c=>c.id===id) : null;

  if(!clientes.length){
    alert('Ajoutez d\'abord une cliente avant de créer une commande.');
    return;
  }

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${existing?'Modifier la commande':'Nouvelle commande'}</div>
    <form id="form-commande">
      <div class="form-group">
        <label>Cliente</label>
        <select name="clientId" required>
          ${clientes.map(cl=>`<option value="${cl.id}" ${((existing?existing.clientId:presetClientId)===cl.id)?'selected':''}>${escapeHtml(cl.nom)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Modèle / description</label><input type="text" name="modele" required value="${escapeAttr(existing?.modele||'')}" placeholder="ex: Robe fourreau, tissu wax bleu"></div>
      <div class="form-grid">
        <div class="form-group"><label>Prix (FCFA)</label><input type="number" name="prix" required value="${existing?.prix||''}"></div>
        <div class="form-group"><label>Acompte versé</label><input type="number" name="acompte" value="${existing?.acompte||0}"></div>
      </div>
      <div class="form-grid">
        <div class="form-group"><label>Date de commande</label><input type="date" name="dateCommande" value="${existing?.dateCommande||todayISO()}"></div>
        <div class="form-group"><label>Livraison prévue</label><input type="date" name="dateLivraisonPrevue" value="${existing?.dateLivraisonPrevue||''}"></div>
      </div>
      <div class="form-group"><label>Notes</label><textarea name="notes" rows="2">${escapeHtml(existing?.notes||'')}</textarea></div>
      ${existing ? `<p style="font-size:.72rem;color:#8a7f71;margin:-6px 0 4px;">Le statut se gère désormais avec les boutons affichés sur la commande, après enregistrement.</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btn-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('form-commande').addEventListener('submit', (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {
      id: existing ? existing.id : uid(),
      clientId: fd.get('clientId'),
      modele: fd.get('modele').trim(),
      prix: Number(fd.get('prix'))||0,
      acompte: Number(fd.get('acompte'))||0,
      dateCommande: fd.get('dateCommande'),
      dateLivraisonPrevue: fd.get('dateLivraisonPrevue'),
      statut: existing ? existing.statut : 'nouvelle',
      notes: fd.get('notes').trim(),
    };
    const list = DB.get(KEYS.commandes, []);
    if(existing){ const i=list.findIndex(c=>c.id===existing.id); list[i]=data; }
    else list.push(data);
    DB.set(KEYS.commandes, list);
    closeModal();
    state.view='commandes';
    render();
  });
}

function openCommandeDetail(id){
  const commandes = DB.get(KEYS.commandes, []);
  const c = commandes.find(x=>x.id===id);
  if(!c) return;
  const cl = DB.get(KEYS.clientes,[]).find(x=>x.id===c.clientId);
  const reste = (Number(c.prix)||0) - (Number(c.acompte)||0);

  root.innerHTML = `
    <button class="link-back" id="btn-back">‹ Retour</button>
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;">${escapeHtml(c.modele)}</h2>
      <button class="btn btn-outline" id="btn-edit-commande">Modifier</button>
    </div>
    <div class="dash-block">
      <p style="margin:2px 0;"><strong>${escapeHtml(cl?cl.nom:'Cliente supprimée')}</strong> · ${escapeHtml(cl?.telephone||'')}</p>
      <div class="divider-tape"></div>
      <p style="margin:6px 0 4px;font-weight:600;">Statut de la commande</p>
      ${commandeStatusBarHtml(c)}
      <p style="margin:14px 0 6px;">Commandé le ${fmtDate(c.dateCommande)} · Livraison prévue le ${fmtDate(c.dateLivraisonPrevue)}</p>
      <p style="margin:6px 0;">Prix total : <strong>${fmtFCFA(c.prix)}</strong></p>
      <p style="margin:6px 0;">Acompte versé : ${fmtFCFA(c.acompte)}</p>
      <p style="margin:6px 0;color:${reste>0?'#B5533C':'#7C8B6F'};font-weight:600;">Reste à payer : ${fmtFCFA(reste)}</p>
      ${c.notes?`<p style="margin-top:10px;font-style:italic;color:#8a7f71;">${escapeHtml(c.notes)}</p>`:''}
    </div>
    <button class="btn btn-danger" id="btn-del-commande">Supprimer cette commande</button>
  `;
  document.getElementById('btn-back').addEventListener('click', ()=>{ state.view='commandes'; render(); });
  document.getElementById('btn-edit-commande').addEventListener('click', ()=>openCommandeForm(id));
  document.getElementById('btn-del-commande').addEventListener('click', ()=>{
    if(!confirm('Supprimer définitivement cette commande ?')) return;
    DB.set(KEYS.commandes, DB.get(KEYS.commandes,[]).filter(x=>x.id!==id));
    state.view='commandes'; render();
  });
  wireCommandeStatusBars(root, ()=>openCommandeDetail(id));
}

/* ---------- Catalogue ---------- */
// Applique le filtre par catégorie + la recherche en cours, dans le même
// ordre que la grille du catalogue (plus récents en premier). Partagé entre
// l'affichage de la grille et la navigation par glissement dans le détail.
function catalogueFiltre(){
  const catalogue = DB.get(KEYS.catalogue, []);
  const q = (state.catSearch||'').trim().replace(/^n[°o]\s*/i,'');
  const filtered = q ? catalogue.filter(m => String(m.numero).includes(q)) : catalogue;
  return filtered.slice().reverse();
}

// Prochain numéro de modèle disponible : max(numero existant) + 1, pour ne
// jamais réutiliser un numéro même après suppression d'un modèle.
function prochainNumeroModele(){
  const catalogue = DB.get(KEYS.catalogue, []);
  const max = catalogue.reduce((m, x) => Math.max(m, Number(x.numero) || 0), 0);
  return max + 1;
}

function renderCatalogue(){
  const filtered = catalogueFiltre();

  root.innerHTML = `
    <h2 class="section-title" style="margin-bottom:10px;">Catalogue de modèles</h2>
    <div class="cat-add-row">
      <button class="btn btn-primary" id="btn-add-modele">+ Ajouter</button>
    </div>
    <div class="search-bar">
      <svg width="16" height="16" viewBox="0 0 24 24"><path d="M10 3a7 7 0 1 0 4.32 12.53l5.08 5.08 1.41-1.41-5.08-5.08A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" fill="#a89a89"/></svg>
      <input type="text" id="cat-search-input" inputmode="numeric" placeholder="Rechercher par numéro (ex : 12)" value="${escapeAttr(state.catSearch||'')}">
    </div>
    <div class="top-actions" style="margin-bottom:10px;">
      <span class="cat-count">${filtered.length} modèle${filtered.length>1?'s':''}</span>
    </div>
    <div class="cat-grid">
      ${filtered.length ? filtered.map(m=>`
        <div class="cat-card" data-open-modele="${m.id}">
          <div class="cat-illus" data-illus="${m.id}">${silhouette()}${m.hasVideo?'<span class="video-badge">▶</span>':''}</div>
          <div class="cat-body">
            <div class="cat-name">N° ${escapeHtml(String(m.numero))}</div>
          </div>
        </div>
      `).join('') : `<p class="empty-note" style="grid-column:1/-1;">${state.catSearch ? 'Aucun modèle ne correspond à ce numéro.' : "Le catalogue est vide — touchez « + Ajouter » pour importer vos premières photos ou vidéos."}</p>`}
    </div>
  `;
  document.getElementById('btn-add-modele').addEventListener('click', ()=>openAjoutModeleForm());
  root.querySelectorAll('[data-open-modele]').forEach(el=>el.addEventListener('click', ()=>openModeleDetail(el.dataset.openModele)));
  const catSearchInput = document.getElementById('cat-search-input');
  catSearchInput.addEventListener('input', (e)=>{
    state.catSearch = e.target.value;
    state._catSearchFocused = true;
    renderCatalogue();
  });
  if(state._catSearchFocused){
    const caret = catSearchInput.value.length;
    catSearchInput.focus();
    catSearchInput.setSelectionRange(caret, caret);
  }
  // Les photos sont chargées à part (IndexedDB) puis injectées dans les
  // vignettes déjà affichées, sans perturber le champ de recherche.
  chargerPhotosVisibles(filtered.map(m=>m.id));
}

// Remplace la silhouette par la vraie photo une fois chargée depuis
// IndexedDB, uniquement pour les vignettes encore présentes à l'écran
// (évite d'écrire dans le DOM si l'utilisateur a changé de vue entre-temps).
async function chargerPhotosVisibles(ids){
  const photos = await PhotoStore.getMany(ids);
  Object.keys(photos).forEach(id=>{
    const el = document.querySelector(`[data-illus="${id}"]`);
    if(!el) return;
    const badge = el.querySelector('.video-badge');
    el.innerHTML = `<img src="${photos[id]}" alt="">`;
    if(badge) el.appendChild(badge);
  });
}

function resizeImageFile(file, maxWidth, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality ?? 0.75));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Capture une image de la vidéo (vers 0.3s) pour servir de vignette dans la
// grille du catalogue, sans avoir à décoder la vidéo entière côté affichage.
function captureVideoPoster(file, maxWidth){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(0.3, (video.duration||1) / 2);
    });
    video.addEventListener('seeked', () => {
      try{
        const scale = Math.min(1, maxWidth / video.videoWidth);
        const w = Math.round(video.videoWidth * scale);
        const h = Math.round(video.videoHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        cleanup();
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      }catch(err){ cleanup(); reject(err); }
    });
    video.addEventListener('error', () => { cleanup(); reject(new Error('Vidéo illisible')); });
  });
}

/* ---------- Ajout au catalogue : un seul bouton, photos et/ou vidéos, une ou plusieurs =====
   Chaque fichier importé devient un modèle du catalogue avec un numéro
   attribué automatiquement (aucun nom, aucune catégorie, aucune description
   à saisir) : le modèle est identifié uniquement par son numéro. */
function openAjoutModeleForm(){
  let items = []; // {kind:'photo'|'video', photo, videoFile}

  const renderList = () => {
    const listEl = document.getElementById('add-list');
    const actionsEl = document.getElementById('add-actions');
    if(!listEl) return;
    listEl.innerHTML = items.map((it, i) => `
      <div class="bulk-row">
        <img src="${it.photo}" class="bulk-thumb">
        <div class="bulk-fields">
          <div class="bulk-item-label">${it.kind==='video' ? '🎬 Vidéo' : '🖼️ Photo'} ${i+1}</div>
        </div>
        <button type="button" class="bulk-remove" data-remove="${i}" aria-label="Retirer">✕</button>
      </div>
    `).join('');
    listEl.querySelectorAll('[data-remove]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        items.splice(Number(btn.dataset.remove), 1);
        renderList();
      });
    });
    actionsEl.style.display = items.length ? 'flex' : 'none';
  };

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Ajouter au catalogue</div>
    <p style="margin:-8px 0 14px;color:#8a7f71;font-size:0.85rem;">Choisissez une ou plusieurs photos et/ou vidéos. Un numéro de modèle est attribué automatiquement à chacune.</p>
    <div class="form-group">
      <label>Photos / vidéos</label>
      <input type="file" accept="image/*,video/*" multiple id="input-add-media">
      <p style="margin:6px 0 0;color:#a89a89;font-size:0.76rem;">Vidéos idéalement légères (moins de 20 Mo) pour un enregistrement plus rapide.</p>
    </div>
    <div id="add-list"></div>
    <div class="modal-actions" id="add-actions" style="display:none;">
      <button type="button" class="btn btn-ghost" id="btn-cancel-add">Annuler</button>
      <button type="button" class="btn btn-primary" id="btn-save-add">Enregistrer tout</button>
    </div>
  `);

  document.getElementById('btn-cancel-add').addEventListener('click', closeModal);
  document.getElementById('input-add-media').addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files || []);
    for(const file of files){
      try{
        if(file.type.startsWith('video/')){
          if(file.size > 60*1024*1024){
            alert(`La vidéo "${file.name}" est trop volumineuse (plus de 60 Mo) et a été ignorée.`);
            continue;
          }
          const poster = await captureVideoPoster(file, 480).catch(()=>null);
          items.push({ kind:'video', photo: poster, videoFile: file });
        }else{
          const photo = await resizeImageFile(file, 480, 0.6);
          items.push({ kind:'photo', photo });
        }
      }catch(err){ /* ignore fichier illisible */ }
    }
    renderList();
  });
  document.getElementById('btn-save-add').addEventListener('click', async ()=>{
    const saveBtn = document.getElementById('btn-save-add');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Enregistrement…';

    const list = DB.get(KEYS.catalogue, []);
    let prochainNumero = prochainNumeroModele();
    const nouveaux = items.map(it => ({ id: uid(), numero: prochainNumero++, kind: it.kind, photo: it.photo, videoFile: it.videoFile }));

    // Photos et vidéos (potentiellement lourdes) vont dans IndexedDB (bien plus
    // vaste que le localStorage), ce qui permet d'ajouter beaucoup de modèles
    // sans risquer de saturer la mémoire du téléphone.
    let manquants = 0;
    for(const n of nouveaux){
      let ok = true;
      if(n.photo) ok = await PhotoStore.set(n.id, n.photo);
      if(n.kind==='video' && n.videoFile) ok = (await VideoStore.set(n.id, n.videoFile)) && ok;
      if(!ok) manquants++;
    }
    const metaSeule = nouveaux.map(n => ({ id: n.id, numero: n.numero, hasPhoto: !!n.photo, hasVideo: n.kind==='video' }));

    const ok = DB.set(KEYS.catalogue, [...list, ...metaSeule]);
    if(!ok){
      alert("Échec de l'enregistrement : la mémoire de stockage du téléphone semble pleine. Essayez d'ajouter moins de fichiers à la fois, ou libérez de l'espace.");
      saveBtn.disabled = false;
      saveBtn.textContent = 'Enregistrer tout';
      return; // on garde la modale ouverte, rien n'est perdu côté saisie
    }

    closeModal();
    state.view='catalogue';
    render();

    if(manquants>0){
      alert(`${nouveaux.length} modèle(s) enregistré(s), mais ${manquants} fichier(s) n'ont pas pu être sauvegardés : mémoire de stockage insuffisante.`);
    }
  });
}

/* ---------- Remplacer la photo/vidéo d'un modèle existant ---------- */
function openModeleMediaForm(id){
  const catalogue = DB.get(KEYS.catalogue, []);
  const existing = catalogue.find(m=>m.id===id);
  if(!existing) return;
  let pendingPhoto = null; // null = inchangé ; false = supprimée ; dataURL = nouvelle
  let pendingPhotoChanged = false;
  let pendingVideo = null; // null = inchangée ; false = supprimée ; File = nouvelle
  let pendingVideoChanged = false;
  let pendingVideoPoster = null;

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Modifier le modèle N° ${escapeHtml(String(existing.numero))}</div>
    <form id="form-modele-media">
      <div class="form-group">
        <label>Photo</label>
        <div id="photo-preview-wrap" class="photo-preview-wrap">
          ${existing.hasPhoto ? `<div class="photo-preview-empty">Chargement de la photo…</div>` : `<div id="photo-preview-empty" class="photo-preview-empty">Aucune photo</div>`}
        </div>
        <input type="file" accept="image/*" id="input-photo" style="margin-top:8px;">
      </div>
      <div class="form-group">
        <label>Vidéo (optionnel)</label>
        <div id="video-preview-wrap" class="photo-preview-wrap">
          ${existing.hasVideo ? `<div class="photo-preview-empty">Vidéo déjà enregistrée</div>` : `<div id="video-preview-empty" class="photo-preview-empty">Aucune vidéo</div>`}
        </div>
        <input type="file" accept="video/*" id="input-video" style="margin-top:8px;">
        ${existing.hasVideo ? `<button type="button" class="btn btn-ghost" id="btn-remove-video" style="margin-top:6px;padding:4px 0;">Retirer la vidéo</button>` : ''}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btn-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary" id="btn-save-modele">Enregistrer</button>
      </div>
    </form>
  `);

  if(existing.hasPhoto){
    PhotoStore.get(existing.id).then(photo=>{
      const wrap = document.getElementById('photo-preview-wrap');
      if(!wrap) return;
      wrap.innerHTML = photo ? `<img id="photo-preview" src="${photo}">` : `<div class="photo-preview-empty">Aucune photo</div>`;
    });
  }

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('input-photo').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      pendingPhoto = await resizeImageFile(file, 640);
      pendingPhotoChanged = true;
      const wrap = document.getElementById('photo-preview-wrap');
      wrap.innerHTML = `<img id="photo-preview" src="${pendingPhoto}">`;
    }catch(err){ alert("Impossible de charger cette image."); }
  });
  document.getElementById('input-video').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    if(file.size > 60*1024*1024){
      alert("Cette vidéo est trop volumineuse (plus de 60 Mo). Choisissez une vidéo plus courte ou plus légère.");
      e.target.value = '';
      return;
    }
    pendingVideo = file;
    pendingVideoChanged = true;
    const wrap = document.getElementById('video-preview-wrap');
    wrap.innerHTML = `<div class="photo-preview-empty">Vidéo sélectionnée (${(file.size/1024/1024).toFixed(1)} Mo)</div>`;
    try{ pendingVideoPoster = await captureVideoPoster(file, 640); }catch(err){ pendingVideoPoster = null; }
  });
  const btnRemoveVideo = document.getElementById('btn-remove-video');
  if(btnRemoveVideo){
    btnRemoveVideo.addEventListener('click', ()=>{
      pendingVideo = false;
      pendingVideoChanged = true;
      pendingVideoPoster = null;
      document.getElementById('video-preview-wrap').innerHTML = `<div class="photo-preview-empty">Aucune vidéo</div>`;
      btnRemoveVideo.remove();
    });
  }
  document.getElementById('form-modele-media').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const saveBtn = document.getElementById('btn-save-modele');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Enregistrement…';

    // Si une vidéo est ajoutée sans photo fournie, on utilise la vignette
    // capturée depuis la vidéo pour illustrer la vignette du catalogue.
    if(pendingVideoChanged && pendingVideo && !pendingPhotoChanged && !existing.hasPhoto && pendingVideoPoster){
      pendingPhoto = pendingVideoPoster;
      pendingPhotoChanged = true;
    }

    const hasPhoto = pendingPhotoChanged ? !!pendingPhoto : !!existing.hasPhoto;
    const hasVideo = pendingVideoChanged ? !!pendingVideo : !!existing.hasVideo;
    if(pendingPhotoChanged){
      if(pendingPhoto) await PhotoStore.set(existing.id, pendingPhoto);
      else await PhotoStore.delete(existing.id);
    }
    if(pendingVideoChanged){
      if(pendingVideo) await VideoStore.set(existing.id, pendingVideo);
      else await VideoStore.delete(existing.id);
    }
    const list = DB.get(KEYS.catalogue, []);
    const i = list.findIndex(m=>m.id===existing.id);
    if(i>-1) list[i] = { ...list[i], hasPhoto, hasVideo };
    const ok = DB.set(KEYS.catalogue, list);
    if(!ok){
      alert("Échec de l'enregistrement : la mémoire de stockage du téléphone semble pleine.");
      saveBtn.disabled = false;
      saveBtn.textContent = 'Enregistrer';
      return;
    }
    closeModal();
    state.view='catalogue';
    render();
  });
}

// URL temporaire (blob) de la vidéo actuellement affichée dans le détail
// d'un modèle : à libérer avant d'en charger une autre pour éviter les
// fuites mémoire.
let _detailVideoUrl = null;
function libererVideoDetail(){
  if(_detailVideoUrl){ URL.revokeObjectURL(_detailVideoUrl); _detailVideoUrl = null; }
}

function openModeleDetail(id){
  const m = DB.get(KEYS.catalogue, []).find(x=>x.id===id);
  if(!m) return;
  libererVideoDetail();

  // Liste des modèles dans le même ordre que la grille (filtre catégorie +
  // recherche courants), pour pouvoir défiler vers le modèle précédent/suivant.
  const liste = catalogueFiltre();
  let idx = liste.findIndex(x=>x.id===id);
  if(idx===-1){ idx = 0; }

  root.innerHTML = `
    <button class="link-back" id="btn-back">‹ Retour</button>
    <div class="detail-nav">
      <button class="detail-nav-arrow" id="btn-prev-modele" aria-label="Modèle précédent" ${liste.length<2?'disabled':''}>‹</button>
      <div class="detail-illus" id="detail-illus-wrap">${silhouette().replace('width="64" height="80"','width="140" height="175"')}</div>
      <button class="detail-nav-arrow" id="btn-next-modele" aria-label="Modèle suivant" ${liste.length<2?'disabled':''}>›</button>
    </div>
    ${liste.length>1 ? `<p class="detail-nav-count">${idx+1} / ${liste.length} — glissez pour voir un autre modèle</p>` : ''}
    ${m.hasVideo ? `<div id="detail-video-wrap" class="detail-video-wrap"><div class="photo-preview-empty">Chargement de la vidéo…</div></div>` : ''}
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;" id="detail-titre">Modèle N° ${escapeHtml(String(m.numero))}</h2>
      <button class="btn btn-outline" id="btn-edit-modele">Modifier</button>
    </div>
    <button class="btn btn-primary btn-block" id="btn-order-modele">Créer une commande pour ce modèle</button>
    <button class="btn btn-danger btn-block" id="btn-del-modele" style="margin-top:8px;">Supprimer ce modèle</button>
  `;

  if(m.hasPhoto){
    PhotoStore.get(m.id).then(photo=>{
      const wrap = document.getElementById('detail-illus-wrap');
      if(!wrap || !photo) return;
      wrap.classList.add('has-photo');
      wrap.innerHTML = `<img src="${photo}" alt="Modèle N° ${escapeAttr(String(m.numero))}">`;
    });
  }
  if(m.hasVideo){
    VideoStore.get(m.id).then(blob=>{
      const wrap = document.getElementById('detail-video-wrap');
      if(!wrap) return; // vue quittée entre-temps
      if(!blob){ wrap.innerHTML = `<p class="empty-note">Vidéo introuvable.</p>`; return; }
      _detailVideoUrl = URL.createObjectURL(blob);
      wrap.innerHTML = `<video src="${_detailVideoUrl}" controls playsinline preload="metadata"></video>`;
    });
  }

  document.getElementById('btn-back').addEventListener('click', ()=>{ libererVideoDetail(); state.view='catalogue'; render(); });
  document.getElementById('btn-edit-modele').addEventListener('click', ()=>openModeleMediaForm(id));
  document.getElementById('btn-del-modele').addEventListener('click', ()=>{
    if(!confirm('Supprimer définitivement ce modèle du catalogue ?')) return;
    libererVideoDetail();
    PhotoStore.delete(id);
    VideoStore.delete(id);
    DB.set(KEYS.catalogue, DB.get(KEYS.catalogue,[]).filter(x=>x.id!==id));
    state.view='catalogue'; render();
  });
  document.getElementById('btn-order-modele').addEventListener('click', ()=>{
    openCommandeForm();
    setTimeout(()=>{
      const modeleInput = document.querySelector('#form-commande [name="modele"]');
      if(modeleInput) modeleInput.value = 'Modèle N° ' + m.numero;
    }, 0);
  });

  // Navigation vers le modèle précédent / suivant (flèches + glissement tactile).
  if(liste.length>1){
    const aller = (nouvelIdx)=>{
      const cible = liste[(nouvelIdx + liste.length) % liste.length];
      openModeleDetail(cible.id);
    };
    document.getElementById('btn-prev-modele').addEventListener('click', ()=>aller(idx-1));
    document.getElementById('btn-next-modele').addEventListener('click', ()=>aller(idx+1));

    const illusWrap = document.querySelector('.detail-nav');
    let touchStartX = null, touchStartY = null;
    illusWrap.addEventListener('touchstart', (e)=>{
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, {passive:true});
    illusWrap.addEventListener('touchend', (e)=>{
      if(touchStartX===null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      // On ignore les gestes trop verticaux (scroll de la page) et les
      // petits mouvements accidentels.
      if(Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
      if(dx < 0) aller(idx+1); else aller(idx-1);
    }, {passive:true});
  }
}

/* ==================== APPRENTIS ==================== */
function soldeApprenti(a){
  const total = Number(a.montantTotal)||0;
  const paye = (a.paiements||[]).reduce((s,p)=>s+(Number(p.montant)||0),0);
  return { total, paye, restant: Math.max(0, total - paye) };
}

function renderApprentis(){
  const apprentis = DB.get(KEYS.apprentis, []);
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = q ? apprentis.filter(a => (a.nom||'').toLowerCase().includes(q) || (a.telephone||'').includes(q)) : apprentis;

  root.innerHTML = `
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;">Apprentis</h2>
      <button class="btn btn-primary" id="btn-add-apprenti">+ Apprenti</button>
    </div>
    <div class="search-bar">
      <svg width="16" height="16" viewBox="0 0 24 24"><path d="M10 3a7 7 0 1 0 4.32 12.53l5.08 5.08 1.41-1.41-5.08-5.08A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" fill="#a89a89"/></svg>
      <input type="text" id="search-input" placeholder="Rechercher un(e) apprenti(e)..." value="${escapeAttr(state.searchQuery)}">
    </div>
    <div class="dash-block" style="padding-top:4px;">
      ${filtered.length ? filtered.slice().reverse().map(a=>{
        const s = soldeApprenti(a);
        return `<div class="list-row" data-open-apprenti="${a.id}">
          <div class="avatar">${initials(a.nom)}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(a.nom)}</div>
            <div class="row-sub">${escapeHtml(a.specialite||motifLabel(a.motif))}</div>
          </div>
          <div class="row-side">
            <span class="status-chip" style="background:var(--ivoire-soft);color:var(--bordeaux);">${motifLabel(a.motif)}</span><br>
            <span style="font-size:.72rem;color:${s.restant>0?'#b5442e':'#8a7f71'};">${s.restant>0? 'Restant '+fmtFCFA(s.restant) : 'Solde payé'}</span>
          </div>
        </div>`;
      }).join('') : `<p class="empty-note">${q?'Aucun apprenti trouvé.':'Aucun apprenti pour le moment.'}</p>`}
    </div>
  `;
  document.getElementById('btn-add-apprenti').addEventListener('click', ()=>openApprentiForm());
  document.getElementById('search-input').addEventListener('input', (e)=>{ state.searchQuery = e.target.value; renderApprentis(); });
  root.querySelectorAll('[data-open-apprenti]').forEach(el=>el.addEventListener('click', ()=>openApprentiDetail(el.dataset.openApprenti)));
}

function openApprentiForm(id){
  const apprentis = DB.get(KEYS.apprentis, []);
  const existing = id ? apprentis.find(a=>a.id===id) : null;
  const motifInit = existing?.motif || 'apprenti';
  const p = DB.get(KEYS.parametres, {});

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">${existing?'Modifier la fiche':'Nouvel apprenti'}</div>
    <form id="form-apprenti">
      <div class="form-group">
        <label>Motif</label>
        <div class="segmented" id="segmented-motif">
          ${MOTIFS_APPRENTI.map(m=>`<button type="button" class="seg-btn ${motifInit===m.k?'active':''}" data-motif="${m.k}">${m.l}</button>`).join('')}
        </div>
        <input type="hidden" name="motif" id="input-motif" value="${motifInit}">
      </div>
      <div class="form-section-label">Identité</div>
      <div class="form-group">
        <label>Photo d'identité</label>
        <div id="photo-identite-preview-wrap" class="photo-preview-wrap">
          ${existing?.photoIdentite ? `<img id="photo-identite-preview" src="${existing.photoIdentite}">` : `<div class="photo-preview-empty">Aucune photo importée</div>`}
        </div>
        <input type="file" accept="image/*" id="input-photo-identite" style="margin-top:8px;">
        <p style="font-size:.72rem;color:#8a7f71;margin-top:4px;">Cette photo apparaît sur l'attestation de stage, le diplôme et le contrat.</p>
      </div>
      <div class="form-group"><label>Nom complet</label><input type="text" name="nom" required value="${escapeAttr(existing?.nom||'')}"></div>
      <div class="form-group"><label>Téléphone</label><input type="tel" name="telephone" value="${escapeAttr(existing?.telephone||'')}"></div>
      <div class="form-group"><label>Domicile / adresse</label><input type="text" name="adresse" value="${escapeAttr(existing?.adresse||'')}"></div>
      <div class="form-grid">
        <div class="form-group"><label>Date de naissance</label><input type="date" name="dateNaissance" value="${escapeAttr(existing?.dateNaissance||'')}"></div>
        <div class="form-group"><label>Lieu de naissance</label><input type="text" name="lieuNaissance" value="${escapeAttr(existing?.lieuNaissance||'')}"></div>
      </div>
      <div class="form-group"><label>Spécialité / formation</label><input type="text" name="specialite" placeholder="ex: Couture Dame" value="${escapeAttr(existing?.specialite||'Couture Dame')}"></div>

      <div class="form-section-label">Formation</div>
      <div class="form-grid">
        <div class="form-group"><label>Date de début</label><input type="date" name="dateDebut" value="${escapeAttr(existing?.dateDebut||todayISO())}"></div>
        <div class="form-group"><label>Date de fin prévue</label><input type="date" name="dateFin" value="${escapeAttr(existing?.dateFin||'')}"></div>
      </div>
      <div class="form-group"><label>Durée (texte libre)</label><input type="text" name="duree" placeholder="ex: 1 an" value="${escapeAttr(existing?.duree||'')}"></div>

      <div class="form-section-label">Parent / Tuteur (si mineur)</div>
      <div class="form-group"><label>Nom du tuteur</label><input type="text" name="tuteurNom" value="${escapeAttr(existing?.tuteurNom||'')}"></div>
      <div class="form-grid">
        <div class="form-group"><label>Profession du tuteur</label><input type="text" name="tuteurProfession" value="${escapeAttr(existing?.tuteurProfession||'')}"></div>
        <div class="form-group"><label>Âge du tuteur</label><input type="number" name="tuteurAge" value="${escapeAttr(existing?.tuteurAge||'')}"></div>
      </div>
      <div class="form-group"><label>Domicile du tuteur</label><input type="text" name="tuteurDomicile" value="${escapeAttr(existing?.tuteurDomicile||'')}"></div>
      <div class="form-group"><label>Téléphone du tuteur</label><input type="tel" name="tuteurTelephone" value="${escapeAttr(existing?.tuteurTelephone||'')}"></div>

      <div class="form-section-label">Frais d'apprentissage</div>
      <div class="form-grid">
        <div class="form-group"><label>Total (FCFA)</label><input type="number" name="fraisApprentissage" min="0" class="calc-frais" value="${escapeAttr(existing?.fraisApprentissage ?? p.fraisApprentissageDefaut)}"></div>
        <div class="form-group"><label>Nombre de tranches</label><input type="number" name="nombreTranches" min="1" value="${escapeAttr(existing?.nombreTranches ?? p.nombreTranchesDefaut)}"></div>
      </div>

      <div class="form-section-label">Autres frais (FCFA)</div>
      <div class="form-grid">
        <div class="form-group"><label>Inscription</label><input type="number" name="fraisInscription" min="0" class="calc-frais" value="${escapeAttr(existing?.fraisInscription ?? p.fraisInscriptionDefaut)}"></div>
        <div class="form-group"><label>Fournitures</label><input type="number" name="fraisFournitures" min="0" class="calc-frais" value="${escapeAttr(existing?.fraisFournitures ?? p.fraisFournituresDefaut)}"></div>
        <div class="form-group"><label>Uniforme</label><input type="number" name="fraisUniforme" min="0" class="calc-frais" value="${escapeAttr(existing?.fraisUniforme ?? p.fraisUniformeDefaut)}"></div>
        <div class="form-group"><label>Dossier</label><input type="number" name="fraisDossier" min="0" class="calc-frais" value="${escapeAttr(existing?.fraisDossier ?? p.fraisDossierDefaut)}"></div>
      </div>
      <div class="form-group total-readout">Montant total indicatif : <strong id="montant-total-readout">${fmtFCFA((Number(existing?.fraisApprentissage ?? p.fraisApprentissageDefaut)||0)+(Number(existing?.fraisInscription ?? p.fraisInscriptionDefaut)||0)+(Number(existing?.fraisFournitures ?? p.fraisFournituresDefaut)||0)+(Number(existing?.fraisUniforme ?? p.fraisUniformeDefaut)||0)+(Number(existing?.fraisDossier ?? p.fraisDossierDefaut)||0))}</strong></div>

      <div class="form-group"><label>Notes</label><textarea name="notes" rows="2">${escapeHtml(existing?.notes||'')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btn-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  let pendingPhotoIdentite = existing?.photoIdentite || null;
  document.getElementById('input-photo-identite').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      pendingPhotoIdentite = await resizeImageFile(file, 500, 0.85);
      document.getElementById('photo-identite-preview-wrap').innerHTML = `<img id="photo-identite-preview" src="${pendingPhotoIdentite}">`;
    }catch(err){ alert("Impossible de charger cette image."); }
  });
  document.querySelectorAll('#segmented-motif .seg-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#segmented-motif .seg-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('input-motif').value = btn.dataset.motif;
    });
  });
  const updateTotalReadout = () => {
    const form = document.getElementById('form-apprenti');
    const fd = new FormData(form);
    const total = ['fraisApprentissage','fraisInscription','fraisFournitures','fraisUniforme','fraisDossier'].reduce((s,k)=>s+(Number(fd.get(k))||0),0);
    document.getElementById('montant-total-readout').textContent = fmtFCFA(total);
  };
  document.querySelectorAll('.calc-frais').forEach(inp=>inp.addEventListener('input', updateTotalReadout));

  document.getElementById('form-apprenti').addEventListener('submit', (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const fraisApprentissage = Number(fd.get('fraisApprentissage'))||0;
    const fraisInscription = Number(fd.get('fraisInscription'))||0;
    const fraisFournitures = Number(fd.get('fraisFournitures'))||0;
    const fraisUniforme = Number(fd.get('fraisUniforme'))||0;
    const fraisDossier = Number(fd.get('fraisDossier'))||0;
    const data = {
      id: existing ? existing.id : uid(),
      motif: fd.get('motif'),
      photoIdentite: pendingPhotoIdentite,
      numeroEnregistrement: existing ? existing.numeroEnregistrement : prochainNumeroEnregistrement(),
      dateEnregistrement: existing ? existing.dateEnregistrement : todayISO(),
      nom: fd.get('nom').trim(),
      telephone: fd.get('telephone').trim(),
      adresse: fd.get('adresse').trim(),
      dateNaissance: fd.get('dateNaissance'),
      lieuNaissance: fd.get('lieuNaissance').trim(),
      specialite: fd.get('specialite').trim(),
      dateDebut: fd.get('dateDebut'),
      dateFin: fd.get('dateFin'),
      duree: fd.get('duree').trim(),
      tuteurNom: fd.get('tuteurNom').trim(),
      tuteurProfession: fd.get('tuteurProfession').trim(),
      tuteurAge: fd.get('tuteurAge'),
      tuteurDomicile: fd.get('tuteurDomicile').trim(),
      tuteurTelephone: fd.get('tuteurTelephone').trim(),
      fraisApprentissage, nombreTranches: Number(fd.get('nombreTranches'))||1,
      fraisInscription, fraisFournitures, fraisUniforme, fraisDossier,
      montantTotal: fraisApprentissage+fraisInscription+fraisFournitures+fraisUniforme+fraisDossier,
      notes: fd.get('notes').trim(),
      paiements: existing ? (existing.paiements||[]) : [],
      dateCreation: existing ? existing.dateCreation : todayISO(),
    };
    const list = DB.get(KEYS.apprentis, []);
    if(existing){ const i=list.findIndex(a=>a.id===existing.id); list[i]=data; }
    else list.push(data);
    DB.set(KEYS.apprentis, list);
    closeModal();
    state.view='apprentis';
    render();
  });
}

function openApprentiDetail(id){
  const apprentis = DB.get(KEYS.apprentis, []);
  const a = apprentis.find(x=>x.id===id);
  if(!a) return;
  const s = soldeApprenti(a);
  const paiements = (a.paiements||[]).slice().sort((p1,p2)=>(p2.date||'').localeCompare(p1.date||''));

  root.innerHTML = `
    <button class="link-back" id="btn-back">‹ Retour</button>
    <div class="top-actions">
      <h2 class="section-title" style="margin:0;">${escapeHtml(a.nom)}</h2>
      <button class="btn btn-outline" id="btn-edit-apprenti">Modifier</button>
    </div>
    <div class="dash-block">
      <span class="status-chip" style="background:var(--ivoire-soft);color:var(--bordeaux);">${motifLabel(a.motif)}</span>
      ${a.numeroEnregistrement?`<span class="status-chip" style="background:var(--or-soft);color:#8a5a00;margin-left:6px;">N° ${escapeHtml(a.numeroEnregistrement)}</span>`:''}
      <p style="margin:8px 0 2px;">${escapeHtml(a.specialite||'—')}</p>
      <p style="margin:2px 0;color:#8a7f71;">${escapeHtml(a.telephone||'Pas de téléphone')}</p>
      <p style="margin:2px 0;color:#8a7f71;">${escapeHtml(a.adresse||'')}</p>
      <p style="margin:2px 0;color:#8a7f71;">Formation : ${fmtDate(a.dateDebut)} → ${a.dateFin?fmtDate(a.dateFin):'—'}</p>
      ${a.tuteurNom?`<p style="margin:2px 0;color:#8a7f71;">Tuteur : ${escapeHtml(a.tuteurNom)} ${a.tuteurTelephone?'('+escapeHtml(a.tuteurTelephone)+')':''}</p>`:''}
      ${a.notes?`<p style="margin-top:8px;font-style:italic;color:#8a7f71;">${escapeHtml(a.notes)}</p>`:''}
    </div>

    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="stat-card"><div class="num" style="font-size:1.05rem;">${fmtFCFA(s.total).replace(' FCFA','')}</div><div class="label">Total</div></div>
      <div class="stat-card"><div class="num" style="font-size:1.05rem;">${fmtFCFA(s.paye).replace(' FCFA','')}</div><div class="label">Payé</div></div>
      <div class="stat-card ${s.restant>0?'alert':''}"><div class="num" style="font-size:1.05rem;">${fmtFCFA(s.restant).replace(' FCFA','')}</div><div class="label">Restant</div></div>
    </div>

    <div class="dash-block">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="border:none;padding:0;margin:0;">Paiements</h3>
        <button class="btn btn-ghost" id="btn-add-paiement" style="padding:6px 12px;font-size:.8rem;">+ Versement</button>
      </div>
      ${paiements.length ? `<button type="button" class="btn btn-outline btn-block" id="btn-print-historique" style="margin:4px 0 10px;">Imprimer l'historique des paiements</button>` : ''}
      ${paiements.length ? paiements.map(p=>`
        <div class="list-row">
          <div class="row-main">
            <div class="row-title">${typeFraisLabel(p.type)}${p.tranche?` — ${p.tranche}${p.tranche===1?'ère':'ème'} tranche`:''}</div>
            <div class="row-sub">${fmtDate(p.date)}</div>
          </div>
          <div class="row-side" style="display:flex;align-items:center;gap:8px;">
            <span style="font-weight:600;color:var(--bordeaux);">${fmtFCFA(p.montant)}</span>
            <button type="button" class="btn btn-ghost" data-quittance="${p.id}" style="padding:4px 8px;font-size:.72rem;">Quittance</button>
          </div>
        </div>`).join('') : '<p class="empty-note">Aucun versement enregistré.</p>'}
    </div>

    <div class="dash-block">
      <h3>Documents</h3>
      <button class="btn btn-outline btn-block" id="btn-print-contrat">Imprimer le contrat d'apprentissage</button>
      <button class="btn btn-outline btn-block" id="btn-print-attestation" style="margin-top:8px;">${a.motif==='stagiaire'?'Télécharger l\'attestation (PDF portrait)':'Télécharger le diplôme (PDF paysage)'}</button>
    </div>

    <button class="btn btn-danger" id="btn-del-apprenti">Supprimer cette fiche</button>
  `;

  document.getElementById('btn-back').addEventListener('click', ()=>{ state.view='apprentis'; render(); });
  document.getElementById('btn-edit-apprenti').addEventListener('click', ()=>openApprentiForm(id));
  document.getElementById('btn-add-paiement').addEventListener('click', ()=>openPaiementForm(id));
  const btnHisto = document.getElementById('btn-print-historique');
  if(btnHisto) btnHisto.addEventListener('click', ()=>printHistoriquePaiements(a));
  document.getElementById('btn-print-contrat').addEventListener('click', ()=>printContrat(a));
  document.getElementById('btn-print-attestation').addEventListener('click', async (e)=>{
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Génération du PDF...';
    if(a.motif==='stagiaire') await attestationTelechargerPDF(a);
    else await diplomeTelechargerPDF(a);
    btn.disabled = false; btn.textContent = original;
  });
  root.querySelectorAll('[data-quittance]').forEach(el=>el.addEventListener('click', ()=>{
    const p = (a.paiements||[]).find(x=>x.id===el.dataset.quittance);
    if(p) printQuittance(a, p);
  }));
  document.getElementById('btn-del-apprenti').addEventListener('click', ()=>{
    if(!confirm('Supprimer définitivement cette fiche ?')) return;
    DB.set(KEYS.apprentis, DB.get(KEYS.apprentis,[]).filter(x=>x.id!==id));
    state.view='apprentis'; render();
  });
}

function openPaiementForm(apprentiId){
  const a = DB.get(KEYS.apprentis, []).find(x=>x.id===apprentiId);
  const nbTranches = Math.max(1, Number(a?.nombreTranches)||1);
  const ordinal = (n) => n===1 ? '1ère' : `${n}ème`;

  // Tranches déjà réglées, pour les repérer dans la palette (informatif, pas bloquant).
  const tranchesPayees = new Set((a?.paiements||[]).filter(p=>p.type==='apprentissage' && p.tranche).map(p=>p.tranche));

  let typeSel = 'apprentissage';
  let trancheSel = Array.from({length:nbTranches}, (_,i)=>i+1).find(n=>!tranchesPayees.has(n)) || 1;

  const trancheBlockHtml = () => `
    <div class="form-group" id="bloc-tranche" style="${typeSel==='apprentissage' ? '' : 'display:none;'}">
      <label>Tranche concernée</label>
      <div class="pill-grid" id="palette-tranche">
        ${Array.from({length:nbTranches}, (_,i)=>i+1).map(n=>`
          <button type="button" class="pill-choice ${trancheSel===n?'active':''}" data-tranche="${n}">${ordinal(n)} tranche${tranchesPayees.has(n)?' ✓':''}</button>
        `).join('')}
      </div>
    </div>`;

  const bindTranchePalette = () => {
    document.querySelectorAll('#palette-tranche .pill-choice').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        trancheSel = Number(btn.dataset.tranche);
        document.getElementById('input-tranche').value = trancheSel;
        document.querySelectorAll('#palette-tranche .pill-choice').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  };

  showModal(`
    <div class="modal-handle"></div>
    <div class="modal-title">Nouveau versement</div>
    <form id="form-paiement">
      <div class="form-group">
        <label>Motif de paiement</label>
        <div class="pill-grid" id="palette-type">
          ${TYPE_FRAIS.map(t=>`<button type="button" class="pill-choice ${typeSel===t.k?'active':''}" data-type="${t.k}">${t.l}</button>`).join('')}
        </div>
        <input type="hidden" name="type" id="input-type-frais" value="${typeSel}">
      </div>
      ${trancheBlockHtml()}
      <input type="hidden" name="tranche" id="input-tranche" value="${trancheSel}">
      <div class="form-group"><label>Montant (FCFA)</label><input type="number" name="montant" min="1" required></div>
      <div class="form-group"><label>Date</label><input type="date" name="date" value="${todayISO()}"></div>
      <div class="form-group"><label>Mode de paiement</label><input type="text" name="mode" placeholder="Espèces, Mobile Money..."></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="btn-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>
  `);

  bindTranchePalette();
  document.querySelectorAll('#palette-type .pill-choice').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      typeSel = btn.dataset.type;
      document.getElementById('input-type-frais').value = typeSel;
      document.querySelectorAll('#palette-type .pill-choice').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('bloc-tranche').style.display = typeSel==='apprentissage' ? '' : 'none';
    });
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('form-paiement').addEventListener('submit', (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const isApprentissage = fd.get('type')==='apprentissage';
    const paiement = {
      id: uid(),
      type: fd.get('type'),
      tranche: isApprentissage ? Number(fd.get('tranche'))||1 : null,
      montant: Number(fd.get('montant'))||0,
      date: fd.get('date')||todayISO(),
      mode: fd.get('mode').trim(),
    };
    const list = DB.get(KEYS.apprentis, []);
    const i = list.findIndex(x=>x.id===apprentiId);
    if(i<0) return;
    list[i].paiements = list[i].paiements || [];
    list[i].paiements.push(paiement);
    const ok = DB.set(KEYS.apprentis, list);
    if(!ok){ alert("Échec de l'enregistrement : mémoire de stockage insuffisante."); return; }
    closeModal();
    openApprentiDetail(apprentiId);
  });
}

/* ==================== PARAMÈTRES ==================== */
function renderParametres(){
  const p = DB.get(KEYS.parametres, {});
  const licenceStockee = DB.get(KEYS.licence, null);
  root.innerHTML = `
    <h2 class="section-title">Paramètres</h2>
    <div class="dash-block">
      <div class="form-section-label" style="margin-top:0;">Licence</div>
      ${licenceStockee ? `
        <p style="font-size:.85rem;color:var(--encre);margin:0 0 4px;"><b>${licenceLabel(licenceStockee.type)}</b></p>
        <p style="font-size:.8rem;color:#8a7f71;margin:0 0 12px;">${licenceStockee.exp==='99991231' ? 'Validité illimitée' : `Expire le ${licenceExpLabel(licenceStockee.exp)}`}</p>
      ` : `<p style="font-size:.8rem;color:#8a7f71;margin:0 0 12px;">Aucune licence enregistrée.</p>`}
      <button type="button" id="btn-licence-modifier" class="btn btn-outline btn-block" style="margin-bottom:18px;">Modifier la clé de licence</button>
      <form id="form-parametres">
        <div class="form-group">
          <label>Logo de l'atelier</label>
          <div id="logo-preview-wrap" class="photo-preview-wrap">
            ${p.logo ? `<img id="logo-preview" src="${p.logo}">` : `<div class="photo-preview-empty">Aucun logo importé</div>`}
          </div>
          <input type="file" accept="image/*" id="input-logo" style="margin-top:8px;">
          <p style="font-size:.72rem;color:#8a7f71;margin-top:4px;">Ce logo apparaît en filigrane répété sur le contrat, l'attestation et le diplôme.</p>
        </div>
        <div class="form-section-label">Identité de l'atelier</div>
        <div class="form-group"><label>Pays</label><input type="text" name="pays" value="${escapeAttr(p.pays||'')}"></div>
        <div class="form-group"><label>Nom de l'atelier</label><input type="text" name="nomAtelier" value="${escapeAttr(p.nomAtelier||'')}"></div>
        <div class="form-group"><label>Raison sociale (optionnel)</label><input type="text" name="raisonSociale" placeholder="ex: Kinvos Group SARL" value="${escapeAttr(p.raisonSociale||'')}"></div>
        <div class="form-group"><label>Sous-titre / activité</label><input type="text" name="sousTitreAtelier" value="${escapeAttr(p.sousTitreAtelier||'')}"></div>
        <div class="form-group"><label>Slogan</label><textarea name="slogan" rows="2">${escapeHtml(p.slogan||'')}</textarea></div>
        <div class="form-group"><label>Adresse</label><input type="text" name="adresse" value="${escapeAttr(p.adresse||'')}"></div>
        <div class="form-grid">
          <div class="form-group"><label>Ville</label><input type="text" name="ville" value="${escapeAttr(p.ville||'')}"></div>
          <div class="form-group"><label>Commune</label><input type="text" name="commune" value="${escapeAttr(p.commune||'')}"></div>
        </div>
        <div class="form-group"><label>Département</label><input type="text" name="departement" value="${escapeAttr(p.departement||'')}"></div>
        <div class="form-group"><label>Téléphone</label><input type="tel" name="telephone" value="${escapeAttr(p.telephone||'')}"></div>

        <div class="form-section-label">Responsable (pour signatures)</div>
        <div class="form-group"><label>Nom de la responsable (ex: Mme Catrina AHOUANSOU)</label><input type="text" name="nomResponsable" value="${escapeAttr(p.nomResponsable||'')}"></div>
        <div class="form-grid">
          <div class="form-group"><label>Âge</label><input type="number" name="ageResponsable" value="${escapeAttr(p.ageResponsable||'')}"></div>
          <div class="form-group"><label>Profession</label><input type="text" name="professionResponsable" value="${escapeAttr(p.professionResponsable||'')}"></div>
        </div>
        <div class="form-group"><label>Titre affiché sous la signature</label><input type="text" name="titreResponsable" value="${escapeAttr(p.titreResponsable||'')}"></div>

        <div class="form-section-label">Horaires de formation (contrat)</div>
        <div class="form-grid">
          <div class="form-group"><label>Jours</label><input type="text" name="joursFormation" value="${escapeAttr(p.joursFormation||'')}"></div>
          <div class="form-group"><label>Horaires</label><input type="text" name="horairesFormation" value="${escapeAttr(p.horairesFormation||'')}"></div>
        </div>

        <div class="form-section-label">Frais par défaut (pré-remplissage des nouvelles fiches)</div>
        <div class="form-grid">
          <div class="form-group"><label>Frais d'apprentissage</label><input type="number" name="fraisApprentissageDefaut" value="${escapeAttr(p.fraisApprentissageDefaut||0)}"></div>
          <div class="form-group"><label>Nombre de tranches</label><input type="number" name="nombreTranchesDefaut" value="${escapeAttr(p.nombreTranchesDefaut||1)}"></div>
        </div>
        <div class="form-grid">
          <div class="form-group"><label>Inscription</label><input type="number" name="fraisInscriptionDefaut" value="${escapeAttr(p.fraisInscriptionDefaut||0)}"></div>
          <div class="form-group"><label>Fournitures</label><input type="number" name="fraisFournituresDefaut" value="${escapeAttr(p.fraisFournituresDefaut||0)}"></div>
        </div>
        <div class="form-grid">
          <div class="form-group"><label>Uniforme</label><input type="number" name="fraisUniformeDefaut" value="${escapeAttr(p.fraisUniformeDefaut||0)}"></div>
          <div class="form-group"><label>Dossier</label><input type="number" name="fraisDossierDefaut" value="${escapeAttr(p.fraisDossierDefaut||0)}"></div>
        </div>

        <button type="submit" class="btn btn-primary btn-block">Enregistrer</button>
      </form>
    </div>
  `;
  document.getElementById('btn-licence-modifier').addEventListener('click', ouvrirModalChangerLicence);
  let pendingLogo = p.logo || null;
  document.getElementById('input-logo').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      pendingLogo = await resizeImageFile(file, 400);
      document.getElementById('logo-preview-wrap').innerHTML = `<img id="logo-preview" src="${pendingLogo}">`;
    }catch(err){ alert("Impossible de charger cette image."); }
  });
  document.getElementById('form-parametres').addEventListener('submit', (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {
      logo: pendingLogo,
      pays: fd.get('pays').trim(),
      nomAtelier: fd.get('nomAtelier').trim(),
      raisonSociale: fd.get('raisonSociale').trim(),
      sousTitreAtelier: fd.get('sousTitreAtelier').trim(),
      slogan: fd.get('slogan').trim(),
      adresse: fd.get('adresse').trim(),
      ville: fd.get('ville').trim(),
      commune: fd.get('commune').trim(),
      departement: fd.get('departement').trim(),
      telephone: fd.get('telephone').trim(),
      nomResponsable: fd.get('nomResponsable').trim(),
      ageResponsable: fd.get('ageResponsable'),
      professionResponsable: fd.get('professionResponsable').trim(),
      titreResponsable: fd.get('titreResponsable').trim(),
      joursFormation: fd.get('joursFormation').trim(),
      horairesFormation: fd.get('horairesFormation').trim(),
      fraisApprentissageDefaut: Number(fd.get('fraisApprentissageDefaut'))||0,
      nombreTranchesDefaut: Number(fd.get('nombreTranchesDefaut'))||1,
      fraisInscriptionDefaut: Number(fd.get('fraisInscriptionDefaut'))||0,
      fraisFournituresDefaut: Number(fd.get('fraisFournituresDefaut'))||0,
      fraisUniformeDefaut: Number(fd.get('fraisUniformeDefaut'))||0,
      fraisDossierDefaut: Number(fd.get('fraisDossierDefaut'))||0,
    };
    DB.set(KEYS.parametres, data);
    alert('Paramètres enregistrés.');
  });
}

function ouvrirModalChangerLicence(){
  showModal(`
    <div class="modal-title">Clé de licence</div>
    <p style="font-size:.82rem;color:#8a7f71;margin:0 0 10px;">Entrez une nouvelle clé pour l'activer ou renouveler votre licence.</p>
    <input type="text" id="license-input-modal" placeholder="EZT-X-XXXXXXXX-XXXXXXXXXX" autocapitalize="characters" autocomplete="off" spellcheck="false">
    <div id="license-error-modal" class="license-error"></div>
    <button type="button" id="btn-activer-licence-modal" class="btn btn-primary btn-block">Activer</button>
  `);
  const btn = document.getElementById('btn-activer-licence-modal');
  const input = document.getElementById('license-input-modal');
  const errEl = document.getElementById('license-error-modal');
  btn.addEventListener('click', async ()=>{
    const raw = input.value.trim();
    errEl.textContent = '';
    if(!raw){ errEl.textContent = 'Entrez une clé.'; return; }
    btn.disabled = true; btn.textContent = 'Vérification...';
    const result = await licenceVerify(raw);
    btn.disabled = false; btn.textContent = 'Activer';
    if(!result.valid){
      errEl.textContent = result.reason === 'expired' ? 'Cette clé a expiré.' : 'Clé invalide.';
      return;
    }
    DB.set(KEYS.licence, { key: result.key, type: result.type, exp: result.exp });
    closeModal();
    renderParametres();
  });
  input.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') btn.click(); });
}

/* ==================== IMPRESSION (contrat / quittance / attestation / diplôme) ==================== */
function printAreaShow(html){
  let area = document.getElementById('print-area');
  if(!area){
    area = document.createElement('div');
    area.id = 'print-area';
    document.body.appendChild(area);
  }
  area.innerHTML = html;
  setTimeout(()=>window.print(), 80);
}

// Construit un motif de filigrane (logo centré dans une case plus grande que
// lui) sous forme de data-URI SVG : le vide autour du logo, à l'intérieur de
// chaque case répétée, donne l'espacement entre les logos. tuile = taille de
// la case répétée (donc de l'espacement obtenu), logo = taille du logo
// affiché dans cette case (plus petit que la tuile).
function watermarkPatternURI(logoDataURL, tuile, logo){
  const offset = (tuile - logo) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tuile}" height="${tuile}"><image href="${logoDataURL}" x="${offset}" y="${offset}" width="${logo}" height="${logo}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
// Filigrane : logo agrandi, avec un vrai espacement entre chaque répétition
// (tuile nettement plus grande que le logo), le tout incliné en diagonale
// (voir .doc-watermark en CSS) pour un rendu filigrane plus élégant.
function watermarkDiv(p){
  if(!p.logo) return '';
  const tuile = 320, logo = 150; // ~170px d'espacement entre chaque logo
  const pattern = watermarkPatternURI(p.logo, tuile, logo);
  return `<div class="doc-watermark" style="background-image:url('${pattern}');background-size:${tuile}px ${tuile}px;"></div>`;
}

function docBrandHeader(p, a){
  return `
    <div class="doc-brand-header">
      ${p.logo?`<img src="${p.logo}" class="doc-logo">`:''}
      <div class="doc-atelier">
        ${p.pays?`<div class="doc-pays">${escapeHtml(p.pays)}</div>`:''}
        <div class="doc-atelier-nom">${escapeHtml(p.nomAtelier||'Atelier de couture')}</div>
        ${p.raisonSociale?`<div class="doc-raison-sociale">(${escapeHtml(p.raisonSociale)})</div>`:''}
        ${p.sousTitreAtelier?`<div class="doc-soustitre">${escapeHtml(p.sousTitreAtelier.toUpperCase())}</div>`:''}
        ${p.slogan?`<div class="doc-slogan">${escapeHtml(p.slogan)}</div>`:''}
        ${(p.adresse||p.ville)?`<div class="doc-coord">Adresse : ${escapeHtml([p.adresse,p.ville].filter(Boolean).join(', '))}</div>`:''}
        ${p.telephone?`<div class="doc-coord">Tél. : ${escapeHtml(p.telephone)}</div>`:''}
      </div>
      ${a && a.photoIdentite ? `<div class="doc-id-photo"><img src="${a.photoIdentite}"></div>` : ''}
    </div>
  `;
}

/* ---------- Contrat d'apprentissage (12 articles) ---------- */
function trancheRows(a){
  const n = Math.max(1, Number(a.nombreTranches)||1);
  const montant = Math.round((Number(a.fraisApprentissage)||0) / n);
  let rows = '';
  const ordinaux = ['1ère','2ème','3ème','4ème','5ème','6ème','7ème','8ème','9ème','10ème'];
  for(let i=0;i<n;i++){
    rows += `<tr><td>${ordinaux[i]||(i+1)+'ème'} tranche</td><td>${fmtFCFA(montant)}</td></tr>`;
  }
  return rows;
}

function v(text){ return `<span class="doc-var">${text}</span>`; }

function printContrat(a){
  const p = DB.get(KEYS.parametres, {});
  const autresTotal = (Number(a.fraisInscription)||0)+(Number(a.fraisFournitures)||0)+(Number(a.fraisUniforme)||0)+(Number(a.fraisDossier)||0);
  const metier = a.specialite || 'coupe-couture';
  const html = `
    <div class="doc-page doc-contrat">
      ${watermarkDiv(p)}
      <div class="doc-content">
        ${a.photoIdentite?`<div class="doc-id-photo" style="position:absolute;top:10px;right:10px;">${`<img src="${a.photoIdentite}">`}</div>`:''}
        <p class="doc-pays-line">${escapeHtml(p.pays||'RÉPUBLIQUE DU BÉNIN')}</p>
        <h1 class="doc-title doc-title-contrat">CONTRAT D'APPRENTISSAGE</h1>
        <p class="doc-subline">${escapeHtml(p.nomAtelier||'ATELIER DE COUTURE')}${p.sousTitreAtelier?' – '+escapeHtml(p.sousTitreAtelier.toUpperCase()):''}</p>
        ${(p.commune||p.departement)?`<p class="doc-subline-2">${[p.commune&&('Commune de '+p.commune),p.departement&&('Département '+p.departement)].filter(Boolean).map(escapeHtml).join(' — ')}</p>`:''}

        <p class="doc-article-title">Article 1 – Identification des parties</p>
        <p><strong>MAÎTRE D'APPRENTISSAGE :</strong> Nom/prénoms : ${v(escapeHtml(p.nomResponsable||'.......................................'))} — Âge : ${v(escapeAttr(p.ageResponsable)||'....')} — Profession : ${v(escapeHtml(p.professionResponsable||'....................'))} — Domicile : ${v(escapeHtml(p.adresse||'....................'))} — Téléphone : ${v(escapeHtml(p.telephone||'....................'))}</p>
        <p><strong>APPRENTI(E) :</strong> Nom/prénoms : ${v(escapeHtml(a.nom))} — Date/lieu de naissance : ${v((a.dateNaissance?fmtDate(a.dateNaissance):'..../..../......')+(a.lieuNaissance?' à '+escapeHtml(a.lieuNaissance):''))} — Âge : ${v(calcAge(a.dateNaissance)||'....')} — Domicile : ${v(escapeHtml(a.adresse||'....................'))} — Téléphone : ${v(escapeHtml(a.telephone||'....................'))}</p>
        <p><strong>PARENT/TUTEUR (si mineur) :</strong> Nom/prénoms : ${v(escapeHtml(a.tuteurNom||'....................'))} — Profession : ${v(escapeHtml(a.tuteurProfession||'....................'))} — Âge : ${v(escapeAttr(a.tuteurAge)||'....')} — Domicile : ${v(escapeHtml(a.tuteurDomicile||'....................'))} — Téléphone : ${v(escapeHtml(a.tuteurTelephone||'....................'))}</p>

        <p class="doc-article-title">Article 2 – Objet et métier enseigné</p>
        <p>Formation pratique et professionnelle dans le métier de la ${v(escapeHtml(metier))} : mesures, tracé, coupe, assemblage, finitions, machines, confection et pagnes africains/Wax.</p>

        <p class="doc-article-title">Article 3 – Lieu de l'apprentissage</p>
        <p>Atelier : ${v(escapeHtml(p.nomAtelier||'....................'))} — Adresse : ${v(escapeHtml(p.adresse||'....................'))} — Commune : ${v(escapeHtml(p.commune||'....................'))} — Département : ${v(escapeHtml(p.departement||'....................'))}</p>

        <p class="doc-article-title">Article 4 – Date et durée de l'apprentissage</p>
        <p>Début : ${v(fmtDate(a.dateDebut))} — Fin : ${v(a.dateFin?fmtDate(a.dateFin):'..../..../......')} — Durée : ${v(escapeHtml(a.duree||'....................'))}</p>

        <p class="doc-article-title">Article 5 – Horaires, assiduité et repos</p>
        <p>Jours : ${v(escapeHtml(p.joursFormation||'....................'))} — Horaires : ${v(escapeHtml(p.horairesFormation||'....................'))}. Toute absence doit être signalée au maître d'apprentissage.</p>

        <p class="doc-article-title">Article 6 – Frais d'apprentissage : ${v(fmtFCFA(a.fraisApprentissage))}</p>
        <p>Les frais d'apprentissage sont distincts des autres frais et sont payés en ${v(a.nombreTranches||1)} tranche(s).</p>
        <table class="doc-table">
          <tr><th>Échéance</th><th>Montant</th></tr>
          ${trancheRows(a)}
          <tr><td><strong>TOTAL</strong></td><td><strong>${fmtFCFA(a.fraisApprentissage)}</strong></td></tr>
        </table>

        <p class="doc-article-title">Article 7 – Autres frais, séparés des frais d'apprentissage</p>
        <p>Ces frais ne sont pas inclus dans les tranches d'apprentissage.</p>
        <table class="doc-table">
          <tr><th>Nature du frais</th><th>Montant</th></tr>
          <tr><td>Droits d'inscription</td><td>${fmtFCFA(a.fraisInscription)}</td></tr>
          <tr><td>Fournitures</td><td>${fmtFCFA(a.fraisFournitures)}</td></tr>
          <tr><td>Uniformes</td><td>${fmtFCFA(a.fraisUniforme)}</td></tr>
          <tr><td>Frais de dossier</td><td>${fmtFCFA(a.fraisDossier)}</td></tr>
          <tr><td><strong>TOTAL</strong></td><td><strong>${fmtFCFA(autresTotal)}</strong></td></tr>
        </table>
        <p><strong>Montant total indicatif : ${v(fmtFCFA(a.montantTotal))}.</strong></p>

        <p class="doc-article-title">Article 8 – Engagements du maître d'apprentissage</p>
        <p>Former méthodiquement ; affecter l'apprenti aux travaux du métier ; assurer sécurité et hygiène ; informer le représentant légal lorsque nécessaire ; ne pas infliger de punition corporelle ni d'amende ; permettre les cours prévus ; présenter aux épreuves prévues.</p>

        <p class="doc-article-title">Article 9 – Engagements de l'apprenti(e)</p>
        <p>Respecter horaires et instructions ; assiduité, discipline, loyauté et respect ; soin du matériel ; respect des règles d'hygiène et de sécurité ; suivi sérieux des cours et évaluations.</p>

        <p class="doc-article-title">Article 10 – Suspension, fin et rupture du contrat</p>
        <p>Le contrat prend fin à l'expiration de sa durée ou dans les autres cas prévus par les textes applicables. Toute rupture doit respecter les formalités requises.</p>

        <p class="doc-article-title">Article 11 – Règlement des différends</p>
        <p>Les parties recherchent d'abord une solution amiable. À défaut, elles peuvent s'adresser aux organisations professionnelles et/ou services compétents du Travail.</p>

        <p class="doc-article-title">Article 12 – Déclaration des parties</p>
        <p>Les parties déclarent avoir pris connaissance du contrat et s'engagent à respecter ses clauses. Les montants doivent être vérifiés avant signature.</p>

        <p class="doc-place-date">Fait à ${v(escapeHtml(p.ville||'....................'))}, le ${v(fmtDate(todayISO()))}</p>

        <div class="doc-signatures doc-signatures-3">
          <div><div class="doc-sign-line"></div><div>LE MAÎTRE D'APPRENTISSAGE<br>Nom : ..................<br>Signature :</div></div>
          <div><div class="doc-sign-line"></div><div>L'APPRENTI(E)<br>Nom : ..................<br>Signature :</div></div>
          <div><div class="doc-sign-line"></div><div>PARENT / TUTEUR<br>Nom : ..................<br>Signature :</div></div>
        </div>
      </div>
    </div>
  `;
  printAreaShow(html);
}

/* ---------- Quittance de paiement ---------- */
function printQuittance(a, paiement){
  const p = DB.get(KEYS.parametres, {});
  const s = soldeApprenti(a);
  const html = `
    <div class="doc-page doc-quittance">
      ${watermarkDiv(p)}
      <div class="doc-content">
        ${docBrandHeader(p, a)}
        <h1 class="doc-title">QUITTANCE DE PAIEMENT</h1>
        <p>Reçu de : <strong>${escapeHtml(a.nom)}</strong></p>
        <p>Motif : ${motifLabel(a.motif)} — ${escapeHtml(a.specialite||'')}</p>
        <table class="doc-table">
          <tr><td>Nature du versement</td><td>${typeFraisLabel(paiement.type)}</td></tr>
          <tr><td>Montant versé</td><td>${fmtFCFA(paiement.montant)}</td></tr>
          <tr><td>Date</td><td>${fmtDate(paiement.date)}</td></tr>
          ${paiement.mode?`<tr><td>Mode de paiement</td><td>${escapeHtml(paiement.mode)}</td></tr>`:''}
          <tr><td>Total dû</td><td>${fmtFCFA(s.total)}</td></tr>
          <tr><td>Total payé à ce jour</td><td>${fmtFCFA(s.paye)}</td></tr>
          <tr><td><strong>Solde restant</strong></td><td><strong>${fmtFCFA(s.restant)}</strong></td></tr>
        </table>
        <div class="doc-signatures">
          <div><div class="doc-sign-line"></div><div>Signature</div></div>
          <div><div class="doc-sign-line"></div><div>Cachet de l'atelier</div></div>
        </div>
        <p class="doc-place-date">Fait à ${escapeHtml(p.ville||'—')}, le ${fmtDate(todayISO())}</p>
      </div>
    </div>
  `;
  printAreaShow(html);
}

/* ---------- En-tête des certificats (logo + nom atelier + coordonnées) ---------- */
function certGoldDivider(color, small){
  return `<div class="doc-cert-divider${small?' doc-cert-divider-sm':''}"><svg viewBox="0 0 150 16" xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="8" x2="60" y2="8" stroke="${color}" stroke-width="1.2"/><path d="M75 2 L81 8 L75 14 L69 8 Z" fill="${color}"/><line x1="90" y1="8" x2="150" y2="8" stroke="${color}" stroke-width="1.2"/></svg></div>`;
}

/* Fleuron doré en forme de coin, utilisé aux 4 angles du cadre de l'Attestation */
function certCornerFlourish(){
  return `<svg class="doc-cert-corner" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 54 C6 24 6 6 36 6" fill="none" stroke="#C9A227" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M6 44 C18 44 24 38 24 28" fill="none" stroke="#C9A227" stroke-width="1.3" stroke-linecap="round" opacity=".7"/>
    <path d="M36 6 C42 6 46 10 46 16 C46 21.5 41.5 25 36 24" fill="none" stroke="#C9A227" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="6" cy="54" r="3" fill="#C9A227"/>
    <circle cx="36" cy="6" r="2.2" fill="#C9A227"/>
  </svg>`;
}

/* Icône livre pour l'encadré "Enregistrée dans les livres de l'atelier" */
function regbookIcon(){
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 5.5c-1.6-1-3.7-1.5-5.6-1.5C4.9 4 3.4 4.3 2 5v13.2c1.4-.6 2.9-.9 4.4-.9 1.9 0 4 .5 5.6 1.5 1.6-1 3.7-1.5 5.6-1.5 1.5 0 3 .3 4.4.9V5c-1.4-.6-2.9-.9-4.4-.9-1.9 0-4 .5-5.6 1.5zM12 5.5v13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function certSeal(color){
  return `<svg class="doc-cert-seal" viewBox="0 0 58 74" xmlns="http://www.w3.org/2000/svg">
    <polygon points="14,34 8,74 29,62 50,74 44,34" fill="${color}"/>
    <circle cx="29" cy="27" r="27" fill="${color}"/>
    <circle cx="29" cy="27" r="21" fill="none" stroke="#fff" stroke-width="1.4" stroke-dasharray="2 2"/>
    <path d="M29 15 L32.4 23.6 L41.5 23.9 L34.3 29.6 L36.9 38.4 L29 33.2 L21.1 38.4 L23.7 29.6 L16.5 23.9 L25.6 23.6 Z" fill="#fff" opacity="0.92"/>
  </svg>`;
}

/* Cadre décoratif de l'Attestation/du Diplôme : un vrai cadre plein (SVG),
   dont le bord intérieur est droit sur trois côtés et ondulé (vague non
   uniforme, amplitudes variables) sur le côté bas — nettement plus visible
   qu'un border-image fin. w/h en mm (dimensions de la page), color = couleur
   du cadre (différente pour l'Attestation et le Diplôme), accent = liseré
   doré intérieur.
   La vague est générée par une chaîne de courbes de Bézier quadratiques dont
   l'amplitude change à chaque segment (non uniforme), en Q x-milieu,y-crête
   x-fin,y-base — chaque segment revient à la ligne de base avant le suivant. */
function wavyLinePath(xStart, xEnd, yBase, amps){
  const n = amps.length;
  const segW = (xEnd - xStart) / n;
  let d = `M${xStart.toFixed(1)},${yBase.toFixed(1)}`;
  for(let i=0;i<n;i++){
    const xMid = xStart + segW*(i+0.5);
    const xEndSeg = xStart + segW*(i+1);
    const yCtrl = yBase + amps[i];
    d += ` Q${xMid.toFixed(1)},${yCtrl.toFixed(1)} ${xEndSeg.toFixed(1)},${yBase.toFixed(1)}`;
  }
  return d;
}
function certFrameSVG(w, h, color, accent){
  const t = 10; // épaisseur du cadre, en mm
  const yBase = h - t;
  const amps = [5,-4.5,6,-3.5,5,-5]; // amplitudes non uniformes de la vague (mm)
  const innerTop = `M${t},${t} H${w-t} V${yBase.toFixed(1)}`;
  const innerWave = wavyLinePath(w-t, t, yBase, amps);
  const innerClose = ` V${t} Z`;
  const innerPath = innerTop + ' ' + innerWave + innerClose;
  const outerPath = `M0,0 H${w} V${h} H0 Z`;
  // Liseré doré fin, juste en retrait de la vague, qui suit le même tracé
  const a2 = t + 3.2;
  const yBase2 = h - a2;
  const amps2 = amps.map(v=>v*0.86);
  const accentTop = `M${a2},${a2} H${w-a2}`;
  const accentRight = ` V${yBase2.toFixed(1)}`;
  const accentWave = wavyLinePath(w-a2, a2, yBase2, amps2);
  const accentLeft = ` V${a2}`;
  // Construit l'image en SVG "à plat" (pas de <svg> vivant dans le DOM :
  // html2canvas, utilisé pour l'export PDF du diplôme/de l'attestation, ne
  // rend pas correctement les <svg> inline complexes — seul un trait fin
  // apparaissait. En passant par une image (data-URI en fond de div, comme
  // pour le filigrane juste au-dessus, méthode déjà éprouvée), le cadre est
  // rasterisé nativement par le navigateur et s'exporte plein et net.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><path d="${outerPath} ${innerPath}" fill="${color}" fill-rule="evenodd"/><path d="${accentTop}${accentRight} ${accentWave}${accentLeft}" fill="none" stroke="${accent}" stroke-width="0.9" opacity=".85"/><circle cx="${t}" cy="${t}" r="2.6" fill="${accent}"/><circle cx="${w-t}" cy="${t}" r="2.6" fill="${accent}"/><circle cx="${t}" cy="${yBase}" r="2" fill="${accent}"/><circle cx="${w-t}" cy="${yBase}" r="2.9" fill="${accent}"/></svg>`;
  const uri = 'data:image/svg+xml,' + encodeURIComponent(svg);
  return `<div class="doc-cert-frame-svg" style="background-image:url('${uri}');"></div>`;
}

function certHeader(p, a, extraClass, innerDividers){
  const hasSoustitre = p.sousTitreAtelier || p.slogan;
  const hasCoord = p.adresse || p.ville || p.telephone;
  return `
    <div class="doc-cert-topbar${extraClass?' '+extraClass:''}">
      <div class="doc-cert-logo-wrap">
        ${p.logo?`<img src="${p.logo}" class="doc-cert-logo">`:`<div class="doc-cert-logo-placeholder">✂</div>`}
        <div class="doc-cert-logo-name">${escapeHtml((p.nomAtelier||'ATELIER').toUpperCase())}</div>
        ${p.raisonSociale?`<div class="doc-cert-logo-sub">(${escapeHtml(p.raisonSociale)})</div>`:''}
      </div>
      <div class="doc-cert-headtext">
        <div class="doc-cert-pays">${escapeHtml(p.pays||'RÉPUBLIQUE DU BÉNIN')}</div>
        <div class="doc-cert-atelier">${escapeHtml(p.nomAtelier||'Atelier de couture')}</div>
        ${p.raisonSociale?`<div class="doc-cert-raison">(${escapeHtml(p.raisonSociale)})</div>`:''}
        ${(innerDividers && hasSoustitre)?certGoldDivider('#C9A227', true):''}
        ${p.sousTitreAtelier?`<div class="doc-cert-soustitre">${escapeHtml(p.sousTitreAtelier.toUpperCase())}</div>`:''}
        ${p.slogan?`<div class="doc-cert-slogan">${escapeHtml(p.slogan)}</div>`:''}
        ${(innerDividers && hasCoord)?certGoldDivider('#C9A227', true):''}
        ${(p.adresse||p.ville)?`<div class="doc-cert-coord"><b>Adresses :</b> ${escapeHtml([p.adresse,p.ville].filter(Boolean).join(', '))}</div>`:''}
        ${p.telephone?`<div class="doc-cert-coord"><b>Tél. :</b> ${escapeHtml(p.telephone)}</div>`:''}
      </div>
      <div class="doc-cert-photobox">${a && a.photoIdentite ? `<img src="${a.photoIdentite}">` : ''}</div>
    </div>
  `;
}

/* Cadre orné (filet or + bandeau bleu marine renforcé aux angles) utilisé par le Diplôme */
function certOrnateFrameSVG(){
  return `
    <svg class="doc-cert-frame-diplome-svg" viewBox="0 0 1414 1000" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <path id="dcorner" d="M0,500 L0,14 Q0,0 14,0 L707,0 L707,14 L180,14 C120,14 85,18 60,40 C30,66 16,110 14,180 L14,500 Z"/>
      </defs>
      <rect x="6" y="6" width="1402" height="988" rx="18" fill="none" stroke="#C9A227" stroke-width="3.5"/>
      <g fill="var(--doc-c1)" stroke="#C9A227" stroke-width="5" stroke-linejoin="round">
        <use href="#dcorner"/>
        <use href="#dcorner" transform="scale(-1,1) translate(-1414,0)"/>
        <use href="#dcorner" transform="scale(1,-1) translate(0,-1000)"/>
        <use href="#dcorner" transform="scale(-1,-1) translate(-1414,-1000)"/>
      </g>
    </svg>
  `;
}

/* Petit fleuron doré décoratif, réservé au bas du Diplôme */
function certBottomOrnament(){
  return `
    <div class="doc-cert-bottom-ornament">
      <svg viewBox="0 0 180 38" xmlns="http://www.w3.org/2000/svg">
        <path d="M2,19 C24,19 30,9 42,9 C50,9 52,15 58,17" fill="none" stroke="#C9A227" stroke-width="1.4"/>
        <path d="M178,19 C156,19 150,9 138,9 C130,9 128,15 122,17" fill="none" stroke="#C9A227" stroke-width="1.4"/>
        <circle cx="42" cy="9" r="2.2" fill="#C9A227"/>
        <circle cx="138" cy="9" r="2.2" fill="#C9A227"/>
        <path d="M90,4 L96,19 L90,34 L84,19 Z" fill="#C9A227"/>
        <path d="M58,17 C70,22 76,22 84,19" fill="none" stroke="#C9A227" stroke-width="1.4"/>
        <path d="M122,17 C110,22 104,22 96,19" fill="none" stroke="#C9A227" stroke-width="1.4"/>
      </svg>
    </div>
  `;
}

/* Variable (nom, date, ville...) affichée en couleur vive et grasse — réservé au Diplôme */
function vv(text){ return `<span class="doc-cert-var">${text}</span>`; }

/* ---------- Historique des paiements d'un apprenti ---------- */
function printHistoriquePaiements(a){
  const p = DB.get(KEYS.parametres, {});
  const s = soldeApprenti(a);
  const paiements = (a.paiements||[]).slice().sort((p1,p2)=>(p1.date||'').localeCompare(p2.date||''));
  const rows = paiements.length ? paiements.map(pmt=>`
    <tr>
      <td>${fmtDate(pmt.date)}</td>
      <td>${typeFraisLabel(pmt.type)}${pmt.tranche?` — ${pmt.tranche}${pmt.tranche===1?'ère':'ème'} tranche`:''}</td>
      <td style="text-align:right;">${fmtFCFA(pmt.montant)}</td>
    </tr>`).join('') : `<tr><td colspan="3" style="text-align:center;color:#8a7f71;">Aucun versement enregistré.</td></tr>`;
  const html = `
    <div class="doc-page doc-historique">
      ${watermarkDiv(p)}
      <div class="doc-content">
        ${docBrandHeader(p, a)}
        <h1 class="doc-title">HISTORIQUE DES PAIEMENTS</h1>
        <p>Apprenti(e)/Stagiaire : <strong>${escapeHtml(a.nom)}</strong></p>
        <p>Motif : ${motifLabel(a.motif)} — ${escapeHtml(a.specialite||'')}</p>
        <table class="doc-table">
          <tr><th>Date</th><th>Nature</th><th style="text-align:right;">Montant</th></tr>
          ${rows}
        </table>
        <table class="doc-table" style="margin-top:14px;">
          <tr><td><strong>Total dû</strong></td><td style="text-align:right;"><strong>${fmtFCFA(s.total)}</strong></td></tr>
          <tr><td><strong>Total payé</strong></td><td style="text-align:right;"><strong>${fmtFCFA(s.paye)}</strong></td></tr>
          <tr><td><strong>Solde restant</strong></td><td style="text-align:right;"><strong>${fmtFCFA(s.restant)}</strong></td></tr>
        </table>
        <p class="doc-place-date">Fait à ${escapeHtml(p.ville||'....................')}, le ${fmtDate(todayISO())}</p>
        <div class="doc-signatures">
          <div><div class="doc-sign-line"></div><div>Signature / Cachet</div></div>
        </div>
      </div>
    </div>
  `;
  printAreaShow(html);
}

/* ---------- Attestation de fin de stage (thème violet/or, A4 portrait) ----------
   Comme le Diplôme, l'attestation se télécharge directement en PDF haute
   résolution via attestationTelechargerPDF plus bas (html2canvas + jsPDF),
   pour un rendu net, non flou, garanti au format A4 portrait exact — sans
   dépendre des réglages d'impression/"enregistrer en PDF" du navigateur.
   attestationHtml() ne fait que construire le balisage, réutilisé aussi par
   printAttestation (gardée en secours pour une impression classique). */
function attestationHtml(a){
  const p = DB.get(KEYS.parametres, {});
  const metier = a.specialite || 'Couture Dame';
  return `
    <div class="doc-page doc-cert doc-page-attestation doc-purple">
      <div class="doc-cert-frame">
        ${certFrameSVG(210, 297, '#4B1F6F', '#C9A227')}
        ${watermarkDiv(p)}
        <div class="doc-cert-inner">
          ${certHeader(p, a, null, true)}
          ${certGoldDivider('#C9A227')}
          <div class="doc-cert-title-wrap">
            <h1 class="doc-cert-title">ATTESTATION</h1>
            <h2 class="doc-cert-subtitle2">DE FIN DE STAGE</h2>
          </div>
          ${certGoldDivider('#C9A227')}
          <div class="doc-cert-body2">
            <p>Je soussignée Mme ${v(escapeHtml(p.nomResponsable||'....................'))}, ${escapeHtml(p.professionResponsable||'Maîtresse Couturière')} demeurant à ${v(escapeHtml(p.ville||'....................'))}, atteste que :</p>
            <p>Mlle / Mme ${v('<strong>'+escapeHtml(a.nom)+'</strong>')}</p>
            <p>a effectué un stage pratique dans notre Atelier de ${escapeHtml(metier)}</p>
            <p>du ${v(fmtDate(a.dateDebut))} au ${v(a.dateFin?fmtDate(a.dateFin):fmtDate(todayISO()))}</p>
            <p>Durant cette période, elle s'est montrée <span class="doc-cert-accent-purple">consciencieuse, dévouée, honnête, assidue</span> et a su faire preuve d'un grand sens de responsabilité et d'apprentissage.</p>
            <p>Cette attestation lui est délivrée pour servir et valoir ce que de droit.</p>
            <p class="doc-place-date">Fait à ${v(escapeHtml(p.ville||'....................'))}, le ....................</p>
          </div>
          <div class="doc-cert-bottom">
            <div class="doc-cert-regbox">
              <div class="doc-cert-regbox-head">
                <div class="doc-cert-regbox-icon">${regbookIcon()}</div>
                <div class="doc-cert-regbox-title">ENREGISTRÉE DANS LES LIVRES DE L'ATELIER</div>
              </div>
              <div>N° d'enregistrement : ${vv(escapeHtml(a.numeroEnregistrement || '....................'))}</div>
              <div>Date d'enregistrement : ${vv(a.dateEnregistrement ? escapeHtml(fmtDate(a.dateEnregistrement)) : '....................')}</div>
              <div>Page : ${vv('....................')}</div>
            </div>
            ${certSeal('#C9A227')}
            <div class="doc-cert-signblock">
              <p class="doc-cert-signname">${escapeHtml(p.titreResponsable||'La Patronne')}</p>
              <div class="doc-sign-line" style="width:150px;margin-left:auto;"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
function printAttestation(a){ printAreaShow(attestationHtml(a)); }

/* ---------- Diplôme de fin d'apprentissage (thème bleu marine/or, A4 paysage) ----------
   Le diplôme ne passe pas par window.print() (qui ouvrirait la boîte de
   dialogue d'impression du navigateur et laisserait l'utilisateur choisir
   portrait/paysage) : il est directement converti en fichier PDF paysage et
   téléchargé, via diplomeTelechargerPDF plus bas. diplomeHtml() ne fait que
   construire le balisage, réutilisé à la fois par l'export PDF et par
   printDiplome (gardée en secours pour une impression classique si besoin). */
function diplomeHtml(a){
  const p = DB.get(KEYS.parametres, {});
  const metier = a.specialite || 'Couture Dame';
  return `
    <div class="doc-page doc-cert doc-page-diplome doc-navy">
      <div class="doc-cert-frame-diplome">
        ${certFrameSVG(297, 210, '#132A63', '#C9A227')}
        ${watermarkDiv(p)}
        <div class="doc-cert-inner">
          ${certHeader(p, a, 'doc-cert-topbar-diplome')}
          ${certGoldDivider('#C9A227')}
          <div class="doc-cert-title-wrap">
            <h1 class="doc-cert-title">DIPLÔME</h1>
            <h2 class="doc-cert-subtitle2">DE FIN D'APPRENTISSAGE</h2>
          </div>
          <div class="doc-cert-body2">
            <p>Je soussignée Mme ${vv(escapeHtml(p.nomResponsable||'....................'))}, ${escapeHtml(p.professionResponsable||'Maîtresse Couturière')} demeurant à ${vv(escapeHtml(p.ville||'....................'))}, certifie que la nommée ${vv('<strong>'+escapeHtml(a.nom)+'</strong>')} a été apprentie en ${escapeHtml(metier)} sous mes ordres du ${vv(fmtDate(a.dateDebut))} au ${vv(a.dateFin?fmtDate(a.dateFin):fmtDate(todayISO()))}.</p>
            <p>Pendant la période de son apprentissage, elle s'est montrée <span class="doc-cert-accent">consciencieuse, dévouée, honnête et assidue</span> à son métier.</p>
            <p>Elle me quitte nantie des connaissances nécessaires pour exercer le métier de ${escapeHtml(metier)}, et est libre de tout engagement.</p>
            <p>En foi de quoi je lui délivre son Diplôme pour servir et valoir ce que de droit.</p>
            <p class="doc-place-date">Fait à ${vv(escapeHtml(p.ville||'....................'))}, le ....................</p>
          </div>
          <div class="doc-cert-bottom" style="justify-content:flex-end;">
            ${certBottomOrnament()}
            <div class="doc-cert-signblock">
              <p class="doc-cert-signname">${escapeHtml(p.titreResponsable||'La Patronne')}</p>
              <div class="doc-sign-line" style="width:160px;margin-left:auto;"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
function printDiplome(a){ printAreaShow(diplomeHtml(a)); }

// Attend que toutes les images d'un conteneur (logo, photo d'identité...) aient
// fini de charger, sinon html2canvas peut capturer un cadre vide.
function waitForImagesLoaded(container){
  const imgs = Array.from(container.querySelectorAll('img'));
  return Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => {
    img.addEventListener('load', res, { once:true });
    img.addEventListener('error', res, { once:true });
  })));
}

/* Génère un vrai fichier PDF (haute résolution, non flou) à partir d'un
   balisage de document et déclenche son téléchargement directement, sans
   passer par la boîte de dialogue d'impression du navigateur — utilisé pour
   le Diplôme (paysage) et l'Attestation (portrait). scale:3 sur html2canvas
   produit un rendu net même après agrandissement (~280 dpi sur une page A4).
   Nécessite jsPDF + html2canvas (chargés via CDN dans index.html, mis en
   cache par le service worker après la première visite en ligne, donc
   disponibles ensuite hors connexion). */
async function docTelechargerPDF(html, pageSelector, orientation, largeurMm, hauteurMm, nomFichier){
  if(!window.html2canvas || !window.jspdf){
    alert("Le module de génération PDF n'a pas pu se charger. Vérifiez votre connexion internet puis réessayez.");
    return false;
  }
  let holder = document.getElementById('pdf-render-holder');
  if(!holder){
    holder = document.createElement('div');
    holder.id = 'pdf-render-holder';
    holder.className = 'pdf-render-holder';
    document.body.appendChild(holder);
  }
  holder.innerHTML = html;
  const target = holder.querySelector(pageSelector);
  await waitForImagesLoaded(target);
  // Petite pause pour laisser les polices (Baloo 2 / Inter) finir de s'appliquer.
  await new Promise(r => setTimeout(r, 60));
  try{
    const canvas = await window.html2canvas(target, { scale:3, useCORS:true, backgroundColor:'#ffffff' });
    const imgData = canvas.toDataURL('image/jpeg', 0.96);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation, unit:'mm', format:'a4', compress:true });
    pdf.addImage(imgData, 'JPEG', 0, 0, largeurMm, hauteurMm, undefined, 'FAST');
    pdf.save(nomFichier);
    return true;
  }catch(err){
    console.error('Échec génération PDF', err);
    alert("La génération du PDF a échoué. Réessayez, ou utilisez l'impression classique.");
    return false;
  }finally{
    holder.innerHTML = '';
  }
}
async function diplomeTelechargerPDF(a){
  const nomFichier = 'Diplome-' + (a.nom||'apprenti').trim().replace(/\s+/g,'_') + '.pdf';
  return docTelechargerPDF(diplomeHtml(a), '.doc-page-diplome', 'landscape', 297, 210, nomFichier);
}
async function attestationTelechargerPDF(a){
  const nomFichier = 'Attestation-' + (a.nom||'stagiaire').trim().replace(/\s+/g,'_') + '.pdf';
  return docTelechargerPDF(attestationHtml(a), '.doc-page-attestation', 'portrait', 210, 297, nomFichier);
}

/* ---------- Modal ---------- */
const modalEl = document.getElementById('modal');
const backdropEl = document.getElementById('modal-backdrop');
function showModal(html){ modalEl.innerHTML = html; modalEl.classList.add('open'); backdropEl.classList.add('open'); }
function closeModal(){ modalEl.classList.remove('open'); backdropEl.classList.remove('open'); modalEl.innerHTML=''; }
backdropEl.addEventListener('click', closeModal);

/* ---------- Recherche (icône header) ---------- */
document.getElementById('btn-search').addEventListener('click', ()=>{
  state.view='clientes'; state.searchQuery=''; render();
  setTimeout(()=>document.getElementById('search-input')?.focus(), 50);
});
document.getElementById('btn-parametres').addEventListener('click', ()=>{
  state.view='parametres'; render();
});

/* ---------- Navigation ---------- */
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{ state.view = btn.dataset.view; state.searchQuery=''; render(); });
});

/* ---------- Échappement HTML ---------- */
function escapeHtml(str){
  return String(str??'').replace(/[&<>"']/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
function escapeAttr(str){ return escapeHtml(str); }

/* ---------- FAB contextuel ---------- */
function updateFab(){
  document.querySelectorAll('.fab').forEach(f=>f.remove());
}

/* ---------- Migration des photos (localStorage -> IndexedDB) ----------
   Pour les installations existantes où des photos de modèles étaient déjà
   stockées en base64 dans localStorage : on les déplace vers IndexedDB une
   fois pour toutes, afin de libérer de la place pour accueillir bien plus
   de 180 modèles sans saturer le stockage du téléphone. */
async function migrerPhotosCatalogue(){
  if(localStorage.getItem('cd_photos_migrees')) return;
  const catalogue = DB.get(KEYS.catalogue, []);
  let changed = false;
  for(const m of catalogue){
    if(m.photo){
      const ok = await PhotoStore.set(m.id, m.photo);
      if(ok){ delete m.photo; m.hasPhoto = true; changed = true; }
    }
  }
  if(changed) DB.set(KEYS.catalogue, catalogue);
  localStorage.setItem('cd_photos_migrees', '1');
}

/* ---------- Migration des numéros de modèle ----------
   Pour les catalogues déjà existants (créés avant l'attribution automatique
   d'un numéro à chaque modèle) : on numérote les modèles qui n'en ont pas
   encore, dans leur ordre d'origine. */
function migrerNumerosModeles(){
  const catalogue = DB.get(KEYS.catalogue, []);
  let prochain = catalogue.reduce((m, x) => Math.max(m, Number(x.numero) || 0), 0) + 1;
  let changed = false;
  for(const m of catalogue){
    if(!m.numero){ m.numero = prochain++; changed = true; }
  }
  if(changed) DB.set(KEYS.catalogue, catalogue);
}
migrerNumerosModeles();

/* ---------- Init ---------- */
render();
migrerPhotosCatalogue().then(()=>{ if(state.view==='catalogue') render(); });

/* ---------- Écran de démarrage ---------- */
window.addEventListener('load', ()=>{
  const splash = document.getElementById('splash-screen');
  if(!splash) return;
  setTimeout(()=>{
    splash.classList.add('hide');
    setTimeout(()=>splash.remove(), 600);
  }, 1600);
});

/* ---------- Service worker ---------- */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

/* ---------- Installation PWA ("Télécharger l'application") ----------
   L'événement beforeinstallprompt est capturé au plus tôt dans le <head>
   d'index.html (avant même le chargement de ce script) et posé sur
   window.__deferredInstallPrompt, pour ne jamais le manquer. */
function deferredInstallPrompt(){ return window.__deferredInstallPrompt; }

function appEstDejaInstallee(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function estAppareilIOS(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function afficherBoutonInstaller(){
  const btn = document.getElementById('btn-install-app');
  if(!btn) return;
  if(appEstDejaInstallee()){ btn.style.display = 'none'; return; }
  btn.style.display = 'flex';
}
window.addEventListener('load', ()=>{ setTimeout(afficherBoutonInstaller, 600); });
window.addEventListener('__installPromptReady', afficherBoutonInstaller);

window.addEventListener('appinstalled', ()=>{
  window.__deferredInstallPrompt = null;
  const btn = document.getElementById('btn-install-app');
  if(btn) btn.style.display = 'none';
});

function installInfoModalHTML(ios){
  return `
    <div class="modal-title">⬇️ Installer EasyTailor</div>
    ${ios ? `
      <p style="font-size:.85rem;color:var(--bordeaux);line-height:1.7;">Pour installer EasyTailor sur votre iPhone / iPad :</p>
      <ol style="margin:0 0 4px 18px;padding:0;font-size:.85rem;line-height:1.9;color:#555;">
        <li>Appuyez sur le bouton <b>Partager</b> ⬆️ de Safari</li>
        <li>Choisissez <b>« Sur l'écran d'accueil »</b></li>
        <li>Appuyez sur <b>Ajouter</b></li>
      </ol>` : `
      <p style="font-size:.85rem;color:var(--bordeaux);line-height:1.7;">Pour installer EasyTailor comme une application :</p>
      <ol style="margin:0 0 4px 18px;padding:0;font-size:.85rem;line-height:1.9;color:#555;">
        <li>Ouvrez le menu de votre navigateur (⋮ ou ⋯)</li>
        <li>Choisissez <b>« Installer l'application »</b> ou <b>« Ajouter à l'écran d'accueil »</b></li>
        <li>Confirmez l'installation</li>
      </ol>
      <p style="font-size:.76rem;color:#8a7f71;margin-top:8px;">Si cette option n'apparaît pas, essayez avec Google Chrome ou Microsoft Edge.</p>`}
    <button type="button" class="btn btn-primary btn-block" onclick="closeModal()" style="margin-top:8px;">Compris</button>
  `;
}

document.getElementById('btn-install-app').addEventListener('click', ()=>{
  const prompt = deferredInstallPrompt();
  if(prompt){
    prompt.prompt();
    prompt.userChoice.finally(()=>{
      window.__deferredInstallPrompt = null;
      const btn = document.getElementById('btn-install-app');
      if(btn) btn.style.display = 'none';
    });
    return;
  }
  showModal(installInfoModalHTML(estAppareilIOS()));
});
