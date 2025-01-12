// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { Low, JSONFile } = require('lowdb'); // <-- For persistent storage
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// =================== 1) LOWDB SETUP =================== //
// We'll keep a small JSON file "db.json" in the project root.
// If it doesn't exist, LowDB will create it.
const adapter = new JSONFile('db.json');
const db = new Low(adapter);

// We'll store something like:
// db.data = {
//   rooms: {
//     "myRoom123": {
//       players: [ ... ],
//       hands: [[],[],[],[]],
//       ...
//     },
//     ...
//   }
// }

async function initDB() {
  // Read db.json, or create if none
  await db.read();
  if (!db.data) {
    db.data = { rooms: {} };
    await db.write();
  }
}
initDB(); // Kickstart reading & writing

// =============== 2) EXPRESS STATIC & PORT =============== //
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// =============== 3) GAME STATE UTILITIES =============== //
function createDeck() {
  const suits = ['clubs','diamonds','hearts','spades'];
  const values = ['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'];
  let deck = [];
  for (let s of suits) {
    for (let v of values) {
      deck.push({ suit: s, value: v });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function getCardValueStrength(value) {
  const order = ['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'];
  return order.indexOf(value);
}

function evaluateTrickWinner(trick, trumpSuit) {
  // trick = [{ playerIndex, card, username }, ...]
  const ledSuit = trick[0].card.suit;
  let winningIndex = 0;
  let bestStrength = getCardValueStrength(trick[0].card.value);
  let bestIsTrump = (trick[0].card.suit === trumpSuit);

  for (let i = 1; i < trick.length; i++) {
    const { card } = trick[i];
    const isTrump = (card.suit === trumpSuit);
    if (isTrump && !bestIsTrump) {
      winningIndex = i;
      bestStrength = getCardValueStrength(card.value);
      bestIsTrump = true;
    } else if (isTrump && bestIsTrump) {
      const strength = getCardValueStrength(card.value);
      if (strength > bestStrength) {
        winningIndex = i;
        bestStrength = strength;
      }
    } else if (!isTrump && !bestIsTrump && card.suit === ledSuit) {
      const strength = getCardValueStrength(card.value);
      if (strength > bestStrength) {
        winningIndex = i;
        bestStrength = strength;
      }
    }
  }
  return trick[winningIndex].playerIndex;
}

// ========== 4) ROOM STATE HELPER (READ & WRITE) ========== //
// Because we must always read the latest from the DB, then write back after changes
async function getRoom(roomName) {
  await db.read();
  return db.data.rooms[roomName];
}

async function setRoom(roomName, newData) {
  await db.read();
  db.data.rooms[roomName] = newData;
  await db.write();
}

// If room doesn't exist, create a default skeleton
async function ensureRoomExists(roomName) {
  await db.read();
  if (!db.data.rooms[roomName]) {
    db.data.rooms[roomName] = {
      players: [],
      hands: [[], [], [], []],
      trumpSuit: null,
      roundWins: [0,0,0,0],
      teamScores: [0,0],
      currentTrick: [],
      currentLeader: 0,
      jackChooser: null,
      deck: [],
      gameInProgress: false,
      isTrumpChosen: false
    };
    await db.write();
  }
}

// ========== 5) PARTIAL GAME FLOW (TWO-PHASE DEAL) ========== //
function createFullDeckAndDeal(roomState) {
  const deck = createDeck();
  shuffle(deck);
  roomState.deck = deck;
  roomState.hands = [[], [], [], []];
  
  // deal 52 cards in round-robin
  let pIndex = 0;
  for (let i=0; i<52; i++) {
    roomState.hands[pIndex].push(deck[i]);
    pIndex = (pIndex+1) % 4;
  }
}

// Find first seat that has a 'jack'
function findJackChooser(roomState) {
  for (let s = 0; s < 4; s++) {
    for (let card of roomState.hands[s]) {
      if (card.value === 'jack') {
        return s;
      }
    }
  }
  return 0; // fallback
}

// Start a new game
async function startGame(roomName) {
  let roomState = await getRoom(roomName);
  if (!roomState) return;

  console.log(`Starting new game in room: ${roomName}`);

  createFullDeckAndDeal(roomState);
  roomState.gameInProgress = true;
  roomState.isTrumpChosen = false;
  roomState.roundWins = [0,0,0,0];
  roomState.teamScores = [0,0];
  roomState.currentTrick = [];
  roomState.trumpSuit = null;

  const jackChooser = findJackChooser(roomState);
  roomState.jackChooser = jackChooser;
  roomState.currentLeader = 0; // we'll set leader once trump is chosen

  await setRoom(roomName, roomState);

  // Send 'deal-started' only to jackChooser
  const chooserSocketId = roomState.players[jackChooser].socketId;
  const chooserCards = roomState.hands[jackChooser];
  io.to(chooserSocketId).emit('deal-started', {
    seatIndex: jackChooser,
    cards: chooserCards
  });

  // Let the other 3 seats know "game-ready" with no hands yet
  roomState.players.forEach(p => {
    if (p.seatIndex !== jackChooser) {
      io.to(p.socketId).emit('game-ready', {
        allHands: null,
        trumpSuit: null,
        currentLeader: null
      });
    }
  });
}

// Once trump is chosen, deliver the rest of the hands
async function deliverRestOfHands(roomName) {
  let roomState = await getRoom(roomName);
  if (!roomState) return;

  roomState.isTrumpChosen = true;
  // The person who found the first jack leads first
  roomState.currentLeader = roomState.jackChooser;

  await setRoom(roomName, roomState);

  io.to(roomName).emit('rest-deal', {
    allHands: roomState.hands,
    trumpSuit: roomState.trumpSuit,
    currentLeader: roomState.currentLeader
  });
}

// ========== 6) SOCKET.IO LOGIC ========== //
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Join or Reconnect
  socket.on('join-room', async ({ roomName, playerId, username }) => {
    if (!roomName || !playerId || !username) return;

    // Ensure room in db
    await ensureRoomExists(roomName);
    let roomState = await getRoom(roomName);

    // Check if playerId is in this room
    let existingPlayer = roomState.players.find(p => p.playerId === playerId);
    if (existingPlayer) {
      // Reconnect scenario
      existingPlayer.socketId = socket.id;
      existingPlayer.username = username;
      socket.join(roomName);
      await setRoom(roomName, roomState);

      socket.emit('player-number', { playerIndex: existingPlayer.seatIndex });
      console.log(`Player seat #${existingPlayer.seatIndex+1} rejoined room ${roomName} as ${username}`);

      // If game in progress, re-send partial state
      if (roomState.gameInProgress) {
        if (!roomState.isTrumpChosen && existingPlayer.seatIndex === roomState.jackChooser) {
          // they're the chooser but haven't chosen suit yet
          const chooserCards = roomState.hands[roomState.jackChooser];
          socket.emit('deal-started', {
            seatIndex: roomState.jackChooser,
            cards: chooserCards
          });
        }
        else if (roomState.isTrumpChosen) {
          // deliver the "rest-deal" state
          socket.emit('rest-deal', {
            allHands: roomState.hands,
            trumpSuit: roomState.trumpSuit,
            currentLeader: roomState.currentLeader
          });
        }
        // Also might re-send the currentTrick, scoreboard, etc.
        if (roomState.currentTrick.length > 0) {
          socket.emit('trick-updated', { currentTrick: roomState.currentTrick });
        }
        socket.emit('round-end', {
          winner: null, // or you can figure out partial
          teamScores: roomState.teamScores
        });
      }

    } else {
      // New seat
      if (roomState.players.length >= 4) {
        socket.emit('room-full', { roomName });
        return;
      }
      const seatIndex = roomState.players.length;
      roomState.players.push({
        playerId,
        socketId: socket.id,
        seatIndex,
        username
      });
      socket.join(roomName);
      await setRoom(roomName, roomState);

      socket.emit('player-number', { playerIndex: seatIndex });
      console.log(`New seat #${seatIndex+1} in room ${roomName}, user=${username}, ID=${playerId}`);

      // If we reach 4 players, start
      if (roomState.players.length === 4 && !roomState.gameInProgress) {
        startGame(roomName);
      }
    }
  });

  // Trump chosen
  socket.on('trump-chosen', async ({ roomName, chosenSuit }) => {
    let roomState = await getRoom(roomName);
    if (!roomState) return;

    let playerObj = roomState.players.find(p => p.socketId === socket.id);
    if (!playerObj) return;

    if (playerObj.seatIndex === roomState.jackChooser && !roomState.isTrumpChosen) {
      roomState.trumpSuit = chosenSuit;
      await setRoom(roomName, roomState);

      console.log(`Room ${roomName}: seat #${playerObj.seatIndex+1} chose trump = ${chosenSuit}`);
      // now deliver rest of the hands
      deliverRestOfHands(roomName);

      // broadcast trump
      io.to(roomName).emit('trump-suit-set', { trumpSuit: chosenSuit });
    }
  });

  // Card played
  socket.on('card-played', async ({ roomName, card }) => {
    let roomState = await getRoom(roomName);
    if (!roomState) return;

    let playerObj = roomState.players.find(p => p.socketId === socket.id);
    if (!playerObj) return;

    const seatIndex = playerObj.seatIndex;
    if (!roomState.isTrumpChosen) return;

    const turnSeat = (roomState.currentLeader + roomState.currentTrick.length) % 4;
    if (seatIndex !== turnSeat) {
      console.log(`seat #${seatIndex+1} tried to play out of turn`);
      return;
    }

    // remove from server's copy of that seat's hand
    const idx = roomState.hands[seatIndex].findIndex(c => c.suit === card.suit && c.value === card.value);
    if (idx >= 0) {
      roomState.hands[seatIndex].splice(idx, 1);
    }

    // add to currentTrick
    roomState.currentTrick.push({
      playerIndex: seatIndex,
      card,
      username: playerObj.username
    });

    await setRoom(roomName, roomState);
    io.to(roomName).emit('trick-updated', {
      currentTrick: roomState.currentTrick
    });

    // If 4th card
    if (roomState.currentTrick.length === 4) {
      // ============== DELAY LOGIC ==============
      // We let the 4 cards remain visible for e.g. 3 seconds:
      setTimeout(async () => {
        // At this point, we evaluate the trick
        let updatedRoom = await getRoom(roomName); // re-read because 3s passed
        const winner = evaluateTrickWinner(updatedRoom.currentTrick, updatedRoom.trumpSuit);
        updatedRoom.roundWins[winner] += 1;

        const winningTeam = (winner % 2 === 0) ? 0 : 1;
        updatedRoom.teamScores[winningTeam] += 1;

        // broadcast round-end
        io.to(roomName).emit('round-end', {
          winner,
          teamScores: updatedRoom.teamScores
        });

        // check if team reached 7
        if (updatedRoom.teamScores[winningTeam] >= 7) {
          io.to(roomName).emit('game-over', { winningTeam });
          // optionally start new game after X seconds
          setTimeout(() => startGame(roomName), 3000);
        } else {
          // next trick
          updatedRoom.currentLeader = winner;
          updatedRoom.currentTrick = [];
          await setRoom(roomName, updatedRoom);
          io.to(roomName).emit('new-trick', {
            currentLeader: winner
          });
        }
      }, 3000); // 3 second delay

    }
  });

  // Disconnect
  socket.on('disconnect', async () => {
    console.log('Socket disconnected:', socket.id);
    // If you want to keep the seat "reserved" so the game continues
    // we won't remove them or reset the room. 
    // The next time they connect with the same playerId, we restore them.
    // Optional: add a "timeout" if they never return, etc.

    // We'll just log that they're offline for now.
    // If your game requires all 4 players always, you might do a "ghost seat" approach
    // or a short timer to end or pause the game.
    let allRooms = Object.keys(db.data.rooms);
    for (let rn of allRooms) {
      let rState = db.data.rooms[rn];
      const pl = rState.players.find(p => p.socketId === socket.id);
      if (pl) {
        console.log(`Seat #${pl.seatIndex+1} in room "${rn}" disconnected. Marking offline.`);
        // pl.socketId = null or keep old but note they're offline
        pl.socketId = null;
        await db.write();
        break;
      }
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
