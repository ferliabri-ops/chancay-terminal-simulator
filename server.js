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
    vessels.push({
      id: `V${i+1}`,
      name: rnd(VESSEL_NAMES),
      sl, teu, eta, hasReefer,
      reeferCount: hasReefer ? rndInt(50, 220) : 0,
      progress: 0,
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

    // Movimientos basados en grúas activas
    const totalCranes = Object.values(GAME.assignments)
      .reduce((s, a) => s + (a && a.berth ? (a.cranes || 2) : 0), 0);
    GAME.cranes.active = totalCranes;
    GAME.moves = Math.round(totalCranes * 22 * (GAME.shiftProgress / 100));

    // Gate activity
    GAME.gateQueue = rndInt(2, 20);
    GAME.gateProcessed += rndInt(0, 1);

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
    const allAssigned = GAME.vessels.every(v => GAME.assignments[v.id]?.berth !== null);
    if (!allAssigned) { socket.emit('errMsg', 'Asigna berth a todos los buques primero'); return; }
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
          addEvent('info', `▸ Instrucción: +1 grúa → ${v?.name.split(' ')[0]} (${GAME.assignments[payload.vesselId].cranes} total)`);
        }
        break;
      case 'removeCrane':
        if (GAME.assignments[payload.vesselId] && (GAME.assignments[payload.vesselId].cranes || 2) > 1) {
          GAME.assignments[payload.vesselId].cranes = Math.max(1, (GAME.assignments[payload.vesselId].cranes || 2) - 1);
          addEvent('warn', `▸ Instrucción: -1 grúa asignada`);
        }
        break;
      case 'reassignBlock':
        if (GAME.assignments[payload.vesselId]) {
          const oldBlock = GAME.assignments[payload.vesselId].block;
          GAME.assignments[payload.vesselId].block = payload.block;
          addEvent('info', `▸ Instrucción: carga redirigida ${oldBlock} → Bloque ${payload.block}`);
        }
        break;
      case 'priorityVessel':
        const v = GAME.vessels.find(v=>v.id===payload.vesselId);
        addEvent('warn', `▸ Instrucción: PRIORIDAD MÁXIMA → ${v?.name.split(' ')[0]}`);
        break;
      case 'callTechnician':
        addEvent('info', `▸ Instrucción: técnico de reefer despachado al patio`);
        GAME.budget -= 500;
        break;
      case 'openGateLane':
        addEvent('info', `▸ Instrucción: carril adicional de gate abierto`);
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

<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Puerto Chancay — Terminal Operations Simulator</title>
<script src="/socket.io/socket.io.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&family=Exo+2:wght@300;400;500;600&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
:root{
  --void:#020B08;--panel:#061F16;--surface:#0A2D1E;--edge:#0F4A30;--edge2:#1A6040;
  --green:#00FF9C;--green2:#00CC7A;--gold:#FFD700;--gold2:#FFA500;
  --red:#FF2D55;--blue:#00D4FF;--purple:#BF5FFF;--amber:#FFB300;--teal:#00E5CC;
  --text:#E0FFF0;--muted:#2A6045;
}
html,body{width:100%;height:100%;overflow:hidden;background:var(--void);font-family:'Exo 2',sans-serif;color:var(--text);}
.mono{font-family:'Share Tech Mono',monospace;}
.orb{font-family:'Orbitron',sans-serif;}
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,255,156,.006) 3px,rgba(0,255,156,.006) 4px);pointer-events:none;z-index:9999;}

/* ═══════ INTRO ═══════ */
#intro{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--void);overflow:hidden;transition:opacity .8s;}
.stars{position:absolute;inset:0;pointer-events:none;}
.star{position:absolute;border-radius:50%;animation:twinkle var(--d,3s) ease-in-out infinite;opacity:0;}
@keyframes twinkle{0%,100%{opacity:0}50%{opacity:var(--op,.8)}}
.ocean{position:absolute;bottom:0;left:0;right:0;height:40%;}
.ocean canvas{width:100%;height:100%;}
.ship-intro{position:absolute;font-size:32px;animation:sail var(--dur,30s) linear infinite;opacity:.5;filter:drop-shadow(0 4px 8px rgba(0,255,156,.3));}
@keyframes sail{from{transform:translateX(-120px) scaleX(1)}to{transform:translateX(calc(100vw + 120px)) scaleX(1)}}
.intro-wrap{position:relative;z-index:2;text-align:center;padding:20px;}
.intro-badge{font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:4px;color:var(--green);text-transform:uppercase;margin-bottom:24px;opacity:0;animation:fu .8s ease .3s both;}
.intro-title{font-family:'Orbitron',sans-serif;font-size:clamp(40px,9vw,100px);font-weight:900;line-height:.88;letter-spacing:-3px;margin-bottom:20px;opacity:0;animation:fu .8s ease .6s both;}
.intro-title .l1{color:var(--text);display:block;}
.intro-title .l2{color:var(--green);text-shadow:0 0 60px rgba(0,255,156,.4);display:block;}
.intro-sub{font-size:13px;color:var(--muted);font-weight:300;margin-bottom:50px;opacity:0;animation:fu .8s ease .9s both;letter-spacing:3px;}
.diff-label{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:20px;opacity:0;animation:fu .8s ease 1.2s both;}
.diff-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;max-width:860px;width:100%;opacity:0;animation:fu .8s ease 1.4s both;}
.diff-card{background:rgba(0,0,0,.5);border:1px solid var(--edge);border-radius:14px;padding:22px 16px;cursor:pointer;transition:all .35s;position:relative;overflow:hidden;}
.diff-card::before{content:'';position:absolute;inset:0;opacity:0;transition:opacity .3s;background:radial-gradient(circle at 50% 0%,rgba(0,255,156,.08),transparent 70%);}
.diff-card:hover::before{opacity:1;}
.diff-card:hover{transform:translateY(-6px);}
.diff-card[data-d="easy"]:hover{border-color:var(--green);box-shadow:0 8px 30px rgba(0,255,156,.15);}
.diff-card[data-d="medium"]:hover{border-color:var(--amber);box-shadow:0 8px 30px rgba(255,179,0,.15);}
.diff-card[data-d="hard"]:hover{border-color:#FF6B35;box-shadow:0 8px 30px rgba(255,107,53,.15);}
.diff-card[data-d="expert"]:hover{border-color:var(--red);box-shadow:0 8px 30px rgba(255,45,85,.15);}
.diff-icon{font-size:30px;margin-bottom:12px;}
.diff-name{font-family:'Orbitron',sans-serif;font-size:14px;font-weight:700;margin-bottom:8px;}
.dn-e{color:var(--green)}.dn-m{color:var(--amber)}.dn-h{color:#FF6B35}.dn-x{color:var(--red)}
.diff-desc{font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:10px;}
.diff-stats{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--edge2);line-height:1.6;}
.diff-rec{font-size:9px;font-weight:700;padding:2px 8px;border-radius:100px;background:rgba(255,179,0,.15);color:var(--amber);border:1px solid rgba(255,179,0,.3);display:inline-block;margin-bottom:8px;}
@keyframes fu{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}

/* ═══════ SIMULATOR ═══════ */
#sim{position:fixed;inset:0;display:none;flex-direction:column;}
#sim.show{display:flex;}

/* TOPBAR */
.topbar{height:46px;background:var(--panel);border-bottom:1px solid var(--edge);display:flex;align-items:center;padding:0 12px;gap:10px;flex-shrink:0;overflow-x:auto;}
.tb-logo{font-family:'Orbitron',sans-serif;font-size:12px;font-weight:800;color:var(--green);letter-spacing:2px;white-space:nowrap;}
.tb-logo span{color:var(--gold);}
.tbdiv{width:1px;height:22px;background:var(--edge);flex-shrink:0;}
.tb-kpi{display:flex;flex-direction:column;gap:1px;flex-shrink:0;}
.tb-lbl{font-family:'Share Tech Mono',monospace;font-size:7px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;}
.tb-val{font-family:'Share Tech Mono',monospace;font-size:11px;font-weight:500;}
.g{color:var(--green)}.gd{color:var(--gold)}.r{color:var(--red)}.a{color:var(--amber)}.b{color:var(--blue)}
.conn-status{display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0;}
.cdot{width:6px;height:6px;border-radius:50%;background:var(--red);animation:blink 1s infinite;}
.cdot.on{background:var(--green);animation:glowPulse 2s infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
@keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(0,255,156,.4)}50%{box-shadow:0 0 0 4px rgba(0,255,156,0)}}
.conn-lbl{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);}
.tb-clock{font-family:'Share Tech Mono',monospace;font-size:12px;color:var(--green);flex-shrink:0;}
.dbadge{font-family:'Orbitron',sans-serif;font-size:8px;font-weight:700;padding:2px 8px;border-radius:100px;flex-shrink:0;}
.db-easy{background:rgba(0,255,156,.1);color:var(--green);border:1px solid rgba(0,255,156,.3);}
.db-medium{background:rgba(255,179,0,.1);color:var(--amber);border:1px solid rgba(255,179,0,.3);}
.db-hard{background:rgba(255,107,53,.1);color:#FF6B35;border:1px solid rgba(255,107,53,.3);}
.db-expert{background:rgba(255,45,85,.1);color:var(--red);border:1px solid rgba(255,45,85,.3);}

/* PROGRESS BAR */
.prog-bar-wrap{height:28px;background:rgba(0,0,0,.4);border-bottom:1px solid var(--edge);display:flex;align-items:center;padding:0 12px;gap:12px;flex-shrink:0;}
.prog-info{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);white-space:nowrap;}
.prog-track{flex:1;height:4px;background:var(--edge);border-radius:4px;overflow:hidden;}
.prog-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--teal));border-radius:4px;transition:width 1s linear;}
.time-info{font-family:'Share Tech Mono',monospace;font-size:9px;white-space:nowrap;}

/* MAIN BODY */
.simbody{display:flex;flex:1;overflow:hidden;}

/* LEFT PANEL */
.lp{width:195px;background:var(--panel);border-right:1px solid var(--edge);display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto;}
.lpsec{padding:10px 12px;border-bottom:1px solid var(--edge);}
.lptitle{font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:9px;}
.kpi{margin-bottom:9px;}
.kpilbl{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);margin-bottom:2px;}
.kpival{font-family:'Orbitron',sans-serif;font-size:16px;font-weight:700;color:var(--green);line-height:1;}
.kpisub{font-family:'Share Tech Mono',monospace;font-size:7px;color:var(--muted);margin-top:1px;}
.kpibar{height:3px;background:var(--edge);border-radius:3px;overflow:hidden;margin-top:3px;}
.kpifill{height:100%;border-radius:3px;transition:width .8s;}
.fin-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);}
.fin-lbl{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);}
.fin-val{font-family:'Share Tech Mono',monospace;font-size:9px;font-weight:600;}
.staff-bar{display:flex;gap:2px;flex-wrap:wrap;margin-top:6px;}
.staff-dot{width:6px;height:6px;border-radius:50%;background:var(--green);transition:background .3s;}
.staff-dot.tired{background:var(--amber);}
.staff-dot.exhausted{background:var(--red);}

