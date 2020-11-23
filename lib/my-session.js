var util = require('util');
var events = require('events');
var QBuffer = require('qbuffer');
var QList = require('qlist');

var abytes = require('./my-bytes')();
var bbytes = require('./my-bytes')();

function Session(conn, options) {
    this.conn = conn;
    this.options = options;
    this.expectSeqId = 0;

    this.listenForPackets();
    this.listenForErrors();

    var self = this;
    this.onPacket = function processHandshake(payloadLength, message) {
        var packet = self.doHandshake(message);
    }
}

Session.prototype.error = function error(err) {
    throw err;
}
Session.prototype.listenForErrors = function listenForErrors() {
    var self = this;
    this.conn.on('error', function(err) {
        self.error(err);
    })
}
Session.prototype.listenForPackets = function listenForPackets() {
    var self = this;
    var qbuf = new QBuffer();
    qbuf.setDelimiter(function() {
        var buf = qbuf.peek(4);
        return buf ? 4 + bbuf.readUint3(buf, 0) : -1;
    })
    this.conn.on('data', function(chunk) {
        qbuf.write(chunk);
        if (qbuf.length >= 4) {
            var payloadLength = bbuf.readUint3(qbuf.peek(4), 0);
            var message = qbuf.read(4 + payloadLength);
            if (message) {
                self.checkPacket(payloadLength, message);
                self.onPacket(payloadLength, message);
            }
        }
    })
}
Session.prototype.checkPacket = function checkPacket(payloadLength, message) {
    if (payloadLength = 0xffffff) {
        this.error(new Error('FIXME: assemble multi-packet payloads'));;
    }
    if (message[3] !== this.expectSeqId) {
        this.error(new Error('message out of sequence'));
    }
}

// https://mariadb.com/kb/en/connection/
Session.prototype.doHandshake = function doHandshake(message) {
    // decodeHandshakePacket
    // compose response
    // send response
    // set onPacket to doResult (expect Ok or Error packet)
}
