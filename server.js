const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── STATE FILE (persiste si Railway reinicia) ──
const STATE_FILE = path.join(__dirname, 'gamestate.json');

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(GAME)); } catch(e) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE));
      // Si habia un turno corriendo, calculamos cuanto paso
      if (saved.shiftRunning && saved.shiftStartTime && !saved.paused) {
        const elapsed = Date.now() - saved.shiftStartTime;
        const cfg = DIFF_CONFIG[saved.diff] || DIFF_CONFIG.medium;
        saved.shiftProgress = Math.min(100, (elapsed / cfg.shiftDuration) * 100);
        if (saved.shiftProgress >= 100) {
          saved.shiftRunning = false;
          saved.shiftProgress = 100;
        }
      }
      return saved;
    }
  } catch(e) {}
  return null;
}

// ── GAME STATE ──
const DEFAULT_GAME = {
  active: false,
  diff: 'medium',
  day: 1,
  shift: 0,
  totalShift: 0,
  startTime: null,
  shiftStartTime: null,
  budget: 45000,
  revenue: 0,
  demurrage: 0,
  totalScore: 0,
  satisfaction: 100,
  moves: 0,
  vessels: [],
  assignments: {},
  berths: { 1: null, 2: null, 3: null, 4: null },
  events: [],
  scores: [],
  cranes: { total: 6, active: 0 },
  trucks: { total: 12, active: 0 },
  staff: 45,
  techReefer: 3,
  gateQueue: 0,
  gateProcessed: 0,
  crisis: null,
  shiftRunning: false,
  paused: false,
  pausedAt: null,
  totalPausedTime: 0,
  shiftProgress: 0,
  shiftElapsedMs: 0,
  shiftRemainingMs: 0,
};

// 8 HORAS REALES
const DIFF_CONFIG = {
  easy:   { vessels:2, budget:60000, crisisEvery:3, mult:1.0, shiftDuration: 8 * 60 * 60 * 1000 },
  medium: { vessels:3, budget:45000, crisisEvery:2, mult:1.5, shiftDuration: 8 * 60 * 60 * 1000 },
  hard:   { vessels:4, budget:30000, crisisEvery:1, mult:2.0, shiftDuration: 8 * 60 * 60 * 1000 },
  expert: { vessels:5, budget:20000, crisisEvery:1, mult:3.0, shiftDuration: 8 * 60 * 60 * 1000 },
};

const VESSEL_NAMES = [
  'MSC OSCAR','COSCO SHIPPING PERU','EVER GIVEN','OOCL HONG KONG',
  'YANG MING WISH','MAERSK EINDHOVEN','CMA CGM MARCO POLO',
  'COSCO GLORY','EVERGREEN EMERALD','MSC MEDITERRANEAN',
  'OOCL BERLIN','YANG MING DYNASTY','COSCO FORTUNE',
];

const SHIPPING_LINES = ['COSCO','EVERGREEN','YANG MING','OOCL','MSC','MAERSK','CMA CGM'];

const SHIFTS = [
  { name:'TURNO MAÑANA', time:'06:00 — 14:00', sky:'morning', startHour:6 },
  { name:'TURNO TARDE',  time:'14:00 — 22:00', sky:'day',     startHour:14 },
  { name:'TURNO NOCHE',  time:'22:00 — 06:00', sky:'night',   startHour:22 },
];

