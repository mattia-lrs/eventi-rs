/**
 * Eventi R/S — dati per il sito + bot Telegram
 * Legge gli eventi di BuonaCaccia per rover e scolte (icona di branca R/S),
 * li passa al sito su GitHub Pages e, se attivi il bot, pubblica le novità in un canale Telegram.
 * Non raccoglie nessun dato di chi usa il sito.
 *
 * Il progetto Apps Script ha un solo file: Codice.gs (questo).
 * L'interfaccia è index.html nel repo GitHub.
 *
 * Installazione:
 * 1. script.google.com → Nuovo progetto. Incolla questo file in Codice.gs.
 * 2. Seleziona la funzione "diagnosi" → Esegui → autorizza.
 * 3. Esegui il deployment → Nuovo deployment → tipo "App web"
 *    Esegui come: Me · Chi ha accesso: Chiunque → Esegui il deployment.
 *    Copia il link /exec e incollalo nella costante API in cima a index.html.
 *    Quando modifichi questo file: Gestisci deployment → modifica → Nuova versione
 *    (così il link /exec non cambia).
 * 4. Scrivi in URL_SITO qui sotto l'indirizzo del sito su GitHub Pages.
 *
 * Bot Telegram:
 * 1. Su Telegram scrivi a @BotFather → /newbot → scegli nome e username.
 *    Ti dà un token tipo 123456:ABC-xyz. Tienilo per te: chi lo ha controlla il bot.
 * 2. Crea un canale Telegram e aggiungi il bot come amministratore,
 *    con il permesso di pubblicare messaggi.
 * 3. Impostazioni progetto (ingranaggio) → Proprietà script → aggiungi
 *    TELEGRAM_TOKEN  = il token del bot
 *    TELEGRAM_CHAT   = @nomecanale se il canale è pubblico. Se è privato: pubblica un
 *                      messaggio nel canale, esegui "trovaChatId" e copia il numero che inizia con -100
 *    TELEGRAM_INVITO = link del canale (https://t.me/nomecanale o link d'invito):
 *                      serve al pulsante "Ricevi le novità su Telegram" del sito.
 * 4. Esegui "attivaBot": manda un messaggio di prova nel canale e da lì
 *    controlla BuonaCaccia ogni 15 minuti e manda il riepilogo settimanale.
 *    Per fermarlo esegui "disattivaBot".
 *    Se il bot è già attivo e aggiorni questo file, basta salvare. Esegui "installaTrigger"
 *    (ricrea i controlli senza scrivere nel canale) se cambi MINUTI_BOT o RIEPILOGO,
 *    o se nella pagina Trigger manca "riepilogoSettimanale".
 */

const BASE = 'https://buonacaccia.agesci.it/';
const URL_LISTA = BASE + 'Events.aspx';
const MINUTI_CACHE = 30;     // ogni quanto il sito rilegge BuonaCaccia
const MINUTI_BOT = 15;       // ogni quanto il bot controlla le novità (1, 5, 10, 15 o 30)
const RE_DATA = /^\d{2}\/\d{2}\/\d{4}$/;

// Indirizzo del sito su GitHub Pages, usato nei messaggi del bot ("Vedi tutti gli eventi").
const URL_SITO = 'https://eventi-rs.mattialarosa.com/';

// Usati solo se nella pagina non si riesce a riconoscere l'icona R/S.
const TIPI_RS_RISERVA = ['ROSS', 'Part', 'EPPPI', 'WS', 'Workshop', 'Cantiere'];

// ==================== Dati per il sito ====================

