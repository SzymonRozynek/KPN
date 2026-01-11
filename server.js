
/**
 * NEON KPN GEOMETRIC - SERVER CORE
 * v15.0.0 (Nonagon Map Layout & Circular Physics)
 */

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

// --- GENEROWANIE MAPY (DZIEWIĘCIOKĄT) ---
const MAP_R = 1500;
const CENTER = MAP_R;
const GEN_WALLS = [];
const GEN_BUSHES = [];
const GEN_ZONES = [];

// Generuj 9 punktów na okręgu (co 40 stopni)
for(let i = 0; i < 9; i++) {
    // Przesunięcie -90 stopni, żeby wierzchołek 0 był na górze (12:00)
    const angleDeg = (i * 40) - 90; 
    const angleRad = angleDeg * (Math.PI / 180);
    const dist = 1100; // Odległość od środka
    
    const x = CENTER + Math.cos(angleRad) * dist;
    const y = CENTER + Math.sin(angleRad) * dist;

    // Co trzeci wierzchołek to BAZA (0, 3, 6)
    if (i % 3 === 0) {
        // Krzak w bazie
        GEN_BUSHES.push({ x: x, y: y, r: 200 });
        
        // Strefa zmian w tym samym miejscu
        let type = 'rock'; // 0 = Rock (Top)
        if (i === 3) type = 'scissors'; // 3 = Scissors (Right Bottom)
        if (i === 6) type = 'paper';    // 6 = Paper (Left Bottom)
        
        GEN_ZONES.push({ t: type, x: x, y: y });
    } else {
        // Na pozostałych wierzchołkach ŚCIANY
        // Rotacja ściany, żeby była prostopadła do promienia? Nie, w canvasie mamy tylko proste AABB
        // Dajemy bloki w układzie poziomym lub pionowym w zależności od pozycji
        if (i === 1 || i === 8) GEN_WALLS.push({ x: x-40, y: y-100, w: 80, h: 200 }); // Pionowe (górne boki)
        else if (i === 4 || i === 5) GEN_WALLS.push({ x: x-40, y: y-100, w: 80, h: 200 }); // Pionowe (dolne boki)
        else GEN_WALLS.push({ x: x-100, y: y-40, w: 200, h: 80 }); // Poziome (boki)
    }
}
// Dodatkowy krzak na środku (Arena Centralna)
GEN_BUSHES.push({ x: CENTER, y: CENTER, r: 250 });


const CFG = {
    PORT: process.env.PORT || 3000,
    TICK_RATE: 30,
    MAP_RADIUS: 1500,
    GRID_SIZE: 250, 
    MAX_PLAYERS: 30,
    MAX_BOTS: 40, 
    WIN_SCORE: 1000,
    SHRINK_START_TIME: 60000, 
    SHRINK_SPEED: 0.6,        
    MIN_ZONE_RADIUS: 300,     
    STORM_DAMAGE: 5,
    PHYSICS_STEPS: 3, 
    
    WALLS: GEN_WALLS,
    BUSHES: GEN_BUSHES,
    ZONES: GEN_ZONES,
    
    STATS: {
        rock: { spd: 7.0, hp: 220, dash: 20, skillCd: 300, skillDur: 20, passive: 'thorns' },
        paper: { spd: 9.5, hp: 130, dash: 26, skillCd: 450, skillDur: 90, passive: 'stealth' },
        scissors: { spd: 8.5, hp: 160, dash: 24, skillCd: 250, skillDur: 10, passive: 'lifesteal' },
        zombie: { spd: 9.5, hp: 60, dash: 0, skillCd: 0, skillDur: 0, passive: 'aggro' } 
    },
    PERKS: {
        vamp: { n: 'Wampiryzm', d: 'Leczenie za 20% obrażeń' },
        glass: { n: 'Szklane Działo', d: '+50% DMG, -30% HP' },
        tank: { n: 'Tytanowa Powłoka', d: '+50% HP, -10% Speed' },
        speed: { n: 'Nitro', d: '+20% Speed' }
    },
    R_ZONE: 180, // Nieco większe strefy bazowe
    MAGNET_RANGE: 150
};

