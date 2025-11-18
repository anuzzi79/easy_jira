# Instructions for EasyJira (Jira Epic Graph)

## Installation
1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `EasyJira` folder

## Credentials Configuration

### Jira
1. Click on the extension icon (letter "J")
2. Click "Settings"
3. In the "Jira Credentials" section:
   - **Email**: your Jira email (e.g. name@company.com)
   - **API Key**: your API key from `id.atlassian.com` → Security → API token
4. Click "Save Jira credentials"

### OpenAI (optional, for advanced AI)
1. In the "OpenAI (Embeddings)" section:
   - **OpenAI API Key**: your OpenAI API key
2. Click "Save key"
3. (Optional) Click "Test OpenAI" to verify it works
4. **Note**: if you don't configure OpenAI, the system will use the Jaccard method as fallback

## Where to Get API Keys

### Jira API Token
1. Go to https://id.atlassian.com
2. Section "Security"
3. Create an "API token"
4. Copy and paste it into the extension

### OpenAI API Key
1. Go to https://platform.openai.com/api-keys
2. Click "Create new secret key"
3. Copy and paste it into the extension

## Usage

### Loading the Graph
1. Click on the extension icon
2. Enter the epic key (e.g. FGC-9540 or just 9540)
3. Click "Open Graph"
4. A new tab will open with the interactive graph

### Graph Navigation
- **Epic** (purple, large): the main epic
- **Story** (blue-cyan): stories linked to the epic
- **Task** (light green): tasks linked to the epic
- **Bug** (red): reported bugs
- **Test** (dark green): linked tests
- **Mobile Task/Bug** (light green/light red with 📱 icon): mobile issues

### Basic Interactions
- **Drag**: move nodes in the graph
- **Hover**: move the mouse to see details (key, summary, type, status, assignee)
- **Click**: open the issue in Jira
- **Alt+Drag**: hold Alt and drag from one node to another to create a "Relates" link in Jira
- **Ctrl+Zoom**: use Ctrl+Mouse wheel to zoom
- **Double click on background**: removes temporary AI links

### Time Inertia: Status Duration Visualization
The new version includes the **Time Inertia** feature that visually shows how long each card has been in its current status.

**How it works**:
- **Time Inertia button**: round blue button in the bottom-left corner of the graph
- **Hover on button**: move the mouse over the button to temporarily activate the visualization
  - Color-coded halos appear around all nodes (0.6 second fade-in)
  - The halo color indicates days since the last status change:
    - **Green**: 0 days (recently changed)
    - **Yellow**: ~5 days
    - **Red**: 10+ days (changed a long time ago)
- **Click on button**: click to keep the visualization active even when you move the mouse away
  - The button starts oscillating between blue and red when active
  - Click again to deactivate (0.6 second fade-out)

**Notes**:
- Cards with status UAT, SKIP UAT, RELEASED, or CANCELLED do not show halos
- The calculation is based on the last status change recorded in Jira's changelog

### AI-Link: Automatic Suggestions
The system can suggest links between BUGs and TASKs using artificial intelligence:

**How to use**:
1. **Right-click** on a BUG node
2. The system will analyze all TASKs in the graph
3. Red dashed lines will appear pointing to the most relevant TASKs
4. On the red lines appears the "AI score" (similarity percentage)

**Viewing explanations**:
1. **Right-click** on an AI red line
2. Select **"Explicação"** to see the detailed explanation with evidence, risks, and impacts

**Analysis methods**:
- **Embeddings (semantic)**: if you have configured OpenAI, uses AI for semantic analysis
- **Jaccard (common terms)**: fallback that counts common words

**SPECs Boost**:
If the epic has links to documentation (SPEC) in the Description, the system:
1. Automatically downloads SPECs from Confluence/Jira pages
2. Uses SPECs as "ground truth" to increase match relevance
3. Shows the status of loaded SPECs in the status bar

### Loading Detailed Fields
When using AI-Link, the system automatically loads **composite fields**:

**For BUGs**:
- Description
- Expected Results
- Steps to Reproduce
- Analysis
- Possible Solutions
- Chosen Solution
- Summary of Changes

**For TASKs**:
- Description
- Possible Solutions
- Chosen Solution
- Summary of Changes

This provides richer context for AI analysis.

### Top Toolbar
- **Settings**: open the configuration page
- **Copy diagnostic**: copy the last API call for debugging
- **View SPECs**: shows the content of loaded SPECs and diagnostic logs
- **Query epic**: performs a complete dump of the epic (fields, names, renderedFields, URL)

## Debug
If the graph doesn't appear or AI doesn't work:
1. Press `F12` to open the browser console
2. Go to the "Console" tab
3. Check error messages
4. Common errors:
   - "Configure email and API key" → go to Settings
   - "Invalid credentials" → verify email and API key
   - "Epic not found" → the epic key might be incorrect
   - "OpenAI Embeddings failed" → verify the OpenAI key or use Jaccard fallback
   - "SPEC: no readable content" → SPEC links might require different permissions

## Technical Notes

### Required Permissions
The extension requires:
- `storage`: to save credentials
- `https://*.atlassian.net/*`: to access Jira and Confluence
- `https://api.openai.com/*`: to call OpenAI APIs

### SPECs Cache
Loaded SPECs are saved in the page cache (`window.EJ_SPECS_CACHE`):
- The cache is cleared when you close/reload the page
- Changing epic resets the cache
- You can force reload using the "View SPECs" button

### Performance
- AI analysis may take a few seconds with many TASKs
- With OpenAI embeddings, each analysis has a minimal API cost
- The system uses batching and retry to handle rate limits
- Texts are truncated to 8000 characters to avoid errors

## Recommended Workflow
1. Load the epic graph
2. Wait for SPECs to load (check the status bar)
3. Right-click on relevant BUGs to see AI suggestions
4. Use "Explicação" for in-depth connection analysis
5. Create Jira links when you're sure of the connection (Alt+Drag)

