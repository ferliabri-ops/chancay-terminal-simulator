const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GAME STATE (runs 24/7 on server) ──
let GAME = {
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
  patio: {},
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
  shiftProgress: 0,
  lastSaved: null,
};

const DIFF_CONFIG = {
  easy:   { vessels: 2, budget: 60000, crisisEvery: 3, mult: 1.0, shiftDuration: 8 * 60 * 60 * 1000 },
  medium: { vessels: 3, budget: 45000, crisisEvery: 2, mult: 1.5, shiftDuration: 8 * 60 * 60 * 1000 },
  hard:   { vessels: 4, budget: 30000, crisisEvery: 1, mult: 2.0, shiftDuration: 8 * 60 * 60 * 1000 },
  expert: { vessels: 5, budget: 20000, crisisEvery: 1, mult: 3.0, shiftDuration: 8 * 60 * 60 * 1000 },
};

const VESSEL_NAMES = [
  'MSC OSCAR','COSCO SHIPPING PERU','EVER GIVEN','OOCL HONG KONG',
  'YANG MING WISH','MAERSK EINDHOVEN','CMA CGM MARCO POLO',
  'COSCO GLORY','EVERGREEN EMERALD','MSC MEDITERRANEAN',
];

const SHIPPING_LINES = ['COSCO','EVERGREEN','YANG MING','OOCL','MSC','MAERSK','CMA CGM'];

const CRISES = [
  {
    id: 'crane_fail',
    title: '🏗️ Grúa STS Averiada',
    desc: 'La grúa STS-3 tuvo una falla mecánica. El demurrage corre.',
    options: [
      { label: 'TÉCNICO INMEDIATO', desc: 'Esperar 45 min. Costo: $3,500', cost: 3500, satHit: -3 },
      { label: 'REASIGNAR GRÚA', desc: 'Mover STS-1. Productividad -30%.', cost: 500, satHit: -5 },
      { label: 'CONTINUAR SIN GRÚA', desc: 'Muy lento. Sin costo extra.', cost: 0, satHit: -10 },
    ]
  },
  {
    id: 'pti_fail',
    title: '❄️ PTI Fallido — Reefer',
    desc: 'Contenedor CSNU4521876 falló PTI. Booking cierra en 2 horas. Carga vale $65,000.',
    options: [
      { label: 'TRANSBORDO INMEDIATO', desc: 'Cambiar contenedor. Costo: $800.', cost: 800, satHit: -3 },
      { label: 'REPARAR DAIKIN', desc: 'Técnico en sitio. 60% éxito. Costo: $1,200.', cost: 1200, satHit: -5 },
      { label: 'ROLLOVER', desc: 'Posponer 15 días. Penalidad: $5,000.', cost: 5000, satHit: -15 },
    ]
  },
  {
    id: 'canal_rojo',
    title: '🔴 Canal Rojo — SUNAT',
    desc: '35 contenedores en canal rojo. Vista de aduana llega en 3 horas.',
    options: [
      { label: 'PRIORIZAR INSPECCIÓN', desc: 'Inspección express. Costo: $2,000.', cost: 2000, satHit: -5 },
      { label: 'REUBICAR CONTENEDORES', desc: 'Mover a bloque X. Costo: $500.', cost: 500, satHit: -3 },
      { label: 'ESPERAR PROCESO NORMAL', desc: '3 horas de espera. Sin costo.', cost: 0, satHit: -12 },
    ]
  },
  {
    id: 'overweight',
    title: '⚖️ Contenedor Sobrepeso',
    desc: 'MRKU7823456 supera payload en 480 kg. No puede embarcar así.',
    options: [
      { label: 'TRANSBORDO PARCIAL', desc: 'Dividir carga. Costo: $400.', cost: 400, satHit: -3 },
      { label: 'ROLLOVER', desc: 'Siguiente buque. Penalidad: $2,500.', cost: 2500, satHit: -10 },
      { label: 'RECHAZAR CARGA', desc: 'Devolver al exportador.', cost: 0, satHit: -8 },
    ]
  },
  {
    id: 'storm',
    title: '🌧️ Alerta Climática',
    desc: 'Vientos 45 km/h. Límite operativo STS: 40 km/h.',
    options: [
      { label: 'SUSPENDER OPERACIONES', desc: '2 horas parada. Demurrage x3 buques.', cost: 8000, satHit: -8 },
      { label: 'REDUCIR VELOCIDAD', desc: 'Operar al 60%. Riesgo moderado.', cost: 1000, satHit: -5 },
      { label: 'CONTINUAR NORMAL', desc: 'Alto riesgo HSSE.', cost: 0, satHit: -20 },
    ]
  },
  {
    id: 'eir_error',
    title: '📋 Error Transmisión EIR',
    desc: 'Técnico generó EIR con número incorrecto. Ya fue transmitido a Evergreen Shanghai.',
    options: [
      { label: 'CANCELAR TRANSMISIÓN', desc: 'Llamar a Evergreen. Costo: $200.', cost: 200, satHit: -2 },
      { label: 'NUEVA TRANSMISIÓN', desc: 'Enviar corrección. Riesgo rechazo.', cost: 500, satHit: -5 },
      { label: 'IGNORAR', desc: 'Error llega a destino. Multa: $8,000.', cost: 8000, satHit: -20 },
    ]
  },
];