const BEATS = { 'rock': 'scissors', 'paper': 'rock', 'scissors': 'paper', 'zombie': 'all' }; 
const TYPES = ['rock', 'paper', 'scissors'];

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
        this.invisible = false; this.inBush = false;
        this.emote = null; this.emoteTimer = 0;
        this.buffs = { shield: false, speed: 0 }; 
    }
    
    move(room) {
        const steps = CFG.PHYSICS_STEPS;
        const subDx = this.dx / steps;
        const subDy = this.dy / steps;

        for(let i = 0; i < steps; i++) {
            let nextX = this.x + subDx;
            if (!room.checkWall(nextX, this.y, this.r)) this.x = nextX;
            else this.dx = 0;

            let nextY = this.y + subDy;
            if (!room.checkWall(this.x, nextY, this.r)) this.y = nextY;
            else this.dy = 0;

            room.resolveWalls(this);

            const cx = room.mapRadius, cy = room.mapRadius;
            const dist = Math.hypot(this.x - cx, this.y - cy);
            if (dist > room.mapRadius - this.r) {
                const angle = Math.atan2(this.y - cy, this.x - cx);
                this.x = cx + Math.cos(angle) * (room.mapRadius - this.r);
                this.y = cy + Math.sin(angle) * (room.mapRadius - this.r);
            }
        }
        
        this.inBush = false;
        for(const b of room.bushes) {
            if(Math.hypot(this.x - b.x, this.y - b.y) < b.r) { this.inBush = true; break; }
        }
    }

    takeDamage(amt, source) {
        if(!this.buffs) this.buffs = { shield: false, speed: 0 };
        if(this.buffs.shield) { this.buffs.shield = false; return false; }
        
        if(this.type === 'rock' && source && source instanceof Entity && source.type !== 'zombie') {
            source.hp -= amt * 0.3; 
        }
        this.hp -= amt;
        if(this.hp <= 0) this.dead = true;
        this.invisible = false; 
        return true;
    }
}

class Player extends Entity {
    constructor(id, nick, type) {
        super(id, type, 0, 0, 30);
        this.nick = nick.substring(0, 15).replace(/[^a-zA-Z0-9 ]/g, "");
        this.active = false;
        this.lvl = 1; this.xp = 0; this.nextXp = 100;
        this.score = 0; this.kills = 0; this.deaths = 0;
        this.roomWins = 0; 
        this.perks = []; this.pendingPerk = false;
        this.input = { x:0, y:0, d:false, s:false };
        this.cdDash = 0; this.cdSkill = 0; this.maxCdSkill = CFG.STATS[type].skillCd;
        this.applyStats();
    }
    
    applyStats() {
        const base = CFG.STATS[this.type];
        if(!base) return;
        this.maxHp = base.hp;
        this.maxCdSkill = base.skillCd;
        if(this.perks.includes('tank')) this.maxHp *= 1.5;
        if(this.perks.includes('glass')) this.maxHp *= 0.7;
        this.hp = Math.min(this.hp, this.maxHp);
        if(this.hp <= 0) this.hp = this.maxHp;
    }

    applyPerk(pid) {
        if(!this.pendingPerk) return;
        this.perks.push(pid); this.pendingPerk = false; 
        this.applyStats();
        this.hp = this.maxHp;
    }

    addXp(amount) {
        this.xp += amount;
        if(this.xp >= this.nextXp) {
            this.lvl++;
            this.xp -= this.nextXp;
            this.nextXp = Math.floor(this.nextXp * 1.4);
            this.hp = this.maxHp; 
            if([5, 10].includes(this.lvl)) this.pendingPerk = true;
        }
    }

