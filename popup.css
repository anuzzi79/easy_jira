const epicInput = document.getElementById('epicKey');
const openGraphBtn = document.getElementById('openGraph');
const openOptions = document.getElementById('openOptions');

(async () => {
  // Pre-riempi con default
  const { lastEpicKey } = await chrome.storage.sync.get(['lastEpicKey']);
  epicInput.value = lastEpicKey || 'FGC-9540';
})();

openGraphBtn.addEventListener('click', async () => {
  let key = epicInput.value.trim();
  if (!key) { alert('Inserisci una chiave epico (es. FGC-9540)'); return; }
  // Normalizza: se è solo numero, aggiunge prefisso FGC-
  if (/^\d+$/.test(key)) key = `FGC-${key}`;

  await chrome.storage.sync.set({ lastEpicKey: key });

  // Apri la pagina del grafico in una nuova tab
  const url = chrome.runtime.getURL(`graph.html?epic=${encodeURIComponent(key)}`);
  chrome.tabs.create({ url });
});

openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
