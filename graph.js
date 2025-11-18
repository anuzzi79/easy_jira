let JIRA_BASE = 'https://facilitygrid.atlassian.net';
let CURRENT_AUTH_TOKEN = null; // usato per operazioni interattive (crea issue link)
let CURRENT_EPIC_KEY = null;  // epico attualmente caricato

let epicSelect = document.getElementById('epicSelect');
const runBtn = document.getElementById('run'); // legacy (può essere nullo)
const headerEl = document.querySelector('.header');
const statusEl = document.getElementById('status');
const viewSpecsBtn = document.getElementById('viewSpecs');
const svg = d3.select('#canvas');
let lastApiDebug = null;

// Sistema di logging per il bootstrap (traccia ogni passo del primo caricamento)
window.EJ_BOOT_LOG = [];
function logBootStep(step, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    step,
    details,
    stack: new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' | ') || 'N/A'
  };
  window.EJ_BOOT_LOG.push(entry);
  console.log(`[BOOT] ${step}`, details);
}

// Buffer diagnostico SPECs (mostrato nel popup e copiabile)
let specsDiag = [];
let nodeContextMenuEl = null;
let inspectBackdrop = null;
let inspectModal = null;
let inspectContentEl = null;
let inspectCopyBtn = null;
let similarityControlEl = null;
let similaritySliderEl = null;
let similarityValueEl = null;
const DEFAULT_MIN_SCORE = 10;
let displayThreshold = DEFAULT_MIN_SCORE;
window.EJ_DISPLAY_THRESHOLD = displayThreshold;

const STATUS_SEQUENCE = [
  'TO DO',
  'NEED REQS',
  'BLOCKED',
  'IN PROGRESS',
  'CODE REVIEW',
  'TESTING',
  'QA',
  'DONE',
  'REGRESSION TEST',
  'UAT',
  'SKIP UAT',
  'RELEASE CANDIDATE',
  'RELEASED',
  'CANCELED'
];

const STATUS_LABEL_MAP = {
  'TO DO': 'To Do',
  'NEED REQS': 'Need Reqs',
  'BLOCKED': 'Blocked',
  'IN PROGRESS': 'In Progress',
  'CODE REVIEW': 'Code Review',
  'TESTING': 'Testing',
  'QA': 'QA',
  'DONE': 'Done',
  'REGRESSION TEST': 'Regression Test',
  'UAT': 'UAT',
  'SKIP UAT': 'Skip UAT',
  'RELEASE CANDIDATE': 'Release Candidate',
  'RELEASED': 'Released',
  'CANCELED': 'Canceled'
};
const STATUS_SPECIAL_OPTIONS = [
  { key: '__ALL__', label: 'All' },
  { key: '__NONE__', label: 'None' }
];
const NO_EPIC_OPTION = '__NO_EPIC__';
const MINOR_FIXES_OPTION = '__MINOR_FIXES__';
const SPECIFIC_EPIC_OPTION = '__SPECIFIC_EPIC__';
let activeStatusFilters = new Set(STATUS_SEQUENCE);
let statusCursorStart = null;
let statusCursorEnd = null;
let cursorAdjusting = false;
let curtainStatusSet = new Set();
const ASSIGNEE_UNASSIGNED = '__UNASSIGNED__';
let activeAssigneeFilters = null;
const ISSUE_TYPE_ALL = '__ALL_TYPES__';
let activeTypeFilters = null;
let windowHandleEl = null;
let windowDragState = null;
let hoveredStatusKey = null;
let hoveredAssigneeKey = null;
let hoveredTypeKey = null;
const currentGraphState = {
  nodeSelection: null,
  labelSelection: null,
  linkSelection: null,
  nodesByKey: new Map(),
  aiLayer: null,
  nodes: [],
  links: [],
  assignees: []
};

// Helper: accoda e mostra stato
function logSpec(phase, msg, ok = true) {
  const line = `[SPEC][${phase}] ${msg}`;
  specsDiag.push(line);
  setStatus(line, ok);
}

let width, height, simulation, tooltip;

class StatusCursor {
  constructor({ list, line, handle, curtain, mode = 'from', onMove }) {
    this.list = list;
    this.line = line;
    this.handle = handle;
    this.curtain = curtain;
    this.mode = mode;
    this.onMove = onMove;
    this.items = [];
    this.metrics = [];
    this.position = null;
    this._mounted = false;
    this.minLimit = null;
    this.maxLimit = null;
    this.limitStrategy = null;
    this.originTop = null;
    this.originBottom = null;
  }

  mount() {
    if (this._mounted) return;
    if (!this.list || !this.line || !this.handle) return;
    this._mounted = true;
    this._bindHandlers();
    this.refresh();
    this.handle.addEventListener('pointerdown', this._onPointerDown);
    this.handle.addEventListener('keydown', this._onKeyDown);
    if (this._scrollContainer) {
      this._scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });
    }
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    if (!this._mounted) return;
    this._mounted = false;
    this.handle.removeEventListener('pointerdown', this._onPointerDown);
    this.handle.removeEventListener('keydown', this._onKeyDown);
    if (this._scrollContainer) {
      this._scrollContainer.removeEventListener('scroll', this._onScroll);
    }
    window.removeEventListener('resize', this._onResize);
  }

  refresh() {
    if (!this.list) return;
    this._cacheItems();
    this._measure();
    if (!this.metrics.length) return;
    if (this.limitStrategy) {
      const limits = this.limitStrategy(this.metrics) || {};
      this.minLimit = Number.isFinite(limits.min) ? limits.min : null;
      this.maxLimit = Number.isFinite(limits.max) ? limits.max : null;
    }
    if (this.minLimit != null) this.originTop = this.minLimit;
    if (this.maxLimit != null) this.originBottom = this.maxLimit;
    if (this.position == null) {
      this.position = this.metrics[0].center;
    }
    this.position = this._clampPosition(this.position);
    this._apply();
  }

  setPositionFromIndex(idx) {
    if (!this.metrics.length) return;
    const clamped = Math.max(0, Math.min(idx, this.metrics.length - 1));
    this.position = this.metrics[clamped].center;
    this._apply();
  }

  setPosition(y) {
    if (!this.metrics.length) return;
    this.position = this._clampPosition(y);
    this._apply();
    return this.position;
  }

  setLimits(min, max) {
    this.minLimit = Number.isFinite(min) ? min : null;
    this.maxLimit = Number.isFinite(max) ? max : null;
    if (this.position != null) {
      this.position = this._clampPosition(this.position);
      this._apply();
    }
  }

  setLimitStrategy(strategy) {
    this.limitStrategy = typeof strategy === 'function' ? strategy : null;
    if (this._mounted) {
      this.refresh();
    }
  }

  getPosition() {
    return this.position;
  }

  getMetric(index) {
    if (index < 0 || index >= this.metrics.length) return null;
    return this.metrics[index];
  }

  _bindHandlers() {
    this._scrollContainer = this.list.closest('.filters-content') || this.list;
    this._onScroll = () => this.refresh();
    this._onResize = () => this.refresh();
    this._onPointerDown = event => this._handlePointerDown(event);
    this._onKeyDown = event => this._handleKeyDown(event);
  }

  _cacheItems() {
    this.items = Array.from(this.list.querySelectorAll('.filter-option'));
  }

  _measure() {
    const scroll = this.list.scrollTop;
    this.metrics = this.items.map(el => {
      const top = el.offsetTop - scroll;
      const height = el.offsetHeight;
      return { top, height, center: top + height / 2 };
    });
  }

  _apply() {
    if (this.position == null) return;
    if (this.line) this.line.style.top = `${this.position}px`;
    if (this.handle) this.handle.style.top = `${this.position}px`;
    if (this.curtain) this._applyCurtain();
    if (typeof this.onMove === 'function') {
      this.onMove(this.position, this);
    }
  }

  _applyCurtain() {
    if (!this.curtain) return;
    const mode = this.mode;
    if (mode === 'from') {
      const origin = this.originTop != null ? this.originTop : (this.metrics[0]?.top ?? 0);
      const height = Math.max(0, this.position - origin);
      this.curtain.style.top = `${origin}px`;
      this.curtain.style.height = `${height}px`;
    } else if (mode === 'to') {
      const origin = this.originBottom != null ? this.originBottom : (this.metrics[this.metrics.length - 1]?.top ?? this.position);
      const top = this.position;
      const height = Math.max(0, origin - top);
      this.curtain.style.top = `${top}px`;
      this.curtain.style.height = `${height}px`;
    }
  }

  _clampPosition(y) {
    if (!this.metrics.length) return 0;
    const first = this.metrics[0];
    const last = this.metrics[this.metrics.length - 1];
    const min = this.minLimit != null ? this.minLimit : first.top;
    const max = this.maxLimit != null ? this.maxLimit : last.top + last.height;
    return Math.max(min, Math.min(max, y));
  }

  _nearestIndex(y) {
    if (!this.metrics.length) return 0;
    let best = 0;
    let bestDist = Infinity;
    this.metrics.forEach((metric, idx) => {
      const dist = Math.abs(y - metric.center);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    });
    return best;
  }

  _handlePointerDown(event) {
    event.preventDefault();
    const pointerId = event.pointerId;
    this.handle.setPointerCapture(pointerId);
    const move = ev => {
      const rect = this.list.getBoundingClientRect();
      const y = ev.clientY - rect.top + this.list.scrollTop;
      this.setPosition(y);
    };
    const up = () => {
      this.handle.releasePointerCapture(pointerId);
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
      this.handle.removeEventListener('pointercancel', up);
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
  }

  _handleKeyDown(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = 12;
    const delta = event.key === 'ArrowUp' ? -step : step;
    const next = (this.position == null ? 0 : this.position) + delta;
    this.setPosition(next);
  }
}

function getStatusFromEndpoint(endpoint) {
  if (!endpoint) return null;
  const node = typeof endpoint === 'object'
    ? endpoint
    : currentGraphState.nodesByKey.get(endpoint);
  if (!node) return null;
  return node.status || node.data?.status || null;
}

function ensureCursorOrder(sourceCursor) {
  if (cursorAdjusting) return;
  if (!statusCursorStart || !statusCursorEnd) return;
  const startPos = statusCursorStart.getPosition();
  const endPos = statusCursorEnd.getPosition();
  if (startPos == null || endPos == null) return;
  if (startPos <= endPos) return;

  cursorAdjusting = true;
  if (sourceCursor === statusCursorStart) {
    statusCursorStart.setPosition(endPos);
  } else if (sourceCursor === statusCursorEnd) {
    statusCursorEnd.setPosition(startPos);
  }
  cursorAdjusting = false;
}

function updateObservationHandle() {
  if (!windowHandleEl || !statusCursorStart || !statusCursorEnd) return;
  const startPos = statusCursorStart.getPosition();
  const endPos = statusCursorEnd.getPosition();
  if (startPos == null || endPos == null) return;
  const top = Math.min(startPos, endPos);
  const bottom = Math.max(startPos, endPos);
  const height = Math.max(32, bottom - top);
  windowHandleEl.style.top = `${top}px`;
  windowHandleEl.style.height = `${height}px`;
}

function shiftObservationWindow(delta) {
  if (!statusCursorStart || !statusCursorEnd) return;
  const startPos = statusCursorStart.getPosition();
  const endPos = statusCursorEnd.getPosition();
  if (startPos == null || endPos == null) return;
  const ascending = startPos <= endPos;
  const lower = ascending ? startPos : endPos;
  const upper = ascending ? endPos : startPos;
  const windowSize = upper - lower;
  const minLimit = Math.min(
    statusCursorStart?.minLimit ?? lower,
    statusCursorEnd?.minLimit ?? lower
  );
  const maxLimit = Math.max(
    statusCursorStart?.maxLimit ?? upper,
    statusCursorEnd?.maxLimit ?? upper
  );
  const minLower = minLimit;
  const maxLower = Math.max(minLower, maxLimit - windowSize);
  let newLower = lower + delta;
  newLower = Math.max(minLower, Math.min(maxLower, newLower));
  const newUpper = newLower + windowSize;
  cursorAdjusting = true;
  if (ascending) {
    statusCursorStart.setPosition(newLower);
    statusCursorEnd.setPosition(newUpper);
  } else {
    statusCursorStart.setPosition(newUpper);
    statusCursorEnd.setPosition(newLower);
  }
  cursorAdjusting = false;
  ensureCursorOrder();
  recomputeCurtainStatuses();
  updateObservationHandle();
}

function initObservationHandle() {
  windowHandleEl = document.getElementById('statusWindowHandle');
  if (!windowHandleEl || windowHandleEl.dataset.bound) return;
  windowHandleEl.dataset.bound = '1';
  windowHandleEl.addEventListener('pointerdown', onObservationHandlePointerDown);
  windowHandleEl.addEventListener('keydown', onObservationHandleKeyDown);
}

function onObservationHandlePointerDown(event) {
  if (!statusCursorStart || !statusCursorEnd) return;
  event.preventDefault();
  const pointerId = event.pointerId;
  windowHandleEl.setPointerCapture(pointerId);
  const startPos = statusCursorStart.getPosition() ?? 0;
  const endPos = statusCursorEnd.getPosition() ?? startPos;
  const ascending = startPos <= endPos;
  const lower = ascending ? startPos : endPos;
  const upper = ascending ? endPos : startPos;
  const minLimit = Math.min(
    statusCursorStart?.minLimit ?? lower,
    statusCursorEnd?.minLimit ?? lower
  );
  const maxLimit = Math.max(
    statusCursorStart?.maxLimit ?? upper,
    statusCursorEnd?.maxLimit ?? upper
  );
  windowDragState = {
    pointerId,
    startY: event.clientY,
    lower,
    upper,
    minLimit,
    maxLimit,
    ascending
  };
  const onMove = ev => {
    if (!windowDragState) return;
    const delta = ev.clientY - windowDragState.startY;
    const windowSize = windowDragState.upper - windowDragState.lower;
    const minLower = windowDragState.minLimit;
    const maxLower = Math.max(minLower, windowDragState.maxLimit - windowSize);
    let newLower = windowDragState.lower + delta;
    newLower = Math.max(minLower, Math.min(maxLower, newLower));
    const newUpper = newLower + windowSize;
    cursorAdjusting = true;
    if (windowDragState.ascending) {
      statusCursorStart.setPosition(newLower);
      statusCursorEnd.setPosition(newUpper);
    } else {
      statusCursorStart.setPosition(newUpper);
      statusCursorEnd.setPosition(newLower);
    }
    cursorAdjusting = false;
    ensureCursorOrder();
    recomputeCurtainStatuses();
    updateObservationHandle();
  };
  const onUp = () => {
    windowHandleEl.releasePointerCapture(pointerId);
    windowHandleEl.removeEventListener('pointermove', onMove);
    windowHandleEl.removeEventListener('pointerup', onUp);
    windowHandleEl.removeEventListener('pointercancel', onUp);
    windowDragState = null;
  };
  windowHandleEl.addEventListener('pointermove', onMove);
  windowHandleEl.addEventListener('pointerup', onUp);
  windowHandleEl.addEventListener('pointercancel', onUp);
}

function onObservationHandleKeyDown(event) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const delta = event.key === 'ArrowUp' ? -12 : 12;
  shiftObservationWindow(delta);
}

function recomputeCurtainStatuses() {
  const container = document.getElementById('statusFilterList');
  if (!container || !statusCursorStart || !statusCursorEnd) return;
  if (container.offsetParent === null || (container.offsetWidth === 0 && container.offsetHeight === 0)) return;
  const options = Array.from(container.querySelectorAll('.filter-option input[data-status]'));
  if (!options.length) return;
  const startPos = statusCursorStart.getPosition();
  const endPos = statusCursorEnd.getPosition();
  if (startPos == null || endPos == null) return;
  const minPos = Math.min(startPos, endPos);
  const maxPos = Math.max(startPos, endPos);
  curtainStatusSet = new Set();
  options.forEach(input => {
    const wrapper = input.closest('.filter-option');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const listRect = container.getBoundingClientRect();
    const top = rect.top - listRect.top + container.scrollTop;
    const bottom = top + rect.height;
    const overlapsTopCurtain = top <= minPos;
    const overlapsBottomCurtain = (bottom + 0.5) >= maxPos;
    if (overlapsTopCurtain || overlapsBottomCurtain) {
      curtainStatusSet.add(normalizeStatusName(input.dataset.status));
    }
  });
  applyStatusCurtainOpacity();
  updateObservationHandle();
}

function applyStatusCurtainOpacity() {
  const nodeSel = currentGraphState.nodeSelection;
  const labelSel = currentGraphState.labelSelection;
  const linkSel = currentGraphState.linkSelection;
  if (!nodeSel || !labelSel || !linkSel) return;
  nodeSel.style('opacity', d => {
    if (!statusIsAllowed(d.status) || !assigneeIsAllowed(d.assigneeId || d.assignee) || !typeIsAllowed(d.issuetype)) return 0;
    return curtainStatusSet.has(normalizeStatusName(d.status)) ? 0.15 : 1;
  });
  labelSel.style('opacity', d => {
    if (!statusIsAllowed(d.status) || !assigneeIsAllowed(d.assigneeId || d.assignee) || !typeIsAllowed(d.issuetype)) return 0;
    return curtainStatusSet.has(normalizeStatusName(d.status)) ? 0.15 : 1;
  });
  linkSel.style('opacity', d => {
    const sourceNode = typeof d.source === 'object' ? currentGraphState.nodesByKey.get(d.source.id) : currentGraphState.nodesByKey.get(d.source);
    const targetNode = typeof d.target === 'object' ? currentGraphState.nodesByKey.get(d.target.id) : currentGraphState.nodesByKey.get(d.target);
    const sourceStatus = sourceNode?.status;
    const targetStatus = targetNode?.status;
    if (!sourceStatus || !targetStatus) return 1;
    if (!statusIsAllowed(sourceStatus) || !statusIsAllowed(targetStatus)) return 0;
    if (!assigneeIsAllowed(sourceNode?.assigneeId || sourceNode?.assignee) || !assigneeIsAllowed(targetNode?.assigneeId || targetNode?.assignee)) return 0;
    if (!typeIsAllowed(sourceNode?.issuetype) || !typeIsAllowed(targetNode?.issuetype)) return 0;
    const inCurtain = curtainStatusSet.has(normalizeStatusName(sourceStatus)) &&
      curtainStatusSet.has(normalizeStatusName(targetStatus));
    return inCurtain ? 0.15 : 1;
  });
  updateHoverHighlights();
}

function updateHoverHighlights() {
  const nodeSel = currentGraphState.nodeSelection;
  if (!nodeSel) return;

  nodeSel.each(function(d) {
    const g = d3.select(this);
    const ringSel = g.selectAll('circle.status-hover-ring');
    const normalizedStatus = normalizeStatusName(d.status);
    const assigneeKey = getAssigneeKey(d);
    const typeKey = String(d.issuetype || '').trim() || 'Unknown';
    const matchesHover = Boolean(
      statusIsAllowed(d.status) &&
      assigneeIsAllowed(d.assigneeId || d.assignee) &&
      typeIsAllowed(d.issuetype) &&
      ((hoveredStatusKey && normalizedStatus === hoveredStatusKey) ||
       (hoveredAssigneeKey && assigneeKey === hoveredAssigneeKey) ||
       (hoveredTypeKey && typeKey === hoveredTypeKey))
    );

    if (!matchesHover) {
      ringSel.remove();
      return;
    }

    const baseRadius = d.id === CURRENT_EPIC_KEY ? 10 : 7;
    const highlightRadius = baseRadius * 2.5;

    ringSel.data([d])
      .join(enter => enter.append('circle').attr('class', 'status-hover-ring'))
      .attr('r', highlightRadius)
      .attr('fill', 'rgba(37, 99, 235, 0.45)');

    const ring = g.select('circle.status-hover-ring');
    if (!ring.empty()) {
      ring.lower();
    }
  });
}

function setHoveredStatus(statusKey) {
  hoveredStatusKey = statusKey ? normalizeStatusName(statusKey) : null;
  updateHoverHighlights();
}

function clearHoveredStatus() {
  if (!hoveredStatusKey) return;
  hoveredStatusKey = null;
  updateHoverHighlights();
}

function setHoveredAssignee(assignee) {
  hoveredAssigneeKey = assignee ? getAssigneeKey(assignee) : null;
  updateHoverHighlights();
}

function clearHoveredAssignee() {
  if (!hoveredAssigneeKey) return;
  hoveredAssigneeKey = null;
  updateHoverHighlights();
}

function setHoveredType(typeId) {
  hoveredTypeKey = typeId ? String(typeId).trim() || 'Unknown' : null;
  updateHoverHighlights();
}

function clearHoveredType() {
  if (!hoveredTypeKey) return;
  hoveredTypeKey = null;
  updateHoverHighlights();
}

// Cache SPECs per epico (vive solo finché la pagina è aperta)
window.EJ_SPECS_CACHE = window.EJ_SPECS_CACHE || {};

// Mappa per spiegazioni: "BUG->TASK" -> { bugText, taskText, score, method, fromKey, toKey }
const aiExplainMap = new Map();

function normalizeStatusName(s) { return String(s || '').trim().toUpperCase(); }

function getCategoryFromIssueType(issuetypeName) {
  const n = String(issuetypeName || '').toLowerCase();
  if (n.includes('epic')) return 'epic';
  if (n.includes('story')) return 'story';
  if (n === 'task' || n.includes(' task')) return 'task';
  if (n === 'bug' || n.includes('bug')) return 'bug';
  return 'other';
}

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#16a34a' : '#dc2626';
}

/**
 * Crea e mostra una status bar di progresso per operazioni asincrone
 * @param {string} initialMessage - Messaggio iniziale
 * @returns {Object} - { update: function, close: function, log: function }
 */
