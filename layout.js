// Layout tuning: distances, strengths, charges per link-kind and node-category
// This file is intentionally small and focused, so we can tweak the layout
// without touching graph.js logic.

// Link distance per kind
function linkDistance(link, nodes) {
  if (link.kind === 'exec') return 60;     // Test Execution -> Test
  if (link.kind === 'weak') return 220;    // molto laschi
  if (link.kind === 'rel')  return 110;    // relazioni leggere

  // gerarchici: se partono dall'epic, usa categoria del figlio per modulare
  if (link.kind === 'hier' && link.childCat) {
    switch (link.childCat) {
      case 'story':          return 60;   // forte e corto
      case 'task':
      case 'mobile_task':    return 80;   // medio-forte
      case 'bug':
      case 'mobile_bug':     return 100;  // medio
      case 'test':           return 120;  // medio-debole
      case 'test_execution': return 180;  // debole
      case 'subtask':        return 200;  // debolissimo
      default:               return 90;
    }
  }

  // fallback
  const t = nodes.find(n => n.id === (link.target.id || link.target))?.type;
  return t === 'subtask' ? 40 : 90;
}

// Link strength per kind
function linkStrength(link) {
  if (link.kind === 'exec') return 0.5;
  if (link.kind === 'weak') return 0.02;
  if (link.kind === 'rel')  return 0.12;
  if (link.kind === 'hier' && link.childCat) {
    switch (link.childCat) {
      case 'story':          return 0.5;  // più forte
      case 'task':
      case 'mobile_task':    return 0.35;
      case 'bug':
      case 'mobile_bug':     return 0.25;
      case 'test':           return 0.18;
      case 'test_execution': return 0.08;
      case 'subtask':        return 0.05; // debolissimo
      default:               return 0.2;
    }
  }
  return 0.2;
}

// Charge per node category
function nodeCharge(node) {
  if (node.category === 'test_execution') return -400;
  return -160;
}

// Export in global namespace for graph.js
window.EJ_LAYOUT = {
  linkDistance,
  linkStrength,
  nodeCharge,
};


