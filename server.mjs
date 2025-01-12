/******************************************************
 * server.js
 * 
 * Main Node/Express/Socket.IO server with LowDB-based 
 * persistence and a 3-second delay before clearing 
 * the table after the 4th card is played.
 ******************************************************/

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createServer } from 'http'
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const adapter = new JSONFile('db.json');
const db = new Low(adapter, { rooms: {} })

// Then read & write
await db.read()
// If db.json is empty, db.data = { rooms: {} }
// Now db.data is guaranteed an object, so no error
await db.write()

/******************************************************
 * Initialize LowDB with default data if db.json empty
 ******************************************************/
async function initDB() {
  await db.read();
  if (!db.data) {
    db.data = { rooms: {} }; 
    await db.write();
  }
}
initDB().catch(console.error);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

/******************************************************
 * HELPER FUNCTIONS - Card Logic
 ******************************************************/
function createDeck() {
  const suits = ['clubs','diamonds','hearts','spades'];
  const values = ['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'];
  const deck = [];
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
  // trick = [ { playerIndex, card, username }, ... ]
  const ledSuit = trick[0].card.suit;
  let winnerIndex = 0;
  let bestStrength = getCardValueStrength(trick[0].card.value);
  let bestIsTrump = (trick[0].card.suit === trumpSuit);

  for (let i = 1; i < trick.length; i++) {
    const { card } = trick[i];
    const isTrump = (card.suit === trumpSuit);

    if (isTrump && !bestIsTrump) {
      winnerIndex = i;
      bestStrength = getCardValueStrength(card.value);
      bestIsTrump = true;
    } else if (isTrump && bestIsTrump) {
      const strength = getCardValueStrength(card.value);
      if (strength > bestStrength) {
        winnerIndex = i;
        bestStrength = strength;
      }
    } else if (!isTrump && !bestIsTrump && card.suit === ledSuit) {
      const strength = getCardValueStrength(card.value);
      if (strength > bestStrength) {
        winnerIndex = i;
        bestStrength = strength;
      }
    }
  }
  return trick[winnerIndex].playerIndex;
}

/******************************************************
 * LOWDB HELPER: get & set a room
 ******************************************************/
async function getRoom(roomName) {
  await db.read();
  return db.data.rooms[roomName];
}
async function setRoom(roomName, newState) {
  await db.read();
  db.data.rooms[roomName] = newState;
  await db.write();
}
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

/******************************************************
 * DEALING & JACK FINDING
 ******************************************************/
function createFullDeckAndDeal(roomState) {
  const deck = createDeck();
  shuffle(deck);
  roomState.deck = deck;
  roomState.hands = [[],[],[],[]];
  let pIndex = 0;
  for (let i=0; i<52; i++) {
    roomState.hands[pIndex].push(deck[i]);
    pIndex = (pIndex+1) % 4;
  }
}

function findJackChooser(roomState) {
  for (let s=0; s<4; s++) {
    for (let c of roomState.hands[s]) {
      if (c.value === 'jack') return s;
    }
  }
  return 0; 
}

/******************************************************
 * START GAME (Two-Phase Deal)
 ******************************************************/
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
  roomState.currentLeader = 0; // set after trump

  await setRoom(roomName, roomState);

  // Send 'deal-started' to the jackChooser
  const chooserSocketId = roomState.players[jackChooser].socketId;
  const chooserCards = roomState.hands[jackChooser];
  io.to(chooserSocketId).emit('deal-started', {
    seatIndex: jackChooser,
    cards: chooserCards
  });

  // Everyone else sees "game-ready" with no hands
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

/******************************************************
 * Once trump is chosen, deliver the rest of the hands
 ******************************************************/
async function deliverRestOfHands(roomName) {
  let roomState = await getRoom(roomName);
  if (!roomState) return;

  roomState.isTrumpChosen = true;
  roomState.currentLeader = roomState.jackChooser; 
  await setRoom(roomName, roomState);

  io.to(roomName).emit('rest-deal', {
    allHands: roomState.hands,
    trumpSuit: roomState.trumpSuit,
    currentLeader: roomState.currentLeader
  });
}