function createProgressStatusBar(initialMessage, options = {}) {
  const variant = options.variant || 'banner';
  
  // Variante minimal: sottile linea blu alla base dell'header
  if (variant === 'thin') {
    const host = headerEl || document.querySelector('.header') || document.body;
    // Contenitore linea (trasparente, serve per posizionamento)
    const line = document.createElement('div');
    line.id = 'ej-progress-header-line';
    line.style.cssText = `
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      background: transparent;
      overflow: hidden;
      z-index: 1000;
    `;
    // Riempimento progressivo
    const fill = document.createElement('div');
    fill.style.cssText = `
      height: 100%;
      width: 0%;
      background: #2563eb;
      transition: width 0.25s ease;
    `;
    line.appendChild(fill);
    // L'header ha già position: relative in CSS, quindi appendiamo lì
    (host || document.body).appendChild(line);
    
    return {
      update: (_message, percent = null) => {
        if (percent !== null) {
          const p = Math.max(0, Math.min(100, percent));
          fill.style.width = `${p}%`;
        }
      },
      log: () => {}, // nessun log nella versione sottile
      close: () => {
        line.style.transition = 'opacity 0.2s ease';
        line.style.opacity = '0';
        setTimeout(() => line.remove(), 200);
      }
    };
  }
  
  // Variante precedente (banner in alto) usata per flussi lunghi come Minor Fixes
  const container = document.createElement('div');
  container.id = 'ej-progress-status-bar';
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 12px 20px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `;
  
  const progressBar = document.createElement('div');
  progressBar.style.cssText = `
    height: 3px;
    background: rgba(255,255,255,0.3);
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  `;
  const progressFill = document.createElement('div');
  progressFill.style.cssText = `
    height: 100%;
    width: 0%;
    background: white;
    border-radius: 2px;
    transition: width 0.3s ease;
    animation: progress-shimmer 1.5s infinite;
  `;
  progressBar.appendChild(progressFill);
  
  const mainMessage = document.createElement('div');
  mainMessage.style.cssText = `
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  `;
  mainMessage.textContent = initialMessage;
  
  const logContainer = document.createElement('div');
  logContainer.id = 'ej-progress-log';
  logContainer.style.cssText = `
    font-size: 12px;
    opacity: 0.9;
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s ease;
    display: flex;
    flex-direction: column;
    gap: 4px;
  `;
  
  container.appendChild(progressBar);
  container.appendChild(mainMessage);
  container.appendChild(logContainer);
  document.body.appendChild(container);
  
  const logs = [];
  
  if (!document.getElementById('ej-progress-shimmer-style')) {
    const style = document.createElement('style');
    style.id = 'ej-progress-shimmer-style';
    style.textContent = `
      @keyframes progress-shimmer {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(300%); }
      }
      @keyframes progress-shimmer-fill {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
    `;
    document.head.appendChild(style);
  }
  
  return {
    update: (message, progressPercent = null) => {
      if (message) mainMessage.textContent = message;
      if (progressPercent !== null) {
        const progress = Math.max(0, Math.min(100, progressPercent));
        progressFill.style.width = `${progress}%`;
      }
    },
    log: (message, type = 'info') => {
      const logEntry = document.createElement('div');
      const timestamp = new Date().toLocaleTimeString('it-IT');
      const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'warning' ? '⚠' : '•';
      logEntry.textContent = `[${timestamp}] ${icon} ${message}`;
      logEntry.style.cssText = `
        padding: 2px 0;
        opacity: 0.85;
      `;
      logs.push({ message, type, timestamp });
      logContainer.appendChild(logEntry);
      if (logs.length > 0 && logContainer.style.maxHeight === '0px') {
        logContainer.style.maxHeight = '200px';
      }
      logContainer.scrollTop = logContainer.scrollHeight;
    },
    close: () => {
      container.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      container.style.opacity = '0';
      container.style.transform = 'translateY(-100%)';
      setTimeout(() => {
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
      }, 300);
    }
  };
}

function ensureSimilarityControl() {
  if (similarityControlEl) return;
  const container = headerEl || (runBtn ? runBtn.parentElement : null);
  if (!container) return;

  const label = document.createElement('label');
  label.id = 'similarityControl';
  label.style.marginLeft = '12px';
  label.style.display = 'none';
  label.style.alignItems = 'center';
  label.style.gap = '6px';

  const textSpan = document.createElement('span');
  textSpan.textContent = 'Similarità minima:';

  const valueSpan = document.createElement('span');
  valueSpan.id = 'similarityValue';
  valueSpan.textContent = `${displayThreshold}%`;

  const slider = document.createElement('input');
  slider.id = 'similaritySlider';
  slider.type = 'range';
  slider.min = '1';
  slider.max = '100';
  slider.value = String(displayThreshold);
  slider.style.cursor = 'pointer';

  label.append(textSpan, valueSpan, slider);
  if (statusEl && statusEl.parentElement === container) {
    container.insertBefore(label, statusEl);
  } else {
    container.appendChild(label);
  }

  similarityControlEl = label;
  similaritySliderEl = slider;
  similarityValueEl = valueSpan;
}

function updateSimilarityControlVisibility(shouldShow) {
  ensureSimilarityControl();
  if (!similarityControlEl) return;
  similarityControlEl.style.display = shouldShow ? 'inline-flex' : 'none';
}

function initSimilaritySlider() {
  ensureSimilarityControl();
  if (!similaritySliderEl || !similarityValueEl) return;

  similaritySliderEl.value = String(displayThreshold);
  similarityValueEl.textContent = `${displayThreshold}%`;

  if (!similaritySliderEl.dataset.bound) {
    similaritySliderEl.dataset.bound = '1';
    similaritySliderEl.addEventListener('input', () => {
      const val = Number(similaritySliderEl.value);
      const clamped = Math.max(1, Math.min(100, val));
      setDisplayThreshold(clamped);
    });
  }

  updateSimilarityControlVisibility(false);
}

function setDisplayThreshold(percent, { updateSlider = true, triggerRedraw = true } = {}) {
  const value = Math.max(1, Math.min(100, Number(percent) || DEFAULT_MIN_SCORE));
  displayThreshold = value;
  window.EJ_DISPLAY_THRESHOLD = value;

  if (updateSlider && similaritySliderEl && similarityValueEl) {
    similaritySliderEl.value = String(value);
    similarityValueEl.textContent = `${value}%`;
  }

  if (triggerRedraw && typeof window.EJ_REDRAW_AI_LINKS === 'function') {
    window.EJ_REDRAW_AI_LINKS(value / 100);
  }
}

function initFilterTabs() {
  const tabs = document.querySelectorAll('.filters-tab');
  const panes = document.querySelectorAll('.filters-pane');
  if (!tabs.length || !panes.length) return;

  tabs.forEach(tab => {
    if (tab.dataset.bound) return;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panes.forEach(pane => {
        pane.classList.toggle('active', pane.id === `filters-${target}`);
      });
      if (target === 'status') {
        updateStatusHoverVisualization();
      } else {
        clearHoveredStatus();
      }
      if (target !== 'users') {
        clearHoveredAssignee();
      }
      if (target !== 'type') {
        clearHoveredType();
      }
    });
  });
}

function statusIsAllowed(statusName) {
  if (!statusName) return true;
  const normalized = normalizeStatusName(statusName);
  if (!STATUS_SEQUENCE.includes(normalized)) return true;
  return activeStatusFilters.has(normalized);
}

function getAssigneeKey(node) {
  if (!node) return ASSIGNEE_UNASSIGNED;
  const id = typeof node === 'string' ? node : (node.assigneeId || node.assignee || '');
  const trimmed = String(id || '').trim();
  return trimmed ? trimmed : ASSIGNEE_UNASSIGNED;
}

function assigneeIsAllowed(assigneeId) {
  if (activeAssigneeFilters === null) return true;
  if (!activeAssigneeFilters.size) return false;
  return activeAssigneeFilters.has(getAssigneeKey(assigneeId));
}

function typeIsAllowed(issueType) {
  if (activeTypeFilters === null) return true;
  if (!activeTypeFilters.size) return false;
  const key = String(issueType || '').trim() || 'Unknown';
  return activeTypeFilters.has(key);
}

function syncStatusCheckboxStates() {
  const container = document.getElementById('statusFilterList');
  if (!container) return;
  const inputs = container.querySelectorAll('input[data-status]');
  inputs.forEach(input => {
    const normalized = normalizeStatusName(input.dataset.status);
    input.checked = activeStatusFilters.has(normalized);
  });
}

function updateStatusSpecialCheckboxes() {
  const container = document.getElementById('statusFilterList');
  if (!container) return;
  const allInput = container.querySelector('input[data-special="all"]');
  const noneInput = container.querySelector('input[data-special="none"]');
  if (allInput) allInput.checked = activeStatusFilters.size === STATUS_SEQUENCE.length;
  if (noneInput) noneInput.checked = activeStatusFilters.size === 0;
}

function isNodeKeyVisible(key) {
  if (!key) return true;
  const node = currentGraphState.nodesByKey.get(key);
  if (!node) return true;
  return statusIsAllowed(node.status) &&
    assigneeIsAllowed(node.assigneeId || node.assignee) &&
    typeIsAllowed(node.issuetype);
}

function applyStatusFilters() {
  const summaryEl = document.getElementById('statusFilterSummary');
  const totalNodes = Array.isArray(currentGraphState.nodes) ? currentGraphState.nodes.length : 0;
  const visibleNodes = totalNodes
    ? currentGraphState.nodes.filter(n => statusIsAllowed(n.status) && assigneeIsAllowed(n.assigneeId || n.assignee) && typeIsAllowed(n.issuetype)).length
    : 0;

  if (summaryEl) {
    if (!totalNodes) {
      summaryEl.textContent = 'Carica un epico per applicare i filtri.';
      summaryEl.classList.remove('warning');
    } else if (visibleNodes === 0) {
      summaryEl.textContent = 'Nessun nodo visibile con i filtri correnti.';
      summaryEl.classList.add('warning');
    } else if (visibleNodes === totalNodes) {
      summaryEl.textContent = 'Mostrati tutti i nodi.';
      summaryEl.classList.remove('warning');
    } else {
      summaryEl.textContent = `Mostrati ${visibleNodes} di ${totalNodes} nodi.`;
      summaryEl.classList.remove('warning');
    }
  }

  const nodeSel = currentGraphState.nodeSelection;
  const labelSel = currentGraphState.labelSelection;
  const linkSel = currentGraphState.linkSelection;
  if (!nodeSel || !labelSel || !linkSel) {
    updateStatusSpecialCheckboxes();
    return;
  }

  nodeSel.style('display', d => (statusIsAllowed(d.status) && assigneeIsAllowed(d.assigneeId || d.assignee) && typeIsAllowed(d.issuetype)) ? null : 'none');
  labelSel.style('display', d => (statusIsAllowed(d.status) && assigneeIsAllowed(d.assigneeId || d.assignee) && typeIsAllowed(d.issuetype)) ? null : 'none');

  linkSel.style('display', d => {
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return (isNodeKeyVisible(sid) && isNodeKeyVisible(tid)) ? null : 'none';
  });

  updateStatusSpecialCheckboxes();
  if (typeof window.EJ_REDRAW_AI_LINKS === 'function') {
    window.EJ_REDRAW_AI_LINKS();
  }
  recomputeCurtainStatuses();
  applyStatusCurtainOpacity();
}

function bindStatusFilterEvents() {
  const container = document.getElementById('statusFilterList');
  if (!container || container.dataset.eventsBound) return;
  container.dataset.eventsBound = '1';

  container.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.type !== 'checkbox') return;

    const special = input.dataset.special;
    if (special === 'all') {
      activeStatusFilters = new Set(STATUS_SEQUENCE);
      syncStatusCheckboxStates();
    } else if (special === 'none') {
      activeStatusFilters = new Set();
      syncStatusCheckboxStates();
    } else if (input.dataset.status) {
      const normalized = normalizeStatusName(input.dataset.status);
      if (input.checked) {
        activeStatusFilters.add(normalized);
      } else {
        activeStatusFilters.delete(normalized);
      }
    }

    updateStatusSpecialCheckboxes();
    applyStatusFilters();
  });
}

function buildStatusFilterOptions() {
  const container = document.getElementById('statusFilterList');
  if (!container || container.dataset.ready) return;
  container.dataset.ready = '1';

  const group = document.createElement('div');
  group.className = 'filters-group';

  const makeOption = (key, label, { checked = false, special = null } = {}) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'filter-option';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = key;
    if (special) input.dataset.special = special;
    else input.dataset.status = key;
    input.checked = checked;

    const text = document.createElement('span');
    text.textContent = label;

    wrapper.append(input, text);
    group.appendChild(wrapper);
  };

  STATUS_SPECIAL_OPTIONS.forEach(opt => {
    makeOption(opt.key, opt.label, { checked: false, special: opt.key === '__ALL__' ? 'all' : 'none' });
  });

  STATUS_SEQUENCE.forEach(status => {
    makeOption(status, STATUS_LABEL_MAP[status] || status, { checked: true });
  });

  container.appendChild(group);
  syncStatusCheckboxStates();
  updateStatusSpecialCheckboxes();

  const options = Array.from(container.querySelectorAll('.filter-option'));
  const firstIdx = options.findIndex(option => {
    const status = option.querySelector('input[data-status]');
    return status && normalizeStatusName(status.dataset.status) === 'TO DO';
  });
  const lastIdx = options.findIndex(option => {
    const status = option.querySelector('input[data-status]');
    return status && normalizeStatusName(status.dataset.status) === 'CANCELED';
  });
  const noneIdx = options.findIndex(option => {
    const special = option.querySelector('input[data-special="none"]');
    return Boolean(special);
  });

  options.forEach(option => {
    const statusInput = option.querySelector('input[data-status]');
    if (!statusInput || option.dataset.hoverBound) return;
    option.dataset.hoverBound = '1';
    option.addEventListener('mouseenter', () => setHoveredStatus(statusInput.dataset.status));
    option.addEventListener('mouseleave', clearHoveredStatus);
  });

  const overlay = document.getElementById('statusCursorOverlay');
  const curtainStart = document.getElementById('statusCursorCurtainStart');
  const lineStart = document.getElementById('statusCursorLineStart');
  const handleStart = document.getElementById('statusCursorHandleStart');
  const curtainEnd = document.getElementById('statusCursorCurtainEnd');
  const lineEnd = document.getElementById('statusCursorLineEnd');
  const handleEnd = document.getElementById('statusCursorHandleEnd');

  if (overlay && !overlay.dataset.initialized) {
    overlay.dataset.initialized = '1';
  }

  if (!statusCursorStart) {
    statusCursorStart = new StatusCursor({
      list: container,
      line: lineStart,
      handle: handleStart,
      curtain: curtainStart,
      mode: 'from',
      onMove: (_, cursor) => { ensureCursorOrder(cursor); recomputeCurtainStatuses(); updateObservationHandle(); }
    });
    statusCursorStart.mount();
  } else {
    statusCursorStart.refresh();
  }

  if (!statusCursorEnd) {
    statusCursorEnd = new StatusCursor({
      list: container,
      line: lineEnd,
      handle: handleEnd,
      curtain: curtainEnd,
      mode: 'to',
      onMove: (_, cursor) => { ensureCursorOrder(cursor); recomputeCurtainStatuses(); updateObservationHandle(); }
    });
    statusCursorEnd.mount();
  } else {
    statusCursorEnd.refresh();
  }

  const limitStrategy = metrics => {
    const metricNone = noneIdx !== -1 ? metrics[noneIdx] : null;
    const metricStart = firstIdx !== -1 ? metrics[firstIdx] : metrics[0];
    const metricBottom = metrics[metrics.length - 1];
    if (!metricStart || !metricBottom) return {};
    const groundTop = metricNone && metricStart
      ? (metricNone.center + metricStart.center) / 2
      : metricStart.top;
    const bottom = metricBottom.top + metricBottom.height + 10;
    return { min: groundTop, max: bottom };
  };

  statusCursorStart?.setLimitStrategy(limitStrategy);
  statusCursorEnd?.setLimitStrategy(limitStrategy);

  const initialStartIndex = firstIdx !== -1 ? firstIdx : 0;
  const initialEndIndex = lastIdx !== -1 ? lastIdx : options.length - 1;
  statusCursorStart?.setPositionFromIndex(initialStartIndex);
  statusCursorEnd?.setPositionFromIndex(initialEndIndex);
  initObservationHandle();
  recomputeCurtainStatuses();
  updateObservationHandle();
}

function normalizeEpicKey(k) {
  if (!k) return null;
  k = k.trim().toUpperCase();
  if (/^\d+$/.test(k)) return `FGC-${k}`;
  return k;
}

// ==== NEW: helper per recuperare la OpenAI API Key (per uso futuro) ====
async function getAiKey() {
  const { openAiApiKey } = await chrome.storage.sync.get(['openAiApiKey']);
  return openAiApiKey || '';
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
    const txt = await res.text().catch(()=> '');
    throw new Error(`Link Jira fallito (${res.status}): ${txt.slice(0,180)}`);
  }
}

// GET /issue/{key}?expand=names,renderedFields,changelog  → restituisce TUTTI i campi disponibili + changelog
async function jiraGetIssueRaw(token, issueKey) {
  const url = `${JIRA_BASE}/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=names,renderedFields,changelog`;
  const res = await fetch(url, {
    method: 'GET',
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json'
    },
    credentials: 'omit', cache: 'no-store', mode: 'cors'
  });
  lastApiDebug = {
    url, method: 'GET',
    requestHeaders: { Authorization: maskAuthHeader(`Basic ${token}`), Accept: 'application/json' },
    status: res.status, statusText: res.statusText, responseText: undefined
  };
  try { lastApiDebug.responseText = await res.clone().text(); } catch {}
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`Errore Jira (${res.status}): ${txt.slice(0,280)}`);
  }
  return res.json();
}

// Estrae TUTTE le URL trovate in un JSON arbitrario
function extractAllUrlsFromJson(obj) {
  try {
    const s = JSON.stringify(obj);
    const re = /\bhttps?:\/\/[^\s)>\]}"]+/gi;
    return Array.from(new Set((s.match(re) || []).map(u => u.replace(/[\\"]+$/g,'').trim())));
  } catch { return []; }
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
    return Array.isArray(data) ? data.map(t => String(t.key)) : [];
  } catch { return []; }
}

// Ritorna l'elenco degli Epic della sprint attiva del board principale
async function fetchActiveSprintEpics(token) {
  let epicLinkFieldId = null;
  try {
    const res = await fetch(`${JIRA_BASE}/rest/api/3/field`, { headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' } });
    if (res.ok) {
      const fields = await res.json();
      const epicField = fields.find(f => String(f.name).toLowerCase() === 'epic link');
      if (epicField) epicLinkFieldId = epicField.id;
    }
  } catch {}

  const childIssues = await jiraSearch(token, `sprint in openSprints() AND issuetype != Epic`, ['summary','issuetype','parent', ...(epicLinkFieldId ? [epicLinkFieldId] : [])]).catch(() => []);

  const epicKeys = new Set();
  for (const it of childIssues) {
    let key = null;
    if (epicLinkFieldId && it.fields && it.fields[epicLinkFieldId]) {
      const v = it.fields[epicLinkFieldId];
      key = typeof v === 'string' ? v : (v?.key || null);
    }
    if (!key && it.fields?.parent?.key) {
      key = it.fields.parent.key;
    }
    if (key) epicKeys.add(key);
  }
  if (epicKeys.size === 0) return [];

  const keyList = Array.from(epicKeys);
  const chunks = [];
  for (let i = 0; i < keyList.length; i += 50) chunks.push(keyList.slice(i, i + 50));
  const out = [];
  for (const ch of chunks) {
    // Escludi Epic con determinati status dalla lista del menu a tendina
    const excludedJql = "status NOT IN ('Released','Closed','Pending development','Backlog')";
    const jql = `key in (${ch.join(',')}) AND issuetype = Epic AND ${excludedJql}`;
    const ep = await jiraSearch(token, jql, ['summary','issuetype']).catch(() => []);
    ep.forEach(e => out.push({ key: e.key, summary: e.fields.summary }));
  }
  out.sort((a,b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Jira Cloud v3: POST /rest/api/3/search/jql con nextPageToken
 */
async function jiraSearch(token, jql, fields = ['summary','issuetype','parent','subtasks','issuelinks','status','assignee']) {
  const results = [];
  let nextPageToken = undefined;
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
    const payload = { jql, fields, maxResults, ...(nextPageToken ? { nextPageToken } : {}) };
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
    nextPageToken = data.nextPageToken;
    if (!nextPageToken || issuesPage.length === 0) break;
  }
  return results;
}

// ======================== Confluence REST ========================
// Dato un URL Confluence, ottieni la base API (https://TENANT.atlassian.net/wiki)
function _confluenceApiBaseFromUrl(u) {
  try {
    const url = new URL(u);
    // Confluence Cloud sta sotto /wiki
    const base = `${url.protocol}//${url.host}/wiki`;
    return base;
  } catch { return null; }
}

// Estrai pageId da URL "lunghi" (/spaces/.../pages/<ID>/...)
function _confluencePageIdFromUrl(u) {
  try {
    const m = String(u).match(/\/pages\/(\d+)\b/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Risolvi tiny-link /wiki/x/<key> → pageId via REST
async function _confluenceResolveTinyKey(token, apiBase, tinyKey) {
  // tentativo 1: endpoint shortlink (nuove API v2)
  try {
    const res = await fetch(`${apiBase}/api/v2/shortlinks/${encodeURIComponent(tinyKey)}`, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (res.ok) {
      const j = await res.json();
      // alcuni tenant restituiscono direttamente il contentId
      const id = j?.destination?.resourceId || j?.resourceId || null;
      if (id) return String(id);
    }
  } catch {}

  // tentativo 2: CQL search su tinyurl
  try {
    const q = `cql=${encodeURIComponent(`tinyurl="${tinyKey}"`)}&expand=body.storage`;
    const res = await fetch(`${apiBase}/rest/api/content/search?${q}`, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (res.ok) {
      const j = await res.json();
      const id = j?.results?.[0]?.id || null;
      if (id) return String(id);
    }
  } catch {}

  return null;
}

// Scarica il corpo "storage" (HTML pulito) di una pagina Confluence
async function _confluenceFetchStorageHtml(token, apiBase, pageId) {
  // v2: /api/v2/pages/{id}?body-format=storage
  // fallback v1: /rest/api/content/{id}?expand=body.storage
  // tentativo v2
  try {
    const res = await fetch(`${apiBase}/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`, {
      headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
      credentials: 'omit', cache: 'no-store', mode: 'cors'
    });
    if (res.ok) {
      const j = await res.json();
      // v2 può avere .body.storage.value o simile
      const html = j?.body?.storage?.value || j?.body?.value || '';
      if (html) return String(html);
    }
  } catch {}

  // fallback v1
  const url = `${apiBase}/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${token}`, 'Accept': 'application/json' },
    credentials: 'omit', cache: 'no-store', mode: 'cors'
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`Confluence API ${res.status}: ${txt.slice(0,200)}`);
  }
  const j = await res.json();
  const html = j?.body?.storage?.value || '';
  return String(html || '');
}

// ===== Helpers SPECs: estrazione link da ADF/Plain, fetch pagine, parsing HTML =====
function _unique(arr){ return Array.from(new Set(arr.filter(Boolean))); }

function _htmlToText(html){
  try{
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html||'');
    return tmp.textContent.replace(/\s+/g,' ').trim();
  }catch{ return String(html||''); }
}

function _extractUrlsFromAdf(adf){
  const out = [];
  try{
    (function walk(node){
      if(!node) return;
      if(Array.isArray(node)){ node.forEach(walk); return; }
      if(node.marks && Array.isArray(node.marks)){
        node.marks.forEach(m=>{
          if(m && m.type==='link' && m.attrs && m.attrs.href){
            out.push(String(m.attrs.href));
          }
        });
      }
      if(node.attrs && node.attrs.href){ out.push(String(node.attrs.href)); }
      if(node.content) walk(node.content);
    })(adf);
  }catch{}
  return _unique(out);
}

function _extractUrlsFromString(s){
  const re = /\bhttps?:\/\/[^\s)>\]}"]+/gi;
  const out = String(s||'').match(re) || [];
  return _unique(out);
}