/** Il sito chiama il link /exec e riceve gli eventi in JSON. */
function doGet() {
  let dati;
  try {
    dati = conDateIscrizioni(getEventi());
  } catch (err) {
    dati = { errore: err.message };
  }
  const invito = PropertiesService.getScriptProperties().getProperty('TELEGRAM_INVITO') || '';
  dati.canale = /^https:\/\/t\.me\//.test(invito) ? invito : '';
  return ContentService.createTextOutput(JSON.stringify(dati))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Chiamata dall'interfaccia: eventi R/S attuali (in cache). */
function getEventi() {
  const c = CacheService.getScriptCache().get('eventi_rs');
  if (c) return JSON.parse(c);
  const out = scaricaRS();
  if (!out.eventi.length) {
    throw new Error('Non trovo eventi R/S nella lista di BuonaCaccia. Avvisa chi gestisce questa pagina.');
  }
  return out;
}

/**
 * Aggiunge a ogni evento le date delle iscrizioni (apre, chiude).
 * Non sono nella lista: le legge il bot dalle pagine dei singoli eventi e le tiene nella sua memoria.
 */
function conDateIscrizioni(dati) {
  const archivio = leggiArchivio();
  dati.eventi.forEach(e => {
    const r = archivio[e.id] || {};
    if (r.apre) e.apre = r.apre;
    if (r.chiude) e.chiude = r.chiude;
  });
  return dati;
}

/** Scarica la lista, tiene gli eventi R/S e aggiorna la cache della web app. */
function scaricaRS() {
  const res = UrlFetchApp.fetch(URL_LISTA, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('BuonaCaccia non risponde in questo momento. Riprova tra qualche minuto.');
  }
  const eventi = soloRS(leggiRighe(res.getContentText('UTF-8')))
    .map(r => ({
      id: r.id, tipo: r.tipo, titolo: r.titolo, regione: r.regione,
      dal: r.dal, al: r.al, quota: r.quota, luogo: r.luogo,
      iscritti: r.iscritti, posti: r.posti, stato: r.stato,
    }))
    .sort((a, b) => chiaveData(a.dal).localeCompare(chiaveData(b.dal)));
  const out = { aggiornato: new Date().toISOString(), eventi };
  if (eventi.length) {
    try { CacheService.getScriptCache().put('eventi_rs', JSON.stringify(out), MINUTI_CACHE * 60); } catch (err) {}
  }
  return out;
}

// ==================== Bot Telegram ====================

const STATI_BOT = {
  light_green: '🟢 Iscrizioni aperte',
  light_yellow: '🟡 Pochi posti',
  light_dual: '🟠 Forte sovrannumero',
  light_red: '🔴 Chiuse o non ancora aperte',
};
const NOMI_TIPO = { Part: 'Partenti', AltroRS: 'Altro' };
const APERTI = ['light_green', 'light_yellow', 'light_dual'];

const TZ = 'Europe/Rome';
const POSTI_ULTIMI = 5;         // avviso "ultimi posti" quando ne restano così pochi (o meno)
const GIORNI_PROMEMORIA = 7;    // promemoria quando mancano così tanti giorni all'apertura delle iscrizioni
const FASCIA_PROMEMORIA = [8, 21]; // i promemoria partono solo tra queste ore (non di notte)
const ORE_DETTAGLI = 6;         // ogni quanto rileggere la pagina di ogni evento (date delle iscrizioni)
const RIEPILOGO = { giorno: 'MONDAY', ora: 8 }; // riepilogo settimanale degli eventi con iscrizioni aperte
const GIORNI_MEMORIA = 3;       // per quanto ricordare un evento sparito dalla lista (evita falsi "nuovo evento")

/** Da eseguire una volta: messaggio di prova, memorizza gli eventi attuali e crea i controlli periodici. */
function attivaBot() {
  configTelegram(); // si ferma subito se mancano token o chat
  const ev = scaricaRS().eventi;
  if (!ev.length) throw new Error('Non trovo eventi R/S: controlla con "diagnosi" prima di attivare il bot.');

  // Si riparte da zero: gli eventi di adesso non generano avvisi
  const adesso = new Date();
  const dettagli = leggiDettagli(ev);
  const archivio = {};
  ev.forEach(e => {
    archivio[e.id] = registro(e, null, dettagli[e.id], adesso);
    segnaGiaNoti(e, archivio[e.id], adesso);
  });
  salvaArchivio(archivio);
  installaTrigger();

  const app = linkApp();
  inviaTelegram(
    `✅ <b>Bot attivo</b>\nDa adesso qui trovate i nuovi eventi R/S di BuonaCaccia, l'apertura delle iscrizioni, ` +
    `gli ultimi posti e ogni settimana il riepilogo degli eventi aperti.` +
    `\nIn questo momento ci sono ${ev.length} eventi in programma.` +
    (app ? `\n\n<a href="${app}">Vedi tutti gli eventi</a>` : '')
  );
  console.log(`Bot attivo: ${ev.length} eventi memorizzati, controllo ogni ${MINUTI_BOT} minuti.`);
}

function disattivaBot() {
  rimuoviTrigger();
  console.log('Bot fermato: nessun controllo periodico attivo.');
}

/** Crea (o ricrea) i controlli periodici senza scrivere nel canale. */
function installaTrigger() {
  rimuoviTrigger();
  ScriptApp.newTrigger('controllaNovita').timeBased().everyMinutes(MINUTI_BOT).create();
  ScriptApp.newTrigger('riepilogoSettimanale').timeBased()
    .onWeekDay(ScriptApp.WeekDay[RIEPILOGO.giorno]).atHour(RIEPILOGO.ora).create();
  console.log(`Controllo ogni ${MINUTI_BOT} minuti, riepilogo ogni ${RIEPILOGO.giorno} alle ${RIEPILOGO.ora} (fuso dello script).`);
}

function rimuoviTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['controllaNovita', 'riepilogoSettimanale'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Eseguita dal trigger: confronta con l'ultima lettura e pubblica le novità. */
function controllaNovita() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    let ev;
    try {
      ev = scaricaRS().eventi;
    } catch (err) {
      console.warn(err.message);
      return; // sito non raggiungibile: si riprova al prossimo giro
    }
    if (!ev.length) {
      console.warn('Nessun evento R/S letto: salto questo giro per non mandare falsi avvisi.');
      return;
    }

    const adesso = new Date();
    const archivio = leggiArchivio();
    const dettagli = leggiDettagli(daRileggere(ev, archivio, adesso));
    const messaggi = [];
    ev.forEach(e => {
      const vecchio = archivio[e.id];
      const nuovo = registro(e, vecchio, dettagli[e.id], adesso);
      const blocco = vecchio ? novita(e, vecchio, nuovo, adesso) : nuovoEvento(e, nuovo, adesso);
      if (blocco) messaggi.push(blocco);
      archivio[e.id] = nuovo;
    });
    dimentica(archivio, ev, adesso);

    if (messaggi.length) {
      const app = linkApp();
      if (app) messaggi.push(`<a href="${app}">Vedi tutti gli eventi R/S</a>`);
      // Prima si invia, poi si salva: se Telegram rifiuta, al prossimo giro gli avvisi si ripetono invece di perdersi
      dividi(messaggi).forEach(testo => inviaTelegram(testo));
    }
    salvaArchivio(archivio);
  } finally {
    lock.releaseLock();
  }
}