const SHIFTS = [
  { name: 'TURNO MAÑANA', time: '06:00 — 14:00', sky: 'morning' },
  { name: 'TURNO TARDE',  time: '14:00 — 22:00', sky: 'day' },
  { name: 'TURNO NOCHE',  time: '22:00 — 06:00', sky: 'night' },
];

// ── HELPERS ──
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateVessels(diff) {
  const cfg = DIFF_CONFIG[diff];
  const vessels = [];
  for (let i = 0; i < cfg.vessels; i++) {
    const sl = rnd(SHIPPING_LINES);
    const teu = rnd([8000, 10000, 12000, 14000, 16000]);
    const hasReefer = Math.random() > 0.6;
    const h = 6 + Math.floor(i * 2.5);
    const eta = `${String(h).padStart(2,'0')}:${Math.random() > 0.5 ? '30' : '00'}`;
    vessels.push({
      id: `V${i+1}`,
      name: rnd(VESSEL_NAMES),
      sl, teu, eta, hasReefer,
      reeferCount: hasReefer ? rndInt(50, 200) : 0,
      progress: 0,
    });
  }
  return vessels;
}

function addEvent(type, msg) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  GAME.events.unshift({ type, msg, time });
  if (GAME.events.length > 30) GAME.events.pop();
  io.emit('event', { type, msg, time });
}

// ── SHIFT TIMER (runs on server 24/7) ──
let shiftInterval = null;

function startShiftTimer() {
  if (shiftInterval) clearInterval(shiftInterval);
  
  const cfg = DIFF_CONFIG[GAME.diff];
  const totalDuration = cfg.shiftDuration;
  
  shiftInterval = setInterval(() => {
    if (!GAME.shiftRunning || GAME.paused) return;
    
    const elapsed = Date.now() - GAME.shiftStartTime;
    GAME.shiftProgress = Math.min(100, (elapsed / totalDuration) * 100);

    // Update moves KPI
    const totalCranes = Object.values(GAME.assignments)
      .reduce((s, a) => s + (a.berth ? a.cranes : 0), 0);
    GAME.moves = Math.round(totalCranes * 22 * (GAME.shiftProgress / 100));
    GAME.cranes.active = totalCranes;

    // Gate activity
    GAME.gateQueue = rndInt(3, 18);
    if (GAME.shiftProgress > 10) GAME.gateProcessed += rndInt(0, 2);

    // Broadcast state every 5 seconds
    io.emit('gameState', getPublicState());

    // Crisis trigger
    const cfg2 = DIFF_CONFIG[GAME.diff];
    if (!GAME.crisis &&
        GAME.shiftProgress > 20 &&
        GAME.shiftProgress < 80 &&
        GAME.totalShift % cfg2.crisisEvery === 0 &&
        Math.random() < 0.003) {
      triggerCrisis();
    }

    // Shift complete
    if (GAME.shiftProgress >= 100) {
      clearInterval(shiftInterval);
      finishShift();
    }

  }, 5000); // Update every 5 seconds
}

function triggerCrisis() {
  const crisis = rnd(CRISES);
  GAME.crisis = { ...crisis, triggeredAt: Date.now() };
  addEvent('danger', `🚨 CRISIS: ${crisis.title}`);
  io.emit('crisis', GAME.crisis);
}