    update(room) {
        if(!this.active || this.dead) return;
        if(this.emoteTimer > 0) this.emoteTimer--; else this.emote = null;

        if(this.stun > 0) { 
            this.stun--; 
        } else {
            if(this.skillActive > 0) { this.skillActive--; this.invisible = true; } 
            else { this.invisible = this.inBush; }

            if(this.type === 'paper' && this.hp < this.maxHp && room.ticks % 30 === 0) this.hp += 3;

            const s = CFG.STATS[this.type];
            let spd = s.spd;
            if(this.perks.includes('speed')) spd *= 1.2;
            if(this.perks.includes('tank')) spd *= 0.9;
            if(this.skillActive > 0 && this.type === 'paper') spd *= 1.4;

            if(this.input.d && this.cdDash <= 0) { this.cdDash = 60; spd = s.dash; }
            if(this.cdDash > 0) this.cdDash--;

            if(this.input.s && this.cdSkill <= 0) {
                this.cdSkill = this.maxCdSkill; 
                io.to(room.id).emit('fx', {t:'skill', x:this.x, y:this.y, c:this.type});
                if(this.type === 'rock') room.aoe(this, 350, 'pull_stun'); 
                if(this.type === 'paper') { this.skillActive = s.skillDur; room.spawnDecoy(this); }
                if(this.type === 'scissors') room.aoe(this, 200, 'lifesteal');
            }
            if(this.cdSkill > 0) this.cdSkill--;

            this.dx += this.input.x * spd * 0.2;
            this.dy += this.input.y * spd * 0.2;
            
            const currentSpeed = Math.hypot(this.dx, this.dy);
            if(currentSpeed > spd) {
                this.dx = (this.dx/currentSpeed) * spd;
                this.dy = (this.dy/currentSpeed) * spd;
            }
        }
        
        if(room.ticks % 15 === 0) {
            const dist = Math.hypot(room.mapRadius - this.x, room.mapRadius - this.y);
            if(dist > room.safeZoneRadius) {
                this.takeDamage(CFG.STORM_DAMAGE, null);
                io.to(room.id).emit('fx', {t:'dmg', x:this.x, y:this.y, v:CFG.STORM_DAMAGE, c:'#555'});
            }
        }
        this.move(room);
    }
}

class Minion extends Entity {
    constructor(id, type, x, y, ownerId = null) { 
        super(id, type, x, y, 20); 
        this.ownerId = ownerId;
        this.hp = type === 'zombie' ? 60 : 40; 
        this.maxHp = this.hp; 
    }
    ai(room, grid) {
        if(this.stun > 0) { this.stun--; this.move(room); return; }
        const nearby = grid.query(this);
        let target = null, minDist = 9999;
        let sepX=0, sepY=0, neighbors=0;

        for(const t of nearby) {
            if(t.id === this.id || t.dead || t.invisible) continue;
            const d = Math.hypot(t.x - this.x, t.y - this.y);
            if(d < 50) { sepX += (this.x-t.x)/d; sepY += (this.y-t.y)/d; neighbors++; }
            let isTarget = false;
            if(this.type === 'zombie') { if(t instanceof Player) isTarget = true; } 
            else { if(BEATS[this.type] === t.type) isTarget = true; }
            if(isTarget && d < minDist) { 
                 if(!room.checkWall((this.x+t.x)/2, (this.y+t.y)/2, 5)) { minDist = d; target = t; }
            }
        }
        let tx = 0, ty = 0;
        if(target) { const a = Math.atan2(target.y-this.y, target.x-this.x); tx = Math.cos(a); ty = Math.sin(a); }
        else {
            if(this.type === 'zombie') { if(Math.random()<0.05) { this.rx = (Math.random()-0.5)*3; this.ry = (Math.random()-0.5)*3; } }
            else { if(Math.random()<0.02) { this.rx = (Math.random()-0.5)*2; this.ry = (Math.random()-0.5)*2; } }
            tx = this.rx||0; ty = this.ry||0;
        }

        if(this.type !== 'zombie' && room.config.mode !== 'koth') {
             room.zones.forEach(z => {
                const dist = Math.hypot(this.x - z.x, this.y - z.y);
                if(dist < CFG.R_ZONE + 200) { tx += ((this.x-z.x)/dist)*4; ty += ((this.y-z.y)/dist)*4; }
            });
        }
        
        if(neighbors>0) { tx += (sepX/neighbors)*2; ty += (sepY/neighbors)*2; }
        
        if(this.type !== 'zombie' && room.safeZoneRadius < room.mapRadius) {
             const cx = room.mapRadius, cy = room.mapRadius;
             if(Math.hypot(cx-this.x, cy-this.y) > room.safeZoneRadius) { tx += (cx-this.x)*0.02; ty += (cy-this.y)*0.02; }
        }

        this.dx += tx * 0.5; this.dy += ty * 0.5;
        const speed = this.type === 'zombie' ? 14 : 10;
        const currentSpeed = Math.hypot(this.dx, this.dy);
        if(currentSpeed > speed) { this.dx = (this.dx/currentSpeed)*speed; this.dy = (this.dy/currentSpeed)*speed; }
        this.move(room);
    }
}