/** Eseguita dal trigger settimanale: elenca gli eventi con le iscrizioni aperte. */
function riepilogoSettimanale() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) throw new Error('Un altro controllo è in corso: riepilogo saltato.');
  try {
    const archivio = leggiArchivio();
    const adesso = new Date();
    // Il semaforo a volte resta acceso anche dopo la chiusura: si scartano gli eventi già chiusi
    const ev = scaricaRS().eventi.filter(e => APERTI.includes(e.stato) &&
      !(giorniA((archivio[e.id] || {}).chiude, adesso) < 0));
    if (!ev.length) {
      console.log('Nessun evento con iscrizioni aperte: niente riepilogo questa settimana.');
      return;
    }
    const blocchi = [
      `📋 <b>Iscrizioni aperte</b>\n` +
      (ev.length === 1 ? `Questa settimana c'è 1 evento` : `Questa settimana ci sono ${ev.length} eventi`) +
      ` con le iscrizioni aperte.`,
    ];
    ev.forEach(e => blocchi.push(schedaEvento(e, archivio[e.id])));
    const app = linkApp();
    if (app) blocchi.push(`<a href="${app}">Vedi tutti gli eventi R/S</a>`);
    dividi(blocchi).forEach(testo => inviaTelegram(testo));
  } finally {
    lock.releaseLock();
  }
}

