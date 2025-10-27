// Popup minimal: apre subito la tela del grafico e chiude il popup
document.addEventListener('DOMContentLoaded', async () => {
  const url = chrome.runtime.getURL('graph.html');
  chrome.tabs.create({ url });
  window.close();
});
