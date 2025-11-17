// Content script per pagine Jira
// Questo script viene iniettato automaticamente nelle pagine Jira
// e permette all'estensione di leggere il meta tag prefetchedItems dal DOM

console.log('[EJIRA] Content script caricato su:', window.location.href);
console.log('[EJIRA] Document ready state:', document.readyState);

// Funzione per aspettare che un meta tag appaia nel DOM
function waitForMetaTag(metaName, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let observer = null;
    let timeoutId = null;
    
    // Funzione per controllare se il meta tag esiste
    const checkMeta = () => {
      const meta = document.querySelector(`meta[name="${metaName}"]`);
      if (meta && meta.content) {
        // Trovato! Pulisci observer e timeout
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(meta.content);
        return true;
      }
      return false;
    };
    
    // Controlla immediatamente se esiste già
    if (checkMeta()) {
      return;
    }
    
    // Se non trovato, usa MutationObserver per rilevare quando viene aggiunto
    observer = new MutationObserver((mutations) => {
      if (checkMeta()) {
        return;
      }
    });
    
    // Osserva i cambiamenti nel <head> e in tutto il documento
    observer.observe(document.head, {
      childList: true,
      subtree: true
    });
    
    // Osserva anche il documento completo (per meta tag aggiunti dinamicamente)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    
    // Fallback: controlla periodicamente ogni secondo
    const periodicCheck = () => {
      if (checkMeta()) {
        return;
      }
      
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        // Timeout scaduto
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        reject(new Error(`Timeout: meta tag "${metaName}" non trovato dopo ${timeout}ms`));
        return;
      }
      
      // Riprova tra 1 secondo
      timeoutId = setTimeout(periodicCheck, 1000);
    };
    
    // Avvia il controllo periodico
    timeoutId = setTimeout(periodicCheck, 1000);
  });
}

// Funzione per leggere il meta tag prefetchedItems
async function readChecklistFromMetaTag() {
  try {
    console.log('[EJIRA] Inizio ricerca meta tag prefetchedItems...');
    console.log('[EJIRA] URL corrente:', window.location.href);
    console.log('[EJIRA] Document ready state:', document.readyState);
    
    // Controlla immediatamente se esiste
    let meta = document.querySelector('meta[name="prefetchedItems"]');
    if (meta) {
      console.log('[EJIRA] Meta tag trovato immediatamente!');
    } else {
      console.log('[EJIRA] Meta tag non trovato immediatamente, attendo...');
      // Lista tutti i meta tag presenti per debug
      const allMetaTags = Array.from(document.querySelectorAll('meta'));
      console.log('[EJIRA] Meta tag presenti nel DOM:', allMetaTags.map(m => m.name || m.getAttribute('name') || 'no-name').filter(Boolean));
    }
    
    // Aspetta che il meta tag prefetchedItems appaia
    const metaContent = await waitForMetaTag('prefetchedItems', 240000);
    
    console.log('[EJIRA] Meta tag trovato! Lunghezza contenuto:', metaContent.length);
    
    // Decodifica le entità HTML (es: &quot; -> ")
    const textarea = document.createElement('textarea');
    textarea.innerHTML = metaContent;
    const jsonStr = textarea.value;
    
    console.log('[EJIRA] JSON decodificato, lunghezza:', jsonStr.length);
    
    // Parsa il JSON
    const prefetchedItems = JSON.parse(jsonStr);
    
    console.log('[EJIRA] JSON parsato con successo! Numero elementi:', prefetchedItems.length);
    
    return { items: prefetchedItems, success: true };
  } catch (error) {
    console.error('[EJIRA] Errore lettura meta tag:', error);
    // Debug: mostra tutti i meta tag presenti
    const allMetaTags = Array.from(document.querySelectorAll('meta'));
    console.log('[EJIRA] Tutti i meta tag nel DOM:', allMetaTags.map(m => ({
      name: m.name || m.getAttribute('name') || 'no-name',
      content: m.content ? m.content.substring(0, 100) + '...' : 'no-content'
    })));
    return { error: error.message || String(error), success: false };
  }
}

// Listener per messaggi dall'estensione
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    // Risposta per verificare che il content script sia pronto
    sendResponse('pong');
    return false;
  }
  
  if (request.action === 'readChecklistFromMeta') {
    // Legge il meta tag prefetchedItems direttamente dal DOM
    readChecklistFromMetaTag()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message || String(error), success: false }));
    return true; // Indica che risponderemo in modo asincrono
  }
  
  // Manteniamo anche il vecchio metodo per compatibilità
  if (request.action === 'fetchChecklist' && request.url) {
    // Fallback: richiesta fetch (meno preferito)
    fetch(request.url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      credentials: 'include',
      mode: 'cors'
    })
    .then(res => {
      if (!res.ok) {
        return { error: `HTTP ${res.status}: ${res.statusText}`, status: res.status, success: false };
      }
      return res.text().then(html => ({ html, status: res.status, success: true }));
    })
    .then(result => sendResponse(result))
    .catch(error => sendResponse({ error: error.message || String(error), success: false }));
    return true;
  }
});

