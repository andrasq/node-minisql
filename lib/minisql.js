/*
 * Simple MySQL driver.
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 *
 * 2020-11-20 - AR.
 */

'use strict';

module.exports = {
    createConnection: function(options) { return new Db(options) },
    Db: Db,
}

var util = require('util')
var net = require('net');
var crypto = require('crypto');
var utf8 = require('q-utf8');
var utils = require('./utils')

// var setImmediate = global.setImmediate || function(fn, a, b) { process.nextTick(function() { fn(a, b) }) }
var abytes = new Bytes(); // for arrays
var bbytes = new Bytes(); // for buffers

// from `qibl`
var allocBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.allocUnsafe : Buffer');
var fromBuf = eval('parseInt(process.versions.node) > 9 ? Buffer.from : Buffer');

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
        // ensure that the first chunk contains the length + seq id + header bytes: 3b + 1b + 1b
        if (this.bufs.length === 1 && this.bufs[0].length < 5) this.bufs[0] = Buffer.concat([this.bufs[0], buf])
        else this.bufs.push(buf)
        this.nbytes += buf.length
    }
    this.get = function get( ) {
        if (this.nbytes < 5) return null
        var need = 4 + bbytes.readUint3(this.bufs[0], 0)
        if (this.bufs[0].length === need) { this.nbytes -= need; return this.bufs.shift() } // expected case
        if (this.nbytes < need) return null
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
    var self = this
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
        // FIXME: error out the waitlist with convertErrorToPacket
        // FIXME: need to terminate current packeteer message, error out listeners, push the error packet
    })
    this._socket.on('close', function() {
        self.error = self.error || _makeError('connection closed')
        // TODO: if options.reconnect ...
    })
    this._socket.once('connect', callback || function(){})
    return this._socket;
}
Packman.prototype.end = function end( callback ) {
    // note: does not disconnect unless a quit command was sent earlier
    callback = callback || function(){}
    this.error ? callback(this.error) : (this._socket.once('close', callback), this._socket.end())
}
Packman.prototype._getResponse = function _getResponse( ) {
    // return the response, contained in one or more arrived packets
    // Chunks are up to 64kb, pacets up to 16mb, responses potentially much longer (up to 1gb)

    // special-case single-packet responses, else locate final packet of response message
    if (this.packets.length && this.packets[0].length < 4 + 0xffffff) return this.packets.shift()
    for (var end=0; end<this.packets.length && this.packets[end].length >= 4 + 0xffffff; end++) ;
    if (end >= this.packets.length) return null // final packet not arrived yet

    // extract the response from multiple packets, `end` count starting at offset `0`
    var packets = this.packets.splice(0, end + 1)
    for (var i=1; i<packets.length; i++) {
        var id1 = packets[i-1][3], id2 = packets[i][3]
        if (id1 + 1 !== id2) {
            return convertErrorToPacket(_makeError('packets %d, %d out of order: %d, %d', i-1, i, id1, id2))
        }
    }
    // combine the packets to form the response
    for (var i=1; i<packets.length; i++) packets[i] = packets[i].slice(4)
    return Buffer.concat.call(Buffer, packets)
}
var bbytes = new Bytes()
Packman.prototype.getPacket = function getPacket( callback ) {
    // wait for and return a message buffer, including the header with length and sequence id
    var packet = this._getResponse()
    // TODO: confirm that the expected seqId fits the sendPacket sequence
    packet ? callback(null, packet) : this.waitlist.push(callback)
    if (this.error) {
        // getPacket never returns errors, so convert them to error packets
        var errbuf = convertErrorToPacket(this.error)
        while ((callback = this.waitlist.shift())) callback(null, errbuf)
    }
}
Packman.prototype.sendPacket = function sendPacket( packet, seqId ) {
    // send a message to the server, fragmenting into smaller packets as needed
    if (!Buffer.isBuffer(packet)) packet = fromBuf(packet)
    var dataOffset = 4;
    if (packet.length > 4 + 0xfffffe) {
        while (packet.length - dataOffset >= 0xffffff) {
            this._socket.write(fromBuf([255, 255, 255, seqId++]))
            this._socket.write(packet.slice(dataOffset, dataOffset + 0xffffff))
            dataOffset += 0xffffff
        }
        var tmpbuf = fromBuf([0, 0, 0, 0])
        bbytes.writeUint3(tmpbuf, 0, packet.length - dataOffset)
        tmpbuf[3] = seqId++
        this._socket.write(tmpbuf)
        this._socket.write(packet.slice(dataOffset))
    } else {
        bbytes.writeUint3(packet, 0, packet.length - 4)
        packet[3] = seqId++
        this._socket.write(packet)
    }
    return seqId
}
Packman.prototype = toStruct(Packman.prototype)

