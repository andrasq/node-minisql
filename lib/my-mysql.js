'use strict';

var util = require('util')
var net = require('net');
var crypto = require('crypto');
var utf8 = require('q-utf8');
var QBuffer = require('qbuffer');

var abytes = new Bytes(); // for arrays
var bbytes = new Bytes(); // for buffers

var allocBuf = eval('parseInt(process.versions.node) >= 6 ? Buffer.alloc : Buffer');
var fromBuf = eval('parseInt(process.versions.node) >= 6 ? Buffer.from : Buffer');

module.exports = {}

// ----------------------------------------------------------------

// packet manager
// packets have a 4-byte header: 3 bytes length, 1 byte sequence id.
// TODO: Length of 0xffffff indicates a multi-packet response longer than 2^24-2 bytes
function Packman( ) {
    this.packets = new Array()          // uncomsumed arrived packets 
    this.waitlist = new Array()         // callbacks waiting for a packet
    this.error = null
    this.qbuf = new QBuffer({ encoding: null })
    this._socket = null
}
Packman.prototype.connect = function connect( options, callback ) {
    var self = this, qbuf = this.qbuf, bbytes = new Bytes()
    this._socket = net.connect(options.port || 3306, options.host || '0.0.0.0')
    // socket: unref(), setNoDelay(), setTimeout(), allowHalfOpen()
    this._socket.setNoDelay(true)
    this._socket.on('data', function(chunk) {
        qbuf.write(chunk)
        var lenbuf, msgbuf
        while ((lenbuf = qbuf.peek(4)) && (msgbuf = qbuf.read(3 + 1 + bbytes.readUint3(lenbuf, 0)))) {
            if (self.waitlist.length) self.waitlist.shift()(null, msgbuf)
            else self.packets.push(msgbuf)
        }
    })
    this._socket.on('error', function(err) {
        self.error = self.error || err
    })
    this._socket.on('close', function() {
        self.error = self.error || _makeError('connection closed')
    })
    this._socket.once('connect', callback || function(){})
    return this._socket;
}
Packman.prototype.end = function end( ) {
    // note: does not disconnect unless a quit command was sent earlier
    this._socket.end()
}
var bbytes = new Bytes()
// wait for and return a message buffer, including length and sequence id
Packman.prototype.getPacket = function getPacket( callback ) {
    // TODO: combine payloads from packets whose payloads are 0xffffff bytes long (ie, whose .length === 0x1000003)
    // verify that oversize packets belong to same sequence by id
    for (var end=0; end<this.packets.length; end++) if (this.packets[end].length <= 0x1000002) break
    (end < this.packets.length) ? callback(null, this.packets.shift()) : this.error ? callback(this.error) : this.waitlist.push(callback)
}
// expects a message-length buffer, but computes own size
// maybe: support max_packet_size? currently 2^24-2
// maybe: pass in seqId instead of requiring it to be poked into buffer
Packman.prototype.sendPacket = function sendPacket( packet, seqId ) {
    if (!Buffer.isBuffer(packet)) packet = fromBuf(packet)
    var seqId = seqId !== undefined ? seqId : packet[3]
    while (packet.length - 4 >= 0xffffff) {
        this._socket.write(this._makeBuffer([255, 255, 255, seqId++]))
        this._socket.write(this._makeBuffer(packet.slice(4, 4 + 0xffffff)))
        packet = packet.slice(0xffffff)
    }
    bbytes.writeUint3(packet, packet.length - 4, 0)
    packet[3] = seqId
    this._socket.write(this._makeBuffer(packet))
}
Packman.prototype._makeBuffer = function _makeBuffer( a ) {
    return Buffer.isBuffer(a) ? a : fromBuf(a)
}
Packman.prototype = toStruct(Packman.prototype)

var packman = new Packman()
var conn = packman.connect({ port: 3306 })

// ----------------------------------------------------------------

function _makeQueryError( buf ) {
    var packet = decodeResponsePacket(buf)
    var err = Object.assign(_makeError('query error %d: %s', packet.error_code, packet.error_message),
        { errorCode: packet.error_code, errorMessage: buf.error_message })
    return (Error.captureStackTrace(err, _makeQueryError), err)
}

