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
  
// Calcola quanto i singoli testi ripetono il contenuto delle SPEC (contesto) e applica una lieve penalizzazione
// in modo che il punteggio finale rifletta soprattutto la specificità nodo↔nodo.
function _applySpecsContext(scoreBase, bugText, taskText, specsText) {
  const safeScore = Math.max(0, Math.min(0.999, Number(scoreBase) || 0));
  if (!specsText || !bugText || !taskText) {
    return {
      score: safeScore,
      specSource: 0,
      specTarget: 0
    };
  }

  const specSource = _jaccard(bugText, specsText);
  const specTarget = _jaccard(taskText, specsText);

  const contextPenalty = Math.min(0.25, Math.max(specSource, specTarget) * 0.3);
  const adjusted = Math.max(0, safeScore - contextPenalty);

  return {
    score: adjusted,
    specSource,
    specTarget
  };
}

function _sharedSpecificityBoost(sourceText, targetText) {
  try {
    const tokensA = _tokenize(sourceText).filter(w => w.length > 3);
    const tokensB = _tokenize(targetText).filter(w => w.length > 3);
    if (tokensA.length < 4 || tokensB.length < 4) {
      return { boost: 0, sharedBigrams: 0 };
    }

    const bigramsA = new Set();
    for (let i = 0; i < tokensA.length - 1; i++) {
      const bg = `${tokensA[i]} ${tokensA[i + 1]}`;
      if (bg.length >= 7) bigramsA.add(bg);
    }
    if (!bigramsA.size) return { boost: 0, sharedBigrams: 0 };

    let shared = 0;
    const counted = new Set();
    for (let i = 0; i < tokensB.length - 1; i++) {
      const bg = `${tokensB[i]} ${tokensB[i + 1]}`;
      if (bg.length < 7) continue;
      if (bigramsA.has(bg) && !counted.has(bg)) {
        counted.add(bg);
        shared++;
      }
    }
    if (!shared) return { boost: 0, sharedBigrams: 0 };

    const boost = Math.min(0.2, shared * 0.045);
    return { boost, sharedBigrams: shared };
  } catch {
    return { boost: 0, sharedBigrams: 0 };
  }
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
          const ctx = _applySpecsContext(base, bugText, t.text, specsText);
          const specificity = _sharedSpecificityBoost(bugText, t.text);
          const finalScore = Math.min(0.999, ctx.score + specificity.boost);
          return {
            id: t.id,
            key: t.key,
            score: finalScore,
            _method: 'embeddings',
            _specContext: {
              source: ctx.specSource,
              target: ctx.specTarget
            },
            _specificity: {
              sharedBigrams: specificity.sharedBigrams,
              boost: specificity.boost
            }
          };
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
      const ctx = _applySpecsContext(base, bugText, t.text, specsText);
      const specificity = _sharedSpecificityBoost(bugText, t.text);
      const finalScore = Math.min(0.999, ctx.score + specificity.boost);
      return {
        id: t.id,
        key: t.key,
        score: finalScore,
        _method: 'jaccard',
        _reason: fallbackReason,
        _specContext: {
          source: ctx.specSource,
          target: ctx.specTarget
        },
        _specificity: {
          sharedBigrams: specificity.sharedBigrams,
          boost: specificity.boost
        }
      };
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
      const specSource = specsText ? _jaccard(bugText, specsText) : 0;
      const specTarget = specsText ? _jaccard(taskText, specsText) : 0;
      const ctx = _applySpecsContext(simSourceTarget, bugText, taskText, specsText);
      const specificity = _sharedSpecificityBoost(bugText, taskText);
      const adjusted = Math.max(0, ctx.score);
      const boosted = Math.min(0.999, adjusted + specificity.boost);

      const fmt = v => `${(v * 100).toFixed(1)}%`;
      const livello = v => {
        if (v >= 0.45) return 'muito alta';
        if (v >= 0.25) return 'média';
        if (v >= 0.12) return 'baixa';
        return 'quase nula';
      };

      let conclusione;
      if (boosted >= 0.45) {
        conclusione = 'Os dois elementos compartilham pontos específicos muito parecidos.';
      } else if (boosted >= 0.25) {
        conclusione = 'Semelhança parcial: algumas especificidades coincidem, outras divergem.';
      } else if (boosted >= 0.12) {
        conclusione = 'Conexão fraca: poucas especificidades em comum.';
      } else {
        conclusione = 'Especificidades praticamente independentes.';
      }

      const rigaSpecs = specsText.trim().length
        ? [
            `Contexto vs ${sourceLabel}: ${fmt(specSource)} (apenas pano de fundo)`,
            `Contexto vs ${targetLabel}: ${fmt(specTarget)}`
          ].join('\n')
        : 'Nenhum texto de SPEC disponível para contextualizar.';

      const fallbackLine =
        (method === 'jaccard' && reason)
          ? `\nNota técnica: foi usado fallback lexical (Jaccard) porque: ${reason}`
          : '';

      return [
        `${sourceLabel} ↔ ${targetLabel} (fallback local sem OpenAI)`,
        '',
        `Similaridade específica ${sourceLabel}–${targetLabel}: ${fmt(boosted)} (nível ${livello(boosted)})`,
        rigaSpecs,
        '',
        `Conclusão: ${conclusione}`,
        '',
        `Score estimado = ${fmt(score)} (${method === 'embeddings' ? 'embeddings' : 'jaccard'}).${fallbackLine}`
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
          system: `Você tem três textos: SPEC de negócio (contexto), descrição do BUG e descrição da TASK.
Objetivo: avaliar se BUG e TASK tratam do mesmo problema concreto.
Passos:
1) Resuma a especificidade do BUG (sintomas, causas, impactos).
2) Resuma a especificidade da TASK (ações, soluções, entregas).
3) Compare sobreposições e diferenças; cite as SPEC apenas como contexto quando necessário.`,
          conclusion: 'fortemente conectados (mesmo bug/fix)'
        },
        'bug-story': {
          system: `Você tem três textos: SPEC de negócio (contexto), descrição do BUG e descrição da STORY.
Objetivo: verificar se o BUG interfere na funcionalidade descrita na STORY.
Passos:
1) Destaque os pontos específicos do BUG (gatilhos, área impactada).
2) Resuma os comportamentos/resultados esperados da STORY.
3) Avalie interseções e diferenças específicas; use as SPEC somente como apoio contextual.`,
          conclusion: 'fortemente conectados (bug impacta story)'
        },
        'bug-test': {
          system: `Você tem três textos: SPEC de negócio (contexto), descrição do BUG e descrição do TEST.
Objetivo: entender se o TEST cobre o cenário específico do BUG.
Passos:
1) Evidencie os detalhes do BUG (como reproduzir, erros observados).
2) Evidencie os passos/assertivas específicas do TEST.
3) Compare as partes que se alinham ou divergem, citando as SPEC apenas como pano de fundo.`,
          conclusion: 'fortemente conectados (test cobre bug)'
        },
        'task-story': {
          system: `Você tem três textos: SPEC de negócio (contexto), descrição da TASK e descrição da STORY.
Objetivo: avaliar se a TASK concretiza a STORY.
Passos:
1) Resuma atividades e entregas específicas da TASK.
2) Resuma os comportamentos/resultados específicos da STORY.
3) Compare as especificidades, recorrendo às SPEC apenas para clarificar o contexto.`,
          conclusion: 'fortemente conectados (task implementa story)'
        },
        'task-test': {
          system: `Você tem três textos: SPEC de negócio (contexto), descrição da TASK e descrição do TEST.
Objetivo: confirmar se o TEST valida a TASK.
Passos:
1) Destaque o que a TASK realiza (etapas, soluções, outputs).
2) Destaque o que o TEST verifica (passos, resultados esperados).
3) Compare os elementos específicos que coincidem ou divergem; cite as SPEC somente como suporte.`,
          conclusion: 'fortemente conectados (test valida task)'
        },
        'story-test': {
          system: `Você tem três textos: SPEC de negócio (contexto), descrição da STORY e descrição do TEST.
Objetivo: checar se o TEST realmente valida a STORY.
Passos:
1) Resuma a STORY com foco nos resultados específicos.
2) Resuma o TEST enfatizando as verificações pontuais.
3) Compare as especificidades e use as SPEC apenas como base contextual.`,
          conclusion: 'fortemente conectados (test valida story)'
        },
        'default': {
          system: `Você tem três textos: SPEC de negócio (contexto), primeiro elemento e segundo elemento.
Objetivo: comparar as especificidades dos dois elementos dentro do mesmo contexto.
Passos:
1) Destaque as particularidades do primeiro elemento.
2) Destaque as particularidades do segundo elemento.
3) Compare convergências e divergências específicas; convide as SPEC somente quando necessário para enquadrar o cenário.`,
          conclusion: 'fortemente conectados (mesmo contexto)'
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
            'Você deve fazer uma comparação concisa, em português.',
            'Regras:',
            '- não invente detalhes que não estejam nos textos;',
            '- máximo de ~10 linhas para todo o resultado;',
            '- organize o texto em tópicos numerados (1. especificidades do primeiro elemento, 2. especificidades do segundo, 3. comparação direta);',
            '- use as SPEC apenas como contexto de apoio, não como argumento principal;',
            `- encerre com uma frase curta de conclusão (ex.: "${promptConfig.conclusion}", "parcialmente conectados", "quase independentes").`
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            'Aqui estão os três textos para comparar.',
            '',
            '=== SPEC (contexto de referência, cite apenas se necessário) ===',
            specShort || '(nessuna SPEC disponibile per questo epic)',
            '',
            `=== ${sourceLabel} (concentre a análise nas suas especificidades) ===`,
            bugShort,
            '',
            `=== ${targetLabel} (concentre a análise nas suas especificidades) ===`,
            taskShort,
            '',
            `Score semântico ${sourceLabel}–${targetLabel} (0–1): ${score.toFixed(3)} (método: ${method})`,
            reason ? `Nota técnica: ${reason}` : ''
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