// ----------------------------------------------------------------

/*
 * Database Session
 * Exposes an interface for talking to the database.
 */
function Db( options ) {
    this.options = extractTo({}, options || {}, {
        user: 1, password: 1, host: 1, port: 1, database: 1,
        setup: 1, teardown: 1, // TODO: timeout: 1, reconnect: 1,
    })
    this.options.setup = Array.isArray(this.options.setup) ? options.setup : []
    this.options.teardown = Array.isArray(this.options.teardown) ? options.teardown : []
    this.packman = new Packman()
    this._queryInfo = null
    this._busyQ = false
    this._readerQueue = new Array()
}
// authenticate ourselves to the database server
// wait for the handshake packet to arrive and reply to it
// TODO: deprecate creds, always get from db.options
Db.prototype.connect = function connect( creds, callback ) {
    var self = this, dbCreds = extractTo({}, this.options, { user: 1, password: 1, host: 1, port: 1, database: 1 })
    if (!callback && typeof creds === 'function') { callback = creds; creds = extractTo({}, this.options, dbCreds) }
    if (!callback) throw _makeError('callback required')
    if (!creds.user) throw _makeError('creds user required')

    this.packman.connect(creds)
    this.packman.getPacket(function(never, buf) {
        var packet = decodeHandshakePacket(buf);
        if (packet.protocol_version !== 10) return callback(_makeError('bad auth protocol v %d', packet.protocol_version))
        if (packet._seqId !== 0) return callback(_makeError('handshake sequence id %d not 0', packet._seqId));

        var serverCaps = packet.capability_flag_1 | packet.capability_flag_2
        var clientCaps = myCaps.CLIENT_PROTOCOL_41 | myCaps.CLIENT_PLUGIN_AUTH |
            // TODO: (serverCaps & myCaps.CLIENT_LOCAL_FILES) |
            (creds.database ? myCaps.CLIENT_CONNECT_WITH_DB : 0)

        var response = encodeHandshakeResponse(1, packet, clientCaps, creds.user, creds.password, creds.database);
        self.packman.sendPacket(response, 1);
        self.packman.getPacket(function(never, buf) {
            // mis-matched auth methods get an EOF with stringZ auth_plugin and stringZ challenge string
            if (!isOkPacket(buf)) return callback(_makeError({ got: buf }, 'auth not OK'))
            self.runQueries(self.options.setup, callback)
        })
    })
    return this;
}
Db.prototype._getPacketsEof = function _getPacketsEof( handler, callback ) {
    // read packets until an EOF (or OK) packet is encountered, on error return the error packet
    // FIXME: detect corrupt/broken packet stream, error out all listeners
    var self = this, packets = new Array();
    (function _loop() {
        self.packman.getPacket(function(never, data) {
            if (isEofPacket(data) || isOkPacket(data)) return callback(null, packets)
            // assume that no packets follow an error packet, return it as the error.  WARNING: is this a safe asumption?
            if (isErrorPacket(data)) return callback(data, packets)
            if (!handler || handler(data)) packets.push(data)
            _loop()
        })
    })()
}
Db.prototype.ping = function ping( callback ) {
    this.packman.sendPacket(composePing(), 0)
    this.packman.getPacket(function(never, buf) {
        // TODO: should not return raw responses, should return a canonical format
        callback(null, decodeResponsePacket(buf))
    })
}
Db.prototype.quit = function quit( callback ) {
    var self = this, called = false;
    self.runQueries(self.options.teardown, function(err) {
        if (err) { self.packman.end(); return callback && callback(err) }
        self.packman.sendPacket(composeQuit(), 0) // quit needs to be sent in a Quit packet
        self.packman.getPacket(function(never, buf) {
            // quit succeeds silently, calls back only on error.  Ignore errors caused by packman.end() below.
            !called && (called = true) && callback(_makeQueryError(buf, 'COM_QUIT'))
        })
        setTimeout(function() { self.packman.end(function() { !called && (called = true) && callback && callback() }) }, 10);
    })
}
Db.prototype.runQueries = function runQueries( queries, callback ) {
    var self = this
    utils.repeatFor(queries.length, function(done, ix) {
        self.query(queries[ix], done)
    }, callback)
}
Db.prototype.queryInfo = function queryInfo( ) {
    return this._queryInfo;
}
Db.prototype.query = function query( query, params, callback ) {
    if (!callback) { callback = params; params = null }
    if (typeof query !== 'string' || typeof callback !== 'function') throw new _makeError('query and callback required')

    var self = this;
    var t1 = utils.microtime();
    if (Array.isArray(params)) query = vinterpolate(query, '?', params)
    var queryCmd = composeQuery(query);
    // var t1b = utils.microtime();
    this._queryInfo = null;
    params = null // remove refs to free sooner

    query = query.length > 200 ? query.slice(0, 200) + '...' : query // query to show in diagnostics
    var seqId = this.packman.sendPacket(queryCmd, 0);
    this._readResult(query, seqId, t1, callback)
}
Db.prototype._readResult = function _readResult(query, seqId, t1, callback) {
    if (this._busyQ) { this._readerQueue.push([query, seqId, t1, callback]); return }
    this._busyQ = true

    var self = this
    function _done( err, res ) {
        if (!self._readerQueue.length) {
            self._busyQ = false }
        else {
            var nextResult = self._readerQueue.shift()
            process.nextTick(function() { self._busyQ = false; self._readResult.apply(self, nextResult) }) }
        callback(err, res)
    }
    this.packman.getPacket(function(never, buf) {
        // expected response: OK, ERROR, LOCAL, or result packets: col count, N col defs, EOF, row values, EOF
        // TODO: return canonical responses (eg lastInsertId and affectedRows), not raw mysql packet contents
        // TODO: also pull out responses from the okPacket.info field, eg lastInsertId
        // var t1c = utils.microtime();
        if (buf[4] === myHeaders.OK && isOkPacket(buf)) return _done(null, decodeOkPacket(buf)) // success but no data
        if (buf[4] === myHeaders.EOF && isEofPacket(buf)) return _done(_makeError('unexpected EOF query response'))
        if (buf[4] === myHeaders.ERROR && isErrorPacket(buf)) return _done(_makeQueryError(buf, query))
        if (buf[4] === myHeaders.LOCAL && isLocalInfilePacket(buf)) {
            // FIXME: either implement, or signal server that response is not forthcoming
            return _done(_makeError('LOCAL INFILE not handled'), decodeResponsePacket(buf)) }

        var columnCount = getColumnCount(buf)  // else the query succeeded and returned results: decode
        self._getPacketsEof(null, function(errPacket, columnDefs) {
            if (errPacket) return _done(_makeQueryError(errPacket, query));
            var columnDecoders = new Array(columnCount);
            var columnNames = new Array(columnCount)
            for (var i=0; i<columnDefs.length; i++) {
                var col = decodeColumnDefinition41(columnDefs[i]);
                columnNames[i] = col.name
                var type = col.column_type
                columnDecoders[i] = getColumnDecoder(type, bbytes)
                columnDefs[i] = null // { name: col.name, type: col.column_type }
                // TODO: see if worth compiling a typelist-specific decoder function (but 60% in C++ and 40% in buf access)
            }
            var rows = new Array()
            function decodeRow(rowbuf) {
                rows.push(decodeRowValues(columnCount, rowbuf, columnDecoders))
                //rows.push(decodeRowHash(columnCount, rowbuf, columnDecoders, columnNames))
            }
            self._getPacketsEof(decodeRow, function(errPacket, rowbufs) {
                if (errPacket) return _done(_makeQueryError(errPacket, query));
                var t2 = utils.microtime()
                // typical 17m timing info: compose 15ms, query 140ms, decode 17ms
                // self._queryInfo = { columns: columnDefs,
                //      duration_ms: t2 - t1, compose_ms: t1b - t1, query_ms: t1c - t1b, decode_ms: t2 - t1c }
                self._queryInfo = { duration_ms: t2 - t1, columnNames: columnNames }
                return _done(null, rows)
            })
        })
    })
}
Db.prototype._select = function _select( query, params, callback ) {
    if (!callback) { callback = params; params = null }
    var self = this
    this.query(query, params, function(err, rows) {
        if (err) return callback(err)
        var names = self.queryInfo().columnNames
        for (var i=0; i<rows.length; i++) {
            var row = rows[i], hash = rows[i] = {}
            for (var j=0; j<names.length; j++) hash[names[j]] = row[j]
        }
        callback(err, rows)
    })
}
Db.prototype.end = function end( callback ) {
    this.quit(callback)
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
    CLIENT_FOUND_ROWS:          0x00000002,     // return rows found instead of rows affected
    CLIENT_LONG_FLAG:           0x00000004,
    CLIENT_CONNECT_WITH_DB:     0x00000008,     // connect to db as part of handshake
    CLIENT_NO_SCHEMA:           0x00000010,
    CLIENT_COMPRESS:            0x00000020,     // use zlib inflate/deflate ([3b compr ZZ len][1b seq][[3b uncomp len] ZZ])
    CLIENT_ODBC:                0x00000040,
    CLIENT_LOCAL_FILES:         0x00000080,     // allow LOAD DATA LOCAL INFILE
    CLIENT_IGNORE_SPACE:        0x00000100,
    CLIENT_PROTOCOL_41:         0x00000200,     // supports the 4.1 protocol
    CLIENT_INTERACTIVE:         0x00000400,     // wait_timeout vs wait_timeout_interactive
    CLIENT_SSL:                 0x00000800,
    CLIENT_IGNORE_SIGPIPE:      0x00001000,
    CLIENT_TRANSACTIONS:        0x00002000,
    CLIENT_RESERVED:            0x00004000,
    CLIENT_SECURE_CONNECTION:   0x00008000,     // supports Native::4.1 authentication
    CLIENT_MULTI_STATEMENTS:    0x00010000,     // handle multiple statements per COM_QUERY
    CLIENT_MULTI_RESULTS:       0x00020000,
    CLIENT_PS_MULTI_RESULTS:    0x00040000,     // allow ;-separated commands (NOTE: only one result is returned)
    CLIENT_PLUGIN_AUTH:         0x00080000,
    CLIENT_CONNECT_ATTRS:       0x00100000,
    CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA:
                                0x00200000,     // understands length-byte counted auth response data
    CLIENT_CAN_HANDLE_EXPIRED_PASSWORDS:
                                0x00400000,
    CLIENT_SESSION_TRACK:       0x00800000,
    CLIENT_DEPRECATE_EOF:       0x01000000,     // do not send EOF packets
}