function finishShift() {
  GAME.shiftRunning = false;
  const cfg = DIFF_CONFIG[GAME.diff];

  const totalCranes = Object.values(GAME.assignments)
    .reduce((s, a) => s + (a.berth ? a.cranes : 0), 0);
  
  const shiftRevenue = GAME.vessels.length * 12000;
  const craneCost = totalCranes * 800 * 8;
  const staffCost = GAME.staff * 45;
  
  GAME.revenue += shiftRevenue;
  GAME.budget -= (craneCost + staffCost);

  const unassigned = GAME.vessels.filter(v => !GAME.assignments[v.id]?.berth).length;
  if (unassigned > 0) {
    const dem = unassigned * 3000;
    GAME.demurrage += dem;
    addEvent('danger', `▸ Demurrage: $${dem.toLocaleString()}`);
  }

  const prodScore  = Math.min(30, Math.round(GAME.moves / 2000));
  const finScore   = Math.min(25, Math.max(0, Math.round((shiftRevenue - craneCost - staffCost) / 1000)));
  const satScore   = Math.round(GAME.satisfaction / 100 * 20);
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
}

function getPublicState() {
  return {
    active: GAME.active,
    diff: GAME.diff,
    day: GAME.day,
    shift: GAME.shift,
    totalShift: GAME.totalShift,
    budget: GAME.budget,
    revenue: GAME.revenue,
    demurrage: GAME.demurrage,
    totalScore: GAME.totalScore,
    satisfaction: GAME.satisfaction,
    moves: GAME.moves,
    vessels: GAME.vessels,
    assignments: GAME.assignments,
    berths: GAME.berths,
    events: GAME.events,
    scores: GAME.scores,
    cranes: GAME.cranes,
    trucks: GAME.trucks,
    staff: GAME.staff,
    gateQueue: GAME.gateQueue,
    gateProcessed: GAME.gateProcessed,
    crisis: GAME.crisis,
    shiftRunning: GAME.shiftRunning,
    shiftProgress: GAME.shiftProgress,
    currentShift: SHIFTS[GAME.shift],
    paused: GAME.paused,
    serverTime: new Date().toISOString(),
  };
}

