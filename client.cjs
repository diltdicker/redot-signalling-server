const WebSocket = require('ws');
console.log("testing client")

var ws = new WebSocket("ws://cryptic-sierra-00220-d4f9a082c462.herokuapp.com");

ws.onmessage = function (event) {
    console.log(event)
};