function _makeError( fmt ) {
    return new Error(util.format.apply(null, arguments))
}

// ----------------------------------------------------------------

function Db( ) {
    this.packman = new Packman()
}
// authenticate ourselves to the database server
// wait for the handshake packet to arrive and reply to it
Db.prototype.connect = function connect( creds, callback ) {
    var self = this
    if (!callback && typeof creds === 'function') { callback = creds; creds = {} }
    this.packman.connect(creds)
    this.packman.getPacket(function(err, buf) {
        if (err) return callback(err);
        var packet = decodeHandshakePacket(buf);
        // console.log("AR: got handshake packet", err,  packet);
        if (packet._seqId !== 0) return callback(_makeError('handshake sequence id %d not 0', packet._seqId));

        var response = encodeHandshakeResponse(1, packet, creds.user, creds.password, creds.database);
        self.packman.sendPacket(response, 1);

        self.packman.getPacket(function(err, buf) {
            if (err) return callback(err);
            // var reply = decodeResponsePacket(buf);
            // console.log("AR: got reply to our handshake response", reply);
            if (!isOkPacket(buf)) return callback(_makeError('expected OK packet in response to auth'));
            if (getPacketSeqId(buf) !== 2) return callback(_makeError('wrong sequence_id in auth OK packet'))
            callback();
        })
    })
}
Db.prototype.createConnection = Db.prototype.connect
// read packets until an EOF (or OK) packet is encountered
Db.prototype._getPacketsEof = function _getPacketsEof( handler, callback ) {
    var self = this;
    var packets = new Array();
    function _loop() {
        self.packman.getPacket(function(err, data) {
            if (err) return callback(err);
            if (isEofPacket(data) || isOkPacket(data)) return callback(null, packets);
            if (isErrorPacket(data)) return callback(_makeQueryError(data));
            if (!handler || handler(data)) packets.push(data);
            _loop();
        })
    }
    _loop();
}
Db.prototype.quit = function quit( callback ) {
    var quitCmd = composeQuit(0)
    this.packman.sendPacket(quitCmd, 0)
    this.packman.getPacket(function(err, buf) {
       // if quit succeeds it silently closes the connection
        callback(err || _makeQueryError(buf, _makeQueryError), buf)
    })
    packman.end()
}
Db.prototype.query = function query( query, callback ) {
    var self = this;
    var t1 = microtime();
    var queryCmd = composeQuery(query);
    this.packman.sendPacket(queryCmd, 0);
    this.packman.getPacket(function(err, buf) {
        switch (true) {
        case isOkPacket(buf):
            // query succeeded but returned no data
            return callback(null, decodeOkPacket(buf))
        case isEofPacket(buf):
            return callback(_makeError('unexpected EOF query response'))
        case isErrorPacket(buf):
            return callback(_makeQueryError(buf))
        case isLocalInfilePacket(buf):
            return callback(_makeError('LOCAL INFILE response not handled'))
        default:
            // query() succeeded (returned results)
            var packet = decodeResponsePacket(buf);
            var columnCount = packet.column_count;
            var packets = [];
            self._getPacketsEof(null, function(err, columnDefs) {
                if (err) return callback(err);
                if (columnDefs.length !== columnCount) {
                    return callback(_makeError('wrong column count: expected %d, got %d', columnCount, columnDefs.length))
                }
                var columnDecoders = new Array(columnCount);
                for (var i=0; i<columnDefs.length; i++) {
                    var col = decodeColumnDefinition41(columnDefs[i]);
                    var type;
                    columnDefs[i] = {
                        name: col.name,
                        type: type = col.column_type,
                        // table: col.table,
                        // decimals: col.decimals,
                    }
                    // NOTE: decodeRowValues uses bbytes, ie must decode with bbytes functions
                    columnDecoders[i] = (type >= 1 && type <= 5 || type === 9) ? bbytes.getNumberN
                        : (type >= 0xf9 && type <= 0xfc) ? bbytes.getBinaryN : bbytes.getStringN
                }
                self._getPacketsEof(null, function(err, rows) {
                    if (err) return callback(err);
                    for (var i=0; i<rows.length; i++) rows[i] = decodeRowValues(columnCount, rows[i], columnDecoders);
                    rows.columns = columnDefs;
                    rows.duration_ms = microtime() - t1;
                    return callback(null, rows);
                })
            })
        }
    })
}
Db.prototype = toStruct(Db.prototype)

