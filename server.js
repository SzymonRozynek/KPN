
/**
 * NEON KPN LEGENDS - SERVER CORE
 * v11.0.0 (New Powers, Stealth, Magnet)
 */

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// --- KONFIGURACJA ---
const CFG = {
    PORT: process.env.PORT || 3000,
    TICK_RATE: 30,
    MAP_SIZE: 3000,
    GRID_SIZE: 250, 
    MAX_PLAYERS: 25,
    MAX_BOTS: 45, 
    WIN_SCORE: 1000,
    ZONES: [
        { t: 'rock', x: 0.5, y: 0.2 },
        { t: 'paper', x: 0.8, y: 0.8 },
        { t: 'scissors', x: 0.2, y: 0.8 }
    ],
    STATS: {
        rock: { spd: 7.0, hp: 220, dash: 20, skillCd: 300, skillDur: 15, passive: 'thorns' },
        paper: { spd: 9.5, hp: 130, dash: 26, skillCd: 450, skillDur: 90, passive: 'stealth' },
        scissors: { spd: 8.5, hp: 160, dash: 24, skillCd: 250, skillDur: 10, passive: 'lifesteal' }
    },
    PERKS: {
        vamp: { n: 'Wampiryzm', d: 'Leczenie za 20% obrażeń' },
        glass: { n: 'Szklane Działo', d: '+50% DMG, -30% HP' },
        tank: { n: 'Tytanowa Powłoka', d: '+50% HP, -10% Speed' },
        speed: { n: 'Nitro', d: '+20% Speed' }
    },
    R_ZONE: 150,
    MAGNET_RANGE: 100 // Zasięg przyciągania kulek
};

const BEATS = { 'rock': 'scissors', 'paper': 'rock', 'scissors': 'paper' };
const TYPES = ['rock', 'paper', 'scissors'];

// --- FIZYKA ---
class SpatialGrid {
    constructor(size) { this.size = size; this.cells = new Map(); }
    key(x, y) { return `${Math.floor(x/this.size)}:${Math.floor(y/this.size)}`; }
    clear() { this.cells.clear(); }
    insert(ent) {
        const k = this.key(ent.x, ent.y);
        if(!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k).push(ent);
    }
    query(ent) {
        const cx = Math.floor(ent.x/this.size), cy = Math.floor(ent.y/this.size);
        let res = [];
        for(let x = cx-1; x <= cx+1; x++) for(let y = cy-1; y <= cy+1; y++) {
            const k = `${x}:${y}`; if(this.cells.has(k)) res.push(...this.cells.get(k));
        }
        return res;
    }
}

class Entity {
    constructor(id, type, x, y, r) {
        this.id = id; this.type = type; this.x = x; this.y = y; this.r = r;
        this.dx = 0; this.dy = 0;
        this.hp = 100; this.maxHp = 100;
        this.dead = false; this.stun = 0;
        this.invisible = false; // Nowa flaga
        this.buffs = { shield: false, speed: 0 };
    }
    move(w, h) {
        this.x += this.dx; this.y += this.dy;
        this.x = Math.max(this.r, Math.min(w - this.r, this.x));
        this.y = Math.max(this.r, Math.min(h - this.r, this.y));
    }
    takeDamage(amt, source) {
        if(this.buffs.shield) { this.buffs.shield = false; return false; }
        if(this.type === 'rock' && source && source instanceof Entity) {
            source.hp -= amt * 0.3; // Thorns buffed
        }
        this.hp -= amt;
        if(this.hp <= 0) this.dead = true;
        return true;
    }
}