async function _fetchSpecPageText(u){
  try {
    // PDF/immagini/binary → ignora come prima
    if (/\.(png|jpe?g|gif|pdf|zip|rar|7z|mp4|mov|avi|pptx?|docx?|xlsx?)(\?|$)/i.test(u)) {
      return `[[SPEC_FETCH_ERROR:${u}: Formato binário (ignorado)]]`;
    }

    // Se non è Confluence, fai best-effort HTML->testo (vecchio comportamento)
    if (!/\.atlassian\.net\/wiki\//i.test(u)) {
      const res = await fetch(u, { method:'GET', credentials:'omit', cache:'no-store', mode:'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      return _htmlToText(html);
    }

    // --- Confluence Cloud (richiede API REST + Basic token) ---
    const apiBase = _confluenceApiBaseFromUrl(u);
    if (!apiBase) throw new Error('Confluence base URL inválido');

    // token già calcolato a livello globale
    const token = CURRENT_AUTH_TOKEN;
    if (!token) throw new Error('Token Atlassian indisponível.');

    // Prova a prendere pageId dall'URL
    let pageId = _confluencePageIdFromUrl(u);

    // Se è tiny-link (/wiki/x/<key>), risolvi
    if (!pageId) {
      const m = String(u).match(/\/x\/([A-Za-z0-9]+)/);
      if (m) {
        pageId = await _confluenceResolveTinyKey(token, apiBase, m[1]);
      }
    }

    if (!pageId) {
      throw new Error('Impossibile risolvere pageId Confluence da URL.');
    }

    // Leggi il body.storage via REST
    const storageHtml = await _confluenceFetchStorageHtml(token, apiBase, pageId);
    if (!storageHtml) throw new Error('Página sem conteúdo (storage HTML vazio).');

    // Converti a testo leggibile
    return _htmlToText(storageHtml);

  } catch(e) {
    const reason = e && e.message ? e.message : 'erro';
    return `[[SPEC_FETCH_ERROR:${u}: ${reason}]]`;
  }
}

function _cleanUrl(u){
  try {
    const url = new URL(u);
    url.searchParams.delete('atlOrigin'); // ripulisce tracking di Confluence
    return url.toString();
  } catch { return String(u||''); }
}

function _extractUrlsFromHtml(html){
  try{
    const div = document.createElement('div');
    div.innerHTML = String(html||'');
    const hrefs = Array.from(div.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(Boolean);
    const textUrls = _extractUrlsFromString(div.textContent || '');
    return _unique([...hrefs, ...textUrls].map(_cleanUrl));
  }catch{ return []; }
}

function _extractUrlsFromDescription(desc){
  // desc può essere: (1) oggetto ADF, (2) stringa HTML, (3) stringa plain
  if (!desc) return [];
  if (typeof desc === 'object') return _unique(_extractUrlsFromAdf(desc).map(_cleanUrl));
  if (/<\s*a\s+/i.test(String(desc))) return _extractUrlsFromHtml(desc); // HTML
  return _unique(_extractUrlsFromString(desc).map(_cleanUrl)); // plain
}

async function _loadEpicSpecs(epicIssue, token){
  try{
    specsDiag = [];
    logSpec('INIT', `Preparando leitura das SPECs do épico ${epicIssue?.key || '(desconhecido)'}`);

    const epicKey = epicIssue.key;

    // ❶ Provo a usare la description arrivata
    let adf = epicIssue.fields?.description || null;

    // ❷ Fallback robusto: se manca la description, la rileggo esplicitamente
    if (!adf) {
      logSpec('PARSE', 'Description assente nell\'oggetto epico: faccio fallback fetch(description)…', false);
      try {
        const m = await fetchIssuesWithDescription(token, [epicKey]); // abbiamo già questo helper sotto
        const plainTmp = m.get(epicKey) || '';
        // Se fetchIssuesWithDescription torna plain, non ADF: lo useremo comunque per estrarre gli URL
        if (plainTmp) {
          // ricreo un "plain-only" flow: lascio adf=null e userò 'plain' più sotto
          logSpec('PARSE', `Fallback OK: description letta (chars=${plainTmp.length}).`);
          var plain = plainTmp; // definisco qui per riuso
        } else {
          var plain = '';
        }
      } catch (e) {
        logSpec('PARSE', `Fallback description FAIL: ${e && e.message ? e.message : e}`, false);
        var plain = '';
      }
    } else {
      var plain = adfToPlain(adf);
    }

    // ① URL dalla description così com'è (HTML o ADF o plain)
    let urls = _extractUrlsFromDescription(adf || '');

    // ② Se ho un plain (da ADF o fallback), arricchisco
    if (plain && typeof plain === 'string') {
      urls = _unique([...urls, ..._extractUrlsFromString(plain).map(_cleanUrl)]);
    }

    // ③ Preferisci anche la rendered description del dump (ancora più fedele ai link di Confluence)
    try {
      const raw = window.__EJ_LAST_EPIC_RAW__ && window.__EJ_LAST_EPIC_RAW__[epicKey];
      const renderedHtml = raw?.renderedFields?.description || '';
      if (renderedHtml) {
        const extra = _extractUrlsFromHtml(renderedHtml);
        if (extra.length) {
          logSpec('PARSE', `URLs da renderedFields.description: +${extra.length}`);
          urls = _unique([...urls, ...extra]);
        }
      }
    } catch {}

    logSpec('PARSE', `ADF presente: ${!!adf} | Texto plain chars: ${plain.length}`);
    logSpec('PARSE', `URLs extraídas: ${urls.length} ${urls.length ? `| Ex.: ${urls.slice(0,3).join(', ')}` : ''}`);

    // === FALLBACK AUTO: se non ho trovato link, prova ora a leggere renderedFields.description ===
    if ((!urls || urls.length === 0) && epicKey && token) {
      try {
        // prova dal dump se già presente
        const cachedRaw = (window.__EJ_LAST_EPIC_RAW__ && window.__EJ_LAST_EPIC_RAW__[epicKey]) || null;
        let renderedNow = cachedRaw?.renderedFields?.description || '';

        // se non c'è in cache, fai fetch on-demand del RAW con renderedFields
        if (!renderedNow) {
          logSpec('PARSE', 'URLs=0 → fetch on-demand di renderedFields.description…', false);
          const rawNow = await jiraGetIssueRaw(token, epicKey);
          renderedNow = rawNow?.renderedFields?.description || '';
          if (renderedNow) {
            // metti in cache per usi futuri
            window.__EJ_LAST_EPIC_RAW__ = window.__EJ_LAST_EPIC_RAW__ || {};
            window.__EJ_LAST_EPIC_RAW__[epicKey] = rawNow;
          }
        }

        if (renderedNow) {
          const extra = _extractUrlsFromHtml(renderedNow);
          if (extra.length) {
            logSpec('PARSE', `URLs da renderedFields.description (fallback on-demand): +${extra.length}`);
            urls = _unique([...(urls||[]), ...extra]);
          } else {
            logSpec('PARSE', 'renderedFields.description presente ma senza link.', false);
          }
        } else {
          logSpec('PARSE', 'renderedFields.description indisponibile.', false);
        }
      } catch (e) {
        logSpec('PARSE', `fallback renderedFields FAIL: ${e && e.message ? e.message : e}`, false);
      }
    }

    // Inizializza record cache
    window.EJ_SPECS_CACHE[epicKey] = {
      text: '',
      urls: urls || [],
      ts: Date.now(),
      ok: false,
      success: 0,
      failed: 0,
      failures: [],
      log: specsDiag
    };

    if (!urls.length) {
      logSpec('PARSE', `Nenhum link encontrado na descrição do épico ${epicKey}`, false);
      return;
    }

    logSpec('FETCH', `Lendo ${urls.length} páginas de SPEC…`);
    const texts = [];
    let success = 0, failed = 0;
    const failures = [];

    for(const u of urls){
      const isBinary = /\.(png|jpe?g|gif|pdf|zip|rar|7z|mp4|mov|avi|pptx?|docx?|xlsx?)(\?|$)/i.test(u);
      if (isBinary) {
        failed++; 
        const reason = 'Formato binário (ignorado)';
        failures.push({ url: u, error: reason });
        logSpec('SKIP', `${u} → ${reason}`, false);
        continue;
      }
      try {
        const t = await _fetchSpecPageText(u);
        if (/^\[\[SPEC_FETCH_ERROR:/.test(t)) {
          failed++; 
          failures.push({ url: u, error: t.slice(0,160) });
          logSpec('HTTP', `${u} → FAIL ${t.slice(0,120)}`, false);
        } else {
          success++; 
          texts.push(`[[URL:${u}]]\n${t}`);
          logSpec('HTTP', `${u} → OK (chars=${t.length})`);
        }
      } catch (e) {
        failed++; 
        const reason = (e && e.message) ? e.message : 'erro desconhecido';
        failures.push({ url: u, error: reason });
        logSpec('HTTP', `${u} → EXCEPTION ${reason}`, false);
      }
    }

    const joined = texts.join('\n\n-----\n\n').trim();
    window.EJ_SPECS_CACHE[epicKey] = {
      text: joined,
      urls,
      ts: Date.now(),
      ok: success > 0,
      success,
      failed,
      failures,
      log: specsDiag
    };

    if (success > 0 && failed === 0) {
      logSpec('DONE', `SPECs carregadas (${success}/${urls.length}) para ${epicKey}.`);
    } else if (success > 0 && failed > 0) {
      logSpec('DONE', `SPECs parciais: ok=${success} | falhas=${failed} | total=${urls.length}`, false);
    } else {
      logSpec('DONE', `Nenhum conteúdo legível (falhas=${failed}/${urls.length}).`, false);
    }

    // Bottone "Ver SPECs" sempre cliccabile
    if (viewSpecsBtn) {
      viewSpecsBtn.disabled = false; // sempre cliccabile
      viewSpecsBtn.setAttribute('data-has-specs', (success > 0 ? '1' : '0'));
    }

  }catch(e){
    logSpec('ERROR', `Falha inesperada: ${e && e.message ? e.message : e}`, false);
    // Bottone sempre cliccabile anche in caso di errore
    if (viewSpecsBtn) {
      viewSpecsBtn.disabled = false; // sempre cliccabile
      viewSpecsBtn.setAttribute('data-has-specs', '0');
    }
  }
}

// Svuota la cache SPECs quando chiudi/ricarichi la pagina
window.addEventListener('unload', ()=>{ try{ window.EJ_SPECS_CACHE = {}; }catch{} });

async function loadGraph(epicKeyRaw) {
  logBootStep('LOAD_GRAPH_ENTRY', { 
    epicKeyRaw,
    hasBuildAssigneeFilters: typeof window.buildAssigneeFilters === 'function',
    hasBuildTypeFilters: typeof window.buildTypeFilters === 'function'
  });
  
  // Pulizia cache changelog e reset Time Inertia
  window.__EJ_CHANGELOG_CACHE__ = {};
  timeInertiaActive = false;
  timeInertiaHover = false;
  timeInertiaBaseDate = null; // Verrà ricaricato dallo storage per l'epico corrente
  
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
    if (epicKeyRaw === NO_EPIC_OPTION) {
      CURRENT_EPIC_KEY = NO_EPIC_OPTION;
      await loadNoEpicCards(token);
      return;
    }
    if (!epicKey) throw new Error('Chiave epico non valida.');
    CURRENT_EPIC_KEY = epicKey;
    logBootStep('LOAD_GRAPH_EPIC_KEY_SET', { epicKey });
    
    // Carica data di ricalcolo Time Inertia dallo storage
    const storageKey = `timeInertiaBaseDate_${epicKey}`;
    try {
      const result = await chrome.storage.sync.get(storageKey);
      if (result[storageKey]) {
        timeInertiaBaseDate = new Date(result[storageKey]);
        // Aggiorna il testo
        const day = String(timeInertiaBaseDate.getDate()).padStart(2, '0');
        const month = String(timeInertiaBaseDate.getMonth() + 1).padStart(2, '0');
        const year = timeInertiaBaseDate.getFullYear();
        const recalcText = document.getElementById('ej-time-inertia-recalc-text');
        if (recalcText) {
          recalcText.textContent = `Dias re-calculados a partir do dia ${day}/${month}/${year}`;
        }
      } else {
        timeInertiaBaseDate = null;
        const recalcText = document.getElementById('ej-time-inertia-recalc-text');
        if (recalcText) {
          recalcText.textContent = '';
        }
      }
    } catch (err) {
      console.warn('Errore caricamento data Time Inertia:', err);
      timeInertiaBaseDate = null;
    }
    
    activeStatusFilters = new Set(STATUS_SEQUENCE);
    syncStatusCheckboxStates();
    updateStatusSpecialCheckboxes();
    clearHoveredStatus();
    clearHoveredAssignee();
    clearHoveredType();
    setStatus(`Recupero dati per ${epicKey}…`);

    // 1) Epico (chiediamo anche 'description' per estrarre i link delle SPECs)
    setStatus('Cercando epic…');
    const epicIssue = await jiraSearch(
      token,
      `issuekey=${epicKey}`,
      ['summary','issuetype','description'] // <<<  AGGIUNTO
    );
    if (!epicIssue.length) throw new Error(`Epico ${epicKey} non trovato.`);
    
    // Aggiorna l'etichetta nel select con "KEY — Summary" se presente
    try {
      const summary = epicIssue[0]?.fields?.summary || '';
      if (epicSelect) {
        let opt = Array.from(epicSelect.options).find(o => o.value === epicKey);
        if (opt) {
          opt.textContent = `${epicKey}${summary ? ' — ' + summary : ''}`;
          epicSelect.value = epicKey;
        }
      }
    } catch {}

    // Carica SPECs dell'epico e mettile in cache per l'AI (passo anche il token)
    await _loadEpicSpecs(epicIssue[0], token); // <<<  PASSO TOKEN

    // Riepilogo SPEC (post-caricamento)
    {
      const meta = window.EJ_SPECS_CACHE[epicIssue[0].key] || {};
      const when = meta.ts ? new Date(meta.ts).toLocaleString() : '';
      const base = `SPEC: ${meta.ok ? 'OK' : 'KO'} — links=${meta.urls?.length||0}, ok=${meta.success||0}, ko=${meta.failed||0}`;
      setStatus(`${base}${when ? ` (${when})` : ''}`, !!meta.ok);
      // bottone "Ver SPECs" sempre cliccabile
      if (viewSpecsBtn) {
        viewSpecsBtn.disabled = false; // sempre cliccabile
        viewSpecsBtn.setAttribute('data-has-specs', (meta.ok ? '1' : '0'));
      }
    }

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
          issuetypeIcon: issue.fields.issuetype?.iconUrl || '',
          category,
          status: normalizeStatusName(issue.fields.status?.name),
          assignee: (issue.fields.assignee?.displayName || issue.fields.assignee?.name || '').trim(),
          assigneeId: issue.fields.assignee?.accountId || issue.fields.assignee?.name || '',
          assigneeAvatar: issue.fields.assignee?.avatarUrls?.['24x24'] || issue.fields.assignee?.avatarUrls?.['32x32'] || ''
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
    const hierLinks = [];
    const relLinks = [];
    const execLinks = [];
    const pairSet = new Set();

    [...linkedIssues, ...parentIssues].forEach(child => {
      const childCat = nodeByKey.get(child.key)?.category;
      const linkKey = `${epicKey}->${child.key}`;
      if (!linkSet.has(linkKey)) {
        hierLinks.push({ source: epicKey, target: child.key, kind: 'hier', childCat: childCat });
        linkSet.add(linkKey);
      }
    });

    [...linkedIssues, ...parentIssues, ...allSubtasks].forEach(issue => {
      if (issue.fields.parent?.key) {
        const pKey = issue.fields.parent.key;
        const linkKey = `${pKey}->${issue.key}`;
        if (nodeByKey.has(pKey) && !linkSet.has(linkKey)) {
          const childCat = nodeByKey.get(issue.key)?.category;
          const parentCat = nodeByKey.get(pKey)?.category;
          const childMeta = parentCat === 'epic' ? { childCat } : {};
          hierLinks.push({ source: pKey, target: issue.key, kind: 'hier', ...childMeta });
          linkSet.add(linkKey);
        }
      }
    });

    const issueByKey = new Map(issues.map(i => [i.key, i]));
    issueByKey.forEach((src) => {
      const linksArr = src.fields.issuelinks || [];
      linksArr.forEach(l => {
        const linked = l.outwardIssue || l.inwardIssue;
        if (!linked) return;
        const a = src.key;
        const b = linked.key;
        if (!issueByKey.has(b)) return;
        const undirected = a < b ? `${a}--${b}` : `${b}--${a}`;
        if (!pairSet.has(undirected)) {
          const srcCat = nodeByKey.get(a)?.category;
          const dstCat = nodeByKey.get(b)?.category;
          if ((srcCat === 'test_execution' && dstCat === 'epic') ||
              (dstCat === 'test_execution' && srcCat === 'epic')) {
            return;
          }
          relLinks.push({ source: a, target: b, kind: 'rel', label: l.type?.name || '' });
          pairSet.add(undirected);
        }
      });
    });

    const testExecIssues = issues.filter(i => /test execution/i.test(i.fields.issuetype?.name || ''));
    const keyRegex = /[A-Z][A-Z0-9]+-\d+/;
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

    const EXCLUDED_ASSIGNEES = [
      'Aleksandr Novoselov',
      'Anna Gromova',
      'Anton Kalmykov',
      'Dmitry Zakharov',
      'Evgeny Soldatov',
      'Platon Lumpov',
      'Savelyev Sergey'
    ];

    const normalizeName = name => String(name || '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');

    const EXCLUDED_SIGNATURES = new Set(EXCLUDED_ASSIGNEES.map(normalizeName));
    const shouldExclude = (name = '') => {
      const normalized = normalizeName(name);
      return normalized && EXCLUDED_SIGNATURES.has(normalized);
    };

    Array.from(nodeByKey.entries()).forEach(([key, node]) => {
      if (shouldExclude(node?.assignee)) {
        nodeByKey.delete(key);
      }
    });

    Array.from(issueByKey.keys()).forEach(key => {
      if (!nodeByKey.has(key)) {
        issueByKey.delete(key);
      }
    });

    const nodes = Array.from(nodeByKey.values());
    const assigneeMap = new Map();
    const typeMap = new Map();
    nodes.forEach(node => {
      const id = getAssigneeKey(node);
      const label = (node.assignee || '').trim() || 'Unassigned';
      const avatar = node.assigneeAvatar || '';
      if (!assigneeMap.has(id)) {
        assigneeMap.set(id, { id, label, avatar, count: 0 });
      }
      assigneeMap.get(id).count += 1;

      const typeKey = (node.issuetype || '').trim() || 'Unknown';
      const typeIcon = node.issuetypeIcon || '';
      if (!typeMap.has(typeKey)) {
        typeMap.set(typeKey, { id: typeKey, label: typeKey, icon: typeIcon, count: 0 });
      }
      typeMap.get(typeKey).count += 1;
    });
    const assignees = Array.from(assigneeMap.values())
      .filter(item => !shouldExclude(item.label))
      .sort((a, b) => a.label.localeCompare(b.label));
    currentGraphState.assignees = assignees;
    logBootStep('LOAD_GRAPH_ASSIGNEES_BUILT', { 
      assigneesCount: assignees.length, 
      assignees: assignees.map(a => ({ id: a.id, label: a.label, count: a.count })),
      hasBuildAssigneeFilters: typeof window.buildAssigneeFilters === 'function'
    });
    
    const types = Array.from(typeMap.values()).sort((a, b) => a.label.localeCompare(b.label));
    currentGraphState.types = types;
    const assigneeIds = assignees.map(a => a.id);
    activeAssigneeFilters = new Set(assigneeIds);
    const typeIds = types.map(t => t.id);
    activeTypeFilters = new Set(typeIds);
    
    logBootStep('LOAD_GRAPH_CALL_BUILD_ASSIGNEES', { 
      willCall: !!window.buildAssigneeFilters,
      assigneesReady: assignees.length > 0
    });
    if (window.buildAssigneeFilters) {
      logBootStep('LOAD_GRAPH_BUILD_ASSIGNEES_START', {});
      window.buildAssigneeFilters();
      logBootStep('LOAD_GRAPH_BUILD_ASSIGNEES_OK', {});
    } else {
      logBootStep('LOAD_GRAPH_BUILD_ASSIGNEES_SKIP', { reason: 'window.buildAssigneeFilters not defined' });
    }
    
    logBootStep('LOAD_GRAPH_CALL_BUILD_TYPES', { willCall: !!window.buildTypeFilters });
    if (window.buildTypeFilters) {
      window.buildTypeFilters();
      logBootStep('LOAD_GRAPH_BUILD_TYPES_OK', {});
    } else {
      logBootStep('LOAD_GRAPH_BUILD_TYPES_SKIP', { reason: 'window.buildTypeFilters not defined' });
    }

    const allLinks = [...hierLinks, ...relLinks, ...execLinks];

    const catById = new Map(nodes.map(n => [n.id, n.category]));
    const visibleLinks = allLinks.filter(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      const a = catById.get(sid);
      const b = catById.get(tid);
      return !((a === 'test_execution' && b === 'epic') || (b === 'test_execution' && a === 'epic'));
    });

    renderForceGraph(nodes, visibleLinks, epicKey, { hierLinks, relLinks });
    applyStatusFilters();
    setStatus(`Caricato: ${nodes.length} nodi, ${visibleLinks.length} collegamenti.`);
    
    // Fix: Se buildAssigneeFilters non era disponibile durante loadGraph, 
    // proviamo a chiamarlo ora che l'IIFE potrebbe aver finito
    if (typeof window.buildAssigneeFilters === 'function' && currentGraphState.assignees?.length > 0) {
      logBootStep('LOAD_GRAPH_RETRY_BUILD_ASSIGNEES', { 
        message: 'Retry buildAssigneeFilters dopo renderForceGraph',
        assigneesCount: currentGraphState.assignees.length
      });
      window.buildAssigneeFilters();
    }
    if (typeof window.buildTypeFilters === 'function' && currentGraphState.types?.length > 0) {
      logBootStep('LOAD_GRAPH_RETRY_BUILD_TYPES', { 
        message: 'Retry buildTypeFilters dopo renderForceGraph'
      });
      window.buildTypeFilters();
    }
  } catch (err) {
    console.error('Errore nel caricamento del grafico:', err);
    const errorMsg = err.message || String(err);
    setStatus(errorMsg, false);
  }
}

// ===== UI: menu contestuale + modale "Explicação" (funzioni globali) =====
function ensureContextUi() {
  if (!document.getElementById('ej-ai-style')) {
    const style = document.createElement('style');
    style.id = 'ej-ai-style';
    style.textContent = `
      .ej-menu { position: fixed; z-index: 9999; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); min-width: 180px; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
      .ej-menu ul { list-style: none; margin: 0; padding: 6px; }
      .ej-menu li { padding: 8px 10px; border-radius: 4px; cursor: pointer; font-size: 14px; }
      .ej-menu li:hover { background: #f3f4f6; }
      .ej-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 9998; }
      .ej-modal { position: fixed; z-index: 10000; background: #fff; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); width: min(720px, 92vw); max-height: 82vh; overflow: auto; padding: 18px; top: 50%; left: 50%; transform: translate(-50%, -50%); font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
      .ej-modal h3 { margin: 0 0 10px 0; font-size: 18px; }
      .ej-modal pre { white-space: pre-wrap; word-wrap: break-word; background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 13px; border: 1px solid #e5e7eb; }
      .ej-close { display: inline-block; margin-top: 12px; background: #111827; color: #fff; border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; font-size: 14px;}
      .ej-specs-log { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; max-height: 180px; overflow: auto; font-size: 12px; }
      .ej-spec-entry { margin: 8px 0; border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 10px; background: #f9fafb; }
      .ej-spec-entry summary { cursor: pointer; font-weight: 600; outline: none; }
      .ej-spec-entry pre { margin: 8px 0 0 0; }
      .ej-specs-failed { margin: 4px 0 0 0; padding-left: 20px; font-size: 13px; color: #b91c1c; }
      .ej-node-menu { position: fixed; z-index: 10001; background: #111827; color: #fff; border-radius: 8px; padding: 8px; box-shadow: 0 10px 24px rgba(0,0,0,0.25); display: none; min-width: 160px; font-size: 13px; }
      .ej-node-menu button { width: 100%; padding: 6px 10px; border: none; background: transparent; color: inherit; text-align: left; border-radius: 6px; cursor: pointer; }
      .ej-node-menu button:hover { background: rgba(255,255,255,0.12); }
      .ej-inspect-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 10002; display: none; }
      .ej-inspect-modal { position: fixed; z-index: 10003; background: #fff; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); width: min(1200px, 95vw); max-height: 80vh; overflow: hidden; padding: 16px; top: 50%; left: 50%; transform: translate(-50%, -50%); font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; display: none; }
      .ej-inspect-modal h3 { margin: 0 0 10px 0; font-size: 18px; }
      .ej-inspect-body-wrapper { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 12px; }
      .ej-inspect-body { overflow: auto; max-height: 56vh; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #f8fafc; font-size: 13px; white-space: pre-wrap; }
      .ej-inspect-bump-section { display: none; overflow: auto; max-height: 56vh; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #f9fafb; font-size: 12px; white-space: pre-wrap; font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
      .ej-inspect-bump-section.visible { display: block; }
      .ej-inspect-bump-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
      .ej-inspect-bump-header h4 { margin: 0; font-size: 14px; color: #475569; }
      .ej-inspect-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
      .ej-btn { padding: 6px 12px; border-radius: 6px; border: 1px solid transparent; font-size: 14px; cursor: pointer; }
      .ej-btn-primary { background: #1d4ed8; color: #fff; }
      .ej-btn-secondary { background: #e5e7eb; color: #111827; }
      .ej-time-inertia-btn { 
        position: fixed; 
        bottom: 20px; 
        left: 260px; 
        width: 60px; 
        height: 60px; 
        border-radius: 50%; 
        border: none; 
        cursor: pointer; 
        font-size: 11px; 
        font-weight: 600; 
        color: white; 
        text-align: center; 
        line-height: 1.2; 
        z-index: 10004; 
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        background-color: #3b82f6; /* Blu fisso quando non attivo */
      }
      .ej-time-inertia-btn:hover { 
        transform: scale(1.1); 
        box-shadow: 0 6px 16px rgba(0,0,0,0.4);
      }
      .ej-time-inertia-btn.active {
        animation: timeInertiaPulse 2s ease-in-out infinite;
      }
      @keyframes timeInertiaPulse {
        0%, 100% { background-color: #3b82f6; }
        50% { background-color: #ef4444; }
      }
      .time-inertia-halo {
        fill: none;
        stroke-width: 3;
        opacity: 0.6;
        pointer-events: none;
        transition: opacity 0.6s ease-out;
      }
      .ej-time-inertia-dots {
        position: fixed;
        bottom: 75px;
        left: 260px;
        width: 30px;
        height: 20px;
        cursor: pointer;
        z-index: 10005;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        color: #64748b;
        font-size: 16px;
        font-weight: bold;
        user-select: none;
      }
      .ej-time-inertia-dots:hover {
        color: #3b82f6;
      }
      .ej-time-inertia-date-picker {
        position: fixed;
        bottom: 100px;
        left: 260px;
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.15);
        z-index: 10006;
        display: none;
      }
      .ej-time-inertia-date-picker.visible {
        display: block;
      }
      .ej-time-inertia-date-picker input[type="date"] {
        padding: 6px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        font-size: 14px;
      }
      .ej-time-inertia-date-picker button {
        margin-top: 8px;
        padding: 6px 12px;
        background: #3b82f6;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
      }
      .ej-time-inertia-date-picker button:hover {
        background: #2563eb;
      }
      .ej-time-inertia-recalc-text {
        position: fixed;
        bottom: 20px;
        left: 330px;
        font-size: 11px;
        color: #64748b;
        z-index: 10004;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }
  if (!document.getElementById('ej-ai-menu')) {
    const menu = document.createElement('div');
    menu.id = 'ej-ai-menu';
    menu.className = 'ej-menu';
    menu.style.display = 'none';
    menu.innerHTML = `<ul><li id="ej-ai-explicacao">Explicação</li></ul>`;
    document.body.appendChild(menu);
  }
  if (!document.getElementById('ej-ai-backdrop')) {
    const back = document.createElement('div');
    back.id = 'ej-ai-backdrop';
    back.className = 'ej-backdrop';
    back.style.display = 'none';
    document.body.appendChild(back);
  }
  if (!document.getElementById('ej-ai-modal')) {
    const modal = document.createElement('div');
    modal.id = 'ej-ai-modal';
    modal.className = 'ej-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <h3 id="ej-ai-modal-title">Explicação da conexão</h3>
      <pre id="ej-ai-modal-text"></pre>
      <button class="ej-close" id="ej-ai-close">Fechar</button>
    `;
    document.body.appendChild(modal);
    document.getElementById('ej-ai-close').addEventListener('click', hideModal);
    document.getElementById('ej-ai-backdrop').addEventListener('click', hideModal);
  }
  if (!document.getElementById('ej-node-menu')) {
    nodeContextMenuEl = document.createElement('div');
    nodeContextMenuEl.id = 'ej-node-menu';
    nodeContextMenuEl.className = 'ej-node-menu';
    nodeContextMenuEl.innerHTML = `
      <button id="ej-node-inspect-btn">Inspect node</button>
      <button id="ej-node-search-btn">Search connection</button>
    `;
    nodeContextMenuEl.style.display = 'none';
    document.body.appendChild(nodeContextMenuEl);
  } else {
    nodeContextMenuEl = document.getElementById('ej-node-menu');
  }
  if (!document.getElementById('ej-inspect-backdrop')) {
    inspectBackdrop = document.createElement('div');
    inspectBackdrop.id = 'ej-inspect-backdrop';
    inspectBackdrop.className = 'ej-inspect-backdrop';
    document.body.appendChild(inspectBackdrop);
  } else {
    inspectBackdrop = document.getElementById('ej-inspect-backdrop');
  }
  if (!document.getElementById('ej-inspect-modal')) {
    inspectModal = document.createElement('div');
    inspectModal.id = 'ej-inspect-modal';
    inspectModal.className = 'ej-inspect-modal';
    inspectModal.innerHTML = `
      <h3 id="ej-inspect-title">Inspect node</h3>
      <div class="ej-inspect-body-wrapper">
        <div class="ej-inspect-body" id="ej-inspect-content">(caricamento…)</div>
        <div class="ej-inspect-bump-section" id="ej-inspect-bump-section">
          <div class="ej-inspect-bump-header">
            <h4>Bump list extended</h4>
            <button class="ej-btn ej-btn-secondary" id="ej-inspect-bump-copy" style="padding: 4px 8px; font-size: 12px;">Copia</button>
          </div>
          <div id="ej-inspect-bump-content">(clicca "Bump list extended" per caricare)</div>
        </div>
      </div>
      <div class="ej-inspect-actions">
        <button class="ej-btn ej-btn-secondary" id="ej-inspect-close">Chiudi</button>
        <button class="ej-btn ej-btn-secondary" id="ej-inspect-bump-toggle">Bump list extended</button>
        <button class="ej-btn ej-btn-primary" id="ej-inspect-copy">Copia</button>
      </div>
    `;
    inspectModal.style.display = 'none';
    document.body.appendChild(inspectModal);
    inspectContentEl = document.getElementById('ej-inspect-content');
    inspectCopyBtn = document.getElementById('ej-inspect-copy');
    const closeBtn = document.getElementById('ej-inspect-close');
    const closeInspect = () => {
      inspectModal.style.display = 'none';
      inspectBackdrop.style.display = 'none';
    };
    closeBtn.addEventListener('click', closeInspect);
    inspectBackdrop.addEventListener('click', closeInspect);
    inspectCopyBtn.addEventListener('click', async () => {
      if (!inspectContentEl) return;
      try {
        await navigator.clipboard.writeText(inspectContentEl.textContent || '');
        setStatus('Dettagli nodo copiati negli appunti.', true);
      } catch (err) {
        console.error('Clipboard error', err);
        setStatus('Impossibile copiare negli appunti.', false);
      }
    });
    
    // Event listener per Bump list extended
    const bumpToggleBtn = document.getElementById('ej-inspect-bump-toggle');
    const bumpContentEl = document.getElementById('ej-inspect-bump-content');
    const bumpCopyBtn = document.getElementById('ej-inspect-bump-copy');
    const bumpSection = document.getElementById('ej-inspect-bump-section');
    
    if (bumpToggleBtn && bumpSection && bumpContentEl && !bumpToggleBtn.dataset.listenerAdded) {
      bumpToggleBtn.dataset.listenerAdded = '1';
      bumpToggleBtn.addEventListener('click', () => {
        logBootStep('BUMP_TOGGLE_CLICK', {
          hasBumpSection: !!bumpSection,
          hasBumpContentEl: !!bumpContentEl,
          isVisible: bumpSection.classList.contains('visible')
        });
        
        const rawDataStr = inspectModal.dataset.rawData;
        logBootStep('BUMP_TOGGLE_CHECK_DATA', {
          hasRawDataStr: !!rawDataStr,
          rawDataStrLength: rawDataStr?.length || 0,
          hasDataset: !!inspectModal.dataset.rawData
        });
        
        if (!rawDataStr) {
          logBootStep('BUMP_TOGGLE_NO_DATA', { error: 'Dati raw non disponibili' });
          setStatus('Dati raw non disponibili', false);
          return;
        }
        
        if (bumpSection.classList.contains('visible')) {
          // Nascondi
          logBootStep('BUMP_TOGGLE_HIDE', {});
          bumpSection.classList.remove('visible');
          bumpToggleBtn.textContent = 'Bump list extended';
        } else {
          // Mostra e carica
          logBootStep('BUMP_TOGGLE_SHOW_START', {});
          try {
            logBootStep('BUMP_TOGGLE_PARSE_START', { rawDataStrLength: rawDataStr.length });
            const rawData = JSON.parse(rawDataStr);
            logBootStep('BUMP_TOGGLE_PARSE_OK', { 
              rawDataKeys: Object.keys(rawData).slice(0, 10),
              rawDataSize: JSON.stringify(rawData).length
            });
            
            const formatted = JSON.stringify(rawData, null, 2);
            logBootStep('BUMP_TOGGLE_FORMAT_OK', { formattedLength: formatted.length });
            
            bumpContentEl.textContent = formatted;
            logBootStep('BUMP_TOGGLE_CONTENT_SET', { 
              contentLength: bumpContentEl.textContent?.length || 0,
              hasContent: !!bumpContentEl.textContent
            });
            
            bumpSection.classList.add('visible');
            logBootStep('BUMP_TOGGLE_VISIBLE_SET', { 
              hasVisibleClass: bumpSection.classList.contains('visible'),
              bumpSectionDisplay: window.getComputedStyle(bumpSection).display
            });
            
            bumpToggleBtn.textContent = 'Nascondi bump list';
            setStatus('Bump list extended caricata', true);
            logBootStep('BUMP_TOGGLE_SUCCESS', {});
          } catch (err) {
            logBootStep('BUMP_TOGGLE_ERROR', { 
              error: err.message,
              stack: err.stack,
              rawDataStrPreview: rawDataStr?.substring(0, 200)
            });
            console.error('Errore parsing raw data', err);
            setStatus('Errore nel caricamento dei dati', false);
          }
        }
      });
    } else {
      logBootStep('BUMP_TOGGLE_ELEMENTS_MISSING', {
        hasBumpToggleBtn: !!bumpToggleBtn,
        hasBumpSection: !!bumpSection,
        hasBumpContentEl: !!bumpContentEl
      });
    }
    
    if (bumpCopyBtn && bumpContentEl) {
      bumpCopyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(bumpContentEl.textContent || '');
          setStatus('Bump list copiata negli appunti.', true);
        } catch (err) {
          console.error('Clipboard error', err);
          setStatus('Impossibile copiare negli appunti.', false);
        }
      });
    }
  } else {
    inspectModal = document.getElementById('ej-inspect-modal');
    inspectContentEl = document.getElementById('ej-inspect-content');
    inspectCopyBtn = document.getElementById('ej-inspect-copy');
    
    const bumpToggleBtn = document.getElementById('ej-inspect-bump-toggle');
    const bumpContentEl = document.getElementById('ej-inspect-bump-content');
    const bumpCopyBtn = document.getElementById('ej-inspect-bump-copy');
    const bumpSection = document.getElementById('ej-inspect-bump-section');
    
    // Aggiungi listener solo se non già aggiunti
    if (bumpToggleBtn && !bumpToggleBtn.dataset.listenerAdded) {
      bumpToggleBtn.dataset.listenerAdded = '1';
      bumpToggleBtn.addEventListener('click', () => {
        logBootStep('BUMP_TOGGLE_CLICK_EXISTING', {
          hasBumpSection: !!bumpSection,
          hasBumpContentEl: !!bumpContentEl,
          isVisible: bumpSection?.classList.contains('visible')
        });
        
        const rawDataStr = inspectModal.dataset.rawData;
        logBootStep('BUMP_TOGGLE_CHECK_DATA_EXISTING', {
          hasRawDataStr: !!rawDataStr,
          rawDataStrLength: rawDataStr?.length || 0
        });
        
        if (!rawDataStr) {
          logBootStep('BUMP_TOGGLE_NO_DATA_EXISTING', { error: 'Dati raw non disponibili' });
          setStatus('Dati raw non disponibili', false);
          return;
        }
        if (bumpSection.classList.contains('visible')) {
          logBootStep('BUMP_TOGGLE_HIDE_EXISTING', {});
          bumpSection.classList.remove('visible');
          bumpToggleBtn.textContent = 'Bump list extended';
        } else {
          logBootStep('BUMP_TOGGLE_SHOW_START_EXISTING', {});
          try {
            const rawData = JSON.parse(rawDataStr);
            const formatted = JSON.stringify(rawData, null, 2);
            bumpContentEl.textContent = formatted;
            bumpSection.classList.add('visible');
            logBootStep('BUMP_TOGGLE_SUCCESS_EXISTING', {
              contentLength: bumpContentEl.textContent?.length || 0,
              hasVisibleClass: bumpSection.classList.contains('visible')
            });
            bumpToggleBtn.textContent = 'Nascondi bump list';
            setStatus('Bump list extended caricata', true);
          } catch (err) {
            logBootStep('BUMP_TOGGLE_ERROR_EXISTING', { 
              error: err.message,
              stack: err.stack
            });
            console.error('Errore parsing raw data', err);
            setStatus('Errore nel caricamento dei dati', false);
          }
        }
      });
    }
    
    if (bumpCopyBtn && !bumpCopyBtn.dataset.listenerAdded) {
      bumpCopyBtn.dataset.listenerAdded = '1';
      bumpCopyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(bumpContentEl.textContent || '');
          setStatus('Bump list copiata negli appunti.', true);
        } catch (err) {
          console.error('Clipboard error', err);
          setStatus('Impossibile copiare negli appunti.', false);
        }
      });
    }
  }
  
  // Bottone Time Inertia
  let timeInertiaBtn = document.getElementById('ej-time-inertia-btn');
  if (!timeInertiaBtn) {
    timeInertiaBtn = document.createElement('button');
    timeInertiaBtn.id = 'ej-time-inertia-btn';
    timeInertiaBtn.className = 'ej-time-inertia-btn';
    timeInertiaBtn.innerHTML = 'Time<br>Inertia';
    document.body.appendChild(timeInertiaBtn);
  }
  
  // Event handlers per Time Inertia (solo se non già aggiunti)
  if (timeInertiaBtn && !timeInertiaBtn.dataset.handlersAdded) {
    timeInertiaBtn.dataset.handlersAdded = '1';
    let fadeOutTimeout = null;
    
    // Funzione per attivare Time Inertia
    async function activateTimeInertia() {
      const nodeSelection = currentGraphState.nodeSelection;
      if (!nodeSelection || !nodeSelection.size()) return;
      
      // Recupera token
      let token;
      try {
        token = CURRENT_AUTH_TOKEN || (await getCreds()).token;
      } catch {
        setStatus('Errore: credenziali non disponibili per Time Inertia', false);
        return;
      }
      
      // Ottieni tutte le chiavi dei nodi (escludendo quelli con status esclusi)
      const nodeKeys = [];
      nodeSelection.each(d => {
        if (!isExcludedStatus(d.status)) {
          nodeKeys.push(d.key);
        }
      });
      
      if (nodeKeys.length === 0) {
        setStatus('Nessun nodo valido per Time Inertia', false);
        return;
      }
      
      setStatus(`Recupero changelog per ${nodeKeys.length} nodi...`, true);
      
      // Recupera changelog
      const changelogMap = await fetchChangelogsForNodes(token, nodeKeys);
      
      // Aggiorna gli aloni
      updateTimeInertiaHalos(nodeSelection, changelogMap);
      
      setStatus(`Time Inertia attivato (${changelogMap.size} nodi)`, true);
    }
    
    // mouseenter: attiva modalità
    timeInertiaBtn.addEventListener('mouseenter', async () => {
      timeInertiaHover = true;
      
      // Cancella eventuale fade-out in corso
      if (fadeOutTimeout) {
        clearTimeout(fadeOutTimeout);
        fadeOutTimeout = null;
      }
      
      // Se la modalità non è già attiva, attivala
      if (!timeInertiaActive) {
        await activateTimeInertia();
      } else {
        // Se già attiva, aggiorna gli aloni (potrebbero essere cambiati i nodi)
        const nodeSelection = currentGraphState.nodeSelection;
        if (nodeSelection && nodeSelection.size()) {
          // Ricrea la map dai dati in cache
          const changelogMap = new Map();
          nodeSelection.each(d => {
            if (window.__EJ_CHANGELOG_CACHE__[d.key]) {
              changelogMap.set(d.key, window.__EJ_CHANGELOG_CACHE__[d.key]);
            }
          });
          updateTimeInertiaHalos(nodeSelection, changelogMap);
        }
      }
    });
    
    // mouseleave: se non è stato fatto click, avvia fade-out
    timeInertiaBtn.addEventListener('mouseleave', () => {
      timeInertiaHover = false;
      
      // Se la modalità non è persistente (click), avvia fade-out
      if (!timeInertiaActive) {
        const nodeSelection = currentGraphState.nodeSelection;
        if (nodeSelection && nodeSelection.size()) {
          // Avvia fade-out dopo un piccolo delay per evitare flickering
          fadeOutTimeout = setTimeout(() => {
            removeTimeInertiaHalos(nodeSelection);
            fadeOutTimeout = null;
          }, 100);
        }
      }
    });
    
    // click: toggle modalità persistente
    timeInertiaBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      
      // Cancella eventuale fade-out
      if (fadeOutTimeout) {
        clearTimeout(fadeOutTimeout);
        fadeOutTimeout = null;
      }
      
      // Toggle modalità
      timeInertiaActive = !timeInertiaActive;
      
      if (timeInertiaActive) {
        // Attiva
        await activateTimeInertia();
        timeInertiaBtn.classList.add('active');
      } else {
        // Disattiva: rimuovi aloni
        const nodeSelection = currentGraphState.nodeSelection;
        if (nodeSelection && nodeSelection.size()) {
          removeTimeInertiaHalos(nodeSelection);
        }
        timeInertiaBtn.classList.remove('active');
        setStatus('Time Inertia disattivato', true);
      }
    });
  }
  
  // Tre puntini per date picker
  let timeInertiaDots = document.getElementById('ej-time-inertia-dots');
  if (!timeInertiaDots) {
    timeInertiaDots = document.createElement('div');
    timeInertiaDots.id = 'ej-time-inertia-dots';
    timeInertiaDots.className = 'ej-time-inertia-dots';
    timeInertiaDots.innerHTML = '⋮';
    document.body.appendChild(timeInertiaDots);
  }
  
  // Date picker
  let timeInertiaDatePicker = document.getElementById('ej-time-inertia-date-picker');
  if (!timeInertiaDatePicker) {
    timeInertiaDatePicker = document.createElement('div');
    timeInertiaDatePicker.id = 'ej-time-inertia-date-picker';
    timeInertiaDatePicker.className = 'ej-time-inertia-date-picker';
    timeInertiaDatePicker.innerHTML = `
      <label style="display: block; margin-bottom: 6px; font-size: 12px; color: #475569;">Data di ricalcolo:</label>
      <input type="date" id="ej-time-inertia-date-input" style="width: 100%;">
      <button id="ej-time-inertia-date-apply">Applica</button>
      <button id="ej-time-inertia-date-clear" style="margin-left: 6px; background: #ef4444;">Rimuovi</button>
    `;
    document.body.appendChild(timeInertiaDatePicker);
  }
  
  // Testo ricalcolo
  let timeInertiaRecalcText = document.getElementById('ej-time-inertia-recalc-text');
  if (!timeInertiaRecalcText) {
    timeInertiaRecalcText = document.createElement('div');
    timeInertiaRecalcText.id = 'ej-time-inertia-recalc-text';
    timeInertiaRecalcText.className = 'ej-time-inertia-recalc-text';
    document.body.appendChild(timeInertiaRecalcText);
  }
  
  // Event handlers per i tre puntini
  if (timeInertiaDots && !timeInertiaDots.dataset.handlersAdded) {
    timeInertiaDots.dataset.handlersAdded = '1';
    
    timeInertiaDots.addEventListener('click', (e) => {
      e.stopPropagation();
      const picker = document.getElementById('ej-time-inertia-date-picker');
      if (picker) {
        picker.classList.toggle('visible');
      }
    });
    
    // Chiudi picker quando si clicca fuori
    document.addEventListener('click', (e) => {
      const picker = document.getElementById('ej-time-inertia-date-picker');
      const dots = document.getElementById('ej-time-inertia-dots');
      if (picker && dots && !picker.contains(e.target) && !dots.contains(e.target)) {
        picker.classList.remove('visible');
      }
    });
  }
  
  // Event handlers per date picker
  const dateInput = document.getElementById('ej-time-inertia-date-input');
  const dateApplyBtn = document.getElementById('ej-time-inertia-date-apply');
  const dateClearBtn = document.getElementById('ej-time-inertia-date-clear');
  
  if (dateApplyBtn && !dateApplyBtn.dataset.handlersAdded) {
    dateApplyBtn.dataset.handlersAdded = '1';
    
    dateApplyBtn.addEventListener('click', async () => {
      const dateValue = dateInput?.value;
      if (!dateValue) return;
      
      const date = new Date(dateValue);
      const storageKey = `timeInertiaBaseDate_${CURRENT_EPIC_KEY || 'NO_EPIC'}`;
      
      try {
        await chrome.storage.sync.set({ [storageKey]: date.toISOString() });
        
        // Aggiorna il testo
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const recalcText = document.getElementById('ej-time-inertia-recalc-text');
        if (recalcText) {
          recalcText.textContent = `Dias re-calculados a partir do dia ${day}/${month}/${year}`;
        }
        
        // Nascondi picker
        const picker = document.getElementById('ej-time-inertia-date-picker');
        if (picker) picker.classList.remove('visible');
        
        // Se Time Inertia è attivo, riaggiorna gli aloni
        if (timeInertiaActive) {
          const nodeSelection = currentGraphState.nodeSelection;
          if (nodeSelection && nodeSelection.size()) {
            const changelogMap = new Map();
            nodeSelection.each(d => {
              if (window.__EJ_CHANGELOG_CACHE__[d.key]) {
                changelogMap.set(d.key, window.__EJ_CHANGELOG_CACHE__[d.key]);
              }
            });
            updateTimeInertiaHalos(nodeSelection, changelogMap);
          }
        }
        
        setStatus('Data di ricalcolo salvata', true);
      } catch (err) {
        console.error('Errore salvataggio data:', err);
        setStatus('Errore nel salvataggio della data', false);
      }
    });
  }
  
  if (dateClearBtn && !dateClearBtn.dataset.handlersAdded) {
    dateClearBtn.dataset.handlersAdded = '1';
    
    dateClearBtn.addEventListener('click', async () => {
      const storageKey = `timeInertiaBaseDate_${CURRENT_EPIC_KEY || 'NO_EPIC'}`;
      
      try {
        await chrome.storage.sync.remove(storageKey);
        
        // Rimuovi il testo
        const recalcText = document.getElementById('ej-time-inertia-recalc-text');
        if (recalcText) {
          recalcText.textContent = '';
        }
        
        // Nascondi picker
        const picker = document.getElementById('ej-time-inertia-date-picker');
        if (picker) picker.classList.remove('visible');
        
        // Se Time Inertia è attivo, riaggiorna gli aloni
        if (timeInertiaActive) {
          const nodeSelection = currentGraphState.nodeSelection;
          if (nodeSelection && nodeSelection.size()) {
            const changelogMap = new Map();
            nodeSelection.each(d => {
              if (window.__EJ_CHANGELOG_CACHE__[d.key]) {
                changelogMap.set(d.key, window.__EJ_CHANGELOG_CACHE__[d.key]);
              }
            });
            updateTimeInertiaHalos(nodeSelection, changelogMap);
          }
        }
        
        setStatus('Data di ricalcolo rimossa', true);
      } catch (err) {
        console.error('Errore rimozione data:', err);
        setStatus('Errore nella rimozione della data', false);
      }
    });
  }
}

