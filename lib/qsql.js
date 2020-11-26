/*
 * Simple MySQL driver.
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict';

module.exports = {
    Db: Db,
}

var util = require('util')
var net = require('net');
var crypto = require('crypto');
var utf8 = require('q-utf8');

var abytes = new Bytes(); // for arrays
var bbytes = new Bytes(); // for buffers

var allocBuf = eval('parseInt(process.versions.node) >= 6 ? Buffer.allocUnsafe : Buffer');
var fromBuf = eval('parseInt(process.versions.node) >= 6 ? Buffer.from : Buffer');

// ----------------------------------------------------------------

/*
 * mysql wire protocol packet assembler: each packet has 3-byte count, 1-byte seq id, and count bytes of payload
 * Response concatenator, write() chunks and get() full-length responses
 * Packet formats at https://dev.mysql.com/doc/internals/en/describing-packets.html
 */
function Packeteer() {
    this.bufs = []
    this.nbytes = 0
    this.write = function write( buf ) {
        if (this.bufs.length === 1 && this.bufs[0].length < 4) this.bufs[0] = Buffer.concat([this.bufs[0], buf])
        this.bufs.push(buf)
        this.nbytes += buf.length
    }
    this.get = function get( ) {
        if (this.nbytes < 4) return null
        var need = 4 + bbytes.readUint3(this.bufs[0], 0)
        if (this.nbytes < need) return null
        if (this.bufs[0].length === need) { this.nbytes -= need; return this.bufs.shift() } // common case of exactly one packet
        var msg = allocBuf(need)
        for (var n = 0, have = 0; need > 0; need -= n, have += n, this.nbytes -= n) {
            if (need >= this.bufs[0].length) { n = this.bufs.shift().copy(msg, have) }
            else { n = this.bufs[0].copy(msg, have, 0, need); this.bufs[0] = this.bufs[0].slice(need) }
        }
        return msg
    }
}

/*
 * Connection (Packet) Manager
 * all packets have a 4-byte header: 3 bytes length, 1 byte sequence id.
 */
function Packman( ) {
    this.packets = new Array()          // uncomsumed arrived packets 
    this.waitlist = new Array()         // callbacks waiting for a packet
    this.error = null
    this.packeteer = new Packeteer()
    this._socket = null
}
Packman.prototype.connect = function connect( options, callback ) {
    var self = this, bbytes = new Bytes()
    this._socket = net.connect(options.port || 3306, options.host || '0.0.0.0')
    // socket: unref(), setNoDelay(), setTimeout(), allowHalfOpen()
    this._socket.setNoDelay(true)       // assume localnet use, do not wait for more data before sending
    this.packeteer = new Packeteer()
    this._socket.on('data', function(chunk) {
        self.packeteer.write(chunk)
        var msgbuf, response
        while ((msgbuf = self.packeteer.get())) {
            self.packets.push(msgbuf)
            if (self.waitlist.length && (response = self._getResponse())) {
                (self.waitlist.shift())(null, response)
            }
        }
    })
    this._socket.on('error', function(err) {
        self.error = self.error || err
    })
    this._socket.on('close', function() {
        self.error = self.error || _makeError('connection closed')
        // TODO: if options.reconnect ...
    })
    this._socket.once('connect', callback || function(){})
    return this._socket;
}
Packman.prototype.end = function end( ) {
    // note: does not disconnect unless a quit command was sent earlier
    this._socket.end()
}
Packman.prototype._getResponse = function _getResponse( ) {
    // return the response, contained in one or more arrived packets
    // Chunks are up to 64kb, pacets up to 16mb, responses potentially much longer (1gb or more)

    // special-case single-packet responses, else locate final packet of response message
    if (this.packets.length && this.packets[0].length < 4 + 0xffffff) return this.packets.shift()
    for (var end=0; end<this.packets.length && this.packets[end].length >= 4 + 0xffffff; end++) ;
    if (end >= this.packets.length) return null // final packet not arrived yet

    // extract the response from multiple packets, `end` count starting at offset `0`
    var packets = this.packets.splice(0, end + 1)
    for (var i=1; i<packets.length; i++) {
        if (packets[i][3] !== packets[i-1][3] + 1) throw _makeError('packets %d,%d out of order: %d, %d', i-1, i, packets[i-1][3], packets[i][3])
    }
    // combine the packets to form the response
    for (var i=1; i<packets.length; i++) packets[i] = packets[i].slice(4)
    return Buffer.concat.call(Buffer, packets)
}
var bbytes = new Bytes()
Packman.prototype.getPacket = function getPacket( callback ) {
    // wait for and return a message buffer, including length and sequence id
    var packet = this._getResponse()
    packet ? callback(null, packet) : this.waitlist.push(callback)
}
Packman.prototype.sendPacket = function sendPacket( packet, seqId ) {
    // send a message to the server, fragmenting into smaller packets as needed
    if (!Buffer.isBuffer(packet)) packet = fromBuf(packet)
    var seqId = seqId !== undefined ? seqId : packet[3]
    var dataOffset = 4;
    if (packet.length > 4 + 0xfffffe) {
        while (packet.length - dataOffset >= 0xffffff) {
            this._socket.write(fromBuf([255, 255, 255, seqId++]))
            this._socket.write(packet.slice(dataOffset, dataOffset + 0xffffff))
            dataOffset += 0xffffff
        }
        var tmpbuf = fromBuf([0, 0, 0, 0])
        bbytes.writeUint3(tmpbuf, packet.length - dataOffset, 0)
        tmpbuf[3] = seqId++
        this._socket.write(tmpbuf)
        this._socket.write(packet.slice(dataOffset))
    } else {
        bbytes.writeUint3(packet, packet.length - 4, 0)
        packet[3] = seqId++
        this._socket.write(packet)
    }
    return seqId
}
Packman.prototype = toStruct(Packman.prototype)

