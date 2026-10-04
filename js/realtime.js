/* ============================================
   QuizApp — realtime layer
   --------------------------------------------
   Global multiplayer with no server of our own.

   GitHub Pages can only hand out static files, so it
   can't relay game traffic. Instead the HOST's browser
   acts as the server: players open a direct WebRTC
   connection to it and everything flows over that,
   phone-to-laptop, anywhere in the world.

   The one thing WebRTC can't do by itself is the
   introduction -- two browsers need to swap network
   details before they can find each other. PeerJS runs
   a free public broker for exactly that, so there's no
   account or API key. Once the handshake is done the
   broker is out of the picture.

   Everything below speaks in terms of rooms and players,
   so if this ever moves to a real backend, only this
   file changes.
   ============================================ */

const PEERJS_SRC =
  "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";

/* Room codes become PeerJS IDs, and those IDs are shared
   with every other project using the public broker. The
   prefix keeps us in our own corner so a stranger's room
   can never collide with ours. */
const ID_PREFIX = "quizapp-v1-";

/* No O/0/I/1 -- those get misread off a projector. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 5;

export const MAX_PLAYERS = 40;
export const MAX_NAME_LENGTH = 18;

/* --- loading PeerJS --- */

let peerLibrary = null;

function loadPeerJS() {
  if (peerLibrary) return peerLibrary;

  peerLibrary = new Promise((resolve, reject) => {
    if (window.Peer) return resolve(window.Peer);

    const script = document.createElement("script");
    script.src = PEERJS_SRC;
    script.onload = () =>
      window.Peer
        ? resolve(window.Peer)
        : reject(new Error("Couldn't start the connection library."));
    script.onerror = () =>
      reject(
        new Error("Couldn't reach the connection service. Are you online?")
      );
    document.head.appendChild(script);
  }).catch((error) => {
    peerLibrary = null; // let a later attempt retry
    throw error;
  });

  return peerLibrary;
}

/* --- codes and names --- */

export function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes]
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");
}

export function normalizeCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

export function validateCode(code) {
  if (code.length !== CODE_LENGTH) {
    return `Game codes are ${CODE_LENGTH} characters long.`;
  }
  if (![...code].every((character) => CODE_ALPHABET.includes(character))) {
    return "That isn't a valid game code.";
  }
  return null;
}

export function cleanName(raw) {
  // Collapse whitespace and drop control characters so nobody
  // can shove the lobby list around with their nickname.
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/* --- peer plumbing --- */

function peerErrorMessage(error) {
  switch (error?.type) {
    case "peer-unavailable":
      return "No game found with that code.";
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return "Lost contact with the connection service. Check your internet.";
    case "browser-incompatible":
      return "This browser can't run multiplayer games. Try Chrome or Safari.";
    case "unavailable-id":
      return "That game code is already in use.";
    case "webrtc":
      return "Couldn't open a direct connection. A strict network may be blocking it.";
    default:
      return "Something went wrong with the connection.";
  }
}

function newPeer(Peer, id) {
  return new Peer(id, {
    debug: 0,
    config: {
      /* Public STUN servers let each browser discover how it
         looks from the outside, which is what makes a direct
         connection across different networks possible. */
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
      ],
    },
  });
}

/* Resolves once the peer is registered with the broker. */
function peerReady(peer) {
  return new Promise((resolve, reject) => {
    if (peer.id && !peer.disconnected) return resolve(peer.id);

    const onOpen = (id) => {
      peer.off("error", onError);
      resolve(id);
    };
    const onError = (error) => {
      peer.off("open", onOpen);
      reject(error);
    };

    peer.once("open", onOpen);
    peer.once("error", onError);
  });
}

/* ============================================
   HOSTING
   ============================================ */

/**
 * Opens a room and starts accepting players.
 *
 * Handlers: onPlayersChange(players), onError(message),
 *           onConnectionLost(), onReconnected(), onMessage(player, data)
 *
 * Resolves with a room controller once the code is live.
 */