class Room {
    constructor(id, name, config) {
        this.id = id; this.name = name; 
        this.config = config || { mode: 'play', max: 25 }; 
        this.players = {}; this.minions = []; this.orbs = [];
        this.active = false; this.hostId = null;
        this.mapRadius = CFG.MAP_RADIUS;
        this.grid = new SpatialGrid(CFG.GRID_SIZE);
        this.safeZoneRadius = CFG.MAP_RADIUS;
        this.ticks = 0;
        this.walls = CFG.WALLS; this.bushes = CFG.BUSHES;
        this.kothTimer = 0; this.kothZone = { x: 1500, y: 1500, t: 'rock' };
        this.zones = JSON.parse(JSON.stringify(CFG.ZONES)); // Copy zones
        this.reset();
    }
    
    checkWall(x, y, r) {
        for(const w of this.walls) {
            const cx = Math.max(w.x, Math.min(x, w.x + w.w));
            const cy = Math.max(w.y, Math.min(y, w.y + w.h));
            if(((x-cx)**2 + (y-cy)**2) < r*r) return true;
        }
        return false;
    }

    resolveWalls(ent) {
        for(const w of this.walls) {
            const cx = Math.max(w.x, Math.min(ent.x, w.x + w.w));
            const cy = Math.max(w.y, Math.min(ent.y, w.y + w.h));
            const dx = ent.x - cx;
            const dy = ent.y - cy;
            const distSq = dx*dx + dy*dy;
            if (distSq < ent.r * ent.r) {
                const dist = Math.sqrt(distSq);
                const overlap = ent.r - dist;
                if (dist === 0) { ent.y -= overlap; } 
                else { ent.x += (dx / dist) * overlap; ent.y += (dy / dist) * overlap; }
                ent.dx *= 0.5; ent.dy *= 0.5;
            }
        }
    }

    getSafeSpawn(x, y) {
        if (!this.checkWall(x, y, 30)) return {x, y};
        for(let i=0; i<10; i++) {
            let nx = x + (Math.random()-0.5)*300; let ny = y + (Math.random()-0.5)*300;
            if(!this.checkWall(nx, ny, 30)) return {x:nx, y:ny};
        }
        for(let i=0; i<10; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * (this.mapRadius - 50);
            let nx = this.mapRadius + Math.cos(a) * r;
            let ny = this.mapRadius + Math.sin(a) * r;
            if(!this.checkWall(nx, ny, 30)) return {x:nx, y:ny};
        }
        return {x: 1500, y: 1500}; 
    }
    
    reset() {
        this.active = false; this.minions = []; this.orbs = []; 
        this.safeZoneRadius = this.mapRadius; this.grid.clear();
        for(let i=0; i<100; i++) this.spawnOrb();
        Object.values(this.players).forEach(p => { p.active=false; p.score=0; p.kills=0; p.deaths=0; p.lvl=1; p.xp=0; p.perks=[]; p.hp=p.maxHp; p.invisible=false; });
        io.to(this.id).emit('gameReset');
    }
    
    spawnOrb() { 
        let x, y, safe=false;
        for(let i=0; i<10; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * (this.mapRadius - 20);
            x = this.mapRadius + Math.cos(a) * r;
            y = this.mapRadius + Math.sin(a) * r;
            if(!this.checkWall(x, y, 12)) { safe=true; break; }
        }
        if(safe) this.orbs.push({ x, y }); 
    }
    
