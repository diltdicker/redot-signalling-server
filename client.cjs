// const { range } = require('bb26');
const WebSocket = require('ws');
console.log("testing client")

var ws = new WebSocket("ws://localhost:8080");
var ws = new WebSocket(url);

console.log('test')

let connList = []

for (let i = 0; i < 500; i++) {
    let conn = new WebSocket(url)
    connList.push(conn)
}

ws.onmessage = function (event) {
    console.log(event)
};