/** Il blocco per un evento appena comparso nella lista. */
function nuovoEvento(e, n, adesso) {
  segnaGiaNoti(e, n, adesso); // ultimi posti e data di apertura sono già nella scheda
  return `🆕 <b>Nuovo evento</b>\n${schedaEvento(e, n)}`;
}

/** Il blocco con le novità di un evento già noto (null se non c'è niente da dire). */
function novita(e, v, n, adesso) {
  const titoli = [];
  const note = [];

  if (n.s !== v.s && e.stato && !soloAffollamento(v.s, n.s)) {
    titoli.push(n.s === 'light_green' ? '📣 <b>Iscrizioni aperte</b>' : '🔄 <b>Cambio di stato</b>');
    note.push(`Prima: ${STATI_BOT[v.s] || 'non indicato'}`);
  }

  // Si confronta solo se c'erano già entrambi i valori (gli eventi memorizzati prima di questa versione non li hanno)
  const cambi = [
    ['📅 Date', periodo(v), periodo(n)],
    ['📍 Luogo', luogoCompleto(v), luogoCompleto(n)],
    ['📝 Apertura iscrizioni', v.apre, n.apre],
    ['📝 Chiusura iscrizioni', v.chiude, n.chiude],
  ].filter(c => c[1] && c[2] && c[1] !== c[2]);
  if (cambi.length) {
    titoli.push('✏️ <b>Evento modificato</b>');
    cambi.forEach(c => note.push(`${c[0]}: ${escT(c[1])} → ${escT(c[2])}`));
  }

  const liberi = postiLiberi(e);
  if (liberi != null && liberi > POSTI_ULTIMI + 2) delete n.u; // posti tornati: il prossimo calo si riavvisa
  if (APERTI.includes(e.stato) && liberi != null && liberi > 0 && liberi <= POSTI_ULTIMI && !n.u) {
    titoli.push('⏳ <b>Ultimi posti</b>');
    note.push(liberi === 1 ? 'Resta 1 posto' : `Restano ${liberi} posti`);
    n.u = 1;
  }

  const giorni = giorniA(n.apre, adesso);
  if (giorni != null && giorni >= 1 && giorni <= GIORNI_PROMEMORIA && n.p !== n.apre &&
      !APERTI.includes(e.stato) && inFascia(adesso)) {
    titoli.push(giorni === 1 ? '⏰ <b>Domani aprono le iscrizioni</b>' : `⏰ <b>Tra ${giorni} giorni aprono le iscrizioni</b>`);
    n.p = n.apre;
  }

  if (!titoli.length) return null;
  return [titoli.join('\n'), schedaEvento(e, n)].concat(note).join('\n');
}

/** Per un evento appena visto: "ultimi posti" e promemoria valgono come già dati. */
function segnaGiaNoti(e, n, adesso) {
  const liberi = postiLiberi(e);
  if (liberi != null && liberi <= POSTI_ULTIMI) n.u = 1;
  const giorni = giorniA(n.apre, adesso);
  if (giorni != null && giorni <= GIORNI_PROMEMORIA) n.p = n.apre;
}

/** Tra "pochi posti" e "forte sovrannumero" lo stato oscilla spesso: non vale un avviso. */
function soloAffollamento(a, b) {
  const s = ['light_yellow', 'light_dual'];
  return s.includes(a) && s.includes(b);
}

function postiLiberi(e) {
  return e.iscritti == null || e.posti == null ? null : e.posti - e.iscritti;
}

function periodo(r) {
  return r.dal ? (r.al && r.al !== r.dal ? `${r.dal} – ${r.al}` : r.dal) : '';
}

function luogoCompleto(r) {
  return [r.luogo, r.regione].filter(Boolean).join(', ');
}