class Player extends Entity {
    constructor(id, nick, type) {
        super(id, type, 0, 0, CFG.R_PL_BASE || 30);
        this.nick = nick.substring(0, 15).replace(/[^a-zA-Z0-9 ]/g, "");
        this.active = false;
        this.lvl = 1; this.xp = 0; this.nextXp = 100;
        this.score = 0; this.kills = 0; this.deaths = 0;
        this.perks = []; this.pendingPerk = false;
        this.streak = 0; this.lastKillTime = 0;
        this.input = { x:0, y:0, d:false, s:false };
        this.cdDash = 0; this.cdSkill = 0; this.maxCdSkill = CFG.STATS[type].skillCd;
        this.applyStats();
    }
    applyStats() {
        const base = CFG.STATS[this.type];
        this.maxHp = base.hp; this.maxCdSkill = base.skillCd;
        if(this.perks.includes('tank')) this.maxHp *= 1.5;
        if(this.perks.includes('glass')) this.maxHp *= 0.7;
        this.hp = Math.min(this.hp, this.maxHp);
        if(this.hp <= 0) this.hp = this.maxHp;
    }
    applyPerk(pid) {
        if(!this.pendingPerk) return;
        this.perks.push(pid); this.pendingPerk = false; this.applyStats();
    }
    update(room) {
        if(!this.active || this.dead) return;
        
        // Handle Stun
        if(this.stun > 0) { 
            this.stun--; this.x+=this.dx; this.y+=this.dy; 
            this.dx*=0.85; this.dy*=0.85; 
            this.move(room.mapW, room.mapH); 
            return; 
        }
        
        // Handle Invisibility Timer
        if(this.invisible && this.skillActive <= 0) this.invisible = false;
        if(this.skillActive > 0) this.skillActive--;

        // Passive Regen (Paper)
        if(this.type === 'paper' && this.hp < this.maxHp && room.ticks % 30 === 0) this.hp += 3;

        const s = CFG.STATS[this.type];
        let spd = s.spd;
        if(this.perks.includes('speed')) spd *= 1.2;
        if(this.perks.includes('tank')) spd *= 0.9;
        if(this.invisible) spd *= 1.3; // Speed boost while invi

        if(this.input.d && this.cdDash <= 0) { this.cdDash = 60; spd = s.dash; }
        if(this.cdDash > 0) this.cdDash--;

        // --- SUPERMOCE ---
        if(this.input.s && this.cdSkill <= 0) {
            this.cdSkill = this.maxCdSkill; 
            io.to(room.id).emit('fx', {t:'skill', x:this.x, y:this.y, c:this.type});
            
            if(this.type === 'rock') {
                // Gravity Slam: Pull enemies IN then Stun
                room.aoe(this, 350, 'pull_stun'); 
            }
            if(this.type === 'paper') {
                // Ghost Walk: Invi + Clone
                this.skillActive = s.skillDur;
                this.invisible = true;
                room.spawnDecoy(this);
            }
            if(this.type === 'scissors') {
                // Blood Nova: Damage + Heal
                room.aoe(this, 200, 'lifesteal');
            }
        }
        if(this.cdSkill > 0) this.cdSkill--;

        this.dx = this.input.x * spd; this.dy = this.input.y * spd;
        
        if(room.singularity > 0) {
            const cx = room.mapW/2, cy = room.mapH/2;
            if(Math.hypot(cx-this.x, cy-this.y) < room.singularity) {
                this.dx += (cx-this.x)*0.02; this.dy += (cy-this.y)*0.02;
                if(room.ticks%15===0) this.takeDamage(5, null);
            }
        }
        this.move(room.mapW, room.mapH);
    }
    addXp(amount) {
        this.xp += amount;
        if(this.xp >= this.nextXp) {
            this.lvl++; this.xp -= this.nextXp; this.nextXp = Math.floor(this.nextXp * 1.4);
            this.hp = this.maxHp;
            if([5, 10].includes(this.lvl)) this.pendingPerk = true;
        }
    }
}

