# Redot/Godot Signalling Server

<img src="addons/gaming_rtc/gaming_rtc_icon.svg" alt="GamingRTC" width="150"/>

## Features

Signalling server features: hosting multiple different game profiles,
private lobbies, public lobbies, and automatic queues for multiplayer.

## Instructions:

Run `server.js` on hosted platform (e.g. heroku) and note the web address.

In Godot/Redot copy the `addons` folder to project directory and enable the plugin.
Use the custom node `PeerToPeerMultiplayer` to setup your RTC connections. Url to
hosted socket server should begin with either prefix `ws://` or `wss://` depending on how
your hosted server is configured.


## Websocket Protocols

```
0: ID: ([server] Initiates call. [user] Responds with game name (failure to respond will result in auto-disconnect))

1: HOST: ([user] Initiates call to host game. [server] Responds with peer id and lobby code)

2: JOIN: ([user] Initiates call to join a lobby. [server] Responds with peer id)

3: QUEUE: ([user] Initiates call to queue for a game. [server] Responds with peer id and lobby code)

4: VIEW: ([user] Initiates call to get details of lobby(s). [server] responds with lobby details and peer count)

5: ADD: ([server] Initiates call to inform user of new peer connection)

6: KICK: ([server] Initiates call to inform user of peer disconnecting or lobby deletion)

7: OFFER: ([user] Initiates rtc offer to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)

8: ANSWER: ([user] Initiates rtc answer to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)

9: CANDIDATE: ([user] Initiates rtc candidate to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)

10: READY: ([server] Initiates call to host to confirm all user connections. [user] Initiates call to server to send READY call to host (in case of not a queued lobby)) 

11: START: ([user] Initiates call to server to disable lobby and close all user connections. [server] Relays call to all peers (including host) to simultaneously start game, server then closes all connections)

12: ERR: ([server] Initiates call to inform user of server error)

```