/* CANVAS AREA */
.canvas-wrap{flex:1;position:relative;overflow:hidden;}
canvas#terminalCanvas{position:absolute;inset:0;width:100%;height:100%;}

/* CRANE STRUCTURES (HTML overlay) */
.crane-overlay{position:absolute;inset:0;pointer-events:none;}
.sts-crane{position:absolute;pointer-events:none;}
.crane-mast{position:absolute;background:var(--amber);box-shadow:0 0 6px rgba(255,179,0,.3);}
.crane-boom{position:absolute;background:var(--amber);transform-origin:right center;box-shadow:0 0 4px rgba(255,179,0,.2);}
.crane-trolley{position:absolute;width:10px;height:10px;background:var(--red);border-radius:2px;box-shadow:0 0 8px var(--red);}
.crane-rope{position:absolute;width:1.5px;background:rgba(255,255,255,.4);}
.crane-cbox{position:absolute;width:14px;height:9px;border-radius:1px;border:1px solid rgba(255,255,255,.4);}

/* MOVING CONTAINERS */
.moving-container{position:absolute;width:18px;height:11px;border-radius:2px;pointer-events:none;z-index:10;transition:all 1.5s cubic-bezier(.4,0,.2,1);box-shadow:0 2px 8px rgba(0,0,0,.5);}

/* TRUCKS */
.truck-sprite{position:absolute;font-size:14px;pointer-events:none;z-index:8;transition:all .5s linear;filter:drop-shadow(0 2px 4px rgba(0,255,156,.3));}

/* YARD SLOTS */
.yard-overlay{position:absolute;pointer-events:none;}
.yslot{position:absolute;border-radius:1px;transition:background .5s,transform .3s;}
.yslot.new-container{animation:containerDrop .6s ease both;}
@keyframes containerDrop{from{transform:scale(0) translateY(-10px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}

/* CRISIS FLASH */
.crisis-flash{position:fixed;inset:0;background:rgba(255,45,85,.15);pointer-events:none;z-index:490;display:none;animation:flashPulse .5s ease-in-out infinite;}
@keyframes flashPulse{0%,100%{opacity:0}50%{opacity:1}}

/* RIGHT PANEL */
.rp{width:275px;background:var(--panel);border-left:1px solid var(--edge);display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto;}
.rpsec{padding:11px 12px;border-bottom:1px solid var(--edge);}
.rptitle{font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:9px;}
.shift-card{background:rgba(0,0,0,.35);border:1px solid var(--edge);border-radius:8px;padding:10px;}
.shname{font-family:'Orbitron',sans-serif;font-size:13px;font-weight:700;color:var(--gold);}
.shtime{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);margin-top:2px;}
.shday{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--green);margin-top:2px;}
.vc{background:rgba(0,0,0,.3);border:1px solid var(--edge);border-radius:7px;padding:9px;margin-bottom:7px;cursor:pointer;transition:all .2s;}
.vc:hover{border-color:var(--blue);}
.vc.sel{border-color:var(--green);background:rgba(0,255,156,.04);}
.vc-name{font-family:'Orbitron',sans-serif;font-size:9px;font-weight:700;margin-bottom:3px;}
.vc-row{display:flex;justify-content:space-between;font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);margin-bottom:1px;}
.vc-val{color:var(--text);}
.dlbl{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);margin-bottom:4px;margin-top:9px;letter-spacing:1px;text-transform:uppercase;}
.dopts{display:flex;gap:3px;flex-wrap:wrap;}
.dbn{background:transparent;border:1px solid var(--edge);color:var(--muted);padding:4px 7px;border-radius:4px;font-family:'Share Tech Mono',monospace;font-size:8px;cursor:pointer;transition:all .2s;}
.dbn:hover{border-color:var(--green);color:var(--green);}
.dbn.sel{background:rgba(0,255,156,.1);border-color:var(--green);color:var(--green);}
.dbn.warn:hover{border-color:var(--amber);color:var(--amber);}
.exec-btn{width:100%;background:linear-gradient(135deg,var(--green),var(--green2));border:none;color:var(--void);padding:10px;border-radius:8px;font-family:'Orbitron',sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;cursor:pointer;transition:all .2s;margin-top:9px;}
.exec-btn:hover:not(:disabled){transform:scale(1.02);box-shadow:0 0 20px rgba(0,255,156,.3);}
.exec-btn:disabled{opacity:.35;cursor:not-allowed;}
.pause-btn{width:100%;background:transparent;border:1px solid var(--amber);color:var(--amber);padding:7px;border-radius:8px;font-family:'Orbitron',sans-serif;font-size:9px;font-weight:700;letter-spacing:2px;cursor:pointer;transition:all .2s;margin-top:5px;display:none;}
.pause-btn:hover{background:rgba(255,179,0,.1);}
.instr-panel{background:rgba(0,255,156,.03);border:1px solid rgba(0,255,156,.15);border-radius:8px;padding:9px;margin-top:8px;display:none;}
.instr-title{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--green);letter-spacing:1px;margin-bottom:7px;text-transform:uppercase;}
.instr-vessel{margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--edge);}
.instr-vessel:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0;}
.iname{font-family:'Share Tech Mono',monospace;font-size:8px;margin-bottom:4px;}
.ibtns{display:flex;gap:3px;flex-wrap:wrap;}
.ibtn{background:rgba(0,0,0,.4);border:1px solid var(--edge);color:var(--muted);padding:3px 7px;border-radius:3px;font-family:'Share Tech Mono',monospace;font-size:8px;cursor:pointer;transition:all .2s;}
.ibtn:hover{border-color:var(--teal);color:var(--teal);}
.ibtn.red:hover{border-color:var(--red);color:var(--red);}
.ev-log{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow-y:auto;}
.ev{font-family:'Share Tech Mono',monospace;font-size:8px;padding:3px 6px;border-radius:2px;border-left:2px solid;line-height:1.4;}
.ev.info{border-color:var(--blue);background:rgba(0,212,255,.03);color:var(--blue);}
.ev.warn{border-color:var(--amber);background:rgba(255,179,0,.03);color:var(--amber);}
.ev.danger{border-color:var(--red);background:rgba(255,45,85,.03);color:var(--red);}
.ev.success{border-color:var(--green);background:rgba(0,255,156,.03);color:var(--green);}

/* REEFER MONITOR */
.reefer-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:3px;margin-top:6px;}
.rplugg{width:100%;aspect-ratio:1;border-radius:2px;transition:all .5s;}
.rplugg.on{background:var(--amber);box-shadow:0 0 4px var(--amber);}
.rplugg.off{background:var(--edge);}
.rplugg.alarm{background:var(--red);animation:blink .5s infinite;}
.temp-badge{display:inline-flex;align-items:center;gap:4px;font-family:'Share Tech Mono',monospace;font-size:9px;padding:3px 8px;border-radius:4px;margin-top:4px;}
.temp-ok{background:rgba(0,255,156,.1);color:var(--green);border:1px solid rgba(0,255,156,.2);}
.temp-warn{background:rgba(255,45,85,.1);color:var(--red);border:1px solid rgba(255,45,85,.2);}

/* GATE PANEL */
.gate-lanes-ctrl{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;}
.gate-lane-ctrl{background:rgba(0,0,0,.3);border:1px solid var(--edge);border-radius:5px;padding:6px;text-align:center;cursor:pointer;transition:all .2s;}
.gate-lane-ctrl.in-lane{border-color:rgba(0,255,156,.2);}
.gate-lane-ctrl.out-lane{border-color:rgba(255,45,85,.2);}
.gate-lane-ctrl.open{opacity:1;}
.gate-lane-ctrl.closed{opacity:.4;}
.gate-lane-lbl{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);margin-bottom:3px;}
.gate-lane-status{font-family:'Orbitron',sans-serif;font-size:9px;font-weight:700;}

/* CRISIS MODAL */
.crisis-overlay{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:500;display:none;align-items:center;justify-content:center;}
.crisis-overlay.show{display:flex;}
.crisis-modal{background:var(--panel);border:2px solid var(--red);border-radius:14px;padding:28px;max-width:440px;width:94%;box-shadow:0 0 60px rgba(255,45,85,.25),0 0 120px rgba(255,45,85,.1);animation:crisisIn .5s cubic-bezier(.34,1.56,.64,1);}
@keyframes crisisIn{from{transform:scale(.7) rotate(-3deg);opacity:0}to{transform:scale(1) rotate(0);opacity:1}}
.crisis-badge{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:3px;color:var(--red);text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:8px;}
.crisis-badge::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--red);animation:blink .5s infinite;}
.crisis-timer{font-family:'Orbitron',sans-serif;font-size:48px;font-weight:900;color:var(--red);text-align:center;margin:10px 0;line-height:1;text-shadow:0 0 30px rgba(255,45,85,.5);}
.crisis-timer.urgent{color:var(--red);animation:timerUrgent .3s ease-in-out infinite alternate;}
@keyframes timerUrgent{from{transform:scale(1)}to{transform:scale(1.05)}}
.crisis-title{font-family:'Orbitron',sans-serif;font-size:18px;font-weight:800;color:var(--text);margin-bottom:8px;}
.crisis-desc{font-size:12px;color:var(--muted);line-height:1.7;margin-bottom:20px;}
.crisis-opts{display:flex;flex-direction:column;gap:8px;}
.copt{background:rgba(0,0,0,.35);border:1px solid var(--edge);border-radius:9px;padding:11px 15px;cursor:pointer;transition:all .25s;text-align:left;width:100%;}
.copt:hover{border-color:var(--amber);background:rgba(255,179,0,.06);transform:translateX(4px);}
.copt-lbl{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--amber);letter-spacing:1px;margin-bottom:3px;}
.copt-desc{font-size:11px;color:var(--muted);}
.copt-cost{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--red);margin-top:3px;}