/**
 * Crea e mostra il modale per inserire il codice della card Minor Fixes
 */
function showMinorFixesModal() {
  ensureContextUi();
  
  // Crea il modale se non esiste
  let modal = document.getElementById('ej-minor-fixes-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ej-minor-fixes-modal';
    modal.className = 'ej-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <h3 id="ej-minor-fixes-title">Minor Fixes</h3>
      <p style="margin: 12px 0; color: #475569; font-size: 14px;">Qual é o código da Card de Minor Fixes?</p>
      <p style="margin: 8px 0 16px 0; color: #64748b; font-size: 12px;">Digite aqui o número, o código do card, ou coloque o url inteiro</p>
      <input 
        type="text" 
        id="ej-minor-fixes-input" 
        placeholder="Ex: 10112, FGC-10112, ou https://facilitygrid.atlassian.net/browse/FGC-10112"
        style="width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; margin-bottom: 16px;"
      />
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button class="ej-btn ej-btn-secondary" id="ej-minor-fixes-cancel">Annulla</button>
        <button class="ej-btn ej-btn-primary" id="ej-minor-fixes-ok">OK</button>
      </div>
    `;
    document.body.appendChild(modal);
    
    // Event listeners
    document.getElementById('ej-minor-fixes-cancel').addEventListener('click', hideMinorFixesModal);
    document.getElementById('ej-minor-fixes-ok').addEventListener('click', handleMinorFixesOk);
    
    // Enter key sull'input
    document.getElementById('ej-minor-fixes-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleMinorFixesOk();
      }
    });
    
    // Gestione click backdrop per questo modale
    const backdrop = document.getElementById('ej-ai-backdrop');
    const backdropClickHandler = (e) => {
      const minorFixesModal = document.getElementById('ej-minor-fixes-modal');
      if (minorFixesModal && minorFixesModal.style.display !== 'none') {
        hideMinorFixesModal();
      }
    };
    backdrop.addEventListener('click', backdropClickHandler);
  }
  
  // Carica valore salvato se esiste
  chrome.storage.sync.get(['minorFixesCardKey'], (result) => {
    const input = document.getElementById('ej-minor-fixes-input');
    if (input && result.minorFixesCardKey) {
      input.value = result.minorFixesCardKey;
    } else if (input) {
      input.value = '';
    }
    input?.focus();
  });
  
  // Mostra modale
  document.getElementById('ej-ai-backdrop').style.display = 'block';
  modal.style.display = 'block';
}

function hideMinorFixesModal() {
  const modal = document.getElementById('ej-minor-fixes-modal');
  if (modal) modal.style.display = 'none';
  document.getElementById('ej-ai-backdrop').style.display = 'none';
  
  // Reset select all'opzione precedente (se era Minor Fixes)
  if (epicSelect && epicSelect.value === MINOR_FIXES_OPTION) {
    // Ripristina all'opzione precedente o alla prima disponibile
    const options = Array.from(epicSelect.options);
    const prevOption = options.find(opt => opt.value !== MINOR_FIXES_OPTION && opt.value !== NO_EPIC_OPTION);
    if (prevOption) {
      epicSelect.value = prevOption.value;
    } else if (options.length > 0) {
      epicSelect.value = options[0].value;
    }
  }
}

// Modale: A specific Epic
function showSpecificEpicModal() {
  ensureContextUi();

  let modal = document.getElementById('ej-specific-epic-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ej-specific-epic-modal';
    modal.className = 'ej-modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <h3 id="ej-specific-epic-title">A specific Epic</h3>
      <p style="margin: 12px 0; color: #475569; font-size: 14px;">Inserisci il codice dell'Epic.</p>
      <p style="margin: 8px 0 16px 0; color: #64748b; font-size: 12px;">Puoi digitare il numero, la KEY completa (es. FGC-1234) o incollare l'URL completo.</p>
      <input
        type="text"
        id="ej-specific-epic-input"
        placeholder="Es: 10112, FGC-10112, oppure https://facilitygrid.atlassian.net/browse/FGC-10112"
        style="width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; margin-bottom: 16px;"
      />
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button class="ej-btn ej-btn-secondary" id="ej-specific-epic-cancel">Annulla</button>
        <button class="ej-btn ej-btn-primary" id="ej-specific-epic-ok">OK</button>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('ej-specific-epic-cancel').addEventListener('click', hideSpecificEpicModal);
    document.getElementById('ej-specific-epic-ok').addEventListener('click', handleSpecificEpicOk);

    document.getElementById('ej-specific-epic-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSpecificEpicOk();
    });

    const backdrop = document.getElementById('ej-ai-backdrop');
    const backdropClickHandler = () => {
      const m = document.getElementById('ej-specific-epic-modal');
      if (m && m.style.display !== 'none') hideSpecificEpicModal();
    };
    backdrop.addEventListener('click', backdropClickHandler);
  }

  chrome.storage.sync.get(['specificEpicKey'], (result) => {
    const input = document.getElementById('ej-specific-epic-input');
    if (input && result.specificEpicKey) input.value = result.specificEpicKey;
    else if (input) input.value = '';
    input?.focus();
  });

  document.getElementById('ej-ai-backdrop').style.display = 'block';
  modal.style.display = 'block';
}

function hideSpecificEpicModal() {
  const modal = document.getElementById('ej-specific-epic-modal');
  if (modal) modal.style.display = 'none';
  document.getElementById('ej-ai-backdrop').style.display = 'none';

  if (epicSelect && epicSelect.value === SPECIFIC_EPIC_OPTION) {
    const options = Array.from(epicSelect.options);
    const prev = options.find(opt => opt.value !== SPECIFIC_EPIC_OPTION && opt.value !== NO_EPIC_OPTION);
    if (prev) epicSelect.value = prev.value;
    else if (options.length > 0) epicSelect.value = options[0].value;
  }
}

async function handleSpecificEpicOk() {
  const input = document.getElementById('ej-specific-epic-input');
  if (!input) return;

  const raw = input.value.trim();
  if (!raw) {
    setStatus('Inserisci un codice valido.', false);
    return;
  }

  const epicKey = parseCardInput(raw);
  if (!epicKey) {
    setStatus('Formato non valido. Usa numero, KEY (es. FGC-XXXX) o URL.', false);
    return;
  }

  try {
    await chrome.storage.sync.set({ specificEpicKey: epicKey });
  } catch {}

  hideSpecificEpicModal();

  // Assicura che il select mostri l'epico scelto:
  // - se non presente tra le opzioni, aggiungi un'opzione ad hoc
  // - seleziona l'opzione corrispondente
  if (epicSelect) {
    let opt = Array.from(epicSelect.options).find(o => o.value === epicKey);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = epicKey;
      opt.textContent = epicKey; // la etichetta verrà raffinata con il summary dopo il fetch in loadGraph
      // Inserisci prima di SPECIFIC_EPIC_OPTION se presente, altrimenti in coda
      const specificOpt = Array.from(epicSelect.options).find(o => o.value === SPECIFIC_EPIC_OPTION);
      if (specificOpt) {
        epicSelect.insertBefore(opt, specificOpt);
      } else {
        epicSelect.appendChild(opt);
      }
    }
    epicSelect.value = epicKey;
  }

  if (window.EJ_SPECS_CACHE) window.EJ_SPECS_CACHE[epicKey] = undefined;
  loadGraph(epicKey);
}
async function handleMinorFixesOk() {
  const input = document.getElementById('ej-minor-fixes-input');
  if (!input) return;
  
  const inputValue = input.value.trim();
  if (!inputValue) {
    setStatus('Inserisci un codice valido.', false);
    return;
  }
  
  // Parsing dell'input
  const cardKey = parseCardInput(inputValue);
  if (!cardKey) {
    setStatus('Formato codice non valido. Usa: numero, FGC-XXXX, o URL completo.', false);
    return;
  }
  
  // Costruisci URL
  const cardUrl = `https://facilitygrid.atlassian.net/browse/${cardKey}`;
  
  // Salva in storage
  try {
    await chrome.storage.sync.set({ minorFixesCardKey: cardKey });
  } catch (e) {
    console.error('Errore salvataggio storage:', e);
  }
  
  // Chiudi modale input
  hideMinorFixesModal();
  
  // Recupera la Checklist
  const progressBar = createProgressStatusBar(`Recupero Checklist per ${cardKey}...`);
  
  try {
    setStatus(`Recupero Checklist per ${cardKey}...`, true);
    progressBar.log('Inizializzazione recupero checklist');
    
    const token = CURRENT_AUTH_TOKEN || (await getCreds()).token;
    progressBar.log('Credenziali Jira verificate');
    
    const { items: checklistItems, debugInfo } = await fetchChecklistItems(token, cardKey, progressBar);
    
    // Chiudi la progress bar dopo un breve delay per mostrare il messaggio finale
    setTimeout(() => {
      progressBar.close();
    }, 1500);
    
    if (checklistItems === null) {
      setStatus(`Checklist non trovata per ${cardKey}`, false);
      showChecklistModal(cardKey, [], debugInfo);
    } else {
      setStatus(`Checklist recuperata: ${checklistItems.length} elementi`, true);
      showChecklistModal(cardKey, checklistItems, debugInfo);
    }
  } catch (error) {
    console.error('Errore recupero Checklist:', error);
    setStatus(`Errore nel recupero Checklist: ${error.message || error}`, false);
    progressBar.log(`Errore: ${error.message || String(error)}`, 'error');
    
    // Chiudi la progress bar dopo un breve delay
    setTimeout(() => {
      progressBar.close();
    }, 2000);
    
    // Mostra modale con errore
    ensureContextUi();
    const modal = document.getElementById('ej-ai-modal');
    const titleEl = document.getElementById('ej-ai-modal-title');
    const textEl = document.getElementById('ej-ai-modal-text');
    if (modal && titleEl && textEl) {
      titleEl.textContent = `Errore - ${cardKey}`;
      textEl.innerHTML = `<p style="color: #dc2626;">Impossibile recuperare la Checklist.</p><p style="color: #64748b; font-size: 12px;">${escapeHtml(error.message || String(error))}</p>`;
      document.getElementById('ej-ai-backdrop').style.display = 'block';
      modal.style.display = 'block';
    }
  }
}

function showModal(text) {
  const elem = document.getElementById('ej-ai-modal-text');
  // Supporto HTML: se il testo contiene <, usa innerHTML, altrimenti textContent
  if (text && typeof text === 'string' && /<[a-z][\s\S]*>/i.test(text)) {
    elem.innerHTML = text;
  } else {
    elem.textContent = text;
  }
  document.getElementById('ej-ai-backdrop').style.display = 'block';
  document.getElementById('ej-ai-modal').style.display = 'block';
}

function hideModal() {
  document.getElementById('ej-ai-backdrop').style.display = 'none';
  document.getElementById('ej-ai-modal').style.display = 'none';
}
// ===== fine UI =====

// ===== Time Inertia: Cache e funzioni helper =====
// Cache globale per i changelog delle issue
window.__EJ_CHANGELOG_CACHE__ = window.__EJ_CHANGELOG_CACHE__ || {};

// Variabili globali per lo stato Time Inertia
let timeInertiaActive = false;
let timeInertiaHover = false;
let timeInertiaBaseDate = null; // Data di riferimento per il ricalcolo (null = usa "now")

/**
 * Verifica se uno status è escluso dalla funzionalità Time Inertia
 * @param {string} status - Status da verificare
 * @returns {boolean} - true se escluso (UAT, SKIP UAT, RELEASED, CANCELLED)
 */
function isExcludedStatus(status) {
  if (!status) return false;
  const normalized = String(status).toUpperCase().trim();
  return normalized === 'UAT' || normalized === 'SKIP UAT' || normalized === 'RELEASED' || normalized === 'CANCELLED';
}

/**
 * Estrae la data dell'ultimo cambio di status dal changelog
 * @param {Object} raw - Dati raw dell'issue Jira (con changelog)
 * @param {string} currentStatus - Status corrente della card
 * @returns {Date|null} - Data dell'ultimo cambio di status, o null se non trovata
 */
function getLastStatusChangeDate(raw, currentStatus) {
  if (!raw?.changelog?.histories || !currentStatus) return null;
  
  const histories = raw.changelog.histories;
  // Cerca dall'ultima modifica alla prima (ordine cronologico inverso)
  for (let i = histories.length - 1; i >= 0; i--) {
    const history = histories[i];
    if (!history.items || !Array.isArray(history.items)) continue;
    
    // Cerca qualsiasi cambio di status (non solo quello corrente)
    for (const item of history.items) {
      if (item.field === 'status') {
        // Trovato un cambio di status
        try {
          return new Date(history.created);
        } catch {
          return null;
        }
      }
    }
  }
  
  return null;
}

/**
 * Calcola i giorni dall'ultimo cambio di status
 * @param {Object} raw - Dati raw dell'issue Jira (con changelog)
 * @param {string} currentStatus - Status corrente della card
 * @param {Date|null} referenceDate - Data di riferimento opzionale (null = usa timeInertiaBaseDate o "now")
 * @returns {number|null} - Numero di giorni, o null se non disponibile
 */
function calculateDaysFromLastStatusChange(raw, currentStatus, referenceDate = null) {
  const changeDate = getLastStatusChangeDate(raw, currentStatus);
  if (!changeDate) return null;
  
  // Usa referenceDate se fornito, altrimenti timeInertiaBaseDate se presente, altrimenti "now"
  const refDate = referenceDate || timeInertiaBaseDate || new Date();
  const diffMs = refDate - changeDate;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays); // Non negativo
}

/**
 * Mappa i giorni a un colore per Time Inertia (verde → giallo → rosso)
 * @param {number} days - Numero di giorni
 * @returns {string} - Colore RGB (es. "rgb(34, 197, 94)")
 */
