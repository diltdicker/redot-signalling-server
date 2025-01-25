import { WebSocketServer } from 'ws';
import log from 'loglevel';
import {toBb26, toDecimal} from 'bb26';

// SETUP LOGGING FORMAT AND LEVEL
let originalFactory = log.methodFactory;
log.methodFactory = function (methodName, logLevel, loggerName) {
    var rawMethod = originalFactory(methodName, logLevel, loggerName);

    return function (message) {
        rawMethod(`${new Date().toISOString()} ${methodName.toUpperCase()} ${message}`);
    };
};
log.rebuild()
const IS_PROD = process.env.NODE_ENV === 'production'
log.setLevel( IS_PROD ? log.levels.INFO : log.levels.DEBUG)

// CONSTANTS
const PORT = process.env.PORT || 8080;
const SERVER = new WebSocketServer({ port: PORT});
const PING_INTERVAL = 10000; // web socket ping for all connected clients every 10s
const MEM_CHECK_INTERVAL = 1_000 * 60 * 2   // nodejs memory usage logs every 2 minutes
const MAX_CONNS = 4096;     // maximum number of simultaneous connections to server

// MODIFIABLES
let CUR_PEER_CNT = 0;   // CURRENT PEER COUNT (connection count)
let LOBBIES_LIST = [];

// WEB SOCKET SERVER PROTOCOLS:
const PROTO = {
    ID: 0,      // ID: ([server] Initiates call. [user] Responds with game name (failure to respond will result in auto-disconnect))
    HOST: 1,    // HOST: ([user] Initiates call to host game. [server] Responds with peer id and lobby code)
    JOIN: 2,    // JOIN: ([user] Initiates call to join a lobby. [server] Responds with peer id)
    QUEUE: 3,   // QUEUE: ([user] Initiates call to queue for a game. [server] Responds with peer id and lobby code)
    VIEW: 4,    // VIEW: ([user] Initiates call to get details of lobby(s). [server] responds with lobby details and peer count)
    ADD: 5,     // ADD: ([server] Initiates call to inform user of new peer connection)
    KICK: 6,    // RM: ([server] Initiates call to inform user of peer disconnecting or lobby deletion)
    OFFER: 7,   // OFFER: ([user] Initiates rtc offer to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)
    ANSWER: 8,  // ANSWER: ([user] Initiates rtc answer to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)
    CANDIDATE: 9,   // CANDIDATE: ([user] Initiates rtc candidate to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)
    READY: 10,  // READY: ([server] Initiates call to host to confirm all user connections. [user] Initiates call to server to send READY call to host (in case of not a queued lobby)) 
    START: 11,  // START: ([user] Initiates call to server to disable lobby and close all user connections)
    ERR: 12,    // ERR: ([server] Initiates call to inform user of server error)
}
// LOBBY TYPES
const LOBBY_TYPE = {
    PRIVATE: 0, // PRIVATE: not viewable without lobbyCode
    PUBLIC: 1,  // PUBLIC: always viewable
    QUEUE: 2,   // QUEUE: lobby type auto checks for when full and auto-starts
}

// ERROR CODES
const START_GAME = [1000, 'Closing peer connection to start game'];
const TOO_MANY_PEERS = [4029, 'Too many peers connected Server busy'];
const BAD_PROTO = [4005, 'Recieved invalid message with unknown protocol'];
const BAD_MESSAGE = [4022, 'Received bad message Unable to process'];
const LOBBY_NOT_FOUND = [4004, 'Lobby for given lobbyCode does not exist'];
const BAD_VIEW = [4000, 'Invalid message for viewing lobby'];
const BAD_HOST = [4006, 'Invalid message for hosting lobby'];
const BAD_JOIN = [4001, 'Invalid message for joining lobby'];
const BAD_QUEUE = [4010, 'Inavlid message for queueing'];
const IDLE_SOCKET_CONN = [4008, 'Idle socket connection for too long'];
const UNKNOWN_ERR = [4017, 'Unknown error'];
const UNKOWN_PEER = [4003, 'Unknown peer'];

