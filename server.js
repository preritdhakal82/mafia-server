// server.js - Mafia game server (Node + Express + Socket.IO)
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("Mafia Server Running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// Data
const rooms = {}; // code -> { code, host, players: [{id,name,alive,role}], settings, phase, timers... }
const DEFAULTS = { mafiaCount: 1, minPlayers: 4, maxPlayers: 12 };

// helpers
function genCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

function broadcastLobby(room){
  io.to(room.code).emit('lobbyState', {
    code: room.code,
    host: room.host,
    players: room.players.map(p=>({ id: p.id, name: p.name, alive: p.alive, role: p.role }))
  });
}

function resetPhaseTimers(room){
  if(room._phaseTimer) { clearTimeout(room._phaseTimer); room._phaseTimer = null; }
}

// assign roles
function assignRoles(room){
  const players = [...room.players];
  // shuffle
  for(let i=players.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  const roles = {};
  let idx = 0;
  // mafia
  for(let i=0;i<room.settings.mafiaCount && idx < players.length;i++, idx++){
    roles[players[idx].id] = 'mafia';
  }
  // medic
  if(idx < players.length) { roles[players[idx].id] = 'medic'; idx++; }
  // detective
  if(idx < players.length) { roles[players[idx].id] = 'detective'; idx++; }
  // rest villager
  for(let i=idx;i<players.length;i++) roles[players[i].id] = 'villager';

  // write roles into players
  room.players.forEach(p=>{ p.role = roles[p.id]; p.alive = true; });
  return roles;
}

// get alive players list
function alivePlayers(room){
  return room.players.filter(p=>p.alive);
}

// check end condition
function checkWin(room){
  const alive = alivePlayers(room);
  const mafiaAlive = alive.filter(p => p.role === 'mafia').length;
  const others = alive.length - mafiaAlive;
  if(mafiaAlive === 0) return { over: true, winner: 'town' };
  if(mafiaAlive >= others) return { over: true, winner: 'mafia' };
  return { over: false };
}

// MAIN socket logic
io.on('connection', socket => {
  console.log('conn', socket.id);

  // Create room
  socket.on('createRoom', ({ username, mafiaCount = 1 }) => {
    const code = genCode();
    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: username, alive: true, role: null }],
      settings: { mafiaCount: mafiaCount || DEFAULTS.mafiaCount },
      phase: 'lobby',
      mafiaTarget: null,
      medicSave: null,
      detectiveTarget: null,
      votes: {},
      _phaseTimer: null
    };
    socket.join(code);
    socket.emit('roomCreated', { roomCode: code, players: rooms[code].players, host: socket.id });
    broadcastLobby(rooms[code]);
    console.log('room created', code);
  });

  // Join
  socket.on('joinRoom', ({ username, roomCode }) => {
    const room = rooms[roomCode];
    if(!room){ socket.emit('errorMessage', 'Invalid room code.'); return; }
    if(room.players.length >= (room.settings.maxPlayers || DEFAULTS.maxPlayers)){ socket.emit('errorMessage', 'Room full'); return; }
    room.players.push({ id: socket.id, name: username, alive: true, role: null });
    socket.join(roomCode);
    io.to(roomCode).emit('updatePlayers', { code: room.code, host: room.host, players: room.players });
    broadcastLobby(room);
    socket.emit('joinedRoom', { roomCode: room.code, players: room.players });
    console.log(username, 'joined', roomCode);
  });

  // Request lobby (sync)
  socket.on('requestLobby', (code) => {
    const room = rooms[code];
    if(room) socket.emit('lobbyState', { code: room.code, host: room.host, players: room.players });
  });

  // Start game (only host)
  socket.on('startGame', (roomCode) => {
    const room = rooms[roomCode];
    if(!room) return;
    if(room.host !== socket.id) return;
    if(room.players.length < (room.settings.minPlayers || DEFAULTS.minPlayers)){
      socket.emit('errorMessage', 'Not enough players to start.');
      return;
    }

    // assign roles
    assignRoles(room);
    room.phase = 'night';
    broadcastLobby(room);

    // send private role to each player
    room.players.forEach(p => {
      io.to(p.id).emit('yourRole', { role: p.role });
    });

    // start night flow
    startNightFlow(room);
  });

  // mafia choose
  socket.on('mafiaChoose', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player || player.role !== 'mafia') return;
    room.mafiaTarget = targetId;
    io.to(roomCode).emit('phaseMessage', { phase: 'mafia_done' });
  });

  // medic choose
  socket.on('medicChoose', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player || player.role !== 'medic') return;
    room.medicSave = targetId;
    io.to(roomCode).emit('phaseMessage', { phase: 'medic_done' });
  });

  // detective choose
  socket.on('detectiveChoose', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    if(!player || player.role !== 'detective') return;
    room.detectiveTarget = targetId;
    // send immediate detective result privately
    const isMafia = room.players.find(p=>p.id===targetId)?.role === 'mafia';
    io.to(socket.id).emit('detectiveResult', { targetId, isMafia });
    io.to(roomCode).emit('phaseMessage', { phase: 'detective_done' });
  });

  // vote
  socket.on('vote', ({ roomCode, targetId }) => {
    const room = rooms[roomCode]; if(!room) return;
    room.votes[socket.id] = targetId;
    // optionally broadcast vote update
    io.to(roomCode).emit('voteUpdate', { votes: room.votes });
  });

  // chat
  socket.on('chatMessage', ({ roomCode, text }) => {
    const room = rooms[roomCode]; if(!room) return;
    const player = room.players.find(p=>p.id===socket.id);
    io.to(roomCode).emit('chatMessage', { from: player ? player.name : 'anon', text });
  });

  // disconnect
  socket.on('disconnect', () => {
    for(const code in rooms){
      const room = rooms[code];
      const idx = room.players.findIndex(p=>p.id===socket.id);
      if(idx !== -1){
        room.players.splice(idx,1);
        io.to(code).emit('updatePlayers', { code: room.code, host: room.host, players: room.players });
      }
      // if host left, close lobby
      if(room.host === socket.id){
        // pick new host
        if(room.players.length > 0){
          room.host = room.players[0].id;
        } else {
          // delete room
          delete rooms[code];
        }
      }
    }
  });

  // helpers: run
  function startNightFlow(room){
    // Reset interim choices
    room.mafiaTarget = null; room.medicSave = null; room.detectiveTarget = null; room.votes = {};
    // mafia phase
    io.to(room.code).emit('phaseMessage', { phase: 'mafia', timeout: 30000 });
    // 30s mafia
    room._phaseTimer = setTimeout(()=> {
      // if mafia hasn't chosen pick random alive target (not mafia)
      if(!room.mafiaTarget){
        const candidates = room.players.filter(p=>p.alive && p.role !== 'mafia');
        if(candidates.length) room.mafiaTarget = candidates[Math.floor(Math.random()*candidates.length)].id;
      }
      // medic phase
      io.to(room.code).emit('phaseMessage', { phase: 'medic', timeout: 30000 });
      room._phaseTimer = setTimeout(()=> {
        // if medic hasn't chosen, medicSave remains null
        // detective phase
        io.to(room.code).emit('phaseMessage', { phase: 'detective', timeout: 30000 });
        room._phaseTimer = setTimeout(()=> {
          // detective auto-skip if not chosen
          // process night:
          const killedId = room.mafiaTarget || null;
          const medicSaved = (room.medicSave && killedId && room.medicSave === killedId) ? true : false;
          // apply kill
          if(killedId && !medicSaved){
            const victim = room.players.find(p=>p.id===killedId);
            if(victim) victim.alive = false;
          }
          // send night result narrative
          const killedName = killedId ? (room.players.find(p=>p.id===killedId)?.name) : null;
          io.to(room.code).emit('nightResult', { killedId: killedId && !medicSaved ? killedId : null, medicSaved: medicSaved, killedName });
          // inform killed player
          if(killedId && !medicSaved){
            io.to(killedId).emit('playerKilled', { you: true });
            // other players get update
          }
          // check win
          const res = checkWin(room);
          if(res.over){
            // prepare reveal
            const reveal = {};
            room.players.forEach(p => reveal[p.id] = { name: p.name, role: p.role });
            io.to(room.code).emit('gameEnd', { winner: res.winner, reveal });
            // cleanup
            delete rooms[room.code];
            return;
          }
          // day phase (voting)
          room.phase = 'day';
          io.to(room.code).emit('phaseMessage', { phase: 'day', timeout: 120000 });
          room.votes = {};
          room._phaseTimer = setTimeout(()=> {
            // tally votes
            const counts = {};
            for(const voter in room.votes){
              const t = room.votes[voter];
              if(!t) continue;
              counts[t] = (counts[t]||0) + 1;
            }
            // find highest
            let lynched = null; let max = 0;
            for(const id in counts){ if(counts[id] > max){ max = counts[id]; lynched = id; } }
            if(lynched){
              const victim = room.players.find(p=>p.id===lynched);
              if(victim){
                victim.alive = false;
                io.to(room.code).emit('voteResult', { lynched: true, reveal: victim.name });
              }
            } else {
              io.to(room.code).emit('voteResult', { lynched: false });
            }
            // after vote check win
            const res2 = checkWin(room);
            if(res2.over){
              const reveal = {};
              room.players.forEach(p => reveal[p.id] = { name: p.name, role: p.role });
              io.to(room.code).emit('gameEnd', { winner: res2.winner, reveal });
              delete rooms[room.code];
              return;
            }
            // next night
            startNightFlow(room);
          }, 120000);
        }, 30000);
      }, 30000);
    }, 30000);
  }

});

const PORT = process.env.PORT || 5000;
server.listen(PORT, ()=> console.log('Server running on port', PORT));
