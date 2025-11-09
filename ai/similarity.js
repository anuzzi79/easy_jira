// =============== ai/similarity.js (caricato in graph.html PRIMA di graph.js) ===============
//
// NOVITÀ: se presente window.EJ_SPECS_CACHE[epicKey].text, le specs sono usate come
// "ground-truth" per: (a) potenziare lo score; (b) arricchire la spiegazione PT-BR.
//
// API esposte:
//  - computeBugTaskSimilarities(bugText, taskItems, aiKey, opts?)
//      opts = { epicKey?: string }  // se passato, usa le specs di quell'epico
//  - explainLinkPTBR(bugText, taskText, score, method, reason, opts?)
//    opts può includere: { epicKey, aiKey, sourceKind, targetKind }
//    sourceKind e targetKind supportano: 'bug', 'task', 'story', 'test'
//
// Tutto resta "drop-in" per il resto del codice.

function _cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

  const _STOP = new Set([
    // IT
    'il','lo','la','i','gli','le','un','una','uno','di','a','da','in','con','su','per','tra','fra','che','e','ma','o','non',
    // PT
    'o','a','os','as','um','uma','de','da','do','em','no','na','nos','nas','por','para','que','e','mas','ou','não',
    // EN
    'the','a','an','of','to','in','on','for','with','and','or','but','not','is','are','be','this','that','these','those'
  ]);
  
function _tokenize(text) {
  return String(text||'')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g,' ')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .split(/\s+/)
      .filter(w => w.length >= 3 && !_STOP.has(w));
}

