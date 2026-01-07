
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, pingInterval: 2000, pingTimeout: 5000 });

app.use(express.static(path.join(__dirname, 'public')));

// --- KONFIGURACJA ROZGRYWKI ---
const CFG = {
    TICK_RATE: 30,
    MAP_W: 2000, MAP_H: 2000,
    R_PL: 30, R_MN: 22, R_ORB: 12,
    SPD_BASE: 7, SPD_DASH: 20,
    DASH_CD: 60,
    SCORE_KILL: 100, SCORE_ORB: 10,
    SCORE_CONVERT: 50
};

const TYPES = ['rock', 'paper', 'scissors'];
const BEATS = { 'rock': 'scissors', 'paper': 'rock', 'scissors': 'paper' };
const BEATEN_BY = { 'rock': 'paper', 'paper': 'scissors', 'scissors': 'rock' };

class Entity {
    constructor(id, x, y, type, radius) {
        this.id = id;
        this.x = x; this.y = y;
        this.type = type;
        this.radius = radius;
        this.dx = 0; this.dy = 0;
        this.cd = 0; 
        this.dead = false;
    }
}

class Minion extends Entity {
    constructor(id, ownerId, x, y, type, dx, dy) {
        super(id, x, y, type, CFG.R_MN);
        this.ownerId = ownerId;
        this.dx = dx || 0;
        this.dy = dy || 0;
        this.age = 0; 
    }
    
    ai(room) {
        this.age++;
        let bestTarget = null; let bestThreat = null;
        let minDistTarget = 9999; let minDistThreat = 350; 
        const entities = [...room.minions];
        if(room.mode === 'play') entities.push(...Object.values(room.players).filter(p => p.active));

        let sepX = 0, sepY = 0; let neighbors = 0;

        entities.forEach(t => {
            if(t.id === this.id || t.dead) return;
            const dist = Math.hypot(t.x - this.x, t.y - this.y);
            if (dist < 60) { sepX += (this.x - t.x) / dist; sepY += (this.y - t.y) / dist; neighbors++; }
            if (BEATS[this.type] === t.type && dist < minDistTarget) { minDistTarget = dist; bestTarget = t; }
            if (BEATEN_BY[this.type] === t.type && dist < minDistThreat) { minDistThreat = dist; bestThreat = t; }
        });

        let steerX = 0, steerY = 0;
        if (bestThreat) {
            const angle = Math.atan2(bestThreat.y - this.y, bestThreat.x - this.x);
            steerX -= Math.cos(angle) * 1.3; steerY -= Math.sin(angle) * 1.3;
        } else if (bestTarget) {
            const angle = Math.atan2(bestTarget.y - this.y, bestTarget.x - this.x);
            steerX += Math.cos(angle) * 0.8; steerY += Math.sin(angle) * 0.8;
        } else {
            steerX += (CFG.MAP_W/2 - this.x) * 0.0002; steerY += (CFG.MAP_H/2 - this.y) * 0.0002;
        }

        if (neighbors > 0) { steerX += (sepX / neighbors) * 1.5; steerY += (sepY / neighbors) * 1.5; }

        const aiControlMult = Math.pow(Math.min(1, this.age / 900), 2); 
        const steerStrength = 0.06 * aiControlMult;
        const currentFriction = this.age < 900 ? 0.985 : 0.96;

        this.dx = (this.dx * currentFriction) + (steerX * steerStrength);
        this.dy = (this.dy * currentFriction) + (steerY * steerStrength);
        
        const speed = Math.hypot(this.dx, this.dy);
        const maxSpd = 14; 
        if(speed > maxSpd) { this.dx = (this.dx/speed)*maxSpd; this.dy = (this.dy/speed)*maxSpd; }
        this.x += this.dx; this.y += this.dy;
        
        if(this.x < 0 || this.x > CFG.MAP_W) this.dx *= -1;
        if(this.y < 0 || this.y > CFG.MAP_H) this.dy *= -1;
        this.x = Math.max(0, Math.min(CFG.MAP_W, this.x));
        this.y = Math.max(0, Math.min(CFG.MAP_H, this.y));
    }
}

class Player extends Entity {
    constructor(id, nick) {
        super(id, Math.random()*CFG.MAP_W, Math.random()*CFG.MAP_H, 'rock', CFG.R_PL);
        this.nick = (nick && nick !== "undefined" ? nick : "Gracz").substring(0, 12);
        this.active = false; this.score = 0;
        this.input = { x:0, y:0, d:false };
        this.dashTime = 0; this.plans = [];
        this.ready = false; this.maxCd = CFG.DASH_CD;
    }

