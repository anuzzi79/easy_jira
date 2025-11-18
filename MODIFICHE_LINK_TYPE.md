# Modifiche per supportare selezione tipo di link

## IMPORTANTE: Applicare queste modifiche manualmente

Il file graph.js è molto grande e le modifiche automatiche stanno causando problemi.
Applica queste modifiche manualmente seguendo le istruzioni.

---

## 1. Modifica funzione jiraCreateIssueLink (riga ~1179)

**Sostituisci:**
```javascript
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
```

**Con:**
```javascript
async function jiraCreateIssueLink(token, fromKey, toKey, linkType = 'Relates') {
  const url = `${JIRA_BASE}/rest/api/3/issueLink`;
  const body = {
    type: { name: linkType },
    outwardIssue: { key: fromKey },
    inwardIssue: { key: toKey }
  };
  
  // Log diagnostico dettagliato
  const debugInfo = {
    timestamp: new Date().toISOString(),
    operation: 'CREATE_ISSUE_LINK',
    url,
    method: 'POST',
    requestBody: body,
    fromKey,
    toKey,
    linkType,
    requestHeaders: {
      'Authorization': maskAuthHeader(`Basic ${token}`),
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
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
  
  debugInfo.status = res.status;
  debugInfo.statusText = res.statusText;
  try { 
    debugInfo.responseText = await res.clone().text(); 
    try {
      debugInfo.responseJson = JSON.parse(debugInfo.responseText);
    } catch {}
  } catch {}
  
  // Salva per "Copia diagnostica"
  lastApiDebug = debugInfo;
  
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`Link Jira fallito (${res.status}): ${txt.slice(0,180)}`);
  }
  
  return res.json();
}
```

---

## 2. Aggiungi funzioni per recuperare tipi di link (dopo jiraCreateIssueLink, prima di jiraGetIssueRaw)

**Aggiungi dopo la funzione jiraCreateIssueLink:**

```javascript
// Recupera i tipi di link disponibili da Jira
let cachedLinkTypes = null;
async function jiraGetIssueLinkTypes(token) {
  const debugInfo = {
    timestamp: new Date().toISOString(),
    operation: 'GET_ISSUE_LINK_TYPES',
    url: `${JIRA_BASE}/rest/api/3/issueLinkType`,
    method: 'GET',
    requestHeaders: {
      'Authorization': maskAuthHeader(`Basic ${token}`),
      'Accept': 'application/json'
    },
    usingCache: !!cachedLinkTypes
  };
  
  if (cachedLinkTypes) {
    debugInfo.cachedTypes = cachedLinkTypes;
    lastApiDebug = debugInfo;
    return cachedLinkTypes;
  }
  
  try {
    const url = `${JIRA_BASE}/rest/api/3/issueLinkType`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json'
      },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    
    debugInfo.status = res.status;
    debugInfo.statusText = res.statusText;
    try { 
      debugInfo.responseText = await res.clone().text(); 
      try {
        debugInfo.responseJson = JSON.parse(debugInfo.responseText);
      } catch {}
    } catch {}
    
    lastApiDebug = debugInfo;
    
    if (!res.ok) {
      console.warn('[LINK_TYPES] API fallita, uso fallback', res.status);
      return getDefaultLinkTypes();
    }
    
    const data = await res.json();
    const types = [];
    if (Array.isArray(data.issueLinkTypes)) {
      data.issueLinkTypes.forEach(lt => {
        if (lt.inward) types.push({ name: lt.inward, id: lt.id, direction: 'inward' });
        if (lt.outward) types.push({ name: lt.outward, id: lt.id, direction: 'outward' });
      });
    }
    
    cachedLinkTypes = types.length > 0 ? types : getDefaultLinkTypes();
    debugInfo.parsedTypes = cachedLinkTypes;
    lastApiDebug = debugInfo;
    return cachedLinkTypes;
  } catch (e) {
    debugInfo.error = e.message;
    debugInfo.stack = e.stack;
    lastApiDebug = debugInfo;
    console.warn('[LINK_TYPES] Errore, uso fallback', e);
    return getDefaultLinkTypes();
  }
}

function getDefaultLinkTypes() {
  return [
    { name: 'Relates', id: 'relates', direction: 'outward' },
    { name: 'Blocks', id: 'blocks', direction: 'outward' },
    { name: 'is blocked by', id: 'blocks', direction: 'inward' },
    { name: 'Implements', id: 'implements', direction: 'outward' },
    { name: 'is implemented by', id: 'implements', direction: 'inward' },
    { name: 'Clones', id: 'clones', direction: 'outward' },
    { name: 'is cloned by', id: 'clones', direction: 'inward' },
    { name: 'Duplicates', id: 'duplicates', direction: 'outward' },
    { name: 'is duplicated by', id: 'duplicates', direction: 'inward' }
  ];
}
```

