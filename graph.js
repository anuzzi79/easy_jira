let JIRA_BASE = 'https://facilitygrid.atlassian.net';
let CURRENT_AUTH_TOKEN = null; // usato per operazioni interattive (crea issue link)

const epicSelect = document.getElementById('epicSelect');
const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');
const svg = d3.select('#canvas');
let lastApiDebug = null;

let width, height, simulation, tooltip;

function normalizeStatusName(s) { return String(s || '').trim().toUpperCase(); }

function getCategoryFromIssueType(issuetypeName) {
  const n = String(issuetypeName || '').toLowerCase();
  if (n.includes('epic')) return 'epic';
  if (n.includes('story')) return 'story';
  if (n === 'task' || n.includes(' task')) return 'task';
  if (n === 'bug' || n.includes('bug')) return 'bug'; // nuovo mapping per bug
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
    const txt = await res.text().catch(()=>'');
    throw new Error(`Link Jira fallito (${res.status}): ${txt.slice(0,180)}`);
  }
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
    // data is array of objects with { key, status, ... }
    return Array.isArray(data) ? data.map(t => String(t.key)) : [];
  } catch { return []; }
}

// Ritorna l'elenco degli Epic della sprint attiva del board principale
async function fetchActiveSprintEpics(token) {
  // 1) Individua l'id del campo "Epic Link"
  let epicLinkFieldId = null;
  try {
    const res = await fetch(`${JIRA_BASE}/rest/api/3/field`, { headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' } });
    if (res.ok) {
      const fields = await res.json();
      const epicField = fields.find(f => String(f.name).toLowerCase() === 'epic link');
      if (epicField) epicLinkFieldId = epicField.id; // es. customfield_10014
    }
  } catch {}

  // 2) Prendi tutte le issue (non-epic) delle sprint aperte
  const childIssues = await jiraSearch(token, `sprint in openSprints() AND issuetype != Epic`, ['summary','issuetype','parent', ...(epicLinkFieldId ? [epicLinkFieldId] : [])]).catch(() => []);

  // 3) Estrai le chiavi degli Epic dai figli
  const epicKeys = new Set();
  for (const it of childIssues) {
    let key = null;
    if (epicLinkFieldId && it.fields && it.fields[epicLinkFieldId]) {
      const v = it.fields[epicLinkFieldId];
      key = typeof v === 'string' ? v : (v?.key || null);
    }
    if (!key && it.fields?.parent?.key) {
      key = it.fields.parent.key; // Team-managed: epic come parent
    }
    if (key) epicKeys.add(key);
  }

  if (epicKeys.size === 0) return [];

  // 4) Recupera i dettagli degli Epic trovati
  const keyList = Array.from(epicKeys);
  const chunks = [];
  for (let i = 0; i < keyList.length; i += 50) chunks.push(keyList.slice(i, i + 50));
  const out = [];
  for (const ch of chunks) {
    const jql = `key in (${ch.join(',')}) AND issuetype = Epic`;
    const ep = await jiraSearch(token, jql, ['summary','issuetype']).catch(() => []);
    ep.forEach(e => out.push({ key: e.key, summary: e.fields.summary }));
  }
  // Ordina per key
  out.sort((a,b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Jira Cloud v3 (nuovi endpoint): POST /rest/api/3/search/jql
 * Pagination: nextPageToken (NON più startAt/maxResults tradizionale).
 * Doc ufficiale: /rest/api/3/search/jql (GET/POST) con { jql, fields, maxResults, nextPageToken }. 
 */
async function jiraSearch(token, jql, fields = ['summary','issuetype','parent','subtasks','issuelinks','status','assignee']) {
  const results = [];
  let nextPageToken = undefined;      // primo giro: assente
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

    // salva diagnostica
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
    const payload = {
      jql,
      fields,
      maxResults,
      ...(nextPageToken ? { nextPageToken } : {})
      // opzionali: expand, properties, fieldsByKeys, reconcileIssues
    };

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

    // nuova paginazione: se c'è nextPageToken, continua
    nextPageToken = data.nextPageToken;
    if (!nextPageToken || issuesPage.length === 0) break;
  }

  return results;
}

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
    setStatus(`Recupero dati per ${epicKey}…`);

    // 1) Epico
    setStatus('Cercando epic…');
    const epicIssue = await jiraSearch(token, `issuekey=${epicKey}`);
    if (!epicIssue.length) throw new Error(`Epico ${epicKey} non trovato.`);

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
    const hierLinks = [];   // gerarchici (epic->child, parent->subtask)
    const relLinks = [];    // relazioni issue-link tra card dello stesso epic
    const execLinks = [];   // collegamenti TestExecution -> Test (da summary)
    const pairSet = new Set(); // per eliminare duplicati direzionali A<->B

    // Epic -> figli top-level (tutti, etichettando la categoria del figlio)
    [...linkedIssues, ...parentIssues].forEach(child => {
      const childCat = nodeByKey.get(child.key)?.category;
      const linkKey = `${epicKey}->${child.key}`;
      if (!linkSet.has(linkKey)) {
        hierLinks.push({ source: epicKey, target: child.key, kind: 'hier', childCat: childCat });
        linkSet.add(linkKey);
      }
    });

    // Parent -> subtask
    [...linkedIssues, ...parentIssues, ...allSubtasks].forEach(issue => {
      if (issue.fields.parent?.key) {
        const pKey = issue.fields.parent.key;
        const linkKey = `${pKey}->${issue.key}`;
        if (nodeByKey.has(pKey) && !linkSet.has(linkKey)) {
          const childCat = nodeByKey.get(issue.key)?.category;
          // se parent è epic, annota la categoria del figlio per layout
          const parentCat = nodeByKey.get(pKey)?.category;
          const childMeta = parentCat === 'epic' ? { childCat } : {};
          hierLinks.push({ source: pKey, target: issue.key, kind: 'hier', ...childMeta });
          linkSet.add(linkKey);
        }
      }
    });

    // Issue links (relazioni) tra card del set (includi tutte le relazioni interne all'epico)
    const issueByKey = new Map(issues.map(i => [i.key, i]));
    issueByKey.forEach((src) => {
      const linksArr = src.fields.issuelinks || [];
      linksArr.forEach(l => {
        const linked = l.outwardIssue || l.inwardIssue;
        if (!linked) return;
        const a = src.key;
        const b = linked.key;
        if (!issueByKey.has(b)) return; // collega solo se l'altro nodo è nel grafo
        const undirected = a < b ? `${a}--${b}` : `${b}--${a}`;
        if (!pairSet.has(undirected)) {
          const srcCat = nodeByKey.get(a)?.category;
          const dstCat = nodeByKey.get(b)?.category;
          // Non creare alcun collegamento tra Test Execution ed Epic
          if ((srcCat === 'test_execution' && dstCat === 'epic') ||
              (dstCat === 'test_execution' && srcCat === 'epic')) {
            return;
          }
          relLinks.push({ source: a, target: b, kind: 'rel', label: l.type?.name || '' });
          pairSet.add(undirected);
        }
      });
    });

    // Collegamenti forti TestExecution -> Test (estraendo la key dal summary)
    const testExecIssues = issues.filter(i => /test execution/i.test(i.fields.issuetype?.name || ''));
    const keyRegex = /[A-Z][A-Z0-9]+-\d+/; // es. FGC-9515
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

    // Filtro finale: rimuovi ogni collegamento tra Test Execution ed Epic
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

function renderForceGraph(nodes, links, epicKey, groups = { hierLinks: [], relLinks: [] }) {
  svg.selectAll('*').remove();

  const rect = svg.node().getBoundingClientRect();
  width = rect.width || window.innerWidth;
  height = rect.height || (window.innerHeight - 56);
  svg.attr('width', width).attr('height', height);
  const stage = svg.append('g').attr('class', 'stage');

  const colorByCategory = (c) => {
    if (c === 'epic') return '#8b5cf6';
    if (c === 'story') return '#3b82f6';
    if (c === 'task' || c === 'mobile_task' || c === 'test_execution') return '#86efac';
    if (c === 'test') return '#166534';
    if (c === 'mobile_bug') return '#fecaca'; // rosso annacquato
    if (c === 'bug') return '#ef4444';       // rosso standard
    return '#94a3b8';
  };

  // Nessun marker freccia: vogliamo linee semplici
  const defs = svg.append('defs');

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
        if (sid === epicKey || tid === epicKey) return 0.1; // 85% trasparenza (poco visibili)
        return 0.8;
      })
      // niente freccia in coda
      ;

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

  // Interazione: ALT + mousedown per iniziare il "laccio" e collegare due card
  let tempLink = null;
  let linkStart = null;

  function startLink(event, d) {
    if (!event.altKey) return; // attiva solo con ALT premuto
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
    // Trova un nodo vicino al punto di rilascio
    const target = findNodeAt(nodes, p[0], p[1]);
    if (target && target.id !== linkStart.id) {
      // crea link su Jira
      jiraCreateIssueLink(CURRENT_AUTH_TOKEN, linkStart.id, target.id)
        .then(() => {
          setStatus(`Creato link: ${linkStart.id} → ${target.id}`);
          // aggiorna grafo in memoria
          links.push({ source: linkStart.id, target: target.id, kind: 'rel' });
          renderForceGraph(nodes, links, epicKey, groups); // ridisegna
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

  // registra la partenza del laccio con ALT+mousedown
  node.on('mousedown', startLink);
  // Se mentre trascini il laccio premi ALT, continui a muovere il laccio; se rilasci ALT, il drag torna attivo grazie al filtro del d3.drag()

  // Disegna i simboli per ciascun nodo
  node.each(function(d) {
    const g = d3.select(this);
    const R = d.id === epicKey ? 10 : 7;

    // Base circle
    g.append('circle')
      .attr('r', R)
      .attr('fill', colorByCategory(d.category))
    .attr('stroke', '#fff')
      .attr('stroke-width', 1.25);

    // Overlay per tipo
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

    node
      .attr('transform', d => `translate(${d.x},${d.y})`);

    label
      .attr('x', d => d.x)
      .attr('y', d => d.y - (d.id === epicKey ? 10 : 7));
  });

  window.addEventListener('resize', () => {
    const r = svg.node().getBoundingClientRect();
    svg.attr('width', r.width).attr('height', r.height);
    simulation.force('center', d3.forceCenter(r.width / 2, r.height / 2)).alpha(0.2).restart();
  });

  // Zoom/pan solo sulla tela: Ctrl+wheel per zoom, pan con middle-button
  const zoom = d3.zoom()
    .filter(ev => (ev.type === 'wheel' && ev.ctrlKey) || (ev.type === 'mousedown' && (ev.button === 1 || ev.buttons === 4)))
    .scaleExtent([0.2, 5])
    .wheelDelta((ev) => ev.deltaY * -0.004) // sensibilità 5x più fine dell'attuale
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
  // Disabilita il drag quando è premuto ALT (per usare la creazione del laccio)
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

// UI wiring
(async () => {
  const params = new URLSearchParams(location.search);
  const epicParam = params.get('epic');

  // Caricamento automatico alla selezione dalla tendina
  epicSelect.addEventListener('change', () => {
    const opt = epicSelect.value;
    if (!opt) return;
    loadGraph(opt);
  });

  // Popola select con gli epici della sprint attiva
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
})();