/* REPORT MODAL */
.rep-overlay{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:600;display:none;align-items:center;justify-content:center;}
.rep-overlay.show{display:flex;}
.rep-modal{background:var(--panel);border:1px solid var(--edge);border-radius:18px;padding:30px;max-width:500px;width:94%;max-height:92vh;overflow-y:auto;}
.rep-title{font-family:'Orbitron',sans-serif;font-size:22px;font-weight:900;color:var(--gold);margin-bottom:4px;}
.rep-sub{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);margin-bottom:24px;letter-spacing:1px;}
.score-ring{width:120px;height:120px;margin:0 auto 20px;position:relative;}
.score-ring svg{width:100%;height:100%;}
.score-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.score-num{font-family:'Orbitron',sans-serif;font-size:36px;font-weight:900;color:var(--green);line-height:1;}
.score-max{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);}
.rep-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05);}
.rep-row:last-child{border:none;}
.rep-k{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);}
.rep-v{font-family:'Orbitron',sans-serif;font-size:13px;font-weight:700;}
.rep-bar{flex:1;height:3px;background:var(--edge);border-radius:3px;overflow:hidden;margin:0 10px;}
.rep-fill{height:100%;border-radius:3px;}
.fin-summary{background:rgba(0,0,0,.3);border:1px solid var(--edge);border-radius:8px;padding:12px;margin:14px 0;}
.fin-sum-row{display:flex;justify-content:space-between;padding:4px 0;font-family:'Share Tech Mono',monospace;font-size:9px;}
.fin-sum-row .label{color:var(--muted);}
.rank-badge{text-align:center;margin:14px 0;padding:14px;background:rgba(0,0,0,.3);border-radius:10px;border:1px solid var(--edge);}
.rank-title{font-family:'Orbitron',sans-serif;font-size:16px;font-weight:800;margin-bottom:4px;}
.rank-desc{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);}
.lloyd-box{background:rgba(0,255,156,.04);border:1px solid rgba(0,255,156,.15);border-radius:8px;padding:10px;margin-top:12px;}
.lloyd-title{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--green);letter-spacing:1px;margin-bottom:6px;text-transform:uppercase;}
.lloyd-mod{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);line-height:1.9;}
.next-btn{width:100%;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--void);padding:14px;border-radius:9px;font-family:'Orbitron',sans-serif;font-size:12px;font-weight:800;letter-spacing:2px;cursor:pointer;margin-top:18px;transition:all .2s;}
.next-btn:hover{transform:scale(1.02);box-shadow:0 0 24px rgba(255,215,0,.3);}

/* RANKING */
.ranking-table{width:100%;border-collapse:collapse;margin-top:10px;}
.ranking-table th{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);padding:5px;text-align:left;border-bottom:1px solid var(--edge);}
.ranking-table td{font-family:'Share Tech Mono',monospace;font-size:9px;padding:6px 5px;border-bottom:1px solid rgba(255,255,255,.04);}
.rank-1{color:var(--gold);}
.rank-2{color:var(--muted);}
.rank-3{color:#CD7F32;}

::-webkit-scrollbar{width:3px;height:3px;}
::-webkit-scrollbar-track{background:var(--void);}
::-webkit-scrollbar-thumb{background:var(--edge);border-radius:2px;}
::-webkit-scrollbar-thumb:hover{background:var(--green);}
</style>
</head>
<body>

<div class="crisis-flash" id="crisis-flash"></div>

<!-- ═══════ INTRO ═══════ -->
<div id="intro">
  <div class="stars" id="stars"></div>
  <div class="ocean"><canvas id="oceanCanvas"></canvas></div>
  <div class="ship-intro" style="--dur:22s;bottom:38%;font-size:36px">🚢</div>
  <div class="ship-intro" style="--dur:35s;animation-delay:-14s;bottom:40%;font-size:24px">🚢</div>
  <div class="ship-intro" style="--dur:50s;animation-delay:-28s;bottom:37%;font-size:20px">🚢</div>
  <div class="intro-wrap">
    <div class="intro-badge mono">▸ TERMINAL OPERATIONS SIMULATOR v2.0 — SERVIDOR 24/7</div>
    <div class="intro-title"><span class="l1">PUERTO</span><span class="l2">CHANCAY</span></div>
    <div class="intro-sub mono">HUB DEL PACÍFICO &nbsp;·&nbsp; CALLAO, PERÚ &nbsp;·&nbsp; COSCO SHIPPING &nbsp;·&nbsp; TURNO DE 8 HORAS REALES</div>
    <div class="diff-label">SELECCIONA TU NIVEL DE OPERADOR</div>
    <div class="diff-grid">
      <div class="diff-card" data-d="easy" onclick="startGame('easy')">
        <div class="diff-icon">🟢</div>
        <div class="diff-name dn-e orb">EASY</div>
        <div class="diff-desc">Aprende los fundamentos del terminal management. Ideal para empezar.</div>
        <div class="diff-stats mono">2 buques/turno<br>Crisis cada 3 turnos<br>Budget: $60,000</div>
      </div>
      <div class="diff-card" data-d="medium" onclick="startGame('medium')">
        <div class="diff-rec">RECOMENDADO</div>
        <div class="diff-icon">🟡</div>
        <div class="diff-name dn-m orb">MEDIUM</div>
        <div class="diff-desc">Operaciones reales con presión moderada. Tu nivel actual.</div>
        <div class="diff-stats mono">3 buques/turno<br>Crisis cada 2 turnos<br>Budget: $45,000</div>
      </div>
      <div class="diff-card" data-d="hard" onclick="startGame('hard')">
        <div class="diff-icon">🔴</div>
        <div class="diff-name dn-h orb">HARD</div>
        <div class="diff-desc">Alta demanda, recursos limitados, navieras muy exigentes.</div>
        <div class="diff-stats mono">4 buques/turno<br>Crisis cada turno<br>Budget: $30,000</div>
      </div>
      <div class="diff-card" data-d="expert" onclick="startGame('expert')">
        <div class="diff-icon">⚫</div>
        <div class="diff-name dn-x orb">EXPERT</div>
        <div class="diff-desc">Modo Chancay día 1. Solo para Terminal Managers reales.</div>
        <div class="diff-stats mono">5+ buques/turno<br>Crisis múltiples<br>Budget: $20,000</div>
      </div>
    </div>
  </div>
</div>

<!-- ═══════ SIMULATOR ═══════ -->
<div id="sim">
  <!-- TOPBAR -->
  <div class="topbar">
    <div class="tb-logo orb">⚓ CHANCAY <span>OPS</span></div>
    <div class="tbdiv"></div>
    <div class="tb-kpi"><div class="tb-lbl">DÍA</div><div class="tb-val g" id="tb-day">1/3</div></div>
    <div class="tb-kpi"><div class="tb-lbl">TURNO</div><div class="tb-val gd" id="tb-shift">--</div></div>
    <div class="tbdiv"></div>
    <div class="tb-kpi"><div class="tb-lbl">BUDGET</div><div class="tb-val g" id="tb-budget">$0</div></div>
    <div class="tb-kpi"><div class="tb-lbl">REVENUE</div><div class="tb-val g" id="tb-rev">$0</div></div>
    <div class="tb-kpi"><div class="tb-lbl">DEMURRAGE</div><div class="tb-val r" id="tb-dem">$0</div></div>
    <div class="tb-kpi"><div class="tb-lbl">P&L</div><div class="tb-val" id="tb-pnl">$0</div></div>
    <div class="tbdiv"></div>
    <div class="tb-kpi"><div class="tb-lbl">SAT.</div><div class="tb-val g" id="tb-sat">100%</div></div>
    <div class="tb-kpi"><div class="tb-lbl">SCORE</div><div class="tb-val gd" id="tb-score">0</div></div>
    <div class="conn-status">
      <div class="cdot" id="cdot"></div>
      <div class="conn-lbl mono" id="clbl">CONECTANDO...</div>
    </div>
    <div class="tb-clock mono" id="tbclock">--:--</div>
    <div class="dbadge db-medium" id="dbadge">MEDIUM</div>
  </div>

  <!-- PROGRESS -->
  <div class="prog-bar-wrap">
    <div class="prog-info mono" id="prog-label">TURNO EN ESPERA</div>
    <div class="prog-track"><div class="prog-fill" id="prog-fill" style="width:0%"></div></div>
    <div class="time-info mono">
      <span class="a" id="elapsed">00:00:00</span>
      <span class="muted"> / </span>
      <span class="g" id="remaining">08:00:00</span>
    </div>
  </div>

  <div class="simbody">
    <!-- LEFT KPIs -->
    <div class="lp">
      <div class="lpsec">
        <div class="lptitle">Terminal KPIs</div>
        <div class="kpi">
          <div class="kpilbl">MOVES TOTALES</div>
          <div class="kpival g" id="kpi-moves">0</div>
          <div class="kpisub">movimientos completados</div>
        </div>
        <div class="kpi">
          <div class="kpilbl">MOVES/HR ESTIMADO</div>
          <div class="kpival" id="kpi-movehr">0</div>
          <div class="kpisub">meta: 25 mov/hr por grúa</div>
          <div class="kpibar"><div class="kpifill" id="kpi-movehr-bar" style="width:0%;background:var(--green)"></div></div>
        </div>
        <div class="kpi">
          <div class="kpilbl">SATISFACCIÓN NAVIERAS</div>
          <div class="kpival g" id="kpi-sat">100%</div>
          <div class="kpibar"><div class="kpifill" id="kpi-sat-bar" style="width:100%;background:var(--green)"></div></div>
        </div>
        <div class="kpi">
          <div class="kpilbl">OCUPACIÓN PATIO</div>
          <div class="kpival b" id="kpi-occ">68%</div>
          <div class="kpisub">de 3,000 TEU capacidad</div>
          <div class="kpibar"><div class="kpifill" id="kpi-occ-bar" style="width:68%;background:var(--blue)"></div></div>
        </div>
      </div>

      <div class="lpsec">
        <div class="lptitle">Recursos Activos</div>
        <div class="kpi"><div class="kpilbl">GRÚAS STS</div><div class="kpival a" id="kpi-cranes">0/6</div></div>
        <div class="kpi"><div class="kpilbl">TRACTOS</div><div class="kpival" id="kpi-trucks">0/12</div></div>
        <div class="kpi"><div class="kpilbl">TÉC. REEFER</div><div class="kpival" id="kpi-tech">3/3</div></div>
      </div>

      <div class="lpsec">
        <div class="lptitle">Personal — <span class="g" id="staff-count">45</span> operadores</div>
        <div class="staff-bar" id="staff-bar"></div>
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
          <span style="font-family:'Share Tech Mono',monospace;font-size:7px;color:var(--green)">■ activo</span>
          <span style="font-family:'Share Tech Mono',monospace;font-size:7px;color:var(--amber)">■ cansado</span>
          <span style="font-family:'Share Tech Mono',monospace;font-size:7px;color:var(--red)">■ agotado</span>
        </div>
        <div class="kpi" style="margin-top:8px;">
          <div class="kpilbl">FATIGA PROMEDIO</div>
          <div class="kpival" id="kpi-fatigue">0%</div>
          <div class="kpibar"><div class="kpifill" id="kpi-fatigue-bar" style="width:0%;background:var(--green)"></div></div>
        </div>
      </div>

      <div class="lpsec">
        <div class="lptitle">Monitor Reefers</div>
        <div class="reefer-grid" id="reefer-grid"></div>
        <div id="reefer-temps" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:3px;"></div>
      </div>

      <div class="lpsec">
        <div class="lptitle">Financiero del Turno</div>
        <div class="fin-row"><span class="fin-lbl">Revenue</span><span class="fin-val g" id="fin-rev">$0</span></div>
        <div class="fin-row"><span class="fin-lbl">Costos grúas</span><span class="fin-val r" id="fin-crane">$0</span></div>
        <div class="fin-row"><span class="fin-lbl">Personal</span><span class="fin-val r" id="fin-staff">$0</span></div>
        <div class="fin-row"><span class="fin-lbl">Crisis/Penalidades</span><span class="fin-val r" id="fin-crisis">$0</span></div>
        <div class="fin-row"><span class="fin-lbl">Demurrage</span><span class="fin-val r" id="fin-dem">$0</span></div>
        <div class="fin-row" style="margin-top:4px;padding-top:4px;border-top:1px solid var(--edge);">
          <span class="fin-lbl" style="color:var(--text);">P&L NETO</span>
          <span class="fin-val" id="fin-pnl" style="color:var(--green);font-size:12px;">$0</span>
        </div>
      </div>

      <div class="lpsec">
        <div class="lptitle">Gate Status</div>
        <div class="fin-row"><span class="fin-lbl">En espera</span><span class="fin-val a" id="gate-q">0</span></div>
        <div class="fin-row"><span class="fin-lbl">Procesados</span><span class="fin-val g" id="gate-p">0</span></div>
        <div class="fin-row"><span class="fin-lbl">Throughput/hr</span><span class="fin-val" id="gate-thr">0</span></div>
      </div>

      <div class="lpsec">
        <div class="lptitle">Score Acumulado</div>
        <div class="kpival gd orb" style="font-size:26px;" id="kpi-score-big">0</div>
        <div class="kpisub" id="kpi-score-sub">de 0 puntos posibles</div>
      </div>
    </div>

    <!-- TERMINAL CANVAS -->
    <div class="canvas-wrap" id="canvas-wrap">
      <canvas id="terminalCanvas"></canvas>
      <div class="crane-overlay" id="crane-overlay"></div>
    </div>

    <!-- RIGHT PANEL -->
    <div class="rp">
      <div class="rpsec">
        <div class="rptitle">Turno Actual</div>
        <div class="shift-card">
          <div class="shname orb" id="shname">--</div>
          <div class="shtime mono" id="shtime">--</div>
          <div class="shday mono" id="shday">--</div>
        </div>
      </div>

      <div class="rpsec">
        <div class="rptitle">Buques en Cola</div>
        <div id="vessel-list"></div>
      </div>

      <div class="rpsec">
        <div class="rptitle">Panel de Decisiones</div>
        <div id="dec-panel">
          <div style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--muted);text-align:center;padding:18px 0;">
            ▸ Selecciona un buque para asignar recursos
          </div>
        </div>
        <button class="exec-btn orb" id="exec-btn" onclick="executeShift()" disabled>▶ EJECUTAR TURNO</button>
        <button class="pause-btn orb" id="pause-btn" onclick="togglePause()">⏸ PAUSAR</button>
      </div>

      <!-- INSTRUCCIONES EN VIVO -->
      <div class="rpsec" id="live-sec" style="display:none;">
        <div class="rptitle">⚡ Instrucciones en Vivo</div>
        <div class="instr-panel" id="instr-panel">
          <div class="instr-title">▸ Turno corriendo — 8h en servidor</div>
          <div id="instr-content"></div>
        </div>
      </div>

      <!-- GATE CONTROL -->
      <div class="rpsec" id="gate-ctrl-sec" style="display:none;">
        <div class="rptitle">Control de Gate</div>
        <div class="gate-lanes-ctrl">
          <div class="gate-lane-ctrl in-lane open" id="gate-in1" onclick="toggleGateLane('in1')">
            <div class="gate-lane-lbl">ENTRADA 1</div>
            <div class="gate-lane-status g">ABIERTO</div>
          </div>
          <div class="gate-lane-ctrl in-lane open" id="gate-in2" onclick="toggleGateLane('in2')">
            <div class="gate-lane-lbl">ENTRADA 2</div>
            <div class="gate-lane-status g">ABIERTO</div>
          </div>
          <div class="gate-lane-ctrl out-lane open" id="gate-out1" onclick="toggleGateLane('out1')">
            <div class="gate-lane-lbl">SALIDA 1</div>
            <div class="gate-lane-status r">ABIERTO</div>
          </div>
          <div class="gate-lane-ctrl out-lane open" id="gate-out2" onclick="toggleGateLane('out2')">
            <div class="gate-lane-lbl">SALIDA 2</div>
            <div class="gate-lane-status r">ABIERTO</div>
          </div>
        </div>
      </div>

      <div class="rpsec">
        <div class="rptitle">Event Log</div>
        <div class="ev-log" id="ev-log"></div>
      </div>
    </div>
  </div>