    spawnBot() {
        if(this.minions.length >= CFG.MAX_BOTS) return;
        const type = TYPES[Math.floor(Math.random() * TYPES.length)];
        let bx, by, safe = false;
        for(let i=0; i<10; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * (this.mapRadius - 40);
            bx = this.mapRadius + Math.cos(a) * r;
            by = this.mapRadius + Math.sin(a) * r;
            let inZone = false;
            if(this.config.mode !== 'koth') {
                for(let z of this.zones) { if(Math.hypot(bx-z.x, by-z.y) < CFG.R_ZONE + 100) { inZone = true; break; } }
            }
            if(!inZone && !this.checkWall(bx, by, 30)) { safe = true; break; }
        }
        if(safe) this.minions.push(new Minion(Math.random(), type, bx, by));
    }

    spawnZombie() {
        if(this.safeZoneRadius >= this.mapRadius) return;
        let angle = Math.random() * Math.PI * 2;
        let dist = this.safeZoneRadius + 100 + Math.random() * 400; 
        if(dist > this.mapRadius - 50) dist = this.mapRadius - 50;
        let zx = this.mapRadius + Math.cos(angle) * dist;
        let zy = this.mapRadius + Math.sin(angle) * dist;
        if(!this.checkWall(zx, zy, 25)) {
             this.minions.push(new Minion(Math.random(), 'zombie', zx, zy));
             io.to(this.id).emit('fx', {t:'spawn', x:zx, y:zy, c:'zombie'});
        }
    }
    