// ----------------------------------------------------------------

/*
 * Database Session
 * Exposes an interfact for talking to the database.
 */
function Db( ) {
    // TODO: keep array of connections, use first available
    // TODO: Mutex to acquire/release connections, w parametric isFree()
    this.packman = new Packman()
}
// authenticate ourselves to the database server
// wait for the handshake packet to arrive and reply to it
Db.prototype.connect = function connect( creds, callback ) {
    var self = this
    if (!callback && typeof creds === 'function') { callback = creds; creds = {} }
    if (!callback) throw _makeError('callback required')
    if (!creds.user) throw _makeError('creds user required')
    this.packman.connect(creds)
    this.packman.getPacket(function(never, buf) {
        var packet = decodeHandshakePacket(buf);
        // console.log("AR: got handshake packet", err,  packet);
        if (packet._seqId !== 0) return callback(_makeError('handshake sequence id %d not 0', packet._seqId));

        var response = encodeHandshakeResponse(1, packet, creds.user, creds.password, creds.database);
        self.packman.sendPacket(response, 1);

        self.packman.getPacket(function(never, buf) {
            // var reply = decodeResponsePacket(buf);
            // console.log("AR: got reply to our handshake response", reply);
            if (!isOkPacket(buf)) return callback(_makeError('expected OK packet in response to auth'));
            if (buf[3] !== 2) return callback(_makeError('wrong sequence_id %d in auth OK packet', buf[3]))
            callback();
        })
    })
}
Db.prototype.createConnection = Db.prototype.connect
// read packets until an EOF (or OK) packet is encountered
Db.prototype._getPacketsEof = function _getPacketsEof( handler, callback ) {
    var self = this;
    var packets = new Array();
    var err;
    function _loop() {
        self.packman.getPacket(function(never, data) {
            if (isEofPacket(data) || isOkPacket(data)) return callback(err, packets);
// FIXME: abandoning the read falls out of sync and breaks this db connection!
            if (isErrorPacket(data)) err = err || _makeQueryError(data);
            if (!handler || handler(data)) packets.push(data);
            _loop();
        })
    }
    _loop();
}
Db.prototype.quit = function quit( callback ) {
    var quitCmd = composeQuit()
    this.packman.sendPacket(quitCmd, 0)
    this.packman.getPacket(function(never, buf) {
       // if quit succeeds it silently closes the connection
        callback(_makeQueryError(buf, _makeQueryError), buf)
    })
    this.packman.end()
}
Db.prototype.query = function query( query, callback ) {
    var self = this;
    var t1 = microtime();
    var queryCmd = composeQuery(query);
    this.packman.sendPacket(queryCmd, 0);

    // expected response: ERROR, else packets with: col count, N col defs, EOF, row values, EOF
    this.packman.getPacket(function(never, buf) {
// TODO: return only documented, guaranteed properties eg lastInsertId and affectedRows
// TODO: separate query() and execute() calls, for better typing of the expected results
        if (buf[4] === myHeaders.OK && isOkPacket(buf)) return callback(null, decodeOkPacket(buf)) // success but no data
        if (buf[4] === myHeaders.EOF && isEofPacket(buf)) return callback(_makeError('unexpected EOF query response'))
        if (buf[4] === myHeaders.ERROR && isErrorPacket(buf)) return callback(_makeQueryError(buf))
        if (buf[4] === myHeaders.LOCAL && isLocalInfilePacket(buf)) return callback(_makeError('LOCAL INFILE response not handled'))

        // else the query succeeded and returned results
        var columnCount = decodeResponsePacket(buf).column_count;
        self._getPacketsEof(null, function(err, columnDefs) {
            if (err) return callback(err);
            var columnDecoders = new Array(columnCount);
            for (var i=0; i<columnDefs.length; i++) {
                var col = decodeColumnDefinition41(columnDefs[i]);
                columnDefs[i] = { name: col.name, type: col.column_type } // table: col.table, decimals: col.decimals
                var type = columnDefs[i].type
                if (!columnDefs[i].type) return callback(_makeError('bad column defs: column %d has no type', i+1))
                columnDecoders[i] = (type >= 1 && type <= 5 || type === 9) ? bbytes.getNumberN
                    : (type >= 0xf9 && type <= 0xfc) ? bbytes.getBinaryN : bbytes.getStringN
            }
            var rows = new Array()
            function decodeRow(rowbuf) { rows.push(decodeRowValues(columnCount, rowbuf, columnDecoders)) }
            self._getPacketsEof(decodeRow, function(err, rowbufs) {
                if (err) return callback(err);
                rows.duration_ms = microtime() - t1;
                rows.columns = columnDefs;
                return callback(null, rows);
            })
        })
    })
}
Db.prototype.end = function end( callback ) {
    this.quit(function(){})
    this.packman.end()
    callback()
}
Db.prototype = toStruct(Db.prototype)