/**
 * Generates a random lobby code
 * @returns 6 character string representing the lobby code
 */
function generateLobbyCode() {
    let randNum = Math.floor(Math.random() * (toDecimal('AAAAAAA') - toDecimal('AAAAAA')) - toDecimal('AAAAAA'));
    return toBb26(Math.abs(randNum));
}

function cancelTimeout(timeoutId) {
    if (timeoutId) {
        clearTimeout(timeoutId);
    }
}

function cancelInterval(intervalId) {
    if (intervalId) {
        clearInterval(intervalId);
    }
}

/**
 * 
 */
class Lobby {
    /**
     * @param {string} game 
     * @param {number} lobbyType 
     * @param {number} maxPeers 
     * @param {boolean} isMesh 
     * @param {string} tags 
     */
    constructor(game, lobbyType, maxPeers, isMesh, tags) {
        this.lobbyCode = generateLobbyCode();
        this.lobbyType = lobbyType;
        this.maxPeers = maxPeers;
        this.isMesh = isMesh;
        this.peerList = [];
        this.game = game;
        this.tags = tags;
        this.isActive = true;
        this.queueIntervalId = null

        if (this.lobbyType == LOBBY_TYPE.QUEUE) {
            this.queueIntervalId = setInterval(() => {
                if (this.maxPeers == this.peerList.length && this.isActive) {
                    let host = this.peerList.find((p) => p.isHost);
                    sendMessage(host.socket, PROTO.READY, {id: null, peerCount: null, status: null});  // tell host to check if everyone is ready to start
                }
            }, 1_000 * 10);     // check every 10 seconds if lobby is full and ready to start (queue type only)
        }

        this.lobbyTimeoutId = setTimeout(() => {
            this.peerList.forEach((p) => {
                p.lobby = null
                sendMessage(p.socket, PROTO.KICK, {id: host.lobbyId, lobbyAlive: false});   // server auto kicks all peers from lobby after 10 minutes
            });
            this.peerList = [];
            LOBBIES_LIST = LOBBIES_LIST.filter((l) => {l.lobbyCode === this.lobbyCode});
            log.info(`deleting idle lobby: ${this.lobbyCode}}`);
            cancelInterval(this.queueIntervalId);
        }, 1_000 * 60 * 10);

    }

    /**
     * 
     * @param {User} peer 
     */
    kickPeer(peer) {
        this.peerList = this.peerList.filter((p) => p.lobbyId != peer.lobbyId);
    }
}

/**
 * 
 */
class User {
    /**
     * @param {WebSocket} socket 
     */
    constructor(socket) {
        this.id = Math.floor(Math.random() * (2147483647 - 2) - 2);
        this.lobbyId = this.id;
        this.isHost = false;
        this.lobby = null;
        this.socket = socket;
        this.game = null;

        this.earlyTimeoutId = setTimeout(() => {
            if (this.game == null) {
                log.debug(`early timeout for peer: ${this.id}`);
                socket.close(...IDLE_SOCKET_CONN);
            }
        }, 1_000 * 10);         // auto-disconnect after 10 seconds

        this.longTimeoutId = setTimeout(() => { 
            log.debug(`long timeout for peer: ${this.id}`);
            this.socket.close(...IDLE_SOCKET_CONN);
        }, 1_000 * 60 * 30);    // auto-disconnect after 30 minutes
    }

}

/**
 * 
 * @param {WebSocket} socket 
 * @param {number} protocol 
 * @param {object} data 
 * @returns stringified 
 */
function sendMessage(socket, protocol, data = {}) {
    log.debug(`sending message | call: ${protocol}, data: ${JSON.stringify(data)}}`);
    socket.send(JSON.stringify({
        'call': protocol,
        'data': data
    }));
}


/**
 * 
 * @param {string} rawMessage 
 * @returns object containing message
 */
