let JIRA_BASE = 'https://facilitygrid.atlassian.net';
let CURRENT_AUTH_TOKEN = null; // usato per operazioni interattive (crea issue link)
let CURRENT_EPIC_KEY = null;  // epico attualmente caricato

const epicSelect = document.getElementById('epicSelect');
const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');
const viewSpecsBtn = document.getElementById('viewSpecs');
const svg = d3.select('#canvas');
let lastApiDebug = null;

// Buffer diagnostico SPECs (mostrato nel popup e copiabile)
let specsDiag = [];

// Helper: accoda e mostra stato
function logSpec(phase, msg, ok = true) {
  const line = `[SPEC][${phase}] ${msg}`;
  specsDiag.push(line);
  setStatus(line, ok);
}

let width, height, simulation, tooltip;

// Cache SPECs per epico (vive solo finché la pagina è aperta)
window.EJ_SPECS_CACHE = window.EJ_SPECS_CACHE || {};

// Mappa per spiegazioni: "BUG->TASK" -> { bugText, taskText, score, method, fromKey, toKey }
const aiExplainMap = new Map();

function normalizeStatusName(s) { return String(s || '').trim().toUpperCase(); }

function getCategoryFromIssueType(issuetypeName) {
  const n = String(issuetypeName || '').toLowerCase();
  if (n.includes('epic')) return 'epic';
  if (n.includes('story')) return 'story';
  if (n === 'task' || n.includes(' task')) return 'task';
  if (n === 'bug' || n.includes('bug')) return 'bug';
  return 'other';
}

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#16a34a' : '#dc2626';
}

function normalizeEpicKey(k) {
  if (!k) return null;
  k = k.trim().toUpperCase();
  if (/^\d+$/.test(k)) return `FGC-${k}`;
  return k;
}

// ==== NEW: helper per recuperare la OpenAI API Key (per uso futuro) ====
async function getAiKey() {
  const { openAiApiKey } = await chrome.storage.sync.get(['openAiApiKey']);
  return openAiApiKey || '';
}

async function getCreds() {
  const { jiraBaseUrl, jiraEmail, jiraApiKey } = await chrome.storage.sync.get(['jiraBaseUrl','jiraEmail','jiraApiKey']);
  if (jiraBaseUrl) JIRA_BASE = jiraBaseUrl;
  if (!jiraEmail || !jiraApiKey) throw new Error('Configura email e API key in Settings.');
  const token = btoa(`${jiraEmail}:${jiraApiKey}`);
  return { token };
}

// Crea un issue link in Jira (tipo "Relates") tra due card
async function jiraCreateIssueLink(token, fromKey, toKey) {
  const url = `${JIRA_BASE}/rest/api/3/issueLink`;
  const body = {
    type: { name: 'Relates' },
    outwardIssue: { key: fromKey },
    inwardIssue: { key: toKey }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    credentials: 'omit', cache: 'no-store', mode: 'cors'
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`Link Jira fallito (${res.status}): ${txt.slice(0,180)}`);
  }
}

// GET /issue/{key}?expand=names,renderedFields  → restituisce TUTTI i campi disponibili
async function jiraGetIssueRaw(token, issueKey) {
  const url = `${JIRA_BASE}/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=names,renderedFields`;
  const res = await fetch(url, {
    method: 'GET',
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json'
    },
    credentials: 'omit', cache: 'no-store', mode: 'cors'
  });
  lastApiDebug = {
    url, method: 'GET',
    requestHeaders: { Authorization: maskAuthHeader(`Basic ${token}`), Accept: 'application/json' },
    status: res.status, statusText: res.statusText, responseText: undefined
  };
  try { lastApiDebug.responseText = await res.clone().text(); } catch {}
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`Errore Jira (${res.status}): ${txt.slice(0,280)}`);
  }
  return res.json();
}

