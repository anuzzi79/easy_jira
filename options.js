const baseUrlEl = document.getElementById('baseUrl');
const emailEl = document.getElementById('email');
const apiKeyEl = document.getElementById('apiKey');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');
const statusEl = document.getElementById('status');

(async () => {
  const { jiraBaseUrl, jiraEmail, jiraApiKey } = await chrome.storage.sync.get(['jiraBaseUrl','jiraEmail','jiraApiKey']);
  baseUrlEl.value = jiraBaseUrl || 'https://facilitygrid.atlassian.net/';
  if (jiraEmail) emailEl.value = jiraEmail;
  if (jiraApiKey) apiKeyEl.value = jiraApiKey;
})();

saveBtn.addEventListener('click', async () => {
  const jiraBaseUrl = baseUrlEl.value.trim();
  const jiraEmail = emailEl.value.trim();
  const jiraApiKey = apiKeyEl.value.trim();

  if (!jiraBaseUrl || !jiraEmail || !jiraApiKey) {
    statusEl.textContent = 'Compila base URL, email e API key.';
    statusEl.style.color = '#c00';
    return;
  }
  // normalizza URL con trailing slash rimosso
  const normalized = jiraBaseUrl.replace(/\/$/, '');
  await chrome.storage.sync.set({ jiraBaseUrl: normalized, jiraEmail, jiraApiKey });
  statusEl.textContent = 'Salvato ✅';
  statusEl.style.color = '#0a7';
  setTimeout(() => statusEl.textContent = '', 2000);
});

async function testConnection() {
  const jiraBaseUrl = (baseUrlEl.value.trim() || '').replace(/\/$/, '');
  const jiraEmail = emailEl.value.trim();
  const jiraApiKey = apiKeyEl.value.trim();
  if (!jiraBaseUrl || !jiraEmail || !jiraApiKey) {
    statusEl.textContent = 'Inserisci base URL, email e API key.';
    statusEl.style.color = '#c00';
    return;
  }
  statusEl.textContent = 'Test in corso…';
  statusEl.style.color = '#666';
  try {
    const token = btoa(`${jiraEmail}:${jiraApiKey}`);
    const res = await fetch(`${jiraBaseUrl}/rest/api/3/myself`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json'
      },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      mode: 'cors'
    });

    const textBody = await res.text();
    if (!res.ok) {
      const snippet = textBody.slice(0, 200);
      throw new Error(`HTTP ${res.status}: ${snippet}`);
    }

    let data;
    try {
      data = JSON.parse(textBody);
    } catch {
      throw new Error('Risposta non valida (non JSON)');
    }

    if (!data || (!data.accountId && !data.emailAddress && !data.self)) {
      throw new Error('Credenziali non valide');
    }

    statusEl.textContent = `OK: ${data.displayName || data.emailAddress || 'utente'}`;
    statusEl.style.color = '#0a7';
  } catch (e) {
    statusEl.textContent = `Connessione fallita: ${e.message}`;
    statusEl.style.color = '#c00';
  }
}

testBtn.addEventListener('click', testConnection);