class Minion extends Entity {
    constructor(id, type, x, y) { super(id, type, x, y, 20); this.hp = 40; this.maxHp = 40; }
    ai(room, grid) {
        if(this.stun > 0) { this.stun--; this.x+=this.dx; this.y+=this.dy; this.dx*=0.85; this.dy*=0.85; this.move(room.mapW, room.mapH); return; }
        const nearby = grid.query(this);
        let target = null, minDist = 9999;
        let sepX=0, sepY=0, neighbors=0;
        for(const t of nearby) {
            if(t.id === this.id || t.dead || t.invisible) continue; // Ignoruj niewidzialnych
            const d = Math.hypot(t.x - this.x, t.y - this.y);
            if(d < 50) { sepX += (this.x-t.x)/d; sepY += (this.y-t.y)/d; neighbors++; }
            if(BEATS[this.type] === t.type && d < minDist) { minDist = d; target = t; }
        }
        let tx = 0, ty = 0;
        if(target) { const a = Math.atan2(target.y-this.y, target.x-this.x); tx = Math.cos(a); ty = Math.sin(a); }
        else {
            if(Math.random()<0.02) { this.rx = (Math.random()-0.5)*2; this.ry = (Math.random()-0.5)*2; }
            tx = this.rx||0; ty = this.ry||0;
        }
        room.zones.forEach(z => {
            const dx = this.x - z.x; const dy = this.y - z.y; const dist = Math.hypot(dx, dy);
            if(dist < CFG.R_ZONE + 200) { tx += (dx/dist)*4; ty += (dy/dist)*4; }
        });
        if(neighbors>0) { tx += (sepX/neighbors)*2; ty += (sepY/neighbors)*2; }
        if(room.singularity > 0) {
             const cx = room.mapW/2, cy = room.mapH/2;
             if(Math.hypot(cx-this.x, cy-this.y) < room.singularity) { tx += (cx-this.x)*0.01; ty += (cy-this.y)*0.01; }
        }
        this.dx = (this.dx*0.9 + tx*1.0); this.dy = (this.dy*0.9 + ty*1.0);
        const spd = Math.hypot(this.dx, this.dy);
        if(spd > 10) { this.dx = (this.dx/spd)*10; this.dy = (this.dy/spd)*10; }
        this.move(room.mapW, room.mapH);
    }
}