---

## 3. Aggiungi stili CSS (in ensureContextUi, dopo riga ~2271)

**Aggiungi nella sezione style.textContent, dopo gli altri stili:**

```javascript
      .ej-link-type-menu { position: fixed; z-index: 10007; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); min-width: 220px; max-height: 400px; overflow-y: auto; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; display: none; }
      .ej-link-type-menu ul { list-style: none; margin: 0; padding: 6px; }
      .ej-link-type-menu li { padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 14px; }
      .ej-link-type-menu li:hover { background: #f3f4f6; }
      .ej-link-type-menu li.selected { background: #dbeafe; color: #1e40af; font-weight: 500; }
      .ej-link-lasso { stroke: #22c55e; stroke-width: 2; stroke-opacity: 0.8; fill: none; pointer-events: none; }
      .ej-link-target-highlight { stroke: #3b82f6; stroke-width: 4; stroke-opacity: 0.6; fill: none; pointer-events: none; }
```

---

## 4. Aggiungi elemento DOM per menu link type (in ensureContextUi, dopo creazione ej-node-menu, riga ~2316)

**Aggiungi dopo:**
```javascript
  } else {
    nodeContextMenuEl = document.getElementById('ej-node-menu');
  }
```

**Aggiungi:**
```javascript
  if (!document.getElementById('ej-link-type-menu')) {
    const linkTypeMenu = document.createElement('div');
    linkTypeMenu.id = 'ej-link-type-menu';
    linkTypeMenu.className = 'ej-link-type-menu';
    linkTypeMenu.innerHTML = `<ul id="ej-link-type-list"></ul>`;
    linkTypeMenu.style.display = 'none';
    document.body.appendChild(linkTypeMenu);
  }
```

---

## 5. Aggiungi funzioni showLinkTypeMenu e hideLinkTypeMenu (dopo hideNodeContextMenu, riga ~3444)

**Aggiungi dopo la funzione hideNodeContextMenu:**