// ----------------------------------------------------------------

/*
 * TEST: connect, authorize, make a warmup query, make a test query, loop test query.
 */
var db = new Db();
var t0 = microtime();
db.connect({ hostname: '0.0.0.0', 'port': 3306, user: 'andras', password: '', database: 'test' }, function(err) {
    var t1 = microtime();
    if (err) throw err;
console.log("AR: auth time (%d ms)", t1 - t0);

    // var sql = 'SELECT 1, "foo", NOW(), NOW()';
    var sql = 'SELECT * FROM queue';
    // 0.29 ms after 'SELECT 1', vs 0.45 mariadb, 0.50 mysql, 0.67 mysql2
    //var sql = 'SELECT * FROM information_schema.collations LIMIT 100;'
    // 1.16ms, vs 1.136 mariadb
    //var sql = 'SELECT * from test;'

console.log("AR: writig query");
    db.query('SELECT 1', function() {
        t1 = microtime();
        db.query(sql, function(err, rows) {
            var t2 = microtime();
console.log("AR: got the rows in (%d ms)", t2 - t1, rows);

            var durations = new Array();
            t2 = microtime();
            var ncalls = 0;
            (function _loop(cb) {
                if (ncalls++ > 10) return cb()
                db.query(sql, function(err, rows) {
                    if (err) throw err
                    durations.push(rows.duration_ms)
                    _loop(cb);
                })
            })(function() {
                var t3 = microtime()
console.log("AR: 10 queries of '%s' in total %d ms: %s", sql, t3 - t2, durations.join(', '));
                db.quit(function(err, buf) {
                    // COM_QUIT does not respond, we never call to here
console.log("AR: did quit", err, buf);
                })
            })
        })
    })
})


/* ---------------------------------------------------------------- */

// https://dev.mysql.com/doc/internals/en/status-flags.html#packet-Protocol::StatusFlags
var statusFlags = {
}

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