// Estrae TUTTE le URL trovate in un JSON arbitrario
function extractAllUrlsFromJson(obj) {
  try {
    const s = JSON.stringify(obj);
    const re = /\bhttps?:\/\/[^\s)>\]}"]+/gi;
    return Array.from(new Set((s.match(re) || []).map(u => u.replace(/[\\"]+$/g,'').trim())));
  } catch { return []; }
}

// Xray: restituisce i test di una Test Execution
async function fetchXrayExecutionTests(token, execKey) {
  try {
    const url = `${JIRA_BASE}/rest/raven/1.0/api/testexec/${encodeURIComponent(execKey)}/test`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map(t => String(t.key)) : [];
  } catch { return []; }
}

// Ritorna l'elenco degli Epic della sprint attiva del board principale
async function fetchActiveSprintEpics(token) {
  let epicLinkFieldId = null;
  try {
    const res = await fetch(`${JIRA_BASE}/rest/api/3/field`, { headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' } });
    if (res.ok) {
      const fields = await res.json();
      const epicField = fields.find(f => String(f.name).toLowerCase() === 'epic link');
      if (epicField) epicLinkFieldId = epicField.id;
    }
  } catch {}

  const childIssues = await jiraSearch(token, `sprint in openSprints() AND issuetype != Epic`, ['summary','issuetype','parent', ...(epicLinkFieldId ? [epicLinkFieldId] : [])]).catch(() => []);

  const epicKeys = new Set();
  for (const it of childIssues) {
    let key = null;
    if (epicLinkFieldId && it.fields && it.fields[epicLinkFieldId]) {
      const v = it.fields[epicLinkFieldId];
      key = typeof v === 'string' ? v : (v?.key || null);
    }
    if (!key && it.fields?.parent?.key) {
      key = it.fields.parent.key;
    }
    if (key) epicKeys.add(key);
  }
  if (epicKeys.size === 0) return [];

  const keyList = Array.from(epicKeys);
  const chunks = [];
  for (let i = 0; i < keyList.length; i += 50) chunks.push(keyList.slice(i, i + 50));
  const out = [];
  for (const ch of chunks) {
    const jql = `key in (${ch.join(',')}) AND issuetype = Epic`;
    const ep = await jiraSearch(token, jql, ['summary','issuetype']).catch(() => []);
    ep.forEach(e => out.push({ key: e.key, summary: e.fields.summary }));
  }
  out.sort((a,b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Jira Cloud v3: POST /rest/api/3/search/jql con nextPageToken
 */
async function jiraSearch(token, jql, fields = ['summary','issuetype','parent','subtasks','issuelinks','status','assignee']) {
  const results = [];
  let nextPageToken = undefined;
  const maxResults = 100;

  async function tryPostJql(body) {
    const url = `${JIRA_BASE}/rest/api/3/search/jql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors'
    });

    lastApiDebug = {
      url,
      method: 'POST',
      requestHeaders: { Authorization: maskAuthHeader(`Basic ${token}`), Accept: 'application/json', 'Content-Type': 'application/json' },
      requestBody: body,
      status: res.status,
      statusText: res.statusText,
      responseText: undefined
    };
    try { lastApiDebug.responseText = await res.clone().text(); } catch {}
    return res;
  }

  while (true) {
    const payload = { jql, fields, maxResults, ...(nextPageToken ? { nextPageToken } : {}) };
    const res = await tryPostJql(payload);

    if (!res.ok) {
      const txt = await res.text();
      const snippet = (txt || '').slice(0, 280);
      const errorMsg =
        res.status === 401 || (txt && txt.includes('Unauthorized'))
          ? 'Credenziali non valide. Verifica email e API key in Settings.'
          : `Errore Jira (${res.status}): ${snippet}`;
      throw new Error(errorMsg);
    }

    const data = await res.json();
    const issuesPage = Array.isArray(data.issues) ? data.issues : [];
    results.push(...issuesPage);
    nextPageToken = data.nextPageToken;
    if (!nextPageToken || issuesPage.length === 0) break;
  }
  return results;
}

// ======================== Confluence REST ========================
// Dato un URL Confluence, ottieni la base API (https://TENANT.atlassian.net/wiki)
function _confluenceApiBaseFromUrl(u) {
  try {
    const url = new URL(u);
    // Confluence Cloud sta sotto /wiki
    const base = `${url.protocol}//${url.host}/wiki`;
    return base;
  } catch { return null; }
}

// Estrai pageId da URL "lunghi" (/spaces/.../pages/<ID>/...)
function _confluencePageIdFromUrl(u) {
  try {
    const m = String(u).match(/\/pages\/(\d+)\b/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Risolvi tiny-link /wiki/x/<key> → pageId via REST
async function _confluenceResolveTinyKey(token, apiBase, tinyKey) {
  // tentativo 1: endpoint shortlink (nuove API v2)
  try {
    const res = await fetch(`${apiBase}/api/v2/shortlinks/${encodeURIComponent(tinyKey)}`, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (res.ok) {
      const j = await res.json();
      // alcuni tenant restituiscono direttamente il contentId
      const id = j?.destination?.resourceId || j?.resourceId || null;
      if (id) return String(id);
    }
  } catch {}

  // tentativo 2: CQL search su tinyurl
  try {
    const q = `cql=${encodeURIComponent(`tinyurl="${tinyKey}"`)}&expand=body.storage`;
    const res = await fetch(`${apiBase}/rest/api/content/search?${q}`, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (res.ok) {
      const j = await res.json();
      const id = j?.results?.[0]?.id || null;
      if (id) return String(id);
    }
  } catch {}

  return null;
}

// Scarica il corpo "storage" (HTML pulito) di una pagina Confluence
async function _confluenceFetchStorageHtml(token, apiBase, pageId) {
  // v2: /api/v2/pages/{id}?body-format=storage
  // fallback v1: /rest/api/content/{id}?expand=body.storage
  // tentativo v2
  try {
    const res = await fetch(`${apiBase}/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (res.ok) {
      const j = await res.json();
      // v2 può avere .body.storage.value o simile
      const html = j?.body?.storage?.value || j?.body?.value || '';
      if (html) return String(html);
    }
  } catch {}

  // fallback v1
  const url = `${apiBase}/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
    credentials: 'omit', cache: 'no-store', mode: 'cors'
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`Confluence API ${res.status}: ${txt.slice(0,200)}`);
  }
  const j = await res.json();
  const html = j?.body?.storage?.value || '';
  return String(html || '');
}

// ===== Helpers SPECs: estrazione link da ADF/Plain, fetch pagine, parsing HTML =====
function _unique(arr){ return Array.from(new Set(arr.filter(Boolean))); }

function _htmlToText(html){
  try{
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html||'');
    return tmp.textContent.replace(/\s+/g,' ').trim();
  }catch{ return String(html||''); }
}

function _extractUrlsFromAdf(adf){
  const out = [];
  try{
    (function walk(node){
      if(!node) return;
      if(Array.isArray(node)){ node.forEach(walk); return; }
      if(node.marks && Array.isArray(node.marks)){
        node.marks.forEach(m=>{
          if(m && m.type==='link' && m.attrs && m.attrs.href){
            out.push(String(m.attrs.href));
          }
        });
      }
      if(node.attrs && node.attrs.href){ out.push(String(node.attrs.href)); }
      if(node.content) walk(node.content);
    })(adf);
  }catch{}
  return _unique(out);
}

function _extractUrlsFromString(s){
  const re = /\bhttps?:\/\/[^\s)>\]}"]+/gi;
  const out = String(s||'').match(re) || [];
  return _unique(out);
}

async function _fetchSpecPageText(u){
  try {
    // PDF/immagini/binary → ignora come prima
    if (/\.(png|jpe?g|gif|pdf|zip|rar|7z|mp4|mov|avi|pptx?|docx?|xlsx?)(\?|$)/i.test(u)) {
      return `[[SPEC_FETCH_ERROR:${u}: Formato binário (ignorado)]]`;
    }

    // Se non è Confluence, fai best-effort HTML->testo (vecchio comportamento)
    if (!/\.atlassian\.net\/wiki\//i.test(u)) {
      const res = await fetch(u, { method:'GET', credentials:'omit', cache:'no-store', mode:'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      return _htmlToText(html);
    }

    // --- Confluence Cloud (richiede API REST + Basic token) ---
    const apiBase = _confluenceApiBaseFromUrl(u);
    if (!apiBase) throw new Error('Confluence base URL inválido');

    // token già calcolato a livello globale
    const token = CURRENT_AUTH_TOKEN;
    if (!token) throw new Error('Token Atlassian indisponível.');

    // Prova a prendere pageId dall'URL
    let pageId = _confluencePageIdFromUrl(u);

    // Se è tiny-link (/wiki/x/<key>), risolvi
    if (!pageId) {
      const m = String(u).match(/\/x\/([A-Za-z0-9]+)/);
      if (m) {
        pageId = await _confluenceResolveTinyKey(token, apiBase, m[1]);
      }
    }

    if (!pageId) {
      throw new Error('Impossibile risolvere pageId Confluence da URL.');
    }

    // Leggi il body.storage via REST
    const storageHtml = await _confluenceFetchStorageHtml(token, apiBase, pageId);
    if (!storageHtml) throw new Error('Página sem conteúdo (storage HTML vazio).');

    // Converti a testo leggibile
    return _htmlToText(storageHtml);

  } catch(e) {
    const reason = e && e.message ? e.message : 'erro';
    return `[[SPEC_FETCH_ERROR:${u}: ${reason}]]`;
  }
}

function _cleanUrl(u){
  try {
    const url = new URL(u);
    url.searchParams.delete('atlOrigin'); // ripulisce tracking di Confluence
    return url.toString();
  } catch { return String(u||''); }
}

function _extractUrlsFromHtml(html){
  try{
    const div = document.createElement('div');
    div.innerHTML = String(html||'');
    const hrefs = Array.from(div.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(Boolean);
    const textUrls = _extractUrlsFromString(div.textContent || '');
    return _unique([...hrefs, ...textUrls].map(_cleanUrl));
  }catch{ return []; }
}

function _extractUrlsFromDescription(desc){
  // desc può essere: (1) oggetto ADF, (2) stringa HTML, (3) stringa plain
  if (!desc) return [];
  if (typeof desc === 'object') return _unique(_extractUrlsFromAdf(desc).map(_cleanUrl));
  if (/<\s*a\s+/i.test(String(desc))) return _extractUrlsFromHtml(desc); // HTML
  return _unique(_extractUrlsFromString(desc).map(_cleanUrl)); // plain
}

async function _loadEpicSpecs(epicIssue, token){
  try{
    specsDiag = [];
    logSpec('INIT', `Preparando leitura das SPECs do épico ${epicIssue?.key || '(desconhecido)'}`);

    const epicKey = epicIssue.key;

    // ❶ Provo a usare la description arrivata
    let adf = epicIssue.fields?.description || null;

    // ❷ Fallback robusto: se manca la description, la rileggo esplicitamente
    if (!adf) {
      logSpec('PARSE', 'Description assente nell\'oggetto epico: faccio fallback fetch(description)…', false);
      try {
        const m = await fetchIssuesWithDescription(token, [epicKey]); // abbiamo già questo helper sotto
        const plainTmp = m.get(epicKey) || '';
        // Se fetchIssuesWithDescription torna plain, non ADF: lo useremo comunque per estrarre gli URL
        if (plainTmp) {
          // ricreo un "plain-only" flow: lascio adf=null e userò 'plain' più sotto
          logSpec('PARSE', `Fallback OK: description letta (chars=${plainTmp.length}).`);
          var plain = plainTmp; // definisco qui per riuso
        } else {
          var plain = '';
        }
      } catch (e) {
        logSpec('PARSE', `Fallback description FAIL: ${e && e.message ? e.message : e}`, false);
        var plain = '';
      }
    } else {
      var plain = adfToPlain(adf);
    }

    // ① URL dalla description così com'è (HTML o ADF o plain)
    let urls = _extractUrlsFromDescription(adf || '');

    // ② Se ho un plain (da ADF o fallback), arricchisco
    if (plain && typeof plain === 'string') {
      urls = _unique([...urls, ..._extractUrlsFromString(plain).map(_cleanUrl)]);
    }

    // ③ Preferisci anche la rendered description del dump (ancora più fedele ai link di Confluence)
    try {
      const raw = window.__EJ_LAST_EPIC_RAW__ && window.__EJ_LAST_EPIC_RAW__[epicKey];
      const renderedHtml = raw?.renderedFields?.description || '';
      if (renderedHtml) {
        const extra = _extractUrlsFromHtml(renderedHtml);
        if (extra.length) {
          logSpec('PARSE', `URLs da renderedFields.description: +${extra.length}`);
          urls = _unique([...urls, ...extra]);
        }
      }
    } catch {}

    logSpec('PARSE', `ADF presente: ${!!adf} | Texto plain chars: ${plain.length}`);
    logSpec('PARSE', `URLs extraídas: ${urls.length} ${urls.length ? `| Ex.: ${urls.slice(0,3).join(', ')}` : ''}`);

    // === FALLBACK AUTO: se non ho trovato link, prova ora a leggere renderedFields.description ===
    if ((!urls || urls.length === 0) && epicKey && token) {
      try {
        // prova dal dump se già presente
        const cachedRaw = (window.__EJ_LAST_EPIC_RAW__ && window.__EJ_LAST_EPIC_RAW__[epicKey]) || null;
        let renderedNow = cachedRaw?.renderedFields?.description || '';

        // se non c'è in cache, fai fetch on-demand del RAW con renderedFields
        if (!renderedNow) {
          logSpec('PARSE', 'URLs=0 → fetch on-demand di renderedFields.description…', false);
          const rawNow = await jiraGetIssueRaw(token, epicKey);
          renderedNow = rawNow?.renderedFields?.description || '';
          if (renderedNow) {
            // metti in cache per usi futuri
            window.__EJ_LAST_EPIC_RAW__ = window.__EJ_LAST_EPIC_RAW__ || {};
            window.__EJ_LAST_EPIC_RAW__[epicKey] = rawNow;
          }
        }

        if (renderedNow) {
          const extra = _extractUrlsFromHtml(renderedNow);
          if (extra.length) {
            logSpec('PARSE', `URLs da renderedFields.description (fallback on-demand): +${extra.length}`);
            urls = _unique([...(urls||[]), ...extra]);
          } else {
            logSpec('PARSE', 'renderedFields.description presente ma senza link.', false);
          }
        } else {
          logSpec('PARSE', 'renderedFields.description indisponibile.', false);
        }
      } catch (e) {
        logSpec('PARSE', `fallback renderedFields FAIL: ${e && e.message ? e.message : e}`, false);
      }
    }

    // Inizializza record cache
    window.EJ_SPECS_CACHE[epicKey] = {
      text: '',
      urls: urls || [],
      ts: Date.now(),
      ok: false,
      success: 0,
      failed: 0,
      failures: [],
      log: specsDiag
    };

    if (!urls.length) {
      logSpec('PARSE', `Nenhum link encontrado na descrição do épico ${epicKey}`, false);
      return;
    }

    logSpec('FETCH', `Lendo ${urls.length} páginas de SPEC…`);
    const texts = [];
    let success = 0, failed = 0;
    const failures = [];

    for(const u of urls){
      const isBinary = /\.(png|jpe?g|gif|pdf|zip|rar|7z|mp4|mov|avi|pptx?|docx?|xlsx?)(\?|$)/i.test(u);
      if (isBinary) {
        failed++; 
        const reason = 'Formato binário (ignorado)';
        failures.push({ url: u, error: reason });
        logSpec('SKIP', `${u} → ${reason}`, false);
        continue;
      }
      try {
        const t = await _fetchSpecPageText(u);
        if (/^\[\[SPEC_FETCH_ERROR:/.test(t)) {
          failed++; 
          failures.push({ url: u, error: t.slice(0,160) });
          logSpec('HTTP', `${u} → FAIL ${t.slice(0,120)}`, false);
        } else {
          success++; 
          texts.push(`[[URL:${u}]]\n${t}`);
          logSpec('HTTP', `${u} → OK (chars=${t.length})`);
        }
      } catch (e) {
        failed++; 
        const reason = (e && e.message) ? e.message : 'erro desconhecido';
        failures.push({ url: u, error: reason });
        logSpec('HTTP', `${u} → EXCEPTION ${reason}`, false);
      }
    }

    const joined = texts.join('\n\n-----\n\n').trim();
    window.EJ_SPECS_CACHE[epicKey] = {
      text: joined,
      urls,
      ts: Date.now(),
      ok: success > 0,
      success,
      failed,
      failures,
      log: specsDiag
    };

    if (success > 0 && failed === 0) {
      logSpec('DONE', `SPECs carregadas (${success}/${urls.length}) para ${epicKey}.`);
    } else if (success > 0 && failed > 0) {
      logSpec('DONE', `SPECs parciais: ok=${success} | falhas=${failed} | total=${urls.length}`, false);
    } else {
      logSpec('DONE', `Nenhum conteúdo legível (falhas=${failed}/${urls.length}).`, false);
    }

    // Bottone "Ver SPECs" sempre cliccabile
    if (viewSpecsBtn) {
      viewSpecsBtn.disabled = false; // sempre cliccabile
      viewSpecsBtn.setAttribute('data-has-specs', (success > 0 ? '1' : '0'));
    }

  }catch(e){
    logSpec('ERROR', `Falha inesperada: ${e && e.message ? e.message : e}`, false);
    // Bottone sempre cliccabile anche in caso di errore
    if (viewSpecsBtn) {
      viewSpecsBtn.disabled = false; // sempre cliccabile
      viewSpecsBtn.setAttribute('data-has-specs', '0');
    }
  }
}

// Svuota la cache SPECs quando chiudi/ricarichi la pagina
window.addEventListener('unload', ()=>{ try{ window.EJ_SPECS_CACHE = {}; }catch{} });

async function loadGraph(epicKeyRaw) {
  try {
    setStatus('Caricamento credenziali…');
    let token;
    try {
      token = (await getCreds()).token;
    } catch {
      throw new Error('Configura email e API key in Settings prima di continuare.');
    }
    CURRENT_AUTH_TOKEN = token;

    const epicKey = normalizeEpicKey(epicKeyRaw);
    if (!epicKey) throw new Error('Chiave epico non valida.');
    CURRENT_EPIC_KEY = epicKey;
    setStatus(`Recupero dati per ${epicKey}…`);

    // 1) Epico (chiediamo anche 'description' per estrarre i link delle SPECs)
    setStatus('Cercando epic…');
    const epicIssue = await jiraSearch(
      token,
      `issuekey=${epicKey}`,
      ['summary','issuetype','description'] // <<<  AGGIUNTO
    );
    if (!epicIssue.length) throw new Error(`Epico ${epicKey} non trovato.`);

    // Carica SPECs dell'epico e mettile in cache per l'AI (passo anche il token)
    await _loadEpicSpecs(epicIssue[0], token); // <<<  PASSO TOKEN

    // Riepilogo SPEC (post-caricamento)
    {
      const meta = window.EJ_SPECS_CACHE[epicIssue[0].key] || {};
      const when = meta.ts ? new Date(meta.ts).toLocaleString() : '';
      const base = `SPEC: ${meta.ok ? 'OK' : 'KO'} — links=${meta.urls?.length||0}, ok=${meta.success||0}, ko=${meta.failed||0}`;
      setStatus(`${base}${when ? ` (${when})` : ''}`, !!meta.ok);
      // bottone "Ver SPECs" sempre cliccabile
      if (viewSpecsBtn) {
        viewSpecsBtn.disabled = false; // sempre cliccabile
        viewSpecsBtn.setAttribute('data-has-specs', (meta.ok ? '1' : '0'));
      }
    }

    // 2) Issue collegati (Epic Link → fallback parentEpic)
    setStatus('Cercando issue collegati…');
    let linkedIssues = [];
    try {
      const epicLinkJql = `"Epic Link"=${epicKey}`;
      linkedIssues = await jiraSearch(token, epicLinkJql);
      if (!linkedIssues.length) {
        const parentEpicJql = `parentEpic=${epicKey}`;
        linkedIssues = await jiraSearch(token, parentEpicJql);
      }
    } catch {
      try {
        const parentEpicJql = `parentEpic=${epicKey}`;
        linkedIssues = await jiraSearch(token, parentEpicJql);
      } catch {
        linkedIssues = [];
      }
    }

    // 3) Issue con parent = epico (alcuni setup)
    let parentIssues = [];
    try {
      parentIssues = await jiraSearch(token, `parent=${epicKey}`);
    } catch {
      parentIssues = [];
    }

    // 4) Combina
    const issues = [epicIssue[0], ...linkedIssues, ...parentIssues];

    // 5) Subtask
    const subtaskKeys = [];
    issues.forEach(issue => {
      if (issue.fields.subtasks?.length) {
        subtaskKeys.push(...issue.fields.subtasks.map(st => st.key));
      }
    });

    let allSubtasks = [];
    if (subtaskKeys.length > 0) {
      setStatus(`Recupero ${subtaskKeys.length} subtask…`);
      const subtaskJql = `key in (${subtaskKeys.join(',')})`;
      allSubtasks = await jiraSearch(token, subtaskJql).catch(() => []);
      issues.push(...allSubtasks);
    }

    // 6) Nodi
    const nodeByKey = new Map();
    function pushNode(issue, type) {
      const key = issue.key;
      if (!nodeByKey.has(key)) {
        const issuetypeName = issue.fields.issuetype?.name || type;
        const lower = String(issuetypeName || '').toLowerCase();
        let category = getCategoryFromIssueType(issuetypeName);
        if (lower.includes('mobile') && category === 'task') category = 'mobile_task';
        if (lower.includes('mobile') && category === 'bug') category = 'mobile_bug';
        if (lower.includes('document')) category = 'document';
        if (lower.includes('test execution')) category = 'test_execution';
        if (lower === 'test') category = 'test';
        nodeByKey.set(key, {
          id: key,
          key,
          summary: issue.fields.summary || '',
          type,
          issuetype: issuetypeName,
          category,
          status: normalizeStatusName(issue.fields.status?.name),
          assignee: (issue.fields.assignee?.displayName || issue.fields.assignee?.name || '').trim()
        });
      } else {
        const n = nodeByKey.get(key);
        if (!n.type && type) n.type = type;
        if (!n.category) n.category = getCategoryFromIssueType(n.issuetype || type);
      }
    }

    const epic = epicIssue[0];
    pushNode(epic, 'epic');

    linkedIssues.forEach(ch => {
      const isSubtask = ch.fields.parent && ch.fields.parent.key;
      pushNode(ch, isSubtask ? 'subtask' : 'issue');
    });

    parentIssues.forEach(ch => pushNode(ch, 'issue'));
    allSubtasks.forEach(st => pushNode(st, 'subtask'));

    // 7) Archi
    const linkSet = new Set();
    const hierLinks = [];
    const relLinks = [];
    const execLinks = [];
    const pairSet = new Set();

    [...linkedIssues, ...parentIssues].forEach(child => {
      const childCat = nodeByKey.get(child.key)?.category;
      const linkKey = `${epicKey}->${child.key}`;
      if (!linkSet.has(linkKey)) {
        hierLinks.push({ source: epicKey, target: child.key, kind: 'hier', childCat: childCat });
        linkSet.add(linkKey);
      }
    });

    [...linkedIssues, ...parentIssues, ...allSubtasks].forEach(issue => {
      if (issue.fields.parent?.key) {
        const pKey = issue.fields.parent.key;
        const linkKey = `${pKey}->${issue.key}`;
        if (nodeByKey.has(pKey) && !linkSet.has(linkKey)) {
          const childCat = nodeByKey.get(issue.key)?.category;
          const parentCat = nodeByKey.get(pKey)?.category;
          const childMeta = parentCat === 'epic' ? { childCat } : {};
          hierLinks.push({ source: pKey, target: issue.key, kind: 'hier', ...childMeta });
          linkSet.add(linkKey);
        }
      }
    });

    const issueByKey = new Map(issues.map(i => [i.key, i]));
    issueByKey.forEach((src) => {
      const linksArr = src.fields.issuelinks || [];
      linksArr.forEach(l => {
        const linked = l.outwardIssue || l.inwardIssue;
        if (!linked) return;
        const a = src.key;
        const b = linked.key;
        if (!issueByKey.has(b)) return;
        const undirected = a < b ? `${a}--${b}` : `${b}--${a}`;
        if (!pairSet.has(undirected)) {
          const srcCat = nodeByKey.get(a)?.category;
          const dstCat = nodeByKey.get(b)?.category;
          if ((srcCat === 'test_execution' && dstCat === 'epic') ||
              (dstCat === 'test_execution' && srcCat === 'epic')) {
            return;
          }
          relLinks.push({ source: a, target: b, kind: 'rel', label: l.type?.name || '' });
          pairSet.add(undirected);
        }
      });
    });

    const testExecIssues = issues.filter(i => /test execution/i.test(i.fields.issuetype?.name || ''));
    const keyRegex = /[A-Z][A-Z0-9]+-\d+/;
    const toLoad = new Set();
    const edgesToAdd = [];
    testExecIssues.forEach(execIssue => {
      const summary = String(execIssue.fields.summary || '');
      const m = keyRegex.exec(summary);
      if (!m) return;
      const targetKey = m[0].toUpperCase();
      if (!nodeByKey.has(targetKey)) toLoad.add(targetKey);
      edgesToAdd.push({ from: execIssue.key, to: targetKey });
    });

    if (toLoad.size) {
      const keys = Array.from(toLoad);
      const chunks = [];
      for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));
      for (const ch of chunks) {
        const extra = await jiraSearch(token, `key in (${ch.join(',')})`, ['summary','issuetype','parent']).catch(() => []);
        extra.forEach(x => pushNode(x, 'issue'));
      }
    }

    edgesToAdd.forEach(({from, to}) => {
      if (!nodeByKey.has(to)) return;
      const id = `${from}->${to}::exec`;
      if (!linkSet.has(id)) {
        execLinks.push({ source: from, target: to, kind: 'exec' });
        linkSet.add(id);
      }
    });

    const nodes = Array.from(nodeByKey.values());
    const allLinks = [...hierLinks, ...relLinks, ...execLinks];

    const catById = new Map(nodes.map(n => [n.id, n.category]));
    const visibleLinks = allLinks.filter(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      const a = catById.get(sid);
      const b = catById.get(tid);
      return !((a === 'test_execution' && b === 'epic') || (b === 'test_execution' && a === 'epic'));
    });

    renderForceGraph(nodes, visibleLinks, epicKey, { hierLinks, relLinks });
    setStatus(`Caricato: ${nodes.length} nodi, ${visibleLinks.length} collegamenti.`);
  } catch (err) {
    console.error('Errore nel caricamento del grafico:', err);
    const errorMsg = err.message || String(err);
    setStatus(errorMsg, false);
  }
}

// ===== UI: menu contestuale + modale "Explicação" (funzioni globali) =====
function ensureContextUi() {
  if (!document.getElementById('ej-ai-style')) {
    const style = document.createElement('style');
    style.id = 'ej-ai-style';
    style.textContent = `
      .ej-menu { position: fixed; z-index: 9999; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); min-width: 180px; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
      .ej-menu ul { list-style: none; margin: 0; padding: 6px; }
      .ej-menu li { padding: 8px 10px; border-radius: 4px; cursor: pointer; font-size: 14px; }
      .ej-menu li:hover { background: #f3f4f6; }
      .ej-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 9998; }
      .ej-modal { position: fixed; z-index: 10000; background: #fff; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); width: min(720px, 92vw); max-height: 82vh; overflow: auto; padding: 18px; top: 50%; left: 50%; transform: translate(-50%, -50%); font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
      .ej-modal h3 { margin: 0 0 10px 0; font-size: 18px; }
      .ej-modal pre { white-space: pre-wrap; word-wrap: break-word; background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 13px; border: 1px solid #e5e7eb; }
      .ej-close { display: inline-block; margin-top: 12px; background: #111827; color: #fff; border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; font-size: 14px;}
    `;
    document.head.appendChild(style);
  }
  if (!document.getElementById('ej-ai-menu')) {
    const menu = document.createElement('div');
    menu.id = 'ej-ai-menu';
    menu.className = 'ej-menu';
    menu.style.display = 'none';
    menu.innerHTML = `<ul><li id="ej-ai-explicacao">Explicação</li></ul>`;
    document.body.appendChild(menu);
  }
  if (!document.getElementById('ej-ai-backdrop')) {
    const back = document.createElement('div');
    back.id = 'ej-ai-backdrop';
    back.className = 'ej-backdrop';
    back.style.display = 'none';
    document.body.appendChild(back);
  }
  if (!document.getElementById('ej-ai-modal')) {
    const modal = document.createElement('div');
    modal.id = 'ej-ai-modal';
    modal.className = 'ej-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <h3 id="ej-ai-modal-title">Explicação da conexão</h3>
      <pre id="ej-ai-modal-text"></pre>
      <button class="ej-close" id="ej-ai-close">Fechar</button>
    `;
    document.body.appendChild(modal);
    document.getElementById('ej-ai-close').addEventListener('click', hideModal);
    document.getElementById('ej-ai-backdrop').addEventListener('click', hideModal);
  }
}

function showModal(text) {
  const elem = document.getElementById('ej-ai-modal-text');
  // Supporto HTML: se il testo contiene <, usa innerHTML, altrimenti textContent
  if (text && typeof text === 'string' && /<[a-z][\s\S]*>/i.test(text)) {
    elem.innerHTML = text;
  } else {
    elem.textContent = text;
  }
  document.getElementById('ej-ai-backdrop').style.display = 'block';
  document.getElementById('ej-ai-modal').style.display = 'block';
}

function hideModal() {
  document.getElementById('ej-ai-backdrop').style.display = 'none';
  document.getElementById('ej-ai-modal').style.display = 'none';
}
// ===== fine UI =====

function renderForceGraph(nodes, links, epicKey, groups = { hierLinks: [], relLinks: [] }) {
  const svgNode = svg.node();
  svg.selectAll('*').remove();

  const rect = svgNode.getBoundingClientRect();
  width = rect.width || window.innerWidth;
  height = rect.height || (window.innerHeight - 56);
  svg.attr('width', width).attr('height', height);
  const stage = svg.append('g').attr('class', 'stage');

  // ===== UI: menu contestuale + modale "Explicação" =====
  ensureContextUi();

  function showMenu(x, y, payload) {
    const menu = document.getElementById('ej-ai-menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';

    const hide = () => { menu.style.display = 'none'; document.removeEventListener('click', hide, true); };
    setTimeout(() => document.addEventListener('click', hide, true), 0);

    const btn = document.getElementById('ej-ai-explicacao');
    btn.onclick = async () => {
      menu.style.display = 'none';

      const {
        sourceText,
        targetText,
        score,
        method,
        fromKey,
        toKey,
        reason,
        sourceFields,
        targetFields,
        sourceRaw,
        targetRaw,
        sourceKind,
        targetKind,
        aiKey,
        // Backward compatibility con vecchi payload (se esistono)
        bugText,
        taskText,
        bugFields,
        taskFields,
        bugRaw,
        taskRaw
      } = payload;
      
      // Fallback per backward compatibility
      const actualSourceText = sourceText || bugText || '';
      const actualTargetText = targetText || taskText || '';
      const actualSourceFields = sourceFields || bugFields || {};
      const actualTargetFields = targetFields || taskFields || {};
      const actualSourceRaw = sourceRaw || bugRaw || null;
      const actualTargetRaw = targetRaw || taskRaw || null;
      const actualSourceKind = sourceKind || 'bug';
      const actualTargetKind = targetKind || 'task';

      // --- FUNZIONE PER ESTRARRE TESTO DA ADF ---
      function extractADFText(node) {
        if (!node) return '';
        if (Array.isArray(node)) return node.map(extractADFText).join(' ');
        if (typeof node === 'string') return node;
        if (node.type === 'text') return node.text || '';
        if (node.content) return extractADFText(node.content);
        return '';
      }

      // 🔧 Parser universale per Jira fields (supporta HTML, ADF e testo normale)
      const parseJiraFieldValue = (rawValue, renderedValue) => {
        // 1️⃣ Se Jira ha fornito già l'HTML "renderedFields", usalo
        if (typeof renderedValue === 'string' && renderedValue.trim()) {
          const div = document.createElement('div');
          div.innerHTML = renderedValue;
          return div.textContent.trim();
        }

        // 2️⃣ Se il rawValue è un oggetto Atlassian Document Format (ADF)
        if (rawValue && typeof rawValue === 'object' && rawValue.type === 'doc') {
          return extractADFText(rawValue).trim();
        }

        // 3️⃣ Se è una stringa semplice
        if (typeof rawValue === 'string') {
          return rawValue.trim();
        }

        // 4️⃣ Fallback: prova comunque extractADFText per oggetti ADF senza type='doc'
        if (rawValue && typeof rawValue === 'object' && rawValue !== null) {
          const extracted = extractADFText(rawValue);
          if (extracted) return extracted.trim();
        }

        // 5️⃣ Ultimo fallback
        return '';
      };

      // --- DEFINIZIONE DEI CAMPI PREVISTI ---
      const BUG_EXPECTED_FIELDS = [
        'Description',
        'Expected Results',
        'Steps to Reproduce',
        'Analysis',
        'Possible Solution',
        'Chosen Solution',
        'Summary of Changes'
      ];

      const TASK_EXPECTED_FIELDS = [
        'Description',
        'Possible Solution',
        'Chosen Solution',
        'Summary of Changes'
      ];
      
      const STORY_EXPECTED_FIELDS = [
        'Description'
      ];
      
      const TEST_EXPECTED_FIELDS = [
        'Description'
      ];

      // --- FORMATTAZIONE DEI CAMPI PREVISTI (ORA CON SUMMARY + STEPS SOLO PER BUG) ---
      const formatExpectedFields = (title, rawData, expectedList, kind) => {
        if (!rawData) {
          return `──────────────────────────────
${title}
──────────────────────────────
(nessun campo trovato)

`;
        }

        const lines = [];

        // 🔹 1) SUMMARY sempre in testa (Bug & Task)
        let summary = '';
        try {
          // Prova a trovarlo nelle names
          const summaryField = Object.entries(rawData.names || {}).find(([k, v]) =>
            String(v || '').toLowerCase() === 'summary' || String(k || '').toLowerCase() === 'summary'
          );
          if (summaryField) {
            const [key] = summaryField;
            summary = parseJiraFieldValue(rawData.fields?.[key], rawData.renderedFields?.[key]);
          } else {
            // Fallback diretto su fields.summary / renderedFields.summary
            summary = parseJiraFieldValue(rawData.fields?.summary, rawData.renderedFields?.summary);
          }
        } catch {}

        lines.push(`• Summary: ${summary || '(non trovato)'}`);

        // 🔹 2) STEPS TO REPRODUCE → SOLO PER BUG
        if (kind === 'bug') {
          let steps = '';

          // 1️⃣ Prova dai renderedFields (HTML già pronto)
          if (rawData?.renderedFields?.customfield_10101) {
            const div = document.createElement('div');
            div.innerHTML = rawData.renderedFields.customfield_10101;
            steps = div.textContent.trim();
          }
          // 2️⃣ Se non c'è HTML, prova dai fields (ADF)
          else if (rawData?.fields?.customfield_10101) {
            steps = extractADFText(rawData.fields.customfield_10101);
          }

          lines.push(`• Steps to Reproduce: ${steps || '(non trovato)'}`);
        }

        // 🔹 3) DESCRIPTION (robusto, come prima)
        let desc = '';
        const descFieldKey = Object.entries(rawData.names || {}).find(([k, v]) =>
          v.toLowerCase().includes('description')
        );
        if (descFieldKey) {
          const [key] = descFieldKey;
          desc = parseJiraFieldValue(rawData.fields?.[key], rawData.renderedFields?.[key]);
        }
        // Fallback manuale se parseJiraFieldValue non ha funzionato
        if (!desc && rawData?.fields?.description) {
          desc = extractADFText(rawData.fields.description);
        }
        if (!desc && rawData?.renderedFields?.description) {
          const div = document.createElement('div');
          div.innerHTML = rawData.renderedFields.description;
          desc = div.textContent.trim();
        }
        lines.push(`• Description: ${desc || '(non trovato)'}`);

        // 🔹 4) Altri campi previsti (escludendo Steps/Description già gestiti)
        const otherFields = expectedList.filter(f => {
          const lower = f.toLowerCase();
          return lower !== 'steps to reproduce' && lower !== 'description';
        });

        const otherLines = otherFields.map((fieldName) => {
          const jiraFieldKey = Object.entries(rawData.names || {}).find(([k, v]) =>
            v.toLowerCase().includes(fieldName.toLowerCase())
          );
          const fieldKey = jiraFieldKey ? jiraFieldKey[0] : null;
          const rawValue = fieldKey ? rawData.fields?.[fieldKey] : null;
          const renderedValue = fieldKey ? rawData.renderedFields?.[fieldKey] : null;
          const parsed = parseJiraFieldValue(rawValue, renderedValue);
          return `• ${fieldName}: ${parsed || '(non trovato)'}`;
        });

        lines.push(...otherLines);

        return `──────────────────────────────
${title}
──────────────────────────────
${lines.join('\n')}

`;
      };

      // Helper per scegliere icona e campi in base al kind
      const getIconForKind = (kind) => {
        if (kind === 'bug') return '🐞';
        if (kind === 'task') return '🧩';
        if (kind === 'story') return '📖';
        if (kind === 'test') return '🧪';
        return '📋';
      };
      
      const getFieldsForKind = (kind) => {
        if (kind === 'bug') return BUG_EXPECTED_FIELDS;
        if (kind === 'task') return TASK_EXPECTED_FIELDS;
        if (kind === 'story') return STORY_EXPECTED_FIELDS;
        if (kind === 'test') return TEST_EXPECTED_FIELDS;
        return ['Description'];
      };
      
      const sourceIcon = getIconForKind(actualSourceKind);
      const targetIcon = getIconForKind(actualTargetKind);
      const sourceFieldsList = getFieldsForKind(actualSourceKind);
      const targetFieldsList = getFieldsForKind(actualTargetKind);
      
      const sourceSection = formatExpectedFields(
        `${sourceIcon} ${actualSourceKind.toUpperCase()}: ${fromKey}`, 
        actualSourceRaw, 
        sourceFieldsList, 
        actualSourceKind
      );
      const targetSection = formatExpectedFields(
        `${targetIcon} ${actualTargetKind.toUpperCase()}: ${toKey}`, 
        actualTargetRaw, 
        targetFieldsList, 
        actualTargetKind
      );

      // 🔥 QUI CHIAMIAMO OPENAI PER LA COMPARAZIONE TRIANGOLARE
      const epicKey = CURRENT_EPIC_KEY || '';
      const exp = await window.EJ_AI.explainLinkPTBR(
        actualSourceText || '',
        actualTargetText || '',
        score || 0,
        method || 'jaccard',
        reason || '',
        { epicKey, aiKey, sourceKind: actualSourceKind, targetKind: actualTargetKind }
      );

      // --- Contenuto base del modale (SENZA "Testo Composito") ---
      const detail = `
${sourceSection}${targetSection}

──────────────────────────────
🧠 COMPARAZIONE TRIANGOLARE (OpenAI)
──────────────────────────────

${exp}

<br><br>

<button id="dumpSource" style="background:#1976d2;color:#fff;border:none;padding:6px 10px;margin:4px;cursor:pointer;border-radius:6px;">🔵 Dump ${fromKey} Fields</button>

<button id="dumpTarget" style="background:#388e3c;color:#fff;border:none;padding:6px 10px;margin:4px;cursor:pointer;border-radius:6px;">🟢 Dump ${toKey} Fields</button>

<div id="sourceDump" style="display:none;white-space:pre-wrap;font-size:12px;background:#f8f8f8;border:1px solid #ccc;border-radius:8px;padding:8px;margin-top:6px;"></div>

<div id="targetDump" style="display:none;white-space:pre-wrap;font-size:12px;background:#f8f8f8;border:1px solid #ccc;border-radius:8px;padding:8px;margin-top:6px;"></div>

`;

      // --- Mostra il modale ---
      showModal(detail);

      // --- Gestione pulsanti dump ---
      setTimeout(() => {
        const btnSource = document.getElementById('dumpSource');
        const btnTarget = document.getElementById('dumpTarget');
        const divSource = document.getElementById('sourceDump');
        const divTarget = document.getElementById('targetDump');

        const prettyJSON = (data) => JSON.stringify(data, null, 2);

        if (btnSource) {
          btnSource.onclick = () => {
            divSource.style.display = divSource.style.display === 'none' ? 'block' : 'none';
            if (divSource.innerText.trim() === '') {
              divSource.innerText = prettyJSON({
                fields: actualSourceRaw?.fields || {},
                names: actualSourceRaw?.names || {},
                renderedFields: actualSourceRaw?.renderedFields || {}
              });
            }
          };
        }

        if (btnTarget) {
          btnTarget.onclick = () => {
            divTarget.style.display = divTarget.style.display === 'none' ? 'block' : 'none';
            if (divTarget.innerText.trim() === '') {
              divTarget.innerText = prettyJSON({
                fields: actualTargetRaw?.fields || {},
                names: actualTargetRaw?.names || {},
                renderedFields: actualTargetRaw?.renderedFields || {}
              });
            }
          };
        }
      }, 200);
    };
  }

  // Layer dedicato alle connessioni AI (rosse temporanee)
  const aiLayer = stage.append('g').attr('class', 'ai-links');
  let aiTempLinks = []; // {source, target, score, method}

  let aiRevealTimeouts = [];

  function cancelAiReveal() {
    aiRevealTimeouts.forEach(id => clearTimeout(id));
    aiRevealTimeouts = [];
  }

  // 🔧 Helper: aggiorna posizione dei link AI in base alle coordinate correnti dei nodi
  function updateAiLinkPositions() {
    aiLayer.selectAll('line.ai')
      .attr('x1', d => {
        const s = nodes.find(n => n.id === d.source);
        return s ? s.x : 0;
      })
      .attr('y1', d => {
        const s = nodes.find(n => n.id === d.source);
        return s ? s.y : 0;
      })
      .attr('x2', d => {
        const t = nodes.find(n => n.id === d.target);
        return t ? t.x : 0;
      })
      .attr('y2', d => {
        const t = nodes.find(n => n.id === d.target);
        return t ? t.y : 0;
      });
  }

  const colorByCategory = (c) => {
    if (c === 'epic') return '#8b5cf6';
    if (c === 'story') return '#3b82f6';
    if (c === 'task' || c === 'mobile_task' || c === 'test_execution') return '#86efac';
    if (c === 'test') return '#166534';
    if (c === 'mobile_bug') return '#fecaca';
    if (c === 'bug') return '#ef4444';
    return '#94a3b8';
  };

  stage.append('defs');

  const link = stage.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
      .attr('stroke-width', d => d.kind === 'exec' ? 2.2 : (d.kind === 'rel' ? 1.25 : 1.5))
      .attr('stroke', d => d.kind === 'exec' ? '#34d399' : (d.kind === 'rel' ? '#7dd3fc' : '#aaa'))
      .attr('stroke-dasharray', d => d.kind === 'rel' ? '4 2' : (d.weak ? '2 4' : null))
      .attr('stroke-opacity', d => {
        const sid = typeof d.source === 'object' ? d.source.id : d.source;
        const tid = typeof d.target === 'object' ? d.target.id : d.target;
        if (sid === epicKey || tid === epicKey) return 0.1;
        return 0.8;
      });

  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links)
      .id(d => d.id)
      .distance(l => window.EJ_LAYOUT.linkDistance(l, nodes))
      .strength(l => window.EJ_LAYOUT.linkStrength(l))
    )
    .force('charge', d3.forceManyBody().strength(d => window.EJ_LAYOUT.nodeCharge(d)))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.id === epicKey ? 10 : 7));

  const node = stage.append('g')
    .selectAll('g.node')
    .data(nodes)
    .join('g')
      .attr('class', 'node')
      .call(makeDrag(simulation));

  let tempLink = null;
  let linkStart = null;

  function startLink(event, d) {
    if (!event.altKey) return;
    event.stopPropagation();
    linkStart = d;
    const p = d3.pointer(event, stage.node());
    tempLink = stage.append('line')
      .attr('x1', d.x).attr('y1', d.y)
      .attr('x2', p[0]).attr('y2', p[1])
      .attr('stroke', '#22c55e')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.8)
      .attr('pointer-events', 'none');

    svg.on('mousemove.link', moveLink)
       .on('mouseup.link', endLink);
  }

  function moveLink(event) {
    if (!tempLink) return;
    const p = d3.pointer(event, stage.node());
    tempLink.attr('x2', p[0]).attr('y2', p[1]);
  }

  function endLink(event) {
    if (!tempLink || !linkStart) return cleanupTemp();
    const p = d3.pointer(event, stage.node());
    const target = findNodeAt(nodes, p[0], p[1]);
    if (target && target.id !== linkStart.id) {
      jiraCreateIssueLink(CURRENT_AUTH_TOKEN, linkStart.id, target.id)
        .then(() => {
          setStatus(`Creato link: ${linkStart.id} → ${target.id}`);
          links.push({ source: linkStart.id, target: target.id, kind: 'rel' });
          renderForceGraph(nodes, links, epicKey, groups);
        })
        .catch(e => setStatus(e.message || String(e), false))
        .finally(cleanupTemp);
    } else {
      cleanupTemp();
    }
  }

  function cleanupTemp() {
    tempLink && tempLink.remove();
    tempLink = null; linkStart = null;
    svg.on('.link', null);
  }

  function findNodeAt(arr, x, y) {
    let best = null; let bestDist = Infinity;
    arr.forEach(n => {
      const dx = (n.x || 0) - x; const dy = (n.y || 0) - y;
      const r = n.id === epicKey ? 10 : 7;
      const d2 = dx*dx + dy*dy;
      if (d2 < (r+6)*(r+6) && d2 < bestDist) { bestDist = d2; best = n; }
    });
    return best;
  }

  // Piccolo scheduler per ridurre i ridisegni consecutivi
  let __ej_drawScheduled = false;
  function scheduleDraw() {
    if (__ej_drawScheduled) return;
    __ej_drawScheduled = true;
    requestAnimationFrame(() => { __ej_drawScheduled = false; drawAiLinks(); });
  }

  async function handleNodeContextMenu(event, d) {
    try {
      cancelAiReveal();

      // Categorie supportate per AI-link
      const INCLUDED_CATEGORIES = ['bug', 'mobile_bug', 'task', 'mobile_task', 'story', 'test'];
      const category = String(d.category || '').toLowerCase();
      
      if (!INCLUDED_CATEGORIES.includes(category)) {
        setStatus('AI-link: funziona su Bug, Task, Story e Test (esclusi Epic, Test Execution, Subtask).', false);
        return;
      }

      const token = CURRENT_AUTH_TOKEN;
      const sourceKey = d.key;
      const epicKey = CURRENT_EPIC_KEY || '';

      // Determina il 'kind' per buildCompositeTextFromRaw
      let sourceKind = 'bug';
      if (category === 'task' || category === 'mobile_task') sourceKind = 'task';
      else if (category === 'story') sourceKind = 'story';
      else if (category === 'test') sourceKind = 'test';
      else if (category === 'bug' || category === 'mobile_bug') sourceKind = 'bug';

      setStatus(`AI-link: leggo descrizioni per ${sourceKey}…`);

      // 1) Nodo sorgente: raw + testo composito
      const sourceRaw = await jiraGetIssueRaw(token, sourceKey);
      const sourceText = buildCompositeTextFromRaw(sourceRaw, sourceKind);
      const sourceFields = buildCompositeFields(sourceRaw, sourceKind);

      if (!sourceText) {
        setStatus(`Impossibile leggere i campi di ${sourceKey}.`, false);
        return;
      }

      setStatus(`AI-link: ${sourceKey} → testo composto (${sourceText.length} chars).`);

      // 2) Nodi candidati nel grafo (tutte le categorie supportate, eccetto il nodo sorgente)
      const targetNodes = [];
      svg.selectAll('g.node').data().forEach(n => {
        if (n && INCLUDED_CATEGORIES.includes(String(n.category || '').toLowerCase()) && n.key !== sourceKey) {
          targetNodes.push(n);
        }
      });

      if (!targetNodes.length) {
        setStatus('Nessun nodo candidato nel grafico.', false);
        return;
      }

      // Conta nodi per categoria (diagnostica)
      const categoryCount = {};
      targetNodes.forEach(n => {
        const cat = String(n.category || 'unknown').toLowerCase();
        categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      });
      const catSummary = Object.entries(categoryCount)
        .map(([cat, count]) => `${count} ${cat}`)
        .join(', ');
      console.log(`[AI-link] Nodi candidati per categoria: ${catSummary}`);

      // Soglie / limiti (embeddings come filtro)
      const TOP_N = 20; // aumentato per più risultati cross-category
      const MIN_SCORE = 0.60; // 60% soglia per match di qualità
      const CONCURRENCY = 1; // valutazione davvero sequenziale (un nodo alla volta)

      // Pulizia stato AI precedente
      cancelAiReveal();
      aiTempLinks = [];
      aiLayer.selectAll('line.ai').remove();
      aiExplainMap.clear();

      const targetKeys = targetNodes.map(n => n.key);
      const targetRawMap = new Map();
      const targetFieldsMap = new Map();
      const descMap = new Map();

      let accepted = 0;

      // 3) STREAMING CON POOL: embeddings come filtro per-target → disegna subito se plausibile
      const aiKey = await getAiKey();
      const specMeta = window.EJ_SPECS_CACHE[epicKey];
      const tag = specMeta && specMeta.ok
        ? `con SPECs (${specMeta.success}/${specMeta.urls.length})`
        : '(senza SPECs utili)';
      if (!aiKey) {
        setStatus(`AI-link: manca chiave OpenAI — impossibile usare embeddings come filtro ${tag}.`, false);
        return;
      }
      setStatus(`AI-link: scan embeddings di ${targetKeys.length} nodi (${catSummary}) ${tag}…`);

      // cache globale opzionale
      window.__EJ_RAW_CACHE__ = window.__EJ_RAW_CACHE__ || {};
      const queue = targetKeys.slice();
      let cancelled = false;
      let processed = 0;
      const total = targetKeys.length;
      
      // Contatori diagnostici
      let skippedNoDescription = 0;
      let skippedShortText = 0;
      let skippedLowScore = 0;

      // Timeout + retry per chiamata embeddings (per-target)
      const TIMEOUT_MS = 12000;
      async function withTimeout(promise, ms) {
        return await Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
        ]);
      }
      async function callEmbeddingsOnce(item) {
        return await withTimeout(
          window.EJ_AI.computeBugTaskSimilarities(
            sourceText,
            [item],
            aiKey,
            { epicKey }
          ),
          TIMEOUT_MS
        );
      }
      async function callEmbeddingsWithRetry(item) {
        let delay = 600;
        for (let i = 0; i < 2; i++) { // due retry rapidi con backoff
          try {
            return await callEmbeddingsOnce(item);
          } catch (e) {
            if (cancelled) return null;
            await new Promise(r => setTimeout(r, delay));
            delay *= 2;
          }
        }
        try {
          return await callEmbeddingsOnce(item);
        } catch {
          return null; // fallback: salta il nodo target
        }
      }

      async function processOne(key) {
        let matched = false;
        try {
          // raw con cache
          let raw = window.__EJ_RAW_CACHE__[key];
          if (!raw) {
            raw = await jiraGetIssueRaw(token, key);
            window.__EJ_RAW_CACHE__[key] = raw;
          }
          
          // Determina il kind del target
          const targetNode = targetNodes.find(n => n.key === key);
          const targetCategory = String(targetNode?.category || '').toLowerCase();
          let targetKind = 'task';
          if (targetCategory === 'bug' || targetCategory === 'mobile_bug') targetKind = 'bug';
          else if (targetCategory === 'task' || targetCategory === 'mobile_task') targetKind = 'task';
          else if (targetCategory === 'story') targetKind = 'story';
          else if (targetCategory === 'test') targetKind = 'test';
          
          targetRawMap.set(key, raw);
          targetFieldsMap.set(key, buildCompositeFields(raw, targetKind));
          const text = buildCompositeTextFromRaw(raw, targetKind) || '';
          descMap.set(key, text);

          if (cancelled) return;
          // Skip nodi senza description (ottimizzazione: evita chiamate embeddings inutili)
          const hasDescription = raw?.fields?.description || raw?.renderedFields?.description;
          if (!hasDescription) {
            skippedNoDescription++;
            return;
          }
          if (text.trim().length < 15) {
            skippedShortText++;
            return; // descrizione insignificante
          }
          if (accepted >= TOP_N) { cancelled = true; return; }

          // Embeddings come filtro: con timeout + retry; se fallisce → skip nodo
          const quick = await callEmbeddingsWithRetry({ id: key, key, text });
          if (!quick) return;

          if (cancelled) return;
          const s = quick && quick[0];
          if (!s || s.score < MIN_SCORE) {
            skippedLowScore++;
            return;
          }

          accepted++;
          const pairKey = `${sourceKey}->${key}`;

          aiTempLinks.push({
            source: sourceKey,
            target: key,
            score: s.score,
            method: s._method || 'embeddings'
          });

          aiExplainMap.set(pairKey, {
            fromKey: sourceKey,
            toKey: key,
            sourceText,
            targetText: text,
            sourceFields,
            targetFields: targetFieldsMap.get(key),
            sourceRaw,
            targetRaw: raw,
            sourceKind,
            targetKind,
            score: s.score,
            method: s._method || 'embeddings',
            reason: s._reason || 'Embeddings gating (SPEC-aware).',
            aiKey
          });

          scheduleDraw();
          setStatus(`AI-link: embeddings ${sourceKey} ↔ ${key} ≈ ${(s.score * 100).toFixed(1)}% (${processed+1}/${total})`);
          matched = true;

          if (accepted >= TOP_N) { cancelled = true; }
        } catch (e) {
          // ignora nodi malformati
        } finally {
          processed++;
          if (!matched && !cancelled) {
            setStatus(`AI-link: scan embeddings di ${total} nodi ${tag} (${processed}/${total})…`, !!(specMeta && specMeta.ok));
          }
        }
      }

      async function worker() {
        while (!cancelled && queue.length) {
          const key = queue.shift();
          await processOne(key);
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, targetKeys.length) }, () => worker());
      await Promise.all(workers);

      // Log diagnostico finale
      console.log(`[AI-link] Risultati: ${accepted} match accettati, ${processed} nodi processati`);
      console.log(`[AI-link] Filtrati: ${skippedNoDescription} senza description, ${skippedShortText} testo corto, ${skippedLowScore} score basso (<${Math.round(MIN_SCORE * 100)}%)`);

      if (accepted === 0) {
        setStatus(
          `AI-link: nessuna corrispondenza ≥ ${Math.round(MIN_SCORE * 100)}% con embeddings.`,
          false
        );
      }

    } catch (e) {
      console.error('AI-link error', e);
      setStatus(`AI-link: errore ${e.message || e}`, false);
    }
  }

  // Ridisegna i link rossi a partire da aiTempLinks (gradiente per score)
  function drawAiLinks() {
    // nessun link → svuota e basta
    if (!aiTempLinks.length) {
      aiLayer.selectAll('line.ai').remove();
      return;
    }

    // Scala assoluta: 0.50 → rosa chiaro, 0.80 → rosso pieno, >0.80 → rosso quasi nero
    const MIN_GRAD = 0.50;  // 50%
    const MAX_GRAD = 0.80;  // 80%

    const light = { r: 254, g: 226, b: 226 }; // rosa molto chiaro (~50%)
    const dark  = { r: 185, g: 28,  b: 28  }; // rosso pieno (~80%)
    const ultra = { r: 30,  g: 3,   b: 3   }; // rosso quasi nero (>80%)

    const lerp = (a, b, t) => a + (b - a) * t;

    function colorForScore(scoreRaw) {
      // scoreRaw è nello [0,1]
      let s = Number(scoreRaw) || 0;
      if (s < 0) s = 0;
      if (s > 1) s = 1;

      // Sotto il 50% → sempre rosa chiaro
      if (s <= MIN_GRAD) {
        return `rgb(${light.r},${light.g},${light.b})`;
      }

      // Sopra l'80% → gradiente dal rosso pieno al rosso quasi nero
      if (s >= MAX_GRAD) {
        const tHigh = (s - MAX_GRAD) / (1 - MAX_GRAD || 1); // mappa [0.80,1] → [0,1]
        const r = Math.round(lerp(dark.r, ultra.r, tHigh));
        const g = Math.round(lerp(dark.g, ultra.g, tHigh));
        const b = Math.round(lerp(dark.b, ultra.b, tHigh));
        return `rgb(${r},${g},${b})`;
      }

      // Tra 50% e 80% → gradiente da rosa chiaro a rosso pieno
      const t = (s - MIN_GRAD) / (MAX_GRAD - MIN_GRAD || 1);
      const r = Math.round(lerp(light.r, dark.r, t));
      const g = Math.round(lerp(light.g, dark.g, t));
      const b = Math.round(lerp(light.b, dark.b, t));
      return `rgb(${r},${g},${b})`;
    }

    aiLayer.selectAll('title').remove();

    const sel = aiLayer.selectAll('line.ai')
      .data(aiTempLinks, d => `${d.source}->${d.target}`);

    const enter = sel.enter()
      .append('line')
        .attr('class', 'ai')
        .attr('stroke-width', 2.2)
        .attr('stroke-dasharray', '6 3')
        .attr('opacity', 0.95)
        .attr('pointer-events', 'stroke'); // necessario per hover
    enter.append('title');

    const merged = enter.merge(sel);

    // stile + interazioni (context menu + hover percentuale)
    merged
      .attr('stroke', d => colorForScore(d.score))
      .on('contextmenu', function(ev, d) {
        ev.preventDefault();
        const pairKey = `${d.source}->${d.target}`;
        const payload = aiExplainMap.get(pairKey) || {
          score: d.score,
          method: d.method,
          fromKey: d.source,
          toKey: d.target,
          bugText: '',
          taskText: '',
          bugFields: {},
          taskFields: {},
          bugRaw: null,
          taskRaw: null,
          reason: ''
        };
        showMenu(ev.clientX, ev.clientY, payload);
      })
      .on('mouseover', (event, d) => {
        if (!tooltip) return;
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${d.source} → ${d.target}</strong><br>` +
            `Similarità: ${(d.score * 100).toFixed(1)}%`
          );
      })
      .on('mousemove', (event) => {
        if (!tooltip) return;
        tooltip
          .style('left', `${event.pageX + 8}px`)
          .style('top', `${event.pageY - 10}px`);
      })
      .on('mouseout', () => {
        if (!tooltip) return;
        tooltip.style('opacity', 0);
      });

    // testo del tooltip nativo SVG (title) – utile anche senza il div tooltip
    merged.select('title')
      .text(d => `Similarità ${(d.score * 100).toFixed(1)}%`);

    sel.exit().remove();

    // 👉 POSIZIONA SUBITO le linee in base alle coordinate attuali
    updateAiLinkPositions();
  }

  node.on('mousedown', startLink);

  node.each(function(d) {
    const g = d3.select(this);
    const R = d.id === epicKey ? 10 : 7;

    g.append('circle')
      .attr('r', R)
      .attr('fill', colorByCategory(d.category))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.25);

    if (d.category === 'task' || d.category === 'bug' || d.category === 'mobile_bug') {
      g.append('circle')
        .attr('r', Math.round(R * 0.45))
        .attr('fill', '#ffffff');
    }
    if (d.category === 'test') {
      g.append('circle')
        .attr('r', Math.round(R * 0.55))
        .attr('fill', 'none')
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 2);
    } 
    if (d.category === 'mobile_task' || d.category === 'mobile_bug') {
      g.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .attr('font-size', R * 1.4)
        .text('📱');
    }
    if (d.category === 'document') {
      g.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .attr('font-size', R * 1.4)
        .text('📄');
    }
    if (d.category === 'test_execution') {
      const k = R * 0.6;
      g.append('path')
        .attr('d', `M ${-k/2},${-k} L ${-k/2},${k} L ${k},0 Z`)
        .attr('fill', '#ffffff');
    }
  });

  // Click destro: calcola similarità con altri nodi e disegna link rossi temporanei
  node.on('contextmenu', (event, d) => {
    event.preventDefault();
    handleNodeContextMenu(event, d);
  });

  const label = stage.append('g')
    .attr('font-size', 11)
    .attr('fill', '#222')
    .selectAll('text')
    .data(nodes)
    .join('text')
      .text(d => d.key)
      .attr('text-anchor', 'middle')
      .attr('dy', 0)
      .attr('pointer-events', 'none');

  tooltip = d3.select('body').append('div')
    .attr('class', 'tooltip')
    .style('opacity', 0);

  node.on('mouseover', (event, d) => {
    const statusTxt = d.status ? `Status: ${escapeHtml(d.status)}` : '';
    const assigneeTxt = d.assignee ? `Assignee: ${escapeHtml(d.assignee)}` : '';
    const extra = [statusTxt, assigneeTxt].filter(Boolean).join('<br>');
    tooltip.style('opacity', 1)
      .html(`<strong>${d.key}</strong><br>${escapeHtml(d.summary)}<br><em>${escapeHtml(d.issuetype)}</em>${extra ? `<br>${extra}` : ''}`);
  }).on('mousemove', (event) => {
    tooltip.style('left', `${event.pageX + 8}px`).style('top', `${event.pageY - 10}px`);
  }).on('mouseout', () => {
    tooltip.style('opacity', 0);
  }).on('click', (event, d) => {
    window.open(`${JIRA_BASE}/browse/${d.key}`, '_blank');
  });

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    // Allinea i link AI temporanei (non fanno parte della force)
    updateAiLinkPositions();

    node.attr('transform', d => `translate(${d.x},${d.y})`);
    label.attr('x', d => d.x).attr('y', d => d.y - (d.id === epicKey ? 10 : 7));
  });

  window.addEventListener('resize', () => {
    const r = svg.node().getBoundingClientRect();
    svg.attr('width', r.width).attr('height', r.height);
    simulation.force('center', d3.forceCenter(r.width / 2, r.height / 2)).alpha(0.2).restart();
  });

  // Doppio click sullo sfondo = pulisci i link AI temporanei
  svg.on('dblclick', () => {
    cancelAiReveal();
    aiTempLinks = [];
    aiExplainMap.clear();
    aiLayer.selectAll('line.ai').remove();
    setStatus('AI-link temporanei rimossi.');
  });

  const zoom = d3.zoom()
    .filter(ev => (ev.type === 'wheel' && ev.ctrlKey) || (ev.type === 'mousedown' && (ev.button === 1 || ev.buttons === 4)))
    .scaleExtent([0.2, 5])
    .wheelDelta((ev) => ev.deltaY * -0.004)
    .on('zoom', (ev) => stage.attr('transform', ev.transform));
  svg.call(zoom);
  svg.node().addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
}

function makeDrag(sim) {
  function dragstarted(event, d) {
    if (!event.active) sim.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x; d.fy = event.y;
  }
  function dragended(event, d) {
    if (!event.active) sim.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
  return d3.drag()
    .filter(ev => !ev.altKey)
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m])
  );
}

function maskAuthHeader(value) {
  if (!value) return value;
  const parts = String(value).split(' ');
  if (parts.length === 2) {
    const v = parts[1];
    return `Basic ${v.slice(0, 6)}…(masked)`;
  }
  return '(masked)';
}

// =============== ADF (Atlassian Doc Format) -> testo semplice ===============
function adfToPlain(adf) {
  // Gestione base: concatena testo dei nodi 'text', 'paragraph', 'heading', 'bulletList/orderedList'
  try {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;
    const out = [];
    (function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      const t = node.type;
      if (t === 'text' && node.text) out.push(node.text);
      if (node.content) walk(node.content);
      if (t === 'paragraph' || t === 'heading') out.push('\n');
      if (t === 'hardBreak') out.push('\n');
      if (t === 'bulletList' || t === 'orderedList') {
        (node.content||[]).forEach(li => walk(li));
        out.push('\n');
      }
    })(adf);
    return out.join(' ').replace(/\s+\n\s+/g, '\n').replace(/\s{2,}/g, ' ').trim();
  } catch { return ''; }
}

// ======= COMPOSITE TEXT (BUG/TASK) =======
// Identificatori "umani" (titoli campo) da cercare nel map "names" di Jira.
// NOTA: match case-insensitive e tollerante (regex).
const BUG_FIELD_PATTERNS = [
  /expected\s*results?/i,
  /steps?\s*to\s*reproduce/i,
  /analysis/i,
  /possible\s*solutions?/i,
  /chosen\s*solution/i,
  /summary\s*of\s*changes?/i
];

const TASK_FIELD_PATTERNS = [
  /possible\s*solutions?/i,
  /chosen\s*solution/i,
  /summary\s*of\s*changes?/i
];

// Converte un valore di campo in testo semplice (ADF, HTML, plain).
function _fieldToText(val) {
  try {
    if (!val) return '';
    // ADF (Atlassian Doc Format) come object
    if (typeof val === 'object') {
      return adfToPlain(val) || '';
    }
    // Stringa: potrebbe essere HTML o plain
    const s = String(val);
    if (/<\s*\w+[\s>]/.test(s)) {
      // HTML → testo
      return _htmlToText(s) || '';
    }
    return s;
  } catch {
    return '';
  }
}

// Dato raw.names (id → humanName), ritorna l'elenco di id che matchano i patterns.
function _collectFieldIds(namesMap, patterns) {
  const ids = [];
  try {
    for (const [fieldId, humanName] of Object.entries(namesMap || {})) {
      const n = String(humanName || '');
      if (patterns.some(rx => rx.test(n))) ids.push(fieldId);
    }
  } catch {}
  return ids;
}

// Estrae un testo renderizzato (preferendo renderedFields se disponibile).
function _getRenderedOrPlainField(raw, fieldId) {
  try {
    const rendered = raw?.renderedFields?.[fieldId];
    if (rendered) {
      // rendered può essere HTML
      return _fieldToText(rendered);
    }
  } catch {}
  // fallback: raw.fields[fieldId] può essere ADF/HTML/plain
  try {
    const plain = raw?.fields?.[fieldId];
    return _fieldToText(plain);
  } catch {
    return '';
  }
}

// Costruisce il testo "composito" per un'issue raw, secondo il "kind" ("bug", "task", "story", "test").
// Include SEMPRE la Description come base; poi concatena i campi richiesti.
function buildCompositeTextFromRaw(raw, kind = 'bug') {
  if (!raw) return '';

  const chunks = [];

  const getRenderedOrPlain = (key) => {
    const html = raw.renderedFields?.[key];
    if (html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div.textContent.trim();
    }
    const val = raw.fields?.[key];
    if (!val) return '';
    if (typeof val === 'object') {
      const extractText = (node) => {
        if (Array.isArray(node)) return node.map(extractText).join(' ');
        if (node.type === 'text') return node.text || '';
        if (node.content) return extractText(node.content);
        return '';
      };
      return extractText(val.content || val).trim();
    }
    return String(val).trim();
  };

  const tryFieldByName = (nameMatch) => {
    const found = Object.entries(raw.names || {}).find(([key, label]) =>
      label?.toLowerCase().includes(nameMatch.toLowerCase())
    );
    if (found) {
      const [key, label] = found;
      const val = getRenderedOrPlain(key);
      if (val) chunks.push(`${label}:\n${val}`);
    }
  };

  // 🔹 SUMMARY sempre per primo (tutti i tipi)
  const summaryText = getRenderedOrPlain('summary');
  if (summaryText) {
    chunks.push(`Summary:\n${summaryText}`);
  }

  // Description sempre inclusa
  tryFieldByName('description');

  // 🔹 Per STORY e TEST: solo Summary + Description (già inclusi sopra)
  if (kind === 'story' || kind === 'test') {
    return chunks.join('\n\n');
  }

  // 🔹 STEPS TO REPRODUCE: SOLO SE kind === 'bug'
  if (
    kind === 'bug' &&
    (raw.fields?.customfield_10101 || raw.renderedFields?.customfield_10101)
  ) {
    const steps = getRenderedOrPlain('customfield_10101');
    if (steps) {
      chunks.push(`Steps to Reproduce:\n${steps}`);
    }
  }

  // Expected Results, Analysis, Possible Solution, ecc. (solo per BUG e TASK)
  tryFieldByName('expected results');
  tryFieldByName('analysis');
  tryFieldByName('possible solution');
  tryFieldByName('chosen solution');
  tryFieldByName('summary of changes');

  return chunks.join('\n\n');
}

// Estrae i campi compositi come oggetto chiave/valore
function buildCompositeFields(raw, kind = 'bug') {
  const names = raw?.names || {};
  const fields = raw?.fields || {};
  const out = {};
  
  // 🔹 SUMMARY sempre per primo
  try {
    let summaryText = '';
    if (raw?.renderedFields?.summary) {
      summaryText = _fieldToText(raw.renderedFields.summary);
    } else {
      summaryText = _fieldToText(fields.summary);
    }
    if (summaryText) {
      out.Summary = summaryText.trim();
    }
  } catch {}
  
  // Description sempre inclusa
  try {
    if (raw?.renderedFields?.description) {
      out.Description = _fieldToText(raw.renderedFields.description);
    } else {
      out.Description = _fieldToText(fields.description);
    }
  } catch {}
  
  // 🔹 Per STORY e TEST: solo Summary + Description (già inclusi sopra)
  const kindLower = String(kind).toLowerCase();
  if (kindLower === 'story' || kindLower === 'test') {
    return out;
  }
  
  // Pattern in base al tipo (solo per BUG e TASK)
  const patterns = (kindLower === 'task') ? TASK_FIELD_PATTERNS : BUG_FIELD_PATTERNS;
  const ids = _collectFieldIds(names, patterns);
  
  // ORDER
  const ORDER = (kindLower === 'task')
    ? [/possible\s*solutions?/i, /chosen\s*solution/i, /summary\s*of\s*changes?/i]
    : [/expected\s*results?/i, /steps?\s*to\s*reproduce/i, /analysis/i, /possible\s*solutions?/i, /chosen\s*solution/i, /summary\s*of\s*changes?/i];
  
  ORDER.forEach(rx => {
    const id = ids.find(fid => rx.test(String(names[fid] || '')));
    if (!id) return;
    const human = String(names[id] || '').trim();
    const val = _getRenderedOrPlainField(raw, id);
    if (val?.trim()) {
      out[human] = val.trim();
    }
  });
  
  return out;
}

// === Fetch "raw" per 1..N issue e costruzione testo composito ===
async function fetchCompositeText(token, key, kind = 'bug') {
  const raw = await jiraGetIssueRaw(token, key);
  return buildCompositeTextFromRaw(raw, kind);
}

// Batch: ritorna Map(key → compositeText)
async function fetchCompositeMap(token, keys, kind = 'task') {
  const out = new Map();
  if (!Array.isArray(keys) || !keys.length) return out;
  for (const k of keys) {
    try {
      const raw = await jiraGetIssueRaw(token, k);
      out.set(k, buildCompositeTextFromRaw(raw, kind));
    } catch {
      out.set(k, '');
    }
  }
  return out;
}

// =============== Lettura description per N issue (batch) ====================
async function fetchIssuesWithDescription(token, keys) {
  if (!keys?.length) return new Map();
  const MAX = 50;
  const result = new Map(); // key -> plainDescription
  for (let i = 0; i < keys.length; i += MAX) {
    const chunk = keys.slice(i, i + MAX);
    const jql = `key in (${chunk.join(',')})`;
    // Qui chiediamo esplicitamente la 'description'
    const issues = await jiraSearch(token, jql, ['summary','issuetype','description']).catch(() => []);
    for (const it of issues) {
      const k = it.key;
      const adf = it.fields?.description || '';
      const plain = adfToPlain(adf);
      result.set(k, plain);
    }
  }
  return result;
}

async function fetchSingleDescription(token, key) {
  const m = await fetchIssuesWithDescription(token, [key]);
  return m.get(key) || '';
}

// UI wiring
(async () => {
  // Rinnovo cache ad ogni apertura della pagina
  window.EJ_SPECS_CACHE = {};
  window.__EJ_LAST_EPIC_RAW__ = {};
  
  ensureContextUi(); // garantisce che backdrop+modal esistano sempre
  
  const params = new URLSearchParams(location.search);
  const epicParam = params.get('epic');

  epicSelect.addEventListener('change', () => {
    const opt = epicSelect.value;
    if (!opt) return;
    // reset soft per evitare riuso di SPEC vecchie
    if (window.EJ_SPECS_CACHE) window.EJ_SPECS_CACHE[opt] = undefined;
    loadGraph(opt);
  });

  try {
    const { token } = await getCreds();
    setStatus('Carico epici della sprint attiva…');
    const epics = await fetchActiveSprintEpics(token);
    epicSelect.innerHTML = '';
    epics.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.key; opt.textContent = `${e.key} — ${e.summary || ''}`;
      epicSelect.appendChild(opt);
    });
    if (!epics.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'Nessun epico in sprint attiva';
      epicSelect.appendChild(opt);
    }
    if (epicParam) {
      const norm = normalizeEpicKey(epicParam);
      const found = epics.find(e => e.key === norm);
      if (found) epicSelect.value = norm;
    }
    if (epicSelect.value) loadGraph(epicSelect.value); else setStatus('Select Epics in Actual Sprint', true);
  } catch (e) {
    console.error(e);
    setStatus('Impossibile caricare gli epici della sprint attiva. Verifica credenziali.', false);
  }

  const copyBtn = document.getElementById('copyDebug');
  const openSettingsBtn = document.getElementById('openSettings');
  openSettingsBtn?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  copyBtn?.addEventListener('click', async () => {
    const debug = lastApiDebug || { info: 'Nessuna chiamata ancora effettuata.' };
    const text = JSON.stringify(debug, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Diagnostica copiata negli appunti.', true);
    } catch (e) {
      console.error('Clipboard error', e);
      setStatus('Impossibile copiare negli appunti.', false);
    }
  });

  viewSpecsBtn?.addEventListener('click', () => {
    // Recupera testo SPECs dalla cache dell'epico selezionato
    const currentEpic = epicSelect?.value || '';
    const meta = (window.EJ_SPECS_CACHE && currentEpic) ? window.EJ_SPECS_CACHE[currentEpic] : null;
    const text = meta?.text || '(Nenhum conteúdo de SPEC carregado.)';

    // Usa il modale già presente per le spiegazioni, ma con titolo e testo dinamici
    ensureContextUi(); // garantisce esistenza dei nodi UI
    const title = document.querySelector('#ej-ai-modal h3');
    const pre   = document.getElementById('ej-ai-modal-text');
    if (title) title.textContent = `SPECs de ${currentEpic}`;
    if (pre)   pre.textContent = text + `\n\n---\n` + (specsDiag.join('\n') || '(sem logs)');
    document.getElementById('ej-ai-backdrop').style.display = 'block';
    document.getElementById('ej-ai-modal').style.display = 'block';
  });

  const dumpEpicBtn = document.getElementById('dumpEpic');
  dumpEpicBtn?.addEventListener('click', async () => {
    try {
      const epic = CURRENT_EPIC_KEY || epicSelect?.value || '';
      if (!epic) { setStatus('Nessun épico selezionato.', false); return; }
      setStatus(`Interrogo épico ${epic}…`);
      const token = CURRENT_AUTH_TOKEN || (await getCreds()).token;
      const data = await jiraGetIssueRaw(token, epic);

      // Salva in cache per uso futuro (renderedFields)
      window.__EJ_LAST_EPIC_RAW__ = window.__EJ_LAST_EPIC_RAW__ || {};
      window.__EJ_LAST_EPIC_RAW__[epic] = data;

      // Prepara un payload leggibile: id→name, renderedFields, e URL trovate
      const fieldNames = data.names || {};
      const rendered = data.renderedFields || {};
      const allUrls = extractAllUrlsFromJson(data);

      const dump = {
        key: data.key,
        fieldsAvailable: Object.keys(fieldNames).length,
        exampleFieldNames: Object.entries(fieldNames).slice(0, 25), // anteprima
        renderedFields: rendered, // HTML già renderizzato da Jira
        urlHits: allUrls.slice(0, 50), // anteprima 50 URL
        note: 'Cerca nei fieldNames la chiave che contiene i link. Se i link stanno in renderedFields, copiali da qui.'
      };

      // Mostra nel modale già esistente
      ensureContextUi();
      const title = document.querySelector('#ej-ai-modal h3');
      const pre   = document.getElementById('ej-ai-modal-text');
      if (title) title.textContent = `Dump épico ${epic}`;
      if (pre)   pre.textContent = JSON.stringify(dump, null, 2);
      document.getElementById('ej-ai-backdrop').style.display = 'block';
      document.getElementById('ej-ai-modal').style.display = 'block';

      setStatus(`Dump épico ${epic} pronto.`, true);
    } catch (e) {
      console.error(e);
      setStatus(e.message || String(e), false);
    }
  });
})();