// ----------------------------------------------------------------

/*
 * MySQL and MariaDB manifest constants.
 */

// https://dev.mysql.com/doc/internals/en/capability-flags.html#packet-Protocol::CapabilityFlags
// Native::4.1 auth: return (sha1(password) XOR sha1("20-bytes random data from server" <concat> sha1(sha1(password))))
var myCaps = {
    CLIENT_LONG_PASSWORD:       0x00000001,     // use the improved version of the Old Password Authentication (insecure)
    CLIENT_CONNECT_WITH_DB:     0x00000008,     // connect to db as part of handshake
    CLIENT_COMPRESS:            0x00000020,     // supports compression
    CLIENT_LOCAL_FILES:         0x00000080,     // allow LOAD DATA LOCAL INFILE
    CLIENT_PROTOCOL_41:         0x00000200,     // supports the 4.1 protocol
    CLIENT_INTERACTIVE:         0x00000400,     // wait_timeout vs wait_timeout_interactive
    CLIENT_SECURE_CONNECTION:   0x00008000,     // supports Native::4.1 authentication
    CLIENT_PLUGIN_AUTH:         0x00080000,
    CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA:
                                0x00200000,     // understands length-byte counted auth response data
    CLIENT_DEPRECATE_EOF:       0x01000000,     // do not send EOF packets
}

// string commands: https://dev.mysql.com/doc/internals/en/command-phase.html
// command starts with a 4-byte little-endian command length
var myCmds = {
    COM_SLEEP:          0x00,
    COM_QUIT:           0x01,
    COM_QUERY:          0x03,   // 
    COM_FIELD_LIST:     0x04,   // column definitions of a table
    COM_PING:           0x0e,
    COM_TIME:           0x0f,
    COM_SET_OPTION:     0x1b,
}

