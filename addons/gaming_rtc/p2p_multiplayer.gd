## PeerToPeerClient
##
## Custom node for setting up WebRTC multiplayer with Redot-Signalling-Server.
##
## @author diltdicker
## @license MIT
extends  Node

class_name PeerToPeerClient

## Signal informing that all multiplayer peers are connected and the game is ready to start.
signal game_start

## Signal informing that the connection to the websocket server has been created
signal socket_connected

## Signal informing that the connection to the web socket server was disconnected.
signal socket_disconnected(code: int, reason: String)

## Signal informing that client has started hosted a lobby (will not be emitted for queues)
signal hosting_lobby(lobby_code: String)

## Signal informing that the client was kicked from the lobby
signal kicked_from_lobby

## Signal informing that the client has hosted or joined a lobby (will be emitted for queues)
signal joined_lobby(lobby_code: String)

## Signal informing that a new peer has joined the lobby
signal peer_joined_lobby(id: int)

## Signal informing that a peer successfully connected to the multiplayer
signal peer_connected(id: int)

## Signal informing that a peer was disconnected from the multiplayer
signal peer_disconnected(id: int)

## Signal informing that peer las left the lobby
signal peer_left_lobby(id: int)

## Signal with data containing lobby details
signal view_lobby_details(details_list: Array)

## Signal with server error data
signal socket_error(err_code: int, err_message: String)

enum _PROTOCOL {ID, HOST, JOIN, QUEUE, VIEW, ADD, KICK, OFFER, ANSWER, CANDIDATE, READY, START, ERR}

## Specific game name profile for creating lobbies (in case server hosts mutliple different games).
@export var game_name: String = ''

## Preference for peer to peer game hosting connection
@export var use_mesh: bool = true

@onready var _websocket: WebSocketPeer = WebSocketPeer.new()

## status of connection to websocket server
var websocket_connected: bool = false

## status of if client is lobby/game host
var is_host: bool = false

## unique multiplayer id 
var multiplayer_id: int = -1

var _host_connection_cnt: int = 0

var _is_in_lobby: bool = false

var _old_state: WebSocketPeer.State = WebSocketPeer.STATE_CLOSED

## Godot High-level multiplayer API
@onready var multiplayer_client: WebRTCMultiplayerPeer = WebRTCMultiplayerPeer.new()


func _ready() -> void:
	multiplayer_client.connect("peer_connected", _peer_was_connected)
	multiplayer_client.connect("peer_disconnected", _peer_was_disconnected)


func _process(_delta: float) -> void:
	_websocket.poll()
	var state = _websocket.get_ready_state()
	if state != _old_state and state == WebSocketPeer.STATE_OPEN:
		emit_signal("socket_connected")
	while state == WebSocketPeer.STATE_OPEN and _websocket.get_available_packet_count():
		_handle_packets(_websocket.get_packet().get_string_from_utf8())
	if state != _old_state and state == WebSocketPeer.STATE_CLOSED:
		emit_signal("socket_disconnected", _websocket.get_close_code(), _websocket.get_close_reason())
		_is_in_lobby = false
	_old_state = state


## Initiates connection to websocket server.
## [param url]: should be prefixed with either ws:// or wss:// depending on how server is configured.
func connect_to_server(url: String):
	if websocket_connected:
		push_warning('already connected to websocket server')
	if !websocket_connected:
		var err = _websocket.connect_to_url(url)
		if err != OK: # not reliable, make sure your URL is correct
			push_error("unable to connect to websocket")

## Disconnect all multiplayer connections
func end_multiplayer():
	multiplayer.multiplayer_peer = null
	multiplayer_client = WebRTCMultiplayerPeer.new()
	multiplayer_client.connect("peer_connected", _peer_was_connected)
	multiplayer_client.connect("peer_disconnected", _peer_was_disconnected)


## manually disconnects from websocket server
func disconnect_from_server() -> void:
	_websocket.close()
	websocket_connected = false


func _send_packets(protocol: int, data: Dictionary) -> void:
	_websocket.send_text(JSON.stringify({"call": protocol, "data": data}))