function getTimeInertiaColor(days) {
  if (days === null || days === undefined) return 'rgba(128, 128, 128, 0.3)'; // Grigio se non disponibile
  
  // Scala lineare: verde (0) → giallo (5) → rosso (10+)
  const green = { r: 34, g: 197, b: 94 };   // rgb(34, 197, 94)
  const yellow = { r: 234, g: 179, b: 8 };   // rgb(234, 179, 8)
  const red = { r: 220, g: 38, b: 38 };     // rgb(220, 38, 38)
  
  let r, g, b;
  
  if (days <= 0) {
    // Verde puro
    r = green.r;
    g = green.g;
    b = green.b;
  } else if (days >= 10) {
    // Rosso puro
    r = red.r;
    g = red.g;
    b = red.b;
  } else if (days <= 5) {
    // Interpolazione verde → giallo (0-5 giorni)
    const t = days / 5;
    r = Math.round(green.r + (yellow.r - green.r) * t);
    g = Math.round(green.g + (yellow.g - green.g) * t);
    b = Math.round(green.b + (yellow.b - green.b) * t);
  } else {
    // Interpolazione giallo → rosso (5-10 giorni)
    const t = (days - 5) / 5;
    r = Math.round(yellow.r + (red.r - yellow.r) * t);
    g = Math.round(yellow.g + (red.g - yellow.g) * t);
    b = Math.round(yellow.b + (red.b - yellow.b) * t);
  }
  
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Aggiorna gli aloni Time Inertia attorno ai nodi
 * @param {d3.Selection} nodeSelection - Selezione D3 dei nodi
 * @param {Map<string, Object>} changelogMap - Map con chiave issue key e valore raw data
 */
function updateTimeInertiaHalos(nodeSelection, changelogMap) {
  if (!nodeSelection || !changelogMap) return;
  
  nodeSelection.each(function(d) {
    const g = d3.select(this);
    
    // Salta i nodi con status esclusi
    if (isExcludedStatus(d.status)) {
      g.selectAll('circle.time-inertia-halo').remove();
      return;
    }
    
    // Ottieni il changelog per questo nodo
    const raw = changelogMap.get(d.key);
    if (!raw) {
      g.selectAll('circle.time-inertia-halo').remove();
      return;
    }
    
    // Calcola i giorni dall'ultimo cambio di status
    const days = calculateDaysFromLastStatusChange(raw, d.status);
    const color = getTimeInertiaColor(days);
    
    // Determina il raggio dell'alone (più grande del nodo)
    const baseRadius = d.id === CURRENT_EPIC_KEY ? 10 : 7;
    const haloRadius = baseRadius * 2.5;
    
    // Aggiungi o aggiorna l'alone
    const halo = g.selectAll('circle.time-inertia-halo')
      .data([d])
      .join(
        enter => enter.append('circle')
          .attr('class', 'time-inertia-halo')
          .attr('r', haloRadius)
          .attr('stroke', color)
          .attr('opacity', 0)
          .call(enter => enter.transition().duration(600).attr('opacity', 0.6)),
        update => update
          .attr('stroke', color)
          .attr('r', haloRadius)
          .attr('opacity', 0.6),
        exit => exit.remove()
      );
    
    // Posiziona l'alone dietro il nodo
    halo.lower();
  });
}

/**
 * Rimuove gli aloni Time Inertia con fade-out
 * @param {d3.Selection} nodeSelection - Selezione D3 dei nodi
 */
function removeTimeInertiaHalos(nodeSelection) {
  if (!nodeSelection) return;
  
  nodeSelection.each(function() {
    const g = d3.select(this);
    const halos = g.selectAll('circle.time-inertia-halo');
    
    if (!halos.empty()) {
      halos.transition()
        .duration(600) // 0.6 secondi come richiesto
        .attr('opacity', 0)
        .on('end', function() {
          d3.select(this).remove();
        });
    }
  });
}

/**
 * Recupera i changelog per una lista di nodi (con cache)
 * @param {string} token - Token di autenticazione Jira
 * @param {Array<string>} nodeKeys - Array di chiavi issue (es. ['FGC-123', 'FGC-456'])
 * @returns {Promise<Map<string, Object>>} - Map con chiave issue key e valore raw data
 */
async function fetchChangelogsForNodes(token, nodeKeys) {
  const result = new Map();
  if (!Array.isArray(nodeKeys) || nodeKeys.length === 0) return result;
  
  // Filtra le chiavi che non sono già in cache
  const keysToFetch = nodeKeys.filter(key => !window.__EJ_CHANGELOG_CACHE__[key]);
  
  // Aggiungi quelle già in cache al risultato
  nodeKeys.forEach(key => {
    if (window.__EJ_CHANGELOG_CACHE__[key]) {
      result.set(key, window.__EJ_CHANGELOG_CACHE__[key]);
    }
  });
  
  // Recupera i changelog mancanti in batch (max 50 alla volta per evitare timeout)
  const batchSize = 50;
  for (let i = 0; i < keysToFetch.length; i += batchSize) {
    const batch = keysToFetch.slice(i, i + batchSize);
    
    // Recupera in parallelo (con limitazione per non sovraccaricare l'API)
    const promises = batch.map(async (key) => {
      try {
        const raw = await jiraGetIssueRaw(token, key);
        // Salva in cache
        window.__EJ_CHANGELOG_CACHE__[key] = raw;
        result.set(key, raw);
      } catch (err) {
        console.warn(`Errore recupero changelog per ${key}:`, err);
        // In caso di errore, salva null in cache per evitare tentativi ripetuti
        window.__EJ_CHANGELOG_CACHE__[key] = null;
        result.set(key, null);
      }
    });
    
    await Promise.all(promises);
    
    // Piccola pausa tra batch per non sovraccaricare l'API
    if (i + batchSize < keysToFetch.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return result;
}

function hideNodeContextMenu() {
  if (nodeContextMenuEl) {
    nodeContextMenuEl.style.display = 'none';
    nodeContextMenuEl.dataset.key = '';
  }
}

/**
 * Estrae la data dell'ultima transizione allo status corrente dal changelog
 * @param {Object} raw - Dati raw dell'issue Jira (con changelog)
 * @param {string} currentStatus - Status corrente della card
 * @returns {Date|null} - Data dell'ultima transizione allo status corrente, o null se non trovata
 */
function getLastStatusTransitionDate(raw, currentStatus) {
  if (!raw?.changelog?.histories || !currentStatus) return null;
  
  const histories = raw.changelog.histories;
  // Cerca dall'ultima modifica alla prima (ordine cronologico inverso)
  for (let i = histories.length - 1; i >= 0; i--) {
    const history = histories[i];
    if (!history.items || !Array.isArray(history.items)) continue;
    
    // Cerca transizioni di status
    for (const item of history.items) {
      if (item.field === 'status' && item.toString === currentStatus) {
        // Trovata transizione allo status corrente
        try {
          return new Date(history.created);
        } catch {
          return null;
        }
      }
    }
  }
  
  return null;
}

/**
 * Calcola e formatta il tempo trascorso da una data
 * @param {Date} date - Data di riferimento
 * @returns {string|null} - Stringa formattata (es. "3 dias (desde 15/01/2024)") o null
 */
function formatTimeInStatus(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
  
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  // Formatta la data
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const dateStr = `${day}/${month}/${year}`;
  
  // Determina l'unità di tempo
  if (diffDays === 0) {
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return diffMins <= 1 ? `menos de 1 minuto (desde ${dateStr})` : `${diffMins} minutos (desde ${dateStr})`;
    }
    return diffHours === 1 ? `1 hora (desde ${dateStr})` : `${diffHours} horas (desde ${dateStr})`;
  } else if (diffDays === 1) {
    return `1 dia (desde ${dateStr})`;
  } else {
    return `${diffDays} dias (desde ${dateStr})`;
  }
}

function showNodeContextMenu(event, nodeData, onInspect, onSearch) {
  ensureContextUi();
  if (!nodeContextMenuEl) return;
  const { clientX, clientY } = event;
  nodeContextMenuEl.style.display = 'block';
  nodeContextMenuEl.style.left = `${clientX + 6}px`;
  nodeContextMenuEl.style.top = `${clientY + 6}px`;
  nodeContextMenuEl.dataset.key = nodeData?.key || '';

  const inspectBtn = document.getElementById('ej-node-inspect-btn');
  const searchBtn = document.getElementById('ej-node-search-btn');
  const hideLater = () => hideNodeContextMenu();
  document.addEventListener('click', hideLater, { once: true });

  if (inspectBtn) {
    inspectBtn.onclick = (e) => {
      e.stopPropagation();
      hideNodeContextMenu();
      onInspect?.(nodeData);
    };
  }
  if (searchBtn) {
    searchBtn.onclick = (e) => {
      e.stopPropagation();
      hideNodeContextMenu();
      onSearch?.(nodeData);
    };
  }
}

async function inspectNodeDetails(nodeData) {
  try {
    logBootStep('INSPECT_NODE_START', { nodeKey: nodeData?.key });
    
    ensureContextUi();
    if (!inspectModal || !inspectContentEl) {
      logBootStep('INSPECT_NODE_ERROR', { error: 'inspectModal o inspectContentEl non disponibili', hasModal: !!inspectModal, hasContent: !!inspectContentEl });
      return;
    }
    
    const token = CURRENT_AUTH_TOKEN || (await getCreds()).token;
    logBootStep('INSPECT_NODE_FETCH_RAW', { nodeKey: nodeData.key, hasToken: !!token });
    
    const raw = await jiraGetIssueRaw(token, nodeData.key);
    logBootStep('INSPECT_NODE_RAW_RECEIVED', { 
      nodeKey: nodeData.key,
      hasRaw: !!raw,
      rawKeys: raw ? Object.keys(raw).slice(0, 10) : [],
      rawSize: raw ? JSON.stringify(raw).length : 0
    });
    
    // Salva i dati raw nel dataset del modale per il bump list
    const rawDataStr = JSON.stringify(raw);
    inspectModal.dataset.rawData = rawDataStr;
    logBootStep('INSPECT_NODE_RAW_SAVED', { 
      nodeKey: nodeData.key,
      rawDataLength: rawDataStr.length,
      hasDataset: !!inspectModal.dataset.rawData,
      datasetLength: inspectModal.dataset.rawData?.length || 0
    });
    
    // Nascondi la sezione bump list quando si carica un nuovo nodo
    const bumpSection = document.getElementById('ej-inspect-bump-section');
    const bumpToggleBtn = document.getElementById('ej-inspect-bump-toggle');
    const bumpContentEl = document.getElementById('ej-inspect-bump-content');
    
    logBootStep('INSPECT_NODE_BUMP_ELEMENTS', {
      hasBumpSection: !!bumpSection,
      hasBumpToggleBtn: !!bumpToggleBtn,
      hasBumpContentEl: !!bumpContentEl,
      bumpSectionVisible: bumpSection?.classList.contains('visible')
    });
    
    if (bumpSection) {
      bumpSection.classList.remove('visible');
      logBootStep('INSPECT_NODE_BUMP_HIDDEN', {});
    }
    if (bumpToggleBtn) {
      bumpToggleBtn.textContent = 'Bump list extended';
      logBootStep('INSPECT_NODE_BUMP_BTN_RESET', {});
    }

    const category = String(nodeData.category || '').toLowerCase();
    let kind = 'task';
    if (category === 'bug' || category === 'mobile_bug') kind = 'bug';
    else if (category === 'story') kind = 'story';
    else if (category === 'test') kind = 'test';

    const fields = buildCompositeFields(raw, kind);
    const summary = raw.fields?.summary || nodeData.summary || '';
    const description = buildCompositeTextFromRaw(raw, kind);
    const status = raw.fields?.status?.name || nodeData.status || '';
    const assignee = raw.fields?.assignee?.displayName || nodeData.assignee || '';

    const lines = [
      `Key: ${nodeData.key}`,
      `Issuetype: ${raw.fields?.issuetype?.name || nodeData.issuetype || ''}`,
      `Status: ${status}`
    ];

    // Aggiungi "Time in [Status]" se disponibile dal changelog
    if (status) {
      const lastTransitionDate = getLastStatusTransitionDate(raw, status);
      if (lastTransitionDate) {
        const timeInStatus = formatTimeInStatus(lastTransitionDate);
        if (timeInStatus) {
          lines.push(`Time in ${status}: ${timeInStatus}`);
        }
      }
    }

    lines.push(
      `Assignee: ${assignee}`,
      `Summary: ${summary}`,
      `Category: ${category}`
    );

    if (description) {
      lines.push('', 'Description:', description.trim());
    }

    const compositeEntries = Object.entries(fields || {});
    if (compositeEntries.length) {
      lines.push('', 'Dettagli:');
      compositeEntries.forEach(([key, value]) => {
        lines.push(`${key}: ${value}`);
      });
    }

    const finalText = lines.join('\n');
    const titleEl = document.getElementById('ej-inspect-title');
    if (titleEl) titleEl.textContent = `Inspect ${nodeData.key}`;
    inspectContentEl.textContent = finalText || '(nessun dato disponibile)';
    inspectBackdrop.style.display = 'block';
    inspectModal.style.display = 'block';
    
    logBootStep('INSPECT_NODE_COMPLETE', {
      nodeKey: nodeData.key,
      contentLength: finalText.length,
      modalDisplay: inspectModal.style.display,
      backdropDisplay: inspectBackdrop.style.display,
      hasRawData: !!inspectModal.dataset.rawData
    });
  } catch (err) {
    logBootStep('INSPECT_NODE_ERROR_FINAL', {
      error: err.message,
      stack: err.stack,
      nodeKey: nodeData?.key
    });
    console.error('Inspect node error', err);
    setStatus(`Inspect node: ${err.message || err}`, false);
  }
}

function renderForceGraph(nodes, links, epicKey, groups = { hierLinks: [], relLinks: [] }, options = {}) {
  const layoutMode = options.layout || 'default';
  const svgNode = svg.node();
  svg.selectAll('*').remove();

  const rect = svgNode.getBoundingClientRect();
  width = rect.width || window.innerWidth;
  height = rect.height || (window.innerHeight - 56);
  svg.attr('width', width).attr('height', height);
  const stage = svg.append('g').attr('class', 'stage');

  // ===== UI: menu contestuale + modale "Explicação" =====
  ensureContextUi();

  function showMenu(x, y, payload) {
    const menu = document.getElementById('ej-ai-menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';

    const hide = () => { menu.style.display = 'none'; document.removeEventListener('click', hide, true); };
    setTimeout(() => document.addEventListener('click', hide, true), 0);

    const btn = document.getElementById('ej-ai-explicacao');
    btn.onclick = async () => {
      menu.style.display = 'none';

      const {
        sourceText,
        targetText,
        score,
        method,
        fromKey,
        toKey,
        reason,
        sourceFields,
        targetFields,
        sourceRaw,
        targetRaw,
        sourceKind,
        targetKind,
        aiKey,
        // Backward compatibility con vecchi payload (se esistono)
        bugText,
        taskText,
        bugFields,
        taskFields,
        bugRaw,
        taskRaw
      } = payload;
      
      // Fallback per backward compatibility
      const actualSourceText = sourceText || bugText || '';
      const actualTargetText = targetText || taskText || '';
      const actualSourceFields = sourceFields || bugFields || {};
      const actualTargetFields = targetFields || taskFields || {};
      const actualSourceRaw = sourceRaw || bugRaw || null;
      const actualTargetRaw = targetRaw || taskRaw || null;
      const actualSourceKind = sourceKind || 'bug';
      const actualTargetKind = targetKind || 'task';

      // --- FUNZIONE PER ESTRARRE TESTO DA ADF ---
      function extractADFText(node) {
        if (!node) return '';
        if (Array.isArray(node)) return node.map(extractADFText).join(' ');
        if (typeof node === 'string') return node;
        if (node.type === 'text') return node.text || '';
        if (node.content) return extractADFText(node.content);
        return '';
      }

      // 🔧 Parser universale per Jira fields (supporta HTML, ADF e testo normale)
      const parseJiraFieldValue = (rawValue, renderedValue) => {
        // 1️⃣ Se Jira ha fornito già l'HTML "renderedFields", usalo
        if (typeof renderedValue === 'string' && renderedValue.trim()) {
          const div = document.createElement('div');
          div.innerHTML = renderedValue;
          return div.textContent.trim();
        }

        // 2️⃣ Se il rawValue è un oggetto Atlassian Document Format (ADF)
        if (rawValue && typeof rawValue === 'object' && rawValue.type === 'doc') {
          return extractADFText(rawValue).trim();
        }

        // 3️⃣ Se è una stringa semplice
        if (typeof rawValue === 'string') {
          return rawValue.trim();
        }

        // 4️⃣ Fallback: prova comunque extractADFText per oggetti ADF senza type='doc'
        if (rawValue && typeof rawValue === 'object' && rawValue !== null) {
          const extracted = extractADFText(rawValue);
          if (extracted) return extracted.trim();
        }

        // 5️⃣ Ultimo fallback
        return '';
      };

      // --- DEFINIZIONE DEI CAMPI PREVISTI ---
      const BUG_EXPECTED_FIELDS = [
        'Description',
        'Expected Results',
        'Steps to Reproduce',
        'Analysis',
        'Possible Solution',
        'Chosen Solution',
        'Summary of Changes'
      ];

      const TASK_EXPECTED_FIELDS = [
        'Description',
        'Possible Solution',
        'Chosen Solution',
        'Summary of Changes'
      ];
      
      const STORY_EXPECTED_FIELDS = [
        'Description'
      ];
      
      const TEST_EXPECTED_FIELDS = [
        'Description'
      ];

      // --- FORMATTAZIONE DEI CAMPI PREVISTI (ORA CON SUMMARY + STEPS SOLO PER BUG) ---
      const formatExpectedFields = (title, rawData, expectedList, kind) => {
        if (!rawData) {
          return `──────────────────────────────
${title}
──────────────────────────────
(nessun campo trovato)

`;
        }

        const lines = [];

        // 🔹 1) SUMMARY sempre in testa (Bug & Task)
        let summary = '';
        try {
          // Prova a trovarlo nelle names
          const summaryField = Object.entries(rawData.names || {}).find(([k, v]) =>
            String(v || '').toLowerCase() === 'summary' || String(k || '').toLowerCase() === 'summary'
          );
          if (summaryField) {
            const [key] = summaryField;
            summary = parseJiraFieldValue(rawData.fields?.[key], rawData.renderedFields?.[key]);
          } else {
            // Fallback diretto su fields.summary / renderedFields.summary
            summary = parseJiraFieldValue(rawData.fields?.summary, rawData.renderedFields?.summary);
          }
        } catch {}

        lines.push(`• Summary: ${summary || '(non trovato)'}`);

        // 🔹 2) STEPS TO REPRODUCE → SOLO PER BUG
        if (kind === 'bug') {
          let steps = '';

          // 1️⃣ Prova dai renderedFields (HTML già pronto)
          if (rawData?.renderedFields?.customfield_10101) {
            const div = document.createElement('div');
            div.innerHTML = rawData.renderedFields.customfield_10101;
            steps = div.textContent.trim();
          }
          // 2️⃣ Se non c'è HTML, prova dai fields (ADF)
          else if (rawData?.fields?.customfield_10101) {
            steps = extractADFText(rawData.fields.customfield_10101);
          }

          lines.push(`• Steps to Reproduce: ${steps || '(non trovato)'}`);
        }

        // 🔹 3) DESCRIPTION (robusto, come prima)
        let desc = '';
        const descFieldKey = Object.entries(rawData.names || {}).find(([k, v]) =>
          v.toLowerCase().includes('description')
        );
        if (descFieldKey) {
          const [key] = descFieldKey;
          desc = parseJiraFieldValue(rawData.fields?.[key], rawData.renderedFields?.[key]);
        }
        // Fallback manuale se parseJiraFieldValue non ha funzionato
        if (!desc && rawData?.fields?.description) {
          desc = extractADFText(rawData.fields.description);
        }
        if (!desc && rawData?.renderedFields?.description) {
          const div = document.createElement('div');
          div.innerHTML = rawData.renderedFields.description;
          desc = div.textContent.trim();
        }
        lines.push(`• Description: ${desc || '(non trovato)'}`);

        // 🔹 4) Altri campi previsti (escludendo Steps/Description già gestiti)
        const otherFields = expectedList.filter(f => {
          const lower = f.toLowerCase();
          return lower !== 'steps to reproduce' && lower !== 'description';
        });

        const otherLines = otherFields.map((fieldName) => {
          const jiraFieldKey = Object.entries(rawData.names || {}).find(([k, v]) =>
            v.toLowerCase().includes(fieldName.toLowerCase())
          );
          const fieldKey = jiraFieldKey ? jiraFieldKey[0] : null;
          const rawValue = fieldKey ? rawData.fields?.[fieldKey] : null;
          const renderedValue = fieldKey ? rawData.renderedFields?.[fieldKey] : null;
          const parsed = parseJiraFieldValue(rawValue, renderedValue);
          return `• ${fieldName}: ${parsed || '(non trovato)'}`;
        });

        lines.push(...otherLines);

        return `──────────────────────────────
${title}
──────────────────────────────
${lines.join('\n')}

`;
      };

      // Helper per scegliere icona e campi in base al kind
      const getIconForKind = (kind) => {
        if (kind === 'bug') return '🐞';
        if (kind === 'task') return '🧩';
        if (kind === 'story') return '📖';
        if (kind === 'test') return '🧪';
        return '📋';
      };
      
      const getFieldsForKind = (kind) => {
        if (kind === 'bug') return BUG_EXPECTED_FIELDS;
        if (kind === 'task') return TASK_EXPECTED_FIELDS;
        if (kind === 'story') return STORY_EXPECTED_FIELDS;
        if (kind === 'test') return TEST_EXPECTED_FIELDS;
        return ['Description'];
      };
      
      const sourceIcon = getIconForKind(actualSourceKind);
      const targetIcon = getIconForKind(actualTargetKind);
      const sourceFieldsList = getFieldsForKind(actualSourceKind);
      const targetFieldsList = getFieldsForKind(actualTargetKind);
      
      const sourceSection = formatExpectedFields(
        `${sourceIcon} ${actualSourceKind.toUpperCase()}: ${fromKey}`, 
        actualSourceRaw, 
        sourceFieldsList, 
        actualSourceKind
      );
      const targetSection = formatExpectedFields(
        `${targetIcon} ${actualTargetKind.toUpperCase()}: ${toKey}`, 
        actualTargetRaw, 
        targetFieldsList, 
        actualTargetKind
      );

      // 🔥 QUI CHIAMIAMO OPENAI PER LA COMPARAZIONE TRIANGOLARE
      const epicKey = CURRENT_EPIC_KEY || '';
      const exp = await window.EJ_AI.explainLinkPTBR(
        actualSourceText || '',
        actualTargetText || '',
        score || 0,
        method || 'jaccard',
        reason || '',
        { epicKey, aiKey, sourceKind: actualSourceKind, targetKind: actualTargetKind }
      );

      // --- Contenuto base del modale (SENZA "Testo Composito") ---
      const detail = `
${sourceSection}${targetSection}

──────────────────────────────
🧠 COMPARAZIONE TRIANGOLARE (OpenAI)
──────────────────────────────

${exp}

<br><br>

<button id="dumpSource" style="background:#1976d2;color:#fff;border:none;padding:6px 10px;margin:4px;cursor:pointer;border-radius:6px;">🔵 Dump ${fromKey} Fields</button>

<button id="dumpTarget" style="background:#388e3c;color:#fff;border:none;padding:6px 10px;margin:4px;cursor:pointer;border-radius:6px;">🟢 Dump ${toKey} Fields</button>

<div id="sourceDump" style="display:none;white-space:pre-wrap;font-size:12px;background:#f8f8f8;border:1px solid #ccc;border-radius:8px;padding:8px;margin-top:6px;"></div>

<div id="targetDump" style="display:none;white-space:pre-wrap;font-size:12px;background:#f8f8f8;border:1px solid #ccc;border-radius:8px;padding:8px;margin-top:6px;"></div>

`;

      // --- Mostra il modale ---
      showModal(detail);

      // --- Gestione pulsanti dump ---
      setTimeout(() => {
        const btnSource = document.getElementById('dumpSource');
        const btnTarget = document.getElementById('dumpTarget');
        const divSource = document.getElementById('sourceDump');
        const divTarget = document.getElementById('targetDump');

        const prettyJSON = (data) => JSON.stringify(data, null, 2);

        if (btnSource) {
          btnSource.onclick = () => {
            divSource.style.display = divSource.style.display === 'none' ? 'block' : 'none';
            if (divSource.innerText.trim() === '') {
              divSource.innerText = prettyJSON({
                fields: actualSourceRaw?.fields || {},
                names: actualSourceRaw?.names || {},
                renderedFields: actualSourceRaw?.renderedFields || {}
              });
            }
          };
        }

        if (btnTarget) {
          btnTarget.onclick = () => {
            divTarget.style.display = divTarget.style.display === 'none' ? 'block' : 'none';
            if (divTarget.innerText.trim() === '') {
              divTarget.innerText = prettyJSON({
                fields: actualTargetRaw?.fields || {},
                names: actualTargetRaw?.names || {},
                renderedFields: actualTargetRaw?.renderedFields || {}
              });
            }
          };
        }
      }, 200);
    };
  }

  // Layer dedicato alle connessioni AI (rosse temporanee)
  const aiLayer = stage.append('g').attr('class', 'ai-links');
  let aiTempLinks = []; // {source, target, score, method}

  let aiRevealTimeouts = [];

  function cancelAiReveal() {
    aiRevealTimeouts.forEach(id => clearTimeout(id));
    aiRevealTimeouts = [];
  }

  // 🔧 Helper: aggiorna posizione dei link AI in base alle coordinate correnti dei nodi
  function updateAiLinkPositions() {
    aiLayer.selectAll('line.ai')
      .attr('x1', d => {
        const s = nodes.find(n => n.id === d.source);
        return s ? s.x : 0;
      })
      .attr('y1', d => {
        const s = nodes.find(n => n.id === d.source);
        return s ? s.y : 0;
      })
      .attr('x2', d => {
        const t = nodes.find(n => n.id === d.target);
        return t ? t.x : 0;
      })
      .attr('y2', d => {
        const t = nodes.find(n => n.id === d.target);
        return t ? t.y : 0;
      });
  }

  const colorByCategory = (c) => {
    if (c === 'epic') return '#8b5cf6';
    if (c === 'story') return '#3b82f6';
    if (c === 'task' || c === 'mobile_task' || c === 'test_execution') return '#86efac';
    if (c === 'test') return '#166534';
    if (c === 'mobile_bug') return '#fecaca';
    if (c === 'bug') return '#ef4444';
    return '#94a3b8';
  };

  stage.append('defs');

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
        if (sid === epicKey || tid === epicKey) return 0.1;
        return 0.8;
      });

  const linkForce = d3.forceLink(links)
    .id(d => d.id)
    .distance(l => window.EJ_LAYOUT.linkDistance(l, nodes))
    .strength(l => window.EJ_LAYOUT.linkStrength(l));

  simulation = d3.forceSimulation(nodes)
    .force('link', linkForce)
    .force('center', d3.forceCenter(width / 2, height / 2));

  if (layoutMode === 'grid') {
    const { clusterIndex, clusterCenters, clusterSizes } = buildClusterLayout(nodes, links);
    const clusterForce = createClusterForce(nodes, clusterIndex, clusterCenters, 0.18);
    simulation
      .force('x', d3.forceX((d) => {
        const center = clusterCenters[clusterIndex.get(d.id)];
        return center ? center.x : width / 2;
      }).strength(0.55))
      .force('y', d3.forceY((d) => {
        const center = clusterCenters[clusterIndex.get(d.id)];
        return center ? center.y : height / 2;
      }).strength(0.65))
      .force('cluster', clusterForce)
      .force('charge', d3.forceManyBody().strength(-50))
      .force('collision', d3.forceCollide().radius(d => {
        const clusterId = clusterIndex.get(d.id);
        const size = clusterSizes.get(clusterId) || 1;
        return 12 + Math.sqrt(size) * 6;
      }));
  } else {
    simulation
      .force('charge', d3.forceManyBody().strength(d => window.EJ_LAYOUT.nodeCharge(d)))
      .force('collision', d3.forceCollide().radius(d => d.id === epicKey ? 10 : 7));
  }

  const node = stage.append('g')
    .selectAll('g.node')
    .data(nodes)
    .join('g')
      .attr('class', 'node')
      .call(makeDrag(simulation));

  let tempLink = null;
  let linkStart = null;

  function startLink(event, d) {
    if (!event.altKey) return;
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

  // Piccolo scheduler per ridurre i ridisegni consecutivi
  let __ej_drawScheduled = false;
  function scheduleDraw() {
    if (__ej_drawScheduled) return;
    __ej_drawScheduled = true;
    requestAnimationFrame(() => { __ej_drawScheduled = false; drawAiLinks(); });
  }

  async function handleNodeContextMenu(event, d) {
    let escListener = null;
    try {
      cancelAiReveal();

      // Categorie supportate per AI-link
      const INCLUDED_CATEGORIES = ['bug', 'mobile_bug', 'task', 'mobile_task', 'story', 'test'];
      const category = String(d.category || '').toLowerCase();
      
      if (!INCLUDED_CATEGORIES.includes(category)) {
        setStatus('AI-link: funziona su Bug, Task, Story e Test (esclusi Epic, Test Execution, Subtask).', false);
        return;
      }

      setDisplayThreshold(DEFAULT_MIN_SCORE, { updateSlider: true, triggerRedraw: false });

      const token = CURRENT_AUTH_TOKEN;
      const sourceKey = d.key;
      const epicKey = CURRENT_EPIC_KEY || '';

      // Determina il 'kind' per buildCompositeTextFromRaw
      let sourceKind = 'bug';
      if (category === 'task' || category === 'mobile_task') sourceKind = 'task';
      else if (category === 'story') sourceKind = 'story';
      else if (category === 'test') sourceKind = 'test';
      else if (category === 'bug' || category === 'mobile_bug') sourceKind = 'bug';

      setStatus(`AI-link: leggo descrizioni per ${sourceKey}…`);

      // 1) Nodo sorgente: raw + testo composito
      const sourceRaw = await jiraGetIssueRaw(token, sourceKey);
      const sourceText = buildCompositeTextFromRaw(sourceRaw, sourceKind);
      const sourceFields = buildCompositeFields(sourceRaw, sourceKind);

      if (!sourceText) {
        setStatus(`Impossibile leggere i campi di ${sourceKey}.`, false);
        return;
      }

      setStatus(`AI-link: ${sourceKey} → testo composto (${sourceText.length} chars).`);

      // 2) Nodi candidati nel grafo (tutte le categorie supportate, eccetto il nodo sorgente)
      const targetNodes = [];
      svg.selectAll('g.node').data().forEach(n => {
        if (n && INCLUDED_CATEGORIES.includes(String(n.category || '').toLowerCase()) && n.key !== sourceKey) {
          targetNodes.push(n);
        }
      });

      if (!targetNodes.length) {
        setStatus('Nessun nodo candidato nel grafico.', false);
        return;
      }

      // Conta nodi per categoria (diagnostica)
      const categoryCount = {};
      targetNodes.forEach(n => {
        const cat = String(n.category || 'unknown').toLowerCase();
        categoryCount[cat] = (categoryCount[cat] || 0) + 1;
      });
      const catSummary = Object.entries(categoryCount)
        .map(([cat, count]) => `${count} ${cat}`)
        .join(', ');
      console.log(`[AI-link] Nodi candidati per categoria: ${catSummary}`);

      // Soglie / limiti (embeddings come filtro)
      const TOP_N = Infinity;
      const SEARCH_THRESHOLD = DEFAULT_MIN_SCORE / 100;
      const CONCURRENCY = 1; // valutazione davvero sequenziale (un nodo alla volta)

      // Pulizia stato AI precedente
      cancelAiReveal();
      aiTempLinks = [];
      aiLayer.selectAll('line.ai').remove();
      aiExplainMap.clear();
      updateSimilarityControlVisibility(false);

      const targetKeys = targetNodes.map(n => n.key);
      const targetRawMap = new Map();
      const targetFieldsMap = new Map();
      const descMap = new Map();

      let accepted = 0;

      // 3) STREAMING CON POOL: embeddings come filtro per-target → disegna subito se plausibile
      const aiKey = await getAiKey();
      const specMeta = window.EJ_SPECS_CACHE[epicKey];
      const tag = specMeta && specMeta.ok
        ? `con SPECs (${specMeta.success}/${specMeta.urls.length})`
        : '(senza SPECs utili)';
      if (!aiKey) {
        setStatus(`AI-link: manca chiave OpenAI — impossibile usare embeddings come filtro ${tag}.`, false);
        return;
      }
      setStatus(`AI-link: scan embeddings di ${targetKeys.length} nodi (${catSummary}) ${tag}…`);

      // cache globale opzionale
      window.__EJ_RAW_CACHE__ = window.__EJ_RAW_CACHE__ || {};
      const queue = targetKeys.slice();
      let cancelled = false;
      let processed = 0;
      const total = targetKeys.length;

      escListener = (ev) => {
        if (ev.key === 'Escape') {
          cancelled = true;
          queue.length = 0;
          setStatus('AI-link: ricerca annullata (ESC).', false);
        }
      };
      document.addEventListener('keydown', escListener, { once: false });
      
      // Contatori diagnostici
      let skippedNoDescription = 0;
      let skippedShortText = 0;
      let skippedLowScore = 0;

      // Timeout + retry per chiamata embeddings (per-target)
      const TIMEOUT_MS = 12000;
      async function withTimeout(promise, ms) {
        return await Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
        ]);
      }
      async function callEmbeddingsOnce(item) {
        return await withTimeout(
          window.EJ_AI.computeBugTaskSimilarities(
            sourceText,
            [item],
            aiKey,
            { epicKey }
          ),
          TIMEOUT_MS
        );
      }
      async function callEmbeddingsWithRetry(item) {
        let delay = 600;
        for (let i = 0; i < 2; i++) { // due retry rapidi con backoff
          try {
            return await callEmbeddingsOnce(item);
          } catch (e) {
            if (cancelled) return null;
            await new Promise(r => setTimeout(r, delay));
            delay *= 2;
          }
        }
        try {
          return await callEmbeddingsOnce(item);
        } catch {
          return null; // fallback: salta il nodo target
        }
      }

      async function processOne(key) {
        let matched = false;
        try {
          // raw con cache
          let raw = window.__EJ_RAW_CACHE__[key];
          if (!raw) {
            raw = await jiraGetIssueRaw(token, key);
            window.__EJ_RAW_CACHE__[key] = raw;
          }
          
          // Determina il kind del target
          const targetNode = targetNodes.find(n => n.key === key);
          const targetCategory = String(targetNode?.category || '').toLowerCase();
          let targetKind = 'task';
          if (targetCategory === 'bug' || targetCategory === 'mobile_bug') targetKind = 'bug';
          else if (targetCategory === 'task' || targetCategory === 'mobile_task') targetKind = 'task';
          else if (targetCategory === 'story') targetKind = 'story';
          else if (targetCategory === 'test') targetKind = 'test';
          
          targetRawMap.set(key, raw);
          targetFieldsMap.set(key, buildCompositeFields(raw, targetKind));
          const text = buildCompositeTextFromRaw(raw, targetKind) || '';
          descMap.set(key, text);

          if (cancelled) return;
          // Skip nodi senza description (ottimizzazione: evita chiamate embeddings inutili)
          const hasDescription = raw?.fields?.description || raw?.renderedFields?.description;
          if (!hasDescription) {
            skippedNoDescription++;
            return;
          }
          if (text.trim().length < 15) {
            skippedShortText++;
            return; // descrizione insignificante
          }
          if (accepted >= TOP_N) { cancelled = true; return; }

          // Embeddings come filtro: con timeout + retry; se fallisce → skip nodo
          const quick = await callEmbeddingsWithRetry({ id: key, key, text });
          if (!quick) return;

          if (cancelled) return;
          const s = quick && quick[0];
          if (!s || s.score < SEARCH_THRESHOLD) {
            skippedLowScore++;
            return;
          }

          accepted++;
          const pairKey = `${sourceKey}->${key}`;

          aiTempLinks.push({
            source: sourceKey,
            target: key,
            score: s.score,
            method: s._method || 'embeddings'
          });

          aiExplainMap.set(pairKey, {
            fromKey: sourceKey,
            toKey: key,
            sourceText,
            targetText: text,
            sourceFields,
            targetFields: targetFieldsMap.get(key),
            sourceRaw,
            targetRaw: raw,
            sourceKind,
            targetKind,
            score: s.score,
            method: s._method || 'embeddings',
            reason: s._reason || 'Embeddings gating (SPEC-aware).',
            aiKey
          });

          scheduleDraw();
          setStatus(`AI-link: embeddings ${sourceKey} ↔ ${key} ≈ ${(s.score * 100).toFixed(1)}% (${processed+1}/${total})`);
          matched = true;

          if (accepted >= TOP_N) { cancelled = true; }
        } catch (e) {
          // ignora nodi malformati
        } finally {
          processed++;
          if (!matched && !cancelled) {
            setStatus(`AI-link: scan embeddings di ${total} nodi ${tag} (${processed}/${total})…`, !!(specMeta && specMeta.ok));
          }
        }
      }

      async function worker() {
        while (!cancelled && queue.length) {
          const key = queue.shift();
          await processOne(key);
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, targetKeys.length) }, () => worker());
      await Promise.all(workers);

      // Log diagnostico finale
      console.log(`[AI-link] Risultati: ${accepted} match accettati, ${processed} nodi processati`);
      console.log(`[AI-link] Filtrati: ${skippedNoDescription} senza description, ${skippedShortText} testo corto, ${skippedLowScore} score basso (<${DEFAULT_MIN_SCORE}%)`);

      if (accepted === 0) {
        setStatus(
          `AI-link: nessuna corrispondenza ≥ ${DEFAULT_MIN_SCORE}% con embeddings.`,
          false
        );
      }

    } catch (e) {
      console.error('AI-link error', e);
      setStatus(`AI-link: errore ${e.message || e}`, false);
    } finally {
      if (escListener) {
        document.removeEventListener('keydown', escListener);
      }
    }
  }

  const getCurrentThreshold = () => {
    const percent = Math.max(1, Math.min(100, Number(displayThreshold) || DEFAULT_MIN_SCORE));
    return percent / 100;
  };

  // Ridisegna i link rossi a partire da aiTempLinks (gradiente per score)
  function drawAiLinks(customThreshold) {
    updateSimilarityControlVisibility(aiTempLinks.length > 0);
    if (!aiTempLinks.length) {
      aiLayer.selectAll('line.ai').remove();
      return;
    }

    const threshold = typeof customThreshold === 'number' ? customThreshold : getCurrentThreshold();
    const visibleLinks = aiTempLinks.filter(l => {
      if (l.score < threshold) return false;
      return isNodeKeyVisible(l.source) && isNodeKeyVisible(l.target);
    });

    if (!visibleLinks.length) {
      aiLayer.selectAll('line.ai').remove();
      return;
    }

    // Scala assoluta: 0.50 → rosa chiaro, 0.80 → rosso pieno, >0.80 → rosso quasi nero
    const MIN_GRAD = 0.50;  // 50%
    const MAX_GRAD = 0.80;  // 80%

    const light = { r: 254, g: 226, b: 226 }; // rosa molto chiaro (~50%)
    const dark  = { r: 185, g: 28,  b: 28  }; // rosso pieno (~80%)
    const ultra = { r: 30,  g: 3,   b: 3   }; // rosso quasi nero (>80%)

    const lerp = (a, b, t) => a + (b - a) * t;

    function colorForScore(scoreRaw) {
      // scoreRaw è nello [0,1]
      let s = Number(scoreRaw) || 0;
      if (s < 0) s = 0;
      if (s > 1) s = 1;

      // Sotto il 50% → sempre rosa chiaro
      if (s <= MIN_GRAD) {
        return `rgb(${light.r},${light.g},${light.b})`;
      }

      // Sopra l'80% → gradiente dal rosso pieno al rosso quasi nero
      if (s >= MAX_GRAD) {
        const tHigh = (s - MAX_GRAD) / (1 - MAX_GRAD || 1); // mappa [0.80,1] → [0,1]
        const r = Math.round(lerp(dark.r, ultra.r, tHigh));
        const g = Math.round(lerp(dark.g, ultra.g, tHigh));
        const b = Math.round(lerp(dark.b, ultra.b, tHigh));
        return `rgb(${r},${g},${b})`;
      }

      // Tra 50% e 80% → gradiente da rosa chiaro a rosso pieno
      const t = (s - MIN_GRAD) / (MAX_GRAD - MIN_GRAD || 1);
      const r = Math.round(lerp(light.r, dark.r, t));
      const g = Math.round(lerp(light.g, dark.g, t));
      const b = Math.round(lerp(light.b, dark.b, t));
      return `rgb(${r},${g},${b})`;
    }

    aiLayer.selectAll('title').remove();

    const sel = aiLayer.selectAll('line.ai')
      .data(visibleLinks, d => `${d.source}->${d.target}`);

    const enter = sel.enter()
      .append('line')
        .attr('class', 'ai')
        .attr('stroke-width', 2.2)
        .attr('stroke-dasharray', '6 3')
        .attr('opacity', 0.95)
        .attr('pointer-events', 'stroke'); // necessario per hover
    enter.append('title');

    const merged = enter.merge(sel);

    // stile + interazioni (context menu + hover percentuale)
    merged
      .attr('stroke', d => colorForScore(d.score))
      .on('contextmenu', function(ev, d) {
        ev.preventDefault();
        const pairKey = `${d.source}->${d.target}`;
        const payload = aiExplainMap.get(pairKey) || {
          score: d.score,
          method: d.method,
          fromKey: d.source,
          toKey: d.target,
          bugText: '',
          taskText: '',
          bugFields: {},
          taskFields: {},
          bugRaw: null,
          taskRaw: null,
          reason: ''
        };
        showMenu(ev.clientX, ev.clientY, payload);
      })
      .on('mouseover', (event, d) => {
        if (!tooltip) return;
        tooltip
          .style('opacity', 1)
          .html(
            `<strong>${d.source} → ${d.target}</strong><br>` +
            `Similarità: ${(d.score * 100).toFixed(1)}%`
          );
      })
      .on('mousemove', (event) => {
        if (!tooltip) return;
        tooltip
          .style('left', `${event.pageX + 8}px`)
          .style('top', `${event.pageY - 10}px`);
      })
      .on('mouseout', () => {
        if (!tooltip) return;
        tooltip.style('opacity', 0);
      });

    // testo del tooltip nativo SVG (title) – utile anche senza il div tooltip
    merged.select('title')
      .text(d => `Similarità ${(d.score * 100).toFixed(1)}%`);

    sel.exit().remove();

    // 👉 POSIZIONA SUBITO le linee in base alle coordinate attuali
    updateAiLinkPositions();
  }

  node.on('mousedown', startLink);

  window.EJ_REDRAW_AI_LINKS = (threshold) => {
    const t = typeof threshold === 'number' ? threshold : getCurrentThreshold();
    drawAiLinks(t);
  };

  node.each(function(d) {
    const g = d3.select(this);
    const R = d.id === epicKey ? 10 : 7;

    g.append('circle')
      .attr('r', R)
      .attr('fill', colorByCategory(d.category))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.25);

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

  currentGraphState.nodeSelection = node;
  currentGraphState.labelSelection = label;
  currentGraphState.linkSelection = link;
  currentGraphState.aiLayer = aiLayer;
  
  // Se Time Inertia è attivo, riattivalo dopo il ridisegno
  if (timeInertiaActive && node && node.size() > 0) {
    // Usa setTimeout per assicurarsi che il rendering sia completato
    setTimeout(async () => {
      if (timeInertiaActive && currentGraphState.nodeSelection) {
        let token;
        try {
          token = CURRENT_AUTH_TOKEN || (await getCreds()).token;
        } catch {
          return; // Silently fail se non ci sono credenziali
        }
        
        const nodeKeys = [];
        currentGraphState.nodeSelection.each(d => {
          if (!isExcludedStatus(d.status)) {
            nodeKeys.push(d.key);
          }
        });
        
        if (nodeKeys.length > 0) {
          const changelogMap = await fetchChangelogsForNodes(token, nodeKeys);
          updateTimeInertiaHalos(currentGraphState.nodeSelection, changelogMap);
        }
      }
    }, 100);
  }
  currentGraphState.nodes = nodes;
  currentGraphState.links = links;
  const nodesMap = new Map();
  nodes.forEach(n => {
    nodesMap.set(n.id, n);
    nodesMap.set(n.key, n);
  });
  currentGraphState.nodesByKey = nodesMap;
  applyStatusFilters();

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

    // Allinea i link AI temporanei (non fanno parte della force)
    updateAiLinkPositions();

    node.attr('transform', d => `translate(${d.x},${d.y})`);
    label.attr('x', d => d.x).attr('y', d => d.y - (d.id === epicKey ? 10 : 7));
  });

  window.addEventListener('resize', () => {
    const r = svg.node().getBoundingClientRect();
    svg.attr('width', r.width).attr('height', r.height);
    simulation.force('center', d3.forceCenter(r.width / 2, r.height / 2)).alpha(0.2).restart();
  });

  // Doppio click sullo sfondo = pulisci i link AI temporanei
  svg.on('dblclick', () => {
    cancelAiReveal();
    aiTempLinks = [];
    aiExplainMap.clear();
    aiLayer.selectAll('line.ai').remove();
    updateSimilarityControlVisibility(false);
    setStatus('AI-link temporanei rimossi.');
  });

  const zoom = d3.zoom()
    .filter(ev => (ev.type === 'wheel' && ev.ctrlKey) || (ev.type === 'mousedown' && (ev.button === 1 || ev.buttons === 4)))
    .scaleExtent([0.2, 5])
    .wheelDelta((ev) => ev.deltaY * -0.004)
    .on('zoom', (ev) => stage.attr('transform', ev.transform));
  svg.call(zoom);
  svg.node().addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
}