// data[4] values for various packet types ([3b len][1b seq][1b header, then rest of payload])
var myHeaders = {
    OK:                 0x00,   // OK packet
    EOF:                0xFE,   // EOF packet
    LOCAL:              0xFB,   // LOCAL INFILE request
    ERROR:              0xFF,   // Error packet
    // other values are the count of columns in the result set
}

// https://dev.mysql.com/doc/internals/en/status-flags.html#packet-Protocol::StatusFlags
var statusFlags = {
}

// https://dev.mysql.com/doc/internals/en/com-query-response.html#packet-ProtocolText::ResultsetRow
var myTypes = {
    // (type >= 0xf9 && type <= 0xfc) are blobs, extract as binary (DO: build row decoder per the column types)
    // (type >= 1 && type <= 5 || type === 9) are numeric, parseFloat
    // (type === 8) is LONGLONG which could be numeric (but would be safer as ascii), the default for manifest integers '1'
    // (type === 0x0f || type === 0xf7 || type === 0xfd || type === 0xfe) are text (varchar, enum, varstring, string)
    // (type === 0xF6) is type NEWDECIMAL, the default for manifest floats '2.5'
}

// lenenc : length encoded integer: 1, 3, 4 or 9 bytes:
// 00-fb 8-bit int, immed, fc.00.00-fc.ff.ff 16-bit int, fd.00.00.00-fd-ff.ff.ff 24-bit int, fe.[8 bytes] 4, 8-byte int
// (up to mysql 3.22 fe was followed by 4 bytes, not 8)
// First byte of packet may be a length-encoded integer specifying its length!

// https://dev.mysql.com/doc/internals/en/mysql-packet.html
// packet layout: ??? [packet: [3-byte length][1 byte sequence id][payload]]
// command payload: [cmd_code eg 03 "query"][query string to payload end]
// if the payload is 0xffffff bytes long or longer, the payload is split into multiple packets until one size is < 2^24-1
// (ie, packet length [ff ff ff] indicates a multi-packet payload that must be recovered from multiple packets)

// ----------------------------------------------------------------

/*
 * Database communication protocol, encoding and decoding packets.
 */

function composeQuit() {
    // COM_QUIT is a fixed-length 1-byte command
    var cmdbuf = new Array(1, 0, 0, 0, myCmds.COM_QUIT);
    return cmdbuf;
}

function composeQuery( query ) {
    // query length is computed and added by packman.sendPacket
    var cmdbuf = new Array(0, 0, 0, 0, myCmds.COM_QUERY);

    abytes.open(cmdbuf, 5);
    abytes.putString(query);
    return cmdbuf;
}

function generateAuthResponse(auth1, auth2, pw) {
    // the no-password case is handled with a 0-length auth response
    if (!pw) return allocBuf(0)

    // 4.1 auth hash is SHA1( password ) XOR SHA1( "20-bytes random data from server" <concat> SHA1( SHA1( password ) ) )
    var ret = xorBytes(sha1(pw), sha1(auth1, auth2, sha1(sha1(pw))))
    return ret

    function sha1(/* VARARGS */) { var sha = crypto.createHash('SHA1');
        for (var i=0; i<arguments.length; i++) sha.update(arguments[i]); return sha.digest() }
    function xorBytes(dst, src) {
        for (var i = 0; i < src.length; i++) dst[i] ^= src[i]; return dst }

}
function encodeHandshakeResponse( sequenceId, packet, username, pw, dbname ) {
    // handshake response: https://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::HandshakeResponse
    var authResponse = generateAuthResponse(packet.auth_plugin_data_part_1, packet.auth_plugin_data_part_2, pw)

    var clientCapabilities =
        myCaps.CLIENT_PROTOCOL_41 |
        myCaps.CLIENT_SECURE_CONNECTION |
        myCaps.CLIENT_PLUGIN_AUTH |
        (dbname ? myCaps.CLIENT_CONNECT_WITH_DB : 0) |
        0;

    var buf = new Array(0, 0, 0, sequenceId)
    abytes.open(buf, 4)
    abytes.putUint4(clientCapabilities),
    abytes.putUint4(0xffffff)    // max_packet_size: max packet we might send, including 4 header bytes (FIXME: what should this be?)
    abytes.putUint1(33)         // select id from information_schema.collations where character_set_name = 'utf8' (dflt 33; latin1 default is 8)
    abytes.fillN(0, 23)
    abytes.putStringZ(username)
    abytes.putUint1(authResponse.length)        // Native::4.1 auth response byte count, if not using lenenc
    abytes.putBinary(authResponse)              // 20 byte response to the 20 byte challenge
    dbname ? abytes.putStringZ(dbname) : 0      // USE `dbname`
    abytes.putStringZ('mysql_native_password')  // authentication method
//    abytes.writeUint3(buf, abytes.tell() - 4, 0)
//console.log("AR: generated handshake response %d: [%s]", buf.length, hexdump(buf))
//console.log("AR: handshake response packet is", decodeHandshakeResponsePacket(buf));

    return buf
}