// string commands: https://dev.mysql.com/doc/internals/en/command-phase.html
var myCmds = {
    COM_SLEEP:                  0x00,
    COM_QUIT:                   0x01,
    COM_QUERY:                  0x03,
    COM_FIELD_LIST:             0x04,           // column definitions of a table
    COM_PING:                   0x0e,
    COM_TIME:                   0x0f,
    COM_SET_OPTION:             0x1b,
}

// data[4] values for various packet types ([3b len][1b seq][1b header, then rest of payload])
var myHeaders = {
    OK:                         0x00,           // OK packet
    EOF:                        0xFE,           // EOF packet
    ERROR:                      0xFF,           // Error packet
    LOCAL:                      0xFB,           // LOCAL INFILE request (also lenenc NULL)
    // other values are the count of columns in the result set
}

// https://dev.mysql.com/doc/internals/en/status-flags.html#packet-Protocol::StatusFlags
var statusFlags = {
}

// https://dev.mysql.com/doc/internals/en/com-query-response.html#column-type
var myTypes = {
    DECIMAL:                    0x00,           // fp, but beware precision
    TINY:                       0x01,           // int char
    SHORT:                      0x02,           // int short
    LONG:                       0x03,           // int long
    FLOAT:                      0x04,           // fp float
    DOUBLE:                     0x05,           // fp double
    NULL:                       0x06,
    TIMESTAMP:                  0x07,
    LONGLONG:                   0x08,           // int, but beware precision
    INT24:                      0x09,           // int
    DATE:                       0x0A,
    TIME:                       0x0B,
    DATETIME:                   0x0C,
    YEAR:                       0x0D,
    NEWDATE:                    0x0E,
    VARCHAR:                    0x0f,
    BIT:                        0x10,           // int bit
    TIMESTAMP2:                 0x11,
    DATETIME2:                  0x12,
    TIME2:                      0x13,
    // (... gap in numbering)
    NEWDECIMAL:                 0xf6,           // fp, but beware precision
    ENUM:                       0xf7,
    SET:                        0xf8,
    TINY_BLOB:                  0xf9,           // binary
    MEDIUM_BLOB:                0xfa,           // binary
    LONG_BLOB:                  0xfb,           // binary
    BLOB:                       0xfc,           // binary
    VAR_STRING:                 0xfd,
    STRING:                     0xfe,
    GEOMETRY:                   0xff,
}

