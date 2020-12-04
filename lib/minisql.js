/*
 * Simple MySQL driver.
 * Flow control and handshaking logic.
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 *
 * 2020-11-20 - AR.
 */

'use strict';

module.exports = {
    createConnection: function(options) { return new Db(options) },
}

var util = require('util')
var net = require('net');
var crypto = require('crypto');
var utf8 = require('q-utf8');
var utils = require('./utils')
var my = require('./mysql')

var _makeError = utils.makeError;
var allocBuf = utils.allocBuf;
var fromBuf = utils.fromBuf;

var myCaps = my.myCaps;
var myHeaders = my.myHeaders;
var isOkPacket = my.isOkPacket;
var isEofPacket = my.isEofPacket;

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
        var need = 4 + my.readUint3(this.bufs[0], 0)
        if (this.bufs[0].length >= need) { // common case, the small control packets
            var buf = this.bufs[0]; this.nbytes -= need
            if (buf.length === need) return this.bufs.shift()
            this.bufs[0] = buf.slice(need); return buf.slice(0, need)
        }
        if (this.nbytes < need) return null
        var msg = allocBuf(need)
        // combining chunks here adds 3.2ms per 17mb combined
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
            return my.convertErrorToPacket(_makeError('packets %d, %d out of order: %d, %d', i-1, i, id1, id2))
        }
    }
    // combine the packets to form the response, this adds 3.7ms per 17mb copied
    for (var i=1; i<packets.length; i++) packets[i] = packets[i].slice(4)
    return Buffer.concat(packets)
}
Packman.prototype.getPacket = function getPacket( callback ) {
    // wait for and return a message buffer, including the header with length and sequence id
    var packet = this._getResponse()
    // TODO: confirm that the expected seqId fits the sendPacket sequence
    packet ? callback(null, packet) : this.waitlist.push(callback)
    if (this.error) {
        // getPacket never returns errors, so convert them to error packets
        var errbuf = my.convertErrorToPacket(this.error)
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
        my.writeUint3(tmpbuf, 0, packet.length - dataOffset)
        tmpbuf[3] = seqId++
        this._socket.write(tmpbuf)
        this._socket.write(packet.slice(dataOffset))
    } else {
        my.writeUint3(packet, 0, packet.length - 4)
        packet[3] = seqId++
        this._socket.write(packet)
    }
    return seqId
}
Packman.prototype = utils.toStruct(Packman.prototype)

// ----------------------------------------------------------------

function Db( options ) {
    this.options = utils.extractTo({}, options || {}, {
        user: 1, password: 1, host: 1, port: 1, database: 1,
        setup: 1, teardown: 1, connections: 1, // TODO: timeout: 1, reconnect: 1,
    })
    this.options.setup = Array.isArray(this.options.setup) ? options.setup : []
    this.options.teardown = Array.isArray(this.options.teardown) ? options.teardown : []
    var linkCount = this.options.connections > 1 ? this.options.connections : 1

    // note: a qlist would be 3x faster than [] for shift/pop
    this.sessions = new Array()
    this.lastSession = -1
    this.lastUsedSession = 0
    for (var i = 0; i < linkCount; i++) {
        this.sessions.push(new Session(this.options))
    }

    // optimize, in single-connection case talk to the link
    return linkCount === 1 ? this.getConnection() : this
}
Db.prototype.connect = function connect( callback ) {
    // FIXME: de-dup args checking, both here and in the connection.
    var self = this, creds = utils.extractTo({}, this.options, { user: 1, password: 1, host: 1, port: 1, database: 1 })
    if (!callback) throw _makeError('callback required')
    if (!creds.user) throw _makeError('creds user required')

    var self = this
    utils.repeatFor(self.sessions.length, function(next, ix) {
        self.sessions[ix].connect(next)
    }, function(err) {
        if (!self.options.reconnect) self.options.password = '****'
        callback(err)
    })
    return this
}
Db.prototype.query = function query( sql, params, callback ) {
    var conn = this.getConnection()
    conn.query(sql, params, callback)
    return conn
}
Db.prototype.end = function end(callback) {
    var self = this
    utils.repeatFor(self.sessions.length, function(done, ix) {
        self.sessions[ix].end(done)
    }, callback || function(){})
}
Db.prototype.getConnection = function getConnection( ) {
    // simple round-robin lru
    this.lastSession = (this.lastSession + 1) % this.sessions.length
    return this.sessions[this.lastSession]
}
Db.prototype.queryInfo = function queryInfo( ) {
    return { duration_ms: 0, columnNames: [] }
}
Db.prototype = utils.toStruct(Db.prototype)