// https://mariadb.com/kb/en/connection/#handshake-response-packet
function decodeHandshakeResponsePacket(data) {
    abytes.open(data, 3);
    return {
        _seqId: abytes.getUint1(),
        capabilities: abytes.getUint4(),
        max_packet_size: abytes.getUint4(),
        collation: abytes.getUint1(),
        skip: abytes.getBinaryN(23),
        username: abytes.getStringZ(),
        auth_resp_len: abytes.getUint1(),
        auth_resp: hexdump(abytes.getBinaryN(data[abytes.tell() - 1])),
        dbname: abytes.getStringZ(),
        auth_method: abytes.getStringZ(),
    }
}

function decodeResponsePacket( data ) {
    switch (data[4]) {
    case myHeaders.ERROR: return decodeErrorPacket(data)
    case myHeaders.OK: return decodeOkPacket(data)
    case myHeaders.EOF:
        // FE could be either EOF packet or length-encoded 8-byte-length row data
        // an EOF packet payload is [1+(2+2)?] <= 5 bytes, an 8-byte lenenc packet is [1+8] >= 9 bytes
        (bbytes.readUint3(data, 0) >= 9) ? decodeTextResultsetPacket(data) : decodeEofPacket(data)
    case myHeaders.LOCAL: return decodeLocalInfilePacket(data)
    default: return decodeTextResultsetPacket(data)
    }
}

function decodeRowValues(n, data, decoders) {
    var values = new Array();
    bbytes.open(data, 4);
    for (var i=0; i<n; i++) {
        var len = bbytes.getLenenc();
        len === null ? values.push(null) : values.push(decoders[i](len));
    }
    return values;
}

function getPacketSeqId(data) {
    return data[3];
}
function isEofPacket(data) {
    // an EOF packet payload is [1+(2+2)?] <= 5 bytes, an 8-byte lenenc packet is [1+8] >= 9 bytes
    return (data[4] === myHeaders.EOF && data[0] < 9 && data[1] === 0 && data[2] === 0);
}
function isOkPacket(data) {
    return (data[4] === myHeaders.OK);
}
function isLocalInfilePacket(data) {
    // LOCAL INFILE request, followed by filename
    // This request is send upon a LOAD DATA LOCAL INFILE command, and the
    // expected response is the _as_is_ file contents, split into packets, followed by an empty packet.
    // On empty file or read error just the empty packet is sent.
    return data[4] === myHeaders.LOCAL;
}
function isErrorPacket(data) {
    return (data[4] === myHeaders.ERROR && !(data[5] === 0xff && data[6] === 0xff));
}
function decodeEofPacket(data) {
    bbytes.open(data, 5);
    return {
        _seqId: data[3],
        _type: 'EOF',
        header: data[4],
        // warnings: bbytes.getUint2(),
        // status_flags: bbytes.getUint2(),
    }
}

// column types: https://dev.mysql.com/doc/internals/en/com-query-response.html#column-type
// column definition packet: https://dev.mysql.com/doc/internals/en/com-query-response.html#column-definition
function decodeColumnDefinition41(data) {
    // this response contains a lot of stuff, we extract things we might care about
    bbytes.open(data, 4);
    return {
        _seqId: data[3],
        catalog: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        schema: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        table: bbytes.getStringN(bbytes.getLenenc()),
        org_table: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        name: bbytes.getStringN(bbytes.getLenenc()),
        org_name: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        next_length: bbytes.getLenenc(),
        _skip: bbytes.skipN(6),
        // character_set: bbytes.getUint2(),
        // column_length: bbytes.getUint4(),
        column_type: bbytes.getUint1(),
        // flags: bbytes.getUint2(),
        // decimals: bbytes.getUint1(),
    }
}

