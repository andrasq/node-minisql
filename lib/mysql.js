/*
 * MySQL / MariaDB manifest constants and pack/unpack functions.
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

var crypto = require('crypto')
var utils = require('./utils')

var myCaps = myCaps()
var myCmds = myCmds()
var myHeaders = myHeaders()
var myStatusFlags = myStatusFlags()
var myTypes = myTypes()

var abytes = new utils.Bytes()  // convert to/from arrays
var bbytes = new utils.Bytes()  // convert to/from Buffers

module.exports = {
    bbytes: bbytes,

    myCaps: myCaps,
    myCmds: myCmds,
    myHeaders: myHeaders,
    myTypes: myTypes,

    // bbytes packet access
    writeUint3: bbytes.writeUint3,
    readUint3: bbytes.readUint3,

    composeQuit: composeQuit,
    composePing: composePing,
    composeQuery: composeQuery,
    generateAuthResponse: generateAuthResponse,
    encodeHandshakeResponse: encodeHandshakeResponse,
    // decodeHandshakeResponsePacket: decodeHandshakeResponsePacket,
    decodeResponsePacket: decodeResponsePacket,
    decodeRowValues: decodeRowValues,
    isEofPacket: isEofPacket,
    isOkPacket: isOkPacket,
    isLocalInfilePacket: isLocalInfilePacket,
    isErrorPacket: isErrorPacket,
    decodeEofPacket: decodeEofPacket,
    decodeColumnDefinition41: decodeColumnDefinition41,
    getColumnCount: getColumnCount,
    getColumnDecoder: getColumnDecoder,
    decodeTextResultsetPacket: decodeTextResultsetPacket,
    decodeOkPacket: decodeOkPacket,
    decodeLocalInfilePacket: decodeLocalInfilePacket,
    convertErrorToPacket: convertErrorToPacket,
    decodeErrorPacket: decodeErrorPacket,
    decodeHandshakePacket: decodeHandshakePacket,
}

var allocBuf = utils.allocBuf;
var fromBuf = utils.fromBuf;

var abytes = new utils.Bytes()
var bbytes = new utils.Bytes()

/*
 * MySQL and MariaDB manifest constants.
 */
// https://dev.mysql.com/doc/internals/en/capability-flags.html#packet-Protocol::CapabilityFlags
// Native::4.1 auth: return (sha1(password) XOR sha1("20-bytes random data from server" <concat> sha1(sha1(password))))
function myCaps() {
return {
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
} }

// string commands: https://dev.mysql.com/doc/internals/en/command-phase.html
function myCmds() {
return {
    COM_SLEEP:                  0x00,
    COM_QUIT:                   0x01,
    COM_QUERY:                  0x03,
    COM_FIELD_LIST:             0x04,           // column definitions of a table
    COM_PING:                   0x0e,
    COM_TIME:                   0x0f,
    COM_SET_OPTION:             0x1b,
} }

// data[4] values for various packet types ([3b len][1b seq][1b header, then rest of payload])
function myHeaders() {
return {
    OK:                         0x00,           // OK packet
    EOF:                        0xFE,           // EOF packet
    ERROR:                      0xFF,           // Error packet
    LOCAL:                      0xFB,           // LOCAL INFILE request (also lenenc NULL)
    // other values are the count of columns in the result set
} }

// https://dev.mysql.com/doc/internals/en/status-flags.html#packet-Protocol::StatusFlags
function myStatusFlags() {
return {
    SERVER_STATUS_IN_TRANS:     0x0001,         // transaction in progress
    SERVER_STATUS_AUTOCOMMIT:   0x0002,         // auto-commit on
    SERVER_MORE_RESULTS_EXISTS: 0x0008,
    SERVER_STATUS_NO_GOOD_INDEX_USED:
                                0x0010,
    SERVER_STATUS_NO_INDEX_USED:0x0020,
    SERVER_STATUS_CURSOR_EXISTS:0x0040,
    SERVER_STATUS_LAST_ROW_SENT:0x0080,
    SERVER_STATUS_DB_DROPPED:   0x0100,
    SERVER_STATUS_NO_BACKSLASH_ESCAPES:
                                0x0200,
    SERVER_STATUS_METADATA_CHANGED:
                                0x0400,
    SERVER_QUERY_WAS_SLOW:      0x0800,
    SERVER_PS_OUT_PARAMS:       0x1000,
    SERVER_STATUS_IN_TRANS_READONLY:
                                0x2000,
    SERVER_SESSION_STATE_CHANGED:
                                0x4000,
} }

// https://dev.mysql.com/doc/internals/en/com-query-response.html#column-type
function myTypes() {
return {
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
} }

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
function composeQuit() { return utils.fromBuf([1, 0, 0, 0, myCmds.COM_QUIT]) }        // fixed-length 1-byte command
function composePing() { return utils.fromBuf([1, 0, 0, 0, myCmds.COM_PING]) }

function composeQuery( query ) {
    // query length is computed and added by packman.sendPacket
    var cmdbuf = allocBuf(5 + Buffer.byteLength(query))
    cmdbuf[4] = myCmds.COM_QUERY
    bbytes.open(cmdbuf, 5)
    bbytes.putString(query)
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

// decode mysql response row into an array of values
// It is a bit faster to decode to an array then pairTo names, values than to decodeRowHash
function decodeRowValues(n, data, decoders) {
    var values = new Array(n);
    bbytes.open(data, 4);
    for (var i=0; i<n; i++) {
        values[i] = decoders[i]();
    }
    return values;
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
/**
    // templated decode is slower than long form below (costs 2% of throughput)
    bbytes.open(data, 4);
    var packet = bbytes.decodeBytesTo({ _seqId: data[3], _type: 'COLUMN' },
        'XXSXSXv===1', ['table', 'name', 'next_length', 'column_type'])
    return packet
**/

    bbytes.open(data, 4);
    var packet1 = {
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
    return packet1
}

function getColumnCount(data) {
    bbytes.open(data, 4)
    return bbytes.getLenenc()
}
function getColumnDecoder(type, callerBytes) {
    var bytes = bbytes
    return (type >= 0 && type <= 5 || type === 8 || type === 9 || type === 0x10 || type === 0xf6) ? bytes.getNumberV
        : (type >= 0xf9 && type <= 0xfc) ? bytes.getBinaryV : bytes.getStringV
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
    return utils.fromBuf(errbuf)
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