function unwrapMessage(rawMessage) {
    let json = null;
        try {
            json = JSON.parse(rawMessage);
        } catch (err) {
            log.error("unable to read message")
            return { protocol: -1, data: null};
        }
    return {
        protocol: typeof (json['call']) === 'number' ? Math.floor(json['call']) : -1,
        data: json['data'] || null,
    };
}

/**
 * 
 * @param {string} rawMessage 
 * @param {User} peer 
 */
function handleMessage(rawMessage, peer) {
    const {protocol, data} = unwrapMessage(rawMessage);

    if (protocol == PROTO.ID) {
        /**
         * 
         */
        const game = data['game'] || null;
        if (game == null) {
            peer.socket.close(...UNKOWN_PEER);
        } else {
            peer.game = game;
        }

    } else if (protocol == PROTO.HOST) {
        /**
         * 
         */
        const game = data['game'] || null;
        const lobbyType = data['isPublic'] ? LOBBY_TYPE.PUBLIC : LOBBY_TYPE.PRIVATE;
        const isMesh = data['isMesh'] || true;
        const maxPeers = typeof data['maxPeers'] === 'number' ? Math.floor(data['maxPeers']) : -1;
        const tags = data['tags'] || null;
        if (game == null || maxPeers == -1) {
            sendMessage(peer.socket, PROTO.ERR, {code: BAD_HOST[0], reason: BAD_HOST[1]});
        } else {
            peer.isHost = true;
            peer.lobbyId = 1;
            let lobby = new Lobby(game, lobbyType, maxPeers, isMesh, tags);
            lobby.peerList.push(peer);
            log.info(`lobby created: ${lobby.lobbyCode} for game: ${game}`);
            peer.lobby = lobby;
            LOBBIES_LIST.push(lobby);
            sendMessage(peer.socket, PROTO.HOST, {id: peer.lobbyId, lobbyCode: lobby.lobbyCode, isMesh: isMesh});
        }

    } else if (protocol == PROTO.JOIN) {
        /**
         * 
         */
        const game = data['game'] || null;
        const lobbyCode = data['lobbyCode'] || null;
        if (game == null || lobbyCode == null) {
            sendMessage(peer.socket, PROTO.ERR, {code: BAD_JOIN[0], reason: BAD_JOIN[1]});
        } else {
            let lobby = LOBBIES_LIST.find((l) => l.lobbyCode === lobbyCode && l.isActive && l.peerList.length < l.maxPeers) || null;
            if (lobby == null) {
                sendMessage(peer.socket, PROTO.ERR, {code: LOBBY_NOT_FOUND[0], reason: LOBBY_NOT_FOUND[1]});        // lobby not found
            } else {
                peer.isHost = false;
                peer.lobbyId = peer.id;
                peer.lobby = lobby;
                lobby.peerList.push(peer);
                log.info(peer.lobby.peerList.map(p => p.lobbyId));
                sendMessage(peer.socket, PROTO.JOIN, {id: peer.lobbyId, isMesh: lobby.isMesh, lobbyCode: lobby.lobbyCode});         // lobby found :)
                lobby.peerList.filter((p) => p.lobbyId != peer.lobbyId).forEach((p) => {
                    setImmediate(() => {    // setImmediate to provide a tiny delay & not hog the I/O
                        sendMessage(p.socket, PROTO.ADD, {peerId: peer.lobbyId});        // inform other peers of new user
                        sendMessage(peer.socket, PROTO.ADD, {peerId: p.lobbyId});        // inform new user of other peers
                    });
                });
            }
        }

    } else if (protocol == PROTO.QUEUE) {
        /**
         * 
         */
        const game = data['game'] || null;
        const maxPeers = typeof data['maxPeers'] === 'number' ? Math.floor(data['maxPeers']) : -1;
        const tags = data['tags'] || null;
        const isMesh = data['isMesh'] || true;
        if (game == null || maxPeers == -1) {
            sendMessage(peer.socket, PROTO.ERR, {code: BAD_QUEUE[0], reason: BAD_QUEUE[1]});
            return;
        }

        // CHECK IF LOBBY EXISTS
        let lobbyList = LOBBIES_LIST.filter((l) => l.game === game && 
            l.lobbyType == LOBBY_TYPE.QUEUE && l.isActive && l.maxPeers == maxPeers && l.tags === tags && l.peerList.length < l.maxPeers);

        if (lobbyList.length > 1) {     // Lobby Queue found :)
            peer.lobbyId = peer.id;
            peer.isHost = false;
            let lobby = lobbyList[0];
            peer.lobby = lobby;
            sendMessage(peer.socket, PROTO.QUEUE, {id: peer.lobbyId, isMesh: lobby.isMesh, lobbyCode: lobby.lobbyCode, isHost: peer.isHost});
            lobby.peerList.filter((p) => p.lobbyId != peer.lobbyId).forEach((p) => {

                setImmediate(() => {    // setImmediate to provide a tiny delay & not hog the I/O

                   sendMessage(p.socket, PROTO.ADD, {peerId: peer.lobbyId});        // inform other peers of new user
                   sendMessage(peer.socket, PROTO.ADD, {peerId: p.lobbyId});        // inform new user of other peers
                });
            });
        } else {        // Lobby Queue not found -> creating lobby
            peer.lobbyId = 1;
            peer.isHost = true;
            let lobby = new Lobby(game, LOBBY_TYPE.QUEUE, maxPeers, isMesh, tags);
            lobby.peerList.push(peer);
            log.info(`queue lobby created: ${lobby.lobbyCode} for game: ${game}`);

            sendMessage(peer.socket, PROTO.QUEUE, {id: peer.lobbyId, lobbyCode: lobby.lobbyCode, isMesh: isMesh, isHost: peer.isHost});
        }

    } else if (protocol == PROTO.VIEW) {
        /**
         * 
         */
        const lobbyCode = data['lobbyCode'] || null;
        const game = data['game'] || null;

        if (game == null) {
            sendMessage(peer.socket, PROTO.ERR, {code: BAD_VIEW[0], reason: BAD_VIEW[1]});
        }

        let lobbyList = [];
        if (lobbyCode != null) {
            lobbyList = LOBBIES_LIST.filter((l) => l.lobbyCode == lobbyCode);
        } else {
            lobbyList = LOBBIES_LIST.filter((l) => game === l.game && l.isActive && l.peerList.length < l.maxPeers && l.lobbyType == LOBBY_TYPE.PUBLIC);
        }
        lobbyList = lobbyList.map((l) => {
            return {
                lobbyCode: l.lobbyCode,
                peerCount: l.peerList.length,
                isActive: l.isActive,
                lobbyType: l.lobbyType,
                maxPeers: l.maxPeers,
                tags: l.tags,
                isMesh: l.isMesh
            };
        });

        sendMessage(peer.socket, PROTO.VIEW, {lobbyList: lobbyList});
    
    } else if (protocol == PROTO.KICK) {
        /**
         * 
         */
        const id = data['id'] || null;
        if (id == null || peer.lobby == null) {
            sendMessage(peer.socket, PROTO.ERR, {code: BAD_MESSAGE[0], reason: BAD_MESSAGE[1]});
            return;
        }
        if (peer.lobbyId == id && peer.isHost) { // host is kicking themselves
            log.info(`peer: ${peer.id} has stopped hosting: ${lobby.lobbyCode} deleting lobby`);
            peer.lobby.kickPeer(peer);
            peer.lobby.peerList.forEach((p) => {
                setImmediate(() => {
                    sendMessage(p.socket, PROTO.KICK, {id: peer.lobbyId, lobbyAlive: false});
                    p.lobby = null;
                });
            });
            let lobby = peer.lobby;
            lobby.peerList = [];
            peer.lobby = null;
            LOBBIES_LIST = LOBBIES_LIST.filter((l) => l.lobbyCode != lobby.lobbyCode);      // delete lobby
            cancelInterval(lobby.queueIntervalId);
            cancelTimeout(lobby.timeoutId);

        } else if (peer.isHost && peer.lobbyId != id) { // host is kickig player
            let user = peer.lobby.find((p) => p.lobbyId == id) || null;
            if (user != null) {
                user.lobby.kickPeer(user);
                user.lobby.peerList.forEach((p) => {
                    setImmediate(() => {
                        sendMessage(p.socket, PROTO.KICK, {id: user.lobbyId, lobbyAlive: true});
                    });
                });
                let lobby = peer.lobby;
                lobby.peerList = lobby.peerList.filter((p) => p != user.lobbyId);   // remove player from lobbby
                user.lobby = null;
            }

        } else if (peer.lobbyId == id) {    // player is kicking themselves
            peer.lobby.kickPeer(peer);
            peer.lobby.peerList.forEach((p) => {
                setImmediate(() => {
                    sendMessage(p.socket, PROTO.KICK, {id: peer.lobbyId, lobbyAlive: true});
                });
            });
            let lobby = peer.lobby;
            lobby.peerList = lobby.peerList.filter((p) => p != peer.lobbyId);   // remove player from lobbby
            peer.lobby = null;
        }
    
    } else if (protocol == PROTO.OFFER || protocol == PROTO.ANSWER || protocol == PROTO.CANDIDATE) {
        /**
         * 
         */
        const toId = typeof data['toId'] === 'number' ? data['toId'] : null;
        const offer = data['offer'] || null;
        const answer = data['answer'] || null;
        const media = data['media'] || null;
        const index = typeof data['index'] === 'number' ? data['index'] : null;
        const sdp = data['sdp'] || null;
        if (toId == null) {
            sendMessage(peer.socket, PROTO.ERR, {code: BAD_MESSAGE[0], reason: BAD_MESSAGE[1]});
            return;
        }
        let toPeer = peer.lobby.peerList.find((p) => p.lobbyId == toId);

        if (protocol == PROTO.OFFER) {
            // OFFER
            sendMessage(toPeer.socket, protocol, {offer: offer, fromId: peer.lobbyId});
        } else if (protocol == PROTO.ANSWER) {
            // ANSWER
            sendMessage(toPeer.socket, protocol, {answer: answer, fromId: peer.lobbyId});
        } else {
            // CANDIDATE
            sendMessage(toPeer.socket, protocol, {media: media, index: index, sdp: sdp, fromId: peer.lobbyId});
        }
        
    
    } else if (protocol == PROTO.READY) {
        /**
         * 
         */
        if (peer.isHost) {    // if message is from host -> send to other peers
            peer.lobby.isActive = false;
            let id = data['id'] || null;
            if (id == null) {
                peer.lobby.peerList.filter((p) => !p.isHost).forEach((p) => {
                    setTimeout(() => {
                        sendMessage(p.socket, PROTO.READY, {id: p.lobbyId, peerCount: peer.lobby.peerList.length - 1, status: null});
                    }, 1_000);  // slight delay to allow user to finish connecting
                });
            } else {
                let latePeer = peer.lobby.peerList.find((p) => p.lobbyId == id);
                setTimeout(() => {
                    sendMessage(latePeer.socket, PROTO.READY, {id: latePeer.lobbyId, peerCount: peer.lobby.peerList.length - 1, status: null});
                }, 1_000);  // slight delay to allow user to finish connecting
            }
        } else {    // if message is from non-host -> send to host
            let host = peer.lobby.peerList.find((p) => p.isHost);
            sendMessage(host.socket, PROTO.READY, data);
        }
    
    } else if (protocol == PROTO.START) {
        /**
         * 
         */
        if (peer.isHost) {
            peer.lobby.isActive = false;
            peer.lobby.peerList.filter((p) => !p.isHost).forEach((p) => { // get all non-host peers
                sendMessage(p.socket, PROTO.START);
                setTimeout(() => {
                    p.socket.close(...START_GAME);
                }, 250);
            });
            sendMessage(peer.socket, PROTO.START);
            setTimeout(() => {
                peer.socket.close(...START_GAME);   // finally close host connection
            }, 250); 
        }
    
    } else {
        sendMessage(peer.socket, PROTO.ERR, {code: BAD_PROTO[0], reason: BAD_PROTO[1]});
    }
}