function decodeTextResultsetPacket(data) {
    bbytes.open(data, 4);
    return {
        _seqId: data[3],
        _type: 'RESULTS',
        column_count: bbytes.getLenenc(),
    }
}

// decode into a user-presentable object
function decodeOkPacket(data) {
    bbytes.open(data, 5)
    return {
        _seqId: data[3],
        _type: 'OK',
        header: data[4],
        affectedRows: bbytes.getLenenc(),
        lastInsertId: bbytes.getLenenc(),
        serverStatus: bbytes.getUint2(),
        warningCount: bbytes.getUint2(),
        info: bbytes.getStringN(data.length - bbytes.tell()),
    }
}

function decodeLocalInfilePacket(data) {
    bbytes.open(data, 5)
    return {
        _seqId: data[3],
        _type: 'LOCAL',
        header: data[4],
        filename: bbytes.getStringN(data.length - bbytes.tell()),
    }
}

// https://dev.mysql.com/doc/internals/en/packet-ERR_Packet.html
// sql_state is returned only if CLIENT_PROTOCOL_41 was set, which we always do
function decodeErrorPacket(data) {
    bbytes.open(data, 5)
    var sequence_id = data[3]
    var header = data[4]
    var errcode = bbytes.getUint2()

    if (errcode === 0xffff) return { // progress reporting
        _seqId: sequence_id,
        _type: 'ERROR_PROGRESS',
        header: header,
        error_code: errcode,
        stage: bbytes.getUint1(),
        max_stage: bbytes.getUint1(),
        progress: bbytes.getUint3(),
        progress_info: bbytes.getStringN(bbytes.getLenenc()),
    }
    else return { // error response
        _seqId: sequence_id,
        _type: 'ERROR',
        header: header,
        error_code: errcode,
        sql_state_marker: bbytes.getStringN(1),
        sql_state: bbytes.getStringN(5),
        error_message: bbytes.getStringN(data.length - bbytes.tell()),
    }
}

// see eg https://mariadb.com/kb/en/connection/#initial-handshake-packet
function decodeHandshakePacket(data) {
    bbytes.open(data, 3)
    var packet = {
        _seqId: bbytes.getUint1(),
        _type: 'HANDSHAKE',
        protocol_version: bbytes.getUint1(),
        server_version: bbytes.getStringZ(),
        connection_id: bbytes.getUint4(),
        auth_plugin_data_part_1: bbytes.getStringN(8),
        filler_1: bbytes.skipN(1),
        capability_flag_1: bbytes.getUint2(),
        character_set: bbytes.getUint1(),
        status_flags: bbytes.getUint2(),
        capability_flags_2: bbytes.getUint2(),
        auth_plugin_data_len: bbytes.getUint1(),
        filler_2: bbytes.getBinaryN(10),
        auth_plugin_data_part_2: null,
        auth_plugin_name: null,
    }
    var flags = packet.capability_flag_1 | packet.capability_flags_2 * 0x10000;
    if (flags & myCaps.CLIENT_SECURE_CONNECTION) {
        // note: docs say 20 chars but server sends a terminating NUL byte too
        // Ignore the NUL byte at the end of the challenge seed, use only the first 20 bytes.
        var len = Math.max(20 - 8, packet.auth_plugin_data_len - 1 - 8)
        packet.auth_plugin_data_part_2 = bbytes.getStringN(len)
        bbytes.skipN(1) // the terminating NUL byte, skip it
        packet.auth_plugin_name = bbytes.getStringZ()
    }
    return packet
}

// ----------------------------------------------------------------

/*
 * Raw byte i/o
 * Functions for reading and writing buffers or arrays of charcodes.
 */
