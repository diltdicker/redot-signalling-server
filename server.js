import { WebSocketServer } from 'ws';
import log from 'loglevel';
import {toBb26} from 'bb26';

// SETUP LOGGING
var originalFactory = log.methodFactory;
log.methodFactory = function (methodName, logLevel, loggerName) {
    var rawMethod = originalFactory(methodName, logLevel, loggerName);

    return function (message) {
        rawMethod(`${new Date().toISOString()} ${methodName.toUpperCase()} ${message}`);
    };
};
log.rebuild()
const IS_PROD = process.env.NODE_ENV === 'production'
log.setLevel( IS_PROD ? log.levels.WARN : log.levels.DEBUG)


const PORT = process.env.PORT || 8080;
const SERVER = new WebSocketServer({ port: PORT});
const PING_INTERVAL = 10000; // web socket ping for all connected clients every 10s
const MAX_CONNS = 4096;

// CURRENT PEER COUNT (connection count)
let CUR_PEER_CNT = 0;
let LOBBIES_LIST = [];

/**
 * To support:
 * [ ] WebRTC multiplayer (essential) max 8 players
 * [ ] matchmaking (queue)
 * [x] private lobby (friends)
 * [x] open lobbies (viewable lobbies) 
 * [x] different games for same signalling server (incompatible lobbies)
 */

// WEB SOCKET SERVER PROTOCOLS:
const PROTO = {
    GAME: 0,        // ws: server sends websocket id + request for game name; usr: sends game name
    HOST: 1,        // usr: sends lobby details(private | open, max players); ws: sends lobby code
    JOIN: 2,        // usr: sends lobby code; ws: sends aknowledgement
    QUEUE: 3,       // usr: sends; ws: sends hosting details | lobby code
    VIEW: 4,        // usr: sends game name; ws: sends list of open lobbies + current player counts
    PEER_ADD: 5,    // ws: sends to every peer for every new peer in lobby
    PEER_RM: 6,     // ws: sends to every peer in lobby; usr: sends to remove themselves from lobby (or to kick peer)
    OFFER: 7,
    ANSWER: 8,
    CANDIDATE: 9,
    SEAL: 10,       // usr: host sends; ws: sends to every peer in lobby
    ERR: 11,        // ws: sends error message
    START: 12,      // ws: sends to all peers to disconnect from ws to start game
};

// ERROR CODES
const START_GAME = [4000, 'Closing host connection to start game'];
const TOO_MANY_PEERS = [4001, 'Too many peers connected Server busy'];
const BAD_PROTO = [4002, 'Recieved message with unknown protocol'];
const BAD_MESSAGE = [4003, 'Received bad message Unable to process'];
const LOBBY_NOT_FOUND = [4004, 'Lobby for given lobbyCode does not exist'];
const INVALID_ID = [4005, 'Invalid RTC id for joining lobby'];
const BAD_OFFER = [4006, 'Invalid Offer for RTC connection'];
const BAD_ANSWER = [4007, 'Invalid Answer for RTC connection'];
const BAD_CANDIDATE = [4008, 'Invalid Candidate for RTC connection'];
const IDLE_SOCKET_CONN = [4009, 'Idle socket connection for too long'];
const UNKNOWN_ERR = [4010, 'Unknown error'];

class WebError extends Error {
    constructor (code, reason) {
        super(reason)
        this.code = code;
        this.reason = reason;
    }
}

class WebPeer {
    constructor (socket) {
        this.gameName = null;
        // this.webId = parseInt(`${Math.floor(new Date() % 100_000_000)}${Math.floor(Math.random() * 100_000)}`);
        this.webId = Math.floor(Math.random() * (2147483647 - 2) - 2);
        this.rtcId = null;
        this.isHost = false;
        this.lobby = null;
        this.socket = socket;

        setTimeout(() => { // auto disconnect after 30 seconds if request for game name is unmet
            if (this.gameName == null) {
                this.socket.close(...IDLE_SOCKET_CONN);
            }
        }, 1000 * 30);

        setTimeout(() => { // auto disconnect after 1 hour
            this.socket.close(...IDLE_SOCKET_CONN);
        }, 1000 * 60 * 60);
    }
}