class Room {
    constructor(id, name, config) {
        this.id = id; this.name = name; this.config = config;
        this.players = {}; this.minions = []; this.orbs = [];
        this.active = false; this.hostId = null;
        this.mapW = CFG.MAP_SIZE; this.mapH = CFG.MAP_SIZE;
        this.grid = new SpatialGrid(CFG.GRID_SIZE);
        this.singularity = 0; this.ticks = 0;
        this.initZones(); this.reset();
    }
    initZones() { this.zones = CFG.ZONES.map(z => ({ t: z.t, x: z.x * this.mapW, y: z.y * this.mapH })); }
    reset() {
        this.active = false; this.minions = []; this.orbs = []; this.singularity = 0; this.grid.clear();
        for(let i=0; i<100; i++) this.spawnOrb();
        Object.values(this.players).forEach(p => { p.active=false; p.score=0; p.kills=0; p.deaths=0; p.lvl=1; p.xp=0; p.perks=[]; p.hp=p.maxHp; p.invisible=false; });
        io.to(this.id).emit('gameReset');
    }
    spawnOrb() { this.orbs.push({ x: Math.random()*this.mapW, y: Math.random()*this.mapH }); }
    spawnBot() {
        if(this.minions.length >= CFG.MAX_BOTS) return;
        const type = TYPES[Math.floor(Math.random() * TYPES.length)];
        let bx, by, safe = false;
        for(let i=0; i<5; i++) {
            bx = Math.random()*this.mapW; by = Math.random()*this.mapH;
            let inZone = false;
            for(let z of this.zones) { if(Math.hypot(bx-z.x, by-z.y) < CFG.R_ZONE + 100) { inZone = true; break; } }
            if(!inZone) { safe = true; break; }
        }
        if(safe) this.minions.push(new Minion(Math.random(), type, bx, by));
    }
    start() {
        this.active = true; this.startTime = Date.now(); this.singularity = 0;
        Object.values(this.players).forEach(p => {
            p.active = true; p.invisible = false;
            const zone = this.zones.find(z => z.t === p.type);
            if(zone) {
                const a = Math.random() * Math.PI * 2; const d = Math.random() * (CFG.R_ZONE * 0.7);
                p.x = zone.x + Math.cos(a)*d; p.y = zone.y + Math.sin(a)*d;
            } else { p.x = Math.random()*this.mapW; p.y = Math.random()*this.mapH; }
            p.applyStats();
        });
        io.to(this.id).emit('gameStart');
    }
    update() {
        if(!this.active) return;
        this.ticks++;
        if(this.ticks % 40 === 0) this.spawnBot();
        
        const timePassed = Date.now() - this.startTime;
        if(timePassed > 180000 && this.singularity === 0) { this.singularity = 100; io.to(this.id).emit('fx', {t:'sing_warn'}); }
        if(this.singularity > 0) this.singularity += 1.2;

        this.grid.clear();
        this.minions.forEach(m => this.grid.insert(m));
        Object.values(this.players).forEach(p => { if(p.active && !p.dead) this.grid.insert(p); });

        Object.values(this.players).forEach(p => p.update(this));
        this.minions.forEach(m => m.ai(this, this.grid));
        this.handleCollisions();
        this.handleZones();
        this.minions = this.minions.filter(m => !m.dead);
        if(this.ticks % 30 === 0) this.checkWin();
    }
    handleCollisions() {
        const entities = [...this.minions, ...Object.values(this.players).filter(p=>p.active && !p.dead)];
        
        // ORB MAGNETISM
        Object.values(this.players).filter(p=>p.active && !p.dead).forEach(p => {
            for(let i = this.orbs.length - 1; i >= 0; i--) {
                const o = this.orbs[i];
                const d = Math.hypot(p.x - o.x, p.y - o.y);
                if(d < CFG.MAGNET_RANGE) {
                    // Pull
                    o.x += (p.x - o.x) * 0.2; o.y += (p.y - o.y) * 0.2;
                    if(d < p.r + 10) {
                        p.score += 10; p.addXp(15); this.orbs.splice(i, 1);
                        if(Math.random() > 0.5) this.spawnOrb();
                        io.to(this.id).emit('fx', {t:'dmg', x:p.x, y:p.y, v:10, c:'#ffd700'});
                    }
                }
            }
        });

        for(const a of entities) {
            const nearby = this.grid.query(a);
            for(const b of nearby) {
                if(a === b || a.dead || b.dead) continue;
                const dist = Math.hypot(a.x - b.x, a.y - b.y);
                const minD = a.r + b.r;
                if(dist < minD) {
                    const pen = minD - dist;
                    const ax = (a.x - b.x) / dist; const ay = (a.y - b.y) / dist;
                    a.x += ax * pen * 0.5; a.y += ay * pen * 0.5;
                    b.x -= ax * pen * 0.5; b.y -= ay * pen * 0.5;
                    if(Date.now() - this.startTime > 3000) {
                        if(BEATS[a.type] === b.type) this.resolveCombat(a, b);
                    }
                }
            }
        }
    }
    resolveCombat(winner, loser) {
        let dmg = 40;
        if(winner instanceof Minion && loser instanceof Player) dmg = 10;
        if(winner instanceof Player) {
            if(winner.perks.includes('glass')) dmg *= 1.5;
            if(winner.type === 'scissors' && Math.random() < 0.25) dmg *= 2; 
            if(winner.perks.includes('vamp')) winner.hp = Math.min(winner.maxHp, winner.hp + dmg*0.2);
        }
        const tookDamage = loser.takeDamage(dmg, winner);
        if(tookDamage) {
            io.to(this.id).emit('fx', {t:'dmg', x:loser.x, y:loser.y, v:Math.round(dmg), c:'#fff'});
            const angle = Math.atan2(loser.y - winner.y, loser.x - winner.x);
            const force = 20; 
            loser.dx = Math.cos(angle) * force; loser.dy = Math.sin(angle) * force; loser.stun = 6; 
            winner.dx -= Math.cos(angle) * (force * 0.5); winner.dy -= Math.sin(angle) * (force * 0.5);
            // Break invisibility on damage taken/dealt
            if(winner instanceof Player) winner.invisible = false;
            if(loser instanceof Player) loser.invisible = false;
        }
        if(loser.dead) {
            if(loser instanceof Player) {
                io.to(this.id).emit('fx', {t:'kill', x:loser.x, y:loser.y, c:winner.type, msg:`${winner.type} eliminuje ${loser.nick}`});
                loser.score = Math.max(0, loser.score - 100);
                loser.deaths++; loser.dead = false; loser.hp = loser.maxHp; loser.stun = 0; loser.streak = 0; loser.invisible = false;
                
                const zone = this.zones.find(z => z.t === loser.type);
                if(zone) {
                    const a = Math.random() * Math.PI * 2; const d = Math.random() * (CFG.R_ZONE * 0.5);
                    loser.x = zone.x + Math.cos(a) * d; loser.y = zone.y + Math.sin(a) * d;
                } else { loser.x = Math.random() * this.mapW; loser.y = Math.random() * this.mapH; }
                
                if (winner instanceof Player) {
                    winner.score += 50; winner.kills++; winner.streak++; winner.lastKillTime = Date.now(); winner.addXp(100);
                    if(winner.streak >= 2) io.to(this.id).emit('fx', {t:'streak', k:winner.streak, n:winner.nick});
                }
            } else {
                if(winner instanceof Player) { winner.addXp(40); winner.score += 50; }
                io.to(this.id).emit('fx', {t:'conv', x:loser.x, y:loser.y, c:winner.type});
            }
        }
    }
    aoe(owner, r, effect) {
        const targets = this.grid.query(owner);
        let totalHeal = 0;
        for(const t of targets) {
            if(t.id === owner.id || t.dead) continue;
            if(Math.hypot(t.x - owner.x, t.y - owner.y) < r) {
                if(effect === 'pull_stun' && t.type !== owner.type) {
                    t.stun = 60; // 2s stun
                    // Pull effect
                    const a = Math.atan2(owner.y - t.y, owner.x - t.x);
                    t.dx += Math.cos(a) * 30; t.dy += Math.sin(a) * 30;
                }
                if(effect === 'lifesteal' && BEATS[owner.type] === t.type) {
                    const dmg = 30;
                    t.takeDamage(dmg, owner);
                    totalHeal += dmg;
                    io.to(this.id).emit('fx', {t:'dmg', x:t.x, y:t.y, v:dmg, c:'#ff0000'});
                }
            }
        }
        if(effect === 'lifesteal' && totalHeal > 0) {
            owner.hp = Math.min(owner.maxHp, owner.hp + totalHeal);
            io.to(this.id).emit('fx', {t:'dmg', x:owner.x, y:owner.y, v:totalHeal, c:'#00ff00'});
        }
    }
    spawnDecoy(owner) {
        const m = new Minion(Math.random(), owner.type, owner.x, owner.y);
        m.dx = (Math.random()-0.5)*30; m.dy = (Math.random()-0.5)*30;
        this.minions.push(m);
    }
    handleZones() {
        Object.values(this.players).forEach(p => {
            if(!p.active || p.dead) return;
            let inZone = false;
            for(const z of this.zones) {
                if(Math.hypot(p.x - z.x, p.y - z.y) < 150) {
                    inZone = true;
                    if(p.type !== z.t) {
                        p.zoneTime = (p.zoneTime || 0) + 1;
                        if(p.zoneTime > 45) { 
                            p.type = z.t; p.applyStats(); p.zoneTime = 0; p.invisible = false;
                            io.to(this.id).emit('fx', {t:'conv', x:p.x, y:p.y, c:p.type});
                        }
                    } else p.zoneTime = 0;
                }
            }
            if(!inZone) p.zoneTime = 0;
        });
    }
    checkWin() {
        if(Date.now() - this.startTime < 5000) return; 
        for(const id in this.players) {
            const p = this.players[id];
            if(p.active && p.score >= CFG.WIN_SCORE) {
                io.to(this.id).emit('gameOver', { w: p.nick, reason: 'score' });
                setTimeout(() => this.reset(), 5000);
                return;
            }
        }
    }
}

