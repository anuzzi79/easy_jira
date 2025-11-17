# Istruzioni per EasyJira (Jira Epic Graph)

## Installazione
1. Apri Chrome → `chrome://extensions`
2. Attiva "Modalità sviluppatore" (Developer mode)
3. Clicca "Carica estensione non pacchettizzata" e seleziona la cartella `EasyJira`

## Configurazione credenziali

### Jira
1. Clicca sull'icona dell'estensione (lettera "J")
2. Clicca "Settings"
3. Nella sezione "Credenziali Jira":
   - **Email**: la tua email Jira (es. nome@azienda.com)
   - **API Key**: la tua API key da `id.atlassian.com` → Security → API token
4. Clicca "Salva credenziali Jira"

### OpenAI (opzionale, per AI avanzata)
1. Nella sezione "OpenAI (Embeddings)":
   - **OpenAI API Key**: la tua chiave API OpenAI
2. Clicca "Salva chiave"
3. (Facoltativo) Clicca "Test OpenAI" per verificare che funzioni
4. **Nota**: se non configuri OpenAI, il sistema userà il metodo Jaccard come fallback

## Dove ottenere le API Key

### Jira API Token
1. Vai su https://id.atlassian.com
2. Sezione "Security"
3. Crea un "API token"
4. Copia e incolla nell'estensione

### OpenAI API Key
1. Vai su https://platform.openai.com/api-keys
2. Clicca "Create new secret key"
3. Copia e incolla nell'estensione

## Utilizzo

### Caricamento del grafico
1. Clicca sull'icona dell'estensione
2. Inserisci la chiave epic (es. FGC-9540 o solo 9540)
3. Clicca "Apri Grafico"
4. Si aprirà una nuova scheda con il grafico interattivo

### Navigazione del grafico
- **Epic** (viola, grande): l'epico principale
- **Story** (blu-cyan): story collegate all'epic
- **Task** (verde chiaro): task collegate all'epic
- **Bug** (rosso): bug segnalati
- **Test** (verde scuro): test collegati
- **Mobile Task/Bug** (verde chiaro/rosso chiaro con icona 📱): issue mobile

### Interazioni base
- **Trascina**: muovi i nodi nel grafico
- **Hover**: passa il mouse per vedere i dettagli (chiave, summary, tipo, status, assignee)
- **Click**: apri la issue in Jira
- **Alt+Drag**: tieni premuto Alt e trascina da un nodo all'altro per creare un link "Relates" in Jira
- **Ctrl+Zoom**: usa Ctrl+Rotella del mouse per zoomare
- **Doppio click sul background**: rimuove i link AI temporanei

### AI-Link: suggerimenti automatici
Il sistema può suggerire collegamenti tra BUG e TASK usando l'intelligenza artificiale:

**Come usare**:
1. Fai **clic destro** su un nodo BUG
2. Il sistema analizzerà tutte le TASK nel grafico
3. Appariranno linee rosse tratteggiate verso le TASK più rilevanti
4. Sulle linee rosse appare il "AI score" (percentuale di somiglianza)

**Visualizzazione delle spiegazioni**:
1. Fai **clic destro** su una linea rossa AI
2. Seleziona **"Explicação"** per vedere la spiegazione dettagliata con evidenze, rischi e impatti

**Metodi di analisi**:
- **Embeddings (semântico)**: se hai configurato OpenAI, usa l'IA per l'analisi semantica
- **Jaccard (termi in comune)**: fallback che conta le parole in comune

**Boost SPECs**:
Se l'epico ha link a documentazioni (SPEC) nella Description, il sistema:
1. Scarica automaticamente le SPEC dalle pagine Confluence/Jira
2. Usa le SPEC come "ground truth" per aumentare la rilevanza dei match
3. Mostra lo stato delle SPEC caricate nella barra di stato

### Caricamento campi dettagliati
Quando usi l'AI-Link, il sistema carica automaticamente **campi compositi**:

**Per i BUG**:
- Description
- Expected Results
- Steps to Reproduce
- Analysis
- Possible Solutions
- Chosen Solution
- Summary of Changes

**Per le TASK**:
- Description
- Possible Solutions
- Chosen Solution
- Summary of Changes

Questo fornisce un contesto più ricco per l'analisi AI.

### Toolbar superiore
- **Settings**: apri la pagina di configurazione
- **Copia diagnostica**: copia l'ultima chiamata API per il debug
- **Ver SPECs**: mostra il contenuto delle SPEC caricate e i log diagnostici
- **Interroga épico**: esegue un dump completo dell'epico (campi, nomi, renderedFields, URL)

## Debug
Se il grafico non appare o l'AI non funziona:
1. Premi `F12` per aprire la console del browser
2. Vai alla tab "Console"
3. Controlla i messaggi di errore
4. Errori comuni:
   - "Configura email e API key" → vai in Settings
   - "Credenziali non valide" → verifica email e API key
   - "Epic non trovato" → la chiave epic potrebbe essere errata
   - "OpenAI Embeddings failed" → verifica la chiave OpenAI o usa il fallback Jaccard
   - "SPEC: nessun contenuto leggibile" → i link SPEC potrebbero richiedere permessi diversi

## Note tecniche

### Permessi necessari
L'estensione richiede:
- `storage`: per salvare le credenziali
- `https://*.atlassian.net/*`: per accedere a Jira e Confluence
- `https://api.openai.com/*`: per chiamare le API OpenAI

### Cache SPECs
Le SPEC caricate vengono salvate nella cache della pagina (`window.EJ_SPECS_CACHE`):
- La cache si svuota quando chiudi/ricarichi la pagina
- Cambiando epic, la cache viene resettata
- Puoi forzare il ricaricamento usando il bottone "Ver SPECs"

### Performance
- L'analisi AI può richiedere alcuni secondi con molte TASK
- Con OpenAI embeddings, ogni analisi ha un costo API minimo
- Il sistema usa batching e retry per gestire rate limits
- I testi vengono troncati a 8000 caratteri per evitare errori

## Flusso di lavoro consigliato
1. Carica il grafico dell'epico
2. Aspetta che le SPEC vengano caricate (controlla la barra di stato)
3. Clicca destro sui BUG rilevanti per vedere i suggerimenti AI
4. Usa "Explicação" per analisi approfondite delle connessioni
5. Crea i link Jira quando sei sicuro della connessione (Alt+Drag)