function buildClusterLayout(nodes, links) {
  if (!Array.isArray(nodes) || !nodes.length) {
    return {
      clusterIndex: new Map(),
      clusterCenters: [{ x: width / 2, y: height / 2 }],
      clusterSizes: new Map()
    };
  }

  const adjacency = new Map();
  nodes.forEach(node => adjacency.set(node.id, new Set()));

  links.forEach(link => {
    const src = typeof link.source === 'object' ? link.source.id || link.source.key : link.source;
    const tgt = typeof link.target === 'object' ? link.target.id || link.target.key : link.target;
    if (!src || !tgt) return;
    if (!adjacency.has(src) || !adjacency.has(tgt)) return;
    adjacency.get(src).add(tgt);
    adjacency.get(tgt).add(src);
  });

  const visited = new Set();
  const clusters = [];
  nodes.forEach(node => {
    if (visited.has(node.id)) return;
    const stack = [node.id];
    const component = [];
    visited.add(node.id);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      const neighbours = adjacency.get(current);
      if (!neighbours) continue;
      neighbours.forEach(next => {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      });
    }
    clusters.push(component);
  });

  const clusterIndex = new Map();
  const clusterSizes = new Map();
  clusters.forEach((cluster, idx) => {
    clusterSizes.set(idx, cluster.length);
    cluster.forEach(id => clusterIndex.set(id, idx));
  });

  const clusterCount = clusters.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusterCount)));
  const rows = Math.max(1, Math.ceil(clusterCount / columns));
  const baseSpacingX = 220 / 3;
  const baseSpacingY = 180 / 3;
  const offsetX = width / 2 - ((columns - 1) * baseSpacingX) / 2;
  const offsetY = height / 2 - ((rows - 1) * baseSpacingY) / 2;
  const clusterCenters = clusters.map((cluster, idx) => ({
    x: offsetX + (idx % columns) * baseSpacingX,
    y: offsetY + Math.floor(idx / columns) * baseSpacingY
  }));

  nodes.forEach(node => {
    const clusterId = clusterIndex.get(node.id);
    const center = clusterCenters[clusterId];
    if (!center) return;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      node.x = center.x + (Math.random() - 0.5) * 30;
      node.y = center.y + (Math.random() - 0.5) * 30;
    }
  });

  return { clusters, clusterIndex, clusterCenters, clusterSizes };
}

function createClusterForce(nodes, clusterIndex, clusterCenters, strength = 0.15) {
  return function clusterForce(alpha) {
    nodes.forEach(node => {
      const clusterId = clusterIndex.get(node.id);
      const center = clusterCenters[clusterId];
      if (!center || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      node.vx += (center.x - node.x) * strength * alpha;
      node.vy += (center.y - node.y) * strength * alpha;
    });
  };
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

// =============== ADF (Atlassian Doc Format) -> testo semplice ===============
function adfToPlain(adf) {
  // Gestione base: concatena testo dei nodi 'text', 'paragraph', 'heading', 'bulletList/orderedList'
  try {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;
    const out = [];
    (function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      const t = node.type;
      if (t === 'text' && node.text) out.push(node.text);
      if (node.content) walk(node.content);
      if (t === 'paragraph' || t === 'heading') out.push('\n');
      if (t === 'hardBreak') out.push('\n');
      if (t === 'bulletList' || t === 'orderedList') {
        (node.content||[]).forEach(li => walk(li));
        out.push('\n');
      }
    })(adf);
    return out.join(' ').replace(/\s+\n\s+/g, '\n').replace(/\s{2,}/g, ' ').trim();
  } catch { return ''; }
}

// ======= COMPOSITE TEXT (BUG/TASK) =======
// Identificatori "umani" (titoli campo) da cercare nel map "names" di Jira.
// NOTA: match case-insensitive e tollerante (regex).
const BUG_FIELD_PATTERNS = [
  /expected\s*results?/i,
  /steps?\s*to\s*reproduce/i,
  /analysis/i,
  /possible\s*solutions?/i,
  /chosen\s*solution/i,
  /summary\s*of\s*changes?/i
];

const TASK_FIELD_PATTERNS = [
  /possible\s*solutions?/i,
  /chosen\s*solution/i,
  /summary\s*of\s*changes?/i
];

// Converte un valore di campo in testo semplice (ADF, HTML, plain).
function _fieldToText(val) {
  try {
    if (!val) return '';
    // ADF (Atlassian Doc Format) come object
    if (typeof val === 'object') {
      return adfToPlain(val) || '';
    }
    // Stringa: potrebbe essere HTML o plain
    const s = String(val);
    if (/<\s*\w+[\s>]/.test(s)) {
      // HTML → testo
      return _htmlToText(s) || '';
    }
    return s;
  } catch {
    return '';
  }
}

// Dato raw.names (id → humanName), ritorna l'elenco di id che matchano i patterns.
function _collectFieldIds(namesMap, patterns) {
  const ids = [];
  try {
    for (const [fieldId, humanName] of Object.entries(namesMap || {})) {
      const n = String(humanName || '');
      if (patterns.some(rx => rx.test(n))) ids.push(fieldId);
    }
  } catch {}
  return ids;
}

// Estrae un testo renderizzato (preferendo renderedFields se disponibile).
function _getRenderedOrPlainField(raw, fieldId) {
  try {
    const rendered = raw?.renderedFields?.[fieldId];
    if (rendered) {
      // rendered può essere HTML
      return _fieldToText(rendered);
    }
  } catch {}
  // fallback: raw.fields[fieldId] può essere ADF/HTML/plain
  try {
    const plain = raw?.fields?.[fieldId];
    return _fieldToText(plain);
  } catch {
    return '';
  }
}

// Costruisce il testo "composito" per un'issue raw, secondo il "kind" ("bug", "task", "story", "test").
// Include SEMPRE la Description come base; poi concatena i campi richiesti.
function buildCompositeTextFromRaw(raw, kind = 'bug') {
  if (!raw) return '';

  const chunks = [];

  const getRenderedOrPlain = (key) => {
    const html = raw.renderedFields?.[key];
    if (html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return div.textContent.trim();
    }
    const val = raw.fields?.[key];
    if (!val) return '';
    if (typeof val === 'object') {
      const extractText = (node) => {
        if (Array.isArray(node)) return node.map(extractText).join(' ');
        if (node.type === 'text') return node.text || '';
        if (node.content) return extractText(node.content);
        return '';
      };
      return extractText(val.content || val).trim();
    }
    return String(val).trim();
  };

  const tryFieldByName = (nameMatch) => {
    const found = Object.entries(raw.names || {}).find(([key, label]) =>
      label?.toLowerCase().includes(nameMatch.toLowerCase())
    );
    if (found) {
      const [key, label] = found;
      const val = getRenderedOrPlain(key);
      if (val) chunks.push(`${label}:\n${val}`);
    }
  };

  // 🔹 SUMMARY sempre per primo (tutti i tipi)
  const summaryText = getRenderedOrPlain('summary');
  if (summaryText) {
    chunks.push(`Summary:\n${summaryText}`);
  }

  // Description sempre inclusa
  tryFieldByName('description');

  // 🔹 Per STORY e TEST: solo Summary + Description (già inclusi sopra)
  if (kind === 'story' || kind === 'test') {
    return chunks.join('\n\n');
  }

  // 🔹 STEPS TO REPRODUCE: SOLO SE kind === 'bug'
  if (
    kind === 'bug' &&
    (raw.fields?.customfield_10101 || raw.renderedFields?.customfield_10101)
  ) {
    const steps = getRenderedOrPlain('customfield_10101');
    if (steps) {
      chunks.push(`Steps to Reproduce:\n${steps}`);
    }
  }

  // Expected Results, Analysis, Possible Solution, ecc. (solo per BUG e TASK)
  tryFieldByName('expected results');
  tryFieldByName('analysis');
  tryFieldByName('possible solution');
  tryFieldByName('chosen solution');
  tryFieldByName('summary of changes');

  return chunks.join('\n\n');
}

// Estrae i campi compositi come oggetto chiave/valore
function buildCompositeFields(raw, kind = 'bug') {
  const names = raw?.names || {};
  const fields = raw?.fields || {};
  const out = {};
  
  // 🔹 SUMMARY sempre per primo
  try {
    let summaryText = '';
    if (raw?.renderedFields?.summary) {
      summaryText = _fieldToText(raw.renderedFields.summary);
    } else {
      summaryText = _fieldToText(fields.summary);
    }
    if (summaryText) {
      out.Summary = summaryText.trim();
    }
  } catch {}
  
  // Description sempre inclusa
  try {
    if (raw?.renderedFields?.description) {
      out.Description = _fieldToText(raw.renderedFields.description);
    } else {
      out.Description = _fieldToText(fields.description);
    }
  } catch {}
  
  // 🔹 Per STORY e TEST: solo Summary + Description (già inclusi sopra)
  const kindLower = String(kind).toLowerCase();
  if (kindLower === 'story' || kindLower === 'test') {
    return out;
  }
  
  // Pattern in base al tipo (solo per BUG e TASK)
  const patterns = (kindLower === 'task') ? TASK_FIELD_PATTERNS : BUG_FIELD_PATTERNS;
  const ids = _collectFieldIds(names, patterns);
  
  // ORDER
  const ORDER = (kindLower === 'task')
    ? [/possible\s*solutions?/i, /chosen\s*solution/i, /summary\s*of\s*changes?/i]
    : [/expected\s*results?/i, /steps?\s*to\s*reproduce/i, /analysis/i, /possible\s*solutions?/i, /chosen\s*solution/i, /summary\s*of\s*changes?/i];
  
  ORDER.forEach(rx => {
    const id = ids.find(fid => rx.test(String(names[fid] || '')));
    if (!id) return;
    const human = String(names[id] || '').trim();
    const val = _getRenderedOrPlainField(raw, id);
    if (val?.trim()) {
      out[human] = val.trim();
    }
  });
  
  return out;
}

// === Fetch "raw" per 1..N issue e costruzione testo composito ===
async function fetchCompositeText(token, key, kind = 'bug') {
  const raw = await jiraGetIssueRaw(token, key);
  return buildCompositeTextFromRaw(raw, kind);
}

// Batch: ritorna Map(key → compositeText)
async function fetchCompositeMap(token, keys, kind = 'task') {
  const out = new Map();
  if (!Array.isArray(keys) || !keys.length) return out;
  for (const k of keys) {
    try {
      const raw = await jiraGetIssueRaw(token, k);
      out.set(k, buildCompositeTextFromRaw(raw, kind));
    } catch {
      out.set(k, '');
    }
  }
  return out;
}

// =============== Lettura description per N issue (batch) ====================
async function fetchIssuesWithDescription(token, keys) {
  if (!keys?.length) return new Map();
  const MAX = 50;
  const result = new Map(); // key -> plainDescription
  for (let i = 0; i < keys.length; i += MAX) {
    const chunk = keys.slice(i, i + MAX);
    const jql = `key in (${chunk.join(',')})`;
    // Qui chiediamo esplicitamente la 'description'
    const issues = await jiraSearch(token, jql, ['summary','issuetype','description']).catch(() => []);
    for (const it of issues) {
      const k = it.key;
      const adf = it.fields?.description || '';
      const plain = adfToPlain(adf);
      result.set(k, plain);
    }
  }
  return result;
}

async function fetchSingleDescription(token, key) {
  const m = await fetchIssuesWithDescription(token, [key]);
  return m.get(key) || '';
}

// UI wiring
(async () => {
  logBootStep('BOOT_START', { message: 'Inizio bootstrap applicazione' });
  
  // Rinnovo cache ad ogni apertura della pagina
  window.EJ_SPECS_CACHE = {};
  window.__EJ_LAST_EPIC_RAW__ = {};
  
  logBootStep('BOOT_INIT_CACHE', { message: 'Cache inizializzate' });
  
  ensureContextUi(); // garantisce che backdrop+modal esistano sempre
  logBootStep('BOOT_CONTEXT_UI', { message: 'Context UI assicurato' });
  
  epicSelect = epicSelect || document.getElementById('epicSelect');
  if (!epicSelect) {
    logBootStep('BOOT_ERROR', { error: 'Elemento epicSelect non trovato nel DOM' });
    console.error('Elemento epicSelect non trovato nel DOM.');
    return;
  }
  logBootStep('BOOT_EPIC_SELECT_FOUND', { element: !!epicSelect });
  
  const params = new URLSearchParams(location.search);
  
  // Progress bar per il primo caricamento (sottile, alla base dell'header)
  const bootProgress = createProgressStatusBar('Avvio…', { variant: 'thin' });
  logBootStep('BOOT_PROGRESS_BAR', { message: 'Progress bar creata' });

  epicSelect.addEventListener('change', () => {
    const opt = epicSelect.value;
    if (!opt) return;
    
    // Gestione Minor Fixes
    if (opt === MINOR_FIXES_OPTION) {
      showMinorFixesModal();
      return;
    }
    
    // Gestione A specific Epic
    if (opt === SPECIFIC_EPIC_OPTION) {
      showSpecificEpicModal();
      return;
    }
    
    // reset soft per evitare riuso di SPEC vecchie
    if (window.EJ_SPECS_CACHE) window.EJ_SPECS_CACHE[opt] = undefined;
    loadGraph(opt);
  });

  try {
    bootProgress.update('Verifica credenziali…', 10);
    logBootStep('BOOT_GET_CREDS_START', { message: 'Richiesta credenziali' });
    const { token } = await getCreds();
    logBootStep('BOOT_GET_CREDS_OK', { hasToken: !!token });
    
    bootProgress.update('Carico epici della sprint attiva…', 25);
    setStatus('Carico epici della sprint attiva…');
    logBootStep('BOOT_FETCH_EPICS_START', { message: 'Fetch epici sprint attiva' });
    const epics = await fetchActiveSprintEpics(token);
    logBootStep('BOOT_FETCH_EPICS_OK', { count: epics.length, keys: epics.map(e => e.key) });
    
    bootProgress.update(`Trovati ${epics.length} epici`, 45);
    const epicOptions = epics.map(e => ({ value: e.key, label: `${e.key} — ${e.summary || ''}` }));
    logBootStep('BOOT_POPULATE_SELECT_START', { optionsCount: epicOptions.length });
    populateEpicSelect(epicOptions);
    logBootStep('BOOT_POPULATE_SELECT_OK', { message: 'Select popolato' });
    
    const epicParam = params.get('epic');
    if (epicParam) {
      const norm = normalizeEpicKey(epicParam);
      const found = epics.find(e => e.key === norm);
      if (found) epicSelect.value = norm;
    }
    if (!epicSelect.value && epicOptions.length) {
      epicSelect.value = epicOptions[0].value;
    }
    if (!epicSelect.value) {
      epicSelect.value = NO_EPIC_OPTION;
    }
    
    logBootStep('BOOT_SELECTED_EPIC', { 
      selectedEpic: epicSelect.value,
      hasBuildAssigneeFilters: typeof window.buildAssigneeFilters === 'function',
      hasBuildTypeFilters: typeof window.buildTypeFilters === 'function'
    });
    
    if (epicSelect.value) {
      bootProgress.update(`Carico grafo per ${epicSelect.value}…`, 65);
      logBootStep('BOOT_LOAD_GRAPH_START', { epicKey: epicSelect.value });
      await loadGraph(epicSelect.value);
      logBootStep('BOOT_LOAD_GRAPH_OK', { epicKey: epicSelect.value });
      bootProgress.update('Completato', 100);
    } else {
      setStatus('Select Epics in Actual Sprint', true);
      bootProgress.update('In attesa di selezione…', 80);
    }
  } catch (e) {
    logBootStep('BOOT_ERROR', { error: e.message, stack: e.stack });
    console.error(e);
    populateEpicSelect();
    setStatus('Impossibile caricare gli epici della sprint attiva. Verifica credenziali.', false);
    bootProgress.update('Errore durante il caricamento', 100);
    await loadGraph(NO_EPIC_OPTION);
  } finally {
    logBootStep('BOOT_FINALLY', { message: 'Bootstrap completato' });
    setTimeout(() => bootProgress.close(), 600);
  }

  function buildSpecEntries(meta) {
    if (!meta || !meta.text) return [];
    const sections = String(meta.text)
      .split(/\n\n-----\n\n/)
      .filter(Boolean);
    return sections.map(section => {
      const match = section.match(/^\[\[URL:(.+?)\]\]\n([\s\S]*)$/);
      return {
        url: match ? match[1] : 'URL non disponibile',
        text: match ? match[2] : section
      };
    });
  }

  function renderSpecsDebugModal() {
    const currentEpic = CURRENT_EPIC_KEY || epicSelect?.value || '';
    const meta = (window.EJ_SPECS_CACHE && currentEpic) ? window.EJ_SPECS_CACHE[currentEpic] : null;

    ensureContextUi();
    const titleEl = document.querySelector('#ej-ai-modal h3');
    const preEl = document.getElementById('ej-ai-modal-text');

    if (!meta) {
      if (titleEl) titleEl.textContent = `Specs – ${currentEpic || '(n/d)'}`;
      if (preEl) preEl.textContent = 'Nessuna informazione sulle SPEC disponibile per questo epico.';
      document.getElementById('ej-ai-backdrop').style.display = 'block';
      document.getElementById('ej-ai-modal').style.display = 'block';
      return;
    }

    const entries = buildSpecEntries(meta);
    const failures = Array.isArray(meta.failures) ? meta.failures : [];

    const logsHtml = meta.log?.length
      ? meta.log.map(line => escapeHtml(line)).join('<br>')
      : '(nessun log disponibile)';

    const successHtml = entries.length
      ? entries.map(entry => (
          `<details class="ej-spec-entry">
            <summary>${escapeHtml(entry.url)}</summary>
            <pre>${escapeHtml(entry.text)}</pre>
          </details>`
        )).join('\n')
      : '(nessuna SPEC caricata)';

    const failuresHtml = failures.length
      ? failures.map(f => `<li>${escapeHtml(f.url || 'URL sconosciuto')} — ${escapeHtml(f.error || 'errore sconosciuto')}</li>`).join('')
      : '(nessuna SPEC fallita)';

    const body = `
      <h4>Epico: ${escapeHtml(currentEpic || '(n/d)')}</h4>
      <p>SPEC trovate: ${entries.length} — Successi: ${meta.success || 0} — Fallite: ${meta.failed || 0}</p>
      <h4>Log</h4>
      <div class="ej-specs-log">${logsHtml}</div>
      <h4>SPEC caricate</h4>
      <div class="ej-specs-success">${successHtml}</div>
      <h4>SPEC fallite</h4>
      <ul class="ej-specs-failed">${failuresHtml}</ul>
    `;

    if (titleEl) titleEl.textContent = `Specs – ${currentEpic || '(n/d)'}`;
    if (preEl) {
      preEl.innerHTML = body;
    }
    document.getElementById('ej-ai-backdrop').style.display = 'block';
    document.getElementById('ej-ai-modal').style.display = 'block';
  }

  initSimilaritySlider();
  initFilterTabs();
  buildStatusFilterOptions();
  bindStatusFilterEvents();
  updateStatusSpecialCheckboxes();
  applyStatusFilters();

  const copyBtn = document.getElementById('copyDebug');
  const openSettingsBtn = document.getElementById('openSettings');
  openSettingsBtn?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  copyBtn?.addEventListener('click', async () => {
    const debug = {
      lastApiCall: lastApiDebug || { info: 'Nessuna chiamata ancora effettuata.' },
      bootLog: window.EJ_BOOT_LOG || [],
      summary: {
        bootLogEntries: (window.EJ_BOOT_LOG || []).length,
        hasBuildAssigneeFilters: typeof window.buildAssigneeFilters === 'function',
        hasBuildTypeFilters: typeof window.buildTypeFilters === 'function',
        currentEpic: CURRENT_EPIC_KEY,
        assigneesCount: currentGraphState?.assignees?.length || 0
      }
    };
    const text = JSON.stringify(debug, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Diagnostica copiata negli appunti.', true);
    } catch (e) {
      console.error('Clipboard error', e);
      setStatus('Impossibile copiare negli appunti.', false);
    }
  });

  // Pulsante "Specs" accanto a "Copia diagnostica"
  if (copyBtn?.parentElement) {
    let specsBtn = document.getElementById('specsDebug');
    if (!specsBtn) {
      specsBtn = document.createElement('button');
      specsBtn.id = 'specsDebug';
      specsBtn.type = 'button';
      specsBtn.textContent = 'Specs';
      specsBtn.style.marginLeft = '8px';
      specsBtn.className = copyBtn.className || '';
      copyBtn.parentElement.insertBefore(specsBtn, copyBtn.nextSibling);
    }
    specsBtn.addEventListener('click', renderSpecsDebugModal);
  }

  viewSpecsBtn?.addEventListener('click', () => {
    // Recupera testo SPECs dalla cache dell'epico selezionato
    const currentEpic = epicSelect?.value || '';
    const meta = (window.EJ_SPECS_CACHE && currentEpic) ? window.EJ_SPECS_CACHE[currentEpic] : null;
    const text = meta?.text || '(Nenhum conteúdo de SPEC carregado.)';

    // Usa il modale già presente per le spiegazioni, ma con titolo e testo dinamici
    ensureContextUi(); // garantisce esistenza dei nodi UI
    const title = document.querySelector('#ej-ai-modal h3');
    const pre   = document.getElementById('ej-ai-modal-text');
    if (title) title.textContent = `SPECs de ${currentEpic}`;
    if (pre)   pre.textContent = text + `\n\n---\n` + (specsDiag.join('\n') || '(sem logs)');
    document.getElementById('ej-ai-backdrop').style.display = 'block';
    document.getElementById('ej-ai-modal').style.display = 'block';
  });

  const dumpEpicBtn = document.getElementById('dumpEpic');
  dumpEpicBtn?.addEventListener('click', async () => {
    try {
      const epic = CURRENT_EPIC_KEY || epicSelect?.value || '';
      if (!epic) { setStatus('Nessun épico selezionato.', false); return; }
      setStatus(`Interrogo épico ${epic}…`);
      const token = CURRENT_AUTH_TOKEN || (await getCreds()).token;
      const data = await jiraGetIssueRaw(token, epic);

      // Salva in cache per uso futuro (renderedFields)
      window.__EJ_LAST_EPIC_RAW__ = window.__EJ_LAST_EPIC_RAW__ || {};
      window.__EJ_LAST_EPIC_RAW__[epic] = data;

      // Prepara un payload leggibile: id→name, renderedFields, e URL trovate
      const fieldNames = data.names || {};
      const rendered = data.renderedFields || {};
      const allUrls = extractAllUrlsFromJson(data);

      const dump = {
        key: data.key,
        fieldsAvailable: Object.keys(fieldNames).length,
        exampleFieldNames: Object.entries(fieldNames).slice(0, 25), // anteprima
        renderedFields: rendered, // HTML già renderizzato da Jira
        urlHits: allUrls.slice(0, 50), // anteprima 50 URL
        note: 'Cerca nei fieldNames la chiave che contiene i link. Se i link stanno in renderedFields, copiali da qui.'
      };

      // Mostra nel modale già esistente
      ensureContextUi();
      const title = document.querySelector('#ej-ai-modal h3');
      const pre   = document.getElementById('ej-ai-modal-text');
      if (title) title.textContent = `Dump épico ${epic}`;
      if (pre)   pre.textContent = JSON.stringify(dump, null, 2);
      document.getElementById('ej-ai-backdrop').style.display = 'block';
      document.getElementById('ej-ai-modal').style.display = 'block';

      setStatus(`Dump épico ${epic} pronto.`, true);
    } catch (e) {
      console.error(e);
      setStatus(e.message || String(e), false);
    }
  });

  function getInitials(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return '?';
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function buildAssigneeFilters() {
    logBootStep('BUILD_ASSIGNEES_ENTRY', { 
      hasPanel: !!document.getElementById('assigneePanel'),
      hasList: !!document.getElementById('assigneeFilterList'),
      assigneesCount: (currentGraphState?.assignees || []).length
    });
    
    const panel = document.getElementById('assigneePanel');
    const list = document.getElementById('assigneeFilterList');
    const allBtn = document.getElementById('assigneeSelectAll');
    const noneBtn = document.getElementById('assigneeSelectNone');
    if (!panel || !list) {
      logBootStep('BUILD_ASSIGNEES_EARLY_RETURN', { reason: 'Panel o list non trovati', hasPanel: !!panel, hasList: !!list });
      return;
    }
    const assignees = currentGraphState.assignees || [];
    logBootStep('BUILD_ASSIGNEES_START', { assigneesCount: assignees.length, assignees: assignees.map(a => ({ id: a.id, label: a.label })) });

    if (!panel.dataset.eventsBound) {
      panel.dataset.eventsBound = '1';
      allBtn?.addEventListener('click', () => {
        const list = currentGraphState.assignees || [];
        activeAssigneeFilters = new Set(list.map(a => a.id));
        buildAssigneeFilters();
        clearHoveredAssignee();
        applyStatusFilters();
      });
      noneBtn?.addEventListener('click', () => {
        activeAssigneeFilters = new Set();
        buildAssigneeFilters();
        clearHoveredAssignee();
        applyStatusFilters();
      });
    }

    list.innerHTML = '';
    if (!assignees.length) {
      const empty = document.createElement('p');
      empty.className = 'assignee-empty';
      empty.textContent = 'Nessun assignee disponibile.';
      list.appendChild(empty);
      clearHoveredAssignee();
      return;
    }

    if (activeAssigneeFilters === null) {
      activeAssigneeFilters = new Set(assignees.map(a => a.id));
    }

    assignees.forEach(item => {
      const option = document.createElement('label');
      option.className = 'assignee-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.assigneeId = item.id;
      checkbox.checked = activeAssigneeFilters.has(item.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          activeAssigneeFilters.add(item.id);
        } else {
          activeAssigneeFilters.delete(item.id);
        }
        applyStatusFilters();
      });

      const avatar = document.createElement('div');
      avatar.className = 'assignee-avatar';
      if (item.avatar) {
        const img = document.createElement('img');
        img.src = item.avatar;
        img.alt = item.label;
        avatar.appendChild(img);
      } else {
        avatar.textContent = getInitials(item.label);
      }

      const label = document.createElement('span');
      label.textContent = item.count ? `${item.label} (${item.count})` : item.label;

      option.append(checkbox, avatar, label);
      if (!option.dataset.hoverBound) {
        option.dataset.hoverBound = '1';
        option.addEventListener('mouseenter', () => setHoveredAssignee(item.id));
        option.addEventListener('mouseleave', clearHoveredAssignee);
      }
      list.appendChild(option);
    });

    updateHoverHighlights();
    logBootStep('BUILD_ASSIGNEES_COMPLETE', { 
      itemsAdded: assignees.length,
      listChildrenCount: list.children.length
    });
  }

  function buildTypeFilters() {
    const container = document.getElementById('typeFilterList');
    const allBtn = document.getElementById('typeSelectAll');
    const noneBtn = document.getElementById('typeSelectNone');
    if (!container) return;
    const types = currentGraphState.types || [];

    if (!container.dataset.eventsBound) {
      container.dataset.eventsBound = '1';
      allBtn?.addEventListener('click', () => {
        const list = currentGraphState.types || [];
        activeTypeFilters = new Set(list.map(t => t.id));
        buildTypeFilters();
        clearHoveredType();
        applyStatusFilters();
      });
      noneBtn?.addEventListener('click', () => {
        activeTypeFilters = new Set();
        buildTypeFilters();
        clearHoveredType();
        applyStatusFilters();
      });
    }

    container.innerHTML = '';
    if (!types.length) {
      const empty = document.createElement('p');
      empty.className = 'assignee-empty';
      empty.textContent = 'Nessun tipo disponibile.';
      container.appendChild(empty);
      clearHoveredType();
      return;
    }

    if (activeTypeFilters === null) {
      activeTypeFilters = new Set(types.map(t => t.id));
    }

    types.forEach(item => {
      const option = document.createElement('label');
      option.className = 'filter-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.typeId = item.id;
      checkbox.checked = activeTypeFilters.has(item.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          activeTypeFilters.add(item.id);
        } else {
          activeTypeFilters.delete(item.id);
        }
        applyStatusFilters();
      });

      const text = document.createElement('span');
      text.textContent = item.count ? `${item.label} (${item.count})` : item.label;

      if (item.icon) {
        const icon = document.createElement('img');
        icon.src = item.icon;
        icon.alt = item.label;
        icon.width = 16;
        icon.height = 16;
        icon.style.marginRight = '8px';
        option.appendChild(icon);
      }

      option.append(checkbox, text);
      if (!option.dataset.hoverBound) {
        option.dataset.hoverBound = '1';
        option.addEventListener('mouseenter', () => setHoveredType(item.id));
        option.addEventListener('mouseleave', clearHoveredType);
      }
      container.appendChild(option);
    });

    updateHoverHighlights();
  }

  window.getInitials = getInitials;
  logBootStep('BOOT_EXPORT_BUILD_ASSIGNEES', { 
    message: 'Esportazione buildAssigneeFilters su window',
    isFunction: typeof buildAssigneeFilters === 'function'
  });
  window.buildAssigneeFilters = buildAssigneeFilters;
  logBootStep('BOOT_EXPORT_BUILD_ASSIGNEES_OK', { 
    windowHasIt: typeof window.buildAssigneeFilters === 'function'
  });
  
  logBootStep('BOOT_EXPORT_BUILD_TYPES', { 
    message: 'Esportazione buildTypeFilters su window',
    isFunction: typeof buildTypeFilters === 'function'
  });
  window.buildTypeFilters = buildTypeFilters;
  logBootStep('BOOT_EXPORT_BUILD_TYPES_OK', { 
    windowHasIt: typeof window.buildTypeFilters === 'function'
  });
  
  // Fix: Se loadGraph è già stato chiamato e ci sono assignees pronti, 
  // chiamiamo buildAssigneeFilters ora che è disponibile
  if (currentGraphState?.assignees?.length > 0) {
    logBootStep('BOOT_IIFE_RETRY_BUILD_ASSIGNEES', { 
      message: 'IIFE finito: retry buildAssigneeFilters se loadGraph già chiamato',
      assigneesCount: currentGraphState.assignees.length
    });
    // Usa setTimeout per dare tempo al DOM di essere pronto
    setTimeout(() => {
      if (typeof window.buildAssigneeFilters === 'function' && currentGraphState?.assignees?.length > 0) {
        logBootStep('BOOT_IIFE_CALL_BUILD_ASSIGNEES', {});
        window.buildAssigneeFilters();
      }
      if (typeof window.buildTypeFilters === 'function' && currentGraphState?.types?.length > 0) {
        logBootStep('BOOT_IIFE_CALL_BUILD_TYPES', {});
        window.buildTypeFilters();
      }
    }, 50);
  }
})();