const CRISES = [
  {
    id:'crane_fail', title:'🏗️ Grúa STS Averiada',
    desc:'La grúa STS-3 tuvo una falla mecánica en el cable de elevación. El buque espera — el demurrage corre.',
    options:[
      {label:'TÉCNICO INMEDIATO', desc:'Esperar 45 min reparación. Costo: $3,500', cost:3500, satHit:-3},
      {label:'REASIGNAR GRÚA',    desc:'Mover STS-1 del otro berth. Productividad -30%.', cost:500, satHit:-5},
      {label:'CONTINUAR SIN GRÚA',desc:'Muy lento. Sin costo extra.', cost:0, satHit:-10},
    ]
  },
  {
    id:'pti_fail', title:'❄️ PTI Fallido — Reefer',
    desc:'Contenedor CSNU4521876 con paltas peruanas falló el PTI. Booking de Evergreen cierra en 2 horas. Carga vale $65,000.',
    options:[
      {label:'TRANSBORDO INMEDIATO', desc:'Cambiar contenedor. Actualizar DAM. Costo: $800.',   cost:800,  satHit:-3},
      {label:'REPARAR DAIKIN CA',    desc:'Técnico en sitio. 60% probabilidad éxito. Costo: $1,200.', cost:1200, satHit:-5},
      {label:'ROLLOVER AL SIGUIENTE',desc:'Posponer 15 días. Cliente furioso. Penalidad: $5,000.', cost:5000, satHit:-15},
    ]
  },
  {
    id:'canal_rojo', title:'🔴 Canal Rojo Masivo — SUNAT',
    desc:'35 contenedores de importación en canal rojo. Vista de aduana llega en 3 horas. Clientes desesperados.',
    options:[
      {label:'PRIORIZAR INSPECCIÓN', desc:'Gestión express con SUNAT. Costo: $2,000.',              cost:2000, satHit:-5},
      {label:'REUBICAR A BLOQUE X',  desc:'Mover contenedores. Libera patio. Costo: $500.',         cost:500,  satHit:-3},
      {label:'ESPERAR PROCESO NORMAL',desc:'3 horas de espera. Clientes insatisfechos. Sin costo.', cost:0,    satHit:-12},
    ]
  },
  {
    id:'overweight', title:'⚖️ Contenedor Sobrepeso Detectado',
    desc:'MRKU7823456 supera el payload en 480 kg. El buque no puede embarcarlo. Cliente insiste en salida hoy.',
    options:[
      {label:'TRANSBORDO PARCIAL', desc:'Dividir carga en dos contenedores. Cuadrilla: $400.', cost:400,  satHit:-3},
      {label:'ROLLOVER',           desc:'Siguiente buque. Penalidad por demora: $2,500.',       cost:2500, satHit:-10},
      {label:'RECHAZAR CARGA',     desc:'Devolver al exportador. Relación dañada.',              cost:0,    satHit:-8},
    ]
  },
  {
    id:'storm', title:'🌧️ Alerta Climática — Vientos Fuertes',
    desc:'SENAMHI reporta vientos de 45 km/h. Límite operativo STS: 40 km/h. Tienes 3 buques en operación.',
    options:[
      {label:'SUSPENDER OPERACIONES', desc:'2 horas parada total. Demurrage en 3 buques: $8,000.', cost:8000, satHit:-8},
      {label:'REDUCIR VELOCIDAD',     desc:'Operar al 60% de capacidad. Riesgo moderado.',         cost:1000, satHit:-5},
      {label:'CONTINUAR NORMAL',      desc:'Alto riesgo HSSE. Multa potencial: $50,000.',           cost:0,    satHit:-20},
    ]
  },
  {
    id:'eir_error', title:'📋 Error Transmisión EIR',
    desc:'Técnico generó EIR con número incorrecto. Ya fue transmitido a Evergreen en Shanghai.',
    options:[
      {label:'CANCELAR TRANSMISIÓN', desc:'Llamar a Evergreen ahora. Costo gestión: $200.',     cost:200,  satHit:-2},
      {label:'NUEVA TRANSMISIÓN',    desc:'Enviar corrección. Riesgo de rechazo en destino.',   cost:500,  satHit:-5},
      {label:'IGNORAR',              desc:'Error llega a Shanghai. Chaos. Multa: $8,000.',       cost:8000, satHit:-20},
    ]
  },
  {
    id:'reefer_temp', title:'🌡️ Temperatura Reefer Fuera de Rango',
    desc:'Contenedor MSCU2341876 con arándanos registra -12°C cuando debería estar a -18°C. Carga en riesgo.',
    options:[
      {label:'TÉCNICO REEFER URGENTE', desc:'Técnico en sitio inmediato. Costo: $1,500.',          cost:1500, satHit:-3},
      {label:'TRANSBORDO PREVENTIVO', desc:'Mover carga a reefer backup. Costo cuadrilla: $600.', cost:600,  satHit:-5},
      {label:'MONITOREAR Y ESPERAR',  desc:'Riesgo alto de pérdida de carga. Sin costo ahora.',   cost:0,    satHit:-15},
    ]
  },
  {
    id:'imo_undeclared', title:'🚨 Carga Peligrosa Mal Declarada',
    desc:'Inspección detectó contenedor IMO clase 3 declarado como carga general. Protocolo HSSE activado.',
    options:[
      {label:'EVACUAR Y AISLAR',     desc:'Protocolo completo. Retraso 3 horas. Costo: $5,000.', cost:5000, satHit:-5},
      {label:'INSPECCIÓN TÉCNICA',   desc:'Equipo especializado evalúa riesgo. Costo: $2,000.',  cost:2000, satHit:-8},
      {label:'CONTINUAR OPERACIONES',desc:'Riesgo HSSE crítico. Multa potencial: $30,000.',      cost:0,    satHit:-25},
    ]
  },
];

