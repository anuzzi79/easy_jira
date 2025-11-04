// options.js – Settings + Test OpenAI
// Salvataggi in chrome.storage.sync:
//  - jiraBaseUrl, jiraEmail, jiraApiKey
//  - openAiApiKey

const $ = (id) => document.getElementById(id);
const jiraBaseUrl = $('jiraBaseUrl');
const jiraEmail = $('jiraEmail');
const jiraApiKey = $('jiraApiKey');
const openAiApiKey = $('openAiApiKey');

const saveJiraBtn = $('saveJira');
const jiraSaveStatus = $('jiraSaveStatus');

const saveOpenAIBtn = $('saveOpenAI');
const testOpenAIBtn = $('testOpenAI');
const openAiState = $('openAiState');
const testOutput = $('testOutput');

const revealBtn = $('revealKeys');
const clearOpenAI = $('clearOpenAI');

function setChip(kind, text) {
  openAiState.className = 'chip ' + (kind || 'warn');
  openAiState.textContent = text || 'In attesa di test';
}

function mask(val) {
  if (!val) return '';
  const s = String(val);
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

async function loadSettings() {
  const cfg = await chrome.storage.sync.get([
    'jiraBaseUrl','jiraEmail','jiraApiKey','openAiApiKey'
  ]);
  jiraBaseUrl.value = cfg.jiraBaseUrl || '';
  jiraEmail.value = cfg.jiraEmail || '';
  jiraApiKey.value = cfg.jiraApiKey || '';
  openAiApiKey.value = cfg.openAiApiKey || '';

  jiraSaveStatus.textContent = 'Pronto';
  setChip(openAiApiKey.value ? 'warn' : 'err',
          openAiApiKey.value ? 'Chiave presente, testa per conferma' : 'Chiave assente');
  testOutput.textContent = '';
}

async function saveJira() {
  await chrome.storage.sync.set({
    jiraBaseUrl: jiraBaseUrl.value.trim(),
    jiraEmail: jiraEmail.value.trim(),
    jiraApiKey: jiraApiKey.value.trim()
  });
  jiraSaveStatus.textContent = 'Salvato ✓';
  setTimeout(() => (jiraSaveStatus.textContent = 'Pronto'), 1500);
}

async function saveOpenAI() {
  await chrome.storage.sync.set({ openAiApiKey: openAiApiKey.value.trim() });
  setChip(openAiApiKey.value ? 'warn' : 'err',
          openAiApiKey.value ? 'Chiave salvata, testa ora' : 'Chiave rimossa');
  testOutput.textContent = '';
}

async function testOpenAI() {
  const key = (await chrome.storage.sync.get(['openAiApiKey'])).openAiApiKey || openAiApiKey.value.trim();
  if (!key) {
    setChip('err', 'Chiave assente');
    testOutput.textContent = 'Inserisci una OpenAI API Key e premi “Salva chiave”.';
    return;
  }

  setChip('warn', 'Test in corso…');
  testOutput.textContent = 'Eseguo richiesta a https://api.openai.com/v1/embeddings…';

  const url = 'https://api.openai.com/v1/embeddings';
  const body = {
    model: 'text-embedding-3-large',
    input: 'ping'
  };

  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      // MV3: niente credenziali, niente cache
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });

    const elapsed = Math.round(performance.now() - started);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      setChip('err', `Errore ${res.status}`);
      testOutput.textContent =
        `❌ OpenAI NON raggiungibile o chiave non valida.\n` +
        `Status: ${res.status} ${res.statusText}\n` +
        `Tempo: ${elapsed} ms\n` +
        `Body (primi 400 chars):\n${txt.slice(0,400)}`;
      return;
    }

    const data = await res.json();
    const dim = (data?.data?.[0]?.embedding || []).length || 'n/d';
    setChip('ok', 'OK (Embeddings attivi)');
    testOutput.textContent =
      `✅ Test riuscito.\n` +
      `Modello: text-embedding-3-large\n` +
      `Dimensione embedding: ${dim}\n` +
      `Tempo: ${elapsed} ms\n` +
      `Suggerimento: ora nel grafico vedrai “Método: Embeddings (semântico)”.`;
  } catch (e) {
    setChip('err', 'Errore di rete');
    testOutput.textContent =
      `❌ Errore di rete/ambiente.\n` +
      `Dettaglio: ${e?.message || e}\n\n` +
      `Possibili cause:\n` +
      `• Proxy/antivirus bloccano la richiesta\n` +
      `• Permessi host mancanti nel manifest\n` +
      `• Offline o DNS\n`;
  }
}

let revealed = false;
function toggleReveal() {
  revealed = !revealed;
  jiraApiKey.type = revealed ? 'text' : 'password';
  openAiApiKey.type = revealed ? 'text' : 'password';
  revealBtn.textContent = revealed ? 'Nascondi chiavi' : 'Mostra/Nascondi chiavi';
}

async function wipeOpenAI() {
  await chrome.storage.sync.set({ openAiApiKey: '' });
  openAiApiKey.value = '';
  setChip('err','Chiave rimossa');
  testOutput.textContent = 'La chiave OpenAI è stata rimossa.';
}

saveJiraBtn.addEventListener('click', saveJira);
saveOpenAIBtn.addEventListener('click', saveOpenAI);
testOpenAIBtn.addEventListener('click', testOpenAI);
revealBtn.addEventListener('click', toggleReveal);
clearOpenAI.addEventListener('click', wipeOpenAI);

loadSettings();