/** Giorni da oggi (ora italiana) alla data gg/mm/aaaa; null se la data non c'è. */
function giorniA(data, adesso) {
  if (!RE_DATA.test(data || '')) return null;
  const [g, m, a] = data.split('/').map(Number);
  const [ao, mo, go] = Utilities.formatDate(adesso, TZ, 'yyyy-M-d').split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, g) - Date.UTC(ao, mo - 1, go)) / 86400000);
}

function inFascia(adesso) {
  const ora = Number(Utilities.formatDate(adesso, TZ, 'H'));
  return ora >= FASCIA_PROMEMORIA[0] && ora < FASCIA_PROMEMORIA[1];
}

function schedaEvento(e, r) {
  r = r || {};
  const tipo = NOMI_TIPO[e.tipo] || e.tipo;
  const date = e.al && e.al !== e.dal ? `${e.dal.slice(0, 5)} – ${e.al}` : e.dal;
  const luogo = [e.luogo, e.regione].filter(Boolean).join(', ');
  const posti = e.iscritti == null ? '' : e.posti == null ? `${e.iscritti} iscritti` : `${e.iscritti}/${e.posti} iscritti`;
  const iscrizioni = r.apre && r.chiude ? `Iscrizioni dal ${r.apre} al ${r.chiude}`
    : r.apre ? `Iscrizioni dal ${r.apre}` : r.chiude ? `Iscrizioni fino al ${r.chiude}` : '';
  return [
    `<b>${escT(tipo)}</b> · <a href="${BASE}Event.aspx?e=${encodeURIComponent(e.id)}">${escT(e.titolo)}</a>`,
    [date && `📅 ${date}`, luogo && `📍 ${escT(luogo)}`].filter(Boolean).join('  '),
    [e.quota && `💶 ${escT(e.quota)}`, posti && `👥 ${posti}`].filter(Boolean).join('  '),
    iscrizioni && `📝 ${iscrizioni}`,
    STATI_BOT[e.stato] || '',
  ].filter(Boolean).join('\n');
}

/** Raggruppa i messaggi in testi sotto il limite di Telegram (4096 caratteri). */
function dividi(blocchi) {
  const out = [];
  let cur = '';
  blocchi.forEach(b => {
    if (cur && (cur + '\n\n' + b).length > 3800) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + b : b;
  });
  if (cur) out.push(cur);
  return out;
}

function inviaTelegram(testo) {
  const { token, chat } = configTelegram();
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      chat_id: chat,
      text: testo,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  });
  const r = JSON.parse(res.getContentText() || '{}');
  if (!r.ok) throw new Error('Telegram ha rifiutato il messaggio: ' + (r.description || res.getResponseCode()));
}

/**
 * Per i canali privati: pubblica un messaggio nel canale (con il bot già amministratore),
 * poi esegui questa funzione e copia l'ID del canale in TELEGRAM_CHAT.
 */
