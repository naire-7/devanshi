// script.js

const socket = io();

// ========== 1) PERSISTENT IDENTITY ==========
let playerId = localStorage.getItem('devanshi_playerId');
if (!playerId) {
  playerId = 'player-' + Math.random().toString(36).substring(2, 9);
  localStorage.setItem('devanshi_playerId', playerId);
}

// ========== DOM ELEMENTS ==========
const usernameInput = document.getElementById('username-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-room-btn');
const joinStatusMsg = document.getElementById('join-status-msg');

const statusDiv = document.getElementById('status');
const team0ScoreSpan = document.getElementById('team0-score');
const team1ScoreSpan = document.getElementById('team1-score');
const trumpSuitSpan = document.getElementById('trump-suit');
const trickContainer = document.getElementById('trick-container');
const handArea = document.getElementById('hand-area');

const chooseTrumpOverlay = document.getElementById('chooseTrumpOverlay');
const suitButtons = document.querySelectorAll('.suit-btn');

// Local game state
let mySeatIndex = null;
let myHand = [];
let currentTrick = [];
let currentLeader = 0;
let trumpSuit = null;
let myUsername = null;
let roomName = null;

// ========== 2) JOIN ROOM ==========
joinBtn.addEventListener('click', () => {
  roomName = roomInput.value.trim();
  myUsername = usernameInput.value.trim();

  if (!roomName || !myUsername) {
    joinStatusMsg.textContent = 'Please provide a valid name and room.';
    return;
  }

  socket.emit('join-room', {
    roomName,
    playerId,
    username: myUsername
  });

  joinStatusMsg.textContent = `Attempting to join "${roomName}"...`;
});

// ========== 3) SUIT BUTTONS FOR JACKCHOOSER ==========
suitButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const chosenSuit = btn.dataset.suit; // clubs/diamonds/hearts/spades
    socket.emit('trump-chosen', { roomName, chosenSuit });
    chooseTrumpOverlay.classList.add('hidden');
  });
});

// ========== 4) SOCKET EVENTS ========== //
socket.on('connect', () => {
  statusDiv.textContent = 'Connected to server.';
});

socket.on('room-full', (data) => {
  joinStatusMsg.textContent = `Room "${data.roomName}" is already full.`;
});

socket.on('player-number', (data) => {
  mySeatIndex = data.playerIndex;
  statusDiv.textContent = `Joined room as seat #${mySeatIndex + 1}. Waiting for others...`;
});

/**
 * "deal-started" event will ONLY give the jackChooser their 13 cards.
 * Then the jackChooser picks trump. AFTER that, "rest-deal" event 
 * will deliver the other 3 players' hands.
 */

// Step 1: jackChooser sees their 13 cards
socket.on('deal-started', (data) => {
  // data => { seatIndex, cards }
  // This event only fires for the jackChooser
  myHand = data.cards;
  renderHand();
  statusDiv.textContent = 'You got the first Jack! Choose the dominant suit.';
  // Show the overlay to pick trump
  chooseTrumpOverlay.classList.remove('hidden');
});

// Step 2: once trump chosen, the server deals the other 3 players
socket.on('rest-deal', (data) => {
  // data => { allHands, trumpSuit, currentLeader }
  // Now EVERYONE has their 13 cards assigned. 
  // The jackChooser keeps their old myHand; the other 3 seats get new data.
  // But let's do a unify approach: 
  myHand = data.allHands[mySeatIndex]; 
  currentLeader = data.currentLeader;
  trumpSuit = data.trumpSuit;
  trumpSuitSpan.textContent = trumpSuit;

  renderHand();
  clearTrick();
  statusDiv.textContent = `Trump is ${trumpSuit}. Seat ${currentLeader + 1} leads the first trick.`;
});

// If you're NOT the jackChooser but the game started
// (server might do something like "game-ready")
socket.on('game-ready', (data) => {
  // data => { allHands, trumpSuit, currentLeader }
  // For the 3 non-jackChooser seats
  myHand = data.allHands[mySeatIndex];
  currentLeader = data.currentLeader;
  trumpSuit = data.trumpSuit;
  trumpSuitSpan.textContent = trumpSuit;
  
  renderHand();
  clearTrick();
  statusDiv.textContent = `Trump is ${trumpSuit}. Seat ${currentLeader + 1} leads.`;
});

// Normal trick updates
socket.on('trick-updated', (data) => {
  currentTrick = data.currentTrick;
  renderTrick();
});

socket.on('round-end', (data) => {
  const winner = data.winner;
  const teamScores = data.teamScores;
  team0ScoreSpan.textContent = teamScores[0];
  team1ScoreSpan.textContent = teamScores[1];

  if (winner === mySeatIndex) {
    statusDiv.textContent = 'You won that trick!';
  } else {
    statusDiv.textContent = `Seat ${winner + 1} won that trick.`;
  }
});

socket.on('new-trick', (data) => {
  currentLeader = data.currentLeader;
  currentTrick = [];
  renderTrick();

  if (currentLeader === mySeatIndex) {
    statusDiv.textContent = 'Your turn to lead the new trick!';
  } else {
    statusDiv.textContent = `Seat ${currentLeader + 1} leads the next trick.`;
  }
});

socket.on('game-over', (data) => {
  const winningTeam = data.winningTeam;
  if ((mySeatIndex % 2) === winningTeam) {
    statusDiv.textContent = 'Your team won the game! A new game will start soon...';
  } else {
    statusDiv.textContent = 'Opponents won the game. A new game will start soon...';
  }
});

// ========== 5) RENDER FUNCTIONS ========== //
function renderHand() {
  handArea.innerHTML = '';
  myHand.forEach((card) => {
    const cardDiv = document.createElement('div');
    cardDiv.classList.add('card');

    const cardImg = document.createElement('img');
    cardImg.src = `cards/${card.value}_of_${card.suit}.png`;
    cardImg.alt = `${card.value} of ${card.suit}`;

    cardDiv.appendChild(cardImg);
    cardDiv.addEventListener('click', () => {
      playCard(card);
    });
    handArea.appendChild(cardDiv);
  });
}

function renderTrick() {
  trickContainer.innerHTML = '';
  currentTrick.forEach(({ playerIndex, card, username }) => {
    const cardDiv = document.createElement('div');
    cardDiv.classList.add('played-card');

    const label = document.createElement('div');
    label.textContent = `${username} (Seat ${playerIndex + 1})`;
    cardDiv.appendChild(label);

    const cardImg = document.createElement('img');
    cardImg.src = `cards/${card.value}_of_${card.suit}.png`;
    cardImg.alt = `${card.value} of ${card.suit}`;
    cardDiv.appendChild(cardImg);

    trickContainer.appendChild(cardDiv);
  });
}

function clearTrick() {
  trickContainer.innerHTML = '';
}

// ========== 6) PLAY A CARD ========== //
function playCard(card) {
  // Check turn order
  if (!myHand.length) return;
  const seatTurn = (currentLeader + currentTrick.length) % 4;
  if (mySeatIndex !== seatTurn) {
    alert('Not your turn yet!');
    return;
  }
  socket.emit('card-played', { roomName, card });

  // Remove from local hand
  myHand = myHand.filter(c => !(c.suit === card.suit && c.value === card.value));
  renderHand();
}
