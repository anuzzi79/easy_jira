// =============== ai/similarity.js (caricato in graph.html PRIMA di graph.js) ===============

// -- Utility: coseno tra due vettori --
function _cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// -- Tokenizzazione semplice per fallback locale --
function _tokenize(text) {
  return String(text||'')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g,' ')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);
}

// -- Similarità Jaccard (fallback) --
function _jaccard(a, b) {
  const A = new Set(_tokenize(a)), B = new Set(_tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// -- Chiamata Embeddings OpenAI (se disponibile) --
async function _embedOpenAI(apikey, texts) {
  // Modello embedding consigliato; puoi cambiarlo da options in futuro
  const url = 'https://api.openai.com/v1/embeddings';
  const body = { model: 'text-embedding-3-large', input: texts };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apikey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`OpenAI Embeddings error (${res.status}): ${t.slice(0,180)}`);
  }
  const data = await res.json();
  const vectors = (data.data||[]).map(d => d.embedding || []);
  return vectors;
}

/**
 * Calcola similarità tra 1 BUG e N TASK:
 * - Se esiste AI key -> embeddings + coseno
 * - Altrimenti fallback Jaccard
 * @param {string} bugText
 * @param {Array<{id:string,key:string,text:string}>} taskItems
 * @param {string} aiKey
 * @returns {Array<{id,key,score}>} ordinati per score desc
 */
async function computeBugTaskSimilarities(bugText, taskItems, aiKey) {
  if (aiKey) {
    try {
      const inputs = [bugText, ...taskItems.map(t => t.text)];
      const vectors = await _embedOpenAI(aiKey, inputs);
      const bugVec = vectors[0];
      const out = [];
      for (let i = 0; i < taskItems.length; i++) {
        const v = vectors[i+1] || [];
        out.push({ id: taskItems[i].id, key: taskItems[i].key, score: _cosineSim(bugVec, v) });
      }
      out.sort((a,b) => b.score - a.score);
      return out;
    } catch (e) {
      // cade al fallback
      console.warn('AI embedding fallita, uso fallback:', e);
    }
  }
  // Fallback Jaccard
  const out = taskItems.map(t => ({
    id: t.id,
    key: t.key,
    score: _jaccard(bugText, t.text)
  }));
  out.sort((a,b) => b.score - a.score);
  return out;
}

// Espone nel global
window.EJ_AI = { computeBugTaskSimilarities };