// lenenc : length encoded integer: 1, 3, 4 or 9 bytes:
//   00-fb 8-bit int, immed, fc.00.00-fc.ff.ff 16-bit int, fd.00.00.00-fd-ff.ff.ff 24-bit int, fe.[8 bytes] 4, 8-byte int
//   (up to mysql 3.22 fe was followed by 4 bytes, not 8)

// https://dev.mysql.com/doc/internals/en/mysql-packet.html
// packet layout: [3-byte payload length][1 byte sequence id][payload]]
//   if the payload is 0xffffff bytes long or longer, the payload is split into multiple packets
//   (ie, packet length [ff ff ff] indicates that another packet with more data to concatenate follows)

// ----------------------------------------------------------------

/*
 * Database communication protocol, encoding and decoding packets.
 */
function composeQuit() { return fromBuf([1, 0, 0, 0, myCmds.COM_QUIT]) }        // fixed-length 1-byte command
function composePing() { return fromBuf([1, 0, 0, 0, myCmds.COM_PING]) }

function composeQuery( query ) {
    // query length is computed and added by packman.sendPacket
    var cmdbuf = allocBuf(5 + Buffer.byteLength(query))
    cmdbuf[4] = myCmds.COM_QUERY
    cmdbuf.write(query, 5)
    return cmdbuf
}