</div>

<!-- CRISIS -->
<div class="crisis-overlay" id="crisis-overlay">
  <div class="crisis-modal">
    <div class="crisis-badge">⚠ CRISIS OPERATIVA — ACCIÓN REQUERIDA</div>
    <div class="crisis-timer mono" id="crisis-timer">30</div>
    <div class="crisis-title" id="crisis-title"></div>
    <div class="crisis-desc" id="crisis-desc"></div>
    <div class="crisis-opts" id="crisis-opts"></div>
  </div>
</div>

<!-- REPORT -->
<div class="rep-overlay" id="rep-overlay">
  <div class="rep-modal">
    <div class="rep-title orb" id="rep-title">REPORTE DE TURNO</div>
    <div class="rep-sub mono" id="rep-sub"></div>
    <div class="score-ring" id="score-ring-wrap">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="8"/>
        <circle id="score-circle" cx="60" cy="60" r="52" fill="none" stroke="var(--green)" stroke-width="8" stroke-linecap="round" stroke-dasharray="327" stroke-dashoffset="327" transform="rotate(-90 60 60)" style="transition:stroke-dashoffset 1.5s ease"/>
      </svg>
      <div class="score-center">
        <div class="score-num" id="rep-score">0</div>
        <div class="score-max mono">/ 100</div>
      </div>
    </div>
    <div id="rep-rows"></div>
    <button class="next-btn orb" id="next-btn" onclick="nextShift()">SIGUIENTE TURNO ▶</button>
  </div>
</div>

<script>
// ══════════════════════════════════════════════
// SOCKET + STATE
// ══════════════════════════════════════════════
const socket = io();
let G = {};
let selectedVessel = null;
let crisisTimerInt = null;
let animFrame = null;
let trucks = [];
let pendingContainers = [];
let fatigue = 0;
let craneCosts = 0;
let crisisCosts = 0;
let gateLanes = {in1:true,in2:true,out1:true,out2:true};
let yardSlots = {};

const SL_COLORS = {
  COSCO:'#EF4444',EVERGREEN:'#22C55E','YANG MING':'#3B82F6',
  OOCL:'#94A3B8',MSC:'#F59E0B',MAERSK:'#06B6D4','CMA CGM':'#C084FC'
};
const STATUS_COLORS = {
  'full-imp':'#1D4ED8','full-exp':'#15803D','empty':'#374151',
  'reefer':'#D97706','damaged':'#DC2626','imo':'#7C3AED','inspect':'#EA580C'
};

// ── SOCKET EVENTS ──
socket.on('connect', () => {
  document.getElementById('cdot').classList.add('on');
  document.getElementById('clbl').textContent = 'SERVIDOR OK';
  document.getElementById('clbl').style.color = 'var(--green)';
});
socket.on('disconnect', () => {
  document.getElementById('cdot').classList.remove('on');
  document.getElementById('clbl').textContent = 'RECONECTANDO...';
  document.getElementById('clbl').style.color = 'var(--red)';
});
socket.on('gameState', (state) => { G = state; updateUI(); });
socket.on('event', (ev) => addEventUI(ev.type, ev.msg, ev.time));
socket.on('crisis', (c) => showCrisis(c));
socket.on('crisisResolved', () => {
  clearInterval(crisisTimerInt);
  document.getElementById('crisis-overlay').classList.remove('show');
  document.getElementById('crisis-flash').style.display = 'none';
});
socket.on('shiftComplete', (d) => showReport(d));
socket.on('gameOver', (d) => showFinalReport(d));
socket.on('errMsg', (m) => addEventUI('danger','⚠ '+m));