function trovaChatId() {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('Prima aggiungi TELEGRAM_TOKEN nelle Proprietà script.');
  const r = JSON.parse(UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/getUpdates`, { muteHttpExceptions: true }).getContentText());
  const chat = {};
  (r.result || []).forEach(u => {
    const c = (u.channel_post || u.message || u.my_chat_member || {}).chat;
    if (c) chat[c.id] = `${c.title || c.username || c.first_name || ''} (${c.type})`;
  });
  if (!Object.keys(chat).length) {
    console.log('Nessuna chat trovata. Pubblica un messaggio nel canale dopo aver aggiunto il bot e riprova.');
    return;
  }
  Object.keys(chat).forEach(id => console.log(`${id} → ${chat[id]}`));
}

function configTelegram() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('TELEGRAM_TOKEN');
  const chat = p.getProperty('TELEGRAM_CHAT');
  if (!token || !chat) throw new Error('Mancano TELEGRAM_TOKEN o TELEGRAM_CHAT nelle Proprietà script.');
  return { token, chat };
}

// ==================== Memoria del bot ====================
// Una proprietà script per evento ("ev_ID"), così non si supera il limite di 9 KB per proprietà.
// s stato · dal, al, luogo, regione · apre, chiude (iscrizioni) · letto (ms, ultima lettura della pagina evento)
// visto (giorno dell'ultima volta in lista) · u ("ultimi posti" già avvisato) · p (data di apertura già ricordata)

const PREFISSO = 'ev_';

function leggiArchivio() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const archivio = {};
  Object.keys(props).forEach(k => {
    if (k.indexOf(PREFISSO) !== 0) return;
    try { archivio[k.slice(PREFISSO.length)] = JSON.parse(props[k]); } catch (err) {}
  });
  // Formato delle versioni precedenti (foto_rs, solo lo stato di ogni evento): si riparte da lì
  if (!Object.keys(archivio).length && props.foto_rs) {
    const foto = JSON.parse(props.foto_rs);
    Object.keys(foto).forEach(id => { archivio[id] = { s: foto[id] }; });
  }
  return archivio;
}

/** Scrive solo gli eventi cambiati e toglie quelli dimenticati. */
function salvaArchivio(archivio) {
  const p = PropertiesService.getScriptProperties();
  const salvate = p.getProperties();
  const nuove = {};
  Object.keys(archivio).forEach(id => {
    const v = JSON.stringify(archivio[id]);
    if (salvate[PREFISSO + id] !== v) nuove[PREFISSO + id] = v;
  });
  if (Object.keys(nuove).length) p.setProperties(nuove);
  Object.keys(salvate).forEach(k => {
    if (k.indexOf(PREFISSO) === 0 && !archivio[k.slice(PREFISSO.length)]) p.deleteProperty(k);
  });
  if (salvate.foto_rs !== undefined) p.deleteProperty('foto_rs');
}

/** Il record aggiornato di un evento: dati della lista, date delle iscrizioni, avvisi già dati. */
function registro(e, v, det, adesso) {
  v = v || {};
  return {
    s: e.stato || v.s || '',
    dal: e.dal, al: e.al, luogo: e.luogo, regione: e.regione,
    apre: (det && det.apre) || v.apre || '',
    chiude: (det && det.chiude) || v.chiude || '',
    letto: det ? adesso.getTime() : v.letto || 0,
    visto: Math.floor(adesso.getTime() / 86400000),
    u: v.u, p: v.p,
  };
}

/** Toglie gli eventi spariti dalla lista da più di GIORNI_MEMORIA giorni. */
function dimentica(archivio, ev, adesso) {
  const presenti = {};
  ev.forEach(e => { presenti[e.id] = true; });
  const oggi = Math.floor(adesso.getTime() / 86400000);
  Object.keys(archivio).forEach(id => {
    if (!presenti[id] && oggi - (archivio[id].visto || 0) > GIORNI_MEMORIA) delete archivio[id];
  });
}

/** Gli eventi la cui pagina va riletta (mai letta o letta da più di ORE_DETTAGLI ore), al massimo 30 per giro. */
function daRileggere(ev, archivio, adesso) {
  const letto = e => (archivio[e.id] && archivio[e.id].letto) || 0;
  return ev
    .filter(e => adesso.getTime() - letto(e) > ORE_DETTAGLI * 3600000)
    .sort((a, b) => letto(a) - letto(b))
    .slice(0, 30);
}

/** Legge dalla pagina di ogni evento le date di apertura e chiusura delle iscrizioni. */
function leggiDettagli(ev) {
  const out = {};
  if (!ev.length) return out;
  let risposte;
  try {
    risposte = UrlFetchApp.fetchAll(ev.map(e => ({
      url: `${BASE}Event.aspx?e=${encodeURIComponent(e.id)}`, muteHttpExceptions: true, followRedirects: true,
    })));
  } catch (err) {
    console.warn('Pagine degli eventi non raggiungibili: ' + err.message);
    return out;
  }
  risposte.forEach((res, i) => {
    if (res.getResponseCode() !== 200) return;
    const html = res.getContentText('UTF-8');
    out[ev[i].id] = { apre: campoData(html, 'lbSubsFrom'), chiude: campoData(html, 'lbSubsTo') };
  });
  return out;
}

/** La data nello <span id="..._lbSubsFrom"> (o lbSubsTo) della pagina evento. */
function campoData(html, id) {
  const m = html.match(new RegExp(`id="[^"]*_${id}"[^>]*>\\s*(\\d{2}/\\d{2}/\\d{4})`));
  return m ? m[1] : '';
}