class GameLobby {
    constructor (gameName, isOpen=false, isMesh=false, maxPeers=8, autoSeal=false, custom=null) {
        this.gameName = gameName;
        this.isOpen = isOpen;
        this.isSealed = false;
        this.lobbyCode = toBb26(Math.floor(Math.random() * (26**8 - 26**7)) - 26**7);  // random 8 letter code
        this.peerList = [];
        this.isMesh = isMesh;
        this.maxPeers = maxPeers;
        this.autoSeal = autoSeal;
        this.custom = custom;               // addtional field for creative usage
    }

    add_peer(peer) {
        if (this.peerList.length < this.maxPeers && this.peerList.filter((p) => p.webId == peer.webId).length == 0) {
            this.peerList.push(peer);
        }
    }

    rm_peer(peer) {
        this.peerList = this.peerList.filter((p) => p.webId != peer.webId);
    }

    
}

function packMessage(proto, data = {}) {
    log.debug(`packing message | proto: ${proto}, data: ${JSON.stringify(data)}}`);
    return JSON.stringify({
            'proto': proto,
            'data': data,
    });
}


/**
 * Function for handling all inputs to websocket server
 * 
 * @param {Object} rawData 
 * @param {WebPeer} peer 
 * @returns 
 */
function handleMessage(rawData, peer) {
    const {proto, data} = unpackMessage(rawData);
    log.debug(`handling message with proto: ${proto}`)

    if (proto < 0 || proto > 12) {
        // bad protocol
        throw new WebError(...BAD_PROTO);
    }

    if (proto == PROTO.GAME) {
        // add gameName to peer
        peer.gameName = data['gameName'] || null;
        return;
    }

    if (proto == PROTO.HOST) {
        // create new lobby
        log.debug("creating new lobby");
        const isOpen = data['isOpen'] || true;
        const isMesh = data['isMesh'] || false;
        const autoSeal = data['autoSeal'] || false;
        const maxPeers = data['maxPeers'] || 8;
        const custom = data['custom'] || null;
        peer.rtcId = 1;                             // default host id is 1
        peer.isHost = true;
        let lobby = new GameLobby(peer.gameName, isOpen, isMesh, maxPeers, autoSeal, custom);
        peer.lobby = lobby;
        log.debug(`lobby created: (${peer.lobby.lobbyCode})`);
        peer.lobby.add_peer(peer);
        peer.socket.send(packMessage(PROTO.HOST, {lobbyCode: peer.lobby.lobbyCode, maxPeers: peer.lobby.maxPeers, autoSeal: peer.lobby.autoSeal}));
        LOBBIES_LIST.push(peer.lobby);
        log.debug('lobbies: ', JSON.stringify(LOBBIES_LIST,(key, value) => key === 'peerList' ? value.map((p) => p.webId) : value));
        return;
    }

    if (proto == PROTO.JOIN) {
        // attempt to join a lobby
        peer.rtcId = peer.webId;
        peer.isHost = false;
        const lobbyCode = data['lobbyCode'] || null;
        let lobby = LOBBIES_LIST.find((l) => l.lobbyCode === lobbyCode && l.isSealed == false) || null;
        if (lobby != null) {
            peer.socket.send(packMessage(PROTO.JOIN, {success: true, rtcId: peer.rtcId, isMesh: lobby.isMesh}));
            peer.lobby = lobby;
            lobby.peerList.forEach((p) => {
                // message exisitng peer of new peer
                p.socket.send(packMessage(PROTO.PEER_ADD, {peerId: peer.rtcId}));

                // message new peer of existing peer
                peer.socket.send(packMessage(PROTO.PEER_ADD, {peerId: p.rtcId}));

            });
            lobby.add_peer(peer);
        } else {
            peer.socket.send(packMessage(PROTO.JOIN, {success: false}));
        }
        if (lobby.autoSeal && lobby.peerList.length == lobby.maxPeers) {
            setTimeout(() => {
                lobby.peerList.find((p) => p.isHost).socket.send(
                    packMessage(PROTO.SEAL, {rtcId: p.rtcId, status: 'ready'})      // for autoSeal, trigger host to start game if lobby is full
                );
            }, 1000 * 10);
        }
        return;
    }

    if (proto == PROTO.QUEUE) {
        // search for open lobby or host new lobby
        const isMesh = data['isMesh'] || false;
        const maxPeers = typeof data['maxPeers'] === 'number' ? data['maxPeers'] : null;
        if (maxPeers == null) {
            // bad request
        }
        // search for autosealing lobby with same maxPeers and matches isMesh

        // join

        // create new lobby

    }

    if (proto == PROTO.VIEW) {
        // list open lobbies
        const lobbyCode = data['lobbyCode'] || null;
        if (peer.lobby) {
            // get details for requested lobby
            let lobbyList = LOBBIES_LIST.filter(((lobby) => lobby.gameName === peer.gameName))
                .filter((lobby) => lobby.isOpen && !lobby.isSealed);
            lobbyList = lobbyList.map((lobby) => {
                return {
                    maxPeers: lobby.maxPeers,
                    lobbyCode: lobby.lobbyCode,
                    peerCount: lobby.peerList.length,
                    isMesh: lobby.isMesh,
                    autoSeal: lobby.autoSeal,
                    custom: lobby.custom,
                }
            });
            peer.socket.send(packMessage(PROTO.VIEW, {lobbyList: lobbyList}));
            return;

        } else {
            // List all open lobbies
            let lobbyList = LOBBIES_LIST.filter(((lobby) => lobby.gameName === peer.gameName))
                .filter((lobby) => lobby.isOpen && !lobby.isSealed);
            lobbyList = lobbyList.map((lobby) => {
                return {
                    maxPeers: lobby.maxPeers,
                    lobbyCode: lobby.lobbyCode,
                    peerCount: lobby.peerList.length,
                    isMesh: lobby.isMesh,
                    autoSeal: lobby.autoSeal,
                    custom: lobby.custom,
                }
            });
            peer.socket.send(packMessage(PROTO.VIEW, {lobbyList: lobbyList}));
            return;
        }
    }

    if (proto == PROTO.PEER_RM) {

    }
    
    if (proto == PROTO.OFFER) {
        const offer = data['offer'] || null;
        const rtcId = data['rtcId'] || null;
        if (offer == null || rtcId == null) {
            throw new WebError(...BAD_OFFER);
        }

        // relay offer to all peers in same lobby
        // peer.lobby.peerList.forEach((p) => {
        //     if (p.webId != peer.webId) {
        //         p.send(packMessage(PROTO.OFFER, {offer: offer, rtcId: peer.rtcId}))
        //     }
        // });
        peer.lobby.peerList.find((p) => p.rtcId == rtcId).socket.send(packMessage(PROTO.OFFER, {
            rtcId: rtcId,
            offer: offer,
        }));
        return;
    }

    if (proto == PROTO.ANSWER) {
        const answer = data['answer'] || null;
        const rtcId = data['rtcId'] || null;
        if (answer == null || rtcId == null) {
            throw new WebError(...BAD_ANSWER);
        }

        // relay answer to all peers in same lobby
        // peer.lobby.peerList.forEach((p) => {
        //     if (p.webId != peer.webId) {
        //         p.send(packMessage(PROTO.ANSWER, {answer: answer, rtcId: peer.rtcId}))
        //     }
        // });
        peer.lobby.peerList.find((p) => p.rtcId == rtcId).socket.send(packMessage(PROTO.ANSWER, {
            rtcId: rtcId,
            answer: answer,
        }));
        return;
    }

    if (proto == PROTO.CANDIDATE) {
        const media = data['media'] || null;
        const index = data['index'] || null;
        const sdp = data['sdp'] || null;
        const rtcId = data['rtcId'] || null;
        if (media == null || index == null || sdp == null || rtcId == null) {
            throw new WebError(...BAD_CANDIDATE);
        }

        // relay candidate to all peers in same lobby
        // peer.lobby.peerList.forEach((p) => {
        //     if (p.webId != peer.webId) {
        //         p.send(packMessage(PROTO.CANDIDATE, {
        //             rtcId: peer.rtcId,
        //             media: media,
        //             index: index,
        //             sdp: sdp,
        //         }));
        //     }
        // });
        peer.lobby.peerList.find((p) => p.rtcId == rtcId).socket.send(packMessage(PROTO.CANDIDATE, {
            rtcId: rtcId,
            media: media,
            index: index,
            sdp: sdp,
        }));
        return;
    }

    if (proto == PROTO.SEAL) {
        // relay SEAL protocol to all peers to respond with ready state
        if (peer.isHost && peer.lobby) {
            peer.lobby.isSealed = true;
            peer.lobby.peerList.forEach((p) => {
                if (p.webId != peer.webId) {
                    p.socket.send(packMessage(PROTO.SEAL))
                }
            });
        } else if (!peer.isHost && peer.lobby) {
            // forward all ready states from peers to lobby host
            peer.lobby.peerList.find((p) => p.isHost).socket.send(packMessage(PROTO.SEAL, data));
        }
    }

    if (proto == PROTO.START) {
        // disconnect host and all peers in lobby to start game + cleanup on server
        if (peer.isHost && peer.lobby.isSealed) {
            peer.socket.close(...START_GAME);
        }
    }
}