/*
 * Database Session
 * Exposes an interface for talking to the database.
 */
var _nextId = 1
function Session( options ) {
    this.id = _nextId++
    this.options = options // use parent options
    this.packman = new Packman()
    this._queryInfo = null
    this.isReading = false
    this.readWaitlist = new Array()
}
// authenticate ourselves to the database server, await and reply to auth handshake
Session.prototype.connect = function connect( callback ) {
    var self = this, creds = utils.extractTo({}, this.options, { user: 1, password: 1, host: 1, port: 1, database: 1 })
    if (!callback) throw _makeError('callback required')
    if (!creds.user) throw _makeError('creds user required')

    this.packman.connect(creds)
    this.packman.getPacket(function(never, buf) {
        var packet = my.decodeHandshakePacket(buf);
        if (packet.protocol_version !== 10) return callback(_makeError('bad auth protocol v %d', packet.protocol_version))
        if (packet._seqId !== 0) return callback(_makeError('handshake sequence id %d not 0', packet._seqId));

        var serverCaps = packet.capability_flag_1 | packet.capability_flag_2
        var clientCaps = myCaps.CLIENT_PROTOCOL_41 | myCaps.CLIENT_PLUGIN_AUTH |
            // TODO: (serverCaps & myCaps.CLIENT_LOCAL_FILES) |
            (creds.database ? myCaps.CLIENT_CONNECT_WITH_DB : 0)

        var response = my.encodeHandshakeResponse(1, packet, clientCaps, creds.user, creds.password, creds.database);
        self.packman.sendPacket(response, 1);
        self.packman.getPacket(function(never, buf) {
            // mis-matched auth methods get an EOF with stringZ auth_plugin and stringZ challenge string
            if (!isOkPacket(buf)) return callback(_makeError({ got: buf }, 'auth not OK'))
            self.runQueries(self.options.setup, callback)
        })
    })
    return this;
}
Session.prototype.getConnection = function getConnection() { return this }
Session.prototype._getPacketsEof = function _getPacketsEof( handler, callback ) {
    // read packets until an EOF (or OK) packet is encountered, on error return the error packet
    // FIXME: detect corrupt/broken packet stream, error out all listeners
    var self = this, packets = new Array();
    (function _loop() {
        self.packman.getPacket(function(never, data) {
            if (isEofPacket(data) || isOkPacket(data)) return callback(null, packets)
            // assume that no packets follow an error packet, return it as the error.  WARNING: is this a safe asumption?
            if (my.isErrorPacket(data)) return callback(data, packets)
            if (!handler || handler(data)) packets.push(data)
            _loop()
        })
    })()
}
Session.prototype.ping = function ping( callback ) {
    this.packman.sendPacket(my.composePing(), 0)
    this.packman.getPacket(function(never, buf) {
        // TODO: should not return raw responses, should return a canonical format
        callback(null, my.decodeResponsePacket(buf))
    })
}
Session.prototype.quit = function quit( callback ) {
    var self = this, called = false;
    self.runQueries(self.options.teardown, function(err) {
        if (err) { self.packman.end(); return callback && callback(err) }
        self.packman.sendPacket(my.composeQuit(), 0) // quit needs to be sent in a Quit packet
        self.packman.getPacket(function(never, buf) {
            // quit succeeds silently, calls back only on error.  Ignore errors caused by packman.end() below.
            !called && (called = true) && callback(_makeQueryError(buf, 'COM_QUIT'))
        })
        setTimeout(function() { self.packman.end(function() { !called && (called = true) && callback && callback() }) }, 10);
    })
}
Session.prototype.runQueries = function runQueries( queries, callback ) {
    var self = this
    utils.repeatFor(queries.length, function(done, ix) {
        self.query(queries[ix], done)
    }, callback)
}
Session.prototype.queryInfo = function queryInfo( ) {
    return this._queryInfo;
}
Session.prototype.query = function query( query, params, callback ) {
    if (!callback) { callback = params; params = null }
    if (typeof query !== 'string' || typeof callback !== 'function') throw new _makeError('query and callback required')

    var self = this;
    var t1 = utils.microtime();
    if (Array.isArray(params)) query = vinterpolate(query, '?', params)
    var queryCmd = my.composeQuery(query);
    // var t1b = utils.microtime();
    this._queryInfo = null;
    params = null // remove refs to free sooner

    query = query.length > 200 ? query.slice(0, 1000) + '...' : query // query to show in diagnostics
    var seqId = this.packman.sendPacket(queryCmd, 0);
    this._readResult(query, seqId, t1, callback)
    return this
}
Session.prototype._readResult = function _readResult(query, seqId, t1, callback) {
    if (this.isReading) { this.readWaitlist.push([query, seqId, t1, callback]); return }
    this.isReading = true

    var self = this
    function _done( err, res ) {
        if (!self.readWaitlist.length) {
            self.isReading = false }
        else {
            var nextResult = self.readWaitlist.shift()
            process.nextTick(function() { self.isReading = false; self._readResult.apply(self, nextResult) }) }
        callback(err, res)
    }
    this.packman.getPacket(function(never, buf) {
        // expected response: OK, ERROR, LOCAL, or result packets: col count, N col defs, EOF, row values, EOF
        // TODO: return canonical responses (eg lastInsertId and affectedRows), not raw mysql packet contents
        // TODO: also pull out responses from the okPacket.info field, eg lastInsertId
        // var t1c = utils.microtime();
        if (buf[4] === myHeaders.OK && isOkPacket(buf)) return _done(null, my.decodeOkPacket(buf)) // success but no data
        if (buf[4] === myHeaders.EOF && isEofPacket(buf)) return _done(_makeError('unexpected EOF query response'))
        if (buf[4] === myHeaders.ERROR && my.isErrorPacket(buf)) return _done(_makeQueryError(buf, query))
        if (buf[4] === myHeaders.LOCAL && my.isLocalInfilePacket(buf)) {
            // FIXME: either implement, or signal server that response is not forthcoming
            return _done(_makeError('LOCAL INFILE not handled'), my.decodeResponsePacket(buf)) }

        var columnCount = my.getColumnCount(buf)  // else the query succeeded and returned results: decode
        self._getPacketsEof(null, function(errPacket, columnDefs) {
            if (errPacket) return _done(_makeQueryError(errPacket, query));
            var columnDecoders = new Array(columnCount);
            var columnNames = new Array(columnCount)
            for (var i=0; i<columnDefs.length; i++) {
                var col = my.decodeColumnDefinition41(columnDefs[i]);
                columnNames[i] = col.name
                columnDecoders[i] = my.getColumnDecoder(col.column_type)
                columnDefs[i] = null // { name: col.name, type: col.column_type }
                // TODO: see if worth compiling a typelist-specific decoder function (but 60% in C++ and 40% in buf access)
            }
            var rows = new Array()
            function decodeRow(rowbuf) {
                var values = my.decodeRowValues(columnCount, rowbuf, columnDecoders)
                rows.push(values)
                //rows.push(utils.pairTo({}, columnNames, values))
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
Session.prototype._select = function _select( query, params, callback ) {
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
Session.prototype.end = function end( callback ) {
    // FIXME: remove from the pool
    this.quit(callback)
}
Session.prototype = utils.toStruct(Session.prototype)

// ----------------------------------------------------------------

function _makeQueryError( msgbuf, query ) {
    var packet = my.decodeResponsePacket(msgbuf)
    var err = _makeError({ errorCode: packet.error_code, errorMessage: packet.error_message, query: query },
        'query error %d: %s', packet.error_code, packet.error_message);
    Error.captureStackTrace(err, _makeQueryError)
    return err
}

// vinterpolate adapted from qibl@1.4.0 via miniq (see also compileVinterpolate in qibl@1.8.0-dev)
function vinterpolate( template, patt, argv ) {
    var s = '', pos, lastPos = 0, argix = 0;
    while ((pos = template.indexOf(patt, lastPos)) >= 0 && argix < argv.length) {
        s += template.slice(lastPos, pos) + formatValue(argv[argix++]);
        lastPos = pos + patt.length;
    }
    return s += template.slice(lastPos);
}
function formatValue(arg) {
    return (typeof arg === 'number') ? arg
        : Buffer.isBuffer(arg) ? "UNHEX('" + arg.toString('hex') + "')"
        : (Array.isArray(arg)) ? arg.map(function(e) { return formatValue(e) }).join(', ')
        : "'" + addslashes(String(arg)) + "'";
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