// RUN WEBSOCKET SERVER
log.info(`starting websocket server on port: ${PORT}`);
SERVER.on('connection', (socket) => { 
    // if too many users
    if (CUR_PEER_CNT >= MAX_CONNS) {
        sendMessage(socket, PROTO.ERR, {code: TOO_MANY_PEERS[0], reason: TOO_MANY_PEERS[1]});
        socket.close(...TOO_MANY_PEERS);
    }

    // on-connection server asks which game user has
    CUR_PEER_CNT++;
    let peer = new User(socket);
    log.info(`peer: ${peer.id} connected to server (${CUR_PEER_CNT}/${MAX_CONNS})`)
    sendMessage(peer.socket, PROTO.ID);

    socket.on('message', (rawData) => {
        log.debug(`recieved message from (${peer.id}): ${rawData}`)
        try{
            setImmediate(() => {
                handleMessage(rawData, peer);
            });
        } catch(err) {
            log.error(err);
        }
    });

    socket.on('close', (code, reason) => {
        /**
         * Memory Cleanup
         */
        CUR_PEER_CNT--;
        log.info(`peer: ${peer.id} disconnected from server [${code}]:${reason}`)
        cancelTimeout(peer.longTimeoutId);
        try {
            // logic for removing from lobbies
            if (peer.lobby != null && peer.lobby.isActive) {
                if (peer.isHost) {
                    // peer disconnect from lobby if host
                    
                    let peerList = peer.lobby.peerList;
                    let lobby = peer.lobby;
                    cancelInterval(lobby.queueIntervalId);
                    peer.lobby.peerList.forEach((p) => {p.lobby = null})
                    lobby.peerList = [];
                    LOBBIES_LIST = LOBBIES_LIST.filter((l) => {l.lobbyCode === lobby.lobbyCode});
                    log.info(`deleting lobby: ${lobby.lobbyCode}}`);
                    lobby = null;
                    peer.lobby = null;
                    peerList.forEach((p) => {
                        setImmediate(() => {
                            sendMessage(p.socket, PROTO.KICK, {id: p.lobbyId, lobbyAlive: false});
                        });
                    });
                } else {
                    // peer disconnect from lobby if not host

                    peer.lobby.peerList.forEach((p) => {
                        setImmediate(() => {
                            sendMessage(p.socket, PROTO.KICK, {id: peer.lobbyId, lobbyAlive: true});
                        });
                    });
                    let lobby = peer.lobby;
                    lobby.peerList = lobby.peerList.filter((p) => p != peer.lobbyId);
                    peer.lobby = null;
                    
                }
            } else if (peer.lobby != null && !peer.lobby.isActive && peer.isHost) {
                // host disconnects to start game
                let lobby = peer.lobby;
                cancelInterval(lobby.queueIntervalId);
                peer.lobby.peerList.forEach((p) => {p.lobby = null})
                lobby.peerList = [];
                LOBBIES_LIST = LOBBIES_LIST.filter((l) => {l.lobbyCode === lobby.lobbyCode});
                log.info(`deleting lobby: ${lobby.lobbyCode}}`);
                lobby = null;
                peer.lobby = null;
            }
        } catch(err) {
            log.error(err);
        }
        
    });

    socket.on('error', (err) => {
            log.error(err);
    });

});

let pingIntervalId = setInterval(() => {
    log.debug(`server ping with (${CUR_PEER_CNT}/${MAX_CONNS}) clients`);
    SERVER.clients.forEach((socket) => {
        socket.ping();
    });
}, PING_INTERVAL);

let memIntervalId = setInterval(() => {
    for (const [key,value] of Object.entries(process.memoryUsage())) {
        log.info(`Memory usage by ${key}, ${Math.floor(value/1_000)/1_000} MB`);    // log memory usage statistics
    }
}, MEM_CHECK_INTERVAL);