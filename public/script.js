/******************************************************
 * script.js
 * 
 * Basic client-side for DEVANSHI with 
 * two-phase dealing and 4-seat system.
 ******************************************************/
const socket = io();

let playerId = localStorage.getItem('devanshi_playerId');
if (!playerId) {
  playerId = 'player-' + Math.random().toString(36).substring(2,9);
  localStorage.setItem('devanshi_playerId', playerId);
}

// DOM
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
const suitBtns = document.querySelectorAll('.suit-btn');

// Local game state
let mySeatIndex = null;
let myHand = [];
let currentTrick = [];
let currentLeader = 0;
let trumpSuit = null;
let myUsername = null;
let roomName = null;

// Join
joinBtn.addEventListener('click', () => {
  roomName = roomInput.value.trim();
  myUsername = usernameInput.value.trim();
  if (!roomName || !myUsername) {
    joinStatusMsg.textContent = 'Please provide a name and room.';
    return;
  }
  socket.emit('join-room', { roomName, playerId, username: myUsername });
  joinStatusMsg.textContent = `Attempting to join "${roomName}"...`;
});

// Suit picking
suitBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const chosenSuit = btn.dataset.suit;
    socket.emit('trump-chosen', { roomName, chosenSuit });
    chooseTrumpOverlay.classList.add('hidden');
  });
});

// Socket events
socket.on('connect', () => {
  statusDiv.textContent = 'Connected.';
});

socket.on('room-full', data => {
  joinStatusMsg.textContent = `Room "${data.roomName}" is full.`;
});

socket.on('player-number', data => {
  mySeatIndex = data.playerIndex;
  statusDiv.textContent = `You are seat #${mySeatIndex+1}. Waiting for more players...`;
});

/** 
 * deal-started => only the jackChooser sees 13 cards 
 */
socket.on('deal-started', data => {
  // data => { seatIndex, cards }
  myHand = data.cards;
  renderHand();

  chooseTrumpOverlay.classList.remove('hidden');
  statusDiv.textContent = 'You have the first Jack. Choose trump suit.';
});

/** 
 * rest-deal => once trump chosen, broadcast the final hands to everyone 
 */
socket.on('rest-deal', data => {
  // data => { allHands, trumpSuit, currentLeader }
  myHand = data.allHands[mySeatIndex];
  trumpSuit = data.trumpSuit;
  trumpSuitSpan.textContent = trumpSuit;
  currentLeader = data.currentLeader;

  renderHand();
  clearTrick();
  statusDiv.textContent = `Trump is ${trumpSuit}. Seat ${currentLeader+1} leads first trick.`;
});

// If you're not the chooser, you get game-ready
socket.on('game-ready', data => {
  // data => { allHands, trumpSuit, currentLeader }
  // here it's null for allHands
  statusDiv.textContent = 'Game started. Waiting for trump choice...';
});

socket.on('trick-updated', data => {
  currentTrick = data.currentTrick;
  renderTrick();
});

socket.on('round-end', data => {
  const winner = data.winner; // seat index
  const teamScores = data.teamScores;
  if (teamScores) {
    team0ScoreSpan.textContent = teamScores[0];
    team1ScoreSpan.textContent = teamScores[1];
  }
  if (winner !== null && winner !== undefined) {
    if (winner === mySeatIndex) {
      statusDiv.textContent = 'You won the trick!';
    } else {
      statusDiv.textContent = `Seat ${winner+1} won the trick.`;
    }
  }
});

socket.on('new-trick', data => {
  currentLeader = data.currentLeader;
  currentTrick = [];
  renderTrick();
  if (currentLeader === mySeatIndex) {
    statusDiv.textContent = 'Your turn to lead!';
  } else {
    statusDiv.textContent = `Seat ${currentLeader+1} leads.`;
  }
});

socket.on('game-over', data => {
  const winningTeam = data.winningTeam;
  if ((mySeatIndex % 2) === winningTeam) {
    statusDiv.textContent = 'Your team won! New game soon...';
  } else {
    statusDiv.textContent = 'Opponents won. New game soon...';
  }
});

// RENDER
function renderHand() {
  handArea.innerHTML = '';
  myHand.forEach(card => {
    const div = document.createElement('div');
    div.classList.add('card');

    const img = document.createElement('img');
    img.src = `cards/${card.value}_of_${card.suit}.png`;
    img.alt = `${card.value} of ${card.suit}`;

    div.appendChild(img);
    div.addEventListener('click', () => {
      playCard(card);
    });
    handArea.appendChild(div);
  });
}

function renderTrick() {
  trickContainer.innerHTML = '';
  currentTrick.forEach(entry => {
    const cdiv = document.createElement('div');
    cdiv.classList.add('played-card');

    const label = document.createElement('div');
    label.textContent = `${entry.username} (Seat ${entry.playerIndex+1})`;
    cdiv.appendChild(label);

    const img = document.createElement('img');
    img.src = `cards/${entry.card.value}_of_${entry.card.suit}.png`;
    img.alt = `${entry.card.value} of ${entry.card.suit}`;
    cdiv.appendChild(img);

    trickContainer.appendChild(cdiv);
  });
}

function clearTrick() {
  trickContainer.innerHTML = '';
}

// PLAY A CARD
function playCard(card) {
  if (!myHand.length) return;
  // check turn
  const seatTurn = (currentLeader + currentTrick.length) % 4;
  if (mySeatIndex !== seatTurn) {
    alert('Not your turn!');
    return;
  }
  socket.emit('card-played', { roomName, card });
  // remove locally
  myHand = myHand.filter(c => !(c.suit===card.suit && c.value===card.value));
  renderHand();
}