    start() {
        this.active = true; this.startTime = Date.now(); this.safeZoneRadius = this.mapRadius;
        
        // Reset KOTH zone
        if (this.config.mode === 'koth') { this.zones = [this.kothZone]; } 
        else { this.zones = JSON.parse(JSON.stringify(CFG.ZONES)); }

        Object.values(this.players).forEach(p => {
            p.active = true; p.invisible = false;
            let tx, ty;
            if(this.config.mode === 'koth') {
                const a = Math.random() * Math.PI * 2; tx = 1500 + Math.cos(a) * 1200; ty = 1500 + Math.sin(a) * 1200;
            } else {
                const zone = this.zones.find(z => z.t === p.type);
                if(zone) {
                    const a = Math.random() * Math.PI * 2; const d = Math.random() * (CFG.R_ZONE * 0.7);
                    tx = zone.x + Math.cos(a)*d; ty = zone.y + Math.sin(a)*d;
                } else { tx = this.mapRadius; ty = this.mapRadius; }
            }
            const spot = this.getSafeSpawn(tx, ty); p.x = spot.x; p.y = spot.y;
            p.applyStats();
        });
        io.to(this.id).emit('gameStart');
    }
    update() {
        if(!this.active) return;
        this.ticks++;
        if(this.ticks % 40 === 0) this.spawnBot();
        
        if (Date.now() - this.startTime > CFG.SHRINK_START_TIME) {
            if (this.safeZoneRadius > CFG.MIN_ZONE_RADIUS) this.safeZoneRadius -= CFG.SHRINK_SPEED;
            if(this.ticks % 100 === 0 && this.minions.length < CFG.MAX_BOTS + 10) this.spawnZombie();
        }
        
        if(this.config.mode === 'koth') {
            this.kothTimer++;
            if(this.kothTimer > 600) {
                this.kothTimer = 0;
                const nextT = TYPES[(TYPES.indexOf(this.zones[0].t) + 1) % 3];
                this.zones[0].t = nextT;
                io.to(this.id).emit('fx', {t:'sing_warn', msg: `STREFA ZMIENIA SIĘ NA: ${nextT.toUpperCase()}`});
            }
        }

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
        // Orb Magnetism Logic inside collisions for efficiency
        Object.values(this.players).filter(p=>p.active && !p.dead).forEach(p => {
            for(let i = this.orbs.length - 1; i >= 0; i--) {
                const o = this.orbs[i];
                const d = Math.hypot(p.x - o.x, p.y - o.y);
                if(d < CFG.MAGNET_RANGE) {
                    if(!this.checkWall((p.x+o.x)/2, (p.y+o.y)/2, 5)) {
                         o.x += (p.x - o.x) * 0.2; o.y += (p.y - o.y) * 0.2;
                         if(d < p.r + 10) {
                            p.score += 10; p.addXp(15); this.orbs.splice(i, 1);
                            if(Math.random() > 0.5) this.spawnOrb();
                            io.to(this.id).emit('fx', {t:'dmg', x:p.x, y:p.y, v:10, c:'#ffd700'});
                         }
                    }
                }
            }
        });

        const all = [...this.minions, ...Object.values(this.players).filter(p=>p.active && !p.dead)];
        for(const a of all) {
            const nearby = this.grid.query(a);
            for(const b of nearby) {
                if(a === b || a.dead || b.dead) continue;
                const dist = Math.hypot(a.x - b.x, a.y - b.y);
                const minD = a.r + b.r;
                if(dist < minD) {
                    const pen = minD - dist;
                    const ax = (a.x - b.x) / dist; const ay = (a.y - b.y) / dist;
                    a.dx += ax * pen * 0.2; a.dy += ay * pen * 0.2;
                    b.dx -= ax * pen * 0.2; b.dy -= ay * pen * 0.2;
                    this.resolveWalls(a); this.resolveWalls(b);
                    if(Date.now() - this.startTime > 3000) {
                        if(BEATS[a.type] === b.type || a.type === 'zombie' || b.type === 'zombie') this.resolveCombat(a, b);
                    }
                }
            }
        }
    }
    resolveCombat(winner, loser) {
        if (winner.type === 'zombie') { loser.takeDamage(10, winner); return; }
        if (loser.type === 'zombie') { loser.takeDamage(20, winner); return; }
        
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
            if(winner instanceof Player) winner.invisible = false;
            if(loser instanceof Player) loser.invisible = false;
        }
        if(loser.dead) {
            if(loser instanceof Player) {
                io.to(this.id).emit('fx', {t:'kill', x:loser.x, y:loser.y, c:winner.type, msg:`${winner.type} eliminuje ${loser.nick}`});
                loser.score = Math.max(0, loser.score - 100);
                loser.deaths++; loser.dead = false; loser.hp = loser.maxHp; loser.stun = 0; loser.streak = 0; loser.invisible = false;
                
                let tx, ty;
                if(this.config.mode === 'koth') {
                     const a = Math.random() * Math.PI * 2; tx = 1500 + Math.cos(a) * 1200; ty = 1500 + Math.sin(a) * 1200;
                } else {
                     const zone = this.zones.find(z => z.t === loser.type);
                     if(zone) { tx = zone.x; ty = zone.y; } else { tx = this.mapRadius; ty = this.mapRadius; }
                }
                const spot = this.getSafeSpawn(tx, ty);
                loser.x = spot.x; loser.y = spot.y;
                
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
                    t.stun = 60; const a = Math.atan2(owner.y - t.y, owner.x - t.x); t.dx += Math.cos(a) * 30; t.dy += Math.sin(a) * 30;
                }
                if(effect === 'lifesteal' && BEATS[owner.type] === t.type) {
                    const dmg = 30; t.takeDamage(dmg, owner); totalHeal += dmg;
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
        const m = new Minion(Math.random(), owner.type, owner.x, owner.y, owner.id); m.dx = (Math.random()-0.5)*30; m.dy = (Math.random()-0.5)*30; this.minions.push(m);
    }
    handleZones() {
        Object.values(this.players).forEach(p => {
            if(!p.active || p.dead) return;
            let inZone = false;
            for(const z of this.zones) {
                if(Math.hypot(p.x - z.x, p.y - z.y) < 150) {
                    inZone = true;
                    if (this.config.mode === 'koth' && p.type === z.t) {
                        if (this.ticks % 30 === 0) { p.score += 50; p.addXp(20); io.to(this.id).emit('fx', {t:'dmg', x:p.x, y:p.y, v:50, c:'#0f0'}); }
                    }
                    if(p.type !== z.t && this.config.mode !== 'koth') { 
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
                p.roomWins++;
                io.to(this.id).emit('gameOver', { w: p.nick, reason: 'score' });
                setTimeout(() => this.reset(), 5000);
                return;
            }
        }
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
const rooms = {};
rooms['public'] = new Room('public', 'Arena Publiczna', { max: 25, mode: 'play' });

io.on('connection', (socket) => {
    let curRoom = null;
    socket.on('getRooms', () => socket.emit('roomList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, c: Object.keys(r.players).length, max: r.config.max, locked: !!r.config.pass, mode: r.config.mode }))));
    socket.on('createRoom', (d) => {
        if(!d.name) return;
        const id = Math.random().toString(36).substr(2, 6).toUpperCase();
        rooms[id] = new Room(id, d.name.substring(0, 20), { max: 15, mode: d.mode || 'play', pass: d.pass });
        socket.emit('roomCreated', id);
    });
    socket.on('join', (d) => {
        const r = rooms[d.roomId];
        if(!r) return;
        if(r.config.pass && r.config.pass !== d.pass) { socket.emit('err', 'Złe hasło'); return; }
        if(Object.keys(r.players).length >= r.config.max) { socket.emit('err', 'Pokój pełny'); return; }
        socket.join(r.id); curRoom = r;
        r.players[socket.id] = new Player(socket.id, d.nick || "Gracz", 'rock');
        if(!r.hostId) r.hostId = socket.id;
        socket.emit('joined', { 
            id: socket.id, host: r.hostId === socket.id, w: 3000, h: 3000, 
            perks: CFG.PERKS, winScore: CFG.WIN_SCORE,
            walls: r.walls, bushes: r.bushes 
        });
    });
    socket.on('setType', (t) => { if(curRoom && !curRoom.active) curRoom.players[socket.id].type = t; });
    socket.on('hostStart', () => { if(curRoom && curRoom.hostId === socket.id && !curRoom.active) curRoom.start(); });
    socket.on('input', (d) => { const p = curRoom?.players[socket.id]; if(p) { const len = Math.hypot(d.x, d.y); if(len > 1.01) { d.x /= len; d.y /= len; } p.input = d; } });
    socket.on('perk', (pid) => { const p = curRoom?.players[socket.id]; if(p) p.applyPerk(pid); });
    socket.on('emote', (eid) => { const p = curRoom?.players[socket.id]; if(p) { p.emote = eid; p.emoteTimer = 60; io.to(curRoom.id).emit('fx', {t:'emote', id:p.id, e:eid}); } });
    socket.on('disconnect', () => { if(curRoom) { delete curRoom.players[socket.id]; if(curRoom.hostId === socket.id) curRoom.hostId = Object.keys(curRoom.players)[0]; if(Object.keys(curRoom.players).length === 0 && curRoom.id !== 'public') delete rooms[curRoom.id]; } });
});

setInterval(() => {
    Object.values(rooms).forEach(r => {
        r.update();
        const pack = {
            p: Object.values(r.players).map(p => ({
                id: p.id, x: ~~p.x, y: ~~p.y, t: p.type, a: p.active, d: p.dead, n: p.nick,
                hp: ~~p.hp, mhp: ~~p.maxHp, lvl: p.lvl, xp: ~~p.xp, nxp: p.nextXp,
                pen: p.pendingPerk ? 1 : 0, perks: p.perks, scd: p.cdSkill, mscd: p.maxCdSkill,
                score: p.score, kills: p.kills, deaths: p.deaths, inv: p.invisible, inBush: p.inBush, rw: p.roomWins 
            })),
            m: r.minions.map(m => ({ x: ~~m.x, y: ~~m.y, t: m.type })),
            o: r.orbs.map(o => ([~~o.x, ~~o.y])),
            st: { a: r.active, sz: ~~r.safeZoneRadius },
            z: r.zones
        };
        io.to(r.id).emit('u', pack);
    });
}, 1000 / CFG.TICK_RATE);

const startServer = (port) => {
    server.once('error', (e) => { if(e.code === 'EADDRINUSE') startServer(port+1); });
    server.listen(port, () => console.log(`🚀 NEON GEOMETRIC running on port ${port}`));
};
startServer(CFG.PORT);