func _handle_packets(raw_message: String) -> void:
	var message: Dictionary = JSON.parse_string(raw_message)
	var protocol: int = message['call']
	var data: Dictionary = message['data']
	
	if protocol == _PROTOCOL.ID:
		websocket_connected = true
		if game_name == '':
			push_error("game_name not setup for server")
		assert(!game_name == '')
		_send_packets(_PROTOCOL.ID, {"game": game_name})
		
	elif protocol == _PROTOCOL.HOST:
		multiplayer_id = data['id']
		_is_in_lobby = true
		is_host = true
		_host_connection_cnt = 0
		if (data['isMesh']):
			multiplayer_client.create_mesh(data['id'])
		else:
			multiplayer_client.create_server()
		multiplayer.multiplayer_peer = multiplayer_client
		emit_signal("hosting_lobby", data['lobbyCode'])
		
	elif protocol == _PROTOCOL.JOIN:
		multiplayer_id = data['id']
		_is_in_lobby = true
		is_host = false
		if (data['isMesh']):
			multiplayer_client.create_mesh(data['id'])
		else:
			multiplayer_client.create_client(data['id'])
		multiplayer.multiplayer_peer = multiplayer_client
		emit_signal("joined_lobby", data['lobbyCode'])
		
	elif protocol == _PROTOCOL.QUEUE:
		multiplayer_id = data['id']
		_is_in_lobby = true
		if data['isHost']:
			is_host = true
			_host_connection_cnt = 0
		if (data['isMesh']):
			multiplayer_client.create_mesh(data['id'])
		elif data['isHost']:
			multiplayer_client.create_server(data['id'])
		else:
			multiplayer_client.create_client(data['id'])
		multiplayer.multiplayer_peer = multiplayer_client
		emit_signal("joined_lobby", data['lobbyCode'])
		
	elif protocol == _PROTOCOL.VIEW:
		emit_signal("view_lobby_details", data)
		
	elif protocol == _PROTOCOL.ADD:
		var peerId: int = data['peerId']
		if peerId != multiplayer_id:
			var rtc_conn: WebRTCPeerConnection = WebRTCPeerConnection.new()
			rtc_conn.initialize({
				"iceServers": [
					{ "urls": "stun:stun.relay.metered.ca:80"}
				]
			})
			rtc_conn.session_description_created.connect(self._offer_created.bind(peerId))
			rtc_conn.ice_candidate_created.connect(self._new_ice_candidate.bind(peerId))
			multiplayer_client.add_peer(rtc_conn, peerId)
			if multiplayer_id != 1: # So lobby creator never creates offers.
				rtc_conn.create_offer()
			emit_signal("peer_joined_lobby", peerId)
		
	elif protocol == _PROTOCOL.KICK:
		if multiplayer_client.get_unique_id() == data['id'] or !data['lobbyAlive']:
			emit_signal("kicked_from_lobby")
		else:
			multiplayer_client.remove_peer(data['id'])
			emit_signal("peer_left_lobby", data['id'])
		
	elif protocol == _PROTOCOL.OFFER:
		_offer_received(data['fromId'], data['offer'])
		
	elif protocol == _PROTOCOL.ANSWER:
		_answer_received(data['fromId'], data['answer'])
		
	elif protocol == _PROTOCOL.CANDIDATE:
		_candidate_received(data['fromId'], data['media'], data['index'], data['sdp'])
		
	elif protocol == _PROTOCOL.READY:
		if is_host:
			if data['status'] == 'ready':
				_host_connection_cnt += 1
			else:
				_send_packets(_PROTOCOL.READY, data)
			if _host_connection_cnt == multiplayer_client.get_peers().size():
				_send_packets(_PROTOCOL.START, {})
				
		else:
			var p_cnt = multiplayer_client.get_peers().size()
			var c_cnt = 0
			for p in multiplayer_client.get_peers():
				if multiplayer_client.get_peer(p)['connected']:
					c_cnt += 1
			if p_cnt == c_cnt:
				_send_packets(_PROTOCOL.READY, {"peerCount": p_cnt, "id": multiplayer_id, "status": "ready"})
			else:
				_send_packets(_PROTOCOL.READY, {"peerCount": p_cnt, "id": multiplayer_id, "status": "not_ready"})
			
			
	elif protocol == _PROTOCOL.START:
		_is_in_lobby = false
		emit_signal("game_start")
		
	elif protocol == _PROTOCOL.ERR:
		push_warning("recieved error from server: %s" % str(data))
		emit_signal("socket_error", data['code'], data['reason'])
		
	else:
		push_warning("unrecognized socket server PROTOCOL: %d" % protocol)