function _jaccard(a, b) {
  const A = new Set(_tokenize(a)), B = new Set(_tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

  // ===== Text helpers =====
  function _splitSentences(t) {
    const s = String(t||'').replace(/\s+/g,' ').trim();
    if (!s) return [];
    return s.split(/(?<=[\.\!\?])\s+(?=[A-ZÀ-Ú])/g)
            .map(x => x.trim()).filter(Boolean);
  }
  
  function _keygrams(text, topN = 12) {
    const toks = _tokenize(text);
    const grams = new Map();
    function push(k){ grams.set(k, (grams.get(k)||0)+1); }
    for (let i=0;i<toks.length;i++){
      push(toks[i]);
      if (i+1<toks.length) push(toks[i]+' '+toks[i+1]);
      if (i+2<toks.length) push(toks[i]+' '+toks[i+1]+' '+toks[i+2]);
    }
    return Array.from(grams.entries()).sort((a,b)=>b[1]-a[1]).slice(0, topN).map(x=>x[0]);
  }
  
  function _levenshtein(a, b) {
    a = (a||'')+''; b = (b||'')+'';
    const m = a.length, n = b.length;
    const dp = Array.from({length:m+1}, ()=>Array(n+1).fill(0));
    for (let i=0;i<=m;i++) dp[i][0]=i;
    for (let j=0;j<=n;j++) dp[0][j]=j;
    for (let i=1;i<=m;i++){
      for (let j=1;j<=n;j++){
        const cost = a[i-1]===b[j-1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
      }
    }
    return dp[m][n];
  }
  
  function _approxEq(a,b,maxDist=2){
    const x = String(a||'').toLowerCase().trim();
    const y = String(b||'').toLowerCase().trim();
    if (!x || !y) return false;
    if (x===y) return true;
    return _levenshtein(x,y) <= maxDist;
  }
  
  function _highlightTerms(sentence, terms){
    let out = String(sentence||'');
    terms.forEach(t=>{
      if (!t) return;
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const re = new RegExp(`\\b(${esc})\\b`, 'gi');
      out = out.replace(re, '“$1”');
    });
    return out;
  }
  
  const ACTION_PATTERNS = [
    /copy(ing)? (a )?project/i, /project copy/i, /entire project/i,
    /not copy (issue )?types?( and categories)?/i,
    /issue (type|types)/i, /issue categor(y|ies)/i, /template/i, /status/i
  ];
  
  function _extractEvidenceSentences(text, hints) {
    const sents = _splitSentences(text);
    const res = [];
    for (const s of sents){
      const hit = hints.some(h => new RegExp(h,'i').test(s));
      if (hit) res.push(s);
    }
    if (!res.length){
      const kg = _keygrams(text, 6);
      for (const s of sents){
        if (kg.some(k => s.toLowerCase().includes(k))) { res.push(s); if (res.length>=2) break; }
      }
    }
    return res.slice(0,3);
  }
  
  function _conceptPresence(bugText, taskText, concepts){
    const bt = (bugText||'').toLowerCase();
    const tt = (taskText||'').toLowerCase();
    const out = [];
    for (const c of concepts){
      const cLow = c.toLowerCase();
      const bHas = bt.includes(cLow) || _approxEq(bt.match(/[a-z]+/g)?.join(' '), cLow);
      const tHas = tt.includes(cLow) || _approxEq(tt.match(/[a-z]+/g)?.join(' '), cLow);
      out.push({concept:c, bug:bHas, task:tHas});
    }
    return out;
  }
  
  function _typoCommissioning(bugText, taskText){
    const words = ['commissioning','comissioning'];
    const all = (bugText+' '+taskText).toLowerCase();
    const seen = words.filter(w => all.includes(w));
    if (seen.length>=1){
      const a = 'commissioning', b = 'comissioning';
      const dist = _levenshtein(a,b);
      return { present:true, dist, forms:seen };
    }
    return { present:false, dist:0, forms:[] };
  }
  
  function _oneLineContextPT(bugText, taskText){
    const hints = ACTION_PATTERNS.map(r=>r.source);
    const b = _extractEvidenceSentences(bugText, hints)[0] || (bugText||'').slice(0,140);
    const t = _extractEvidenceSentences(taskText, hints)[0] || (taskText||'').slice(0,140);
    return { bugLine: b, taskLine: t };
  }
  
  // ===== Embeddings =====
async function _embedOpenAI(apikey, texts) {
  const url = 'https://api.openai.com/v1/embeddings';
    const model = 'text-embedding-3-large';
    const MAX_CHARS = 8000;
    const safeTexts = texts.map(t => String(t || '').slice(0, MAX_CHARS));
    const filtered = safeTexts.filter(t => t.trim().length > 0);
    if (filtered.length === 0) throw new Error('OpenAI Embeddings: nessun testo valido.');
    const BATCH = 32, out = [];
    for (let i = 0; i < filtered.length; i += BATCH) {
      const chunk = filtered.slice(i, i + BATCH);
      let attempt = 0;
      while (true) {
        attempt++;
  const res = await fetch(url, {
    method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apikey}` },
          body: JSON.stringify({ model, input: chunk, encoding_format: 'float' })
  });
        if (res.ok) { const data = await res.json(); out.push(...(data.data||[]).map(d=>d.embedding||[])); break; }
        const body = await res.text().catch(()=>''), status = res.status;
        if (status === 429 && attempt < 4) { const wait = 200*attempt + Math.floor(Math.random()*120); await new Promise(r=>setTimeout(r,wait)); continue; }
        throw new Error(`OpenAI Embeddings failed (${status}): ${body.slice(0,200)}`);
  }
    }
    return out;
  }
  
  // ==== Specs integration (boost) ==============================================
  function _getSpecsTextForEpic(epicKey) {
    try {
      const cache = (window.EJ_SPECS_CACHE && epicKey) ? window.EJ_SPECS_CACHE[epicKey] : null;
      return cache && cache.text ? String(cache.text) : '';
    } catch { return ''; }
  }
  
  function _getSpecsMetaForEpic(epicKey){
    try{
      const c = (window.EJ_SPECS_CACHE && epicKey) ? window.EJ_SPECS_CACHE[epicKey] : null;
      if (!c) return { ok:false, urls:[], success:0, failed:0, ts:null, failures:[] };
      return {
        ok: !!c.ok,
        urls: Array.isArray(c.urls) ? c.urls : [],
        success: Number(c.success||0),
        failed: Number(c.failed||0),
        ts: c.ts || null,
        failures: Array.isArray(c.failures) ? c.failures : []
      };
    }catch{
      return { ok:false, urls:[], success:0, failed:0, ts:null, failures:[] };
    }
  }
  
  function _fmtWhen(ts){
    try{ return ts ? new Date(ts).toLocaleString() : ''; }catch{ return ''; }
  }
  
  // Combina scoreBase con "evidenza specs": media(Jaccard(specs, bug), Jaccard(specs, task))
  // e applica un boost moderato (cap a 0.18)
  function _applySpecsBoost(scoreBase, bugText, taskText, specsText) {
    if (!specsText || !bugText || !taskText) return scoreBase;
    const sBug  = _jaccard(specsText, bugText);
    const sTask = _jaccard(specsText, taskText);
    const rel   = (sBug + sTask) / 2;
    const boost = Math.min(0.18, rel * 0.35); // boost controllato
    return Math.min(0.999, scoreBase + boost);
}

/**
 * Calcola similarità tra 1 BUG e N TASK:
   * - Se c'è AI key → embeddings + coseno
   * - Altrimenti → Jaccard
   * - Se sono disponibili le SPECs dell'epico → boost dello score in base alla coerenza con le specs
 */
  async function computeBugTaskSimilarities(bugText, taskItems, aiKey, opts = {}) {
    const epicKey = opts.epicKey || '';
    const specsText = _getSpecsTextForEpic(epicKey);
  
    let fallbackReason = null;
    const bug = String(bugText || '').trim();
    if (!aiKey) fallbackReason = 'Chave OpenAI ausente/não configurada.';
    if (aiKey && bug.length === 0) fallbackReason = 'Descrição do BUG vazia/indisponível para embeddings.';
  
    if (!fallbackReason) {
      try {
        const prepared = taskItems.map((t, idx) => ({ idx, id:t.id, key:t.key, text:String(t.text||'').trim() }));
        const withText = prepared.filter(x => x.text.length > 0);
        if (withText.length === 0) throw new Error('Nenhum TASK com descrição válida (>0 chars).');
  
        // Embeddings
        const inputs = [bug, ...withText.map(x => x.text)];
      const vectors = await _embedOpenAI(aiKey, inputs);
      const bugVec = vectors[0];
        const raw = taskItems.map((t, i) => {
          const pos = withText.findIndex(x => x.idx === i);
          if (pos === -1) return { id:t.id, key:t.key, score:0, _method:'embeddings' };
          const v = vectors[pos + 1] || [];
          const base = _cosineSim(bugVec, v);
          // boost da specs
          const boosted = _applySpecsBoost(base, bugText, t.text, specsText);
          return { id:t.id, key:t.key, score: boosted, _method:'embeddings' };
        });
        raw.sort((a,b)=>b.score - a.score);
        return raw;
      } catch (e) {
        console.warn('AI embedding falhou, usando fallback:', e);
        fallbackReason = e && e.message ? e.message : 'Erro desconhecido na chamada embeddings';
      }
    }
  
    // Fallback: Jaccard + boost specs
    const out = taskItems.map(t => {
      const base = _jaccard(bugText, t.text);
      const boosted = _applySpecsBoost(base, bugText, t.text, specsText);
      return { id:t.id, key:t.key, score:boosted, _method:'jaccard', _reason:fallbackReason };
    });
    out.sort((a,b)=>b.score - a.score);
      return out;
  }
  
  // ------------------- EXPLICAÇÃO / COMPARAZIONE TRIANGOLARE CON OPENAI -------------------
  async function explainLinkPTBR(bugText, taskText, score, method, reason, opts = {}) {
    const { epicKey = '', aiKey = '', sourceKind = 'bug', targetKind = 'task' } = opts;

    const specsText = _getSpecsTextForEpic(epicKey) || '';
    
    // Helper per label leggibili
    const getLabel = (kind) => {
      if (kind === 'bug') return 'BUG';
      if (kind === 'task') return 'TASK';
      if (kind === 'story') return 'STORY';
      if (kind === 'test') return 'TEST';
      return kind.toUpperCase();
    };
    
    const sourceLabel = getLabel(sourceKind);
    const targetLabel = getLabel(targetKind);

    // Fallback locale (se manca AI key o i testi sono vuoti)
    function localFallback() {
      const simSourceTarget = _jaccard(bugText, taskText);
      const simSourceSpecs = specsText ? _jaccard(bugText, specsText) : 0;
      const simTargetSpecs = specsText ? _jaccard(taskText, specsText) : 0;

      const fmt = v => `${(v * 100).toFixed(1)}%`;
      const livello = v => {
        if (v >= 0.40) return 'alta';
        if (v >= 0.20) return 'media';
        if (v >= 0.10) return 'bassa';
        return 'quasi nulla';
      };

      const hasSpecs = specsText.trim().length > 0;
      const avgTri = hasSpecs
        ? (simSourceTarget + simSourceSpecs + simTargetSpecs) / 3
        : simSourceTarget;

      let conclusione;
      if (avgTri >= 0.40) {
        conclusione = 'I tre elementi risultano fortemente collegati (stesso ambito funzionale).';
      } else if (avgTri >= 0.20) {
        conclusione = 'Collegamento plausibile ma non fortissimo: stesso tema generale, con differenze.';
      } else if (avgTri >= 0.10) {
        conclusione = 'Collegamento debole/parziale: ci sono solo alcuni punti di contatto.';
      } else {
        conclusione = 'Non emergono legami forti tra i tre testi.';
      }

      const rigaSpecs = hasSpecs
        ? [
            `${sourceLabel}–SPECs : ${fmt(simSourceSpecs)} (similarità ${livello(simSourceSpecs)})`,
            `${targetLabel}–SPECs: ${fmt(simTargetSpecs)} (similarità ${livello(simTargetSpecs)})`
          ].join('\n')
        : `Nessun testo SPEC disponibile per questo epic (non posso confrontare ${sourceLabel}/${targetLabel} con le SPECs).`;

      const fallbackLine =
        (method === 'jaccard' && reason)
          ? `\nNota tecnica: è stato usato un fallback lessicale (Jaccard) perché: ${reason}`
          : '';

      return [
        `Triangolo ${sourceLabel}–${targetLabel}–SPEC (fallback locale senza OpenAI chat)`,
        '',
        `${sourceLabel}–${targetLabel} : ${fmt(simSourceTarget)} (similarità ${livello(simSourceTarget)})`,
        rigaSpecs,
        '',
        `Conclusione: ${conclusione}`,
        '',
        `Dettaglio link ${sourceLabel}–${targetLabel}: score AI = ${fmt(score)} (${method === 'embeddings' ? 'embeddings' : 'jaccard'}).${fallbackLine}`
      ].join('\n');
    }

    const apiKey = (aiKey || '').trim();
    const bug = String(bugText || '').trim();
    const task = String(taskText || '').trim();

    // Se non ho chiave o testi minimi → fallback locale
    if (!apiKey || !bug || !task) {
      return localFallback();
    }

    // Taglio i testi per non esplodere il prompt
    const MAX = 6000;
    const specShort = (specsText || '').slice(0, MAX);
    const bugShort = bug.slice(0, MAX);
    const taskShort = task.slice(0, MAX);

    // Helper per costruire il prompt dinamicamente in base ai tipi
    function buildPromptForTypes(sourceKind, targetKind) {
      const combinations = {
        'bug-task': {
          system: `Confronta tre testi: SPEC di business, descrizione BUG e descrizione TASK. Analizza:
1) Se il BUG rispetta/viola le SPEC;
2) Se la TASK è allineata alle SPEC;
3) Se BUG e TASK parlano dello stesso problema.`,
          conclusion: 'fortemente collegati (stesso bug/fix)'
        },
        'bug-story': {
          system: `Confronta tre testi: SPEC di business, descrizione BUG e descrizione STORY. Analizza:
1) Se il BUG impatta funzionalità descritte nella STORY;
2) Se la STORY rispetta le SPEC;
3) Se il BUG blocca o degrada la STORY.`,
          conclusion: 'fortemente collegati (bug impatta story)'
        },
        'bug-test': {
          system: `Confronta tre testi: SPEC di business, descrizione BUG e descrizione TEST. Analizza:
1) Se il TEST rileva il BUG descritto;
2) Se il TEST valida le SPEC;
3) Se BUG e TEST sono correlati nella copertura.`,
          conclusion: 'fortemente collegati (test copre bug)'
        },
        'task-story': {
          system: `Confronta tre testi: SPEC di business, descrizione TASK e descrizione STORY. Analizza:
1) Se la TASK implementa la STORY;
2) Se entrambe rispettano le SPEC;
3) Se la TASK è un subtask della STORY.`,
          conclusion: 'fortemente collegati (task implementa story)'
        },
        'task-test': {
          system: `Confronta tre testi: SPEC di business, descrizione TASK e descrizione TEST. Analizza:
1) Se il TEST valida la TASK implementata;
2) Se entrambe rispettano le SPEC;
3) Se il TEST copre i requisiti della TASK.`,
          conclusion: 'fortemente collegati (test valida task)'
        },
        'story-test': {
          system: `Confronta tre testi: SPEC di business, descrizione STORY e descrizione TEST. Analizza:
1) Se il TEST valida la STORY;
2) Se entrambe rispettano le SPEC;
3) Se il TEST copre i requisiti della STORY.`,
          conclusion: 'fortemente collegati (test valida story)'
        },
        'default': {
          system: `Confronta tre testi: SPEC di business, primo elemento e secondo elemento. Analizza:
1) Come il primo elemento si relaziona alle SPEC;
2) Come il secondo elemento si relaziona alle SPEC;
3) Se i due elementi sono correlati tra loro.`,
          conclusion: 'fortemente collegati (stesso contesto)'
        }
      };
      
      const key = `${sourceKind}-${targetKind}`;
      return combinations[key] || combinations['default'];
    }
    
    const promptConfig = buildPromptForTypes(sourceKind, targetKind);

    try {
      const url = 'https://api.openai.com/v1/chat/completions';
      const model = 'gpt-4o-mini'; // puoi cambiarlo se preferisci un altro modello

      const messages = [
        {
          role: 'system',
          content: [
            promptConfig.system,
            'Devi fare una comparazione TRIANGOLARE molto concisa, in italiano.',
            'Regole:',
            '- non inventare dettagli che non sono nei testi;',
            '- niente papiri: massimo ~10 righe;',
            '- struttura chiara e numerata;',
            `- chiudi con una frase di conclusione secca (es. "${promptConfig.conclusion}", "collegati ma parziali", "quasi indipendenti").`
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'Ecco i tre testi da confrontare.',
            '',
            '=== SPEC (testo caricato da Confluence) ===',
            specShort || '(nessuna SPEC disponibile per questo epic)',
            '',
            `=== ${sourceLabel} (testo composito) ===`,
            bugShort,
            '',
            `=== ${targetLabel} (testo composito) ===`,
            taskShort,
            '',
            `Score semantico ${sourceLabel}–${targetLabel} (0–1): ${score.toFixed(3)} (metodo: ${method})`,
            reason ? `Nota tecnica: ${reason}` : ''
          ].join('\n')
        }
      ];

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 400,
          temperature: 0.2
        })
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn('OpenAI chat completions FALLITA:', res.status, body);
        return localFallback();
      }

      const data = await res.json();
      const choice = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!choice) return localFallback();

      // Torno direttamente il testo generato da OpenAI
      return choice.trim();
    } catch (e) {
      console.warn('OpenAI explainLinkPTBR errore:', e);
      return localFallback();
    }
  }
  
  window.EJ_AI = { computeBugTaskSimilarities, explainLinkPTBR };
