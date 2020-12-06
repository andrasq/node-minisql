/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

var assert = require('assert')
var utils = require('../lib/utils')
var my = require('../lib/mysql')

var handshakePacket = utils.fromBuf(            // initial handshake from server
    ('53 00 00 00 0a 35 2e 36 2e 33 30 2d 31 7e 62 70 6f 38 2b 31' +
    '00 92 62 00 00 7a 75 5e 58 7d 2c 62 29 00 ff f7 08 02 00 7f' +
    '80 15 00 00 00 00 00 00 00 00 00 00 45 5d 29 4e 2f 3d 27 48' +
    '75 36 49 50 00 6d 79 73 71 6c 5f 6e 61 74 69 76 65 5f 70 61' +
    '73 73 77 6f 72 64 00').replace(/ /g, ''), 'hex')
var eofPacket = utils.fromBuf(                  // EOF
    '05 00 00 05 fe 00 00 02 00'.replace(/ /g, ''), 'hex')
var textResultsetPacket = utils.fromBuf(        // 1001 columns
    '05 00 00 02 fc e9 03'.replace(/ /g, ''), 'hex')
var resultRowPacket3 = utils.fromBuf(           // row with "ABC", 23.5
    '09 00 00 02 03 41 42 43 04 32 33 2e 35'.replace(/ /g, ''), 'hex')
var errorPacket = utils.fromBuf(                // Error packet of "No database selected", error_code 1046
    ('1d 00 00 4d ff 16 04 23 33 44 30 30 30 4e 6f 20 64 61 74 61' +
    '62 61 73 65 20 73 65 6c 65 63 74 65 64').replace(/ /g, ''), 'hex')

describe('mysql', function() {
    describe('OkPacket', function() {
    })
    describe('EofPacket', function() {
        var p1, p2
        it('is detected by isEofPacket', function(done) {
            assert.equal(my.isEofPacket(eofPacket), true)
            done()
        })
        it('decodes seq id and header', function(done) {
            var packet = p1 = my.decodeEofPacket(eofPacket)
            assert.equal(packet._seqId, 5)
            assert.equal(packet._type, 'EOF')
            assert.equal(packet.header, my.myHeaders.EOF)
            done()
        })
        it('is decoded by decodeResponsePacket', function(done) {
            var packet = p2 = my.decodeResponsePacket(eofPacket)
            assert.deepEqual(p2, p1)
            done()
        })
    })
    describe('ErrorPacket', function() {
        var p1, p2
        it('is decoded by decodeResponsePacket', function(done) {
            var packet = p1 = my.decodeResponsePacket(errorPacket)
            assert.equal(packet._seqId, 77)
            assert.equal(packet._type, 'ERROR')
            assert.equal(packet.header, my.myHeaders.ERROR)
            assert.equal(packet.error_code, 1046)
            assert.equal(packet.error_message, 'No database selected')
            assert.equal(packet.sql_state_marker, '#')
            assert.equal(packet.sql_state, '3D000')
            done()
        })
        it('is decoded by decodeErrorPacket', function(done) {
            var p2 = my.decodeErrorPacket(errorPacket)
            assert.deepEqual(p2, p1)
            done()
        })
        it('is distinguished from ErrorProgress', function(done) {
            var progressPacket = utils.fromBuf(errorPacket)
            progressPacket[5] = progressPacket[6] = 0xff
            var packet = my.decodeErrorPacket(progressPacket)
            assert.equal(packet._seqId, 77)
            assert.equal(packet._type, 'ERROR_PROGRESS')
            assert.equal(packet.header, my.myHeaders.ERROR)
            assert.equal(packet.error_code, 0xffff)
            assert.equal(packet.progress_info, 'No database selected')
            done()
        })
    })
    describe('TextResultsetPacket', function() {
        it('is decoded by decodeResponsePacket', function(done) {
            var packet = my.decodeResponsePacket(textResultsetPacket)
            assert.equal(packet._seqId, 2)
            assert.equal(packet._type, 'RESULTS')
            assert.equal(packet.column_count, 1001)
            done()
        })
    })
    describe('handshake packet', function() {
        it('is decoded by decodeHandshakePacket', function(done) {
            var packet = my.decodeHandshakePacket(handshakePacket)
            assert.equal(packet.protocol_version, 10)
            assert.equal(packet.auth_plugin_name, 'mysql_native_password')

            assert.deepEqual(my.decodeResponsePacket(handshakePacket), packet)
            done()
        })
    })
})