function generateAuthResponse(auth1, auth2, pw) {
    // 4.1 auth hash is SHA1( password ) XOR SHA1( "20-bytes random data from server" <concat> SHA1( SHA1( password ) ) )
    // the no-password case is handled with a 0-length auth response (but compute the hash anyway, for timing)
    var hash = xorBytes(sha1(pw || ''), sha1(auth1, auth2, sha1(sha1(pw || ''))))
    return pw ? hash : allocBuf(0)

    function sha1(/* VARARGS */) { var sha = crypto.createHash('SHA1');
        for (var i=0; i<arguments.length; i++) sha.update(arguments[i]); return sha.digest() }
    function xorBytes(dst, src) {
        for (var i = 0; i < src.length; i++) dst[i] ^= src[i]; return dst }

}
function encodeHandshakeResponse( sequenceId, handshake, clientCaps, username, pw, dbname ) {
    // https://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::HandshakeResponse
    var authResponse = generateAuthResponse(handshake.auth_plugin_data_part_1, handshake.auth_plugin_data_part_2, pw)

    var buf = new Array(0, 0, 0, sequenceId)
    abytes.open(buf, 4)
    abytes.putUint4(clientCaps),
    abytes.putUint4(0x40000000) // max_packet_size: longest query client might send to server,
                                // including 4 header bytes (default 16mb; see also max_allowed_packet)
                                // Note: does not seem to make a difference, can still send 2^24-1 byte packets.
    abytes.putUint1(33)         // utf8 default is 33, latin1 default is 8
                                // select id from information_schema.collations where character_set_name = 'utf8'
    abytes.fillN(0, 23)
    abytes.putStringZ(username)
    abytes.putUint1(authResponse.length)        // Native::4.1 auth response byte count, if not using lenenc
    abytes.putBinary(authResponse)              // 20 byte response to the 20 byte challenge
    dbname ? abytes.putStringZ(dbname) : 0      // USE `dbname`
    abytes.putStringZ('mysql_native_password')  // authentication method

    return buf
}