```javascript
function showLinkTypeMenu(event, fromKey, toKey, onSelect) {
  const debugInfo = {
    timestamp: new Date().toISOString(),
    operation: 'SHOW_LINK_TYPE_MENU',
    fromKey,
    toKey,
    clientX: event.clientX,
    clientY: event.clientY
  };
  console.log('[LINK_MENU] Mostro menu', debugInfo);
  
  const menu = document.getElementById('ej-link-type-menu');
  const list = document.getElementById('ej-link-type-list');
  if (!menu || !list) {
    debugInfo.error = 'Menu o list non trovati';
    lastApiDebug = debugInfo;
    console.error('[LINK_MENU] Menu non trovato');
    return;
  }

  const { clientX, clientY } = event;
  menu.style.display = 'block';
  menu.style.left = `${clientX + 6}px`;
  menu.style.top = `${clientY + 6}px`;

  // Carica i tipi di link
  getCreds().then(({ token }) => {
    debugInfo.loadingLinkTypes = true;
    console.log('[LINK_MENU] Carico tipi di link...');
    
    jiraGetIssueLinkTypes(token).then(linkTypes => {
      debugInfo.linkTypesCount = linkTypes.length;
      debugInfo.linkTypes = linkTypes.map(lt => lt.name);
      console.log('[LINK_MENU] Tipi caricati', linkTypes.length, linkTypes.map(lt => lt.name));
      
      list.innerHTML = '';
      linkTypes.forEach(lt => {
        const li = document.createElement('li');
        li.textContent = lt.name;
        li.onclick = (e) => {
          e.stopPropagation();
          const selectDebug = {
            timestamp: new Date().toISOString(),
            operation: 'SELECT_LINK_TYPE',
            fromKey,
            toKey,
            selectedType: lt.name,
            linkTypeData: lt
          };
          console.log('[LINK_MENU] Tipo selezionato', selectDebug);
          lastApiDebug = selectDebug;
          hideLinkTypeMenu();
          onSelect(lt.name);
        };
        list.appendChild(li);
      });
      
      lastApiDebug = debugInfo;
    }).catch((err) => {
      debugInfo.error = err.message;
      debugInfo.stack = err.stack;
      console.error('[LINK_MENU] Errore caricamento tipi', err);
      
      // Fallback a lista default
      const defaultTypes = getDefaultLinkTypes();
      debugInfo.usingFallback = true;
      debugInfo.fallbackTypes = defaultTypes.map(lt => lt.name);
      console.log('[LINK_MENU] Uso fallback', defaultTypes.length);
      
      list.innerHTML = '';
      defaultTypes.forEach(lt => {
        const li = document.createElement('li');
        li.textContent = lt.name;
        li.onclick = (e) => {
          e.stopPropagation();
          const selectDebug = {
            timestamp: new Date().toISOString(),
            operation: 'SELECT_LINK_TYPE',
            fromKey,
            toKey,
            selectedType: lt.name,
            linkTypeData: lt,
            usingFallback: true
          };
          console.log('[LINK_MENU] Tipo selezionato (fallback)', selectDebug);
          lastApiDebug = selectDebug;
          hideLinkTypeMenu();
          onSelect(lt.name);
        };
        list.appendChild(li);
      });
      
      lastApiDebug = debugInfo;
    });
  }).catch((err) => {
    debugInfo.credsError = err.message;
    console.error('[LINK_MENU] Errore credenziali', err);
    lastApiDebug = debugInfo;
  });

  const hideLater = () => hideLinkTypeMenu();
  setTimeout(() => document.addEventListener('click', hideLater, { once: true }), 0);
}

function hideLinkTypeMenu() {
  const menu = document.getElementById('ej-link-type-menu');
  if (menu) {
    console.log('[LINK_MENU] Nascondo menu');
    menu.style.display = 'none';
  }
}
```

---

## 6. Modifica renderForceGraph per ALT + tasto destro con laccio

**All'inizio di renderForceGraph (dopo riga ~3570), aggiungi variabili:**

```javascript
  // Variabili per il laccio ALT + tasto destro
  let altRightClickLasso = null;
  let altRightClickStart = null;
  let altRightClickTargetHighlight = null;
  let altRightClickActive = false;
```

**Sostituisci il gestore contextmenu (riga ~4525):**

**TROVA:**
```javascript
  // Click destro: mostra menu contestuale (inspect / search)
  node.on('contextmenu', (event, d) => {
    event.preventDefault();
    showNodeContextMenu(
      event,
      d,
      (nodeData) => {
        inspectNodeDetails(nodeData);
      },
      (nodeData) => {
        handleNodeContextMenu(event, nodeData);
      }
    );
  });
```