// ── CLOCK ──
setInterval(() => {
  const n = new Date();
  document.getElementById('tbclock').textContent =
    `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
}, 1000);

// ══════════════════════════════════════════════
// OCEAN CANVAS ANIMATION
// ══════════════════════════════════════════════
const oceanCanvas = document.getElementById('oceanCanvas');
const octx = oceanCanvas.getContext('2d');
let waveT = 0;

function resizeOcean() {
  oceanCanvas.width = oceanCanvas.offsetWidth;
  oceanCanvas.height = oceanCanvas.offsetHeight;
}

function drawOcean() {
  resizeOcean();
  octx.clearRect(0,0,oceanCanvas.width,oceanCanvas.height);
  const grad = octx.createLinearGradient(0,0,0,oceanCanvas.height);
  grad.addColorStop(0,'rgba(0,26,16,0)');
  grad.addColorStop(.4,'#001A10');
  grad.addColorStop(1,'#003A22');
  octx.fillStyle = grad;
  octx.fillRect(0,0,oceanCanvas.width,oceanCanvas.height);

  // Waves
  [.12,.08,.05].forEach((alpha,wi) => {
    octx.beginPath();
    octx.moveTo(0, oceanCanvas.height*.3);
    for(let x=0; x<=oceanCanvas.width; x+=4) {
      const y = oceanCanvas.height*.3 + Math.sin((x/80) + waveT + wi*1.2) * 8 +
                Math.sin((x/140) + waveT*.7 + wi*.8) * 5;
      octx.lineTo(x,y);
    }
    octx.lineTo(oceanCanvas.width,oceanCanvas.height);
    octx.lineTo(0,oceanCanvas.height);
    octx.closePath();
    const wg = octx.createLinearGradient(0,oceanCanvas.height*.2,0,oceanCanvas.height);
    wg.addColorStop(0,`rgba(0,200,150,${alpha})`);
    wg.addColorStop(1,`rgba(0,80,50,${alpha*.5})`);
    octx.fillStyle = wg;
    octx.fill();
  });
  waveT += 0.015;
  requestAnimationFrame(drawOcean);
}
drawOcean();

// ══════════════════════════════════════════════
// TERMINAL CANVAS — Main visual
// ══════════════════════════════════════════════
const tc = document.getElementById('terminalCanvas');
const ctx = tc.getContext('2d');
let skyColors = {morning:['#FF6B35','#FFB300','#2A4A35'],day:['#001A40','#002A60','#001A20'],night:['#000510','#000A20','#000508']};
let currentSky = 'day';
let skyT = 0;
const BERTH_COUNT = 4;
let berthData = [];

function resizeCanvas() {
  tc.width = tc.offsetWidth;
  tc.height = tc.offsetHeight;
}

function lerp(a,b,t){ return a + (b-a)*t; }

function drawTerminal() {
  resizeCanvas();
  const W = tc.width, H = tc.height;
  ctx.clearRect(0,0,W,H);

  // Sky
  const sc = skyColors[currentSky] || skyColors.day;
  const skyGrad = ctx.createLinearGradient(0,0,0,H*.35);
  skyGrad.addColorStop(0,sc[0]);
  skyGrad.addColorStop(.5,sc[1]);
  skyGrad.addColorStop(1,sc[2]);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0,0,W,H*.35);

  // Stars at night
  if(currentSky === 'night') {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for(let i=0;i<40;i++) {
      const sx = (i*137.5)%W;
      const sy = (i*73.1)%(H*.25);
      const sz = (Math.sin(skyT+i)*.5+.5)*.8+.2;
      ctx.globalAlpha = sz;
      ctx.fillRect(sx,sy,1.5,1.5);
    }
    ctx.globalAlpha = 1;
  }

  // Moon/Sun
  if(currentSky === 'morning' || currentSky === 'day') {
    const sunY = H*.06;
    const sunG = ctx.createRadialGradient(W*.75,sunY,0,W*.75,sunY,50);
    sunG.addColorStop(0,'rgba(255,220,100,0.9)');
    sunG.addColorStop(.5,'rgba(255,180,50,0.3)');
    sunG.addColorStop(1,'transparent');
    ctx.fillStyle = sunG;
    ctx.fillRect(W*.6,0,W*.3,H*.2);
  }
  if(currentSky === 'night') {
    const moonG = ctx.createRadialGradient(W*.8,H*.08,0,W*.8,H*.08,30);
    moonG.addColorStop(0,'rgba(220,240,255,0.8)');
    moonG.addColorStop(.5,'rgba(180,210,255,0.2)');
    moonG.addColorStop(1,'transparent');
    ctx.fillStyle = moonG;
    ctx.fillRect(W*.7,0,W*.2,H*.18);
  }

  // Horizon glow
  const hgGrad = ctx.createLinearGradient(0,H*.28,0,H*.38);
  hgGrad.addColorStop(0,'rgba(0,255,156,0.05)');
  hgGrad.addColorStop(1,'transparent');
  ctx.fillStyle = hgGrad;
  ctx.fillRect(0,H*.28,W,H*.1);

  // Water
  const waterGrad = ctx.createLinearGradient(0,H*.33,0,H*.5);
  waterGrad.addColorStop(0,'#001A10');
  waterGrad.addColorStop(.5,'#002A18');
  waterGrad.addColorStop(1,'#001A0C');
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0,H*.33,W,H*.17);

  // Water shimmer
  for(let i=0;i<6;i++) {
    const wx = (W*.1*i + skyT*20*((i%2)?1:-1)) % W;
    const wy = H*(.35 + i*.022);
    const wal = Math.sin(skyT*2+i) * .04 + .06;
    ctx.fillStyle = `rgba(0,255,156,${wal})`;
    ctx.fillRect(wx,wy,W*.15,1);
  }

  // Ground/Quay
  const quayGrad = ctx.createLinearGradient(0,H*.5,0,H);
  quayGrad.addColorStop(0,'#0A1F14');
  quayGrad.addColorStop(.3,'#061810');
  quayGrad.addColorStop(1,'#030C08');
  ctx.fillStyle = quayGrad;
  ctx.fillRect(0,H*.5,W,H*.5);

  // Quay edge line
  ctx.strokeStyle = 'rgba(0,255,156,0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0,H*.5); ctx.lineTo(W,H*.5);
  ctx.stroke();

  // Berths
  const bw = W / BERTH_COUNT;
  berthData = [];
  for(let i=0;i<BERTH_COUNT;i++) {
    const bx = i * bw;
    const by = H*.33;
    const bh = H*.18;
    berthData.push({x:bx, y:by, w:bw, h:bh, cx:bx+bw*.5});

    // Berth separator
    if(i>0) {
      ctx.strokeStyle = 'rgba(0,255,156,0.1)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4,4]);
      ctx.beginPath();
      ctx.moveTo(bx,H*.5); ctx.lineTo(bx,H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Berth label
    ctx.fillStyle = 'rgba(0,255,156,0.3)';
    ctx.font = `bold 9px 'Share Tech Mono'`;
    ctx.textAlign = 'left';
    ctx.fillText(`BERTH 0${i+1}`,bx+8,H*.52);

    // Vessel
    const vid = G.berths ? G.berths[i+1] : null;
    const v = vid && G.vessels ? G.vessels.find(v=>v.id===vid) : null;
    if(v) {
      drawVessel(ctx, bx, by, bw, bh, v, G.assignments?.[v.id]);
    } else {
      // Empty berth - water reflection
      ctx.fillStyle = 'rgba(0,40,25,0.4)';
      ctx.fillRect(bx+4, by+4, bw-8, bh-8);
      ctx.fillStyle = 'rgba(0,255,156,0.1)';
      ctx.font = `10px 'Share Tech Mono'`;
      ctx.textAlign = 'center';
      ctx.fillText('LIBRE', bx+bw*.5, by+bh*.5);
    }
  }

  // Yard background
  const yardGrad = ctx.createLinearGradient(0,H*.55,0,H*.9);
  yardGrad.addColorStop(0,'rgba(0,20,12,.6)');
  yardGrad.addColorStop(1,'rgba(0,10,6,.3)');
  ctx.fillStyle = yardGrad;
  ctx.fillRect(0,H*.54,W,H*.36);

  // Yard grid lines
  ctx.strokeStyle = 'rgba(0,255,156,0.05)';
  ctx.lineWidth = 1;
  for(let xi=0;xi<8;xi++) {
    ctx.beginPath();
    ctx.moveTo(xi*(W/8),H*.54);
    ctx.lineTo(xi*(W/8),H*.9);
    ctx.stroke();
  }

  // Yard label
  ctx.fillStyle = 'rgba(0,255,156,0.15)';
  ctx.font = `bold 9px 'Share Tech Mono'`;
  ctx.textAlign = 'left';
  ctx.fillText('CONTAINER YARD — PUERTO CHANCAY',8,H*.575);

  // Gate
  const gateY = H*.91;
  const gateGrad = ctx.createLinearGradient(0,gateY,0,H);
  gateGrad.addColorStop(0,'#0A1F14');
  gateGrad.addColorStop(1,'#030C08');
  ctx.fillStyle = gateGrad;
  ctx.fillRect(0,gateY,W,H-gateY);

  ctx.strokeStyle = 'rgba(255,179,0,0.3)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0,gateY); ctx.lineTo(W,gateY);
  ctx.stroke();

  // Gate lanes
  const laneW = W/6;
  ['IN 1','IN 2','IN 3','OUT 1','OUT 2','OUT 3'].forEach((lbl,i) => {
    const lx = i*laneW;
    ctx.strokeStyle = i<3?'rgba(0,255,156,0.2)':'rgba(255,45,85,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.beginPath();
    ctx.moveTo(lx,gateY); ctx.lineTo(lx,H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = i<3?'rgba(0,255,156,0.4)':'rgba(255,45,85,0.4)';
    ctx.font = `8px 'Share Tech Mono'`;
    ctx.textAlign = 'center';
    ctx.fillText(lbl, lx+laneW*.5, gateY+12);
  });

  // Gate status
  ctx.fillStyle = 'rgba(255,179,0,0.6)';
  ctx.font = `bold 9px 'Share Tech Mono'`;
  ctx.textAlign = 'right';
  ctx.fillText(`GATE · EN ESPERA: ${G.gateQueue||0} · HOY: ${G.gateProcessed||0}`, W-8, H*.915);

  // Trucks
  updateTrucks();
  drawTrucks(ctx,W,H);

  skyT += 0.008;
  animFrame = requestAnimationFrame(drawTerminal);
}

function drawVessel(ctx, bx, by, bw, bh, v, a) {
  const W = tc.width, H = tc.height;
  const vx = bx + bw*.08, vy = by + bh*.1;
  const vw = bw*.84, vh = bh*.75;

  // Vessel body
  const vGrad = ctx.createLinearGradient(vx,vy,vx,vy+vh);
  vGrad.addColorStop(0,'rgba(29,78,216,0.6)');
  vGrad.addColorStop(.5,'rgba(15,40,120,0.8)');
  vGrad.addColorStop(1,'rgba(10,25,80,0.9)');
  ctx.fillStyle = vGrad;
  ctx.beginPath();
  ctx.roundRect(vx,vy,vw,vh,4);
  ctx.fill();

  ctx.strokeStyle = `${SL_COLORS[v.sl]||'#3B82F6'}66`;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Vessel name
  ctx.fillStyle = SL_COLORS[v.sl] || '#38BDF8';
  ctx.font = `bold 8px 'Orbitron'`;
  ctx.textAlign = 'center';
  ctx.fillText(v.name.substring(0,12), bx+bw*.5, vy+12);

  // Container rows on vessel
  const cRows = 3, cCols = Math.min(8, Math.floor(vw/16));
  const cprog = (G.shiftProgress||0)/100;
  for(let r=0;r<cRows;r++) {
    for(let c=0;c<cCols;c++) {
      const progress_threshold = (r*cCols+c)/(cRows*cCols);
      if(progress_threshold < cprog) continue; // already unloaded
      const cx2 = vx + 8 + c*(vw/cCols)*.9;
      const cy2 = vy + 22 + r*12;
      const colors = ['#1D4ED8','#15803D','#374151','#D97706'];
      ctx.fillStyle = colors[(r+c)%colors.length];
      ctx.fillRect(cx2,cy2,vw/cCols*.85,10);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = .5;
      ctx.strokeRect(cx2,cy2,vw/cCols*.85,10);
    }
  }

  // Progress bar on vessel
  const progW = vw*.8;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(vx+vw*.1, vy+vh-10, progW, 5);
  ctx.fillStyle = `${SL_COLORS[v.sl]||'#3B82F6'}`;
  ctx.fillRect(vx+vw*.1, vy+vh-10, progW*(G.shiftProgress||0)/100, 5);
}

function drawTrucks(ctx,W,H) {
  trucks.forEach(t => {
    if(!t.visible) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,255,156,0.15)';
    ctx.strokeStyle = 'rgba(0,255,156,0.6)';
    ctx.lineWidth = 1;
    // Truck body
    ctx.fillRect(t.x-12, t.y-5, 20, 9);
    ctx.strokeRect(t.x-12, t.y-5, 20, 9);
    // Container on truck
    if(t.hasContainer) {
      ctx.fillStyle = STATUS_COLORS[t.containerType] || '#1D4ED8';
      ctx.fillRect(t.x-10, t.y-9, 16, 8);
    }
    // Wheels
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.arc(t.x-7,t.y+5,3,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(t.x+5,t.y+5,3,0,Math.PI*2); ctx.fill();
    ctx.restore();
  });
}

function updateTrucks() {
  const W = tc.width, H = tc.height;
  trucks.forEach(t => {
    if(!t.visible) return;
    if(t.pathIdx < t.path.length) {
      const target = t.path[t.pathIdx];
      const tx = target[0]*W, ty = target[1]*H;
      const dx = tx - t.x, dy = ty - t.y;
      const dist = Math.sqrt(dx*dx+dy*dy);
      if(dist < 3) {
        t.pathIdx++;
        if(t.pathIdx >= t.path.length) t.visible = false;
      } else {
        const speed = 1.5;
        t.x += (dx/dist)*speed;
        t.y += (dy/dist)*speed;
      }
    }
  });
  // Clean up
  trucks = trucks.filter(t=>t.visible);
}

function spawnTruck(berthIdx, targetBlock) {
  const W = tc.width, H = tc.height;
  const bw = W/BERTH_COUNT;
  const bx = (berthIdx/BERTH_COUNT) + .5/BERTH_COUNT;
  const blockX = targetBlock * .12 + .05;
  trucks.push({
    x: bx*W, y: H*.52,
    pathIdx: 0,
    visible: true,
    hasContainer: true,
    containerType: 'full-imp',
    path: [
      [bx, .55],
      [blockX, .65],
      [blockX, .7],
    ]
  });
}

// ══════════════════════════════════════════════
// CRANES HTML OVERLAY
// ══════════════════════════════════════════════
function buildCranes() {
  const overlay = document.getElementById('crane-overlay');
  const wrap = document.getElementById('canvas-wrap');
  overlay.innerHTML = '';
  const W = wrap.offsetWidth, H = wrap.offsetHeight;
  const bw = W/BERTH_COUNT;

  for(let i=0;i<BERTH_COUNT;i++) {
    const bx = i*bw;
    const vid = G.berths ? G.berths[i+1] : null;
    const v = vid && G.vessels ? G.vessels.find(v=>v.id===vid) : null;
    const a = v && G.assignments ? G.assignments[v.id] : null;
    const craneCount = a ? Math.min(a.cranes||2, 3) : 0;
    if(!v || !G.shiftRunning) continue;

    for(let c=0;c<craneCount;c++) {
      const cx = bx + (c+1)*bw/(craneCount+1);
      const cy = H*.18;
      const mastH = H*.22;
      const boomW = bw*.45;

      const crane = document.createElement('div');
      crane.className = 'sts-crane';
      crane.style.cssText = `left:${cx-4}px;top:${cy}px;width:8px;height:${mastH}px;`;

      // Mast
      const mast = document.createElement('div');
      mast.className = 'crane-mast';
      mast.style.cssText = `width:5px;height:${mastH}px;left:1.5px;top:0;position:absolute;`;
      crane.appendChild(mast);

      // Boom
      const boom = document.createElement('div');
      boom.className = 'crane-boom';
      boom.style.cssText = `width:${boomW}px;height:3px;left:${-boomW*.6}px;top:${mastH*.15}px;position:absolute;`;
      crane.appendChild(boom);

      // Trolley (animated)
      const trolley = document.createElement('div');
      trolley.className = 'crane-trolley';
      const animDur = 4 + c*1.5;
      const animDelay = c * 1.2;
      trolley.style.cssText = `top:-3px;left:0;position:absolute;animation:trolleySlide ${animDur}s ease-in-out ${animDelay}s infinite;`;
      boom.appendChild(trolley);

      // Rope
      const rope = document.createElement('div');
      rope.className = 'crane-rope';
      const ropeH = H*.08 + Math.random()*H*.04;
      rope.style.cssText = `width:1px;height:${ropeH}px;left:4px;top:3px;position:absolute;background:rgba(255,255,255,0.35);animation:ropeSwing ${animDur}s ease-in-out ${animDelay}s infinite;`;
      trolley.appendChild(rope);

      // Container on hook
      const cbox = document.createElement('div');
      cbox.className = 'crane-cbox';
      const cColors = ['#1D4ED8','#15803D','#D97706','#7C3AED'];
      cbox.style.cssText = `left:-7px;top:${ropeH}px;position:absolute;background:${cColors[c%cColors.length]};opacity:0.85;`;
      trolley.appendChild(cbox);

      overlay.appendChild(crane);

      // Spawn truck periodically
      if(G.shiftRunning && Math.random() < 0.1) {
        setTimeout(() => spawnTruck(i, Math.floor(Math.random()*6)), Math.random()*3000);
      }
    }
  }
}

// Add CSS for crane animation
const craneStyle = document.createElement('style');
craneStyle.textContent = `
@keyframes trolleySlide{
  0%{transform:translateX(0px)}
  45%{transform:translateX(var(--tw,60px))}
  50%{transform:translateX(var(--tw,60px))}
  95%{transform:translateX(0px)}
  100%{transform:translateX(0px)}
}
@keyframes ropeSwing{
  0%,100%{transform:scaleY(1)}
  45%,50%{transform:scaleY(1.3)}
}
`;
document.head.appendChild(craneStyle);

// ══════════════════════════════════════════════
// UPDATE UI
// ══════════════════════════════════════════════
function updateUI() {
  if(!G.active) return;

  currentSky = G.currentShift?.sky || 'day';

  // Topbar
  document.getElementById('tb-day').textContent = `${G.day||1}/3`;
  document.getElementById('tb-shift').textContent = (G.currentShift?.name||'--').replace('TURNO ','');
  const budget = G.budget||0;
  document.getElementById('tb-budget').textContent = `$${budget.toLocaleString()}`;
  document.getElementById('tb-budget').className = `tb-val ${budget<5000?'r':budget<15000?'a':'g'}`;
  document.getElementById('tb-rev').textContent = `$${(G.revenue||0).toLocaleString()}`;
  document.getElementById('tb-dem').textContent = `$${(G.demurrage||0).toLocaleString()}`;
  const pnl = (G.revenue||0) - (G.demurrage||0) - craneCosts - crisisCosts;
  const pnlEl = document.getElementById('tb-pnl');
  pnlEl.textContent = `$${pnl.toLocaleString()}`;
  pnlEl.className = `tb-val ${pnl>=0?'g':'r'}`;
  document.getElementById('tb-sat').textContent = `${G.satisfaction||100}%`;
  const sat = G.satisfaction||100;
  document.getElementById('tb-sat').className = `tb-val ${sat<50?'r':sat<75?'a':'g'}`;
  document.getElementById('tb-score').textContent = G.totalScore||0;

  // Diff badge
  const db = document.getElementById('dbadge');
  db.className = `dbadge db-${G.diff||'medium'}`;
  db.textContent = (G.diff||'medium').toUpperCase();

  // Progress
  const prog = G.shiftProgress||0;
  document.getElementById('prog-fill').style.width = `${prog}%`;
  document.getElementById('elapsed').textContent = G.elapsedFormatted||'00:00:00';
  document.getElementById('remaining').textContent = G.remainingFormatted||'08:00:00';

  const progLbl = document.getElementById('prog-label');
  if(G.shiftRunning && !G.paused) progLbl.textContent = `⚡ TURNO CORRIENDO — ${prog.toFixed(1)}%`;
  else if(G.paused) progLbl.textContent = `⏸ TURNO PAUSADO — ${prog.toFixed(1)}%`;
  else progLbl.textContent = 'TURNO EN ESPERA — ASIGNA RECURSOS';

  // KPIs
  document.getElementById('kpi-moves').textContent = (G.moves||0).toLocaleString();
  const movehr = Math.round((G.moves||0) / Math.max((G.shiftElapsedMs||1)/3600000, 0.01));
  document.getElementById('kpi-movehr').textContent = movehr;
  document.getElementById('kpi-movehr-bar').style.width = `${Math.min(movehr/25*100,100)}%`;
  document.getElementById('kpi-movehr-bar').style.background = movehr>=25?'var(--green)':movehr>=15?'var(--amber)':'var(--red)';
  const satPct = G.satisfaction||100;
  document.getElementById('kpi-sat').textContent = `${satPct}%`;
  document.getElementById('kpi-sat').className = `kpival ${satPct>70?'g':satPct>40?'a':'r'}`;
  document.getElementById('kpi-sat-bar').style.width = `${satPct}%`;
  document.getElementById('kpi-sat-bar').style.background = satPct>70?'var(--green)':satPct>40?'var(--amber)':'var(--red)';
  document.getElementById('kpi-cranes').textContent = `${G.cranes?.active||0}/${G.cranes?.total||6}`;
  document.getElementById('kpi-tech').textContent = `${G.techReefer||3}/3`;

  // Financials
  craneCosts = (G.cranes?.active||0)*800*((G.shiftElapsedMs||0)/3600000);
  document.getElementById('fin-rev').textContent = `$${(G.revenue||0).toLocaleString()}`;
  document.getElementById('fin-crane').textContent = `-$${Math.round(craneCosts).toLocaleString()}`;
  document.getElementById('fin-staff').textContent = `-$${((G.staff||45)*45).toLocaleString()}`;
  document.getElementById('fin-crisis').textContent = `-$${crisisCosts.toLocaleString()}`;
  document.getElementById('fin-dem').textContent = `-$${(G.demurrage||0).toLocaleString()}`;
  const pnlFin = (G.revenue||0) - Math.round(craneCosts) - (G.staff||45)*45 - crisisCosts - (G.demurrage||0);
  const pnlFinEl = document.getElementById('fin-pnl');
  pnlFinEl.textContent = `$${pnlFin.toLocaleString()}`;
  pnlFinEl.style.color = pnlFin>=0?'var(--green)':'var(--red)';

  // Gate
  document.getElementById('gate-q').textContent = G.gateQueue||0;
  document.getElementById('gate-p').textContent = G.gateProcessed||0;
  const gateThr = Math.round((G.gateProcessed||0)/Math.max((G.shiftElapsedMs||1)/3600000,0.01));
  document.getElementById('gate-thr').textContent = gateThr;

  // Staff
  const staffCount = G.staff||45;
  fatigue = Math.min(100, prog*.8);
  document.getElementById('staff-count').textContent = staffCount;
  document.getElementById('kpi-fatigue').textContent = `${Math.round(fatigue)}%`;
  document.getElementById('kpi-fatigue-bar').style.width = `${fatigue}%`;
  document.getElementById('kpi-fatigue-bar').style.background = fatigue>70?'var(--red)':fatigue>40?'var(--amber)':'var(--green)';
  const staffBar = document.getElementById('staff-bar');
  staffBar.innerHTML = '';
  for(let i=0;i<Math.min(staffCount,36);i++) {
    const dot = document.createElement('div');
    dot.className = `staff-dot ${fatigue>70?'exhausted':fatigue>40?'tired':''}`;
    staffBar.appendChild(dot);
  }

  // Reefer monitor
  buildReeferMonitor();

  // Score
  document.getElementById('kpi-score-big').textContent = G.totalScore||0;
  document.getElementById('kpi-score-sub').textContent = `de ${(G.totalShift||0)*100} puntos posibles`;

  // Shift info
  document.getElementById('shname').textContent = G.currentShift?.name||'--';
  document.getElementById('shtime').textContent = G.currentShift?.time||'--';
  document.getElementById('shday').textContent = `DÍA ${G.day||1} DE 3 · TURNO ${(G.totalShift||0)+1}/9`;

  // Vessels
  renderVesselList();

  // Buttons
  const execBtn = document.getElementById('exec-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const liveS = document.getElementById('live-sec');
  const gateCtrl = document.getElementById('gate-ctrl-sec');
  const instrPanel = document.getElementById('instr-panel');

  if(G.shiftRunning) {
    execBtn.style.display='none';
    pauseBtn.style.display='block';
    pauseBtn.textContent = G.paused?'▶ REANUDAR':'⏸ PAUSAR';
    liveS.style.display='block';
    gateCtrl.style.display='block';
    instrPanel.style.display='block';
    renderLiveInstructions();
    buildCranes();
  } else {
    execBtn.style.display='block';
    pauseBtn.style.display='none';
    liveS.style.display='none';
    gateCtrl.style.display='none';
    instrPanel.style.display='none';
    document.getElementById('crane-overlay').innerHTML='';
    const allAssigned = G.vessels?.every(v=>G.assignments?.[v.id]?.berth!==null);
    execBtn.disabled=!allAssigned;
  }

  // Events
  if(G.events?.length) renderEvents();
}

function buildReeferMonitor() {
  const grid = document.getElementById('reefer-grid');
  const temps = document.getElementById('reefer-temps');
  const totalPlugs = 24;
  let onCount = 0;
  G.vessels?.forEach(v => { if(v.hasReefer) onCount += Math.floor((v.reeferCount||0)/8); });
  onCount = Math.min(onCount, totalPlugs);

  grid.innerHTML = '';
  for(let i=0;i<totalPlugs;i++) {
    const p = document.createElement('div');
    const isOn = i < onCount;
    const isAlarm = isOn && Math.random() < 0.03;
    p.className = `rplugg ${isOn?'on':''} ${isAlarm?'alarm':''}`;
    grid.appendChild(p);
  }

  temps.innerHTML = '';
  if(onCount > 0) {
    const tempOk = document.createElement('div');
    tempOk.className = 'temp-badge temp-ok';
    tempOk.textContent = `❄ ${onCount} enchufados · -18°C`;
    temps.appendChild(tempOk);
  }
}

// ══════════════════════════════════════════════
// VESSEL LIST + DECISIONS
// ══════════════════════════════════════════════
function renderVesselList() {
  if(!G.vessels) return;
  document.getElementById('vessel-list').innerHTML = G.vessels.map(v => {
    const a = G.assignments?.[v.id];
    return `<div class="vc ${selectedVessel===v.id?'sel':''}" onclick="selectVessel('${v.id}')">
      <div class="vc-name" style="color:${SL_COLORS[v.sl]||'var(--blue)'}">🚢 ${v.name}</div>
      <div class="vc-row"><span>LÍNEA</span><span class="vc-val">${v.sl}</span></div>
      <div class="vc-row"><span>TEU</span><span class="vc-val">${(v.teu||0).toLocaleString()}</span></div>
      <div class="vc-row"><span>ETA</span><span class="vc-val">${v.eta}</span></div>
      ${v.hasReefer?`<div class="vc-row"><span>REEFERS</span><span class="vc-val a">❄ ${v.reeferCount}</span></div>`:''}
      <div class="vc-row"><span>BERTH</span>
        <span class="vc-val" style="color:${a?.berth?'var(--green)':'var(--red)'};">
          ${a?.berth?`BERTH 0${a.berth}`:'⚠ SIN ASIGNAR'}
        </span>
      </div>
      ${a?.berth?`<div class="vc-row"><span>GRÚAS</span><span class="vc-val a">${a.cranes} STS</span></div>`:''}
    </div>`;
  }).join('');
}

function selectVessel(id) {
  selectedVessel = id;
  renderVesselList();
  renderDecisions();
}

function renderDecisions() {
  const v = G.vessels?.find(v=>v.id===selectedVessel);
  if(!v) return;
  const a = G.assignments?.[v.id]||{};
  const vColor = SL_COLORS[v.sl]||'var(--blue)';

  const berthBtns = [1,2,3,4].map(b => {
    const taken = G.vessels?.find(vv=>vv.id!==v.id && G.assignments?.[vv.id]?.berth===b);
    return `<button class="dbn ${a.berth===b?'sel':''} ${taken?'warn':''}"
      onclick="${taken?'':'assignBerth(\''+v.id+'\','+b+')'}"
      ${taken?'title="Ocupado por '+taken.name.split(' ')[0]+'"':''}>
      B0${b}${taken?'⚠':''}
    </button>`;
  }).join('');

  const craneBtns = [1,2,3,4,5,6].map(c =>
    `<button class="dbn ${a.cranes===c?'sel':''}" onclick="assignCranes('${v.id}',${c})">${c}🏗</button>`
  ).join('');

  const blockBtns = ['A','B','C','D','E'].map(b =>
    `<button class="dbn ${a.block===b?'sel':''}" onclick="assignBlock('${v.id}','${b}')">BLQ ${b}</button>`
  ).join('');

  const reeferHtml = v.hasReefer ? `
    <div class="dlbl">ZONA REEFER (${v.reeferCount} unidades)</div>
    <div class="dopts">
      ${['R1','R2'].map(r=>`<button class="dbn ${a.reefer===r?'sel':''}" onclick="assignReefer('${v.id}','${r}')">❄ ZONA ${r}</button>`).join('')}
    </div>` : '';

  document.getElementById('dec-panel').innerHTML = `
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;color:${vColor};margin-bottom:8px;letter-spacing:1px;">▸ ${v.name} · ${(v.teu||0).toLocaleString()} TEU</div>
    <div class="dlbl">ASIGNAR BERTH</div>
    <div class="dopts">${berthBtns}</div>
    <div class="dlbl">GRÚAS STS (costo $800/hr c/u)</div>
    <div class="dopts">${craneBtns}</div>
    <div class="dlbl">BLOQUE DESTINO EN PATIO</div>
    <div class="dopts">${blockBtns}</div>
    ${reeferHtml}
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);margin-top:8px;padding:6px;background:rgba(0,0,0,.3);border-radius:4px;">
      💡 +grúas = más velocidad y costo | Bloque lleno = redirigir durante el turno
    </div>`;
}

function renderLiveInstructions() {
  if(!G.vessels) return;
  const activeVessels = G.vessels.filter(v=>G.assignments?.[v.id]?.berth);
  document.getElementById('instr-content').innerHTML = activeVessels.map(v => {
    const a = G.assignments[v.id];
    const vColor = SL_COLORS[v.sl]||'var(--blue)';
    return `<div class="instr-vessel">
      <div class="iname" style="color:${vColor}">▸ ${v.name.split(' ').slice(0,2).join(' ')}</div>
      <div class="ibtns">
        <button class="ibtn" onclick="giveInstruction('addCrane','${v.id}')">+🏗 Grúa</button>
        <button class="ibtn red" onclick="giveInstruction('removeCrane','${v.id}')">-🏗 Grúa</button>
        <button class="ibtn" onclick="giveInstruction('priorityVessel','${v.id}')">⚡ Prioridad</button>
      </div>
      <div class="ibtns" style="margin-top:3px;">
        ${['A','B','C','D','E'].map(b=>`<button class="ibtn ${a.block===b?'sel':''}" onclick="giveInstruction('reassignBlock','${v.id}','${b}')">→${b}</button>`).join('')}
        <button class="ibtn" onclick="giveInstruction('callTechnician','${v.id}')">🔧Tech</button>
      </div>
    </div>`;
  }).join('') || `<div style="font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--muted);">No hay buques en operación</div>`;
}

function renderEvents() {
  document.getElementById('ev-log').innerHTML =
    (G.events||[]).slice(0,20).map(e =>
      `<div class="ev ${e.type}">[${e.time}] ${e.msg}</div>`
    ).join('');
}

// ══════════════════════════════════════════════
// SOCKET ACTIONS
// ══════════════════════════════════════════════
function assignBerth(vid,berth){socket.emit('assignBerth',{vesselId:vid,berth});}
function assignCranes(vid,cranes){socket.emit('assignCranes',{vesselId:vid,cranes});}
function assignBlock(vid,block){socket.emit('assignBlock',{vesselId:vid,block});}
function assignReefer(vid,r){socket.emit('assignBlock',{vesselId:vid,block:r});}
function executeShift(){socket.emit('executeShift');}
function togglePause(){socket.emit('pauseShift');}
function nextShift(){document.getElementById('rep-overlay').classList.remove('show');socket.emit('nextShift');}
function giveInstruction(type,vesselId,extra){
  const payload={vesselId};
  if(extra)payload.block=extra;
  socket.emit('giveInstruction',{type,payload});
}
function toggleGateLane(id){
  gateLanes[id]=!gateLanes[id];
  const el=document.getElementById('gate-'+id);
  el.classList.toggle('open',gateLanes[id]);
  el.classList.toggle('closed',!gateLanes[id]);
  el.querySelector('.gate-lane-status').textContent=gateLanes[id]?'ABIERTO':'CERRADO';
  const isIn = id.startsWith('in');
  el.querySelector('.gate-lane-status').style.color=gateLanes[id]?(isIn?'var(--green)':'var(--red)'):'var(--muted)';
  addEventUI('info',`▸ Gate ${id.toUpperCase()} ${gateLanes[id]?'abierto':'cerrado'}`);
}

// ══════════════════════════════════════════════
// CRISIS
// ══════════════════════════════════════════════
function showCrisis(crisis) {
  document.getElementById('crisis-title').textContent = crisis.title;
  document.getElementById('crisis-desc').textContent = crisis.desc;
  document.getElementById('crisis-opts').innerHTML = crisis.options.map((o,i)=>`
    <button class="copt" onclick="resolveCrisis(${i})">
      <div class="copt-lbl">${o.label}</div>
      <div class="copt-desc">${o.desc}</div>
      <div class="copt-cost">${o.cost>0?`Costo: -$${o.cost.toLocaleString()}`:o.cost===0?'Sin costo':'Ahorra costos'} · SAT ${o.satHit}</div>
    </button>`).join('');

  let t=30;
  document.getElementById('crisis-timer').textContent=t;
  clearInterval(crisisTimerInt);
  crisisTimerInt=setInterval(()=>{
    t--;
    const el=document.getElementById('crisis-timer');
    el.textContent=t;
    if(t<=10)el.classList.add('urgent');
    if(t<=0){clearInterval(crisisTimerInt);resolveCrisis(crisis.options.length-1);}
  },1000);

  // Flash effect
  const flash = document.getElementById('crisis-flash');
  flash.style.display='block';
  setTimeout(()=>flash.style.display='none', 3000);

  document.getElementById('crisis-overlay').classList.add('show');
}

function resolveCrisis(idx){
  clearInterval(crisisTimerInt);
  document.getElementById('crisis-timer').classList.remove('urgent');
  socket.emit('resolveCrisis',{optionIdx:idx});
  // Track crisis costs
  if(G.crisis?.options?.[idx]) crisisCosts += G.crisis.options[idx].cost||0;
}

// ══════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════
function showReport(data) {
  const color=data.score>=80?'var(--green)':data.score>=60?'var(--gold)':'var(--red)';
  const isFinal = data.totalShift>=9;

  document.getElementById('rep-title').textContent = isFinal?'🏆 RESULTADO FINAL':'REPORTE DE TURNO';
  document.getElementById('rep-sub').textContent = `TURNO ${data.totalShift} · DÍA ${G.day||1} · PUERTO CHANCAY`;
  document.getElementById('rep-score').textContent = data.score;
  document.getElementById('rep-score').style.color = color;

  // Animate score ring
  const circle = document.getElementById('score-circle');
  const circumference = 327;
  const offset = circumference - (data.score/100)*circumference;
  circle.style.stroke = color;
  setTimeout(()=>circle.style.strokeDashoffset = offset, 300);

  const rank = getRank(data.score);

  document.getElementById('rep-rows').innerHTML = `
    ${[['PRODUCTIVIDAD',data.prodScore,30,'var(--green)'],
       ['FINANCIERO',data.finScore,25,'var(--gold)'],
       ['SATISFACCIÓN',data.satScore,20,'var(--blue)'],
       ['HSSE',data.hsseScore,15,'var(--purple)'],
       ['GESTIÓN CRISIS',data.crisisScore,10,'var(--amber)']
    ].map(([k,v,max,c])=>`
      <div class="rep-row">
        <span class="rep-k">${k}</span>
        <div class="rep-bar"><div class="rep-fill" style="width:${Math.max(0,v/max*100)}%;background:${c}"></div></div>
        <span class="rep-v" style="color:${c}">${v}/${max}</span>
      </div>`).join('')}
    <div class="fin-summary">
      <div class="fin-sum-row"><span class="label">Revenue</span><span style="color:var(--green)">+$${(data.revenue||0).toLocaleString()}</span></div>
      <div class="fin-sum-row"><span class="label">Costos operativos</span><span style="color:var(--red)">-$${(data.costs||0).toLocaleString()}</span></div>
      <div class="fin-sum-row"><span class="label">Demurrage</span><span style="color:var(--red)">-$${(G.demurrage||0).toLocaleString()}</span></div>
      <div class="fin-sum-row" style="border-top:1px solid rgba(255,255,255,.05);padding-top:4px;margin-top:4px;">
        <span style="color:var(--text);">P&L Neto</span>
        <span style="color:${(data.revenue-data.costs)>=0?'var(--green)':'var(--red)'}">$${((data.revenue||0)-(data.costs||0)).toLocaleString()}</span>
      </div>
    </div>
    <div class="rank-badge">
      <div class="rank-title" style="color:${color}">${rank.icon} ${rank.title}</div>
      <div class="rank-desc mono">${rank.desc}</div>
    </div>
    <div class="rep-row"><span class="rep-k">SCORE ACUMULADO</span><span class="rep-v gd orb" style="font-size:16px;">${data.totalScore}/${data.totalShift*100}</span></div>
    <div class="lloyd-box">
      <div class="lloyd-title">MÓDULOS LLOYD'S APLICADOS EN ESTE TURNO</div>
      <div class="lloyd-mod">
        ${data.prodScore>20?'▸ M3 Terminal Operations — Productividad alcanzada ✅':'▸ M3 Terminal Operations — Necesitas más grúas ⚠'}
        <br>${data.finScore>15?'▸ M7 Economics — P&L positivo ✅':'▸ M7 Economics — Revisa tus costos ⚠'}
        <br>▸ M4 HSSE — Seguridad operativa ${data.hsseScore===15?'✅':'⚠'}
        <br>▸ M8 Leadership — Gestión de equipo aplicada ✅
        <br>${data.crisisScore===10?'▸ M9 Legal — Crisis resuelta correctamente ✅':'▸ M9 Legal — Mejorar respuesta a crisis ⚠'}
      </div>
    </div>`;

  const nb=document.getElementById('next-btn');
  if(isFinal){nb.textContent='🏆 VER RESULTADO FINAL';nb.onclick=()=>showFinalReport({totalScore:data.totalScore});}
  else{nb.textContent='SIGUIENTE TURNO ▶';nb.onclick=nextShift;}

  document.getElementById('rep-overlay').classList.add('show');
}

function getRank(score) {
  if(score>=90) return {icon:'👑',title:'TERMINAL MANAGER ÉLITE',desc:'Nivel Chancay / Rotterdam — Listo para el sector portuario'};
  if(score>=75) return {icon:'⭐⭐⭐⭐',title:'OPS SUPERVISOR SENIOR',desc:'Excelente gestión — Candidato a posiciones de liderazgo'};
  if(score>=60) return {icon:'⭐⭐⭐',title:'OPERATIONS SUPERVISOR',desc:'Buena gestión — Sigue practicando los KPIs críticos'};
  if(score>=45) return {icon:'⭐⭐',title:'COORDINADOR DE OPERACIONES',desc:'En desarrollo — Enfócate en productividad y finanzas'};
  return {icon:'⭐',title:'EN ENTRENAMIENTO',desc:'Practica más — Cada turno es una lección'};
}

function showFinalReport(data) {
  const avg = Math.round((data.totalScore||0)/Math.max(G.totalShift||1,1));
  const rank = getRank(avg);
  const color = avg>=80?'var(--green)':avg>=60?'var(--gold)':'var(--red)';

  document.getElementById('rep-title').textContent='🏆 RESULTADO FINAL — 3 DÍAS COMPLETADOS';
  document.getElementById('rep-sub').textContent='9 TURNOS · 3 DÍAS · PUERTO CHANCAY';
  document.getElementById('rep-score').textContent=avg;
  document.getElementById('rep-score').style.color=color;
  const circle=document.getElementById('score-circle');
  circle.style.stroke=color;
  setTimeout(()=>circle.style.strokeDashoffset=327-(avg/100)*327,300);

  document.getElementById('rep-rows').innerHTML=`
    <div class="rank-badge">
      <div class="rank-title" style="color:${color};font-size:20px;">${rank.icon} ${rank.title}</div>
      <div class="rank-desc mono">${rank.desc}</div>
    </div>
    <div class="fin-summary">
      <div class="fin-sum-row"><span class="label">Score Total</span><span style="color:var(--gold);font-family:Orbitron,sans-serif;font-size:16px;">${data.totalScore||0} / ${(G.totalShift||9)*100}</span></div>
      <div class="fin-sum-row"><span class="label">Revenue Total</span><span style="color:var(--green)">$${(G.revenue||0).toLocaleString()}</span></div>
      <div class="fin-sum-row"><span class="label">Demurrage Total</span><span style="color:var(--red)">-$${(G.demurrage||0).toLocaleString()}</span></div>
      <div class="fin-sum-row"><span class="label">Satisfacción Final</span><span style="color:${(G.satisfaction||100)>70?'var(--green)':'var(--red)'}">${G.satisfaction||100}%</span></div>
      <div class="fin-sum-row"><span class="label">Dificultad</span><span>${(G.diff||'medium').toUpperCase()} × ${{'easy':1.0,'medium':1.5,'hard':2.0,'expert':3.0}[G.diff||'medium']}</span></div>
    </div>
    <div class="lloyd-box">
      <div class="lloyd-title">MÓDULOS LLOYD'S DOMINADOS</div>
      <div class="lloyd-mod">
        ▸ M3 Terminal Operations ✅ · ▸ M4 HSSE ✅ · ▸ M7 Economics ✅<br>
        ▸ M8 Managing People ✅ · ▸ M9 Legal Framework ✅ · ▸ M11 Projects ✅
      </div>
    </div>`;

  document.getElementById('next-btn').textContent='🔄 JUGAR DE NUEVO';
  document.getElementById('next-btn').onclick=()=>location.reload();
  document.getElementById('rep-overlay').classList.add('show');
}

// ══════════════════════════════════════════════
// INTRO STARS + START
// ══════════════════════════════════════════════
(function initStars(){
  const c=document.getElementById('stars');
  for(let i=0;i<80;i++){
    const s=document.createElement('div');
    s.className='star';
    const sz=Math.random()<0.2?3:Math.random()<0.5?2:1;
    s.style.cssText=`left:${Math.random()*100}%;top:${Math.random()*65}%;width:${sz}px;height:${sz}px;background:${Math.random()<0.1?'var(--green)':'white'};--d:${2+Math.random()*5}s;--op:${.2+Math.random()*.8};animation-delay:${Math.random()*5}s`;
    c.appendChild(s);
  }
})();

function startGame(diff){
  const intro=document.getElementById('intro');
  intro.style.opacity='0';
  setTimeout(()=>{
    intro.style.display='none';
    document.getElementById('sim').classList.add('show');
    resizeCanvas();
    drawTerminal();
    socket.emit('startGame',diff);
  },800);
}

function addEventUI(type,msg,time){
  const log=document.getElementById('ev-log');
  if(!log)return;
  const n=new Date();
  const t=time||`${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`;
  const div=document.createElement('div');
  div.className=`ev ${type}`;
  div.textContent=`[${t}] ${msg}`;
  log.insertBefore(div,log.firstChild);
  if(log.children.length>20)log.removeChild(log.lastChild);
}

// Resize handler
window.addEventListener('resize',()=>{
  resizeCanvas();
  if(G.active&&G.shiftRunning)buildCranes();
});
</script>
</body>
</html>
