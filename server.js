// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

/*
 rooms[roomName] = {
   players: [
     {
       playerId: string,
       socketId: string,
       seatIndex: 0..3,
       username: string,
       isConnected: boolean
     },
     ...
   ],
   deck: [],          // the shuffled deck
   hands: [ [], [], [], [] ], // 13 cards each
   jackChooser: null,
   trumpSuit: null,
   currentTrick: [],
   roundWins: [0,0,0,0],
   teamScores: [0,0],
   currentLeader: 0,
   gameInProgress: false,
   isTrumpChosen: false
 }
*/

const rooms = {};

// ========== Utility Functions ========== //
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
  for (let i=arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()* (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Return the seat index of the first jack
function findFirstJackIndex(hands) {
  // Each player has 13 cards => total 52 distributed in [hands[0], ...]
  // We want whichever seat got a 'jack' first in the dealing order
  // But we can do a simpler check: find the earliest occurrence of 'jack' in the combined sequence
  // or we can do it while dealing; depends on your approach.
  for (let s = 0; s < 4; s++) {
    for (let card of hands[s]) {
      if (card.value === 'jack') {
        return s;
      }
    }
  }
  return 0; // fallback if no jack found
}

// Evaluate trick winner
function getCardValueStrength(value) {
  const order = ['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'];
  return order.indexOf(value);
}
function evaluateTrickWinner(trick, trumpSuit) {
  // trick = [ { playerIndex, card, username }, ...]
  const ledSuit = trick[0].card.suit;
  let winnerIndex = 0;
  let bestStrength = getCardValueStrength(trick[0].card.value);
  let bestIsTrump = (trick[0].card.suit === trumpSuit);

  for (let i=1; i<4; i++) {
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

// ========== Phase 1: Deal only to the seat with first Jack ========== //
function dealFirstJackOnly(roomState) {
  // Create + shuffle deck, place in roomState.deck
  const deck = createDeck();
  shuffle(deck);
  roomState.deck = deck;  
  roomState.hands = [[],[],[],[]];
  roomState.roundWins = [0,0,0,0];
  roomState.teamScores = [0,0];
  roomState.currentTrick = [];
  roomState.trumpSuit = null;
  roomState.currentLeader = 0;
  roomState.isTrumpChosen = false;
  roomState.gameInProgress = true;

  // Fully deal 52 cards into 4 arrays of 13 
  // but we won't SHOW the other 3 yet
  let pIndex = 0;
  for (let i=0; i<52; i++) {
    roomState.hands[pIndex].push(deck[i]);
    pIndex = (pIndex + 1) % 4;
  }
  // Find first Jack seat
  const jackChooser = findFirstJackIndex(roomState.hands);
  roomState.jackChooser = jackChooser;
}

// ========== Phase 2: Once trump is chosen, deal the other 3 seats' visibility ========== //
function deliverRestOfHands(roomName) {
  const roomState = rooms[roomName];
  if (!roomState) return;

  roomState.isTrumpChosen = true;
  roomState.currentLeader = roomState.jackChooser;

  // Broadcast rest of the hands to everyone
  io.to(roomName).emit('rest-deal', {
    allHands: roomState.hands,
    trumpSuit: roomState.trumpSuit,
    currentLeader: roomState.currentLeader
  });
}

// ========== Start a new game in a room ========== //
function startGame(roomName) {
  const roomState = rooms[roomName];
  if (!roomState) return;

  console.log(`Starting new game in room: ${roomName}`);

  dealFirstJackOnly(roomState);

  // Identify the jackChooser's socket
  const jSocketId = roomState.players[roomState.jackChooser].socketId;
  // Send them "deal-started" with their 13 cards
  const chooserCards = roomState.hands[roomState.jackChooser];
  io.to(jSocketId).emit('deal-started', {
    seatIndex: roomState.jackChooser,
    cards: chooserCards
  });

  // For the other 3 seats, let them know "game is in progress, wait for rest of deal"
  // They won't see their 13 cards until trump is chosen
  roomState.players.forEach((pl) => {
    if (pl.seatIndex !== roomState.jackChooser) {
      const sockId = pl.socketId;
      io.to(sockId).emit('game-ready', {
        allHands: null, // or we can hide
        trumpSuit: null,
        currentLeader: null
      });
    }
  });
}

// ========== Socket.IO ========== //
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomName, playerId, username }) => {
    if (!roomName || !playerId || !username) return;

    if (!rooms[roomName]) {
      rooms[roomName] = {
        players: [],
        deck: [],
        hands: [[],[],[],[]],
        jackChooser: null,
        trumpSuit: null,
        currentTrick: [],
        roundWins: [0,0,0,0],
        teamScores: [0,0],
        currentLeader: 0,
        gameInProgress: false,
        isTrumpChosen: false
      };
    }
    const roomState = rooms[roomName];

    // Reconnect check
    let existing = roomState.players.find(p => p.playerId === playerId);
    if (existing) {
      // Reconnect
      existing.socketId = socket.id;
      existing.username = username;
      existing.isConnected = true;
      socket.join(roomName);
      socket.emit('player-number', { playerIndex: existing.seatIndex });
      console.log(`Player seat #${existing.seatIndex+1} rejoined room ${roomName} as ${username}`);

      // If the game is in progress, we might want to re-send partial info
      // E.g., if they've already been dealt cards:
      if (roomState.gameInProgress) {
        if (!roomState.isTrumpChosen && existing.seatIndex === roomState.jackChooser) {
          // They were the jackChooser but got disconnected before choosing?
          // re-send "deal-started"
          const chooserCards = roomState.hands[roomState.jackChooser];
          socket.emit('deal-started', {
            seatIndex: roomState.jackChooser,
            cards: chooserCards
          });
        } else if (roomState.isTrumpChosen) {
          // Everyone else or a reconnected seat after trump chosen
          socket.emit('rest-deal', {
            allHands: roomState.hands,
            trumpSuit: roomState.trumpSuit,
            currentLeader: roomState.currentLeader
          });
        }
        // Also re-send scoreboard or currentTrick if desired
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
        username,
        isConnected: true
      });
      socket.join(roomName);
      socket.emit('player-number', { playerIndex: seatIndex });
      console.log(`New seat #${seatIndex+1} in room ${roomName}, user=${username}, ID=${playerId}`);

      // If we have 4 players, start
      if (roomState.players.length === 4 && !roomState.gameInProgress) {
        startGame(roomName);
      }
    }
  });

  // Trump chosen
  socket.on('trump-chosen', ({ roomName, chosenSuit }) => {
    const roomState = rooms[roomName];
    if (!roomState) return;

    let playerObj = roomState.players.find(p => p.socketId === socket.id);
    if (!playerObj) return;

    if (playerObj.seatIndex === roomState.jackChooser && !roomState.isTrumpChosen) {
      roomState.trumpSuit = chosenSuit;
      console.log(`Room ${roomName}: seat #${playerObj.seatIndex+1} chose trump = ${chosenSuit}`);
      // Now "deliver" the rest of the hands
      deliverRestOfHands(roomName);
      // Everyone sees the final trump
      io.to(roomName).emit('trump-suit-set', { trumpSuit: chosenSuit });
    }
  });

  // Card played
  socket.on('card-played', ({ roomName, card }) => {
    const roomState = rooms[roomName];
    if (!roomState) return;

    let playerObj = roomState.players.find(p => p.socketId === socket.id);
    if (!playerObj) return;

    const seatIndex = playerObj.seatIndex;
    if (!roomState.isTrumpChosen) return; // no card play if trump not chosen
    const turnSeat = (roomState.currentLeader + roomState.currentTrick.length) % 4;
    if (seatIndex !== turnSeat) {
      console.log(`seat #${seatIndex+1} tried to play out of turn in ${roomName}`);
      return;
    }

    // Remove from server's copy of that seat's hand
    const idx = roomState.hands[seatIndex].findIndex(c => c.suit===card.suit && c.value===card.value);
    if (idx >= 0) {
      roomState.hands[seatIndex].splice(idx, 1);
    }

    // Add to currentTrick
    roomState.currentTrick.push({
      playerIndex: seatIndex,
      card,
      username: playerObj.username
    });

    io.to(roomName).emit('trick-updated', {
      currentTrick: roomState.currentTrick
    });

    // If 4 cards played => evaluate
    if (roomState.currentTrick.length === 4) {
      const winner = evaluateTrickWinner(roomState.currentTrick, roomState.trumpSuit);
      roomState.roundWins[winner] += 1;

      const winningTeam = (winner % 2 === 0) ? 0 : 1;
      roomState.teamScores[winningTeam] += 1;

      io.to(roomName).emit('round-end', {
        winner,
        teamScores: roomState.teamScores
      });

      // Check if a team reached 7
      if (roomState.teamScores[winningTeam] >= 7) {
        io.to(roomName).emit('game-over', { winningTeam });
        setTimeout(() => startGame(roomName), 3000);
      } else {
        // Next trick
        roomState.currentLeader = winner;
        roomState.currentTrick = [];
        io.to(roomName).emit('new-trick', {
          currentLeader: winner
        });
      }
    }
  });

  // On disconnect
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    // Mark them as disconnected but do NOT reset the entire room
    for (const rn in rooms) {
      const roomState = rooms[rn];
      if (!roomState) continue;
      let pl = roomState.players.find(p => p.socketId === socket.id);
      if (pl) {
        console.log(`Seat #${pl.seatIndex+1} in room "${rn}" disconnected.`);
        pl.isConnected = false;
        // Optionally set pl.socketId = null
        pl.socketId = null;
        // We keep the game going, hopefully they rejoin soon with the same playerId
        // No forced reset. If they never come back, you might consider a "timer" to re-init the room or allow a sub
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