// ── SOCKET.IO EVENTS ──
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('gameState', getPublicState());

  // Start game
  socket.on('startGame', (diff) => {
    const cfg = DIFF_CONFIG[diff] || DIFF_CONFIG.medium;
    GAME.active = true;
    GAME.diff = diff;
    GAME.day = 1;
    GAME.shift = 0;
    GAME.totalShift = 0;
    GAME.budget = cfg.budget;
    GAME.revenue = 0;
    GAME.demurrage = 0;
    GAME.totalScore = 0;
    GAME.satisfaction = 100;
    GAME.moves = 0;
    GAME.vessels = generateVessels(diff);
    GAME.assignments = {};
    GAME.vessels.forEach(v => {
      GAME.assignments[v.id] = { berth: null, cranes: 2, block: 'A', reefer: null };
    });
    GAME.berths = { 1: null, 2: null, 3: null, 4: null };
    GAME.events = [];
    GAME.scores = [];
    GAME.crisis = null;
    GAME.shiftRunning = false;
    GAME.shiftProgress = 0;
    GAME.gateProcessed = 0;
    GAME.startTime = Date.now();

    addEvent('success', `▸ Simulador iniciado — Dificultad: ${diff.toUpperCase()}`);
    addEvent('info', `▸ Presupuesto del turno: $${cfg.budget.toLocaleString()}`);
    addEvent('info', `▸ ${cfg.vessels} buques en cola de llegada`);

    io.emit('gameState', getPublicState());
  });

  // Assign berth
  socket.on('assignBerth', ({ vesselId, berth }) => {
    const taken = GAME.vessels.find(v => v.id !== vesselId && GAME.assignments[v.id]?.berth === berth);
    if (taken) {
      socket.emit('error', `Berth 0${berth} ya asignado a ${taken.name.split(' ')[0]}`);
      return;
    }
    if (GAME.assignments[vesselId]) {
      GAME.assignments[vesselId].berth = berth;
      GAME.berths[berth] = vesselId;
      const v = GAME.vessels.find(v => v.id === vesselId);
      addEvent('info', `▸ ${v?.name.split(' ')[0]} → Berth 0${berth}`);
      io.emit('gameState', getPublicState());
    }
  });

  // Assign cranes
  socket.on('assignCranes', ({ vesselId, cranes }) => {
    if (GAME.assignments[vesselId]) {
      GAME.assignments[vesselId].cranes = cranes;
      addEvent('info', `▸ ${cranes} grúas STS asignadas`);
      io.emit('gameState', getPublicState());
    }
  });

  // Assign block
  socket.on('assignBlock', ({ vesselId, block }) => {
    if (GAME.assignments[vesselId]) {
      GAME.assignments[vesselId].block = block;
      io.emit('gameState', getPublicState());
    }
  });

  // Execute shift
  socket.on('executeShift', () => {
    const allAssigned = GAME.vessels.every(v => GAME.assignments[v.id]?.berth !== null);
    if (!allAssigned) {
      socket.emit('error', 'Debes asignar berth a todos los buques primero');
      return;
    }
    GAME.shiftRunning = true;
    GAME.shiftStartTime = Date.now();
    GAME.shiftProgress = 0;
    GAME.paused = false;
    addEvent('success', '▸ Turno ejecutándose en servidor — corre 24/7');
    startShiftTimer();
    io.emit('gameState', getPublicState());
  });

  // Pause / Resume
  socket.on('pauseShift', () => {
    GAME.paused = !GAME.paused;
    if (GAME.paused) {
      GAME.pausedAt = Date.now();
      addEvent('warn', '▸ Turno pausado');
    } else {
      // Adjust start time for pause duration
      if (GAME.pausedAt) {
        GAME.shiftStartTime += (Date.now() - GAME.pausedAt);
      }
      addEvent('info', '▸ Turno reanudado');
    }
    io.emit('gameState', getPublicState());
  });

  // Resolve crisis
  socket.on('resolveCrisis', ({ optionIdx }) => {
    if (!GAME.crisis) return;
    const option = GAME.crisis.options[optionIdx];
    if (!option) return;

    GAME.budget -= option.cost;
    GAME.satisfaction = Math.max(0, GAME.satisfaction + option.satHit);
    
    if (option.cost > 0) addEvent('warn', `▸ Costo crisis: -$${option.cost.toLocaleString()}`);
    addEvent('success', '▸ Crisis resuelta — operaciones reanudadas');
    
    GAME.crisis = null;
    io.emit('crisisResolved', { option });
    io.emit('gameState', getPublicState());
  });

  // Next shift
  socket.on('nextShift', () => {
    GAME.shiftRunning = false;
    GAME.crisis = null;
    GAME.shiftProgress = 0;
    GAME.shift++;
    
    if (GAME.shift >= 3) { GAME.shift = 0; GAME.day++; }
    if (GAME.day > 3) {
      io.emit('gameOver', { totalScore: GAME.totalScore, scores: GAME.scores });
      return;
    }

    GAME.vessels = generateVessels(GAME.diff);
    GAME.assignments = {};
    GAME.vessels.forEach(v => {
      GAME.assignments[v.id] = { berth: null, cranes: 2, block: 'A', reefer: null };
    });
    GAME.berths = { 1: null, 2: null, 3: null, 4: null };
    GAME.gateProcessed = 0;

    addEvent('success', `▸ ${SHIFTS[GAME.shift].name} iniciado — Día ${GAME.day}`);
    io.emit('gameState', getPublicState());
  });

  // Give instruction during shift
  socket.on('giveInstruction', ({ type, payload }) => {
    if (!GAME.shiftRunning) return;
    switch(type) {
      case 'reassignBlock':
        if (GAME.assignments[payload.vesselId]) {
          GAME.assignments[payload.vesselId].block = payload.block;
          addEvent('info', `▸ Instrucción: redirigir carga al Bloque ${payload.block}`);
        }
        break;
      case 'addCrane':
        if (GAME.assignments[payload.vesselId] && GAME.cranes.active < GAME.cranes.total) {
          GAME.assignments[payload.vesselId].cranes++;
          addEvent('info', `▸ Instrucción: grúa adicional asignada`);
        }
        break;
      case 'removeCrane':
        if (GAME.assignments[payload.vesselId] && GAME.assignments[payload.vesselId].cranes > 1) {
          GAME.assignments[payload.vesselId].cranes--;
          addEvent('info', `▸ Instrucción: grúa liberada`);
        }
        break;
      case 'priorityVessel':
        addEvent('warn', `▸ Instrucción: prioridad máxima a ${payload.vesselId}`);
        break;
    }
    io.emit('gameState', getPublicState());
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected — shift continues on server');
  });
});

// ── API ROUTES ──
app.get('/state', (req, res) => res.json(getPublicState()));
app.get('/health', (req, res) => res.json({ status: 'ok', serverTime: new Date().toISOString() }));

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚢 Puerto Chancay Terminal Simulator`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌊 Ready for operations 24/7`);
});