export async function hostRoom(handlers = {}) {
  const Peer = await loadPeerJS();

  let peer = null;
  let code = null;

  /* A code is only ours once the broker accepts the matching
     ID. If someone else holds it, roll another and retry. */
  for (let attempt = 0; attempt < 6 && !peer; attempt++) {
    const candidate = randomCode();
    const candidatePeer = newPeer(Peer, ID_PREFIX + candidate);

    try {
      await peerReady(candidatePeer);
      peer = candidatePeer;
      code = candidate;
    } catch (error) {
      candidatePeer.destroy();
      if (error?.type !== "unavailable-id") {
        throw new Error(peerErrorMessage(error));
      }
    }
  }

  if (!peer) {
    throw new Error("Couldn't find a free game code. Please try again.");
  }

  /* peerId -> { id, name, connection, joinedAt } */
  const players = new Map();
  let locked = false;
  let closed = false;

  const roster = () =>
    [...players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(({ id, name, joinedAt }) => ({ id, name, joinedAt }));

  function broadcast(message) {
    for (const player of players.values()) {
      if (player.connection.open) player.connection.send(message);
    }
  }

  function announceRoster() {
    const list = roster();
    broadcast({ t: "roster", players: list });
    handlers.onPlayersChange?.(list);
  }

  // Two players called "Sam" would be indistinguishable on the
  // host's screen, so the second one becomes "Sam (2)".
  function uniqueName(wanted) {
    const taken = new Set(
      [...players.values()].map((player) => player.name.toLowerCase())
    );
    if (!taken.has(wanted.toLowerCase())) return wanted;

    for (let suffix = 2; suffix < 100; suffix++) {
      const candidate = `${wanted} (${suffix})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
  }

  function turnAway(connection, reason) {
    if (connection.open) connection.send({ t: "rejected", reason });
    // Let the explanation leave before cutting the line.
    setTimeout(() => connection.close(), 300);
  }

  peer.on("connection", (connection) => {
    /* A player sends their nickname as the first message. Until
       then they aren't in the lobby, so a peer that connects
       and goes quiet never takes up a slot. */
    let player = null;

    const greetingTimer = setTimeout(() => {
      if (!player) connection.close();
    }, 10000);

    connection.on("data", (message) => {
      if (!message || typeof message !== "object") return;

      if (message.t === "hello") {
        if (player) return; // already in; ignore repeats
        clearTimeout(greetingTimer);

        if (closed || locked) {
          return turnAway(connection, "This game has already started.");
        }
        if (players.size >= MAX_PLAYERS) {
          return turnAway(connection, "This game is full.");
        }

        const name = cleanName(message.name);
        if (!name) {
          return turnAway(connection, "That nickname isn't allowed.");
        }

        player = {
          id: connection.peer,
          name: uniqueName(name),
          connection,
          joinedAt: Date.now(),
        };
        players.set(player.id, player);

        connection.send({ t: "accepted", id: player.id, name: player.name });
        announceRoster();
        return;
      }

      if (player) handlers.onMessage?.(player, message);
    });

    connection.on("close", () => {
      clearTimeout(greetingTimer);
      if (player && players.delete(player.id)) announceRoster();
    });

    connection.on("error", () => connection.close());
  });

  peer.on("error", (error) => {
    // One player failing to connect shouldn't tear down the
    // whole room, so only report what affects everyone.
    if (error?.type === "peer-unavailable") return;
    handlers.onError?.(peerErrorMessage(error));
  });

  peer.on("disconnected", () => {
    if (closed) return;
    /* We've lost the broker, which only stops NEW players from
       being introduced -- everyone already connected is
       unaffected, since their connections are direct. */
    handlers.onConnectionLost?.();
    try {
      peer.reconnect();
    } catch {
      /* destroyed in the meantime; nothing to do */
    }
  });

  peer.on("open", () => {
    if (!closed) handlers.onReconnected?.();
  });

  return {
    code,
    get players() {
      return roster();
    },
    get locked() {
      return locked;
    },

    /* Stops new players joining, for when a game starts. */
    lock() {
      locked = true;
    },
    unlock() {
      locked = false;
    },

    kick(id) {
      const player = players.get(id);
      if (!player) return;

      players.delete(id);
      if (player.connection.open) {
        player.connection.send({ t: "kicked" });
        setTimeout(() => player.connection.close(), 300);
      }
      announceRoster();
    },

    broadcast,

    close() {
      if (closed) return;
      closed = true;
      broadcast({ t: "ended" });
      setTimeout(() => peer.destroy(), 400);
    },
  };
}

/* ============================================
   JOINING
   ============================================ */

/**
 * Joins an existing room.
 *
 * Handlers: onRosterChange(players), onKicked(), onGameEnded(),
 *           onError(message), onMessage(data)
 *
 * Resolves once the host has accepted us; rejects with a
 * readable message if the code is wrong, the game is full,
 * or we can't get through.
 */
export async function joinRoom(rawCode, rawName, handlers = {}) {
  const code = normalizeCode(rawCode);
  const codeError = validateCode(code);
  if (codeError) throw new Error(codeError);

  const name = cleanName(rawName);
  if (!name) throw new Error("Please enter a nickname.");

  const Peer = await loadPeerJS();
  const peer = newPeer(Peer, undefined); // the broker assigns our id

  try {
    await peerReady(peer);
  } catch (error) {
    peer.destroy();
    throw new Error(peerErrorMessage(error));
  }

  const connection = peer.connect(ID_PREFIX + code, { reliable: true });

  /* Settles when the host accepts us, or on any of the ways
     joining can fail -- whichever happens first. After it has
     settled the same events become ordinary lobby updates. */
  /* Set once we're done with this connection for a reason we
     already know -- the player left, or the host kicked us or
     ended the game. Tearing down our own peer fires the same
     close event as the host vanishing, so without this the
     close handler would overwrite the real explanation with
     "the host ended the game". */
  let finished = false;

  const accepted = new Promise((resolve, reject) => {
    let settled = false;

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      fail("The host didn't respond. Is the game still open?");
      peer.destroy();
    }, 20000);

    connection.on("open", () => connection.send({ t: "hello", name }));

    connection.on("data", (message) => {
      if (!message || typeof message !== "object" || finished) return;

      switch (message.t) {
        case "accepted":
          clearTimeout(timer);
          return succeed({ id: message.id, name: message.name });

        case "rejected":
          clearTimeout(timer);
          finished = true;
          fail(message.reason || "The host turned you away.");
          return peer.destroy();

        case "roster":
          return handlers.onRosterChange?.(message.players || []);

        case "kicked":
          finished = true;
          handlers.onKicked?.();
          return peer.destroy();

        case "ended":
          finished = true;
          handlers.onGameEnded?.();
          return peer.destroy();

        default:
          return handlers.onMessage?.(message);
      }
    });

    connection.on("close", () => {
      clearTimeout(timer);
      if (finished) return;

      /* Before acceptance a close means we never got in; after
         it, the host's tab is gone. */
      const wasInLobby = settled;
      fail("No game found with that code.");
      if (wasInLobby) handlers.onGameEnded?.();
    });

    peer.on("error", (error) => {
      clearTimeout(timer);
      if (finished) return;

      const message = peerErrorMessage(error);
      const wasInLobby = settled;
      fail(message);
      if (wasInLobby) handlers.onError?.(message);
    });
  });

  try {
    const me = await accepted;

    return {
      code,
      me,
      send(message) {
        if (connection.open) connection.send(message);
      },
      leave() {
        finished = true;
        peer.destroy();
      },
    };
  } catch (error) {
    /* Never got in, so don't leave a half-open peer sitting on
       the broker. */
    finished = true;
    peer.destroy();
    throw error;
  }
}