/******************************************************
 * SOCKET.IO
 ******************************************************/
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Join or Reconnect
  socket.on('join-room', async ({ roomName, playerId, username }) => {
    if (!roomName || !playerId || !username) return;

    await ensureRoomExists(roomName);
    let roomState = await getRoom(roomName);

    // Reconnect check
    let existingPlayer = roomState.players.find(p => p.playerId === playerId);
    if (existingPlayer) {
      // Reconnect
      existingPlayer.socketId = socket.id;
      existingPlayer.username = username;
      socket.join(roomName);
      await setRoom(roomName, roomState);

      socket.emit('player-number', { playerIndex: existingPlayer.seatIndex });
      console.log(`Player seat #${existingPlayer.seatIndex+1} rejoined ${roomName} as ${username}`);

      // If game in progress, re-send partial
      if (roomState.gameInProgress) {
        if (!roomState.isTrumpChosen && existingPlayer.seatIndex === roomState.jackChooser) {
          // They still need to choose trump
          const chooserCards = roomState.hands[roomState.jackChooser];
          socket.emit('deal-started', {
            seatIndex: roomState.jackChooser,
            cards: chooserCards
          });
        } else if (roomState.isTrumpChosen) {
          socket.emit('rest-deal', {
            allHands: roomState.hands,
            trumpSuit: roomState.trumpSuit,
            currentLeader: roomState.currentLeader
          });
        }
        if (roomState.currentTrick.length > 0) {
          socket.emit('trick-updated', { currentTrick: roomState.currentTrick });
        }
        socket.emit('round-end', {
          winner: null,
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
      console.log(`New seat #${seatIndex+1} in ${roomName}, user=${username}`);

      if (roomState.players.length === 4 && !roomState.gameInProgress) {
        startGame(roomName);
      }
    }
  });

  // trump-chosen
  socket.on('trump-chosen', async ({ roomName, chosenSuit }) => {
    let roomState = await getRoom(roomName);
    if (!roomState) return;

    let playerObj = roomState.players.find(p => p.socketId === socket.id);
    if (!playerObj) return;

    if (playerObj.seatIndex === roomState.jackChooser && !roomState.isTrumpChosen) {
      roomState.trumpSuit = chosenSuit;
      await setRoom(roomName, roomState);

      console.log(`Room ${roomName}: seat #${playerObj.seatIndex+1} chose trump = ${chosenSuit}`);
      deliverRestOfHands(roomName);
      io.to(roomName).emit('trump-suit-set', { trumpSuit: chosenSuit });
    }
  });

  // card-played
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

    // remove card from that player's hand
    const idx = roomState.hands[seatIndex].findIndex(
      c => c.suit === card.suit && c.value === card.value
    );
    if (idx >= 0) {
      roomState.hands[seatIndex].splice(idx, 1);
    }

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
      // Delay 3 seconds so everyone sees the final trick
      setTimeout(async () => {
        let updatedState = await getRoom(roomName);
        const winner = evaluateTrickWinner(updatedState.currentTrick, updatedState.trumpSuit);
        updatedState.roundWins[winner] += 1;
        
        const winningTeam = (winner % 2 === 0) ? 0 : 1;
        updatedState.teamScores[winningTeam] += 1;

        await setRoom(roomName, updatedState);

        io.to(roomName).emit('round-end', {
          winner,
          teamScores: updatedState.teamScores
        });

        // check if team reached 7
        if (updatedState.teamScores[winningTeam] >= 7) {
          io.to(roomName).emit('game-over', { winningTeam });
          setTimeout(() => startGame(roomName), 3000);
        } else {
          updatedState.currentLeader = winner;
          updatedState.currentTrick = [];
          await setRoom(roomName, updatedState);

          io.to(roomName).emit('new-trick', {
            currentLeader: winner
          });
        }
      }, 3000);
    }
  });

  socket.on('disconnect', async () => {
    console.log('Socket disconnected:', socket.id);
    // We'll keep the seat "reserved".
    // If the user re-joins with the same playerId, they get it back.
    // If you want to handle a final removal, do it after a timer, etc.
    
    await db.read();
    for (let rn of Object.keys(db.data.rooms)) {
      let rState = db.data.rooms[rn];
      let pl = rState.players.find(p => p.socketId === socket.id);
      if (pl) {
        console.log(`Seat #${pl.seatIndex+1} in room "${rn}" disconnected`);
        pl.socketId = null;
        await db.write();
        break;
      }
    }
  });
});

// Listen
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
