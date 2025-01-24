# Redot/Godot Signalling Server

## Websocket Protocols

```
0: ID: ([server] Initiates call. [user] Responds with game name (failure to respond will result in auto-disconnect))

1: HOST: ([user] Initiates call to host game. [server] Responds with peer id and lobby code)

2: JOIN: ([user] Initiates call to join a lobby. [server] Responds with peer id)

3: QUEUE: ([user] Initiates call to queue for a game. [server] Responds with peer id and lobby code)

4: VIEW: ([user] Initiates call to get details of lobby(s). [server] responds with lobby details and peer count)

5: ADD: ([server] Initiates call to inform user of new peer connection)

6: RM: ([server] Initiates call to inform user of peer disconnecting or lobby deletion)

7: OFFER: ([user] Initiates rtc offer to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)

8: ANSWER: ([user] Initiates rtc answer to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)

9: CANDIDATE: ([user] Initiates rtc candidate to be relayed to desired user in lobby. [server] Relays call to desired user tagging the sending user's peer id)

10: READY: ([server] Initiates call to host to confirm all user connections. [user] Initiates call to server to send READY call to host (in case of not a queued lobby)) 

11: START: ([user] Initiates call to server to disable lobby and close all user connections)

12: ERR: ([server] Initiates call to inform user of server error)

```