const unpackMessage = (rawData) => {
    let json = null;
        try {
            json = JSON.parse(rawData);
        } catch (err) {
            throw err;
        }
    return {
        proto: typeof (json['proto']) === 'number' ? Math.floor(json['proto']) : -1,
        data: json['data'] || null,
    };
}

// RUN WEBSOCKET SERVER
log.debug(`starting websocket server on port: ${PORT}`)
SERVER.on('connection', (socket) => {

    // if too many users
    if (CUR_PEER_CNT >= MAX_CONNS) {
        socket.close(...TOO_MANY_PEERS)
    }

    // on-connection server asks which game user has
    CUR_PEER_CNT++;
    let peer = new WebPeer(socket);
    log.debug(`peer: ${peer.webId} connected to server (${CUR_PEER_CNT}/${MAX_CONNS})`)
    socket.send(packMessage(PROTO.GAME))

    socket.on('message', (rawData) => {
        log.debug(`recieved message from (${peer.webId}): ${rawData}`)
        try{
            handleMessage(rawData, peer, socket);
        } catch(err) {
            log.error(err)
            if (err instanceof WebError) {
                peer.socket.send(packMessage(PROTO.ERR, {code: err.code, reason: err.reason}));
            }
            
        }
    });
    
    socket.on('close', (code, reason) => {
        CUR_PEER_CNT--;
        log.debug(`peer: ${peer.webId} disconnected from server [${code}]:${reason}`)

        // logic for removing from lobbies
        if (peer.lobby != null && !peer.lobby.isSealed) {
            if (peer.isHost) {
                // peer disconnect from lobby if host
                log.debug(`deleting lobby: (${peer.lobby.lobbyCode})`);
                let lobby = peer.lobby;
                peer.lobby.rm_peer(peer);
                peer.lobby.peerList.forEach((p) => {
                    p.socket.send(packMessage(PROTO.PEER_RM, {rtcId: peer.rtcId, lobbyAlive: false}));
                    p.lobby = null;
                });
                // delete lobby
                LOBBIES_LIST = LOBBIES_LIST.filter((l) => l.lobbyCode !== lobby.lobbyCode);
                lobby = null;
                log.debug('lobbies: ', JSON.stringify(LOBBIES_LIST,(key, value) => key === 'peerList' ? value.map((p) => p.webId) : value));

            } else {
                // peer disconnect from lobby if not host
                peer.lobby.rm_peer(peer);
                peer.lobby.peerList.forEach((p) => {
                    p.socket.send(packMessage(PROTO.PEER_RM, {rtcId: peer.rtcId, lobbyAlive: true}));
                });
            }
        } else if (peer.lobby != null && peer.lobby.isSealed && peer.isHost) {
            // host disconnecting to start game
            log.debug(`deleting lobby: (${peer.lobby.lobbyCode})`);
            let lobby = peer.lobby;
            peer.lobby.peerList.forEach((p) => {
                p.socket.send(packMessage(PROTO.START, {}));
                p.lobby = null;
            });
            // delete lobby
            LOBBIES_LIST = LOBBIES_LIST.filter((l) => l.lobbyCode !== lobby.lobbyCode);
            lobby = null;
            log.debug('lobbies: ', JSON.stringify(LOBBIES_LIST,(key, value) => key === 'peerList' ? value.map((p) => p.webId) : value));
        }
    });

    socket.on('error', (err) => {
        log.error(err)
        if (err instanceof WebError) {
            peer.send(packMessage(PROTO.ERR, {code: err.code, reason: err.reason}));
        }
    });
});

setInterval(() => {
    log.debug(`server ping with (${CUR_PEER_CNT}/${MAX_CONNS}) clients`);
    SERVER.clients.forEach((socket) => {
        socket.ping();
    });
}, PING_INTERVAL);