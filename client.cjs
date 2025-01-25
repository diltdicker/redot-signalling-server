const WebSocket = require('ws');
console.log("testing client")

var ws = new WebSocket("ws://localhost:8080");

ws.onmessage = function (event) {
    console.log(event)
};