async function loadNoEpicCards(token) {
  // Pulizia cache changelog e reset Time Inertia
  window.__EJ_CHANGELOG_CACHE__ = {};
  timeInertiaActive = false;
  timeInertiaHover = false;
  
  // Carica data di ricalcolo Time Inertia dallo storage per NO_EPIC
  const storageKey = `timeInertiaBaseDate_${NO_EPIC_OPTION}`;
  try {
    const result = await chrome.storage.sync.get(storageKey);
    if (result[storageKey]) {
      timeInertiaBaseDate = new Date(result[storageKey]);
      const day = String(timeInertiaBaseDate.getDate()).padStart(2, '0');
      const month = String(timeInertiaBaseDate.getMonth() + 1).padStart(2, '0');
      const year = timeInertiaBaseDate.getFullYear();
      const recalcText = document.getElementById('ej-time-inertia-recalc-text');
      if (recalcText) {
        recalcText.textContent = `Dias re-calculados a partir do dia ${day}/${month}/${year}`;
      }
    } else {
      timeInertiaBaseDate = null;
      const recalcText = document.getElementById('ej-time-inertia-recalc-text');
      if (recalcText) {
        recalcText.textContent = '';
      }
    }
  } catch (err) {
    console.warn('Errore caricamento data Time Inertia:', err);
    timeInertiaBaseDate = null;
  }
  
  try {
    setStatus('Carico card senza epic…');
    const jql = 'sprint in openSprints() AND issuetype != Epic AND parent is EMPTY AND "Epic Link" is EMPTY AND status NOT IN (Closed, "Rejected & Closed", "Pending Development", Backlog)';
    const issues = await jiraSearch(token, jql).catch(() => []);

    if (!Array.isArray(issues) || issues.length === 0) {
      svg.selectAll('*').remove();
      currentGraphState.nodesByKey = new Map();
      currentGraphState.nodes = [];
      currentGraphState.links = [];
      currentGraphState.aiLayer = null;
      currentGraphState.assignees = [];
      activeAssigneeFilters = new Set();
      activeTypeFilters = new Set();
      buildAssigneeFilters();
      buildTypeFilters();
      applyStatusFilters();
      setStatus('Nessuna card senza epic nella sprint attiva.', true);
      return;
    }

    const nodeByKey = new Map();
    issues.forEach(issue => {
      if (!issue || !issue.key) return;
      const issuetypeName = issue.fields?.issuetype?.name || '';
      const lower = String(issuetypeName || '').toLowerCase();
      let category = getCategoryFromIssueType(issuetypeName);
      if (lower.includes('mobile') && category === 'task') category = 'mobile_task';
      if (lower.includes('mobile') && category === 'bug') category = 'mobile_bug';
      if (lower.includes('document')) category = 'document';
      if (lower.includes('test execution')) category = 'test_execution';
      if (lower === 'test') category = 'test';
      nodeByKey.set(issue.key, {
        id: issue.key,
        key: issue.key,
        summary: issue.fields?.summary || '',
        type: 'issue',
        issuetype: issuetypeName,
        issuetypeIcon: issue.fields?.issuetype?.iconUrl || '',
        category,
        status: normalizeStatusName(issue.fields?.status?.name),
        assignee: (issue.fields?.assignee?.displayName || issue.fields?.assignee?.name || '').trim(),
        assigneeId: issue.fields?.assignee?.accountId || issue.fields?.assignee?.name || '',
        assigneeAvatar: issue.fields?.assignee?.avatarUrls?.['24x24'] || issue.fields?.assignee?.avatarUrls?.['32x32'] || ''
      });
    });

    const issueByKey = new Map(issues.map(it => [it.key, it]));
    const relLinks = [];
    const pairSet = new Set();
    issueByKey.forEach(src => {
      if (!nodeByKey.has(src.key)) return;
      const linksArr = src.fields?.issuelinks || [];
      linksArr.forEach(l => {
        const linked = l.outwardIssue || l.inwardIssue;
        if (!linked || !linked.key) return;
        if (!nodeByKey.has(linked.key)) return;
        const a = src.key;
        const b = linked.key;
        const undirected = a < b ? `${a}--${b}` : `${b}--${a}`;
        if (pairSet.has(undirected)) return;
        relLinks.push({ source: a, target: b, kind: 'rel', label: l.type?.name || '' });
        pairSet.add(undirected);
      });
    });

    const nodes = Array.from(nodeByKey.values());

    const assigneeMap = new Map();
    const typeMap = new Map();
    nodes.forEach(node => {
      const id = getAssigneeKey(node);
      const label = (node.assignee || '').trim() || 'Unassigned';
      const avatar = node.assigneeAvatar || '';
      if (!assigneeMap.has(id)) {
        assigneeMap.set(id, { id, label, avatar, count: 0 });
      }
      assigneeMap.get(id).count += 1;

      const typeKey = (node.issuetype || '').trim() || 'Unknown';
      const typeIcon = node.issuetypeIcon || '';
      if (!typeMap.has(typeKey)) {
        typeMap.set(typeKey, { id: typeKey, label: typeKey, icon: typeIcon, count: 0 });
      }
      typeMap.get(typeKey).count += 1;
    });

    const assignees = Array.from(assigneeMap.values()).sort((a, b) => a.label.localeCompare(b.label));
    currentGraphState.assignees = assignees;
    const types = Array.from(typeMap.values()).sort((a, b) => a.label.localeCompare(b.label));
    currentGraphState.types = types;
    const assigneeIds = assignees.map(a => a.id);
    activeAssigneeFilters = new Set(assigneeIds);
    const typeIds = types.map(t => t.id);
    activeTypeFilters = new Set(typeIds);
    buildAssigneeFilters();
    buildTypeFilters();

    const visibleLinks = relLinks;
    renderForceGraph(nodes, visibleLinks, null, { hierLinks: [], relLinks }, { layout: 'grid' });
    setStatus(`Caricate ${nodes.length} card senza epic.`);
    applyStatusFilters();
  } catch (err) {
    console.error('Errore caricamento card senza epic:', err);
    setStatus(err.message || 'Errore nel caricamento delle card senza epic.', false);
  }
}

/**
 * Estrae il codice card da input vari (numero, codice completo, o URL)
 * @param {string} input - Input dell'utente (es: "10112", "FGC-10112", o URL completo)
 * @returns {string|null} - Codice card normalizzato (es: "FGC-10112") o null se non valido
 */
function parseCardInput(input) {
  if (!input || typeof input !== 'string') return null;
  
  const trimmed = input.trim();
  if (!trimmed) return null;
  
  // Caso 1: URL completo
  const urlMatch = trimmed.match(/\/browse\/([A-Z]+-\d+)/i);
  if (urlMatch) {
    return urlMatch[1].toUpperCase();
  }
  
  // Caso 2: Codice completo (es: FGC-10112)
  const codeMatch = trimmed.match(/^([A-Z]+)-(\d+)$/i);
  if (codeMatch) {
    return codeMatch[1].toUpperCase() + '-' + codeMatch[2];
  }
  
  // Caso 3: Solo numero (es: 10112) - assumiamo prefisso FGC
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    return 'FGC-' + numMatch[1];
  }
  
  return null;
}

/**
 * Estrae testo da un oggetto ADF (Atlassian Document Format)
 * @param {Object} node - Nodo ADF
 * @returns {string} - Testo estratto
 */
function extractADFText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractADFText).join(' ');
  if (node.type === 'text') return node.text || '';
  if (node.content) return extractADFText(node.content);
  return '';
}

/**
 * Parsa il testo della checklist in elementi strutturati
 * Il formato atteso è: "Nome - Status - Key - Descrizione"
 * Esempio: "Hugo - Bug Return To Do - FGC-3764 - When we select..."
 * @param {string} text - Testo della checklist
 * @returns {Array} - Array di elementi parsati
 */
function parseChecklistText(text) {
  if (!text || typeof text !== 'string') return [];
  
  const items = [];
  // Dividi per righe (può essere separato da \n, \r\n, o altri separatori)
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Prova a parsare il formato: "Nome - Status - Key - Descrizione"
    // Pattern: cattura tutto fino al primo " - ", poi status, poi key (FGC-XXXX), poi resto
    const match = trimmed.match(/^(.+?)\s*-\s*(.+?)\s*-\s*([A-Z]+-\d+)\s*-\s*(.+)$/);
    
    if (match) {
      const [, name, status, key, description] = match;
      items.push({
        name: name.trim(),
        status: status.trim(),
        key: key.trim(),
        description: description.trim(),
        fullText: trimmed
      });
    } else {
      // Se non matcha il formato completo, prova a cercare almeno la key
      const keyMatch = trimmed.match(/([A-Z]+-\d+)/);
      if (keyMatch) {
        items.push({
          name: trimmed,
          status: null,
          key: keyMatch[1],
          description: null,
          fullText: trimmed
        });
      } else {
        // Fallback: usa l'intera riga come nome
        items.push({
          name: trimmed,
          status: null,
          key: null,
          description: null,
          fullText: trimmed
        });
      }
    }
  }
  
  return items;
}

/**
 * Recupera le proprietà dell'issue (dove potrebbero essere salvate le checklist)
 * @param {string} token - Token di autenticazione
 * @param {string} issueKey - Chiave dell'issue
 * @returns {Object|null} - Proprietà della checklist o null
 */
async function fetchIssueProperties(token, issueKey) {
  try {
    // Elenca tutte le proprietà dell'issue
    const url = `${JIRA_BASE}/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json'
      },
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors'
    });
    
    if (!res.ok) {
      console.warn(`Errore nel recupero proprietà v3: ${res.status}`);
      // Prova anche con API v2
      const urlV2 = `${JIRA_BASE}/rest/api/2/issue/${encodeURIComponent(issueKey)}/properties`;
      const resV2 = await fetch(urlV2, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${token}`,
          'Accept': 'application/json'
        },
        credentials: 'omit',
        cache: 'no-store',
        mode: 'cors'
      });
      
      if (!resV2.ok) {
        return null;
      }
      
      const propertiesV2 = await resV2.json();
      // API v2 restituisce un array di chiavi
      if (Array.isArray(propertiesV2)) {
        const checklistData = {};
        for (const key of propertiesV2) {
          if (key && /checklist/i.test(key)) {
            try {
              const propUrl = `${JIRA_BASE}/rest/api/2/issue/${encodeURIComponent(issueKey)}/properties/${encodeURIComponent(key)}`;
              const propRes = await fetch(propUrl, {
                method: 'GET',
                headers: {
                  'Authorization': `Basic ${token}`,
                  'Accept': 'application/json'
                },
                credentials: 'omit',
                cache: 'no-store',
                mode: 'cors'
              });
              
              if (propRes.ok) {
                const propData = await propRes.json();
                checklistData[key] = propData;
              }
            } catch (e) {
              console.warn(`Errore nel recupero proprietà ${key}:`, e);
            }
          }
        }
        return Object.keys(checklistData).length > 0 ? checklistData : null;
      }
      
      return null;
    }
    
    const properties = await res.json();
    
    // Se l'API v3 restituisce un oggetto con 'keys', usa quello
    // Altrimenti potrebbe essere un array diretto
    let allKeys = [];
    if (properties.keys && Array.isArray(properties.keys)) {
      allKeys = properties.keys;
    } else if (Array.isArray(properties)) {
      allKeys = properties;
    }
    
    // Recupera TUTTE le proprietà (non solo quelle con "checklist" nel nome)
    // perché potrebbero avere nomi diversi
    const allProperties = {};
    for (const key of allKeys) {
      try {
        const propUrl = `${JIRA_BASE}/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties/${encodeURIComponent(key)}`;
        const propRes = await fetch(propUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${token}`,
            'Accept': 'application/json'
          },
          credentials: 'omit',
          cache: 'no-store',
          mode: 'cors'
        });
        
        if (propRes.ok) {
          const propData = await propRes.json();
          allProperties[key] = propData;
        }
      } catch (e) {
        console.warn(`Errore nel recupero proprietà ${key}:`, e);
      }
    }
    
    // Filtra quelle che potrebbero essere checklist
    const checklistData = {};
    Object.entries(allProperties).forEach(([key, value]) => {
      // Cerca "checklist" nel nome o nel contenuto
      if (/checklist/i.test(key) || 
          (typeof value === 'string' && /checklist/i.test(value)) ||
          (typeof value === 'object' && JSON.stringify(value).toLowerCase().includes('checklist'))) {
        checklistData[key] = value;
      }
    });
    
    return Object.keys(checklistData).length > 0 ? checklistData : (Object.keys(allProperties).length > 0 ? allProperties : null);
    
  } catch (error) {
    console.error('Errore nel recupero proprietà issue:', error);
    return null;
  }
}

/**
 * Estrae gli elementi della Checklist dall'endpoint herokuapp.com (app Checklistr2)
 * @param {string} issueKey - Chiave dell'issue (es: "FGC-10112")
 * @param {Object} progressBar - Oggetto progress bar opzionale per aggiornamenti di stato
 * @returns {Object} - {items: Array|null, debugInfo: Object}
 */
async function fetchChecklistFromHerokuapp(issueKey, progressBar = null) {
  const debugInfo = {
    source: 'herokuapp.com',
    url: null,
    status: null,
    error: null,
    itemsFound: 0,
    method: 'direct'
  };
  
  let createdTabId = null;
  
  try {
    const url = `https://issue-checklist-prod-2.herokuapp.com/issue/${encodeURIComponent(issueKey)}/panel`;
    debugInfo.url = url;
    
    if (progressBar) {
      progressBar.update('Cercando sessione Jira...', 10);
      progressBar.log('Verifico se esiste una tab Jira aperta');
    }
    
    // PROVA 1: Inietta uno script nella pagina Jira per fare la richiesta dal contesto della pagina
    // (dove i cookie di sessione sono disponibili)
    try {
      let jiraTab = null;
      const tabs = await chrome.tabs.query({ url: 'https://*.atlassian.net/*' });
      
      if (tabs && tabs.length > 0) {
        // Usa la prima scheda Jira trovata
        jiraTab = tabs[0];
        debugInfo.method = 'injected-script-existing-tab';
        if (progressBar) {
          progressBar.update('Tab Jira trovata, verifico disponibilità...', 20);
          progressBar.log(`Tab Jira trovata: ${jiraTab.url}`, 'success');
        }
        
        // Verifica che il content script sia pronto (con retry più lungo)
        let contentScriptReady = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const pingResult = await Promise.race([
              chrome.tabs.sendMessage(jiraTab.id, { action: 'ping' }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ping')), 5000))
            ]);
            if (pingResult === 'pong' || pingResult) {
              contentScriptReady = true;
              if (progressBar) {
                progressBar.log('Content script pronto', 'success');
              }
              break;
            }
          } catch (e) {
            if (progressBar && attempt < 9) {
              progressBar.log(`Tentativo ${attempt + 1}/10: content script non ancora pronto, attendo...`, 'warning');
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
        
        if (!contentScriptReady && progressBar) {
          progressBar.log('Content script non risponde, procedo comunque...', 'warning');
        }
        
        if (progressBar) {
          progressBar.update('Preparo navigazione alla pagina issue...', 25);
        }
      } else {
        // Nessuna tab Jira trovata, apri una in background
        // Prima apriamo una pagina Jira per avere i cookie di sessione, poi navighiamo al pannello
        const jiraBaseUrl = 'https://facilitygrid.atlassian.net';
        if (progressBar) {
          progressBar.update('Apertura tab Jira in background...', 15);
          progressBar.log(`Nessuna tab Jira trovata, apro una tab Jira per la sessione`);
        }
        
        const newTab = await chrome.tabs.create({
          url: jiraBaseUrl,
          active: false
        });
        createdTabId = newTab.id;
        jiraTab = newTab;
        debugInfo.method = 'injected-script-new-tab';
        
        if (progressBar) {
          progressBar.update('Attendo caricamento pagina Jira...', 20);
          progressBar.log(`Navigazione a ${jiraBaseUrl}`);
        }
        
        // Attendi che la tab sia completamente caricata (timeout aumentato a 240 secondi)
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Timeout caricamento tab Jira (240s)'));
          }, 240000);
          
          const checkTab = (tabId, changeInfo) => {
            if (tabId === newTab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(checkTab);
              clearTimeout(timeout);
              resolve();
            }
          };
          
          chrome.tabs.onUpdated.addListener(checkTab);
          
          // Controlla se è già caricata
          chrome.tabs.get(newTab.id, (tab) => {
            if (tab.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(checkTab);
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        
        if (progressBar) {
          progressBar.update('Pagina Jira caricata, navigo al pannello checklist...', 30);
          progressBar.log('Pagina Jira caricata, ora navigo al pannello checklist');
        }
        
        // Ora navighiamo al pannello checklist (dove il meta tag è presente)
        const panelUrl = `https://issue-checklist-prod-2.herokuapp.com/issue/${encodeURIComponent(issueKey)}/panel`;
        await chrome.tabs.update(newTab.id, { url: panelUrl });
        
        // Attendi che il pannello sia caricato
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Timeout caricamento pannello checklist (240s)'));
          }, 240000);
          
          const checkTab = (tabId, changeInfo) => {
            if (tabId === newTab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(checkTab);
              clearTimeout(timeout);
              resolve();
            }
          };
          
          chrome.tabs.onUpdated.addListener(checkTab);
          
          chrome.tabs.get(newTab.id, (tab) => {
            if (tab.status === 'complete' && tab.url && tab.url.includes(panelUrl)) {
              chrome.tabs.onUpdated.removeListener(checkTab);
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        
        if (progressBar) {
          progressBar.update('Pannello caricato, attendo checklist...', 40);
          progressBar.log('Pannello checklist caricato, attendo che meta tag prefetchedItems appaia nel DOM');
        }
      }
      
      if (jiraTab) {
        // Naviga direttamente all'URL del pannello herokuapp.com per avere il meta tag nel DOM
        // Il meta tag prefetchedItems è presente solo quando viene caricato il pannello dell'app Checklistr2
        const panelUrl = `https://issue-checklist-prod-2.herokuapp.com/issue/${encodeURIComponent(issueKey)}/panel`;
        const currentUrl = jiraTab.url || '';
        
        if (!currentUrl.includes(panelUrl) && !currentUrl.includes(`/browse/${issueKey}`)) {
          if (progressBar) {
            progressBar.update('Navigazione al pannello checklist...', 35);
            progressBar.log(`Navigo al pannello checklist: ${panelUrl}`);
          }
          
          // Naviga direttamente al pannello checklist (dove il meta tag è presente)
          await chrome.tabs.update(jiraTab.id, { url: panelUrl });
          
          // Attendi che la pagina sia caricata
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Timeout navigazione pannello checklist (240s)'));
            }, 240000);
            
            const checkTab = (tabId, changeInfo) => {
              if (tabId === jiraTab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(checkTab);
                clearTimeout(timeout);
                resolve();
              }
            };
            
            chrome.tabs.onUpdated.addListener(checkTab);
            
            // Controlla se è già caricata
            chrome.tabs.get(jiraTab.id, (tab) => {
              if (tab.status === 'complete' && tab.url && (tab.url.includes(panelUrl) || tab.url.includes(`/browse/${issueKey}`))) {
                chrome.tabs.onUpdated.removeListener(checkTab);
                clearTimeout(timeout);
                resolve();
              }
            });
          });
          
          if (progressBar) {
            progressBar.update('Pannello caricato, attendo checklist...', 40);
            progressBar.log('Pannello checklist caricato, attendo che meta tag prefetchedItems appaia nel DOM');
          }
        } else if (currentUrl.includes(`/browse/${issueKey}`)) {
          // Se siamo sulla pagina issue Jira, naviga al pannello
          if (progressBar) {
            progressBar.update('Navigazione al pannello checklist...', 35);
            progressBar.log(`Navigo dalla pagina issue al pannello checklist`);
          }
          
          await chrome.tabs.update(jiraTab.id, { url: panelUrl });
          
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Timeout navigazione pannello checklist (240s)'));
            }, 240000);
            
            const checkTab = (tabId, changeInfo) => {
              if (tabId === jiraTab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(checkTab);
                clearTimeout(timeout);
                resolve();
              }
            };
            
            chrome.tabs.onUpdated.addListener(checkTab);
            
            chrome.tabs.get(jiraTab.id, (tab) => {
              if (tab.status === 'complete' && tab.url && tab.url.includes(panelUrl)) {
                chrome.tabs.onUpdated.removeListener(checkTab);
                clearTimeout(timeout);
                resolve();
              }
            });
          });
          
          if (progressBar) {
            progressBar.update('Pannello caricato, attendo checklist...', 40);
            progressBar.log('Pannello checklist caricato, attendo che meta tag prefetchedItems appaia nel DOM');
          }
        } else {
          if (progressBar) {
            progressBar.update('Pannello già aperto, attendo checklist...', 40);
            progressBar.log('Siamo già sul pannello checklist corretto');
          }
        }
        
        // PROVA 1: Leggi il meta tag direttamente dal DOM (metodo preferito)
        if (progressBar) {
          progressBar.update('Attendo che meta tag prefetchedItems appaia...', 45);
          progressBar.log('Aspetto che il meta tag prefetchedItems appaia nel DOM della pagina');
        }
        
        let metaResult = null;
        try {
          const messageResult = await Promise.race([
            chrome.tabs.sendMessage(jiraTab.id, {
              action: 'readChecklistFromMeta'
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout attesa meta tag (240s)')), 240000)
            )
          ]);
          
          if (messageResult && messageResult.success && messageResult.items) {
            metaResult = messageResult.items;
            if (progressBar) {
              progressBar.update('Meta tag trovato, parsing dati...', 80);
              progressBar.log(`Meta tag prefetchedItems trovato nel DOM`, 'success');
            }
          } else if (messageResult && messageResult.error) {
            throw new Error(messageResult.error);
          }
        } catch (metaError) {
          if (progressBar) {
            progressBar.log(`Errore lettura meta tag: ${metaError.message}`, 'warning');
            progressBar.log('Provo metodo alternativo (fetch)...', 'warning');
          }
        }
        
        // Se il meta tag è stato letto con successo, usa quello
        if (metaResult && Array.isArray(metaResult)) {
          if (progressBar) {
            progressBar.update('Normalizzazione elementi checklist...', 90);
            progressBar.log(`Trovati ${metaResult.length} elementi nella checklist`);
          }
          
          // Normalizza gli elementi
          const normalizedItems = metaResult.map((item, index) => {
            let state = 'OPEN';
            if (item.state) {
              state = item.state;
            } else if (item.status) {
              state = item.status;
            } else if (item.checked !== undefined) {
              state = item.checked ? 'DONE' : 'OPEN';
            } else if (item.complete !== undefined) {
              state = item.complete ? 'DONE' : 'OPEN';
            }
            
            const name = item.summary || item.name || item.text || item.title || item.label || String(item) || `Item ${index + 1}`;
            
            let key = item.key || item.issueKey || item.issue || null;
            if (!key && name) {
              const keyMatch = name.match(/([A-Z]+-\d+)/);
              if (keyMatch) {
                key = keyMatch[1];
              }
            }
            
            return {
              index: index + 1,
              state: String(state).toUpperCase(),
              name: String(name),
              key: key,
              raw: item
            };
          });
          
          debugInfo.itemsFound = normalizedItems.length;
          debugInfo.method = 'meta-tag-dom';
          
          if (progressBar) {
            progressBar.update('Checklist recuperata con successo!', 100);
            progressBar.log(`Checklist recuperata: ${normalizedItems.length} elementi`, 'success');
          }
          
          // Chiudi la tab se l'abbiamo creata noi
          if (createdTabId) {
            try {
              await chrome.tabs.remove(createdTabId);
              if (progressBar) {
                progressBar.log('Tab Jira temporanea chiusa');
              }
            } catch (e) {
              console.warn('Errore chiusura tab:', e);
            }
          }
          
          return { items: normalizedItems, debugInfo };
        }
        
        // PROVA 2: Fallback - usa fetch (metodo vecchio)
        if (progressBar) {
          progressBar.update('Metodo alternativo: richiesta fetch...', 50);
          progressBar.log('Lettura meta tag fallita, provo con fetch a herokuapp.com');
        }
        
        let pageResult = null;
        const maxRetries = 3;
        let lastError = null;
        
        for (let retry = 0; retry < maxRetries; retry++) {
          try {
            if (progressBar && retry > 0) {
              progressBar.log(`Tentativo fetch ${retry + 1}/${maxRetries}...`, 'warning');
            }
            
            const messageResult = await Promise.race([
              chrome.tabs.sendMessage(jiraTab.id, {
                action: 'fetchChecklist',
                url: url
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout richiesta (240s)')), 240000)
              )
            ]);
            
            if (messageResult && messageResult.success && messageResult.html) {
              pageResult = messageResult;
              if (progressBar && retry > 0) {
                progressBar.log(`Richiesta fetch riuscita al tentativo ${retry + 1}`, 'success');
              }
              break;
            } else if (messageResult && messageResult.error) {
              lastError = new Error(messageResult.error);
              if (retry < maxRetries - 1) {
                const waitTime = 3000 * (retry + 1);
                if (progressBar) {
                  progressBar.log(`Errore: ${messageResult.error}. Riprovo tra ${waitTime/1000}s...`, 'warning');
                }
                await new Promise(resolve => setTimeout(resolve, waitTime));
              }
            }
          } catch (messageError) {
            lastError = messageError;
            if (retry < maxRetries - 1) {
              const waitTime = Math.min(3000 * (retry + 1), 15000);
              if (progressBar) {
                progressBar.log(`Errore: ${messageError.message}. Riprovo tra ${waitTime/1000}s...`, 'warning');
              }
              await new Promise(resolve => setTimeout(resolve, waitTime));
            }
          }
        }
        
        if (pageResult && pageResult.html) {
          if (progressBar) {
            progressBar.update('Estraggo dati dalla risposta HTML...', 70);
            progressBar.log('Risposta HTML ricevuta, cerco meta tag prefetchedItems');
          }
          
          // Cerca il meta tag prefetchedItems nell'HTML
          const metaMatch = pageResult.html.match(/<meta\s+name=["']prefetchedItems["']\s+content=["']([^"']+)["']/i);
          if (!metaMatch) {
            debugInfo.error = 'Meta tag prefetchedItems non trovato nella risposta HTML';
            if (progressBar) {
              progressBar.log('Meta tag prefetchedItems non trovato nell\'HTML', 'error');
            }
            // Chiudi la tab se l'abbiamo creata noi
            if (createdTabId) {
              try {
                await chrome.tabs.remove(createdTabId);
              } catch (e) {
                console.warn('Errore chiusura tab:', e);
              }
            }
            return { items: null, debugInfo };
          }
          
          if (progressBar) {
            progressBar.update('Decodifico dati JSON...', 80);
            progressBar.log('Meta tag trovato nell\'HTML, decodifico entità HTML');
          }
          
          // Decodifica le entità HTML (es: &quot; -> ")
          let jsonStr = metaMatch[1];
          const textarea = document.createElement('textarea');
          textarea.innerHTML = jsonStr;
          jsonStr = textarea.value;
          
          if (progressBar) {
            progressBar.update('Parsing dati checklist...', 85);
            progressBar.log('Parsing JSON dei dati della checklist');
          }
          
          // Parsa il JSON
          let prefetchedItems;
          try {
            prefetchedItems = JSON.parse(jsonStr);
          } catch (e) {
            debugInfo.error = `Errore nel parsing JSON: ${e.message}`;
            if (progressBar) {
              progressBar.log(`Errore parsing JSON: ${e.message}`, 'error');
            }
            // Chiudi la tab se l'abbiamo creata noi
            if (createdTabId) {
              try {
                await chrome.tabs.remove(createdTabId);
              } catch (e) {
                console.warn('Errore chiusura tab:', e);
              }
            }
            return { items: null, debugInfo };
          }
          
          if (!Array.isArray(prefetchedItems)) {
            debugInfo.error = 'prefetchedItems non è un array';
            if (progressBar) {
              progressBar.log('prefetchedItems non è un array', 'error');
            }
            // Chiudi la tab se l'abbiamo creata noi
            if (createdTabId) {
              try {
                await chrome.tabs.remove(createdTabId);
              } catch (e) {
                console.warn('Errore chiusura tab:', e);
              }
            }
            return { items: null, debugInfo };
          }
          
          if (progressBar) {
            progressBar.update('Normalizzazione elementi checklist...', 90);
            progressBar.log(`Trovati ${prefetchedItems.length} elementi nella checklist`);
          }
          
          // Normalizza gli elementi
          const normalizedItems = prefetchedItems.map((item, index) => {
            let state = 'OPEN';
            if (item.state) {
              state = item.state;
            } else if (item.status) {
              state = item.status;
            } else if (item.checked !== undefined) {
              state = item.checked ? 'DONE' : 'OPEN';
            } else if (item.complete !== undefined) {
              state = item.complete ? 'DONE' : 'OPEN';
            }
            
            const name = item.summary || item.name || item.text || item.title || item.label || String(item) || `Item ${index + 1}`;
            
            let key = item.key || item.issueKey || item.issue || null;
            if (!key && name) {
              const keyMatch = name.match(/([A-Z]+-\d+)/);
              if (keyMatch) {
                key = keyMatch[1];
              }
            }
            
            return {
              index: index + 1,
              state: String(state).toUpperCase(),
              name: String(name),
              key: key,
              raw: item
            };
          });
          
          debugInfo.itemsFound = normalizedItems.length;
          debugInfo.method = 'fetch-html';
          
          if (progressBar) {
            progressBar.update('Checklist recuperata con successo!', 100);
            progressBar.log(`Checklist recuperata: ${normalizedItems.length} elementi`, 'success');
          }
          
          // Chiudi la tab se l'abbiamo creata noi
          if (createdTabId) {
            try {
              await chrome.tabs.remove(createdTabId);
              if (progressBar) {
                progressBar.log('Tab Jira temporanea chiusa');
              }
            } catch (e) {
              console.warn('Errore chiusura tab:', e);
            }
          }
          
          return { items: normalizedItems, debugInfo };
        }
        
        // Se siamo arrivati qui, entrambi i metodi hanno fallito
        debugInfo.error = lastError ? lastError.message : 'Impossibile recuperare checklist';
        if (progressBar) {
          progressBar.log('Tutti i metodi falliti', 'error');
        }
        
        // Chiudi la tab se l'abbiamo creata noi
        if (createdTabId) {
          try {
            await chrome.tabs.remove(createdTabId);
          } catch (e) {
            console.warn('Errore chiusura tab:', e);
          }
        }
      }
    } catch (injectError) {
      // Se l'iniezione fallisce, continua con la richiesta diretta
      debugInfo.error = `Iniezione script fallita: ${injectError.message}. Provo richiesta diretta...`;
      if (progressBar) {
        progressBar.log(`Iniezione script fallita: ${injectError.message}`, 'warning');
        progressBar.log('Tento richiesta diretta come fallback...');
      }
      
      // Chiudi la tab se l'abbiamo creata noi
      if (createdTabId) {
        try {
          await chrome.tabs.remove(createdTabId);
        } catch (e) {
          console.warn('Errore chiusura tab:', e);
        }
      }
    }
    
    // PROVA 2: Richiesta diretta (fallback)
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        credentials: 'include',
        mode: 'cors'
      });
    } catch (corsError) {
      // Se fallisce con CORS, prova con 'omit'
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          credentials: 'omit',
          mode: 'cors'
        });
      } catch (error2) {
        debugInfo.error = `Errore CORS: ${error2.message || String(error2)}. La richiesta potrebbe essere bloccata dalle policy CORS del browser. Nota: assicurati che il permesso per herokuapp.com sia stato aggiunto al manifest.json e che l'estensione sia stata ricaricata.`;
        return { items: null, debugInfo };
      }
    }
    
    debugInfo.status = res.status;
    
    if (!res.ok) {
      debugInfo.error = `HTTP ${res.status}: ${res.statusText}`;
      return { items: null, debugInfo };
    }
    
    const html = await res.text();
    
    // Cerca il meta tag prefetchedItems
    const metaMatch = html.match(/<meta\s+name=["']prefetchedItems["']\s+content=["']([^"']+)["']/i);
    if (!metaMatch) {
      debugInfo.error = 'Meta tag prefetchedItems non trovato nella risposta HTML';
      return { items: null, debugInfo };
    }
    
    // Decodifica le entità HTML (es: &quot; -> ")
    let jsonStr = metaMatch[1];
    const textarea = document.createElement('textarea');
    textarea.innerHTML = jsonStr;
    jsonStr = textarea.value;
    
    // Parsa il JSON
    let prefetchedItems;
    try {
      prefetchedItems = JSON.parse(jsonStr);
    } catch (e) {
      debugInfo.error = `Errore nel parsing JSON: ${e.message}`;
      return { items: null, debugInfo };
    }
    
    if (!Array.isArray(prefetchedItems)) {
      debugInfo.error = 'prefetchedItems non è un array';
      return { items: null, debugInfo };
    }
    
    // Normalizza gli elementi
    const normalizedItems = prefetchedItems.map((item, index) => {
      // Estrai i campi dall'oggetto item
      // Formato atteso: { summary: "Hugo - Bug Return To Do - FGC-3764 - ...", state: "...", ... }
      let state = 'OPEN';
      if (item.state) {
        state = item.state;
      } else if (item.status) {
        state = item.status;
      } else if (item.checked !== undefined) {
        state = item.checked ? 'DONE' : 'OPEN';
      } else if (item.complete !== undefined) {
        state = item.complete ? 'DONE' : 'OPEN';
      }
      
      // Estrai il nome/descrizione
      const name = item.summary || item.name || item.text || item.title || item.label || String(item) || `Item ${index + 1}`;
      
      // Estrai la chiave Jira se presente nel summary (es: "FGC-3764")
      let key = item.key || item.issueKey || item.issue || null;
      if (!key && name) {
        const keyMatch = name.match(/([A-Z]+-\d+)/);
        if (keyMatch) {
          key = keyMatch[1];
        }
      }
      
      return {
        index: index + 1,
        state: String(state).toUpperCase(),
        name: String(name),
        key: key,
        raw: item
      };
    });
    
    debugInfo.itemsFound = normalizedItems.length;
    return { items: normalizedItems, debugInfo };
    
  } catch (error) {
    debugInfo.error = error.message || String(error);
    return { items: null, debugInfo };
  }
}

/**
 * Estrae gli elementi della Checklist da un'issue Jira
 * @param {string} token - Token di autenticazione
 * @param {string} issueKey - Chiave dell'issue (es: "FGC-10112")
 * @param {Object} progressBar - Oggetto progress bar opzionale per aggiornamenti di stato
 * @returns {Object} - {items: Array|null, debugInfo: Object}
 */
async function fetchChecklistItems(token, issueKey, progressBar = null) {
  const debugInfo = {
    allFields: [],
    checklistFieldId: null,
    checklistFieldName: null,
    checklistValue: null,
    checklistValueType: null,
    itemsFound: 0,
    error: null,
    issueProperties: null,
    checklistProperties: null,
    herokuappDebug: null
  };
  
  try {
    // PROVA 0: Cerca nell'endpoint herokuapp.com (app Checklistr2)
    if (progressBar) {
      progressBar.update('Tentativo recupero da herokuapp.com...', 5);
      progressBar.log('Avvio recupero checklist da app Checklistr2');
    }
    const herokuappResult = await fetchChecklistFromHerokuapp(issueKey, progressBar);
    debugInfo.herokuappDebug = herokuappResult.debugInfo;
    if (herokuappResult.items && herokuappResult.items.length > 0) {
      debugInfo.itemsFound = herokuappResult.items.length;
      debugInfo.error = null;
      return { items: herokuappResult.items, debugInfo };
    }
    if (progressBar) {
      progressBar.log('Recupero da herokuapp.com non riuscito, provo metodi alternativi...', 'warning');
    }
    
    // PROVA 1: Cerca nelle proprietà dell'issue (priorità per app di terze parti)
    debugInfo.issueProperties = await fetchIssueProperties(token, issueKey);
    if (debugInfo.issueProperties && Object.keys(debugInfo.issueProperties).length > 0) {
      // Prova a estrarre items dalle proprietà
      for (const [key, value] of Object.entries(debugInfo.issueProperties)) {
        debugInfo.checklistProperties = { key, value };
        
        // Prova a parsare il valore come array di items
        let items = [];
        
        // Caso 1: Array diretto
        if (Array.isArray(value)) {
          items = value;
        }
        // Caso 2: Oggetto con proprietà che contiene array
        else if (value && typeof value === 'object') {
          if (value.items && Array.isArray(value.items)) {
            items = value.items;
          } else if (value.checklist && Array.isArray(value.checklist)) {
            items = value.checklist;
          } else if (value.data && Array.isArray(value.data)) {
            items = value.data;
          } else if (value.value && Array.isArray(value.value)) {
            items = value.value;
          } else {
            // Cerca qualsiasi proprietà che sia un array
            for (const propKey in value) {
              if (Array.isArray(value[propKey])) {
                items = value[propKey];
                break;
              }
            }
          }
        }
        // Caso 3: Stringa JSON
        else if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
              items = parsed;
            } else if (parsed && typeof parsed === 'object') {
              if (parsed.items && Array.isArray(parsed.items)) {
                items = parsed.items;
              } else if (parsed.checklist && Array.isArray(parsed.checklist)) {
                items = parsed.checklist;
              } else if (parsed.data && Array.isArray(parsed.data)) {
                items = parsed.data;
              }
            }
          } catch (e) {
            // Non è JSON, prova a parsare come testo
            items = parseChecklistText(value);
          }
        }
        
        if (items.length > 0) {
          debugInfo.itemsFound = items.length;
          debugInfo.error = null;
          
          // Normalizza gli elementi della checklist
          const normalizedItems = items.map((item, index) => {
            let state = 'OPEN';
            if (item.state) state = item.state;
            else if (item.status) state = item.status;
            else if (item.checked !== undefined) state = item.checked ? 'DONE' : 'OPEN';
            else if (item.complete !== undefined) state = item.complete ? 'DONE' : 'OPEN';
            
            // Se l'item è già stato parsato da parseChecklistText, usa quei campi
            let name, key;
            if (item.fullText) {
              name = item.description || item.name || item.fullText;
              key = item.key;
              if (item.status) {
                const statusLower = item.status.toLowerCase();
                if (statusLower.includes('done') || statusLower.includes('complete') || statusLower.includes('closed')) {
                  state = 'DONE';
                } else {
                  state = 'OPEN';
                }
              }
            } else {
              name = item.name || item.text || item.title || item.label || item.content || String(item) || `Item ${index + 1}`;
              key = item.key || item.issueKey || item.issue || null;
            }
            
            return {
              index: index + 1,
              state: String(state).toUpperCase(),
              name: String(name),
              key: key,
              raw: item
            };
          });
          
          return { items: normalizedItems, debugInfo };
        }
      }
    }
    
    // PROVA 2: Cerca nei campi personalizzati (fallback)
    const raw = await jiraGetIssueRaw(token, issueKey);
    
    // Raccogli informazioni su tutti i campi
    const names = raw.names || {};
    const searchTerms = ['Hugo', 'FGC-3764', 'Notify label', 'Assigned to on the Modal'];
    
    Object.entries(names).forEach(([fieldId, fieldName]) => {
      const fieldValue = raw.fields?.[fieldId];
      const renderedValue = raw.renderedFields?.[fieldId];
      const valueType = typeof fieldValue;
      
      // Estrai testo dal valore (supporta ADF, HTML, stringhe)
      let textValue = '';
      if (renderedValue && typeof renderedValue === 'string') {
        // HTML renderizzato
        const div = document.createElement('div');
        div.innerHTML = renderedValue;
        textValue = div.textContent || '';
      } else if (fieldValue) {
        if (typeof fieldValue === 'string') {
          textValue = fieldValue;
        } else if (typeof fieldValue === 'object') {
          // Prova a estrarre testo da ADF o oggetti
          try {
            textValue = extractADFText(fieldValue) || JSON.stringify(fieldValue);
          } catch {
            textValue = String(fieldValue);
          }
        }
      }
      
      const valuePreview = valueType === 'object' 
        ? (Array.isArray(fieldValue) ? `Array[${fieldValue.length}]` : 'Object')
        : String(fieldValue || '').substring(0, 100);
      
      // Cerca i termini di ricerca nel valore del campo
      const matchesSearch = searchTerms.some(term => 
        textValue.toLowerCase().includes(term.toLowerCase()) ||
        valuePreview.toLowerCase().includes(term.toLowerCase())
      );
      
      debugInfo.allFields.push({
        id: fieldId,
        name: fieldName,
        type: valueType,
        preview: valuePreview,
        hasValue: fieldValue !== null && fieldValue !== undefined,
        textValue: textValue.substring(0, 500), // Aggiungi il testo estratto
        matchesSearch: matchesSearch // Flag se contiene i termini cercati
      });
    });
    
    // Cerca il campo checklist con varianti del nome
    // Priorità: prima "Checklist Text", poi altri campi checklist (escludendo "Progress")
    let checklistFieldId = null;
    const checklistTextPatterns = [
      /checklist\s+text/i,
      /checklist\s+items/i
    ];
    const checklistPatterns = [
      /checklist/i
    ];
    const excludePatterns = [
      /progress/i,
      /template/i
    ];
    
    // Prima cerca "Checklist Text" specificamente
    for (const [fieldId, fieldName] of Object.entries(names)) {
      const nameStr = String(fieldName || '').toLowerCase();
      if (checklistTextPatterns.some(pattern => pattern.test(nameStr)) && 
          !excludePatterns.some(pattern => pattern.test(nameStr))) {
        checklistFieldId = fieldId;
        debugInfo.checklistFieldId = fieldId;
        debugInfo.checklistFieldName = fieldName;
        break;
      }
    }
    
    // Se non trovato, cerca altri campi checklist (escludendo Progress e Template)
    if (!checklistFieldId) {
      for (const [fieldId, fieldName] of Object.entries(names)) {
        const nameStr = String(fieldName || '').toLowerCase();
        if (checklistPatterns.some(pattern => pattern.test(nameStr)) && 
            !excludePatterns.some(pattern => pattern.test(nameStr))) {
          checklistFieldId = fieldId;
          debugInfo.checklistFieldId = fieldId;
          debugInfo.checklistFieldName = fieldName;
          break;
        }
      }
    }
    
    if (!checklistFieldId) {
      debugInfo.error = 'Campo Checklist non trovato (esclusi Progress e Template)';
      return { items: null, debugInfo };
    }
    
    // Estrai il valore del campo checklist da fields E renderedFields
    const checklistValue = raw.fields?.[checklistFieldId] || raw.renderedFields?.[checklistFieldId];
    
    // Se è ancora vuoto, verifica se il campo esiste ma è null/undefined
    if (!checklistValue) {
      // Controlla se il campo esiste nei renderedFields anche se vuoto
      if (raw.renderedFields?.[checklistFieldId] !== undefined) {
        debugInfo.checklistValue = raw.renderedFields[checklistFieldId];
        debugInfo.checklistValueType = typeof raw.renderedFields[checklistFieldId];
        debugInfo.error = 'Campo Checklist trovato ma vuoto (potrebbe essere un campo calcolato/view-only)';
      } else if (raw.fields?.[checklistFieldId] !== undefined) {
        debugInfo.checklistValue = raw.fields[checklistFieldId];
        debugInfo.checklistValueType = typeof raw.fields[checklistFieldId];
        debugInfo.error = 'Campo Checklist trovato ma vuoto';
      } else {
        debugInfo.error = 'Campo Checklist non trovato nei fields né nei renderedFields';
      }
      return { items: null, debugInfo };
    }
    
    debugInfo.checklistValue = checklistValue;
    debugInfo.checklistValueType = typeof checklistValue;
    
    // La checklist può essere in diversi formati
    let items = [];
    
    // Caso 1: Array diretto
    if (Array.isArray(checklistValue)) {
      items = checklistValue;
    }
    // Caso 2: Oggetto ADF (Atlassian Document Format) - prova a estrarre testo
    else if (checklistValue && typeof checklistValue === 'object' && checklistValue.type === 'doc') {
      // Estrai testo da ADF
      const adfText = extractADFText(checklistValue);
      if (adfText) {
        // Prova a parsare il testo come lista di elementi
        items = parseChecklistText(adfText);
      }
    }
    // Caso 3: Stringa JSON
    else if (typeof checklistValue === 'string') {
      try {
        const parsed = JSON.parse(checklistValue);
        if (Array.isArray(parsed)) {
          items = parsed;
        } else if (parsed && typeof parsed === 'object') {
          if (parsed.items && Array.isArray(parsed.items)) {
            items = parsed.items;
          } else if (parsed.checklist && Array.isArray(parsed.checklist)) {
            items = parsed.checklist;
          } else if (parsed.value && Array.isArray(parsed.value)) {
            items = parsed.value;
          } else {
            for (const key in parsed) {
              if (Array.isArray(parsed[key])) {
                items = parsed[key];
                break;
              }
            }
          }
        }
      } catch (e) {
        // Non è JSON, prova a parsare come testo semplice
        items = parseChecklistText(checklistValue);
      }
    }
    // Caso 4: Oggetto
    else if (checklistValue && typeof checklistValue === 'object') {
      // Se è un oggetto ADF, estrai testo
      if (checklistValue.type === 'doc') {
        const adfText = extractADFText(checklistValue);
        if (adfText) {
          items = parseChecklistText(adfText);
        }
      } else if (checklistValue.items && Array.isArray(checklistValue.items)) {
        items = checklistValue.items;
      } else if (checklistValue.value && Array.isArray(checklistValue.value)) {
        items = checklistValue.value;
      } else if (checklistValue.checklist && Array.isArray(checklistValue.checklist)) {
        items = checklistValue.checklist;
      } else {
        for (const key in checklistValue) {
          if (Array.isArray(checklistValue[key])) {
            items = checklistValue[key];
            break;
          }
        }
      }
    }
    
    debugInfo.itemsFound = items.length;
    
    // Normalizza gli elementi della checklist
    const normalizedItems = items.map((item, index) => {
      let state = 'OPEN';
      if (item.state) state = item.state;
      else if (item.status) state = item.status;
      else if (item.checked !== undefined) state = item.checked ? 'DONE' : 'OPEN';
      else if (item.complete !== undefined) state = item.complete ? 'DONE' : 'OPEN';
      
      // Se l'item è già stato parsato da parseChecklistText, usa quei campi
      let name, key;
      if (item.fullText) {
        // Item parsato da testo
        name = item.description || item.name || item.fullText;
        key = item.key;
        // Prova a dedurre lo stato dal testo
        if (item.status) {
          const statusLower = item.status.toLowerCase();
          if (statusLower.includes('done') || statusLower.includes('complete') || statusLower.includes('closed')) {
            state = 'DONE';
          } else {
            state = 'OPEN';
          }
        }
      } else {
        // Item da oggetto/array
        name = item.name || item.text || item.title || item.label || item.content || String(item) || `Item ${index + 1}`;
        key = item.key || item.issueKey || item.issue || null;
      }
      
      return {
        index: index + 1,
        state: String(state).toUpperCase(),
        name: String(name),
        key: key,
        raw: item
      };
    });
    
    return { items: normalizedItems, debugInfo };
    
  } catch (error) {
    debugInfo.error = error.message || String(error);
    console.error('Errore nel recupero Checklist:', error);
    return { items: null, debugInfo };
  }
}