    update() {
        if(!this.active) return;
        let spd = CFG.SPD_BASE;
        if(this.input.d && this.cd <= 0) { this.dashTime = 10; this.cd = CFG.DASH_CD; }
        if(this.dashTime > 0) { spd = CFG.SPD_DASH; this.dashTime--; } 
        else if(this.cd > 0) this.cd--;
        this.x += this.input.x * spd;
        this.y += this.input.y * spd;
        this.x = Math.max(this.radius, Math.min(CFG.MAP_W-this.radius, this.x));
        this.y = Math.max(this.radius, Math.min(CFG.MAP_H-this.radius, this.y));
    }
}

class Room {
    constructor(id) {
        this.id = id; this.players = {}; this.minions = []; this.orbs = [];
        this.active = false; this.mode = 'play'; this.hostId = null;
        this.resetTimer = null; this.winner = null;
        for(let i=0; i<30; i++) this.spawnOrb();
    }
    spawnOrb() { this.orbs.push({x: Math.random()*CFG.MAP_W, y: Math.random()*CFG.MAP_H}); }
    reset() {
        this.active = false; this.minions = []; this.winner = null; this.orbs = [];
        for(let i=0; i<30; i++) this.spawnOrb();
        Object.values(this.players).forEach(p => { p.active = false; p.ready = false; p.score = 0; p.plans = []; });
        io.to(this.id).emit('gameReset');
    }
    start() {
        this.active = true; this.minions = [];
        Object.values(this.players).forEach(p => {
            p.plans.forEach(plan => {
                this.minions.push(new Minion(Math.random().toString(36).substr(2,9), p.id, plan.x, plan.y, plan.type, plan.dx, plan.dy));
            });
            p.plans = [];
            if(this.mode === 'play') {
                p.active = true; p.x = Math.random() * (CFG.MAP_W - 200) + 100;
                p.y = Math.random() * (CFG.MAP_H - 200) + 100; p.cd = 0; 
            }
        });
        io.to(this.id).emit('gameStart', { mode: this.mode });
    }
    update() {
        if(!this.active) return;
        Object.values(this.players).forEach(p => p.update());
        this.minions.forEach(m => m.ai(this));
        this.resolveCollisions();
        this.checkWin();
    }
    resolveCollisions() {
        let entities = [...this.minions];
        if(this.mode === 'play') entities.push(...Object.values(this.players).filter(p => p.active));
        
        Object.values(this.players).forEach(p => {
            if(!p.active) return;
            for(let i=this.orbs.length-1; i>=0; i--) {
                const o = this.orbs[i];
                if(Math.hypot(p.x-o.x, p.y-o.y) < p.radius + CFG.R_ORB) {
                    p.score += CFG.SCORE_ORB; this.orbs.splice(i, 1);
                    io.to(this.id).emit('fx', {t:'orb', x:o.x, y:o.y});
                    if(Math.random()>0.5) this.spawnOrb();
                }
            }
        });

        for(let i=0; i<entities.length; i++) {
            for(let j=i+1; j<entities.length; j++) {
                const a = entities[i], b = entities[j];
                const dist = Math.hypot(a.x - b.x, a.y - b.y), minD = a.radius + b.radius;
                if(dist < minD) {
                    const push = (minD - dist) / 2, ax = (a.x - b.x) / dist, ay = (a.y - b.y) / dist;
                    a.x += ax * push; a.y += ay * push; b.x -= ax * push; b.y -= ay * push;
                    if(BEATS[a.type] === b.type) this.interact(a, b);
                    else if(BEATS[b.type] === a.type) this.interact(b, a);
                }
            }
        }
        this.minions = this.minions.filter(m => !m.dead);
    }
    interact(winner, loser) {
        let winnerName = "Minion";
        if(winner instanceof Player) { winner.score += (loser instanceof Player) ? CFG.SCORE_KILL : CFG.SCORE_CONVERT; winnerName = winner.nick; }
        if(loser instanceof Player) {
            loser.active = false;
            io.to(this.id).emit('fx', {t:'kill', x:loser.x, y:loser.y, c:winner.type, msg: `${winnerName} > ${loser.nick}`});
        } else {
            const oldType = loser.type; loser.type = winner.type;
            loser.dx += (loser.x - winner.x) * 0.1; loser.dy += (loser.y - winner.y) * 0.1;
            if(oldType !== winner.type) io.to(this.id).emit('fx', {t:'convert', x:loser.x, y:loser.y, c:winner.type});
        }
    }
    checkWin() {
        if(this.resetTimer) return;
        let aliveTeams = new Set();
        this.minions.forEach(m => aliveTeams.add(m.type));
        if(this.mode === 'play') Object.values(this.players).forEach(p => { if(p.active) aliveTeams.add(p.type); });
        if(aliveTeams.size <= 1 && (this.minions.length > 0 || Object.values(this.players).some(p=>p.active))) {
            const winner = [...aliveTeams][0] || 'draw'; this.winner = winner;
            io.to(this.id).emit('gameOver', { winner });
            this.resetTimer = setTimeout(() => { this.reset(); this.resetTimer = null; }, 5000);
        }
    }
}

