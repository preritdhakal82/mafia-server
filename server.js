const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  }
});

// Render uses process.env.PORT
const PORT = process.env.PORT || 10000;

// Stores all lobbies
let lobbies = {};

// Random 6-letter code
function generateCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Host creates a lobby
  socket.on("createLobby", ({ username, mafiaCount }) => {
    const code = generateCode();

    lobbies[code] = {
      host: socket.id,
      users: {},
      mafiaCount: mafiaCount,
      gameStarted: false,
    };

    lobbies[code].users[socket.id] = {
      username,
      role: null,
      alive: true,
    };

    socket.join(code);
    socket.emit("lobbyCreated", code);
    io.to(code).emit("lobbyUpdate", lobbies[code]);
  });

  // Join a lobby
  socket.on("joinLobby", ({ username, code }) => {
    if (!lobbies[code]) {
      socket.emit("errorMessage", "Lobby not found");
      return;
    }

    lobbies[code].users[socket.id] = {
      username,
      role: null,
      alive: true,
    };

    socket.join(code);
    io.to(code).emit("lobbyUpdate", lobbies[code]);
  });

  // Start the game (assign roles)
  socket.on("startGame", (code) => {
    if (!lobbies[code]) return;

    let players = Object.keys(lobbies[code].users);
    let mafiaCount = lobbies[code].mafiaCount;

    let roles = [];

    for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
    roles.push("medic");
    roles.push("detective");

    while (roles.length < players.length) roles.push("villager");

    // Shuffle roles
    roles.sort(() => Math.random() - 0.5);

    players.forEach((id, index) => {
      lobbies[code].users[id].role = roles[index];
      io.to(id).emit("yourRole", roles[index]); // Secret role reveal
    });

    lobbies[code].gameStarted = true;
    io.to(code).emit("gameStarted");
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    for (const code in lobbies) {
      if (lobbies[code].users[socket.id]) {
        delete lobbies[code].users[socket.id];
        io.to(code).emit("lobbyUpdate", lobbies[code]);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