## Method to leave lobby, but stay connected to websocket.
## Use before switching to a different lobby
func leave_lobby() -> void:
	if _is_in_lobby:
		_send_packets(_PROTOCOL.KICK, {"id": multiplayer_id})
		_is_in_lobby = false
	else:
		push_warning('not currently in lobby')


## Method to initiate hosting a lobby for multiplayer
## [param lobby_coe]: lobby code to join game
func join_lobby(lobby_code: String) -> void:
	if not websocket_connected:
		push_error('not connected to websocket server, use: "connect_to_server()"')
	assert(websocket_connected)
	if not _is_in_lobby:
		_send_packets(_PROTOCOL.JOIN, {"game": game_name, "lobbyCode": lobby_code.to_upper()})
	else:
		push_error('already in a lobby, use: "leave_lobby()" before trying to join a new lobby')


## Method to initiate hosting a lobby for multiplayer
func host_lobby(max_peers: int, is_public: bool) -> void:
	if not websocket_connected:
		push_error('not connected to websocket server, use: "connect_to_server()"')
	assert(websocket_connected)
	if not _is_in_lobby:
		_send_packets(_PROTOCOL.HOST, {"game": game_name, "maxPeers": max_peers, "isMesh": use_mesh, "isPublic": is_public})
	else:
		push_error('already in a lobby, use: "leave_lobby()" before trying to host a new lobby')


## Method to initiate joining a game queue, will only join queues with matching tags
func join_queue(max_peers: int, tags: String) -> void:
	if not websocket_connected:
		push_error('not connected to websocket server, use: "connect_to_server():')
	assert(websocket_connected)
	if not _is_in_lobby:
		_send_packets(_PROTOCOL.QUEUE, {"game": game_name, "maxPeers": max_peers, "tags": tags, "isMesh": use_mesh})
	else:
		push_error('already in a lobby, use: "leave_lobby()" before trying to join a queue')


## method for getting details on all public lobbies for game -> will emit response as signal
func view_lobbies() -> void:
	if not websocket_connected:
		push_error('not connected to websocket server, use: "connect_to_server()"')
	assert(websocket_connected)
	_send_packets(_PROTOCOL.VIEW, {"game": game_name})


## method for getting lobby details -> will emit response as signal
## [param] lobby id code
func view_lobby(lobby_code: String) -> void:
	if not websocket_connected:
		push_error('not connected to websocket server, use: connect_to_server()')
	assert(websocket_connected)
	_send_packets(_PROTOCOL.VIEW, {"game": game_name, "lobbyCode": lobby_code.to_upper()})


## method to initiate as host the game start -> will emit signal to confirm all clients are ready
func start_game():
	if !is_host:
		push_warning('not lobby host, will do nothing')
	else:
		_send_packets(_PROTOCOL.READY, {})


func _offer_created(type, data, toId: int):
	multiplayer_client.get_peer(toId).connection.set_local_description(type, data)
	if type == "offer": 
		_send_packets(_PROTOCOL.OFFER, {"offer": data, "toId": toId})
	else: 
		_send_packets(_PROTOCOL.ANSWER, {"answer": data, "toId": toId})


func _new_ice_candidate(media, index, sdp, toId: int):
	_send_packets(_PROTOCOL.CANDIDATE, {"media": media, "index": index, "sdp": sdp, "toId": toId})


func _offer_received(fromId: int, offer):
	if multiplayer_client.has_peer(fromId):
		multiplayer_client.get_peer(fromId).connection.set_remote_description("offer", offer)


func _answer_received(fromId: int, answer):
	if multiplayer_client.has_peer(fromId):
		multiplayer_client.get_peer(fromId).connection.set_remote_description("answer", answer)


func _candidate_received(fromId: int, media, index: int, sdp):
	if multiplayer_client.has_peer(fromId):
		multiplayer_client.get_peer(fromId).connection.add_ice_candidate(media, index, sdp)

func _peer_was_connected(id: int):
	emit_signal("peer_connected", id)

func _peer_was_disconnected(id: int):
	emit_signal("peer_disconnected", id)
