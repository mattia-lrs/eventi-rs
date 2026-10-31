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
 *    controlla BuonaCaccia ogni 15 minuti. Per fermarlo esegui "disattivaBot".
 */

const BASE = 'https://buonacaccia.agesci.it/';
const URL_LISTA = BASE + 'Events.aspx';
const MINUTI_CACHE = 30;     // ogni quanto il sito rilegge BuonaCaccia
const MINUTI_BOT = 15;       // ogni quanto il bot controlla le novità (1, 5, 10, 15 o 30)
const RE_DATA = /^\d{2}\/\d{2}\/\d{4}$/;

// Indirizzo del sito su GitHub Pages, usato nei messaggi del bot ("Vedi tutti gli eventi").
const URL_SITO = 'https://mattia-lrs.github.io/eventi-rs/';

// Usati solo se nella pagina non si riesce a riconoscere l'icona R/S.
const TIPI_RS_RISERVA = ['ROSS', 'Part', 'EPPPI', 'WS', 'Workshop', 'Cantiere'];

// ==================== Dati per il sito ====================

/** Il sito chiama il link /exec e riceve gli eventi in JSON. */
function doGet() {
  let dati;
  try {
    dati = getEventi();
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

/** Da eseguire una volta: messaggio di prova, memorizza gli eventi attuali e crea il controllo periodico. */
function attivaBot() {
  configTelegram(); // si ferma subito se mancano token o chat
  const ev = scaricaRS().eventi;
  if (!ev.length) throw new Error('Non trovo eventi R/S: controlla con "diagnosi" prima di attivare il bot.');
  salvaFoto(ev);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'controllaNovita')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('controllaNovita').timeBased().everyMinutes(MINUTI_BOT).create();

  const app = linkApp();
  inviaTelegram(
    `✅ <b>Bot attivo</b>\nDa adesso qui trovate i nuovi eventi R/S di BuonaCaccia e l'apertura delle iscrizioni.` +
    `\nIn questo momento ci sono ${ev.length} eventi in programma.` +
    (app ? `\n\n<a href="${app}">Vedi tutti gli eventi</a>` : '')
  );
  console.log(`Bot attivo: ${ev.length} eventi memorizzati, controllo ogni ${MINUTI_BOT} minuti.`);
}

function disattivaBot() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'controllaNovita')
    .forEach(t => ScriptApp.deleteTrigger(t));
  console.log('Bot fermato: nessun controllo periodico attivo.');
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

    const prima = leggiFoto();
    const messaggi = [];
    ev.forEach(e => {
      const vecchio = prima[e.id];
      if (vecchio === undefined) {
        messaggi.push(`🆕 <b>Nuovo evento</b>\n${schedaEvento(e)}`);
      } else if (vecchio !== e.stato && e.stato && !soloAffollamento(vecchio, e.stato)) {
        const titolo = e.stato === 'light_green' ? '📣 <b>Iscrizioni aperte</b>' : '🔄 <b>Cambio di stato</b>';
        messaggi.push(`${titolo}\n${schedaEvento(e)}\nPrima: ${STATI_BOT[vecchio] || 'non indicato'}`);
      }
    });

    salvaFoto(ev);
    if (!messaggi.length) return;

    const app = linkApp();
    if (app) messaggi.push(`<a href="${app}">Vedi tutti gli eventi R/S</a>`);
    dividi(messaggi).forEach(testo => inviaTelegram(testo));
  } finally {
    lock.releaseLock();
  }
}

/** Tra "pochi posti" e "forte sovrannumero" lo stato oscilla spesso: non vale un avviso. */
function soloAffollamento(a, b) {
  const s = ['light_yellow', 'light_dual'];
  return s.includes(a) && s.includes(b);
}

function schedaEvento(e) {
  const tipo = NOMI_TIPO[e.tipo] || e.tipo;
  const date = e.al && e.al !== e.dal ? `${e.dal.slice(0, 5)} – ${e.al}` : e.dal;
  const luogo = [e.luogo, e.regione].filter(Boolean).join(', ');
  const posti = e.iscritti == null ? '' : e.posti == null ? `${e.iscritti} iscritti` : `${e.iscritti}/${e.posti} iscritti`;
  return [
    `<b>${escT(tipo)}</b> · <a href="${BASE}Event.aspx?e=${encodeURIComponent(e.id)}">${escT(e.titolo)}</a>`,
    [date && `📅 ${date}`, luogo && `📍 ${escT(luogo)}`].filter(Boolean).join('  '),
    [e.quota && `💶 ${escT(e.quota)}`, posti && `👥 ${posti}`].filter(Boolean).join('  '),
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

function leggiFoto() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('foto_rs') || '{}');
}

function salvaFoto(ev) {
  const foto = {};
  ev.forEach(e => { foto[e.id] = e.stato; });
  PropertiesService.getScriptProperties().setProperty('foto_rs', JSON.stringify(foto));
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
}