// --- SERVER INIT ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
rooms['public'] = new Room('public', 'Publiczna Arena', { max: 20, mode: 'play', pass: '' });

io.on('connection', (socket) => {
    let curRoom = null;
    socket.on('getRooms', () => socket.emit('roomList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, c: Object.keys(r.players).length, max: r.config.max, locked: !!r.config.pass }))));
    socket.on('createRoom', (d) => {
        if(!d.name) return;
        const id = Math.random().toString(36).substr(2, 6).toUpperCase();
        rooms[id] = new Room(id, d.name.substring(0, 20), { max: 15, mode: 'play', pass: d.pass });
        socket.emit('roomCreated', id);
    });
    socket.on('join', (d) => {
        const r = rooms[d.roomId];
        if(!r) return socket.emit('err', 'Pokój nie istnieje');
        if(r.config.pass && r.config.pass !== d.pass) return socket.emit('err', 'Złe hasło');
        if(Object.keys(r.players).length >= r.config.max) return socket.emit('err', 'Pokój pełny');
        socket.join(r.id); curRoom = r;
        r.players[socket.id] = new Player(socket.id, d.nick || "Gracz", 'rock');
        if(!r.hostId) r.hostId = socket.id;
        socket.emit('joined', { id: socket.id, host: r.hostId === socket.id, w: r.mapW, h: r.mapH, perks: CFG.PERKS, winScore: CFG.WIN_SCORE });
    });
    socket.on('setType', (t) => { if(curRoom && !curRoom.active && CFG.STATS[t]) curRoom.players[socket.id].type = t; });
    socket.on('hostStart', () => { if(curRoom && curRoom.hostId === socket.id && !curRoom.active) curRoom.start(); });
    socket.on('input', (d) => { const p = curRoom?.players[socket.id]; if(p) { const len = Math.hypot(d.x, d.y); if(len > 1.01) { d.x /= len; d.y /= len; } p.input = d; } });
    socket.on('perk', (pid) => { const p = curRoom?.players[socket.id]; if(p) p.applyPerk(pid); });
    socket.on('disconnect', () => {
        if(curRoom) {
            delete curRoom.players[socket.id];
            if(curRoom.hostId === socket.id) curRoom.hostId = Object.keys(curRoom.players)[0];
            if(Object.keys(curRoom.players).length === 0 && curRoom.id !== 'public') delete rooms[curRoom.id];
        }
    });
});

setInterval(() => {
    Object.values(rooms).forEach(r => {
        r.update();
        const pack = {
            p: Object.values(r.players).map(p => ({
                id: p.id, x: ~~p.x, y: ~~p.y, t: p.type, a: p.active, d: p.dead, n: p.nick,
                hp: ~~p.hp, mhp: ~~p.maxHp, lvl: p.lvl, xp: ~~p.xp, nxp: p.nextXp,
                pen: p.pendingPerk ? 1 : 0, perks: p.perks, scd: p.cdSkill, mscd: p.maxCdSkill,
                score: p.score, kills: p.kills, deaths: p.deaths, inv: p.invisible // Send invis status
            })),
            m: r.minions.map(m => ({ x: ~~m.x, y: ~~m.y, t: m.type })),
            o: r.orbs.map(o => ([~~o.x, ~~o.y])),
            st: { a: r.active, s: ~~r.singularity },
            z: r.zones
        };
        io.to(r.id).emit('u', pack);
    });
}, 1000 / CFG.TICK_RATE);

const startServer = (port) => {
    server.once('error', (e) => { if(e.code === 'EADDRINUSE') startServer(port+1); });
    server.listen(port, () => console.log(`🚀 NEON LEGENDS running on port ${port}`));
};
startServer(CFG.PORT);