function linkApp() {
  return URL_SITO;
}

function escT(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== Lettura del sito ====================

/** Tiene gli eventi con l'icona R/S; se l'icona non si riconosce, usa i tipi di riserva. */
function soloRS(righe) {
  if (righe.some(r => r.rs)) return righe.filter(r => r.rs);
  console.warn('Icona R/S non riconosciuta: filtro per tipo.');
  const tipi = TIPI_RS_RISERVA.map(t => t.toLowerCase());
  return righe.filter(r => tipi.includes(r.tipo.toLowerCase()));
}

/** Legge la lista eventi (la tabella del sito ha tabelle annidate, quindi si segue ogni link a un evento). */
function leggiRighe(html) {
  return leggiDaiLink(html);
}

/**
 * Per ogni link a un evento
 * guarda il pezzo subito prima (icona e tipo) e quello dopo (dettagli fino al semaforo).
 */
function leggiDaiLink(html) {
  const re = /Event\.aspx\?e=(\d+)/gi;
  const pos = [];
  let m;
  while ((m = re.exec(html)) !== null) pos.push({ id: m[1], i: m.index });

  const visti = {};
  const out = [];
  pos.forEach((p, k) => {
    if (visti[p.id]) return;
    visti[p.id] = true;

    // Prima del link: dalla fine dell'evento precedente (il suo semaforo) a qui
    let prima = html.substring(k > 0 ? pos[k - 1].i : Math.max(0, p.i - 1500), p.i);
    const semafori = [...prima.matchAll(/light_(green|yellow|dual|red)[^>]*>/g)];
    if (semafori.length) {
      const ult = semafori[semafori.length - 1];
      prima = prima.substring(ult.index + ult[0].length);
    }
    // per il primo evento non risalire fino ai filtri della pagina (che contengono "R/S")
    prima = prima.slice(k > 0 ? -1500 : -400).replace(/<[^>]*$/, '');
    const parole = pulisci(prima).split(' ').filter(Boolean);

    // Dopo il link: titolo e dettagli fino al semaforo
    const fine = k + 1 < pos.length ? pos[k + 1].i : html.length;
    let pezzo = html.substring(p.i, fine);
    const stato = pezzo.match(/light_(green|yellow|dual|red)/);
    if (stato) pezzo = pezzo.substring(0, stato.index).replace(/<[^>]*$/, '');
    pezzo = pezzo.substring(pezzo.indexOf('>') + 1);
    const chiusura = pezzo.search(/<\/a>/i);
    const titolo = pulisci(chiusura >= 0 ? pezzo.substring(0, chiusura) : '');
    const resto = pulisci(chiusura >= 0 ? pezzo.substring(chiusura) : pezzo);

    const d = resto.match(/^(.*?)\s*(\d{2}\/\d{2}\/\d{4})\s+(?:(\d{2}\/\d{2}\/\d{4})\s+)?(-|[\d.,]+\s*€)?\s*(.*?)\s*(?:(\d+)\s*\/\s*(\d+|\(\*\)))?$/);
    out.push({
      id: p.id,
      tipo: parole.length ? parole[parole.length - 1] : '',
      titolo,
      regione: d ? d[1] : '',
      dal: d ? d[2] : '',
      al: d && d[3] ? d[3] : '',
      quota: d && d[4] && d[4] !== '-' ? d[4] : '',
      luogo: d ? d[5] : resto,
      iscritti: d && d[6] ? Number(d[6]) : null,
      posti: d && d[7] && d[7] !== '(*)' ? Number(d[7]) : null,
      stato: stato ? stato[0] : '',
      rs: haMarcatoreRS(prima),
      tipoHtml: prima,
    });
  });
  return out;
}

/**
 * Riconosce gli eventi R/S dall'icona di branca (Images/branch_rs.png);
 * se l'icona non c'è, cerca "rs" o "r/s" come parola a sé negli attributi o nel testo.
 */
function haMarcatoreRS(h) {
  const icona = h.match(/branch_([a-z]+)\./i);
  if (icona) return icona[1].toLowerCase() === 'rs';
  const attr = (h.match(/\b(?:src|alt|title|class|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*')/gi) || []).join(' ');
  return /(^|[^a-z])r\/?s([^a-z]|$)/i.test(attr + ' ' + pulisci(h));
}

function chiaveData(d) {
  return d ? d.split('/').reverse().join('') : '99999999';
}

function pulisci(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&agrave;/g, 'à').replace(/&egrave;/g, 'è').replace(/&eacute;/g, 'é')
    .replace(/&igrave;/g, 'ì').replace(/&ograve;/g, 'ò').replace(/&ugrave;/g, 'ù')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ==================== Controllo ====================

/**
 * Da eseguire a mano dall'editor. Nel log trovi:
 * - quante righe evento ha letto e quante con l'icona R/S;
 * - i tipi trovati (tra gli R/S dovresti vedere ROSS, Part, EPPPI...);
 * - qualche esempio di evento R/S già interpretato.
 * Se qualcosa non torna, mandami il log: contiene anche l'HTML attorno al primo evento.
 */
function diagnosi() {
  CacheService.getScriptCache().remove('eventi_rs');
  const res = UrlFetchApp.fetch(URL_LISTA, { muteHttpExceptions: true, followRedirects: true });
  const html = res.getContentText('UTF-8');
  const conta = re => (html.match(re) || []).length;
  console.log(`HTTP ${res.getResponseCode()}, ${html.length} caratteri`);
  console.log('Titolo pagina: ' + pulisci((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]));
  console.log(`Link a eventi: ${conta(/Event\.aspx\?e=\d+/gi)}, <tr>: ${conta(/<tr[\s>]/gi)}, <td>: ${conta(/<td[\s>]/gi)}, semafori: ${conta(/light_(green|yellow|dual|red)/g)}`);

  const righe = leggiRighe(html);
  const icone = {};
  righe.forEach(r => {
    const m = r.tipoHtml.match(/branch_([a-z]+)\./i);
    const k = m ? m[1] : '(nessuna)';
    icone[k] = (icone[k] || 0) + 1;
  });
  console.log(`Eventi letti: ${righe.length}, R/S: ${righe.filter(r => r.rs).length}`);
  console.log('Icone di branca: ' + JSON.stringify(icone));
  const tipi = {};
  righe.forEach(r => {
    const k = (r.rs ? '[R/S] ' : '') + r.tipo;
    tipi[k] = (tipi[k] || 0) + 1;
  });
  console.log('Tipi: ' + JSON.stringify(tipi));

  const i = html.search(/Event\.aspx\?e=\d+/i);
  if (i >= 0) {
    // HTML grezzo attorno al primo evento: è quello da mandarmi se qualcosa non torna
    console.log('HTML prima del primo evento:\n' + html.substring(Math.max(0, i - 700), i));
    console.log('HTML dopo il primo evento:\n' + html.substring(i, i + 900));
  } else {
    console.log('Nessun link a eventi. Inizio del contenuto:\n' + pulisci(html.replace(/^[\s\S]*?<body[^>]*>/i, '')).slice(0, 800));
  }

  soloRS(righe).slice(0, 3).forEach(r => {
    const copia = Object.assign({}, r);
    delete copia.tipoHtml;
    console.log(JSON.stringify(copia));
  });

  // Le date delle iscrizioni arrivano dalla pagina del singolo evento
  const primo = soloRS(righe)[0];
  if (primo) {
    const d = leggiDettagli([primo])[primo.id] || {};
    console.log(`Pagina evento ${primo.id}: iscrizioni dal ${d.apre || '?'} al ${d.chiude || '?'}` +
      (d.apre ? '' : ' (date non trovate: controlla gli span lbSubsFrom e lbSubsTo)'));
  }
}