// https://mariadb.com/kb/en/connection/#handshake-response-packet
/** not used currently, was for returned handshake responses
function decodeHandshakeResponsePacket(data) {
    abytes.open(data, 3);
    return {
        _seqId: abytes.getUint1(),
        _type: 'HANDSHAKE_RES',
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
} **/

function decodeResponsePacket( data ) {
    switch (data[4]) {
    case myHeaders.ERROR: return decodeErrorPacket(data)
    case myHeaders.OK:    return decodeOkPacket(data)
    case myHeaders.LOCAL: return decodeLocalInfilePacket(data)
    case myHeaders.EOF:   return isEofPacket(data) ? decodeEofPacket(data) : decodeTextResultsetPacket(data)
    default:              return decodeTextResultsetPacket(data)
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
/** experimental, see query()
function decodeRowHash(n, data, decoders, names) {
    var hash = {}
    bbytes.open(data, 4)
    for (var i=0; i<n; i++) {
        var len = bbytes.getLenenc()
        hash[names[i]] = (len === null) ? null : decoders[i](len)
    }
    return hash;
} **/

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

function getColumnCount(data) {
    bbytes.open(data, 4)
    return bbytes.getLenenc()
}
function getColumnDecoder(type, bytes) {
    return (type >= 0 && type <= 5 || type === 8 || type === 9 || type === 0x10 || type === 0xf6) ? bytes.getNumberN
        : (type >= 0xf9 && type <= 0xfc) ? bytes.getBinaryN : bytes.getStringN
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
        // Protocol::41 but without CLIENT_TRANSACTIONS
        warningCount: bbytes.getUint2(),
        // without SESSION_TRACK
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

// convert Errors into sql packets that will decode into mysql error objects,
// to be able to inject connection errors into the received packet stream
function convertErrorToPacket(err) {
    var errbuf = new Array(0, 0, 0, 255, myHeaders.ERROR, 0, 0, 0, 32, 32, 32, 32, 32)
    abytes.open(errbuf, 13)
    abytes.putString(err.message)
    abytes.writeUint3(errbuf, 0, errbuf.length - 4)
    return fromBuf(errbuf)
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
        _type: 'HANDSHAKE_REQ',
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
    }
    if (flags & myCaps.CLIENT_PLUGIN_AUTH) {
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
        tell: function() { return pos },
        // seek: function(_pos) { pos = _pos },
        // databuf: function() { return buf },

        readUint3: function(buf, pos) { return buf[pos++] + (buf[pos++] << 8) + (buf[pos] << 16) },
        writeUint3: function(buf, pos, v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF; buf[pos] = (v >>> 16) & 0xFF },

        putUint1: function(v) { buf[pos++] = v & 0xFF },
        putUint2: function(v) { buf[pos++] = v & 0xFF; buf[pos++] = (v >>> 8) & 0xFF },
        // putUint3: function(v) { putUint2(v); buf[pos++] = (v >>> 16) & 0xFF },
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
        skipN: function(n) { pos += n },
        getLenenc: function() { var v1 = buf[pos++]; return (v1 <= 250) ? v1
            : (v1 === 251) ? null : (v1 === 252) ? bytes.getUint2()
            : (v1 === 253) ? bytes.getUint3() : (v1 === 254) ? bytes.getUint4() + bytes.getUint4() * 0x100000000 : NaN },
        getNumberN: function(n) { return parseFloat(bytes.getStringN(n)) },

        // copyIn: function(src, base, bound) { while (base < bound) buf[pos++] = src[base++] },
        // copyOut: function(dst, to, n) { for (var i=0; i<n; i++) dst[to+i] = buf[pos++] },
    }
    return bytes;

    // function isAscii(str) { return !/[^\x01-0x7f]/.test(str) }
    function writeString(buf, pos, str) {
        // it is faster to utf8-encode than to isAscii/copyloop
        return (Buffer.isBuffer(buf)) ? buf.write(str, pos) : utf8.utf8_encode(str, 0, str.length, buf, pos)
    }
    function readString(buf, fm, to) {
        // return (to - fm > 20 && Buffer.isBuffer(buf)) ? buf.toString('utf8', fm, to) : utf8.utf8_decode(buf, fm, to)
        return (to - fm <= 40 || !Buffer.isBuffer(buf)) ? utf8.utf8_decode(buf, fm, to) : buf.toString('utf8', fm, to)
    }
}

// ----------------------------------------------------------------

/*
 * Utilities
 */
function _makeQueryError( msgbuf, query ) {
    var packet = decodeResponsePacket(msgbuf)
    Error.captureStackTrace(packet, _makeQueryError)
    return _makeError({ errorCode: packet.error_code, errorMessage: packet.error_message, stack: packet.stack, query: query },
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

// vinterpolate adapted from qibl@1.4.0 via miniq (see also compileInterpolate in qibl@1.8.0-dev)
function vinterpolate( template, patt, argv ) {
    var s = '', pos, lastPos = 0, argix = 0;
    while ((pos = template.indexOf(patt, lastPos)) >= 0 && argix < argv.length) {
        s += template.slice(lastPos, pos) + formatValue(argv[argix++]);
        lastPos = pos + patt.length;
    }
    return s += template.slice(lastPos);

    function formatValue(arg) {
        return (typeof arg === 'number') ? arg
            : Buffer.isBuffer(arg) ? "UNHEX('" + arg.toString('hex') + "')"
            : (Array.isArray(arg)) ? arg.map(function(e) { return formatValue(e) }).join(', ')
            : "'" + addslashes(String(arg)) + "'";
    }
}
// from qibl
function addslashes( str, patt ) {
    patt = patt || /([\'\"\\\x00])/g;
    return str.replace(patt, '\\$1');
}

/**
// for debugging:
function pad2x(n) { return n < 16 ? '0' + n.toString(16) : n.toString(16) }
function hexdump(buf, fm, to) {
    fm = fm || 0;
    to = to || buf.length;
    return buf.slice(fm, to).map(function(ch) { return pad2x(ch) }).join(' ');
}
**/

function toStruct( hash ) { return toStruct.prototype = hash }