const rooms = {};
['Arena 1', 'Arena 2', 'Arena 3'].forEach(id => rooms[id] = new Room(id));

io.on('connection', (socket) => {
    socket.on('getRooms', () => {
        socket.emit('roomList', Object.values(rooms).map(r => ({ id: r.id, count: Object.keys(r.players).length, status: r.active ? 'GRA' : 'LOBBY' })));
    });
    socket.on('join', (d) => {
        if(!rooms[d.roomId]) return;
        const r = rooms[d.roomId];
        socket.rooms.forEach(rm => { if(rm !== socket.id) socket.leave(rm); });
        socket.join(d.roomId);
        r.players[socket.id] = new Player(socket.id, d.nick);
        if(!r.hostId) r.hostId = socket.id;
        socket.emit('joined', { id: socket.id, host: r.hostId === socket.id, w: CFG.MAP_W, h: CFG.MAP_H });
    });
    socket.on('setType', (t) => { const r = getRoom(socket); if(r && r.players[socket.id] && !r.active) r.players[socket.id].type = t; });
    socket.on('planMinion', (d) => {
        const r = getRoom(socket);
        if(r && r.players[socket.id] && !r.active) {
            const p = r.players[socket.id], limit = r.mode === 'sim' ? 5 : 3;
            if(p.plans.length < limit) {
                const jitter = (Math.random() - 0.5) * 5;
                p.plans.push({x: d.x + jitter, y: d.y + jitter, type: p.type, dx: d.dx, dy: d.dy});
            }
        }
    });
    
    // --- CHAT SYSTEM (v3.0) ---
    socket.on('chat', (msg) => {
        const r = getRoom(socket);
        if(r && r.players[socket.id] && msg && msg.length <= 40) {
            // Emisja do wszystkich w pokoju
            io.to(r.id).emit('chat', { id: socket.id, msg: msg.substring(0, 40) });
        }
    });
    
    socket.on('clearPlans', () => { const r = getRoom(socket); if(r) r.players[socket.id].plans = []; });
    socket.on('toggleReady', () => { const r = getRoom(socket); if(r) r.players[socket.id].ready = !r.players[socket.id].ready; });
    socket.on('setMode', (m) => { const r = getRoom(socket); if(r && r.hostId === socket.id && !r.active) r.mode = m; });
    socket.on('hostStart', () => { const r = getRoom(socket); if(r && r.hostId === socket.id && !r.active) r.start(); });
    socket.on('input', (d) => {
        const r = getRoom(socket);
        if(r && r.active && r.players[socket.id]) {
            const p = r.players[socket.id], len = Math.hypot(d.x, d.y);
            if(len > 1) { d.x /= len; d.y /= len; }
            p.input = d;
        }
    });
    socket.on('ping', (cb) => { if(typeof cb === 'function') cb(); });
    socket.on('disconnect', () => {
        Object.values(rooms).forEach(r => {
            if(r.players[socket.id]) { delete r.players[socket.id]; if(r.hostId === socket.id) r.hostId = Object.keys(r.players)[0] || null; }
        });
    });
});

function getRoom(socket) { const rid = Array.from(socket.rooms).find(id => rooms[id]); return rooms[rid]; }

setInterval(() => {
    Object.values(rooms).forEach(r => {
        r.update();
        const pack = {
            p: Object.values(r.players).map(p => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), t: p.type, s: p.score, a: p.active, r: p.ready, n: p.nick, pl: p.plans, cd: p.cd, mcd: p.maxCd })),
            m: r.minions.map(m => ({ x: Math.round(m.x), y: Math.round(m.y), t: m.type })),
            o: r.orbs.map(o => ([Math.round(o.x), Math.round(o.y)])),
            st: { a: r.active, m: r.mode, h: r.hostId, w: r.winner }
        };
        io.to(r.id).emit('u', pack);
    });
}, 1000/CFG.TICK_RATE);

server.listen(3000, () => console.log("🚀 Neon Server v3.0 (Chat & Haptics) Ready"));