// ── LOAD OR INIT GAME ──
let GAME = loadState() || { ...DEFAULT_GAME };

// ── HELPERS ──
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateVessels(diff) {
  const cfg = DIFF_CONFIG[diff];
  const vessels = [];
  for (let i = 0; i < cfg.vessels; i++) {
    const sl = rnd(SHIPPING_LINES);
    const teu = rnd([8000, 10000, 12000, 14000, 16000, 18000]);
    const hasReefer = Math.random() > 0.55;
    const shift = SHIFTS[GAME.shift];
    const h = shift.startHour + Math.floor(i * 2.5);
    const adjustedH = h >= 24 ? h - 24 : h;
    const eta = `${String(adjustedH).padStart(2,'0')}:${Math.random() > 0.5 ? '30' : '00'}`;
    const pendingContainers = Math.floor(teu * 0.6); // 60% to discharge
    vessels.push({
      id: `V${i+1}`,
      name: rnd(VESSEL_NAMES),
      sl, teu, eta, hasReefer,
      reeferCount: hasReefer ? rndInt(50, 220) : 0,
      progress: 0,
      pendingContainers,
      totalContainers: pendingContainers,
    });
  }
  return vessels;
}

function addEvent(type, msg) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const ev = { type, msg, time };
  GAME.events.unshift(ev);
  if (GAME.events.length > 50) GAME.events.pop();
  io.emit('event', ev);
  saveState();
}