// https://dev.mysql.com/doc/internals/en/com-query-response.html#packet-ProtocolText::ResultsetRow
var myTypes = {
    // (type >= 0xf9 && type <= 0xfc) are blobs, extract as binary (DO: build row decoder per the column types)
    // (type >= 1 && type <= 5 || type === 9) are numeric, parseFloat
    // (type === 8) is LONGLONG which is not numeric (but is ascii, ie String.fromCharCode(...slice)
    // (type === 0x0f || type === 0xf7 || type === 0xfd || type === 0xfe) are text (varchar, enum, varstring, string)
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

function composeQuit(seqId) {
    // COM_QUIT is a fixed-length 1-byte command
    var cmdbuf = new Array(1, 0, 0, seqId, myCmds.COM_QUIT);
    return cmdbuf;
}

function composeQuery( query ) {
    if (query[query.length - 1] !== ';') {
        query = query.trim();
        if (query[query.length - 1] !== ';') query += ';';
    }

    var seqId = 0; // every query starts its own sequence
    var cmdbuf = new Array(0, 0, 0, seqId, myCmds.COM_QUERY);

    abytes.open(cmdbuf, 5);
    abytes.putString(query);
//    abytes.writeUint3(cmdbuf, abytes.tell() - 4, 0);
    // packet length and sequence id are added by packman.sendPacket,
    // which also splits overlong queries into 2^24-1 byte packets
    return cmdbuf;
}

function generateAuthResponse(auth1, auth2, pw) {
    // judging by other implementations, the no-password case is handed with a 0-length auth response
    if (!pw) return allocBuf(0)

    // trim the NUL byte off the end of the challenge seed, use only the first 20 bytes
    // algo is SHA1( password ) XOR SHA1( "20-bytes random data from server" <concat> SHA1( SHA1( password ) ) )
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
    abytes.putUint4(0xfffffe)   // max packet we will send
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
    case myHeaders.EOF: return decodeEofPacket(data)
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
    return (data[0] === 5 && data[1] === 0 && data[2] === 0 && data[4] === myHeaders.EOF);
}
function isOkPacket(data) {
    return (data[0] === 7 && data[1] === 0 && data[2] === 0 && data[4] === myHeaders.OK);
}
function isLocalInfilePacket(data) {
    // LOCAL INFILE request, followed by filename
    return data[3] === myHeaders.LOCAL;
}
function isErrorPacket(data) {
    return (data[4] === myHeaders.ERROR && !(data[5] === 0xff && data[6] === 0xff));
}
function decodeEofPacket(data) {
    bbytes.open(data, 3);
    return {
        _seqId: bbytes.getUint1(),
        _type: 'EOF',
        header: bbytes.getUint1(),
        warnings: bbytes.getUint2(),
        status_flags: bbytes.getUint2(),
    }
}

// column types: https://dev.mysql.com/doc/internals/en/com-query-response.html#column-type
// column definition packet: https://dev.mysql.com/doc/internals/en/com-query-response.html#column-definition
function decodeColumnDefinition41(data) {
    bbytes.open(data, 3);
    return {
// FIXME: yikes, a lot of rubbish!
// NOTE: the 320 protocol is much simpler, maybe avoid the 41?
// NOTE: ...or just skip the column definitions?
        _seqId: bbytes.getUint1(),
        catalog: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        schema: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        table: bbytes.getStringN(bbytes.getLenenc()),
        org_table: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        name: bbytes.getStringN(bbytes.getLenenc()),
        org_name: bbytes.skipN(bbytes.getLenenc()), // bbytes.getStringN(bbytes.getLenenc()),
        next_length: bbytes.getLenenc(),
        character_set: bbytes.getUint2(),
        column_length: bbytes.getUint4(),
        column_type: bbytes.getUint1(),
        flags: bbytes.getUint2(),
        decimals: bbytes.getUint1(),
    }
}

function decodeTextResultsetPacket(data) {
    bbytes.open(data, 3);
    return {
        _seqId: bbytes.getUint1(),
        _type: 'RESULTS',
        column_count: bbytes.getLenenc(),
    }
}

// decode into a user-presentable object
function decodeOkPacket(data) {
    bbytes.open(data, 3)
    return {
        _seqId: bbytes.getUint1(),
        _type: 'OK',
        header: bbytes.getUint1(),
        affectedRows: bbytes.getLenenc(),
        lastInsertId: bbytes.getLenenc(),
        serverStatus: bbytes.getUint2(),
        warningCount: bbytes.getUint2(),
        info: bbytes.getStringN(data.length - bbytes.tell()),
    }
}

function decodeLocalInfilePacket(data) {
    bbytes.open(data, 3)
    return {
        _seqId: bbytes.getUint1(),
        _type: 'LOCAL',
        header: bbytes.getUint1(),
        filename: bbytes.getStringN(data.length - bbytes.tell()),
    }
}

// https://dev.mysql.com/doc/internals/en/packet-ERR_Packet.html
// sql_state is returned only if CLIENT_PROTOCOL_41 was set, which we always do
function decodeErrorPacket(data) {
    bbytes.open(data, 3)
    var sequence_id = bbytes.getUint1();
    var header = bbytes.getUint1();
    var errcode = bbytes.getUint2();

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
        var len = Math.max(12, packet.auth_plugin_data_len - 1 - 8)
        // note: documents total 20 chars, but passes a 21st terminating zero byte too
        packet.auth_plugin_data_part_2 = bbytes.getStringN(len)
        bbytes.getUint1() // skip the terminating NUL byte
        packet.auth_plugin_name = bbytes.getStringZ()
    }
    return packet
}


/*----------------------------------------------------------------
 * my-bytes.js
 *----------------------------------------------------------------*/

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
        getBinaryN: function(n) { return buf.slice(pos, pos += n) },
        getStringLenenc: function() { var len = bytes.getLenenc(); return len === null ? null : bytes.getStringN(len) },
        skipN: function(n) { pos += n },
        getLenenc: function() { var v1 = buf[pos++]; return (v1 <= 250) ? v1
            : (v1 === 251) ? null : (v1 === 252) ? bytes.getUint2()
            : (v1 === 253) ? bytes.getUint3() : (v1 === 254) ? bytes.getUint4() + bytes.getUint4() * 0x100000000 : NaN },
        getNumberN(n) { return parseFloat(bytes.getStringN(n)) },

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
