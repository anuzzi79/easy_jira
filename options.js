// options.js

const el = (id) => document.getElementById(id);
const statusEl = el('status');

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (ok ? 'ok' : 'err');
}

async function load() {
  try {
    const {
      jiraBaseUrl = 'https://facilitygrid.atlassian.net',
      jiraEmail = '',
      jiraApiKey = '',
      openAiApiKey = ''
    } = await chrome.storage.sync.get([
      'jiraBaseUrl','jiraEmail','jiraApiKey','openAiApiKey'
    ]);

    el('jiraBaseUrl').value = jiraBaseUrl || '';
    el('jiraEmail').value = jiraEmail || '';
    el('jiraApiKey').value = jiraApiKey || '';
    el('openAiApiKey').value = openAiApiKey || '';

    setStatus('Impostazioni caricate.', true);
  } catch (e) {
    console.error(e);
    setStatus('Errore nel caricamento delle impostazioni.', false);
  }
}

async function save() {
  const jiraBaseUrl = el('jiraBaseUrl').value.trim();
  const jiraEmail   = el('jiraEmail').value.trim();
  const jiraApiKey  = el('jiraApiKey').value.trim();
  const openAiApiKey = el('openAiApiKey').value.trim();

  if (!jiraBaseUrl || !jiraEmail || !jiraApiKey) {
    setStatus('Compila Jira Base URL, Email e Jira API Key.', false);
    return;
  }

  try {
    await chrome.storage.sync.set({ jiraBaseUrl, jiraEmail, jiraApiKey, openAiApiKey });
    setStatus('Salvato.', true);
  } catch (e) {
    console.error(e);
    setStatus('Errore nel salvataggio.', false);
  }
}

async function clearKeys() {
  try {
    await chrome.storage.sync.set({ jiraApiKey: '', openAiApiKey: '' });
    el('jiraApiKey').value = '';
    el('openAiApiKey').value = '';
    setStatus('Chiavi cancellate.', true);
  } catch (e) {
    console.error(e);
    setStatus('Errore nella cancellazione.', false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();

  el('save').addEventListener('click', save);
  el('clear').addEventListener('click', clearKeys);

  el('showJira').addEventListener('change', (ev) => {
    el('jiraApiKey').type = ev.target.checked ? 'text' : 'password';
  });
  el('showOpenAI').addEventListener('change', (ev) => {
    el('openAiApiKey').type = ev.target.checked ? 'text' : 'password';
  });
});