/**
 * Mostra gli elementi della Checklist in un modale
 * @param {string} issueKey - Chiave dell'issue
 * @param {Array} items - Array di elementi checklist
 * @param {Object} debugInfo - Informazioni di debug (opzionale)
 */
function showChecklistModal(issueKey, items, debugInfo = null) {
  ensureContextUi();
  
  const modal = document.getElementById('ej-ai-modal');
  const backdrop = document.getElementById('ej-ai-backdrop');
  const titleEl = document.getElementById('ej-ai-modal-title');
  const textEl = document.getElementById('ej-ai-modal-text');
  
  if (!modal || !titleEl || !textEl) {
    setStatus('Errore: modale non disponibile', false);
    return;
  }
  
  // Costruisci il contenuto HTML
  let html = `<h4 style="margin: 0 0 16px 0; color: #334155;">Checklist per ${issueKey}</h4>`;
  
  if (!items || items.length === 0) {
      html += '<p style="color: #64748b; margin-bottom: 16px;">Nessun elemento nella checklist.</p>';
    
    // Mostra informazioni di debug se disponibili
    if (debugInfo) {
      html += '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px;">';
      html += '<h5 style="margin: 0 0 12px 0; color: #334155; font-size: 14px; font-weight: 600;">Informazioni di Debug</h5>';
      
      // Mostra informazioni herokuapp se disponibili
      if (debugInfo.herokuappDebug) {
        html += '<div style="background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; margin-bottom: 12px;">';
        html += '<p style="margin: 0 0 8px 0; color: #334155; font-size: 13px; font-weight: 600;">🔍 Tentativo herokuapp.com (Checklistr2)</p>';
        if (debugInfo.herokuappDebug.url) {
          html += `<p style="margin: 0 0 4px 0; color: #475569; font-size: 12px;"><strong>URL:</strong> <code style="background: #f1f5f9; padding: 2px 4px; border-radius: 3px; font-size: 11px;">${escapeHtml(debugInfo.herokuappDebug.url)}</code></p>`;
        }
        if (debugInfo.herokuappDebug.status) {
          html += `<p style="margin: 0 0 4px 0; color: #475569; font-size: 12px;"><strong>Status HTTP:</strong> ${debugInfo.herokuappDebug.status}</p>`;
        }
        if (debugInfo.herokuappDebug.error) {
          html += `<p style="margin: 0 0 4px 0; color: #dc2626; font-size: 12px;"><strong>Errore:</strong> ${escapeHtml(debugInfo.herokuappDebug.error)}</p>`;
        } else if (debugInfo.herokuappDebug.itemsFound > 0) {
          html += `<p style="margin: 0 0 4px 0; color: #10b981; font-size: 12px; font-weight: 600;">✓ Trovati ${debugInfo.herokuappDebug.itemsFound} elementi</p>`;
        }
        html += '</div>';
      }
      
      if (debugInfo.error) {
        html += `<p style="color: #dc2626; margin: 0 0 12px 0; font-size: 13px;"><strong>Errore:</strong> ${escapeHtml(debugInfo.error)}</p>`;
      }
      
      // Mostra informazioni sulle proprietà se disponibili
      if (debugInfo.issueProperties && Object.keys(debugInfo.issueProperties).length > 0) {
        html += '<p style="margin: 0 0 8px 0; color: #10b981; font-size: 13px; font-weight: 600;">✓ Proprietà issue trovate:</p>';
        Object.entries(debugInfo.issueProperties).forEach(([key, value]) => {
          html += `<p style="margin: 0 0 4px 0; color: #475569; font-size: 12px;"><strong>Proprietà:</strong> ${escapeHtml(key)}</p>`;
          const valueStr = typeof value === 'object' 
            ? JSON.stringify(value, null, 2).substring(0, 300)
            : String(value).substring(0, 300);
          html += `<pre style="background: #fff; padding: 6px; border-radius: 4px; font-size: 10px; overflow-x: auto; max-height: 150px; overflow-y: auto; margin-bottom: 8px;">${escapeHtml(valueStr)}</pre>`;
        });
      } else {
        html += '<p style="margin: 0 0 8px 0; color: #64748b; font-size: 13px;">Nessuna proprietà issue trovata.</p>';
      }
      
      if (debugInfo.checklistFieldId) {
        html += `<p style="margin: 8px 0 8px 0; color: #475569; font-size: 13px;"><strong>Campo trovato:</strong> "${escapeHtml(debugInfo.checklistFieldName)}" (ID: ${debugInfo.checklistFieldId})</p>`;
        html += `<p style="margin: 0 0 8px 0; color: #475569; font-size: 13px;"><strong>Tipo valore:</strong> ${escapeHtml(debugInfo.checklistValueType || 'N/A')}</p>`;
        if (debugInfo.checklistValue !== null && debugInfo.checklistValue !== undefined) {
          const valueStr = typeof debugInfo.checklistValue === 'object' 
            ? JSON.stringify(debugInfo.checklistValue, null, 2).substring(0, 500)
            : String(debugInfo.checklistValue).substring(0, 500);
          html += `<p style="margin: 0 0 8px 0; color: #475569; font-size: 13px;"><strong>Valore (anteprima):</strong></p>`;
          html += `<pre style="background: #fff; padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; max-height: 200px; overflow-y: auto;">${escapeHtml(valueStr)}</pre>`;
        }
      } else {
        html += '<p style="margin: 8px 0 12px 0; color: #475569; font-size: 13px;"><strong>Campo Checklist non trovato nei campi personalizzati.</strong></p>';
      }
      
      html += '<details style="margin-top: 12px;">';
      html += '<summary style="cursor: pointer; color: #2563eb; font-size: 13px; font-weight: 600; margin-bottom: 8px;">Mostra tutti i campi disponibili</summary>';
      html += '<div style="max-height: 300px; overflow-y: auto;">';
      html += '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
      html += '<thead><tr style="background: #f1f5f9;">';
      html += '<th style="padding: 6px; text-align: left; font-weight: 600; color: #475569;">Nome Campo</th>';
      html += '<th style="padding: 6px; text-align: left; font-weight: 600; color: #475569;">ID</th>';
      html += '<th style="padding: 6px; text-align: left; font-weight: 600; color: #475569;">Tipo</th>';
      html += '<th style="padding: 6px; text-align: left; font-weight: 600; color: #475569;">Anteprima</th>';
      html += '<th style="padding: 6px; text-align: left; font-weight: 600; color: #475569;">Testo Estratto</th>';
      html += '</tr></thead><tbody>';
      
      // Ordina i campi: prima quelli che matchano la ricerca
      const sortedFields = [...debugInfo.allFields].sort((a, b) => {
        if (a.matchesSearch && !b.matchesSearch) return -1;
        if (!a.matchesSearch && b.matchesSearch) return 1;
        return 0;
      });
      
      sortedFields.forEach(field => {
        let rowColor = 'transparent';
        if (field.matchesSearch) {
          rowColor = '#d1fae5'; // Verde chiaro per i match
        } else if (field.name && /checklist/i.test(field.name)) {
          rowColor = '#fef3c7'; // Giallo per checklist
        }
        
        html += `<tr style="background: ${rowColor};">`;
        html += `<td style="padding: 6px; color: #334155; font-weight: ${field.matchesSearch ? '600' : '400'};">${escapeHtml(field.name || 'N/A')}${field.matchesSearch ? ' ✓' : ''}</td>`;
        html += `<td style="padding: 6px; color: #64748b; font-family: monospace; font-size: 11px;">${escapeHtml(field.id)}</td>`;
        html += `<td style="padding: 6px; color: #64748b;">${escapeHtml(field.type)}</td>`;
        html += `<td style="padding: 6px; color: #64748b; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(field.preview || '')}</td>`;
        html += `<td style="padding: 6px; color: #64748b; max-width: 300px; overflow: hidden; text-overflow: ellipsis; font-size: 11px;">${escapeHtml(field.textValue || '')}</td>`;
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      html += '</div>';
      html += '</details>';
      html += '</div>';
      
      // Pulsante Copia
      const debugText = JSON.stringify(debugInfo, null, 2);
      html += `<button id="copy-debug-info" style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-top: 12px;">📋 Copia informazioni di debug</button>`;
      html += `<div id="copy-feedback" style="display: none; color: #10b981; font-size: 12px; margin-top: 8px;">✓ Copiato negli appunti!</div>`;
    }
  } else {
    // Mostra informazioni sulla fonte se disponibili
    if (debugInfo && debugInfo.herokuappDebug && debugInfo.herokuappDebug.itemsFound > 0) {
      html += `<p style="margin: 0 0 12px 0; color: #10b981; font-size: 13px; font-weight: 600;">✓ Dati recuperati da herokuapp.com (Checklistr2)</p>`;
    }
    html += `<p style="margin: 0 0 16px 0; color: #64748b; font-size: 13px;">Trovati ${items.length} elementi:</p>`;
    html += '<div style="max-height: 60vh; overflow-y: auto;">';
    html += '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">';
    html += '<thead><tr style="background: #f1f5f9; border-bottom: 2px solid #e2e8f0;">';
    html += '<th style="padding: 8px; text-align: left; font-weight: 600; color: #475569;">#</th>';
    html += '<th style="padding: 8px; text-align: left; font-weight: 600; color: #475569;">Stato</th>';
    html += '<th style="padding: 8px; text-align: left; font-weight: 600; color: #475569;">Elemento</th>';
    html += '<th style="padding: 8px; text-align: left; font-weight: 600; color: #475569;">Key</th>';
    html += '</tr></thead><tbody>';
    
    items.forEach((item) => {
      const stateColor = item.state === 'DONE' ? '#10b981' : '#f59e0b';
      const stateBg = item.state === 'DONE' ? '#d1fae5' : '#fef3c7';
      html += '<tr style="border-bottom: 1px solid #e2e8f0;">';
      html += `<td style="padding: 8px; color: #64748b;">${item.index}</td>`;
      html += `<td style="padding: 8px;"><span style="background: ${stateBg}; color: ${stateColor}; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;">${item.state}</span></td>`;
      html += `<td style="padding: 8px; color: #334155;">${escapeHtml(item.name)}</td>`;
      html += `<td style="padding: 8px; color: #64748b; font-family: monospace;">${item.key || '-'}</td>`;
      html += '</tr>';
    });
    
    html += '</tbody></table>';
    html += '</div>';
    
    // Pulsante Copia anche quando ci sono items
    if (debugInfo) {
      const debugText = JSON.stringify(debugInfo, null, 2);
      html += `<button id="copy-debug-info" style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-top: 16px;">📋 Copia informazioni di debug</button>`;
      html += `<div id="copy-feedback" style="display: none; color: #10b981; font-size: 12px; margin-top: 8px;">✓ Copiato negli appunti!</div>`;
    }
  }
  
  // Mostra il modale
  titleEl.textContent = `Checklist - ${issueKey}`;
  textEl.innerHTML = html;
  backdrop.style.display = 'block';
  modal.style.display = 'block';
  
  // Event listener per il pulsante copia
  const copyBtn = document.getElementById('copy-debug-info');
  const copyFeedback = document.getElementById('copy-feedback');
  if (copyBtn && debugInfo) {
    copyBtn.addEventListener('click', async () => {
      try {
        const debugText = JSON.stringify(debugInfo, null, 2);
        await navigator.clipboard.writeText(debugText);
        if (copyFeedback) {
          copyFeedback.style.display = 'block';
          setTimeout(() => {
            copyFeedback.style.display = 'none';
          }, 2000);
        }
        setStatus('Informazioni di debug copiate negli appunti', true);
      } catch (e) {
        console.error('Errore copia:', e);
        setStatus('Errore nella copia', false);
      }
    });
  }
}

function populateEpicSelect(options = []) {
  epicSelect.innerHTML = '';
  options.forEach(optData => {
    const opt = document.createElement('option');
    opt.value = optData.value;
    opt.textContent = optData.label;
    epicSelect.appendChild(opt);
  });
  const noEpicOption = document.createElement('option');
  noEpicOption.value = NO_EPIC_OPTION;
  noEpicOption.textContent = 'No Epic Cards';
  epicSelect.appendChild(noEpicOption);
  
  // Aggiungi opzione A specific Epic (prima di Minor Fixes)
  const specificEpicOption = document.createElement('option');
  specificEpicOption.value = SPECIFIC_EPIC_OPTION;
  specificEpicOption.textContent = 'A specific Epic';
  specificEpicOption.style.fontWeight = 'bold';
  epicSelect.appendChild(specificEpicOption);
  
  // Aggiungi opzione Minor Fixes
  const minorFixesOption = document.createElement('option');
  minorFixesOption.value = MINOR_FIXES_OPTION;
  minorFixesOption.textContent = 'Minor Fixes (still developing)';
  epicSelect.appendChild(minorFixesOption);
  
  if (!options.length) {
    epicSelect.value = NO_EPIC_OPTION;
  }
}