**SOSTITUISCI CON:**
```javascript
  // Click destro: mostra menu contestuale (inspect / search) o attiva laccio se ALT premuto
  node.on('contextmenu', (event, d) => {
    event.preventDefault();
    
    // Se ALT è premuto, attiva il laccio per creare link
    if (event.altKey) {
      const debugInfo = {
        timestamp: new Date().toISOString(),
        operation: 'ALT_RIGHT_CLICK_START',
        sourceNode: d.id,
        sourceKey: d.key,
        clientX: event.clientX,
        clientY: event.clientY
      };
      console.log('[ALT_LINK] Inizio laccio', debugInfo);
      lastApiDebug = debugInfo;
      
      // Cancella eventuale laccio precedente
      if (altRightClickLasso) {
        altRightClickLasso.remove();
        altRightClickLasso = null;
      }
      if (altRightClickTargetHighlight) {
        altRightClickTargetHighlight.remove();
        altRightClickTargetHighlight = null;
      }
      
      altRightClickStart = d;
      altRightClickActive = true;
      
      // Crea il laccio che parte dal nodo sorgente
      const startP = [d.x || 0, d.y || 0];
      altRightClickLasso = stage.append('line')
        .attr('class', 'ej-link-lasso')
        .attr('x1', startP[0])
        .attr('y1', startP[1])
        .attr('x2', startP[0])
        .attr('y2', startP[1])
        .attr('pointer-events', 'none');
      
      setStatus(`ALT+Click destro: seleziona il nodo di destinazione (rilascia il mouse su un nodo)`);
      
      // Funzione per aggiornare il laccio seguendo il mouse
      const updateLasso = (moveEvent) => {
        if (!altRightClickLasso || !altRightClickActive) return;
        
        const p = d3.pointer(moveEvent, stage.node());
        altRightClickLasso
          .attr('x2', p[0])
          .attr('y2', p[1]);
        
        // Controlla se il mouse è su un nodo target
        const target = findNodeAt(nodes, p[0], p[1]);
        
        // Rimuovi highlight precedente
        if (altRightClickTargetHighlight) {
          altRightClickTargetHighlight.remove();
          altRightClickTargetHighlight = null;
        }
        
        // Evidenzia il nodo target se diverso dal sorgente
        if (target && target.id !== altRightClickStart.id) {
          const targetNode = svg.selectAll('g.node').filter(n => n && n.id === target.id);
          if (targetNode.size() > 0) {
            const nodeData = targetNode.datum();
            altRightClickTargetHighlight = stage.append('circle')
              .attr('class', 'ej-link-target-highlight')
              .attr('cx', nodeData.x || 0)
              .attr('cy', nodeData.y || 0)
              .attr('r', (nodeData.id === epicKey ? 10 : 7) + 4)
              .attr('pointer-events', 'none');
          }
        }
      };
      
      // Funzione per completare il link quando si rilascia il mouse
      const completeLink = (upEvent) => {
        if (!altRightClickActive || !altRightClickStart) {
          cleanupAltRightClick();
          return;
        }
        
        const p = d3.pointer(upEvent, stage.node());
        const target = findNodeAt(nodes, p[0], p[1]);
        
        const debugInfo = {
          timestamp: new Date().toISOString(),
          operation: 'ALT_RIGHT_CLICK_COMPLETE',
          sourceNode: altRightClickStart.id,
          sourceKey: altRightClickStart.key,
          targetNode: target ? target.id : null,
          targetKey: target ? target.key : null,
          mousePosition: { x: p[0], y: p[1] }
        };
        console.log('[ALT_LINK] Completamento laccio', debugInfo);
        
        if (target && target.id !== altRightClickStart.id) {
          // Mostra menu per selezionare il tipo di link
          debugInfo.showingMenu = true;
          lastApiDebug = debugInfo;
          
          showLinkTypeMenu(upEvent, altRightClickStart.id, target.id, (linkType) => {
            const createDebug = {
              timestamp: new Date().toISOString(),
              operation: 'CREATE_LINK_FROM_ALT_RIGHT_CLICK',
              sourceNode: altRightClickStart.id,
              sourceKey: altRightClickStart.key,
              targetNode: target.id,
              targetKey: target.key,
              linkType
            };
            console.log('[ALT_LINK] Creo link', createDebug);
            lastApiDebug = createDebug;
            
            jiraCreateIssueLink(CURRENT_AUTH_TOKEN, altRightClickStart.id, target.id, linkType)
              .then((result) => {
                const successDebug = {
                  timestamp: new Date().toISOString(),
                  operation: 'CREATE_LINK_SUCCESS',
                  sourceNode: altRightClickStart.id,
                  targetNode: target.id,
                  linkType,
                  result
                };
                console.log('[ALT_LINK] Link creato con successo', successDebug);
                lastApiDebug = successDebug;
                
                setStatus(`Creato link ${linkType}: ${altRightClickStart.id} → ${target.id}`);
                links.push({ source: altRightClickStart.id, target: target.id, kind: 'rel', label: linkType });
                renderForceGraph(nodes, links, epicKey, groups);
              })
              .catch((e) => {
                const errorDebug = {
                  timestamp: new Date().toISOString(),
                  operation: 'CREATE_LINK_ERROR',
                  sourceNode: altRightClickStart.id,
                  targetNode: target.id,
                  linkType,
                  error: e.message,
                  stack: e.stack
                };
                console.error('[ALT_LINK] Errore creazione link', errorDebug);
                lastApiDebug = errorDebug;
                setStatus(e.message || String(e), false);
              });
          });
        } else {
          debugInfo.noTarget = true;
          console.log('[ALT_LINK] Nessun target valido', debugInfo);
          lastApiDebug = debugInfo;
          setStatus('Nessun nodo di destinazione selezionato', false);
        }
        
        cleanupAltRightClick();
      };
      
      // Funzione per pulire il laccio
      const cleanupAltRightClick = () => {
        if (altRightClickLasso) {
          altRightClickLasso.remove();
          altRightClickLasso = null;
        }
        if (altRightClickTargetHighlight) {
          altRightClickTargetHighlight.remove();
          altRightClickTargetHighlight = null;
        }
        altRightClickStart = null;
        altRightClickActive = false;
        svg.on('.altrightclick', null);
      };
      
      // Attacca event listeners
      svg.on('mousemove.altrightclick', updateLasso)
         .on('mouseup.altrightclick', completeLink)
         .on('contextmenu.altrightclick', (e) => {
           e.preventDefault();
           cleanupAltRightClick();
         });
      
      // Timeout per cancellare se non viene completato
      setTimeout(() => {
        if (altRightClickActive && altRightClickStart && altRightClickStart.id === d.id) {
          console.log('[ALT_LINK] Timeout, pulizia laccio');
          cleanupAltRightClick();
          setStatus('Timeout: laccio annullato', false);
        }
      }, 10000);
      
    } else {
      // Comportamento normale: mostra menu contestuale
      showNodeContextMenu(
        event,
        d,
        (nodeData) => {
          inspectNodeDetails(nodeData);
        },
        (nodeData) => {
          handleNodeContextMenu(event, nodeData);
        }
      );
    }
  });
```