// ── FORMAT TIME ──
function formatMs(ms) {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── SHIFT TIMER (corre 24/7 en servidor) ──
let shiftInterval = null;

function startShiftTimer() {
  if (shiftInterval) clearInterval(shiftInterval);
  
  shiftInterval = setInterval(() => {
    if (!GAME.shiftRunning || GAME.paused) return;

    const cfg = DIFF_CONFIG[GAME.diff];
    const elapsed = Date.now() - GAME.shiftStartTime - (GAME.totalPausedTime || 0);
    
    GAME.shiftElapsedMs = elapsed;
    GAME.shiftRemainingMs = Math.max(0, cfg.shiftDuration - elapsed);
    GAME.shiftProgress = Math.min(100, (elapsed / cfg.shiftDuration) * 100);

    // Update pending containers per vessel
    GAME.vessels.forEach(v => {
      const a = GAME.assignments[v.id];
      if (a?.berth && v.pendingContainers > 0) {
        const discharged = Math.floor((a.cranes||2) * 0.8);
        v.pendingContainers = Math.max(0, v.pendingContainers - discharged);
      }
    });

    // Movimientos basados en grúas activas
    const totalCranes = Object.values(GAME.assignments)
      .reduce((s, a) => s + (a && a.berth ? (a.cranes || 2) : 0), 0);
    GAME.cranes.active = totalCranes;
    GAME.moves = Math.round(totalCranes * 22 * (GAME.shiftProgress / 100));

    // Gate evacuation — containers leaving yard automatically
    const baseEvac = Math.floor(GAME.gateProcessed * 0.1 + 2);
    GAME.gateProcessed += baseEvac;
    GAME.gateQueue = rndInt(2, 20);

    // Broadcast cada 10 segundos
    io.emit('gameState', getPublicState());
    saveState();

    // Crisis — probabilidad calibrada para 8 horas
    // Con update cada 10s y shiftDuration 8h = 2880 ticks
    // crisisEvery=2 significa ~2 crisis por turno
    // P(crisis) por tick = crisisEvery / 2880 * 3 ≈ 0.002
    const cfg2 = DIFF_CONFIG[GAME.diff];
    if (!GAME.crisis &&
        GAME.shiftProgress > 10 &&
        GAME.shiftProgress < 90) {
      const crisisProb = (cfg2.crisisEvery * 3) / 2880;
      if (Math.random() < crisisProb) {
        triggerCrisis();
      }
    }

    // Turno completo
    if (GAME.shiftProgress >= 100) {
      clearInterval(shiftInterval);
      finishShift();
    }

  }, 10000); // Actualizar cada 10 segundos
}

function triggerCrisis() {
  const crisis = rnd(CRISES);
  GAME.crisis = { ...crisis, triggeredAt: Date.now() };
  addEvent('danger', `🚨 CRISIS: ${crisis.title}`);
  io.emit('crisis', GAME.crisis);
  saveState();
}

function finishShift() {
  GAME.shiftRunning = false;

  const totalCranes = Object.values(GAME.assignments)
    .reduce((s, a) => s + (a && a.berth ? (a.cranes || 2) : 0), 0);

  const shiftRevenue = GAME.vessels.length * 12000;
  const craneCost = totalCranes * 800 * 8;
  const staffCost = GAME.staff * 45;

  GAME.revenue += shiftRevenue;
  GAME.budget -= (craneCost + staffCost);

  // Demurrage por buques sin berth
  const unassigned = GAME.vessels.filter(v => !GAME.assignments[v.id]?.berth).length;
  if (unassigned > 0) {
    const dem = unassigned * 3000;
    GAME.demurrage += dem;
    addEvent('danger', `▸ Demurrage: $${dem.toLocaleString()} — ${unassigned} buques sin berth`);
  }

  const prodScore  = Math.min(30, Math.round(GAME.moves / 2000));
  const finScore   = Math.min(25, Math.max(0, Math.round((shiftRevenue - craneCost - staffCost) / 1000)));
  const satScore   = Math.round((GAME.satisfaction || 100) / 100 * 20);
  const hsseScore  = 15;
  const crisisScore = 10;
  const turnScore  = Math.max(0, prodScore + finScore + satScore + hsseScore + crisisScore);

  GAME.scores.push(turnScore);
  GAME.totalScore += turnScore;
  GAME.totalShift++;

  addEvent('success', `▸ Turno ${GAME.totalShift} completado — Score: ${turnScore}/100`);

  io.emit('shiftComplete', {
    score: turnScore, prodScore, finScore, satScore, hsseScore, crisisScore,
    revenue: shiftRevenue, costs: craneCost + staffCost,
    moves: GAME.moves, totalScore: GAME.totalScore, totalShift: GAME.totalShift,
  });
  saveState();
}

function getPublicState() {
  const cfg = DIFF_CONFIG[GAME.diff] || DIFF_CONFIG.medium;
  return {
    ...GAME,
    currentShift: SHIFTS[GAME.shift],
    shiftDurationMs: cfg.shiftDuration,
    elapsedFormatted: formatMs(GAME.shiftElapsedMs),
    remainingFormatted: formatMs(GAME.shiftRemainingMs),
    serverTime: new Date().toISOString(),
  };
}

// ── SOCKET.IO ──
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Reconexión — recalcular progreso
  if (GAME.shiftRunning && !GAME.paused && GAME.shiftStartTime) {
    const cfg = DIFF_CONFIG[GAME.diff];
    const elapsed = Date.now() - GAME.shiftStartTime - (GAME.totalPausedTime || 0);
    GAME.shiftElapsedMs = elapsed;
    GAME.shiftRemainingMs = Math.max(0, cfg.shiftDuration - elapsed);
    GAME.shiftProgress = Math.min(100, (elapsed / cfg.shiftDuration) * 100);
  }
  
  socket.emit('gameState', getPublicState());
  if (GAME.crisis) socket.emit('crisis', GAME.crisis);

  // Iniciar juego
  socket.on('startGame', (diff) => {
    const cfg = DIFF_CONFIG[diff] || DIFF_CONFIG.medium;
    Object.assign(GAME, {
      ...DEFAULT_GAME,
      active: true,
      diff,
      budget: cfg.budget,
      vessels: [],
      assignments: {},
    });
    GAME.vessels = generateVessels(diff);
    GAME.vessels.forEach(v => {
      GAME.assignments[v.id] = { berth: null, cranes: 2, block: 'A', reefer: null };
    });
    addEvent('success', `▸ Simulador iniciado — Dificultad: ${diff.toUpperCase()}`);
    addEvent('info', `▸ Turno de 8 horas reales — el servidor corre aunque cierres el dispositivo`);
    addEvent('info', `▸ ${cfg.vessels} buques en cola de llegada`);
    io.emit('gameState', getPublicState());
  });

  // Asignar berth
  socket.on('assignBerth', ({ vesselId, berth }) => {
    const taken = GAME.vessels.find(v => v.id !== vesselId && GAME.assignments[v.id]?.berth === berth);
    if (taken) { socket.emit('errMsg', `Berth 0${berth} ya asignado`); return; }
    if (GAME.assignments[vesselId]) {
      GAME.assignments[vesselId].berth = berth;
      GAME.berths[berth] = vesselId;
      const v = GAME.vessels.find(v => v.id === vesselId);
      addEvent('info', `▸ ${v?.name.split(' ')[0]} → Berth 0${berth}`);
      io.emit('gameState', getPublicState());
    }
  });

  // Asignar grúas
  socket.on('assignCranes', ({ vesselId, cranes }) => {
    if (GAME.assignments[vesselId]) {
      GAME.assignments[vesselId].cranes = cranes;
      addEvent('info', `▸ ${cranes} grúas STS asignadas`);
      io.emit('gameState', getPublicState());
    }
  });

  // Asignar bloque
  socket.on('assignBlock', ({ vesselId, block }) => {
    if (GAME.assignments[vesselId]) {
      GAME.assignments[vesselId].block = block;
      io.emit('gameState', getPublicState());
    }
  });

  // Ejecutar turno
  socket.on('executeShift', () => {
    const anyAssigned = GAME.vessels.some(v => GAME.assignments[v.id]?.berth !== null);
    if (!anyAssigned) { socket.emit('errMsg', 'Asigna berth a al menos 1 buque primero'); return; }
    GAME.shiftRunning = true;
    GAME.shiftStartTime = Date.now();
    GAME.shiftProgress = 0;
    GAME.shiftElapsedMs = 0;
    GAME.totalPausedTime = 0;
    GAME.paused = false;
    GAME.crisis = null;
    const cfg = DIFF_CONFIG[GAME.diff];
    GAME.shiftRemainingMs = cfg.shiftDuration;
    addEvent('success', '▸ TURNO INICIADO — 8 horas reales en servidor');
    addEvent('info', '▸ Puedes cerrar el dispositivo — el turno sigue corriendo');
    startShiftTimer();
    io.emit('gameState', getPublicState());
  });

  // Pausar / Reanudar
  socket.on('pauseShift', () => {
    if (!GAME.shiftRunning) return;
    GAME.paused = !GAME.paused;
    if (GAME.paused) {
      GAME.pausedAt = Date.now();
      addEvent('warn', '⏸ Turno pausado');
    } else {
      if (GAME.pausedAt) {
        GAME.totalPausedTime = (GAME.totalPausedTime || 0) + (Date.now() - GAME.pausedAt);
        GAME.pausedAt = null;
      }
      addEvent('info', '▶ Turno reanudado');
    }
    io.emit('gameState', getPublicState());
    saveState();
  });

  // Resolver crisis
  socket.on('resolveCrisis', ({ optionIdx }) => {
    if (!GAME.crisis) return;
    const option = GAME.crisis.options[optionIdx];
    if (!option) return;
    GAME.budget -= option.cost;
    GAME.satisfaction = Math.max(0, (GAME.satisfaction || 100) + option.satHit);
    if (option.cost > 0) addEvent('warn', `▸ Costo crisis: -$${option.cost.toLocaleString()}`);
    addEvent('success', '▸ Crisis resuelta — operaciones reanudadas');
    GAME.crisis = null;
    io.emit('crisisResolved', { option });
    io.emit('gameState', getPublicState());
    saveState();
  });

  // Instrucción durante el turno
  socket.on('giveInstruction', ({ type, payload }) => {
    if (!GAME.shiftRunning) return;
    switch(type) {
      case 'addCrane':
        if (GAME.assignments[payload.vesselId] && GAME.cranes.active < GAME.cranes.total) {
          GAME.assignments[payload.vesselId].cranes = Math.min(6, (GAME.assignments[payload.vesselId].cranes || 2) + 1);
          const v = GAME.vessels.find(v=>v.id===payload.vesselId);
          addEvent('info', `▸ +1 grúa → ${v?.name.split(' ')[0]} (${GAME.assignments[payload.vesselId].cranes} total)`);
        }
        break;
      case 'removeCrane':
        if (GAME.assignments[payload.vesselId] && (GAME.assignments[payload.vesselId].cranes || 2) > 1) {
          GAME.assignments[payload.vesselId].cranes = Math.max(1, (GAME.assignments[payload.vesselId].cranes || 2) - 1);
          addEvent('warn', `▸ -1 grúa asignada`);
        }
        break;
      case 'reassignBlock':
        if (GAME.assignments[payload.vesselId]) {
          const oldBlock = GAME.assignments[payload.vesselId].block;
          GAME.assignments[payload.vesselId].block = payload.block;
          addEvent('info', `▸ Carga redirigida ${oldBlock} → Bloque ${payload.block}`);
        }
        break;
      case 'priorityVessel':
        const pv = GAME.vessels.find(v=>v.id===payload.vesselId);
        addEvent('warn', `▸ PRIORIDAD MÁXIMA → ${pv?.name.split(' ')[0]}`);
        break;
      case 'callTechnician':
        addEvent('info', `▸ Técnico reefer despachado`);
        GAME.budget -= 500;
        break;

      // ── EVACUACIÓN DE PATIO ──
      case 'evacuateBlock': {
        const block = payload.block;
        const costPerContainer = 85; // costo tracto extraportuario
        const containers = payload.amount || 20;
        const totalCost = containers * costPerContainer;
        if (GAME.budget < totalCost) {
          addEvent('danger', `▸ EVACUACIÓN FALLIDA: presupuesto insuficiente ($${totalCost.toLocaleString()} requerido)`);
          break;
        }
        GAME.budget -= totalCost;
        GAME.yardEvacuated = (GAME.yardEvacuated || 0) + containers;
        addEvent('warn', `▸ EVACUACIÓN Bloque ${block}: ${containers} contenedores → depósito extraportuario · Costo: $${totalCost.toLocaleString()}`);
        addEvent('info', `▸ Tractos contratados — llegada al bloque en 15 min`);
        // Boost gate processed
        GAME.gateProcessed += Math.floor(containers * 0.8);
        break;
      }

      // ── DESCARGA DIRECTA (Cross-docking) ──
      case 'crossDocking': {
        const vId = payload.vesselId;
        const crossV = GAME.vessels.find(v=>v.id===vId);
        const costCross = 120; // por contenedor cross-dock
        const crossContainers = payload.amount || 15;
        const costTotal = crossContainers * costCross;
        if (GAME.budget < costTotal) {
          addEvent('danger', `▸ CROSS-DOCK FALLIDO: presupuesto insuficiente`);
          break;
        }
        GAME.budget -= costTotal;
        GAME.crossDockContainers = (GAME.crossDockContainers || 0) + crossContainers;
        GAME.gateProcessed += crossContainers;
        addEvent('success', `▸ DESCARGA DIRECTA activada: ${crossV?.name.split(' ')[0]} → ${crossContainers} cont. directo a tractos · $${costTotal.toLocaleString()}`);
        addEvent('info', `▸ Camiones posicionados en berth — descarga directa sin pasar por patio`);
        break;
      }

      // ── DEPÓSITO EXTRAPORTUARIO (overflow) ──
      case 'extraportDepot': {
        const depotCost = 2500; // costo fijo por activar depósito
        const depotContainers = payload.amount || 30;
        const depotCostTotal = depotCost + depotContainers * 45;
        if (GAME.budget < depotCostTotal) {
          addEvent('danger', `▸ DEPÓSITO EXTRA FALLIDO: presupuesto insuficiente`);
          break;
        }
        GAME.budget -= depotCostTotal;
        GAME.extraportContainers = (GAME.extraportContainers || 0) + depotContainers;
        GAME.gateProcessed += depotContainers;
        addEvent('warn', `▸ DEPÓSITO EXTRAPORTUARIO activado: ${depotContainers} cont. → almacén externo · $${depotCostTotal.toLocaleString()}`);
        addEvent('info', `▸ Coordinando con operador de depósito — flota de tractos en camino`);
        // Improve satisfaction slightly (clients get their cargo faster)
        GAME.satisfaction = Math.min(100, (GAME.satisfaction || 100) + 5);
        break;
      }

      // ── EVACUAR REEFERS ──
      case 'evacuateReefer': {
        const reeferCost = 150; // por contenedor reefer con tracto refrigerado
        const reeferContainers = payload.amount || 10;
        const reeferTotal = reeferContainers * reeferCost;
        if (GAME.budget < reeferTotal) {
          addEvent('danger', `▸ EVACUACIÓN REEFER FALLIDA: presupuesto insuficiente`);
          break;
        }
        GAME.budget -= reeferTotal;
        GAME.gateProcessed += reeferContainers;
        addEvent('warn', `▸ EVACUACIÓN REEFER: ${reeferContainers} unidades → tractos refrigerados · $${reeferTotal.toLocaleString()}`);
        addEvent('info', `▸ Cadena de frío mantenida — contenedores en tránsito a cámara externa`);
        break;
      }

      case 'openGateLane':
        addEvent('info', `▸ Carril adicional de gate abierto`);
        break;
    }
    io.emit('gameState', getPublicState());
    saveState();
  });

  // Siguiente turno
  socket.on('nextShift', () => {
    GAME.shiftRunning = false;
    GAME.crisis = null;
    GAME.shiftProgress = 0;
    GAME.shiftElapsedMs = 0;
    GAME.shiftRemainingMs = 0;
    GAME.shift++;
    if (GAME.shift >= 3) { GAME.shift = 0; GAME.day++; }
    if (GAME.day > 3) { io.emit('gameOver', { totalScore: GAME.totalScore }); return; }
    GAME.vessels = generateVessels(GAME.diff);
    GAME.assignments = {};
    GAME.vessels.forEach(v => { GAME.assignments[v.id] = { berth:null, cranes:2, block:'A', reefer:null }; });
    GAME.berths = { 1:null, 2:null, 3:null, 4:null };
    GAME.gateProcessed = 0;
    addEvent('success', `▸ ${SHIFTS[GAME.shift].name} iniciado — Día ${GAME.day}`);
    io.emit('gameState', getPublicState());
    saveState();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected — shift continues on server 24/7');
  });
});

// ── API ──
app.get('/state', (req,res) => res.json(getPublicState()));
app.get('/health', (req,res) => res.json({ status:'ok', shiftRunning: GAME.shiftRunning, progress: GAME.shiftProgress, remaining: formatMs(GAME.shiftRemainingMs) }));

// Si habia un turno corriendo al reiniciar el servidor, lo reanudamos
if (GAME.shiftRunning && !GAME.paused) {
  console.log('🔄 Resuming shift from saved state...');
  startShiftTimer();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚢 Puerto Chancay Terminal Simulator`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`⏱️  Shift duration: 8 REAL HOURS per turn`);
  console.log(`💾 State persistence: enabled`);
  console.log(`🌊 Ready for operations 24/7`);
});