function Bytes(buf) {
    buf = buf || [];
    var pos = 0;

    var bytes = {
        open: function(_buf, _pos) { buf = _buf; pos = _pos || 0 },
        seek: function(_pos) { pos = _pos },
        tell: function() { return pos },
        databuf: function() { return buf },

        readUint3: function(buf, pos) { return buf[pos++] + (buf[pos++] << 8) + (buf[pos] << 16) },
        writeUint3: function(buf, v, pos) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; buf[pos] = (v >>> 16) & 0xFF },

        putUint1: function(v) { buf[pos++] = v & 0xFF },
        putUint2: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF },
        putUint3: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; buf[pos++] = (v >>> 16) & 0xFF },
        putUint4: function(v) { bytes.putUint2(v); bytes.putUint2(v >>> 16) },
        putString: function(str) { pos = writeString(buf, pos, str) },
        putStringZ: function(str) { bytes.putString(str); buf[pos++] = 0 },
        putBinary: function(src) { for (var i=0; i<src.length; i++) buf[pos++] = src[i] },
        fillN: function(v, n) { for (var i=0; i<n; i++) buf[pos++] = v },

        getUint1: function() { return buf[pos++] },
        getUint2: function() { return buf[pos++] + (buf[pos++] << 8) },
        getUint3: function() { return buf[pos++] + (buf[pos++] << 8) + (buf[pos++] << 16) },
        getUint4: function() { return bytes.getUint2() + bytes.getUint2() * 0x10000 },
        getStringN: function(n) { return readString(buf, pos, pos += n) },
        getStringZ: function() { var base = pos; while (buf[pos]) pos++; return readString(buf, base, pos++) },
// FIXME: send as hex, insert as UNHEX(?)
        getBinaryN: function(n) { return buf.slice(pos, pos += n) },
        getStringLenenc: function() { var len = bytes.getLenenc(); return len === null ? null : bytes.getStringN(len) },
        skipN: function(n) { pos += n },
        getLenenc: function() { var v1 = buf[pos++]; return (v1 <= 250) ? v1
            : (v1 === 251) ? null : (v1 === 252) ? bytes.getUint2()
            : (v1 === 253) ? bytes.getUint3() : (v1 === 254) ? bytes.getUint4() + bytes.getUint4() * 0x100000000 : NaN },
        getNumberN: function(n) { return parseFloat(bytes.getStringN(n)) },

        copyIn: function(src, base, bound) { while (base < bound) buf[pos++] = src[base++] },
        copyOut: function(dst, to, n) { for (var i=0; i<n; i++) dst[to+i] = buf[pos++] },
    }
    return bytes;

    function isAscii(str) { return !/[^\x01-0x7f]/.test(str) }
    function writeString(buf, pos, str) {
        // it is faster to utf8-encode than to isAscii/copyloop
        return utf8.utf8_encode(str, 0, str.length, buf, pos)
    }
    function readString(buf, fm, to) {
        return Buffer.isBuffer(buf) ? buf.toString('utf8', fm, to) : utf8.utf8_decode(buf, fm, to)
    }
}

// ----------------------------------------------------------------

/*
 * Utilities
 */
function _makeQueryError( buf ) {
    var packet = decodeResponsePacket(buf)
    Error.captureStackTrace(packet, _makeQueryError)
    return _makeError({ errorCode: packet.error_code, errorMessage: packet.error_message, stack: packet.stack },
        'query error %d: %s', packet.error_code, packet.error_message);
}
function _makeError( props, fmt ) {
    var args = [].slice.call(arguments);
    var err = new Error(util.format.apply(null, typeof args[0] === 'object' ? args.slice(1) : args))
    if (typeof args[0] === 'object') extractTo(err, args[0], args[0])
    return err
}
function extractTo(dst, src, mask) {
    for (var k in mask) dst[k] = src[k]
    return dst
}

function hexdump(buf, fm, to) {
    fm = fm || 0;
    to = to || buf.length;
    return buf.slice(fm, to).map(function(ch) { return pad2x(ch) }).join(' ');
}
function pad2x(n) {
    return n < 16 ? '0' + n.toString(16) : n.toString(16);
}

function microtime() {
    var ms = process.hrtime();
    return ms[0] * 1000 + ms[1] / 1e6;
}

function toStruct( hash ) { return toStruct.prototype = hash }
