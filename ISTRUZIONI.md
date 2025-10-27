# Istruzioni per EasyJira (Jira Epic Graph)

## Installazione
1. Apri Chrome → `chrome://extensions`
2. Attiva "Modalità sviluppatore" (Developer mode)
3. Clicca "Carica estensione non pacchettizzata" e seleziona la cartella `EasyJira`

## Configurazione credenziali
1. Clicca sull'icona dell'estensione (lettera "J")
2. Clicca "Settings"
3. Inserisci:
   - **Email**: la tua email Jira (es. nome@azienda.com)
   - **API Key**: la tua API key da `id.atlassian.com` → Security → API token
4. Clicca "Salva"

## Utilizzo
1. Clicca sull'icona dell'estensione
2. Inserisci la chiave epic (es. FGC-9540 o solo 9540)
3. Clicca "Apri Grafico"
4. Si aprirà una nuova scheda con il grafico interattivo

## Dove ottenere l'API Key
1. Vai su https://id.atlassian.com
2. Sezione "Security"
3. Crea un "API token"
4. Copia e incolla nell'estensione

## Debug
Se il grafico non appare:
1. Premi `F12` per aprire la console del browser
2. Vai alla tab "Console"
3. Controlla i messaggi di errore
4. Errori comuni:
   - "Configura email e API key" → vai in Settings
   - "Credenziali non valide" → verifica email e API key
   - "Epic non trovato" → la chiave epic potrebbe essere errata

## Caratteristiche del grafico
- **Epic** (viola, grande): l'epico principale
- **Issue** (blu-cyan): story/task collegate all'epic
- **Subtask** (verde): sottotask degli issue
- **Interazioni**:
  - Trascina i nodi per muoverli
  - Passa il mouse per vedere i dettagli
  - Doppio clic per aprire la issue in Jira