---

## 7. Modifica endLink per usare menu con ALT+Drag (riga ~4026)

**TROVA la funzione endLink:**

```javascript
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
```

**SOSTITUISCI CON:**

```javascript
  function endLink(event) {
    if (!tempLink || !linkStart) return cleanupTemp();
    const p = d3.pointer(event, stage.node());
    const target = findNodeAt(nodes, p[0], p[1]);
    if (target && target.id !== linkStart.id) {
      // Mostra menu per selezionare il tipo di link
      showLinkTypeMenu(event, linkStart.id, target.id, (linkType) => {
        jiraCreateIssueLink(CURRENT_AUTH_TOKEN, linkStart.id, target.id, linkType)
          .then(() => {
            setStatus(`Creato link ${linkType}: ${linkStart.id} → ${target.id}`);
            links.push({ source: linkStart.id, target: target.id, kind: 'rel', label: linkType });
            renderForceGraph(nodes, links, epicKey, groups);
          })
          .catch(e => setStatus(e.message || String(e), false));
      });
      cleanupTemp();
    } else {
      cleanupTemp();
    }
  }
```

---

## Fine delle modifiche

Dopo aver applicato tutte le modifiche, testa la funzionalità:
1. ALT + tasto destro su un nodo A
2. Trascina il laccio verso un nodo B
3. Rilascia il mouse su B
4. Seleziona il tipo di link dal menu
5. Verifica che il link venga creato

Usa "Copia diagnostica" per vedere tutti i log dettagliati di ogni operazione.


